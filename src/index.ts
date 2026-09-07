// NOTE: all host shapes below are structural and local. The extension never imports the host
// package at runtime; the factory receives the live `ExtensionAPI` and is cast to `Api`.
import { classify, SYNC_MUTATORS, type Targets } from "./classify.ts";
import { createSnapshotter, type CaptureOutcome } from "./snapshot.ts";
import { describeWorkspace, identityForDir, readRepoStatus, resolveRepoTargets } from "./repo.ts";
import { checkHealth, formatReport } from "./health.ts";
import {
	formatScope,
	hasPublishedMarker,
	immutableCommits,
	previewAbsorb,
	previewRebase,
	previewSplit,
	previewSquash,
	previewTarget,
	publishedCommits,
	type HistoryScope,
} from "./history.ts";
import { loadStore, policyFor, storeDirForRoot, validateAll } from "./pr.ts";
import { handlePrCommand, handleStackCommand } from "./pr-commands.ts";
import {
	CHECKPOINT_CUSTOM_TYPE,
	CheckpointStore,
	previewStateRestore,
	restoreFiles,
	restoreState,
	shortId,
	validateCheckpoint,
	type BoundaryKind,
	type CheckpointRecord,
} from "./recovery.ts";
import {
	childStatus,
	effectiveState,
	masterStatus,
	parseToggleArg,
	sessionIdOf,
	STATE_CUSTOM_TYPE,
	ToggleStore,
	type EffectiveState,
	type JJSettings,
	type SettingKey,
} from "./state.ts";
import { resolveTargetRoot, rootsFor } from "./workspace.ts";
import { addWorkspace, formatError, formatRow, listWorkspaces, mainWorkspace, removeWorkspace, selectWorkspace } from "./workspaces.ts";

/**
 * JJ-native OMP extension (foundation).
 *
 * - `before_agent_start` injects SHORT repository-scoped context: identity, workspace, working
 *   change, pre-existing work flag, selected PR policy placeholder, and workflow constraints.
 *   All reads use `--ignore-working-copy`, so prompt rendering never snapshots.
 * - `tool_call` / `tool_result` own the mutation boundaries, reusing the snapshot ordering
 *   (per-target roots, staged AST rewrites, post-execution pass for synchronous mutators only),
 *   gated on master && snapshots.
 * - `/jj`, `/jj-snapshots`, `/jj-explain` toggle session-scoped settings with immediate
 *   feedback; the TUI palette decorates only this extension's rows via a provider wrapper that
 *   reads in-memory state and never shells out.
 * - Missing JJ or a non-JJ target is inactive: the extension never initializes a repository
 *   and never mutates Git.
 */

// Local structural types keep the entry testable without resolving the host package at
// runtime (all host imports above are type-only and erased). They mirror the shapes used.
interface Ctx {
	cwd: string;
	mode?: string;
	hasUI?: boolean;
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
		addAutocompleteProvider?: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
		select?: (
			title: string,
			options: Array<string | { label: string; description?: string }>,
			dialogOptions?: Record<string, unknown>,
		) => Promise<string | undefined>;
	};
	sessionManager?: {
		getSessionId?: () => string;
		getEntries?: () => readonly unknown[];
	};
}

interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	icon?: string;
	hint?: string;
}

interface AutocompleteProvider {
	getSuggestions: (
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	) => Promise<{ items: AutocompleteItem[]; prefix: string } | null>;
	applyCompletion: (
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	) => { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void };
	trySyncSlashCompletion?: (
		textBeforeCursor: string,
	) => { items: AutocompleteItem[]; prefix: string } | null;
	[key: string]: unknown;
}

interface Api {
	logger: { debug: (message: string, fields?: Record<string, unknown>) => void; warn: (message: string, fields?: Record<string, unknown>) => void };
	setLabel: (label: string) => void;
	on: (event: string, handler: (event: unknown, ctx: Ctx) => unknown) => void;
	registerCommand: (
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
			handler: (args: string, ctx: Ctx) => Promise<void>;
		},
	) => void;
	appendEntry?: <T>(customType: string, data?: T) => void;
}

/** Ceiling on pre-call tracking; blocked or aborted calls never reach `tool_result`. */
const MAX_TRACKED_CALLS = 64;

const COMMAND_NAMES = ["jj", "jj-snapshots", "jj-explain"] as const;

const COMMAND_DESCRIPTIONS: Record<(typeof COMMAND_NAMES)[number], string> = {
	jj: "Toggle the JJ extension (on/off/status)",
	"jj-snapshots": "Toggle automatic JJ snapshots and session-linked recovery (on/off/status)",
	"jj-explain": "Toggle extra explanations for JJ history editing (on/off/status)",
};

const TOGGLE_COMPLETIONS: AutocompleteItem[] = [
	{ value: "on", label: "on", description: "Enable" },
	{ value: "off", label: "off", description: "Disable" },
	{ value: "status", label: "status", description: "Show current status" },
];

/** Marks a provider this extension already wrapped, so re-registration never stacks. */
const WRAPPED = Symbol.for("omp-jj.autocomplete-wrapped");

function isOwnRow(item: AutocompleteItem): (typeof COMMAND_NAMES)[number] | undefined {
	for (const name of COMMAND_NAMES) {
		for (const text of [item.value, item.label]) {
			if (!text) continue;
			const bare = text.startsWith("/") ? text.slice(1) : text;
			const first = bare.split(/\s/)[0];
			if (first === name) return name;
		}
	}
	return undefined;
}

/** Strip quoted spans so `echo "git commit"` never reads as a git invocation. */
function stripQuotes(text: string): string {
	return text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, " ");
}

/** Split a shell command into segments; the model composes with &&, ||, ;, pipes. */
function splitSegments(command: string): string[] {
	return stripQuotes(command)
		.split(/&&|\|\||[;|\n()]/)
		.map((part) => part.trim())
		.filter(Boolean);
}

interface ParsedSegment {
	tool: string;
	rest: string;
}

const STACK_TOOLS: Record<string, true> = {
	"gh-stack": true,
	machete: true,
	"git-machete": true,
	"git-town": true,
	gt: true,
	spr: true,
};

/** Recognize a leading VCS invocation in one segment. Opaque code (eval bodies, task
 * prompts, missing command strings) never reaches here — that gap is documented, not
 * guessed at. */
function parseSegment(segment: string): ParsedSegment | undefined {
	// Longer names first: `gh` would otherwise match the `gh` in `gh-stack`.
	const match = /^(?:sudo\s+)?(gh-stack|git-machete|git-town|machete|jj|git|gh|sl|gt|spr)\b\s*(.*)$/.exec(segment);
	if (!match) return undefined;
	return { tool: match[1] as string, rest: match[2] ?? "" };
}

/** First non-empty string among candidates (tool inputs use several names for cwd/command). */
function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export default function ompJJ(pi: unknown): void {
	const api = pi as Api;
	const logger = api.logger;
	const snapshotter = createSnapshotter({ logger });
	const toggles = new ToggleStore();
	/**
	 * Session-scoped, not module-scoped: one process can host several sessions (a subagent gets
	 * its own runner), and staged roots must not leak between them.
	 */
	const stagedAstRoots = new Map<string, Set<string>>();
	const executedRoots = new Map<string, Map<string, { tool: string; roots: string[] }>>();
	const wrappedSessions = new Set<string>();
	/** Last cwd observed per session, so the render path can report repo-scoped status without
	 * I/O. Updated on every event; the palette wrapper reads it but never shells out. */
	const lastCwd = new Map<string, string>();
	/** Session-linked checkpoint index, rebuilt from persisted entries on every session event. */
	const checkpoints = new CheckpointStore();
	/** Current user-request group per session, minted in before_agent_start. */
	const requestIds = new Map<string, string>();
	let requestSeq = 0;

	const stagedFor = (sessionId: string): Set<string> => {
		let set = stagedAstRoots.get(sessionId);
		if (!set) {
			set = new Set();
			stagedAstRoots.set(sessionId, set);
		}
		return set;
	};

	/** Persist toggle changes for resume; in-memory state is authoritative live. */
	const persist = (ctx: Ctx, settings: JJSettings): void => {
		try {
			api.appendEntry?.(STATE_CUSTOM_TYPE, {
				settings: { ...settings },
				savedAt: new Date().toISOString(),
			});
		} catch {
			// Persistence is best-effort; the live map already holds the change.
		}
		void ctx;
	};

	const refreshSession = (ctx: Ctx): { sessionId: string; settings: JJSettings } => {
		const sessionId = sessionIdOf(ctx);
		lastCwd.set(sessionId, ctx.cwd);
		let entries: readonly unknown[] = [];
		try {
			entries = ctx.sessionManager?.getEntries?.() ?? [];
		} catch {
			entries = [];
		}
		const settings = toggles.refresh(sessionId, entries);
		checkpoints.refresh(sessionId, entries);
		installPaletteWrapper(ctx, sessionId);
		return { sessionId, settings };
	};

	/** Session-level arming: master on, snapshots on, jj installed. Per-target inactivity falls
	 * out of root resolution — a non-JJ target resolves to no roots and snapshots nothing, even
	 * when the session cwd itself is not a JJ workspace (e.g. a staged rewrite applied from
	 * another directory). */
	const snapshotsArmed = (ctx: Ctx): { sessionId: string; armed: boolean } => {
		const sessionId = sessionIdOf(ctx);
		const settings = toggles.get(sessionId);
		if (!settings.master || !settings.snapshots) return { sessionId, armed: false };
		if (!Bun.which("jj")) return { sessionId, armed: false };
		return { sessionId, armed: true };
	};

	/** Bounded and non-throwing: a throw from `tool_call` blocks the tool (fail-closed). */
	const snapshot = async (
		targets: Targets,
		ctx: ExtensionContextForSnapshot,
		reason: string,
	): Promise<{ roots: string[]; outcomes: CaptureOutcome[] }> => {
		try {
			const roots = rootsFor(targets, ctx.cwd);
			if (roots.length === 0) return { roots, outcomes: [] };
			// Every snapshot owns its deadline and is dead before this resolves, so the tool never
			// runs concurrently with a snapshot of the files it is about to change.
			const outcomes = await Promise.all(
				roots.map((root) => snapshotter.snapshot(root, reason)),
			);
			return { roots, outcomes };
		} catch (error) {
			logger.warn("jj snapshot skipped", { reason, error: String(error) });
			return { roots: [], outcomes: [] };
		}
	};
	type ExtensionContextForSnapshot = Ctx;

	/**
	 * Persist one checkpoint record per restorable capture. Only ok/unchanged/partial captures
	 * with an operation id name a state worth restoring; failed/skipped captures leave no
	 * restore point and stay in the warn log. Never throws.
	 */
	const recordCaptures = (
		sessionId: string,
		roots: string[],
		outcomes: CaptureOutcome[],
		detail: { boundary: BoundaryKind; requestId: string | null; callId?: string; tool?: string },
	): void => {
		try {
			for (let i = 0; i < roots.length; i++) {
				const outcome = outcomes[i];
				if (!outcome || !outcome.opId) continue;
				if (outcome.status !== "ok" && outcome.status !== "unchanged" && outcome.status !== "partial") {
					continue;
				}
				const identity = describeWorkspace(roots[i] as string);
				if (!identity) continue;
				const record: CheckpointRecord = {
					v: 1,
					requestId: detail.requestId,
					boundary: detail.boundary,
					...(detail.callId ? { callId: detail.callId } : {}),
					...(detail.tool ? { tool: detail.tool } : {}),
					root: identity.root,
					workspace: identity.workspace,
					storeKey: identity.storeKey,
					opId: outcome.opId,
					...(outcome.commitId ? { commitId: outcome.commitId } : {}),
					...(outcome.changeId ? { changeId: outcome.changeId } : {}),
					status: outcome.status,
					...(outcome.message ? { message: outcome.message } : {}),
					at: new Date().toISOString(),
				};
				checkpoints.add(sessionId, record);
				api.appendEntry?.(CHECKPOINT_CUSTOM_TYPE, record);
			}
		} catch {
			// Recording is best-effort; the restore point itself already exists in jj.
		}
	};

	/**
	 * Repo-aware pre-execution guardrail for model-driven shell commands. Runs only when the
	 * master switch is on; snapshots need not be (guardrails are not captures). Returns a
	 * block verdict only on positive evidence of a violation — staged-index git habits in JJ
	 * roots, implicit branch assumptions, immutable or policy-prohibited history rewrites,
	 * and destructive restores that bypass session-linked recovery. Anything undeterminable
	 * (opaque eval/task bodies, missing command strings, unparseable flags, non-JJ targets)
	 * is allowed with a debug note: these hooks are workflow aids, not a security sandbox.
	 * Ordinary Git repositories are never touched.
	 */
	const guardToolCall = async (
		c: Ctx,
		sessionId: string,
		toolName: string,
		input: Record<string, unknown>,
	): Promise<{ block: true; reason: string } | undefined> => {
		if (toolName !== "bash") return undefined;
		const rawCommand =
			firstString(input.command, input.cmd, input.script) ??
			(Array.isArray(input.args) ? (input.args as unknown[]).filter((a) => typeof a === "string").join(" ") : undefined);
		if (!rawCommand) return undefined;
		const cwdOverride = firstString(input.cwd, input.workdir, input.dir);
		const verbose = toggles.get(sessionId).explain;
		for (const segment of splitSegments(rawCommand)) {
			const parsed = parseSegment(segment);
			if (!parsed) continue;
			const verdict = await guardSegment(c, sessionId, parsed, cwdOverride, verbose);
			if (verdict) return verdict;
		}
		return undefined;
	};

	/** Split `rest` into verb + args, honoring -R/-C/--repository path overrides. */
	const splitVerb = (rest: string): { verb?: string; args: string[]; repoFlag?: string } => {
		const tokens = rest.split(/\s+/).filter(Boolean);
		const words: string[] = [];
		let repoFlag: string | undefined;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i] as string;
			if (token === "-R" || token === "--repository" || token === "-C") {
				repoFlag = tokens[i + 1];
				i++;
				continue;
			}
			if (token.startsWith("-")) continue;
			words.push(token);
		}
		return { verb: words[0], args: words.slice(1), repoFlag };
	};

	/**
	 * `--name value` and `--name=value` lookup over raw (quote-stripped) tokens. A flag
	 * present without a usable value yields the sentinel "\0" (never a valid revision), so
	 * callers fall into their unresolvable path instead of silently using defaults.
	 */
	const flagValue = (rest: string, names: string[]): string | undefined => {
		const tokens = rest.split(/\s+/).filter(Boolean);
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i] as string;
			for (const name of names) {
				if (token === name) {
					const next = tokens[i + 1];
					return next === undefined || next.startsWith("-") ? "\0" : next;
				}
				if (token.startsWith(`${name}=`)) {
					const value = token.slice(name.length + 1);
					return value ? value : "\0";
				}
			}
		}
		return undefined;
	};

	const guardSegment = async (
		c: Ctx,
		sessionId: string,
		parsed: { tool: string; rest: string },
		cwdOverride: string | undefined,
		verbose: boolean,
	): Promise<{ block: true; reason: string } | undefined> => {
		const { verb, repoFlag } = splitVerb(parsed.rest);
		const scopePath = repoFlag ?? cwdOverride ?? c.cwd;
		let root: string | null = null;
		try {
			root = resolveTargetRoot(scopePath, c.cwd);
		} catch {
			return undefined;
		}
		// Non-JJ targets keep their own rules: never intervene outside JJ workspaces.
		if (!root) {
			logger.debug("jj guardrail skipped outside JJ workspace", { segment: `${parsed.tool} ${verb ?? ""}`.trim() });
			return undefined;
		}
		if (parsed.tool === "git") return guardGit(root, verb ?? "", parsed.rest, verbose);
		if (parsed.tool === "gh") return guardGh(verb ?? "", parsed.rest);
		if (STACK_TOOLS[parsed.tool] === true) {
			return {
				block: true,
				reason: [
					`${parsed.tool} targets a JJ-managed workspace (${root}); Git-based stack tooling assumes branches, not JJ changes.`,
					"Manage the stack with jj bookmarks plus /jj-pr and /jj-stack (skill jj-stacked-pr) instead.",
				].join("\n"),
			};
		}
		if (parsed.tool === "jj") return guardJj(c, sessionId, root, verb ?? "", parsed.rest, verbose);
		return undefined;
	};

	const GIT_REDIRECTS: Record<string, string> = {
		add: "jj tracks files automatically; `jj st` shows what changed. There is no staging step.",
		commit: "record intent with `jj describe` and open the next change with `jj new` (skill jj-atomic).",
		stash: "shelve into a scratch change with `jj new`, or isolate in a workspace (skill jj-isolation); checkpoints in /jj-recover cover mistakes.",
		rebase: "use `jj rebase -s <source> -d <dest>` with explicit revisions after a scope preview.",
		merge: "merging is an explicit user action; rebase onto the target or resolve the conflict in the working copy instead.",
		reset: "restore via /jj-recover (session checkpoints) instead of rewriting git index state.",
		rm: "remove the file; jj tracks the deletion without a separate staging command.",
		mv: "move the file; no git-index update is needed.",
		"cherry-pick": "duplicate with `jj duplicate` or rebase the source change explicitly.",
		revert: "reverse with `jj backout`, which records the reversal as its own commit.",
		push: "publish through /jj-pr (explicit bookmark, base, and policy checks), not raw git push.",
		pull: "pulling merges implicitly; fetch/sync is an explicit, authorized step — say which remote state you want.",
		clean: "deleting untracked files bypasses checkpoints; remove paths explicitly or isolate first.",
		restore: "restore file contents via /jj-recover (validated checkpoints), not git index surgery.",
		checkout: "checkout moves Git HEAD and branch assumptions do not map to JJ; create/move bookmarks explicitly instead.",
		switch: "switch moves Git HEAD and branch assumptions do not map to JJ; create/move bookmarks explicitly instead.",
	};

	const GIT_READONLY: Record<string, true> = {
		status: true, log: true, diff: true, show: true, blame: true, "ls-files": true, "rev-parse": true,
		grep: true, describe: true, "ls-remote": true, "rev-list": true, "cat-file": true, "hash-object": true,
	};

	const guardGit = (
		root: string,
		verb: string,
		rest: string,
		_verbose: boolean,
	): { block: true; reason: string } | undefined => {
		if (!verb) return undefined;
		if (GIT_READONLY[verb] === true) {
			logger.debug("jj guardrail allows read-only git", { verb, root });
			return undefined;
		}
		// Bare listers read; any flag turns them into branch/tag surgery.
		if ((verb === "branch" || verb === "tag") && splitVerb(rest).args.length === 0) return undefined;
		if (verb === "stash") {
			const sub = splitVerb(rest).args[0];
			if (sub === "list" || sub === "show") return undefined;
		}
		if (verb === "remote" && !/push|set-url|add|remove|rename|prune/i.test(rest)) return undefined;
		if (verb === "worktree" && /^worktree\s+list\b/.test(rest)) return undefined;
		if (verb === "worktree") {
			return {
				block: true,
				reason: [
					`git worktree targets a JJ-managed workspace (${root}); worktree/workspace lifecycle belongs to the helper.`,
					"List, create, and remove through /jj-workspace (placement, collision, and removal safeguards apply).",
				].join("\n"),
			};
		}
		if (verb === "fetch") {
			logger.debug("jj guardrail allows explicit git fetch", { root });
			return undefined;
		}
		const hint = GIT_REDIRECTS[verb];
		if (!hint) {
			logger.debug("jj guardrail allows unknown git verb", { verb, root });
			return undefined;
		}
		return {
			block: true,
			reason: [
				`git ${verb} targets a JJ-managed workspace (${root}); the staged-index workflow does not apply here.`,
				hint,
				"This was not translated silently because git and jj semantics differ.",
			].join("\n"),
		};
	};

	const guardGh = (verb: string, rest: string): { block: true; reason: string } | undefined => {
		if (verb !== "pr") return undefined;
		const sub = splitVerb(rest).args[0];
		if (sub === "create" || sub === "checkout") {
			return {
				block: true,
				reason: [
					`gh pr ${sub} assumes git branches; in a JJ workspace the PR is a bookmarked change group.`,
					"Publish through /jj-pr with an explicit bookmark, base, and policy (preview first), or check out by resolving the bookmark to its commit explicitly.",
				].join("\n"),
			};
		}
		if (sub === "merge") {
			return {
				block: true,
				reason: [
					"gh pr merge is an explicit user action (merge method decides the restack that follows).",
					"Say which PR and which merge method; after it lands, restack with /jj-stack restack.",
				].join("\n"),
			};
		}
		return undefined;
	};

	const guardJj = async (
		c: Ctx,
		sessionId: string,
		root: string,
		verb: string,
		rest: string,
		verbose: boolean,
	): Promise<{ block: true; reason: string } | undefined> => {
		void c;
		if (!verb) return undefined;
		// Destructive restores bypass session-linked recovery: always redirect.
		if (verb === "undo" || (verb === "op" && splitVerb(rest).args[0] === "restore")) {
			return {
				block: true,
				reason: [
					`jj ${verb} bypasses session-linked recovery; an unscoped undo can clobber unrelated work.`,
					"Restore through /jj-recover (validated checkpoints, pre-restore safety net, explicit authorization).",
				].join("\n"),
			};
		}
		if (verb === "op" && splitVerb(rest).args[0] === "abandon") {
			return {
				block: true,
				reason: "jj op abandon destroys operation history that checkpoints reference; use /jj-recover instead.",
			};
		}
		if (verb === "workspace") {
			const sub = splitVerb(rest).args[0];
			if (sub === "add" || sub === "forget" || sub === "remove") {
				return {
					block: true,
					reason: `jj workspace ${sub} bypasses the workspace helper (placement, collision, ignore coverage, and removal safeguards); use /jj-workspace instead.`,
				};
			}
			return undefined;
		}
		if (verb === "config") {
			const sub = splitVerb(rest).args[0];
			if (sub === "set" || sub === "unset") {
				return {
					block: true,
					reason: "jj config changes persist beyond this session; edit configuration explicitly instead of scripting it.",
				};
			}
			return undefined;
		}
		if (verb === "git" && (splitVerb(rest).args[0] === "fetch" || splitVerb(rest).args[0] === "clone")) {
			return {
				block: true,
				reason: "fetching/cloning contacts remotes and rewrites remote state visibility; sync is an authorized step — say which remote and why.",
			};
		}
		// History rewrites: preview scope, then enforce immutable + published policy.
		// Verbs without a rewrite scope (reads, bookmark moves, push) fall through to
		// their own checks below instead of returning early.
		const scope = await historyScopeFor(root, verb, rest);
		if (scope !== null && !("unavailable" in scope)) {
			// Absorb folds into owning ancestors without naming targets; its scope always spans
			// the immutable root, so the frozen check would false-positive on every invocation.
			// jj itself refuses genuinely immutable destinations; policy still applies below.
			const frozen = verb === "absorb" ? [] : immutableCommits(scope);
			if (frozen.length > 0) {
				const lines = [
					`jj ${verb} would rewrite ${frozen.length} immutable commit(s); jj itself refuses these.`,
					...(verbose ? [formatScope(scope, true)] : [`Re-run with /jj-explain on for the full scope, or inspect via /jj-health.`]),
					"Retarget to mutable commits.",
				];
				return { block: true, reason: lines.join("\n") };
			}
			const published = publishedCommits(scope);
			if (published.length > 0) {
				const verdict = await publishedVerdict(root, scope, verb, verbose);
				if (verdict) return verdict;
			}
		} else if (scope !== null) {
			logger.debug("jj guardrail allows unresolvable scope", { verb, detail: scope.unavailable });
		}
		if (verb === "bookmark") {
			const sub = splitVerb(rest).args[0];
			if (sub === "delete" || sub === "forget") {
				const names = splitVerb(rest).args.slice(1).filter((a) => !a.startsWith("-"));
				const mapped = await mappedBookmarks(root);
				const hit = names.find((n) => mapped.has(n));
				if (hit) {
					return {
						block: true,
						reason: `bookmark ${hit} backs a recorded PR mapping; unmap it first with /jj-pr unmap (or update the mapping) instead of deleting blindly.`,
					};
				}
			}
		}
		return undefined;
	};

	/** Scope preview for a history verb, or null when the verb needs no scope check. */
	const historyScopeFor = async (
		root: string,
		verb: string,
		rest: string,
	): Promise<HistoryScope | { unavailable: string } | null> => {
		switch (verb) {
			case "absorb":
				return previewAbsorb(root);
			case "split":
				return previewSplit(root, { rev: flagValue(rest, ["--revision", "-r"]) });
			case "squash":
				return previewSquash(root, {
					from: flagValue(rest, ["--from", "-r", "--revision"]),
					into: flagValue(rest, ["--into"]),
				});
			case "rebase":
				return previewRebase(root, {
					source: flagValue(rest, ["--source", "-s"]),
					dest: flagValue(rest, ["--destination", "-d"]),
				});
			case "describe":
			case "metaedit":
			case "abandon":
				return previewTarget(root, flagValue(rest, ["--revision", "-r"]) ?? "@");
			default:
				return null;
		}
	};

	/** Policy verdict for published commits in scope: block on prohibit or per-round rewrites. */
	const publishedVerdict = async (
		root: string,
		scope: HistoryScope,
		verb: string,
		verbose: boolean,
	): Promise<{ block: true; reason: string } | undefined> => {
		const storeDir = storeDirForRoot(root);
		const store = storeDir ? loadStore(storeDir).data : null;
		const inScope = new Set<string>();
		for (const commit of [...scope.revs, ...scope.descendants]) {
			for (const bookmark of commit.bookmarks) inScope.add(bookmark);
		}
		const policies = (store?.mappings ?? [])
			.filter((m) => inScope.has(m.bookmark))
			.map((m) => ({ bookmark: m.bookmark, policy: policyFor(store?.defaults ?? { preset: "atomic" }, m) }));
		if (store && policies.length === 0) {
			policies.push({ bookmark: "(default)", policy: policyFor(store.defaults) });
		}
		const names = [...scope.revs, ...scope.descendants]
			.filter(hasPublishedMarker)
			.map((commit) => commit.changeId.slice(0, 8))
			.join(", ");
		for (const { bookmark, policy } of policies) {
			if (policy.publishedSha === "prohibit-rewrite") {
				return {
					block: true,
					reason: [
						`jj ${verb} would rewrite published commit(s) (${names}); policy for ${bookmark} prohibits rewriting published SHAs.`,
						...(verbose ? [formatScope(scope, true)] : []),
						"Change policy explicitly or narrow the scope; the policy is not switched silently.",
					].join("\n"),
				};
			}
			if ((verb === "absorb" || verb === "squash" || verb === "describe" || verb === "metaedit") && policy.reviewUpdates === "per-round") {
				return {
					block: true,
					reason: [
						`jj ${verb} would fold a published review round (${names}) away under one-commit-per-round policy (${bookmark}).`,
						"Append a new commit for this round instead of rewriting the published one.",
					].join("\n"),
				};
			}
		}
		return undefined;
	};

	const mappedBookmarks = async (root: string): Promise<Set<string>> => {
		const storeDir = storeDirForRoot(root);
		if (!storeDir) return new Set();
		return new Set(loadStore(storeDir).data.mappings.map((m) => m.bookmark));
	};
	const decorateCommandRows = (items: AutocompleteItem[], sessionId: string): AutocompleteItem[] => {
		const settings = toggles.get(sessionId);
		// Render-path state only: in-memory toggles plus the cached workspace resolver. No jj
		// subprocess, no snapshotting here — ever.
		let repoActive = false;
		try {
			const cwd = lastCwd.get(sessionId);
			repoActive = cwd !== undefined && identityForDir(cwd) !== null;
		} catch {
			repoActive = false;
		}
		const jjAvailable = Bun.which("jj") !== null;
		const effective = effectiveState(settings, { jjAvailable, repoActive });
		return items.map((item) => {
			const name = isOwnRow(item);
			if (!name) return item;
			const live =
				name === "jj"
					? masterStatus(settings, effective)
					: childStatus(name === "jj-snapshots" ? "snapshots" : "explain", settings, effective);
			return { ...item, description: live };
		});
	};

	const installPaletteWrapper = (ctx: Ctx, sessionId: string): void => {
		if (wrappedSessions.has(sessionId)) return;
		const addProvider = ctx.ui?.addAutocompleteProvider;
		if (typeof addProvider !== "function") return;
		try {
			addProvider((current: AutocompleteProvider) => {
				if ((current as Record<symbol, unknown>)[WRAPPED] === true) return current;
				const wrapped = Object.create(current);
				Object.defineProperty(wrapped, WRAPPED, { value: true });
				wrapped.getSuggestions = async (
					lines: string[],
					cursorLine: number,
					cursorCol: number,
					signal?: AbortSignal,
				) => {
					const result = await current.getSuggestions(lines, cursorLine, cursorCol, signal);
					if (!result) return result;
					return { ...result, items: decorateCommandRows(result.items, sessionId) };
				};
				if (typeof current.trySyncSlashCompletion === "function") {
					const sync = current.trySyncSlashCompletion.bind(current);
					wrapped.trySyncSlashCompletion = (textBeforeCursor: string) => {
						const result = sync(textBeforeCursor);
						if (!result) return result;
						return { ...result, items: decorateCommandRows(result.items, sessionId) };
					};
				}
				return wrapped as AutocompleteProvider;
			});
			wrappedSessions.add(sessionId);
		} catch {
			// Palette decoration is cosmetic; a host without the supported wrapper keeps the
			// static registered descriptions plus immediate command feedback.
		}
	};

	const toggleUsage = (name: string): string => `Usage: /${name} [on|off|status]`;

	const makeToggleHandler = (name: (typeof COMMAND_NAMES)[number], key: SettingKey) => {
		return async (args: string, ctx: Ctx): Promise<void> => {
			const sessionId = sessionIdOf(ctx);
			lastCwd.set(sessionId, ctx.cwd);
			const parsed = parseToggleArg(args ?? "");
			if (!parsed) {
				ctx.ui?.notify?.(toggleUsage(name), "error");
				return;
			}
			let settings = toggles.get(sessionId);
			if (parsed === "on") settings = toggles.setKey(sessionId, key, true);
			else if (parsed === "off") settings = toggles.setKey(sessionId, key, false);
			else if (parsed === "toggle") settings = toggles.toggle(sessionId, key);
			if (parsed !== "status") persist(ctx, settings);

			const jjAvailable = Bun.which("jj") !== null;
			let repoActive = false;
			try {
				repoActive = identityForDir(ctx.cwd) !== null;
			} catch {
				repoActive = false;
			}
			const effective: EffectiveState = effectiveState(settings, { jjAvailable, repoActive });
			const line =
				key === "master"
					? masterStatus(settings, effective)
					: childStatus(key, settings, effective);
			ctx.ui?.notify?.(line, "info");
		};
	};

	api.setLabel("jj");

	api.on("session_start", async (_event, ctx) => {
		const c = ctx as Ctx;
		const session = refreshSession(c);
		const { armed, sessionId } = snapshotsArmed(c);
		if (armed) {
			const { roots, outcomes } = await snapshot("cwd", c, "session_start");
			recordCaptures(sessionId, roots, outcomes, { boundary: "session", requestId: null });
		}
		void session;
	});

	api.on("session_switch", async (_event, ctx) => {
		refreshSession(ctx as Ctx);
	});

	// Forks and tree navigation keep the transcript but must not restore files; they only
	// rebuild the checkpoint index from the entries visible on the new branch.
	api.on("session_branch", async (_event, ctx) => {
		refreshSession(ctx as Ctx);
	});

	api.on("session_tree", async (_event, ctx) => {
		refreshSession(ctx as Ctx);
	});

	api.on("session_before_compact", async (_event, ctx) => {
		const c = ctx as Ctx;
		lastCwd.set(sessionIdOf(c), c.cwd);
		const { armed, sessionId } = snapshotsArmed(c);
		if (armed) {
			const { roots, outcomes } = await snapshot("cwd", c, "session_before_compact");
			recordCaptures(sessionId, roots, outcomes, { boundary: "session", requestId: null });
		}
		return undefined;
	});
	api.on("before_agent_start", async (event, ctx) => {
		const c = ctx as Ctx;
		let e: { prompt?: string; systemPrompt?: string[] };
		try {
			e = event as { prompt?: string; systemPrompt?: string[] };
		} catch {
			return undefined;
		}
		try {
			const sessionId = sessionIdOf(c);
			lastCwd.set(sessionId, c.cwd);
			// One group per user request: later tool boundaries reference this id, so the
			// recovery list can show before/after states together. Read-only requests run no
			// tools and therefore leave no checkpoints behind.
			requestSeq += 1;
			requestIds.set(sessionId, `req-${requestSeq}`);
			const settings = toggles.get(sessionId);
			// Master-off prevents new automatic repository actions and instruction injection.
			// A non-JJ target is inactive, never a reason to initialize or mutate Git.
			if (!settings.master) return undefined;
			if (!Bun.which("jj")) return undefined;
			const targets = resolveRepoTargets({ cwd: c.cwd });
			if (targets.repos.length === 0) return undefined;

			const blocks: string[] = [];
			for (const repo of targets.repos) {
				const status = await readRepoStatus(repo.root, { timeoutMs: 3_000 });
				if (!status) continue;
				const described = describeWorkspace(repo.root);
				const colocated = described?.colocated ?? repo.colocated;
				const summaryLines = status.summary.split("\n").slice(0, 8).join("\n");
				const dirty =
					/no changes/i.test(status.summary) || /nothing changed/i.test(status.summary)
						? "clean"
						: "has working-copy changes (treat as pre-existing work: describe intent before the first agent-owned mutation; never rename user work)";
				blocks.push(
					[
						`[JJ repository] ${repo.root} (workspace ${repo.workspace}${colocated ? ", colocated with Git" : ""})`,
						`Working copy: ${status.changeId} ${status.commitId}${status.description ? ` "${status.description.split("\n")[0]}"` : ""} — ${dirty}`,
						summaryLines,
						`PR policy: ${prPolicyLine(repo.root)} — ask before the first publication under an unestablished policy (/jj-pr status; skills jj-pr, jj-stacked-pr).`,
						`Workflows: describe intent -> edit and verify -> refine description -> jj new at a coherent boundary. No automatic jj new, description replacement, or history reshaping. Atomic edits via skills jj-atomic; recovery via /jj-recover (skill jj-recovery); isolation via jj-isolation.`,
						`Constraints: JJ owns this root even when colocated; read-only git is fine, never translate git mutations into JJ or reattach Git HEAD. Guardrails redirect git habits and scope history rewrites; /jj-health is read-only. Other (non-JJ) targets in this session keep their own rules.`,
					].join("\n"),
				);
			}
			if (blocks.length === 0) return undefined;
			const addition = blocks.join("\n");
			const systemPrompt = [...(e.systemPrompt ?? []), addition];
			return { systemPrompt };
		} catch {
			return undefined;
		}
	});

	api.on("tool_call", async (event, ctx) => {
		const c = ctx as Ctx;
		const { armed, sessionId } = snapshotsArmed(c);
		lastCwd.set(sessionId, c.cwd);
		const ev = event as { toolName: string; input?: Record<string, unknown>; toolCallId: string };
		const { tool, targets, staged, stages } = classify(ev.toolName, ev.input ?? {});

		if (staged === "clear") {
			stagedFor(sessionId).clear();
			return undefined;
		}
		// Guardrails run on the master switch alone: a blocked tool never executes, so it
		// takes no checkpoint. Snapshots may stay off while guardrails still redirect.
		if (toggles.get(sessionId).master) {
			const verdict = await guardToolCall(c, sessionId, ev.toolName, ev.input ?? {});
			if (verdict) return verdict;
		}
		if (!armed) {
			// Still clear a pending staged apply: a disabled snapshots switch suspends capture
			// and must not leave stale roots for a later re-enablement.
			if (staged === "use") stagedFor(sessionId).clear();
			return undefined;
		}
		// An applied AST rewrite names no file, so snapshot where the staging call said it lands.
		const stagedRoots = stagedFor(sessionId);
		const effective: Targets =
			staged === "use" && stagedRoots.size > 0 ? [...stagedRoots] : targets;
		if (staged === "use") stagedRoots.clear();

		const { roots, outcomes } = await snapshot(effective, c, tool);
		recordCaptures(sessionId, roots, outcomes, {
			boundary: "pre",
			requestId: requestIds.get(sessionId) ?? null,
			callId: ev.toolCallId,
			tool,
		});
		if (stages) for (const root of roots) stagedRoots.add(root);

		if (roots.length > 0 && SYNC_MUTATORS[tool] === true) {
			let tracked = executedRoots.get(sessionId);
			if (!tracked) {
				tracked = new Map();
				executedRoots.set(sessionId, tracked);
			}
			tracked.set(ev.toolCallId, { tool, roots });
			if (tracked.size > MAX_TRACKED_CALLS) {
				const oldest = tracked.keys().next();
				if (!oldest.done) tracked.delete(oldest.value);
			}
		}
		return undefined;
	});

	// Supplies the per-tool boundary a batched pre-pass cannot. Runs even on error, since a failed
	// tool may still have written something.
	api.on("tool_result", async (event, ctx) => {
		const c = ctx as Ctx;
		const { armed, sessionId } = snapshotsArmed(c);
		lastCwd.set(sessionId, c.cwd);
		const ev = event as { toolCallId: string };
		const tracked = executedRoots.get(sessionId)?.get(ev.toolCallId);
		executedRoots.get(sessionId)?.delete(ev.toolCallId);
		if (!tracked || !armed) return undefined;
		const { roots, outcomes } = await snapshot(tracked.roots, c, `${tracked.tool}:after`);
		recordCaptures(sessionId, roots, outcomes, {
			boundary: "post",
			requestId: requestIds.get(sessionId) ?? null,
			callId: ev.toolCallId,
			tool: tracked.tool,
		});
		return undefined;
	});

	const recoverUsage = [
		"Usage:",
		"  /jj-recover list — show session recovery points",
		"  /jj-recover files <n> [-- <paths...>] — preview restoring file contents (bookmarks untouched)",
		"  /jj-recover files <n> --apply [-- <paths...>] — restore file contents",
		"  /jj-recover state <n> — preview restoring whole-repository state",
		"  /jj-recover state <n> --apply --confirm <op> — restore whole-repository state",
	].join("\n");

	const formatRecord = (index: number, record: CheckpointRecord): string => {
		const time = record.at.length >= 19 ? record.at.slice(11, 19) : record.at;
		return `#${index + 1} [${record.requestId ?? "session"}/${record.boundary}] ${record.tool ?? "—"} · ${record.workspace} · op:${shortId(record.opId)} · ${record.status} · ${time}`;
	};

	const listRecords = (sessionId: string, suspendedNote: string | null): string => {
		const records = checkpoints.list(sessionId);
		const lines =
			records.length === 0
				? ["No JJ recovery points this session."]
				: [
						`JJ recovery points (${records.length}):`,
						...records.map((record, i) => `  ${formatRecord(i, record)}`),
					];
		if (suspendedNote) lines.push(suspendedNote);
		return lines.join("\n");
	};

	/** Capture a recoverable pre-restore state when possible. Never throws. */
	const capturePreRestore = async (
		sessionId: string,
		root: string,
	): Promise<CaptureOutcome | undefined> => {
		try {
			const outcome = await snapshotter.snapshot(root, "pre-restore");
			if (outcome.opId) {
				const identity = describeWorkspace(root);
				if (identity) {
					const record: CheckpointRecord = {
						v: 1,
						requestId: requestIds.get(sessionId) ?? null,
						boundary: "pre-restore",
						root: identity.root,
						workspace: identity.workspace,
						storeKey: identity.storeKey,
						opId: outcome.opId,
						...(outcome.commitId ? { commitId: outcome.commitId } : {}),
						...(outcome.changeId ? { changeId: outcome.changeId } : {}),
						status: outcome.status,
						...(outcome.message ? { message: outcome.message } : {}),
						at: new Date().toISOString(),
					};
					checkpoints.add(sessionId, record);
					api.appendEntry?.(CHECKPOINT_CUSTOM_TYPE, record);
				}
			}
			return outcome;
		} catch {
			return undefined;
		}
	};

	const pickRecord = async (
		ctx: Ctx,
		kind: "files" | "state",
		records: CheckpointRecord[],
	): Promise<CheckpointRecord | undefined> => {
		const eligible = records.filter((r) => (kind === "files" ? r.commitId : r.opId));
		if (eligible.length === 0) {
			ctx.ui?.notify?.(`No restorable ${kind} checkpoints this session.`, "error");
			return undefined;
		}
		const select = ctx.ui?.select;
		if (typeof select !== "function") {
			ctx.ui?.notify?.(`${recoverUsage}`, "error");
			return undefined;
		}
		const options = eligible.map((r) => formatRecord(records.indexOf(r), r));
		let choice: string | undefined;
		try {
			choice = await select(`JJ recovery: restore ${kind} from`, options);
		} catch {
			return undefined;
		}
		if (!choice) return undefined;
		const match = /^#(\d+)/.exec(choice);
		if (!match) return undefined;
		return records[Number(match[1]) - 1];
	};

	const filesPreview = async (
		ctx: Ctx,
		record: CheckpointRecord,
		index: number,
		paths: string[],
	): Promise<string | null> => {
		const identity = describeWorkspace(record.root);
		if (!identity) return `Checkpoint #${index + 1}: workspace ${record.root} is no longer available.`;
		const validation = await validateCheckpoint(identity.root, record);
		if (!validation.commit || !record.commitId) {
			return [
				`Checkpoint #${index + 1} is not restorable: its commit is no longer available.`,
				`Missing state is reported, never replaced by a nearby revision — pick another point from /jj-recover list.`,
			].join("\n");
		}
		const status = await readRepoStatus(identity.root, { timeoutMs: 5_000 });
		const scope = paths.length > 0 ? `${paths.length} selected path(s): ${paths.join(", ")}` : "all files";
		const lines = [
			`Checkpoint #${index + 1} [${record.requestId ?? "session"}/${record.boundary}] ${record.tool ?? "—"} · workspace ${identity.workspace}`,
			`Will restore ${scope} from commit ${shortId(record.commitId)} (op ${shortId(record.opId)}). Bookmarks and heads are untouched.`,
			`Current state:`,
			status ? status.summary.split("\n").slice(0, 8).join("\n") : "(unreadable)",
			`Work at risk: changes made after this checkpoint are overwritten for the restored paths. A pre-restore checkpoint is captured first when possible.`,
		];
		if (record.status === "partial" || record.message) {
			lines.push(
				`Note: this checkpoint is partial — ${record.message ?? "some files were skipped and were never protected"}.`,
			);
		}
		lines.push(
			`To apply: /jj-recover files ${index + 1} --apply${paths.length > 0 ? ` -- ${paths.join(" ")}` : ""}`,
		);
		return lines.join("\n");
	};

	const statePreview = async (
		ctx: Ctx,
		record: CheckpointRecord,
		index: number,
	): Promise<string | null> => {
		const identity = describeWorkspace(record.root);
		if (!identity) return `Checkpoint #${index + 1}: workspace ${record.root} is no longer available.`;
		if (!record.opId) return `Checkpoint #${index + 1} names no operation and cannot restore state.`;
		const validation = await validateCheckpoint(identity.root, record);
		if (!validation.op) {
			return [
				`Checkpoint #${index + 1} is not restorable: operation ${shortId(record.opId)} is no longer available.`,
				`Missing state is reported, never replaced by a nearby revision — pick another point from /jj-recover list.`,
			].join("\n");
		}
		const preview = await previewStateRestore(identity.root, record.opId);
		if (preview.unavailable) {
			return [`Checkpoint #${index + 1} cannot be previewed: ${preview.unavailable}.`].join("\n");
		}
		return [
			`Checkpoint #${index + 1} [${record.requestId ?? "session"}/${record.boundary}] ${record.tool ?? "—"} · workspace ${identity.workspace}`,
			`Will restore whole-repository state to op ${shortId(record.opId)} (from current op ${shortId(preview.currentOp)}).`,
			`Impact (op diff, truncated):`,
			preview.diff ?? "(empty)",
			`Current working-copy state:`,
			preview.summary ?? "(unreadable)",
			`WARNING: this rewinds heads, bookmarks, and every workspace of this shared repo (store ${identity.storeKey}). Other sessions using these workspaces will see their state replaced. This does not undo pushes or PR changes and never contacts remotes.`,
			`To apply: /jj-recover state ${index + 1} --apply --confirm ${shortId(record.opId)}`,
		].join("\n");
	};

	const recoverHandler = async (args: string, ctx: Ctx): Promise<void> => {
		const sessionId = sessionIdOf(ctx);
		lastCwd.set(sessionId, ctx.cwd);
		const settings = toggles.get(sessionId);
		const suspended = !settings.master || !settings.snapshots;
		const suspendedNote = !settings.master
			? "JJ is off — recovery actions are suspended (records kept). Re-enable with /jj on."
			: "JJ snapshots are off — recovery actions are suspended (records kept). Re-enable with /jj-snapshots on.";

		const raw = (args ?? "").trim();
		const dashdash = raw.split(/\s+/).indexOf("--");
		const head = (dashdash >= 0 ? raw.split(/\s+/).slice(0, dashdash) : raw.split(/\s+/)).filter(Boolean);
		const paths = dashdash >= 0 ? raw.split(/\s+/).slice(dashdash + 1).filter(Boolean) : [];
		const sub = head[0] ?? "list";

		if (sub === "list") {
			ctx.ui?.notify?.(listRecords(sessionId, suspended ? suspendedNote : null), "info");
			return;
		}
		if (sub !== "files" && sub !== "state") {
			ctx.ui?.notify?.(recoverUsage, "error");
			return;
		}
		const records = checkpoints.list(sessionId);
		if (records.length === 0) {
			ctx.ui?.notify?.("No JJ recovery points this session.", "info");
			return;
		}
		let index = head.length > 1 ? Number(head[1]) : NaN;
		let record = Number.isInteger(index) ? records[index - 1] : undefined;
		if (!record) {
			if (head.length > 1) {
				ctx.ui?.notify?.(`No recovery point #${head[1]} (1–${records.length}).\n${recoverUsage}`, "error");
				return;
			}
			record = await pickRecord(ctx, sub, records);
			if (!record) return;
			index = records.indexOf(record) + 1;
		}
		const apply = head.includes("--apply");
		if (!apply) {
			const preview = sub === "files" ? await filesPreview(ctx, record, index - 1, paths) : await statePreview(ctx, record, index - 1);
			ctx.ui?.notify?.(preview ?? "Unable to preview this checkpoint.", "info");
			return;
		}
		// Restores are explicit repo mutations: they require master and snapshots.
		if (suspended) {
			ctx.ui?.notify?.(suspendedNote, "error");
			return;
		}
		if (!Bun.which("jj")) {
			ctx.ui?.notify?.("jj is not installed; cannot restore.", "error");
			return;
		}
		const identity = describeWorkspace(record.root);
		if (!identity) {
			ctx.ui?.notify?.(`Workspace ${record.root} is no longer available; nothing was changed.`, "error");
			return;
		}
		if (sub === "files") {
			if (!record.commitId) {
				ctx.ui?.notify?.(`Checkpoint #${index} names no commit and cannot restore files.`, "error");
				return;
			}
			const validation = await validateCheckpoint(identity.root, record);
			if (!validation.commit) {
				ctx.ui?.notify?.(
					`Checkpoint #${index} is not restorable: its commit is no longer available. Nothing was changed.`,
					"error",
				);
				return;
			}
			const pre = await capturePreRestore(sessionId, identity.root);
			if (!pre?.opId) {
				ctx.ui?.notify?.(
					"Warning: no pre-restore checkpoint could be captured; proceeding with the authorized restore.",
					"info",
				);
			}
			const result = await restoreFiles(identity.root, record.commitId, paths);
			if (!result.ok) {
				ctx.ui?.notify?.(`File restore failed; the pre-restore checkpoint above remains available.\n${result.detail}`, "error");
				return;
			}
			const post = await snapshotter.snapshot(identity.root, "post-restore");
			if (post.opId) {
				recordCaptures(sessionId, [identity.root], [post], {
					boundary: "post-restore",
					requestId: requestIds.get(sessionId) ?? null,
				});
			}
			ctx.ui?.notify?.(
				[`Restored ${paths.length > 0 ? `${paths.length} path(s)` : "all files"} in ${identity.workspace} from commit ${shortId(record.commitId)}.`, result.detail].filter(Boolean).join("\n"),
				"info",
			);
			return;
		}
		// Whole-repository restore: explicit authorization via the preview's confirm token.
		if (!record.opId) {
			ctx.ui?.notify?.(`Checkpoint #${index} names no operation and cannot restore state.`, "error");
			return;
		}
		const confirmAt = head.indexOf("--confirm");
		const token = confirmAt >= 0 ? head[confirmAt + 1] : undefined;
		if (token !== shortId(record.opId) && token !== record.opId) {
			ctx.ui?.notify?.(
				`Whole-repository restore requires explicit authorization: re-run with --confirm ${shortId(record.opId)}. Nothing was changed.`,
				"error",
			);
			return;
		}
		const validation = await validateCheckpoint(identity.root, record);
		if (!validation.op) {
			ctx.ui?.notify?.(
				`Checkpoint #${index} is not restorable: operation ${shortId(record.opId)} is no longer available. Nothing was changed.`,
				"error",
			);
			return;
		}
		const pre = await capturePreRestore(sessionId, identity.root);
		if (!pre?.opId) {
			ctx.ui?.notify?.(
				"Warning: no pre-restore checkpoint could be captured; proceeding with the authorized restore.",
				"info",
			);
		}
		const result = await restoreState(identity.root, record.opId);
		if (!result.ok) {
			ctx.ui?.notify?.(`Repository restore failed; the pre-restore checkpoint above remains available.\n${result.detail}`, "error");
			return;
		}
		const post = await snapshotter.snapshot(identity.root, "post-restore");
		if (post.opId) {
			recordCaptures(sessionId, [identity.root], [post], {
				boundary: "post-restore",
				requestId: requestIds.get(sessionId) ?? null,
			});
		}
		ctx.ui?.notify?.(
			[`Restored ${identity.workspace} to op ${shortId(record.opId)} (new op ${shortId(result.newOpId)}).`, result.detail].filter(Boolean).join("\n"),
			"info",
		);
	};

	api.registerCommand("jj-recover", {
		description: "Recover files or repository state from session-linked JJ checkpoints (list/files/state)",
		getArgumentCompletions: (prefix: string) => {
			const needle = (prefix ?? "").trim().toLowerCase();
			const matches = ["list", "files", "state"]
				.filter((word) => word.startsWith(needle))
				.map((word) => ({ value: word, label: word }));
			return matches.length > 0 ? matches : null;
		},
		handler: recoverHandler,
	});
	/** One-line PR policy for prompt context: sync store read, best-effort, never throws. */
	const prPolicyLine = (root: string): string => {
		try {
			const storeDir = storeDirForRoot(root);
			if (!storeDir) return "not configured";
			const { data } = loadStore(storeDir);
			const count = data.mappings.length;
			return `${data.defaults.preset} (${policySummary(policyFor(data.defaults))})${count > 0 ? ` · ${count} mapping(s)` : " · no mappings yet"}`;
		} catch {
			return "not configured";
		}
	};
	/** PR summary + this root's checkpoints for the health report. Never throws. */
	const healthOptions = async (
		sessionId: string,
		cwd: string,
	): Promise<{ checkpoints?: CheckpointRecord[]; pr?: { mappings: number; stale: string[]; preset: string } }> => {
		try {
			const records = checkpoints.list(sessionId);
			const identity = identityForDir(cwd);
			const own = identity ? records.filter((record) => record.root === identity.root) : [];
			let pr: { mappings: number; stale: string[]; preset: string } | undefined;
			if (identity) {
				const storeDir = storeDirForRoot(identity.root);
				if (storeDir) {
					const { data } = loadStore(storeDir);
					const validated = await validateAll(identity.root, data);
					pr = { mappings: validated.total, stale: validated.stale, preset: data.defaults.preset };
				}
			}
			return { checkpoints: own, ...(pr ? { pr } : {}) };
		} catch {
			return {};
		}
	};
	api.registerCommand("jj-health", {
		description: "Read-only repository health inspection (never repairs, fetches, or publishes)",
		handler: async (args: string, ctx: Ctx): Promise<void> => {
			const sessionId = sessionIdOf(ctx);
			lastCwd.set(sessionId, ctx.cwd);
			if ((args ?? "").trim()) {
				ctx.ui?.notify?.("Usage: /jj-health (no arguments; inspects the session workspace)", "error");
				return;
			}
			const report = await checkHealth(ctx.cwd, await healthOptions(sessionId, ctx.cwd));
			ctx.ui?.notify?.(formatReport(report), "info");
		},
	});
	api.registerCommand("jj-pr", {
		description: "Grouped-change PRs: map, preview, and publish with policy checks (preview never publishes)",
		getArgumentCompletions: (prefix: string) => {
			const needle = (prefix ?? "").trim().toLowerCase();
			const matches = ["status", "policy", "map", "unmap", "preview", "publish"]
				.filter((word) => word.startsWith(needle))
				.map((word) => ({ value: word, label: word }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args: string, ctx: Ctx): Promise<void> => {
			const sessionId = sessionIdOf(ctx);
			lastCwd.set(sessionId, ctx.cwd);
			await handlePrCommand(
				{ cwd: ctx.cwd, master: toggles.get(sessionId).master, notify: (message, level) => ctx.ui?.notify?.(message, level) },
				args,
			);
		},
	});
	api.registerCommand("jj-stack", {
		description: "Stacked PRs: per-layer preview/publish and merge-method-aware restacking",
		getArgumentCompletions: (prefix: string) => {
			const needle = (prefix ?? "").trim().toLowerCase();
			const matches = ["preview", "publish", "restack"]
				.filter((word) => word.startsWith(needle))
				.map((word) => ({ value: word, label: word }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args: string, ctx: Ctx): Promise<void> => {
			const sessionId = sessionIdOf(ctx);
			lastCwd.set(sessionId, ctx.cwd);
			await handleStackCommand(
				{ cwd: ctx.cwd, master: toggles.get(sessionId).master, notify: (message, level) => ctx.ui?.notify?.(message, level) },
				args,
			);
		},
	});
	/**
	 * Workspace actions delegate every rule to the bundled helper: placement, naming,
	 * collisions, nested-destination guards, removal safeguards, and backend detection.
	 * Creation and removal are preview-then-authorized; reads never mutate.
	 */
	const workspaceHandler = async (
		wctx: { cwd: string; master: boolean; notify: (message: string, level?: "info" | "error") => void },
		rawArgs: string,
	): Promise<void> => {
		const tokens = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
		const sub = tokens[0] ?? "list";
		const has = (...flags: string[]): boolean => flags.some((f) => tokens.includes(f));
		const valueOf = (...names: string[]): string | undefined => {
			for (let i = 0; i < tokens.length; i++) {
				for (const name of names) {
					if (tokens[i] === name) return tokens[i + 1];
					if ((tokens[i] as string).startsWith(`${name}=`)) return (tokens[i] as string).slice(name.length + 1);
				}
			}
			return undefined;
		};
		const base = { cwd: wctx.cwd };
		if (sub === "list") {
			const result = await listWorkspaces({ ...base, all: has("-a", "--all") });
			wctx.notify(result.ok ? [`Workspaces (${result.value.length}):`, ...result.value.map((r) => `  ${formatRow(r)}`)].join("\n") : formatError(result.error), result.ok ? "info" : "error");
			return;
		}
		if (sub === "select") {
			const name = tokens[1];
			if (!name) {
				wctx.notify(`select names a workspace explicitly (no interactive picking here).\n${workspaceUsage}`, "error");
				return;
			}
			const result = await selectWorkspace({ ...base, name, all: has("-a", "--all") });
			wctx.notify(result.ok ? result.value : formatError(result.error), result.ok ? "info" : "error");
			return;
		}
		if (sub === "main") {
			const result = await mainWorkspace(base);
			wctx.notify(result.ok ? `${result.value.backend} primary: ${result.value.path}${result.value.prefix ? ` (subdirectory ${result.value.prefix})` : ""}` : formatError(result.error), result.ok ? "info" : "error");
			return;
		}
		if (sub === "add") {
			const name = tokens[1];
			if (!name) {
				wctx.notify(workspaceUsage, "error");
				return;
			}
			if (!wctx.master) {
				wctx.notify("JJ is off — workspace creation is suspended. Re-enable with /jj on.", "error");
				return;
			}
			const revision = valueOf("--revision", "-r");
			if (!has("--apply")) {
				wctx.notify(
					[
						`Will create workspace '${name}' under the helper's managed root for this repository (backend per helper detection)${revision ? ` at revision ${revision}` : ""}.`,
						"Placement, collision, and nested-destination rules run inside the helper.",
						`To execute: /jj-workspace add ${name} --apply${revision ? ` --revision ${revision}` : ""}`,
					].join("\n"),
					"info",
				);
				return;
			}
			const result = await addWorkspace({ ...base, name, ...(revision ? { revision } : {}), force: has("--force") });
			wctx.notify(result.ok ? `Created ${result.value.backend} workspace '${result.value.name}' at ${result.value.path}` : formatError(result.error), result.ok ? "info" : "error");
			return;
		}
		if (sub === "remove") {
			const name = tokens[1];
			if (!name) {
				wctx.notify(workspaceUsage, "error");
				return;
			}
			if (!wctx.master) {
				wctx.notify("JJ is off — workspace removal is suspended. Re-enable with /jj on.", "error");
				return;
			}
			const confirm = valueOf("--confirm");
			if (!has("--apply") || confirm !== name) {
				const lookup = await listWorkspaces({ ...base, all: has("-a", "--all") });
				const row = lookup.ok ? lookup.value.find((r) => r.name === name) : undefined;
				wctx.notify(
					[
						row ? `Would remove: ${formatRow(row)}` : `No managed row named '${name}' is visible; the helper still decides (try --all).`,
						"Removal safeguards refuse dirty/untracked state without --force, protect the primary, and never delete history.",
						`To execute: /jj-workspace remove ${name} --apply --confirm ${name}${has("--force") ? " --force" : ""}${has("--delete-dir") ? " --delete-dir" : ""}`,
					].join("\n"),
					"info",
				);
				return;
			}
			const result = await removeWorkspace({ ...base, name, all: has("-a", "--all"), force: has("--force"), deleteDir: has("--delete-dir") });
			if (!result.ok) {
				wctx.notify(formatError(result.error), "error");
				return;
			}
			wctx.notify(
				[`Removed '${result.value.name}' (${result.value.path}).`, ...result.value.notes.map((n) => `  - ${n}`)].join("\n"),
				"info",
			);
			return;
		}
		wctx.notify(workspaceUsage, "error");
	};
	const workspaceUsage = [
		"Usage:",
		"  /jj-workspace list [-a] — registered workspaces (managed only unless --all)",
		"  /jj-workspace select <name> [-a] — resolve one workspace to its path",
		"  /jj-workspace main — primary checkout/workspace path",
		"  /jj-workspace add <name> [--revision R] — preview creation (re-run with --apply)",
		"  /jj-workspace add <name> --apply [--revision R] [--force] — create via the helper",
		"  /jj-workspace remove <name> [-a] — preview removal safeguards (re-run with --apply --confirm <name>)",
		"  /jj-workspace remove <name> --apply --confirm <name> [--force] [--delete-dir] — remove via the helper",
	].join("\n");
	api.registerCommand("jj-workspace", {
		description: "Workspace actions through the bundled helper (list/select/main/add/remove with safeguards)",
		getArgumentCompletions: (prefix: string) => {
			const needle = (prefix ?? "").trim().toLowerCase();
			const matches = ["list", "select", "main", "add", "remove"]
				.filter((word) => word.startsWith(needle))
				.map((word) => ({ value: word, label: word }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args: string, ctx: Ctx): Promise<void> => {
			const sessionId = sessionIdOf(ctx);
			lastCwd.set(sessionId, ctx.cwd);
			await workspaceHandler(
				{ cwd: ctx.cwd, master: toggles.get(sessionId).master, notify: (message, level) => ctx.ui?.notify?.(message, level) },
				args,
			);
		},
	});
	for (const name of COMMAND_NAMES) {
		const key = (name === "jj" ? "master" : name === "jj-snapshots" ? "snapshots" : "explain") as SettingKey;
		api.registerCommand(name, {
			description: COMMAND_DESCRIPTIONS[name],
			getArgumentCompletions: (prefix: string) => {
				const needle = (prefix ?? "").trim().toLowerCase();
				const matches = TOGGLE_COMPLETIONS.filter((item) => item.value.startsWith(needle));
				return matches.length > 0 ? matches : null;
			},
			handler: makeToggleHandler(name, key),
		});
	}
}

