/**
 * Pure mapping from a tool call to the paths it may modify. No filesystem access, no state — the
 * caller resolves paths to jj workspaces and owns the staged-rewrite bookkeeping.
 */

/** Paths to snapshot: explicit targets, the session cwd, or nothing at all. */
export type Targets = readonly string[] | "cwd" | null;

export interface Classification {
	/**
	 * Effective tool name, device-unwrapped: in an `xdev` session an inner tool call arrives as a
	 * `write` to `xd://<device>` carrying JSON arguments.
	 */
	tool: string;
	targets: Targets;
	/**
	 * `use` — snapshot the roots a previous `ast_edit` staged, because the apply names no file;
	 * `clear` — the staged rewrite was discarded, so forget them. `targets` is the fallback for
	 * `use` when no stage was observed.
	 */
	staged?: "use" | "clear";
	/** This call stages an AST rewrite; the caller must remember its resolved roots for the apply. */
	stages?: boolean;
}

/** Tools that can write anywhere, with no target path in their arguments. */
export const CWD_SCOPED_TOOLS: Record<string, true> = { bash: true, eval: true, task: true };

/** `lsp` actions that write to disk (rename/rename_file apply by default; code_actions opt in). */
export const LSP_WRITING_ACTIONS: Record<string, true> = {
	rename: true,
	rename_file: true,
	code_actions: true,
};

/**
 * Tools whose writes are finished by the time their `tool_result` fires, so a post-execution
 * snapshot records a settled tree. Deliberately excludes the opaque executors: `bash` and `eval`
 * can auto-background, `task` subagents are background by design, and `debug launch` leaves a live
 * debuggee — snapshotting on their result could capture a half-written tree. Those tools get only
 * the pre-execution (pre-batch) boundary.
 */
export const SYNC_MUTATORS: Record<string, true> = {
	write: true,
	edit: true,
	resolve: true,
	lsp: true,
	github: true,
};

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function strArray(value: unknown): string[] {
	if (typeof value === "string") return str(value) ? [value.trim()] : [];
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => (str(entry) ? [String(entry).trim()] : []));
}

/**
 * Hashline `MV DEST` destinations, which are not section headers and so never appear in the
 * `paths` the host's argument normalization injects.
 */
function moveDestinations(input: Record<string, unknown>): string[] {
	const body = str(input.input) ?? str(input._input);
	if (!body) return [];
	const found: string[] = [];
	for (const match of body.matchAll(/^\s*MV\s+(.+?)\s*$/gm)) {
		const raw = match[1];
		const quote = raw[0];
		const unquoted =
			(quote === '"' || quote === "'") && raw.endsWith(quote) ? raw.slice(1, -1) : raw;
		if (unquoted.trim()) found.push(unquoted.trim());
	}
	return found;
}

function parseDevicePayload(content: unknown): Record<string, unknown> | null {
	const text = str(content);
	if (!text) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function classify(toolName: string, input: Record<string, unknown>): Classification {
	switch (toolName) {
		case "write": {
			const path = str(input.path);
			if (!path) return { tool: toolName, targets: "cwd" };
			if (!path.startsWith("xd://")) return { tool: toolName, targets: [path] };

			const device = path.slice("xd://".length).split(/[/?#]/)[0];
			if (device === "reject") return { tool: device, targets: null, staged: "clear" };
			if (device === "resolve") return { tool: device, targets: "cwd", staged: "use" };

			const payload = parseDevicePayload(input.content);
			// Unparseable device arguments: snapshot the cwd rather than skip.
			if (!payload) return { tool: device, targets: "cwd" };
			return classify(device, payload);
		}

		case "edit": {
			// Host normalization already extracted hashline section paths into `paths`/`path`.
			const paths = [
				...strArray(input.paths),
				...strArray(input.path),
				...moveDestinations(input),
			];
			return { tool: toolName, targets: paths.length > 0 ? paths : "cwd" };
		}

		case "ast_edit": {
			const paths = strArray(input.paths);
			return { tool: toolName, targets: paths.length > 0 ? paths : "cwd", stages: true };
		}

		// `tts` is deliberately out of scope. Its caller-chosen `output_path` genuinely can
		// overwrite a file inside the workspace, but this extension covers code/editing tools, and
		// a generated audio artifact at a model-chosen path is not what restore points are for.
		// Add a `case "tts"` returning `[input.output_path]` if that scope call changes.

		case "lsp": {
			const action = str(input.action);
			if (!action || LSP_WRITING_ACTIONS[action] !== true) {
				return { tool: toolName, targets: null };
			}
			// rename/rename_file apply unless told not to; code_actions only apply on request.
			const applies = action === "code_actions" ? input.apply === true : input.apply !== false;
			if (!applies) return { tool: toolName, targets: null };
			const file = str(input.file);
			return { tool: toolName, targets: file && file !== "*" ? [file] : "cwd" };
		}

		case "github": {
			// pr_checkout materializes git worktrees; every other op is read-only or remote-only.
			if (str(input.op) !== "pr_checkout") return { tool: toolName, targets: null };
			return { tool: toolName, targets: "cwd" };
		}

		case "debug": {
			// A launched debuggee can write files; `write_memory` is process memory, not disk.
			if (str(input.action) !== "launch") return { tool: toolName, targets: null };
			const cwd = str(input.cwd);
			return { tool: toolName, targets: cwd ? [cwd] : "cwd" };
		}

		default:
			return { tool: toolName, targets: CWD_SCOPED_TOOLS[toolName] === true ? "cwd" : null };
	}
}
