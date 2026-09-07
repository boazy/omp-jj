/**
 * Preview helpers for consequential history operations (absorb/split/squash/rebase and the
 * destructive describe/metaedit/abandon/undo family).
 *
 * Every preview is built from `--ignore-working-copy` reads: inspection never snapshots. A
 * preview names the source and destination changes, affected descendants and bookmarks, and
 * whether published commits would be rewritten — the same explicit targets must then be used
 * for execution. `fingerprint`/`drifted` let callers revalidate state before acting: if the
 * repository moved since the preview, stop and refresh instead of executing stale intent.
 *
 * Never use an unscoped latest-operation undo as automatic rollback; recovery stays with the
 * session-linked checkpoint flow in recovery.ts.
 */
import { runJj, shortId } from "./recovery.ts";

/** One commit inside a history-operation scope. */
export interface HistoryCommit {
	commitId: string;
	changeId: string;
	description: string;
	bookmarks: string[];
	remoteBookmarks: string[];
	immutable: boolean;
}

/** Commits an operation would rewrite, plus the blast radius around them. */
export interface HistoryScope {
	/** Revset describing the rewritten set, for display. */
	range: string;
	/** Extra display context that is not part of the rewritten set (e.g. rebase destination). */
	detail?: string;
	/** Commits that would be rewritten. */
	revs: HistoryCommit[];
	/** Commits that would move as a consequence (rebased descendants). */
	descendants: HistoryCommit[];
	/** Working-copy files involved, for absorb/split. Empty when not applicable. */
	files: string[];
	/** Warnings that do not stop execution on their own (explained, not hidden). */
	warnings: string[];
}

const HEX = /^[0-9a-f]+$/i;
/**
 * The colocated/git-backend mirror (`<name>@git`) tracks local bookmarks; it is not
 * publication. Published means a real remote saw the commit.
 */
export function hasPublishedMarker(commit: { remoteBookmarks: string[] }): boolean {
	return commit.remoteBookmarks.some((name) => !name.endsWith("@git"));
}

/** Split template record separator output into per-commit blocks. */
function parseCommits(out: string, immutable: Set<string>): HistoryCommit[] {
	const commits: HistoryCommit[] = [];
	for (const block of out.split("@@\n")) {
		const lines = block.split("\n");
		const [commitId = "", changeId = "", description = "", bookmarks = "", remotes = ""] = lines;
		if (!commitId || !HEX.test(commitId)) continue;
		commits.push({
			commitId,
			changeId,
			description: description.trim(),
			bookmarks: bookmarks.trim() ? bookmarks.trim().split(/\s+/) : [],
			remoteBookmarks: remotes.trim() ? remotes.trim().split(/\s+/) : [],
			immutable: immutable.has(commitId),
		});
	}
	return commits;
}

/**
 * Commits matching a revset with bookmark and immutability detail. Returns undefined when the
 * revset cannot be resolved. Callers build revsets from ids this module returned, so quoting
 * stays safe; anything else is rejected before it reaches jj.
 */
export async function listCommits(root: string, revset: string): Promise<HistoryCommit[] | undefined> {
	const [listed, frozen] = await Promise.all([
		runJj(
			root,
			[
				"--ignore-working-copy",
				"log",
				"--no-graph",
				"-r",
				revset,
				"-T",
				'commit_id ++ "\\n" ++ change_id ++ "\\n" ++ description.first_line() ++ "\\n" ++ bookmarks ++ "\\n" ++ remote_bookmarks ++ "\\n@@\\n"',
			],
			{ timeoutMs: 10_000 },
		),
		runJj(
			root,
			["--ignore-working-copy", "log", "--no-graph", "-r", `(${revset}) & immutable()`, "-T", "commit_id ++ \"\\n\""],
			{ timeoutMs: 10_000 },
		),
	]);
	if (listed.code !== 0 || frozen.code !== 0) return undefined;
	const immutable = new Set(frozen.out.trim().split("\n").filter(Boolean));
	return parseCommits(listed.out, immutable);
}

/** Files with working-copy changes, for absorb/split previews. Empty when clean or unreadable. */
export async function workingCopyFiles(root: string): Promise<string[]> {
	const result = await runJj(root, ["--ignore-working-copy", "diff", "--name-only"], {
		timeoutMs: 10_000,
	});
	if (result.code !== 0) return [];
	return result.out.trim().split("\n").map((f) => f.trim()).filter(Boolean);
}

async function withDescendants(root: string, range: string): Promise<HistoryScope | { unavailable: string }> {
	const revs = await listCommits(root, range);
	if (!revs) return { unavailable: `cannot resolve revision set: ${range}` };
	const ids = revs.map((r) => r.commitId);
	const descendants =
		ids.length > 0
			? ((await listCommits(root, `descendants(${ids.join("|")})`)) ?? [])
			: [];
	return { range, revs, descendants, files: [], warnings: [] };
}

/** Guardrail-safe revision token: hex ids and @-relative expressions only. */
export function cleanRev(token: string): string | undefined {
	const trimmed = token.trim().replace(/^["']|["']$/g, "");
	if (/^@(-+\d*|\+?\d*)$/.test(trimmed) || trimmed === "@") return trimmed;
	if (HEX.test(trimmed)) return trimmed;
	return undefined;
}

/** Preview `jj absorb`: working-copy files folded into owning ancestors. */
export async function previewAbsorb(root: string): Promise<HistoryScope | { unavailable: string }> {
	const files = await workingCopyFiles(root);
	const scope = await withDescendants(root, "ancestors(@)");
	if ("unavailable" in scope) return scope;
	const warnings: string[] = [
		// Read-only inspection sees recorded state only: files changed since the last
		// snapshot are invisible until the next capture records them.
		"file list reflects the last snapshotted state; unsnapshotted edits are invisible to read-only inspection",
	];
	if (files.length === 0) warnings.push("working copy is clean; absorb would be a no-op");
	return { ...scope, files, warnings };
}

/** Preview `jj squash`: fold `--from` into `--into` (defaults mirror jj: @ into @-). */
export async function previewSquash(
	root: string,
	options?: { from?: string; into?: string },
): Promise<HistoryScope | { unavailable: string }> {
	const from = (options?.from && cleanRev(options.from)) || "@";
	const into = (options?.into && cleanRev(options.into)) || "@-";
	if (options?.from && !cleanRev(options.from)) return { unavailable: `unresolvable revision: ${options.from}` };
	if (options?.into && !cleanRev(options.into)) return { unavailable: `unresolvable revision: ${options.into}` };
	return withDescendants(root, `${from} | ${into}`);
}

/** Preview `jj split`: divide a revision (default @) into parts. */
export async function previewSplit(
	root: string,
	options?: { rev?: string },
): Promise<HistoryScope | { unavailable: string }> {
	const rev = (options?.rev && cleanRev(options.rev)) || "@";
	if (options?.rev && !cleanRev(options.rev)) return { unavailable: `unresolvable revision: ${options.rev}` };
	const files = rev === "@" ? await workingCopyFiles(root) : [];
	const scope = await withDescendants(root, rev);
	if ("unavailable" in scope) return scope;
	return { ...scope, files, warnings: ["file list reflects the last snapshotted state; unsnapshotted edits are invisible to read-only inspection"] };
}

/** Preview `jj rebase -s <source> -d <dest>`: move a subtree. */
export async function previewRebase(
	root: string,
	options: { source?: string; dest?: string },
): Promise<HistoryScope | { unavailable: string }> {
	const source = options.source && cleanRev(options.source);
	const dest = options.dest && cleanRev(options.dest);
	if (!source) return { unavailable: "rebase needs an explicit source revision" };
	if (!dest) return { unavailable: "rebase needs an explicit destination revision" };
	// Only the source side is rewritten; the destination is context, never a rewrite target
	// (rebasing onto an immutable base is ordinary and must not trip the frozen check).
	const scope = await withDescendants(root, source);
	if ("unavailable" in scope) return scope;
	return { ...scope, detail: `onto ${dest}` };
}

/** Preview describe/metaedit/abandon targets: the revision plus everything below it. */
export async function previewTarget(
	root: string,
	rev: string,
): Promise<HistoryScope | { unavailable: string }> {
	const cleaned = cleanRev(rev);
	if (!cleaned) return { unavailable: `unresolvable revision: ${rev}` };
	return withDescendants(root, cleaned);
}

function fmtCommitList(commits: HistoryCommit[]): string {
	return commits
		.map(
			(c) =>
				`  ${c.changeId.slice(0, 8)} ${c.commitId.slice(0, 8)}${c.description ? ` "${c.description}"` : ""}${c.bookmarks.length > 0 ? ` [${c.bookmarks.join(", ")}]` : ""}${c.remoteBookmarks.length > 0 ? ` <${c.remoteBookmarks.join(", ")}>` : ""}${c.immutable ? " (immutable)" : ""}`,
		)
		.join("\n");
}

/** Commits carrying remote bookmarks: the published-rewrite signal. */
export function publishedCommits(scope: HistoryScope): HistoryCommit[] {
	return [...scope.revs, ...scope.descendants].filter(hasPublishedMarker);
}

/** Commits jj itself would refuse to rewrite. */
export function immutableCommits(scope: HistoryScope): HistoryCommit[] {
	return [...scope.revs, ...scope.descendants].filter((c) => c.immutable);
}

/** One-line or full rendering of a scope. Full detail is the explain-on presentation. */
export function formatScope(scope: HistoryScope, verbose: boolean): string {
	const rewritten = scope.revs.length;
	const moved = scope.descendants.length;
	const published = publishedCommits(scope).length;
	const frozen = immutableCommits(scope).length;
	const head = `rewrites ${rewritten} commit(s), moves ${moved} descendant(s)${published > 0 ? `, ${published} published` : ""}${frozen > 0 ? `, ${frozen} immutable` : ""} [${scope.range}]`;
	if (!verbose) return head;
	const parts = [head, `Rewritten:\n${fmtCommitList(scope.revs) || "  (none)"}`];
	if (scope.descendants.length > 0) parts.push(`Descendants (rebased as a consequence):\n${fmtCommitList(scope.descendants)}`);
	if (scope.files.length > 0) parts.push(`Files:\n${scope.files.map((f) => `  ${f}`).join("\n")}`);
	for (const warning of scope.warnings) parts.push(`Note: ${warning}`);
	return parts.join("\n");
}

/** Exact-state fingerprint for revalidation: op id plus working-copy commit id. */
export interface StateFingerprint {
	opId?: string;
	commitId?: string;
}

export async function fingerprint(root: string): Promise<StateFingerprint> {
	const [op, wc] = await Promise.all([
		runJj(root, ["--ignore-working-copy", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], {
			timeoutMs: 5_000,
		}),
		runJj(root, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"], {
			timeoutMs: 5_000,
		}),
	]);
	return {
		...(op.code === 0 && op.out.trim() ? { opId: op.out.trim() } : {}),
		...(wc.code === 0 && wc.out.trim() ? { commitId: wc.out.trim() } : {}),
	};
}

/** True when any known identifier moved: stop and refresh the preview, never execute stale intent. */
export function drifted(before: StateFingerprint, after: StateFingerprint): boolean {
	if (before.opId && after.opId && before.opId !== after.opId) return true;
	if (before.commitId && after.commitId && before.commitId !== after.commitId) return true;
	return false;
}

/** Short display for confirm tokens. */
export function shortCommit(id: string | undefined): string {
	return shortId(id);
}
