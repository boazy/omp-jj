/**
 * Session-linked checkpoint records and recovery operations.
 *
 * Every extension-managed capture that produces a restorable state (ok, unchanged, or partial)
 * is persisted as a namespaced `custom` session entry, alongside the toggle state pattern:
 * the in-memory index is authoritative live, and `refresh` rebuilds it from entries on
 * start/switch/resume/fork/tree-navigation. Records carry the workspace identity plus the
 * EXACT commit and operation ids — a change id alone can never restore an earlier version,
 * so it is recorded for display only.
 *
 * Grouping: each user request mints one request id in `before_agent_start`; tool-boundary
 * checkpoints reference it. Read-only requests run no tools, so they leave no checkpoints.
 * Unchanged captures share the previous operation id; this module never creates changes or
 * bookmarks to manufacture checkpoints — it only runs `jj status` (capture) and read-only
 * `--ignore-working-copy` inspection, plus the two explicit restore commands below.
 */
import { statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { canonicalize } from "./repo.ts";
import type { CaptureOutcome } from "./snapshot.ts";

/** Custom entry type for checkpoint records. */
export const CHECKPOINT_CUSTOM_TYPE = "omp-jj-checkpoint";

/** Where in the tool lifecycle a checkpoint was taken. */
export type BoundaryKind = "pre" | "post" | "session" | "pre-restore" | "post-restore";

export interface CheckpointRecord {
	v: 1;
	/** User-request group, or null for session-level boundaries (start/compact). */
	requestId: string | null;
	boundary: BoundaryKind;
	callId?: string;
	tool?: string;
	root: string;
	workspace: string;
	storeKey: string;
	opId?: string;
	commitId?: string;
	changeId?: string;
	status: CaptureOutcome["status"];
	message?: string;
	at: string;
}

const BOUNDARIES: readonly BoundaryKind[] = ["pre", "post", "session", "pre-restore", "post-restore"];

function isRecord(value: unknown): value is CheckpointRecord {
	if (!value || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return (
		r.v === 1 &&
		(r.requestId === null || typeof r.requestId === "string") &&
		typeof r.boundary === "string" &&
		(BOUNDARIES as readonly string[]).includes(r.boundary) &&
		typeof r.root === "string" &&
		typeof r.workspace === "string" &&
		typeof r.storeKey === "string" &&
		typeof r.status === "string" &&
		typeof r.at === "string"
	);
}

/** Session-scoped in-memory index over persisted checkpoint entries. */
export class CheckpointStore {
	private readonly records = new Map<string, CheckpointRecord[]>();

	list(sessionId: string): CheckpointRecord[] {
		return [...(this.records.get(sessionId) ?? [])];
	}

	add(sessionId: string, record: CheckpointRecord): void {
		const existing = this.records.get(sessionId);
		if (existing) existing.push(record);
		else this.records.set(sessionId, [record]);
	}

	/** Rebuild one session's index from its entries (resume/fork/navigation). */
	refresh(sessionId: string, entries: readonly unknown[]): CheckpointRecord[] {
		const rebuilt = readCheckpointEntries(entries);
		this.records.set(sessionId, rebuilt);
		return [...rebuilt];
	}
}

/** Latest-first scan is wrong here: order is the checkpoint timeline, oldest first. */
export function readCheckpointEntries(entries: readonly unknown[]): CheckpointRecord[] {
	const found: CheckpointRecord[] = [];
	for (const entry of entries) {
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (!candidate || typeof candidate !== "object") continue;
		if (candidate.type !== "custom" || candidate.customType !== CHECKPOINT_CUSTOM_TYPE) continue;
		if (isRecord(candidate.data)) found.push({ ...(candidate.data as CheckpointRecord) });
	}
	return found;
}

/** Short-id display (12 hex chars, matching `jj` short prefixes). */
export function shortId(id: string | undefined): string {
	return id ? id.slice(0, 12) : "(none)";
}

export interface JjRunResult {
	code: number;
	signal?: string;
	out: string;
	err: string;
}

/**
 * Live-PATH lookup: `Bun.which` does not observe `process.env.PATH` changes made after
 * startup, so test doubles on PATH (and user PATH edits mid-session) need a manual scan.
 */
export function whichBin(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			const st = statSync(candidate);
			if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
		} catch {
			// Not present here; keep scanning.
		}
	}
	return undefined;
}

/** Bounded jj invocation. Never throws: spawn failure surfaces as code -1. */
export async function runJj(
	root: string,
	args: string[],
	options?: { timeoutMs?: number },
): Promise<JjRunResult> {
	const binary = whichBin("jj");
	if (!binary) return { code: -1, out: "", err: "jj not installed" };
	const timeoutMs = options?.timeoutMs ?? 10_000;
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	try {
		proc = Bun.spawn([binary, ...args], {
			cwd: root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		const [code, out, err] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text().catch(() => ""),
			new Response(proc.stderr).text().catch(() => ""),
		]);
		return { code, signal: proc.signalCode ?? undefined, out, err };
	} catch (error) {
		return { code: -1, out: "", err: String(error) };
	} finally {
		try {
			proc?.kill("SIGKILL");
		} catch {
			// Already exited.
		}
	}
}

/** Whether the referenced operation and commit are still available. Read-only. */
export async function validateCheckpoint(
	root: string,
	record: CheckpointRecord,
): Promise<{ op: boolean; commit: boolean }> {
	const [op, commit] = await Promise.all([
		record.opId
			? runJj(root, ["--ignore-working-copy", "op", "show", record.opId], { timeoutMs: 5_000 }).then(
					(r) => r.code === 0,
				)
			: Promise.resolve(false),
		record.commitId
			? runJj(
					root,
					["--ignore-working-copy", "log", "-r", record.commitId, "--no-graph", "-T", "commit_id"],
					{ timeoutMs: 5_000 },
				).then((r) => r.code === 0)
			: Promise.resolve(false),
	]);
	return { op, commit };
}

/** Current operation id, newest first read. Read-only. */
export async function currentOpId(root: string): Promise<string | undefined> {
	const result = await runJj(
		root,
		["--ignore-working-copy", "op", "log", "--limit", "1", "--no-graph", "-T", "id"],
		{ timeoutMs: 5_000 },
	);
	if (result.code !== 0) return undefined;
	const id = result.out.trim();
	return id ? id : undefined;
}

function truncateLines(text: string, maxLines: number, maxChars: number): string {
	const trimmed = text.trim();
	const clipped = trimmed.split("\n").length > maxLines || trimmed.length > maxChars;
	const kept = trimmed.split("\n").slice(0, maxLines).join("\n").slice(0, maxChars);
	return clipped ? `${kept}\n…(truncated)` : kept;
}

/** Impact preview for a whole-repository restore. Read-only. */
export async function previewStateRestore(
	root: string,
	targetOpId: string,
): Promise<{ currentOp?: string; diff?: string; summary?: string; unavailable: string | null }> {
	const current = await currentOpId(root);
	if (!current) return { unavailable: "current repository state is unreadable" };
	if (current === targetOpId) {
		return { currentOp: current, unavailable: "target is already the current operation" };
	}
	const [diff, summary] = await Promise.all([
		runJj(root, ["--ignore-working-copy", "op", "diff", "--from", current, "--to", targetOpId], {
			timeoutMs: 10_000,
		}),
		runJj(root, ["--ignore-working-copy", "st"], { timeoutMs: 5_000 }),
	]);
	if (diff.code !== 0) {
		return {
			currentOp: current,
			unavailable: `cannot diff against target operation: ${diff.err.trim() || "unknown error"}`,
		};
	}
	return {
		currentOp: current,
		diff: truncateLines(diff.out, 40, 3000),
		summary: summary.code === 0 ? truncateLines(summary.out, 8, 800) : undefined,
		unavailable: null,
	};
}

/**
 * Restore file contents from a recorded commit without rewinding bookmarks: `jj restore`
 * writes the paths into the working copy as a new state. Intentional mutation — callers
 * capture a pre-restore checkpoint first.
 */
export async function restoreFiles(
	root: string,
	commitId: string,
	paths: string[],
): Promise<{ ok: boolean; detail: string }> {
	// jj filesets are repo-relative: absolute tool paths must be translated, and anything
	// escaping the workspace is refused rather than reinterpreted.
	const scoped: string[] = [];
	const skipped: string[] = [];
	for (const raw of paths) {
		// Canonicalize first: tool paths may arrive via symlinked prefixes (/var vs
		// /private/var) that would otherwise look like they escape the workspace.
		const rel = relative(root, canonicalize(isAbsolute(raw) ? raw : join(root, raw)));
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) skipped.push(raw);
		else scoped.push(rel);
	}
	if (paths.length > 0 && scoped.length === 0) {
		return { ok: false, detail: `no selected paths are inside ${root}: ${skipped.join(", ")}` };
	}
	const args =
		scoped.length > 0 ? ["restore", "--from", commitId, "--", ...scoped] : ["restore", "--from", commitId];
	const result = await runJj(root, args, { timeoutMs: 30_000 });
	if (result.code !== 0) {
		return { ok: false, detail: result.err.trim() || `jj restore exited ${result.code}` };
	}
	const skippedNote = skipped.length > 0 ? ` Skipped outside workspace: ${skipped.join(", ")}.` : "";
	return { ok: true, detail: `${result.out.trim() || result.err.trim()}${skippedNote}` };
}

/**
 * Restore whole-repository state to a recorded operation. Creates a NEW operation (it never
 * rewrites history in place), but working copies, heads, and bookmarks all move — callers
 * require explicit authorization first.
 */
export async function restoreState(
	root: string,
	opId: string,
): Promise<{ ok: boolean; detail: string; newOpId?: string }> {
	const result = await runJj(root, ["op", "restore", opId], { timeoutMs: 30_000 });
	if (result.code !== 0) {
		return { ok: false, detail: result.err.trim() || `jj op restore exited ${result.code}` };
	}
	return { ok: true, detail: result.out.trim() || result.err.trim(), newOpId: await currentOpId(root) };
}
