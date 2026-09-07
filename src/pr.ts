/**
 * Grouped-change PR identity, policy, publication, and stack maintenance.
 *
 * A PR is an explicit group of changes with a bookmark at its tip: one or several commits,
 * never inferred from linear ancestors. A stack is a chain of these groups, each named
 * explicitly. Policy separates the initial shape from the review-update rule and from
 * published-SHA constraints; presets cover the common shapes, with per-PR overrides.
 *
 * Persistence is shared-repo-scoped: `<store>/omp-jj/pr.json` sits beside (never inside)
 * jj's own store files, so every workspace of one repo shares defaults and mappings while
 * independent clones differ. Mappings are validated against jj and gh before publication;
 * split/squash operations replace change ids, so stale mappings are reported, never silently
 * reinterpreted.
 *
 * Publication is always preview-then-authorized-execute with drift revalidation: the preview
 * prints a confirm token bound to the current operation, and publish refuses a stale token
 * instead of pushing moved state. Preview paths never publish (no `gh pr create --dry-run`,
 * no `--no-integrate-operation` reliance, no bypass flags).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasPublishedMarker, listCommits, type HistoryCommit } from "./history.ts";
import { resolveStorePath } from "./repo.ts";
import { runJj, shortId, whichBin } from "./recovery.ts";

/** Bounded gh invocation. Never throws: missing binary surfaces as code -1. */
export async function runGh(
	root: string,
	args: string[],
	options?: { timeoutMs?: number },
): Promise<{ code: number; out: string; err: string }> {
	const binary = whichBin("gh");
	if (!binary) return { code: -1, out: "", err: "gh not installed" };
	const timeoutMs = options?.timeoutMs ?? 15_000;
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
		return { code, out, err };
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

export interface PRPolicy {
	initialShape: "single-commit" | "atomic-multi";
	reviewUpdates: "rewrite" | "per-round";
	publishedSha: "permit-restack" | "prohibit-rewrite";
}

export type PRPresetName = "single" | "atomic" | "per-round";

export const PR_PRESETS: Record<PRPresetName, { label: string; policy: PRPolicy }> = {
	single: {
		label: "continuously single-commit PR",
		policy: { initialShape: "single-commit", reviewUpdates: "rewrite", publishedSha: "permit-restack" },
	},
	atomic: {
		label: "atomic multi-commit PRs",
		policy: { initialShape: "atomic-multi", reviewUpdates: "rewrite", publishedSha: "permit-restack" },
	},
	"per-round": {
		label: "one initial commit plus one commit per review round",
		policy: { initialShape: "single-commit", reviewUpdates: "per-round", publishedSha: "prohibit-rewrite" },
	},
};

export interface PRMapping {
	bookmark: string;
	base: string;
	remote?: string;
	repo?: string;
	/** Explicit group: full change ids, tip first. Never inferred. */
	changes: string[];
	tipChange: string;
	prNumber?: number;
	policy?: Partial<PRPolicy>;
	updatedAt: string;
}

export interface PRDefaults {
	preset: PRPresetName;
}

export interface PRStoreData {
	defaults: PRDefaults;
	mappings: PRMapping[];
}

const DEFAULT_DATA: PRStoreData = { defaults: { preset: "atomic" }, mappings: [] };

function isPolicy(value: unknown): value is PRPolicy {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	return (
		(p.initialShape === "single-commit" || p.initialShape === "atomic-multi") &&
		(p.reviewUpdates === "rewrite" || p.reviewUpdates === "per-round") &&
		(p.publishedSha === "permit-restack" || p.publishedSha === "prohibit-rewrite")
	);
}

function isMapping(value: unknown): value is PRMapping {
	if (!value || typeof value !== "object") return false;
	const m = value as Record<string, unknown>;
	return (
		typeof m.bookmark === "string" &&
		typeof m.base === "string" &&
		Array.isArray(m.changes) &&
		typeof m.tipChange === "string"
	);
}

/** Effective policy: preset defaults, then repo preset, then per-PR overrides. */
export function policyFor(defaults: PRDefaults, mapping?: PRMapping): PRPolicy {
	const base = PR_PRESETS[defaults.preset]?.policy ?? PR_PRESETS.atomic.policy;
	return { ...base, ...(mapping?.policy ?? {}) };
}

export function policySummary(policy: PRPolicy): string {
	return `initial ${policy.initialShape}, updates ${policy.reviewUpdates}, published ${policy.publishedSha}`;
}

/** Store file beside jj's own store files, shared by every workspace of one repo. */
export function storePathFor(storeDir: string): string {
	return join(storeDir, "omp-jj", "pr.json");
}

export function loadStore(storeDir: string): { data: PRStoreData; corrupt: boolean } {
	try {
		const raw = readFileSync(storePathFor(storeDir), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return { data: structuredClone(DEFAULT_DATA), corrupt: true };
		const record = parsed as { defaults?: unknown; mappings?: unknown };
		const preset =
			record.defaults && typeof record.defaults === "object" && (record.defaults as { preset?: unknown }).preset;
		const data: PRStoreData = {
			defaults: {
				preset:
					preset === "single" || preset === "atomic" || preset === "per-round" ? preset : "atomic",
			},
			mappings: Array.isArray(record.mappings) ? record.mappings.filter(isMapping) : [],
		};
		return { data, corrupt: false };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { data: structuredClone(DEFAULT_DATA), corrupt: false };
		}
		return { data: structuredClone(DEFAULT_DATA), corrupt: true };
	}
}

export function saveStore(storeDir: string, data: PRStoreData): void {
	mkdirSync(join(storeDir, "omp-jj"), { recursive: true });
	writeFileSync(storePathFor(storeDir), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Bookmark names jj and git both accept; anything else is refused before it reaches a shell. */
export function cleanBookmark(name: string): string | undefined {
	const trimmed = name.trim();
	if (/^[A-Za-z0-9_.\/-]+$/.test(trimmed) && trimmed.length <= 128) return trimmed;
	return undefined;
}

async function resolveRev(root: string, rev: string): Promise<{ commitId: string; changeId: string } | undefined> {
	const result = await runJj(
		root,
		["--ignore-working-copy", "log", "--no-graph", "-r", rev, "-T", 'commit_id ++ "\\n" ++ change_id'],
		{ timeoutMs: 10_000 },
	);
	if (result.code !== 0) return undefined;
	const [commitId = "", changeId = ""] = result.out.trim().split("\n");
	if (!commitId || !changeId) return undefined;
	return { commitId, changeId };
}

export interface PRGroup {
	mapping: PRMapping;
	tipCommit: string;
	tipChange: string;
	baseCommit: string;
	/** Explicitly mapped commits, tip first. */
	changes: HistoryCommit[];
	/** Mapped change ids that no longer resolve (split/squash replaced them). */
	stale: string[];
}

export async function resolveGroup(root: string, mapping: PRMapping): Promise<PRGroup> {
	const bookmark = cleanBookmark(mapping.bookmark);
	const tip = bookmark ? await resolveRev(root, bookmark) : undefined;
	const base = await resolveRev(root, mapping.base);
	const changes: HistoryCommit[] = [];
	const stale: string[] = [];
	for (const change of mapping.changes) {
		const listed = await listCommits(root, change);
		if (!listed || listed.length === 0) stale.push(change);
		else changes.push(...listed);
	}
	return {
		mapping,
		tipCommit: tip?.commitId ?? "",
		tipChange: tip?.changeId ?? "",
		baseCommit: base?.commitId ?? "",
		changes,
		stale,
	};
}

/** True when the tip is an empty scratch @: refusing it catches unintended publication. */
export async function isEmptyScratchTip(root: string, group: PRGroup): Promise<boolean> {
	const at = await resolveRev(root, "@");
	if (!at || !group.tipCommit || at.commitId !== group.tipCommit) return false;
	// `jj diff --stat` always prints a summary line, so emptiness comes from the `empty`
	// template keyword plus a missing description — never from blank diff output.
	const [desc, empty] = await Promise.all([
		runJj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "description"], { timeoutMs: 5_000 }),
		runJj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "empty"], { timeoutMs: 5_000 }),
	]);
	return desc.code === 0 && !desc.out.trim() && empty.code === 0 && empty.out.trim() === "true";
}

export interface PRPreview {
	text: string;
	/** Confirm token bound to the current operation; publish refuses drifted tokens. */
	token?: string;
	problems: string[];
}

/** Exact preview: ranges, bookmark updates, creations/edits, published rewrites. Never publishes. */
export async function previewPR(
	root: string,
	store: PRStoreData,
	mapping: PRMapping,
): Promise<PRPreview> {
	const problems: string[] = [];
	const group = await resolveGroup(root, mapping);
	if (!group.tipCommit) problems.push(`bookmark ${mapping.bookmark} does not resolve`);
	if (!group.baseCommit) problems.push(`base ${mapping.base} does not resolve`);
	if (group.stale.length > 0) {
		problems.push(
			`stale mapping: ${group.stale.length} mapped change(s) no longer resolve (split/squash replaced them): ${group.stale.map((c) => c.slice(0, 8)).join(", ")}. Re-select the group explicitly.`,
		);
	}
	const policy = policyFor(store.defaults, mapping);
	const published = group.changes.filter(hasPublishedMarker);
	if (policy.publishedSha === "prohibit-rewrite" && published.length > 0) {
		problems.push(
			`strict no-rewrite policy: ${published.length} grouped commit(s) carry remote bookmarks (${published.map((c) => c.changeId.slice(0, 8)).join(", ")}). Republishing would rewrite published SHAs. Change policy or narrow the group; the policy is not switched silently.`,
		);
	}
	if (problems.length === 0 && (await isEmptyScratchTip(root, group))) {
		problems.push("refusing to publish an empty scratch @: select the intended PR tip explicitly.");
	}

	const current = await runJj(root, ["--ignore-working-copy", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], {
		timeoutMs: 5_000,
	});
	const token = current.code === 0 && current.out.trim() ? current.out.trim().slice(0, 12) : undefined;

	// Existing PR lookup is read-only metadata; failures only mean "unknown, verify manually".
	let existing = "unknown (verify manually)";
	if (mapping.prNumber) {
		const view = await runGh(root, ["pr", "view", String(mapping.prNumber), "--json", "url,state,baseRefName,headRefName", "--jq", ".url + \" \" + .state"], { timeoutMs: 10_000 });
		if (view.code === 0 && view.out.trim()) existing = `#${mapping.prNumber} ${view.out.trim()}`;
	} else {
		const view = await runGh(root, ["pr", "view", mapping.bookmark, "--json", "url,number,state", "--jq", "\"#\" + (.number|tostring) + \" \" + .url + \" \" + .state"], { timeoutMs: 10_000 });
		existing = view.code === 0 && view.out.trim() ? view.out.trim() : "none found";
	}

	const lines = [
		`PR preview: ${mapping.bookmark} → ${mapping.base}${mapping.remote ? ` (remote ${mapping.remote})` : ""}`,
		`Policy: ${store.defaults.preset} (${policySummary(policy)})`,
		group.tipCommit
			? `Group (${group.changes.length} change(s), base ${group.baseCommit.slice(0, 8) || "?"} → tip ${group.tipCommit.slice(0, 8)}):`
			: `Group: unresolvable`,
		...group.changes.map(
			(c) =>
				`  ${c.changeId.slice(0, 8)} ${c.commitId.slice(0, 8)}${c.description ? ` "${c.description}"` : ""}${c.remoteBookmarks.length > 0 ? ` <${c.remoteBookmarks.join(", ")}>` : ""}`,
		),
		group.tipCommit ? `Bookmark update: ${mapping.bookmark} stays at ${group.tipCommit.slice(0, 8)} (narrow push exports it)` : "",
		published.length > 0
			? `Published rewrites: ${published.map((c) => c.changeId.slice(0, 8)).join(", ")}`
			: "Published rewrites: none",
		`Existing PR: ${existing}`,
	];
	const text =
		problems.length > 0
			? [...lines, `Blocked:\n${problems.map((p) => `  - ${p}`).join("\n")}`].join("\n")
			: [...lines, `To publish: /jj-pr publish ${mapping.bookmark} --apply --confirm ${token ?? "(unavailable)"}`].join("\n");
	return { text, token: problems.length === 0 ? token : undefined, problems };
}

export interface PublishResult {
	ok: boolean;
	detail: string;
	url?: string;
	prNumber?: number;
	pushed: boolean;
	incomplete: string[];
}

/**
 * Authorized publication: revalidate the mapping, reject drifted confirm tokens and empty
 * scratch tips, push narrow refs, manage metadata with gh, verify and report honestly.
 */
export async function publishPR(
	root: string,
	store: PRStoreData,
	mapping: PRMapping,
	confirm: string | undefined,
): Promise<PublishResult> {
	const incomplete: string[] = [];
	const group = await resolveGroup(root, mapping);
	if (!group.tipCommit || !group.baseCommit || group.stale.length > 0) {
		return { ok: false, pushed: false, incomplete, detail: "mapping no longer validates; re-run preview and re-select the group." };
	}
	const current = await runJj(root, ["--ignore-working-copy", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], {
		timeoutMs: 5_000,
	});
	const fresh = current.code === 0 ? current.out.trim() : "";
	if (!confirm || (confirm !== fresh && confirm !== fresh.slice(0, 12))) {
		return {
			ok: false,
			pushed: false,
			incomplete,
			detail: "state changed since the preview (operation moved); re-run preview for a fresh confirm token. Nothing was pushed.",
		};
	}
	if (await isEmptyScratchTip(root, group)) {
		return { ok: false, pushed: false, incomplete, detail: "refusing to publish an empty scratch @: select the intended PR tip explicitly." };
	}
	const policy = policyFor(store.defaults, mapping);
	const published = group.changes.filter(hasPublishedMarker);
	if (policy.publishedSha === "prohibit-rewrite" && published.length > 0) {
		return {
			ok: false,
			pushed: false,
			incomplete,
			detail: `strict no-rewrite policy stops publication: ${published.length} grouped commit(s) are published. Explain the tradeoff and change policy explicitly; nothing was pushed.`,
		};
	}

	const pushed = await pushAndDescribe(root, store, mapping, group);
	return pushed;
}

/**
 * Narrow ref push plus gh metadata, shared by single and stacked publication. Assumes the
 * mapping already validated, the state already revalidated, and the policy already checked.
 */
export async function pushAndDescribe(
	root: string,
	store: PRStoreData,
	mapping: PRMapping,
	group: PRGroup,
): Promise<PublishResult> {
	const incomplete: string[] = [];
	const policy = policyFor(store.defaults, mapping);
	const pushArgs = ["git", "push", "--bookmark", mapping.bookmark];
	if (mapping.remote) pushArgs.push("--remote", mapping.remote);
	const push = await runJj(root, pushArgs, { timeoutMs: 60_000 });
	if (push.code !== 0) {
		return { ok: false, pushed: false, incomplete, detail: `narrow push failed:\n${push.err.trim() || push.out.trim()}` };
	}
	// Metadata via gh; a missing gh leaves refs pushed and metadata honestly pending.
	const repoFlag = mapping.repo ? ["--repo", mapping.repo] : [];
	if (mapping.prNumber) {
		const view = await runGh(root, ["pr", "view", String(mapping.prNumber), ...repoFlag, "--json", "url,number", "--jq", ".url"], { timeoutMs: 15_000 });
		if (view.code !== 0) incomplete.push("PR metadata unverified (gh unavailable or PR lookup failed); refs were pushed.");
		const url = view.code === 0 && view.out.trim() ? view.out.trim() : undefined;
		return {
			ok: incomplete.length === 0,
			pushed: true,
			prNumber: mapping.prNumber,
			url,
			incomplete,
			detail: [`Pushed ${mapping.bookmark} (existing PR #${mapping.prNumber}).`, url ? `URL: ${url}` : "", ...incomplete.map((i) => `Incomplete: ${i}`)].filter(Boolean).join("\n"),
		};
	}
	const title = group.changes[0]?.description || mapping.bookmark;
	const body = [
		`Published via omp-jj (/jj-pr) under policy ${store.defaults.preset} (${policySummary(policy)}).`,
		"",
		"Commits:",
		...group.changes.map((c) => `- ${c.changeId.slice(0, 8)} ${c.commitId.slice(0, 8)}${c.description ? ` ${c.description}` : ""}`),
	].join("\n");
	const create = await runGh(
		root,
		["pr", "create", "--head", mapping.bookmark, "--base", mapping.base, "--title", title, "--body", body, ...repoFlag],
		{ timeoutMs: 30_000 },
	);
	if (create.code !== 0) {
		incomplete.push(`PR creation failed or gh unavailable (${(create.err.trim() || "unknown error").split("\n")[0]}); refs were pushed, create the PR manually.`);
		return { ok: false, pushed: true, incomplete, detail: [`Pushed ${mapping.bookmark}.`, ...incomplete.map((i) => `Incomplete: ${i}`)].join("\n") };
	}
	const url = create.out.trim().split("\n").filter(Boolean).at(-1);
	const number = /\/pull\/(\d+)/.exec(url ?? "")?.[1];
	return {
		ok: true,
		pushed: true,
		prNumber: number ? Number(number) : undefined,
		url,
		incomplete,
		detail: [`Pushed ${mapping.bookmark} and created PR${number ? ` #${number}` : ""}.`, url ? `URL: ${url}` : ""].filter(Boolean).join("\n"),
	};
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

export interface StackLayer {
	bookmark: string;
	mapping?: PRMapping;
	group?: PRGroup;
	problem?: string;
}

/** Resolve every layer explicitly; linear ancestry is verified, never assumed. */
export async function resolveStack(root: string, store: PRStoreData, bookmarks: string[]): Promise<StackLayer[]> {
	const layers: StackLayer[] = [];
	for (const name of bookmarks) {
		const cleaned = cleanBookmark(name);
		if (!cleaned) {
			layers.push({ bookmark: name, problem: `invalid bookmark name: ${name}` });
			continue;
		}
		const mapping = store.mappings.find((m) => m.bookmark === cleaned);
		if (!mapping) {
			layers.push({ bookmark: cleaned, problem: `no PR mapping for ${cleaned}; map it first with /jj-pr map` });
			continue;
		}
		const group = await resolveGroup(root, mapping);
		if (!group.tipCommit || !group.baseCommit || group.stale.length > 0) {
			layers.push({ bookmark: cleaned, mapping, group, problem: `mapping for ${cleaned} no longer validates; re-select the group` });
			continue;
		}
		layers.push({ bookmark: cleaned, mapping, group });
	}
	// Verify the chain: each upper base must equal the lower tip.
	for (let i = 1; i < layers.length; i++) {
		const lower = layers[i - 1]?.group;
		const upper = layers[i]?.group;
		if (!lower || !upper || layers[i]?.problem || layers[i - 1]?.problem) continue;
		if (upper.baseCommit !== lower.tipCommit) {
			layers[i] = { ...layers[i] as StackLayer, problem: `${layers[i]?.bookmark} base ${upper.baseCommit.slice(0, 8)} is not stacked on ${layers[i - 1]?.bookmark} tip ${lower.tipCommit.slice(0, 8)}` };
		}
	}
	return layers;
}

export type MergeMethod = "rebase" | "squash" | "merge";

export interface RestackPlan {
	toAbandon: string[];
	rebases: Array<{ source: string; dest: string }>;
	notes: string[];
}

export interface RestackResult {
	plan?: RestackPlan;
	stopped?: string;
}

/**
 * Merge-method-aware restacking after a lower layer lands. `landedBase` is the local revision
 * the lower layer merged into (post authorized sync). Landed-layer commits already reachable
 * from it need nothing; orphans are abandoned so squash/rebase merges do not reappear
 * upstairs. Under a strict no-rewrite policy, touching published commits stops with the
 * tradeoff explained — never a silent policy switch, never merge commits.
 */
export async function planRestack(
	root: string,
	store: PRStoreData,
	layers: StackLayer[],
	landedBookmark: string,
	method: MergeMethod,
	landedBase: string,
): Promise<RestackResult> {
	const landedIdx = layers.findIndex((l) => l.bookmark === landedBookmark);
	if (landedIdx < 0) return { stopped: `${landedBookmark} is not a layer of this stack` };
	const base = await resolveRev(root, landedBase);
	if (!base) return { stopped: `landing base ${landedBase} does not resolve` };
	const landed = layers[landedIdx] as StackLayer;
	if (landed.problem || !landed.group) return { stopped: landed.problem ?? "landed layer is unresolvable" };

	const toAbandon: string[] = [];
	const notes: string[] = [];
	for (const change of landed.group.changes) {
		const under = await runJj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", `${change.commitId} & ancestors(${base.commitId})`, "-T", "commit_id"], { timeoutMs: 10_000 });
		if (under.code === 0 && under.out.trim()) {
			notes.push(`${change.changeId.slice(0, 8)} already under ${landedBase} (${method} merge preserved it); kept`);
		} else {
			toAbandon.push(change.commitId);
			notes.push(`${change.changeId.slice(0, 8)} superseded by the ${method} merge; abandon so it does not reappear upstairs`);
		}
	}

	const rebases: Array<{ source: string; dest: string }> = [];
	let dest = base.commitId;
	for (const upper of layers.slice(landedIdx + 1)) {
		if (upper.problem || !upper.group) return { stopped: upper.problem ?? "upper layer is unresolvable; restack stops here" };
		rebases.push({ source: upper.group.tipCommit, dest });
		dest = upper.group.tipCommit; // moves with its rebase; bookmarks follow their commits
	}

	// Strict policy gate across everything the plan would rewrite.
	for (const layer of [landed, ...layers.slice(landedIdx + 1)]) {
		const policy = policyFor(store.defaults, layer.mapping);
		if (policy.publishedSha !== "prohibit-rewrite") continue;
		const scope = await listCommits(root, layer.group ? `${layer.group.tipCommit}` : "@");
		const published = (scope ?? []).filter(hasPublishedMarker);
		const abandonedPublished = toAbandon.length > 0 ? (await listCommits(root, toAbandon.join("|")))?.filter(hasPublishedMarker) ?? [] : [];
		if (published.length > 0 || abandonedPublished.length > 0) {
			return {
				stopped: `strict no-rewrite policy stops restacking ${layer.bookmark}: the plan rewrites published commits. Either keep the stack as-is or change policy explicitly; nothing was moved.`,
			};
		}
	}

	return { plan: { toAbandon, rebases, notes } };
}

/** Execute a restack plan with drift revalidation between phases. */
export async function applyRestack(
	root: string,
	plan: RestackPlan,
	expectedOp: string | undefined,
): Promise<{ ok: boolean; detail: string; newTips: Record<string, string> }> {
	const current = await runJj(root, ["--ignore-working-copy", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], { timeoutMs: 5_000 });
	const fresh = current.code === 0 ? current.out.trim() : "";
	if (expectedOp && fresh && expectedOp !== fresh && expectedOp !== fresh.slice(0, 12)) {
		return { ok: false, detail: "state changed since the restack preview; re-run preview. Nothing was moved.", newTips: {} };
	}
	if (plan.toAbandon.length > 0) {
		const abandon = await runJj(root, ["abandon", ...plan.toAbandon], { timeoutMs: 30_000 });
		if (abandon.code !== 0) {
			return { ok: false, detail: `abandon failed; restack stops before any rebase:\n${abandon.err.trim()}`, newTips: {} };
		}
	}
	for (const step of plan.rebases) {
		const rebase = await runJj(root, ["rebase", "-s", step.source, "-d", step.dest], { timeoutMs: 60_000 });
		if (rebase.code !== 0) {
			return { ok: false, detail: `rebase ${shortId(step.source)} onto ${shortId(step.dest)} failed; stop and inspect before continuing:\n${rebase.err.trim()}`, newTips: {} };
		}
	}
	return { ok: true, detail: `restacked ${plan.rebases.length} layer(s)${plan.toAbandon.length > 0 ? `, abandoned ${plan.toAbandon.length} superseded commit(s)` : ""}`, newTips: {} };
}

/** Validate every stored mapping for one repo: the health/consistency view. */
export async function validateAll(root: string, store: PRStoreData): Promise<{ total: number; stale: string[] }> {
	const stale: string[] = [];
	for (const mapping of store.mappings) {
		const group = await resolveGroup(root, mapping);
		if (!group.tipCommit || !group.baseCommit || group.stale.length > 0) {
			stale.push(`${mapping.bookmark} (${group.stale.length} unresolvable change(s))`);
		}
	}
	return { total: store.mappings.length, stale };
}

/** Load the shared store for a workspace root (null when the store is unreadable). */
export function storeDirForRoot(root: string): string | null {
	return resolveStorePath(root);
}

export { shortId };
export type { HistoryCommit };
