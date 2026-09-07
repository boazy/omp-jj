/**
 * Repository identity for JJ-aware behavior.
 *
 * Builds on the workspace resolver (`workspace.ts`): discovery is still a filesystem walk for
 * `.jj`, never `jj root`, because every jj command snapshots the working copy by default.
 * A colocated `.git` directory does NOT disqualify a root — JJ owns instruction and
 * workspace policy wherever `.jj` is present, and Git rules stay scoped to ordinary Git roots.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findWorkspaceRoot, resolveTargetRoot } from "./workspace.ts";

/** What the extension knows about one JJ workspace. */
export interface RepoIdentity {
	/** Canonical (symlink-resolved) workspace root. */
	root: string;
	/** Workspace name: the root's basename. */
	workspace: string;
	/** A `.git` entry is colocated at the root; JJ still owns this workspace. */
	colocated: boolean;
	/** Resolved shared-store path every workspace of this repo points at. */
	storePath: string;
	/**
	 * Stable key for the shared repository: `device:inode` of the store. Identical from any
	 * workspace of the same repo (primary or secondary), different for independent clones of
	 * the same remote. Never derived from the workspace path or the remote URL alone.
	 */
	storeKey: string;
}

/** Best-effort canonicalization: symlinks resolved, otherwise the normalized absolute path. */
export function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Resolved store directory for a workspace root, following secondary-workspace pointers. */
export function resolveStorePath(root: string): string | null {
	const pointer = join(root, ".jj", "repo");
	let stat: ReturnType<typeof statSync> | undefined;
	try {
		stat = statSync(pointer);
	} catch {
		return null;
	}
	try {
		if (stat.isDirectory()) return canonicalize(pointer);
		// Secondary workspaces keep a small file pointing at the shared store.
		const target = readFileSync(pointer, "utf8").trim();
		if (!target) return null;
		const resolved = isAbsolute(target) ? target : resolve(root, ".jj", target);
		return canonicalize(resolved);
	} catch {
		return null;
	}
}

/** Full identity for a known workspace root, or null when the store cannot be read. */
export function describeWorkspace(root: string): RepoIdentity | null {
	const canonical = canonicalize(root);
	if (!existsSync(join(canonical, ".jj"))) return null;
	const storePath = resolveStorePath(canonical);
	if (!storePath) return null;
	let storeKey: string;
	try {
		const stat = statSync(storePath);
		storeKey = `${stat.dev}:${stat.ino}`;
	} catch {
		return null;
	}
	return {
		root: canonical,
		workspace: canonical === "/" ? "/" : canonical.slice(canonical.lastIndexOf("/") + 1),
		colocated: existsSync(join(canonical, ".git")),
		storePath,
		storeKey,
	};
}

/** Identity for the workspace owning `startDir`, or null outside any JJ workspace. */
export function identityForDir(startDir: string): RepoIdentity | null {
	const root = findWorkspaceRoot(startDir);
	return root ? describeWorkspace(root) : null;
}

export interface RepoTargets {
	/** One identity per distinct workspace root, innermost-first per target. */
	repos: RepoIdentity[];
	/** Canonical roots that resolved to no JJ workspace (ordinary Git, plain dirs, ...). */
	nonJj: string[];
}

/**
 * Resolve the repositories a turn touches, from the session cwd, explicit tool paths, and any
 * cwd overrides the tool carries (e.g. `debug`'s `cwd`). Paths canonicalize before lookup, so
 * the same checkout reached via a symlink and via its real path resolves once. Nested
 * repositories stay distinct: each target keeps its innermost owner, and different owners are
 * never collapsed into one — they have separate operation logs and separate checkpoints.
 */
export function resolveRepoTargets(options: {
	cwd: string;
	paths?: readonly string[];
	extraCwds?: readonly string[];
}): RepoTargets {
	const { cwd } = options;
	const seen = new Map<string, RepoIdentity>();
	const nonJj = new Set<string>();

	const consider = (dir: string) => {
		const canonical = canonicalize(dir);
		const identity = identityForDir(canonical);
		if (identity) {
			if (!seen.has(identity.root)) seen.set(identity.root, identity);
		} else {
			nonJj.add(canonical);
		}
	};

	const cwdRoot = findWorkspaceRoot(cwd);
	if (cwdRoot) {
		const identity = describeWorkspace(cwdRoot);
		if (identity && !seen.has(identity.root)) seen.set(identity.root, identity);
	} else {
		nonJj.add(canonicalize(cwd));
	}

	for (const extra of options.extraCwds ?? []) {
		let dir = extra.trim();
		if (!dir) continue;
		if (!isAbsolute(dir)) dir = resolve(cwd, dir);
		consider(dir);
	}

	for (const raw of options.paths ?? []) {
		const root = resolveTargetRoot(raw, cwd);
		if (root) {
			const identity = describeWorkspace(root);
			if (identity) {
				if (!seen.has(identity.root)) seen.set(identity.root, identity);
				continue;
			}
		}
		// Not a JJ target: record the canonical path so callers can keep Git rules scoped to it.
		const trimmed = raw.trim();
		if (trimmed && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !trimmed.startsWith("xd://")) {
			try {
				const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
				nonJj.add(canonicalize(abs));
			} catch {
				// Unresolvable input is not a repository either way; ignore it.
			}
		}
	}

	return { repos: [...seen.values()], nonJj: [...nonJj] };
}

/** Read-only working-copy summary. Uses `--ignore-working-copy` throughout: inspection must
 * never snapshot. Returns undefined when jj is missing, the root is not a workspace, or any
 * read fails. Never throws. */
export async function readRepoStatus(
	root: string,
	options?: { binary?: string | null; timeoutMs?: number },
): Promise<
	{ changeId: string; commitId: string; description: string; summary: string } | undefined
> {
	let binary = options?.binary;
	if (binary === undefined) binary = Bun.which("jj");
	if (!binary) return undefined;
	const timeoutMs = options?.timeoutMs ?? 5_000;

	const runRead = async (args: string[]): Promise<string | undefined> => {
		let proc: ReturnType<typeof Bun.spawn> | undefined;
		try {
			proc = Bun.spawn([binary as string, "--ignore-working-copy", ...args], {
				cwd: root,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
				timeout: timeoutMs,
				killSignal: "SIGKILL",
			});
			const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
			if (code !== 0 || proc.signalCode === "SIGKILL") return undefined;
			const trimmed = text.trim();
			return trimmed ? trimmed : undefined;
		} catch {
			return undefined;
		} finally {
			try {
				proc?.kill("SIGKILL");
			} catch {
				// Already exited.
			}
		}
	};

	const [identity, summary] = await Promise.all([
		runRead(["log", "-r", "@", "--no-graph", "-T", "change_id ++ \"\\n\" ++ commit_id ++ \"\\n\" ++ description"]),
		runRead(["st"]),
	]);
	if (!identity || !summary) return undefined;
	const [changeId = "", commitId = "", ...descLines] = identity.split("\n");
	if (!changeId || !commitId) return undefined;
	return { changeId, commitId, description: descLines.join("\n").trim(), summary };
}

/** Nearest existing ancestor directory of an absolute path (for programmatic callers). */
export function nearestExistingDir(absPath: string): string | null {
	let dir = absPath;
	try {
		if (statSync(dir).isDirectory()) return canonicalize(dir);
	} catch {
		// Fall through to the walk.
	}
	dir = dirname(dir);
	for (;;) {
		try {
			if (statSync(dir).isDirectory()) return canonicalize(dir);
		} catch {
			// Keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
