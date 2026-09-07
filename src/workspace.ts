/**
 * Maps target paths to the jj workspace that owns them.
 *
 * Discovery is a filesystem walk for a `.jj` entry, never `jj root`: every jj command snapshots
 * the working copy by default, so shelling out here would create checkpoints during discovery.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Targets } from "./classify.ts";

/** Positive lookups are cached forever; misses expire so `jj git init` mid-session is picked up. */
const MISSING_ROOT_TTL_MS = 60_000;

const rootCache = new Map<string, { root: string | null; expiresAt: number }>();

/** Drops memoized lookups. Needed by tests that create or remove workspaces between cases. */
export function clearWorkspaceCache(): void {
	rootCache.clear();
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Nearest existing ancestor directory, so a not-yet-created file still resolves to a workspace. */
function nearestExistingDir(absPath: string): string | null {
	let dir = isDirectory(absPath) ? absPath : dirname(absPath);
	for (;;) {
		if (isDirectory(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Nearest ancestor of `startDir` containing `.jj`, or null when the path is not in a workspace. */
export function findWorkspaceRoot(startDir: string): string | null {
	const now = Date.now();
	const cached = rootCache.get(startDir);
	if (cached && (cached.root !== null || cached.expiresAt > now)) return cached.root;

	const visited: string[] = [];
	let dir = startDir;
	for (;;) {
		visited.push(dir);
		if (existsSync(resolve(dir, ".jj"))) {
			for (const seen of visited) {
				rootCache.set(seen, { root: dir, expiresAt: Number.POSITIVE_INFINITY });
			}
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const seen of visited) {
		rootCache.set(seen, { root: null, expiresAt: now + MISSING_ROOT_TTL_MS });
	}
	return null;
}

/**
 * Workspace owning one tool target. Internal URL schemes (`xd://`, `local://`, `memory://`, ...)
 * are not filesystem paths and resolve to null; `file://` is unwrapped and `~` expanded. Trailing
 * selectors (`archive.zip:member`, `db.sqlite:table:key`) need no special handling, since walking
 * up from a nonexistent leaf lands in the right directory anyway.
 */
export function resolveTargetRoot(raw: string, cwd: string): string | null {
	let path = raw.trim();
	if (path.startsWith("file://")) path = path.slice("file://".length);
	else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
	if (path === "~" || path.startsWith("~/")) path = resolve(homedir(), path.slice(1) || ".");
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const dir = nearestExistingDir(abs);
	return dir ? findWorkspaceRoot(dir) : null;
}

/** Distinct workspace roots to snapshot for one classification. */
export function rootsFor(targets: Targets, cwd: string): string[] {
	if (!targets) return [];
	if (targets === "cwd") {
		const root = findWorkspaceRoot(cwd);
		return root ? [root] : [];
	}
	const roots = new Set<string>();
	for (const target of targets) {
		const root = resolveTargetRoot(target, cwd);
		if (root) roots.add(root);
	}
	return [...roots];
}
