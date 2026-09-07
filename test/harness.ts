/**
 * Shared test scaffolding: throwaway jj workspaces, `jj op log` inspection, and a stub host that
 * captures the handlers the extension registers so they can be driven in the real order.
 */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompJJ from "../src/index.ts";

export const JJ = Bun.which("jj");
export const hasJj = JJ !== null;

async function jj(root: string, args: string[]): Promise<{ code: number; out: string }> {
	if (!JJ) throw new Error("jj not installed");
	const proc = Bun.spawn([JJ, ...args], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
	return { code, out };
}

const scratchDirs: string[] = [];

/** Creates a throwaway directory, registered for `cleanupScratch()`. */
export async function makeDir(prefix = "omp-jj-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	scratchDirs.push(dir);
	return dir;
}

/** Creates a throwaway jj workspace. */
export async function makeRepo(prefix = "omp-jj-repo-"): Promise<string> {
	const dir = await makeDir(prefix);
	const { code } = await jj(dir, ["git", "init", "--quiet"]);
	if (code !== 0) throw new Error(`jj git init failed in ${dir}`);
	return dir;
}

/** Creates a throwaway jj workspace colocated with Git metadata. */
export async function makeColocatedRepo(): Promise<string> {
	const dir = await makeDir("omp-jj-colocated-");
	const { code } = await jj(dir, ["git", "init", "--colocate", "--quiet"]);
	if (code !== 0) throw new Error(`jj git init --colocate failed in ${dir}`);
	return dir;
}

export async function cleanupScratch(): Promise<void> {
	await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	scratchDirs.length = 0;
}

/**
 * Operation ids, newest first. `--ignore-working-copy` is essential: without it the inspection
 * command would snapshot the working copy and perturb what it is measuring.
 */
export async function opIds(root: string): Promise<string[]> {
	const { out } = await jj(root, [
		"op",
		"log",
		"--ignore-working-copy",
		"--no-graph",
		"-T",
		'id.short() ++ "\\n"',
	]);
	return out.trim().split("\n").filter(Boolean);
}

export async function opCount(root: string): Promise<number> {
	return (await opIds(root)).length;
}

export async function restoreOp(root: string, opId: string): Promise<void> {
	const { code } = await jj(root, ["op", "restore", opId]);
	if (code !== 0) throw new Error(`jj op restore ${opId} failed in ${root}`);
}

/** Makes the working copy dirty, so a snapshot has something to record. */
export async function touchFile(root: string, name: string, body = String(Date.now())) {
	await Bun.write(join(root, name), `${body}\n`);
}

export interface LogEntry {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	fields?: Record<string, unknown>;
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export interface StubHost {
	/** Fires every handler registered for an event, in registration order. */
	emit(event: string, payload: Record<string, unknown>, cwd: string): Promise<void>;
	/** Fires before_agent_start handlers; returns the first defined result. */
	prompt(cwd: string, systemPrompt?: string[]): Promise<unknown>;
	/** Convenience for the common tool_call/tool_result pair around one executing tool. */
	toolCall(payload: Record<string, unknown>, cwd: string): Promise<void>;
	toolResult(payload: Record<string, unknown>, cwd: string): Promise<void>;
	/** Fires tool_call handlers and returns the first defined result (block verdicts). */
	guard(payload: Record<string, unknown>, cwd: string): Promise<unknown>;
	/** Invokes a registered toggle command; returns notifications it produced. */
	command(name: string, args: string, cwd: string): Promise<string[]>;
	/** Queues select-dialog answers as option indices (undefined = dismiss). */
	pick(...indices: Array<number | undefined>): void;
	/** Persisted custom entries (toggles + checkpoints), for resume simulation. */
	entries(): Array<{ type: string; customType: string; data?: unknown }>;
	setEntries(next: Array<{ type: string; customType: string; data?: unknown }>): void;
	/** Applies registered autocomplete factories to a base provider, in order. */
	wrapProvider(base: {
		getSuggestions: (...args: never[]) => Promise<unknown>;
		trySyncSlashCompletion?: (text: string) => unknown;
		applyCompletion?: (...args: never[]) => unknown;
	}): Record<string, (...args: never[]) => unknown>;
	sessionId: string;
	logs: LogEntry[];
	/** `reason` field of every recorded snapshot, in order. */
	snapshotReasons(): string[];
	warnings(): LogEntry[];
	label?: string;
}

/** Loads the extension against a stub host, mirroring what the runtime provides. */
export function startExtension(options?: { sessionId?: string }): StubHost {
	const sessionId = options?.sessionId ?? "test-session";
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const logs: LogEntry[] = [];
	const record = (level: LogEntry["level"]) => (message: string, fields?: Record<string, unknown>) =>
		void logs.push({ level, message, fields });
	const notifications: string[] = [];
	const providers: Array<(current: unknown) => unknown> = [];
	const commands = new Map<
		string,
		{
			description?: string;
			getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
			handler: (args: string, ctx: unknown) => Promise<void>;
		}
	>();
	const entries: Array<{ type: string; customType: string; data?: unknown }> = [];
	const pickQueue: Array<number | undefined> = [];

	const makeCtx = (cwd: string) => ({
		cwd,
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string) => void notifications.push(message),
			addAutocompleteProvider: (factory: (current: unknown) => unknown) => {
				providers.push(factory);
			},
			select: async (
				_title: string,
				options: Array<string | { label: string; description?: string }>,
			): Promise<string | undefined> => {
				const at = pickQueue.shift();
				if (at === undefined) return undefined;
				const option = options[at];
				if (option === undefined) return undefined;
				return typeof option === "string" ? option : option.label;
			},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries,
		},
	});

	const host: StubHost = {
		sessionId,
		logs,
		async emit(event, payload, cwd) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, makeCtx(cwd));
		},
		async prompt(cwd, systemPrompt = []) {
			for (const handler of handlers.get("before_agent_start") ?? []) {
				const result = await handler({ prompt: "test prompt", systemPrompt }, makeCtx(cwd));
				if (result !== undefined && result !== null) return result;
			}
			return undefined;
		},
		async toolCall(payload, cwd) {
			await host.emit("tool_call", payload, cwd);
		},
		async toolResult(payload, cwd) {
			await host.emit("tool_result", { isError: false, content: [], ...payload }, cwd);
		},
		async guard(payload, cwd) {
			for (const handler of handlers.get("tool_call") ?? []) {
				const result = await handler(payload, makeCtx(cwd));
				if (result !== undefined && result !== null) return result;
			}
			return undefined;
		},
		async command(name, args, cwd) {
			const command = commands.get(name);
			if (!command) throw new Error(`unknown command ${name}`);
			notifications.length = 0;
			await command.handler(args, makeCtx(cwd));
			return [...notifications];
		},
		pick(...indices: Array<number | undefined>) {
			pickQueue.push(...indices);
		},
		entries() {
			return entries;
		},
		setEntries(next: Array<{ type: string; customType: string; data?: unknown }>) {
			entries.length = 0;
			entries.push(...next);
		},
		wrapProvider(base) {
			let current: unknown = base;
			for (const factory of providers) current = factory(current);
			return current as Record<string, (...args: never[]) => unknown>;
		},
		snapshotReasons() {
			return logs
				.filter((entry) => entry.level === "debug" && entry.message === "jj snapshot")
				.map((entry) => String(entry.fields?.reason));
		},
		warnings() {
			return logs.filter((entry) => entry.level === "warn");
		},
	};

	const api = {
		logger: {
			debug: record("debug"),
			info: record("info"),
			warn: record("warn"),
			error: record("error"),
		},
		setLabel(label: string) {
			host.label = label;
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const existing = handlers.get(event);
			if (existing) existing.push(handler);
			else handlers.set(event, [handler]);
		},
		registerCommand(
			name: string,
			options: {
				description?: string;
				getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
				handler: (args: string, ctx: unknown) => Promise<void>;
			},
		) {
			commands.set(name, options);
		},
		appendEntry<T>(customType: string, data?: T) {
			entries.push({ type: "custom", customType, data });
		},
	};

	// The stub implements the surface this extension uses; the real API is far wider.
	ompJJ(api as unknown as Parameters<typeof ompJJ>[0]);
	return host;
}

/** Writes an executable stand-in for `jj`, for exercising slow and failing snapshots. */
export async function makeFakeJj(script: string): Promise<string> {
	const dir = await makeDir("omp-jj-fake-");
	const path = join(dir, "fake-jj");
	await Bun.write(path, `#!/bin/sh\n${script}\n`);
	// Bun.write has no mode option, and a non-executable stub would surface as a spawn error.
	await chmod(path, 0o755);
	return path;
}

/**
 * Writes an executable stand-in for `gh`. Control and observation are file-based, because
 * spawned processes do not observe `process.env` mutations in this runtime: marker files in
 * the binary's directory steer behavior (`pr-exists`, `create-fails`), and every invocation
 * appends to `gh.log` in the same directory. Returns paths for PATH prepending and reading.
 */
export async function makeFakeGh(): Promise<{ bin: string; dir: string; log: string }> {
	const dir = await makeDir("omp-jj-fake-gh-");
	const bin = join(dir, "gh");
	const log = join(dir, "gh.log");
	await Bun.write(
		bin,
		[
			"#!/bin/sh",
			'dir=$(dirname "$0")',
			'echo "gh $@" >> "$dir/gh.log"',
			'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
			'  if [ -f "$dir/pr-exists" ]; then echo "https://example.com/o/r/pull/7"; exit 0; fi',
			'  echo "no pull requests found" >&2; exit 1',
			"fi",
			'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
			'  if [ -f "$dir/create-fails" ]; then echo "auth failed" >&2; exit 1; fi',
			'  echo "https://example.com/o/r/pull/8"; exit 0',
			"fi",
			'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then',
			'  echo "o/r https://example.com/o/r"; exit 0',
			"fi",
			'echo "fake gh: unhandled $@" >&2; exit 1',
			"",
		].join("\n"),
	);
	await chmod(bin, 0o755);
	return { bin, dir, log };
}

/** Prepends a directory to PATH, returning a restore function. */
export function withPathPrefix(dir: string): () => void {
	const previous = process.env.PATH ?? "";
	process.env.PATH = `${dir}:${previous}`;
	return () => {
		process.env.PATH = previous;
	};
}

/** Creates an isolated bare git remote for publication mechanics (no GitHub contact). */
export async function makeBareRemote(): Promise<string> {
	const git = Bun.which("git");
	if (!git) throw new Error("git not installed");
	const dir = await makeDir("omp-jj-bare-");
	const remote = join(dir, "up.git");
	const proc = Bun.spawn([git, "init", "--bare", "-q", remote], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	if ((await proc.exited) !== 0) throw new Error("git init --bare failed");
	return remote;
}

/** Branch names present in a bare remote. */
export async function bareBranches(remote: string): Promise<string[]> {
	const git = Bun.which("git") as string;
	const proc = Bun.spawn([git, "--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
	if (code !== 0) return [];
	return out.trim().split("\n").filter(Boolean);
}
