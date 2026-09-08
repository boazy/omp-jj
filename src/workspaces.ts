/**
 * Client for the bundled JJ workspace fallback.
 *
 * The fallback owns the narrow machine contract needed by the extension: resolve the
 * wt-compatible `workspace_dir`, list/select workspaces, find the primary workspace, and
 * create/remove with collision and safety checks. Configuration precedence exactly follows
 * `wt`: `~/dots/config/wt.toml`, then `<primary>/.local/wt.toml`, with relative paths based
 * on the primary workspace.
 *
 * Every call is timeout-bounded and never throws (spawn failure surfaces as an error
 * value). Read paths (`root`, `list`, `select`, `main`) use `--ignore-working-copy`; only
 * explicitly authorized creation/removal may snapshot or mutate repository state.
 */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";

/** One inventory row, exactly as the fallback reports it. */
export interface WorkspaceRow {
	backend: string;
	name: string;
	branch: string;
	change: string;
	state: string;
	path: string;
	managed: boolean;
	primary: boolean;
	stale: boolean;
	note: string;
}

export type HelperError =
	| { kind: "missing"; detail: string }
	| { kind: "failed"; detail: string }
	| { kind: "cancelled"; detail: string }
	| { kind: "timeout"; detail: string }
	| { kind: "malformed"; detail: string };

export type HelperOutcome<T> = { ok: true; value: T } | { ok: false; error: HelperError };

export interface HelperCallOptions {
	/** Working directory the helper resolves the JJ repository from. */
	cwd: string;
	/** Explicit fallback path (tests may point at a fixture). */
	helper?: string;
	/** Hard deadline per invocation. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Bundled fallback, resolved relative to the package root (never from PATH). */
export function bundledHelperPath(): string {
	return join(dirname(new URL(import.meta.url).pathname), "..", "helper", "jj-workspace.py");
}

function isExecutable(path: string): boolean {
	try {
		const stat = statSync(path);
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

interface RawRun {
	code: number;
	signal?: string;
	out: string;
	err: string;
	spawnFailed?: string;
}

/** Milliseconds allowed for reading buffered output once the process has exited. A killed
 * helper may leave grandchildren holding its pipes; diagnostics are worth a short wait,
 * never an unbounded one. */
const DRAIN_MS = 500;

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const deadline = new Promise<string>((resolve) => {
		setTimeout(() => resolve(""), DRAIN_MS).unref?.();
	});
	try {
		return await Promise.race([new Response(stream).text(), deadline]);
	} catch {
		return "";
	}
}

async function runHelperRaw(
	helper: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<RawRun> {
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	try {
		proc = Bun.spawn([helper, ...args], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			env: { ...process.env },
		});
		// Sequential, not Promise.all with the streams: a grandchild inheriting a pipe
		// keeps it open after the helper dies, and awaiting the stream alongside the
		// exit would hang the caller well past its budget.
		const code = await proc.exited;
		const [out, err] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
		return { code, signal: proc.signalCode ?? undefined, out, err };
	} catch (error) {
		return { code: -1, out: "", err: "", spawnFailed: String(error) };
	} finally {
		try {
			proc?.kill("SIGKILL");
		} catch {
			// Already exited.
		}
	}
}

function resolveHelper(explicit?: string): { path?: string; error?: HelperError } {
	const candidate = explicit ?? bundledHelperPath();
	if (!isExecutable(candidate)) {
		return {
			error: {
				kind: "missing",
				detail: `workspace fallback is not executable: ${candidate}. Verify helper/jj-workspace.py and its 'uv run --script' shebang. Nothing was listed, created, or removed.`,
			},
		};
	}
	return { path: candidate };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRow(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	return (
		typeof value.backend === "string" &&
		typeof value.name === "string" &&
		typeof value.path === "string" &&
		(typeof value.branch === "string" || value.branch === undefined) &&
		(typeof value.change === "string" || value.change === undefined) &&
		(typeof value.state === "string" || value.state === undefined)
	);
}

function normalizeRow(value: Record<string, unknown>): WorkspaceRow {
	return {
		backend: value.backend as string,
		name: value.name as string,
		branch: typeof value.branch === "string" ? value.branch : "",
		change: typeof value.change === "string" ? value.change : "",
		state: typeof value.state === "string" ? value.state : "",
		path: value.path as string,
		managed: value.managed === true,
		primary: value.primary === true,
		stale: value.stale === true,
		note: typeof value.note === "string" ? value.note : "",
	};
}

function failureText(command: string, err: string, out: string): string {
	const stderr = err.trim();
	const stdout = out.trim();
	const lines = [`jj-workspace ${command} failed.`];
	if (stderr) lines.push(stderr.split("\n").slice(0, 8).join("\n"));
	// Some failures echo context on stdout; never mistake it for a result path.
	if (stdout) lines.push(`(stdout, not a result: ${stdout.slice(0, 200)})`);
	return lines.join("\n");
}

async function callJson<T>(
	command: string,
	args: string[],
	options: HelperCallOptions,
	parse: (json: unknown) => T | undefined,
): Promise<HelperOutcome<T>> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const resolved = resolveHelper(options.helper);
	if (!resolved.path || resolved.error) {
		return { ok: false, error: resolved.error as HelperError };
	}
	const run = await runHelperRaw(resolved.path, args, options.cwd, timeoutMs);
	if (run.spawnFailed) {
		return {
			ok: false,
			error: {
				kind: "missing",
				detail: `workspace fallback could not start (${run.spawnFailed}). Nothing was listed, created, or removed.`,
			},
		};
	}
	if (run.signal === "SIGKILL" || (run.code !== 0 && run.signal === "SIGKILL")) {
		return { ok: false, error: { kind: "timeout", detail: `jj-workspace ${command} exceeded ${timeoutMs}ms and was killed. Nothing was confirmed; re-run to observe state.` } };
	}
	if (run.code === 2) {
		return { ok: false, error: { kind: "cancelled", detail: `jj-workspace ${command} was cancelled (no output, no changes).` } };
	}
	if (run.code !== 0) {
		return { ok: false, error: { kind: "failed", detail: failureText(command, run.err, run.out) } };
	}
	let json: unknown;
	try {
		json = JSON.parse(run.out);
	} catch {
		return {
			ok: false,
			error: { kind: "malformed", detail: `jj-workspace ${command} returned unparseable JSON: ${run.out.trim().slice(0, 200)}` },
		};
	}
	const value = parse(json);
	if (value === undefined) {
		return {
			ok: false,
			error: { kind: "malformed", detail: `jj-workspace ${command} returned an unexpected JSON shape: ${run.out.trim().slice(0, 200)}` },
		};
	}
	return { ok: true, value };
}

export interface ConfiguredWorkspaceRoot {
	backend: string;
	root: string;
	path: string;
}

/** Configured managed-workspace directory and the primary workspace it is relative to. */
export async function workspaceRoot(options: HelperCallOptions): Promise<HelperOutcome<ConfiguredWorkspaceRoot>> {
	return callJson("root", ["root", "--json"], options, (json) => {
		if (!isRecord(json) || typeof json.path !== "string" || typeof json.root !== "string") return undefined;
		return {
			backend: typeof json.backend === "string" ? json.backend : "",
			root: json.root,
			path: json.path,
		};
	});
}

/** Registered JJ workspaces. Default: configured-root entries only; `all` includes external locations. */
export async function listWorkspaces(
	options: HelperCallOptions & { all?: boolean },
): Promise<HelperOutcome<WorkspaceRow[]>> {
	const args = options.all ? ["list", "--json", "--all"] : ["list", "--json"];
	return callJson("list", args, options, (json) => {
		if (!Array.isArray(json) || !json.every(isRow)) return undefined;
		return json.map(normalizeRow);
	});
}

/** Resolve one workspace to its path. Names pass through verbatim — validation is the
 * helper's job, and its refusal surfaces unchanged. */
export async function selectWorkspace(
	options: HelperCallOptions & { name: string; all?: boolean },
): Promise<HelperOutcome<string>> {
	const args = options.all
		? ["select", options.name, "--json", "--all"]
		: ["select", options.name, "--json"];
	return callJson("select", args, options, (json) => {
		if (!isRecord(json) || typeof json.path !== "string" || !json.path) return undefined;
		return json.path;
	});
}

export interface MainWorkspace {
	backend: string;
	root: string;
	prefix: string;
	path: string;
}

/** Primary workspace, mirroring the current subdirectory when it exists there. */
export async function mainWorkspace(options: HelperCallOptions): Promise<HelperOutcome<MainWorkspace>> {
	return callJson("main", ["main", "--json"], options, (json) => {
		if (!isRecord(json) || typeof json.path !== "string" || typeof json.root !== "string") return undefined;
		return {
			backend: typeof json.backend === "string" ? json.backend : "",
			root: json.root,
			prefix: typeof json.prefix === "string" ? json.prefix : "",
			path: json.path,
		};
	});
}

export interface CreatedWorkspace {
	backend: string;
	name: string;
	path: string;
}

/**
 * Create a workspace under the configured root. The name, revision, and force flag pass
 * through untouched; placement, collision, and nested-destination rules run in the fallback.
 */
export async function addWorkspace(
	options: HelperCallOptions & { name: string; revision?: string; force?: boolean },
): Promise<HelperOutcome<CreatedWorkspace>> {
	const args = ["add", options.name, "--json"];
	if (options.revision) args.push("--revision", options.revision);
	if (options.force) args.push("--force");
	return callJson(`add ${options.name}`, args, options, (json) => {
		if (!isRecord(json) || typeof json.path !== "string" || typeof json.name !== "string") return undefined;
		return {
			backend: typeof json.backend === "string" ? json.backend : "",
			name: json.name,
			path: json.path,
		};
	});
}

export interface RemovedWorkspace {
	backend: string;
	name: string;
	path: string;
	registrationRemoved: boolean;
	dirDeleted: boolean;
	notes: string[];
}

/**
 * Remove a workspace through the fallback's safeguards: dirty/untracked refusal without
 * --force, primary protection, and no implicit history deletion.
 */
export async function removeWorkspace(
	options: HelperCallOptions & { name: string; force?: boolean; deleteDir?: boolean; all?: boolean },
): Promise<HelperOutcome<RemovedWorkspace>> {
	const args = ["remove", options.name, "--json"];
	if (options.all) args.push("--all");
	if (options.force) args.push("--force");
	if (options.deleteDir) args.push("--delete-dir");
	return callJson(`remove ${options.name}`, args, options, (json) => {
		if (!isRecord(json) || typeof json.path !== "string" || typeof json.name !== "string") return undefined;
		return {
			backend: typeof json.backend === "string" ? json.backend : "",
			name: json.name,
			path: json.path,
			registrationRemoved: json.registration_removed === true,
			dirDeleted: json.dir_deleted === true,
			notes: Array.isArray(json.notes) ? json.notes.filter((n): n is string => typeof n === "string") : [],
		};
	});
}

/** One-line rendering for command output. Backend, name, branch/change, state, path. */
export function formatRow(row: WorkspaceRow): string {
	const ident = row.branch || row.change || "-";
	const flags = [
		row.primary ? "primary" : "",
		!row.managed ? "external" : "",
		row.stale ? "stale" : "",
		row.note,
	].filter(Boolean);
	return `${row.backend} ${row.name} ${ident} ${row.state} ${row.path}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`;
}

/** Human rendering of a helper failure (kind-prefixed so callers can branch on text). */
export function formatError(error: HelperError): string {
	return `[${error.kind}] ${error.detail}`;
}
