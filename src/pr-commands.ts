/**
 * `/jj-pr` and `/jj-stack` command flows.
 *
 * Thin interaction layer over pr.ts: parse arguments, resolve the shared-repo store for the
 * session workspace, run previews, and execute authorized mutations. Publication always
 * follows preview → authorize → revalidate → narrow push → gh metadata → verify, with drift
 * tokens refusing moved state. Preview paths never publish.
 *
 * The context given to these handlers is deliberately narrow (cwd, master gate, notify):
 * everything else resolves from the repository itself, so the same flows stay honest in
 * TUI, headless, and test-stub hosts.
 */
import {
	loadStore,
	planRestack,
	applyRestack,
	policyFor,
	policySummary,
	previewPR,
	PR_PRESETS,
	publishPR,
	resolveGroup,
	resolveStack,
	saveStore,
	storeDirForRoot,
	validateAll,
	cleanBookmark,
	type PRMapping,
	type PRStoreData,
} from "./pr.ts";
import { identityForDir } from "./repo.ts";
import { drifted, fingerprint, listCommits } from "./history.ts";

export const PR_USAGE = [
	"Usage:",
	"  /jj-pr status — mappings, policy, and validation",
	"  /jj-pr policy [single|atomic|per-round] — show or set the repo default",
	"  /jj-pr map <bookmark> --base <base> [--remote R] [--repo OWNER/REPO] [--changes c1,c2] [--tip <change>] [--pr N]",
	"  /jj-pr unmap <bookmark>",
	"  /jj-pr preview <bookmark> — exact ranges, bookmark updates, published rewrites (never publishes)",
	"  /jj-pr publish <bookmark> --apply --confirm <op> — narrow push + gh metadata after revalidation",
].join("\n");

export const STACK_USAGE = [
	"Usage:",
	"  /jj-stack preview <b1> <b2> ... — per-layer previews with chain verification",
	"  /jj-stack publish <b1> <b2> ... --apply --confirm <op> — bottom-up publication",
	"  /jj-stack restack <landed> --method <rebase|squash|merge> --onto <rev> --layers <b1,b2> [--apply --confirm <op>]",
].join("\n");

function splitArgs(raw: string): string[] {
	return (raw ?? "").trim().split(/\s+/).filter(Boolean);
}

/** `--name value` / `--name=value` flags plus positionals. */
function parseFlags(tokens: string[]): { positional: string[]; flags: Map<string, string | true> } {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq >= 0) {
				flags.set(token.slice(2, eq), token.slice(eq + 1));
			} else {
				const next = tokens[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags.set(token.slice(2), next);
					i++;
				} else {
					flags.set(token.slice(2), true);
				}
			}
		} else {
			positional.push(token);
		}
	}
	return { positional, flags };
}

const flagString = (flags: Map<string, string | true>, name: string): string | undefined => {
	const value = flags.get(name);
	return typeof value === "string" ? value : undefined;
};

interface PrRoot {
	root: string;
	storeDir: string;
	store: PRStoreData;
}

async function needPrRoot(ctx: PrCommandCtx): Promise<PrRoot | undefined> {
	let identity: ReturnType<typeof identityForDir> = null;
	try {
		identity = identityForDir(ctx.cwd);
	} catch {
		identity = null;
	}
	if (!identity) {
		ctx.notify(`Not a JJ workspace: ${ctx.cwd}. PR commands run from the publishing workspace.`, "error");
		return undefined;
	}
	const storeDir = storeDirForRoot(identity.root);
	if (!storeDir) {
		ctx.notify("Shared store is unreadable; cannot load PR policy.", "error");
		return undefined;
	}
	return { root: identity.root, storeDir, store: loadStore(storeDir).data };
}

function requireMaster(ctx: PrCommandCtx): boolean {
	if (!ctx.master) {
		ctx.notify("JJ is off — PR actions are suspended. Re-enable with /jj on.", "error");
		return false;
	}
	return true;
}

async function mutableCandidates(root: string, tipChange: string): Promise<string[]> {
	const listed = await listCommits(root, `ancestors(${tipChange}, 12) & mutable()`);
	if (!listed) return [];
	return listed.map((c) => c.changeId);
}

export async function handlePrCommand(ctx: PrCommandCtx, args: string): Promise<void> {
	const { positional, flags } = parseFlags(splitArgs(args));
	const sub = positional[0] ?? "status";

	if (sub === "status") {
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		const { root, store } = resolved;
		const validated = await validateAll(root, store);
		const lines = [
			`PR defaults: preset ${store.defaults.preset} (${PR_PRESETS[store.defaults.preset].label})`,
			`Policy: ${policySummary(policyFor(store.defaults))}`,
			validated.total === 0 ? "Mappings: none yet — map one before the first publication." : `Mappings (${validated.total}):`,
		];
		for (const mapping of store.mappings) {
			const group = await resolveGroup(root, mapping);
			const stale = group.stale.length > 0 ? ` STALE (${group.stale.length} change(s) replaced)` : "";
			lines.push(
				`  ${mapping.bookmark} → ${mapping.base} · ${mapping.changes.length} change(s) · tip ${group.tipChange.slice(0, 8) || "?"}${mapping.prNumber ? ` · PR #${mapping.prNumber}` : ""}${stale}`,
			);
		}
		ctx.notify(lines.join("\n"), "info");
		return;
	}

	if (sub === "policy") {
		const name = positional[1];
		if (!name) {
			const resolved = await needPrRoot(ctx);
			if (!resolved) return;
			ctx.notify(
				`Repo default preset: ${resolved.store.defaults.preset} (${policySummary(policyFor(resolved.store.defaults))}). Available: single, atomic, per-round.`,
				"info",
			);
			return;
		}
		if (!requireMaster(ctx)) return;
		if (name !== "single" && name !== "atomic" && name !== "per-round") {
			ctx.notify(`Unknown preset ${name}.\n${PR_USAGE}`, "error");
			return;
		}
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		resolved.store.defaults.preset = name as PRPresetName;
		try {
			saveStore(resolved.storeDir, resolved.store);
		} catch (error) {
			ctx.notify(`Could not persist policy: ${String(error)}`, "error");
			return;
		}
		ctx.notify(`Repo default preset: ${name} (${PR_PRESETS[name as PRPresetName].label}).`, "info");
		return;
	}

	if (sub === "map") {
		if (!requireMaster(ctx)) return;
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		const { root, storeDir, store } = resolved;
		const bookmark = cleanBookmark(positional[1] ?? "");
		if (!bookmark) {
			ctx.notify(`Map needs a bookmark name.\n${PR_USAGE}`, "error");
			return;
		}
		const existing = store.mappings.find((m) => m.bookmark === bookmark);
		const base = flagString(flags, "base") ?? existing?.base;
		if (!base) {
			ctx.notify(`Map needs an explicit base: /jj-pr map ${bookmark} --base <bookmark|commit>.`, "error");
			return;
		}
		const tipOverride = flagString(flags, "tip");
		const tipResolved = await resolveGroup(root, {
			bookmark,
			base,
			changes: [],
			tipChange: "",
		} as PRMapping);
		if (!tipResolved.tipCommit) {
			ctx.notify(`Bookmark ${bookmark} does not resolve; create/move it to the group tip first.`, "error");
			return;
		}
		if (tipOverride && tipOverride !== tipResolved.tipChange && tipOverride !== tipResolved.tipCommit) {
			ctx.notify(
				`Explicit tip ${tipOverride} is not where ${bookmark} points (${tipResolved.tipChange.slice(0, 8)}). The bookmark must sit at the group tip; move it first.`,
				"error",
			);
			return;
		}
		const changesRaw = flagString(flags, "changes") ?? existing?.changes.join(",");
		if (!changesRaw) {
			const candidates = await mutableCandidates(root, tipResolved.tipChange);
			ctx.notify(
				[
					`Map needs the explicit group: /jj-pr map ${bookmark} --base ${base} --changes <change,change>.`,
					candidates.length > 0
						? `Mutable ancestors of the tip (candidates, tip first): ${candidates.slice(0, 8).map((c) => c.slice(0, 8)).join(", ")}`
						: "No mutable ancestors found.",
					"Groups are never inferred from linear ancestry.",
				].join("\n"),
				"error",
			);
			return;
		}
		const changes: string[] = [];
		for (const piece of changesRaw.split(",")) {
			const listed = await listCommits(root, piece.trim());
			const only = listed && listed.length === 1 ? listed[0] : undefined;
			if (!only) {
				ctx.notify(`Change ${piece.trim()} does not resolve to exactly one commit; select the group explicitly.`, "error");
				return;
			}
			changes.push(only.changeId);
		}
		if (!changes.includes(tipResolved.tipChange)) {
			ctx.notify(`Group must include the tip change ${tipResolved.tipChange.slice(0, 8)}; refusing a tip-less group.`, "error");
			return;
		}
		const prNumberRaw = flagString(flags, "pr");
		const mapping: PRMapping = {
			bookmark,
			base,
			...(flagString(flags, "remote") ? { remote: flagString(flags, "remote") as string } : {}),
			...(flagString(flags, "repo") ? { repo: flagString(flags, "repo") as string } : {}),
			changes,
			tipChange: tipResolved.tipChange,
			...(prNumberRaw && Number.isInteger(Number(prNumberRaw)) ? { prNumber: Number(prNumberRaw) } : {}),
			...(existing?.policy ? { policy: existing.policy } : {}),
			updatedAt: new Date().toISOString(),
		};
		const next = store.mappings.filter((m) => m.bookmark !== bookmark);
		next.push(mapping);
		try {
			saveStore(storeDir, { ...store, mappings: next });
		} catch (error) {
			ctx.notify(`Could not persist mapping: ${String(error)}`, "error");
			return;
		}
		ctx.notify(
			`Mapped ${bookmark} → ${base} (${changes.length} change(s), tip ${tipResolved.tipChange.slice(0, 8)}). Preview with /jj-pr preview ${bookmark}.`,
			"info",
		);
		return;
	}

	if (sub === "unmap") {
		if (!requireMaster(ctx)) return;
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		const bookmark = cleanBookmark(positional[1] ?? "");
		if (!bookmark) {
			ctx.notify(`Unmap needs a bookmark name.\n${PR_USAGE}`, "error");
			return;
		}
		const next = resolved.store.mappings.filter((m) => m.bookmark !== bookmark);
		if (next.length === resolved.store.mappings.length) {
			ctx.notify(`No mapping for ${bookmark}.`, "error");
			return;
		}
		try {
			saveStore(resolved.storeDir, { ...resolved.store, mappings: next });
		} catch (error) {
			ctx.notify(`Could not persist removal: ${String(error)}`, "error");
			return;
		}
		ctx.notify(`Removed mapping for ${bookmark}; history is untouched.`, "info");
		return;
	}

	if (sub === "preview") {
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		const bookmark = cleanBookmark(positional[1] ?? "");
		const mapping = resolved.store.mappings.find((m) => m.bookmark === bookmark);
		if (!mapping) {
			ctx.notify(`No mapping for ${positional[1] ?? "(none)"}; map it first.\n${PR_USAGE}`, "error");
			return;
		}
		const preview = await previewPR(resolved.root, resolved.store, mapping);
		ctx.notify(preview.text, preview.problems.length > 0 ? "error" : "info");
		return;
	}

	if (sub === "publish") {
		if (!requireMaster(ctx)) return;
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		const bookmark = cleanBookmark(positional[1] ?? "");
		const mapping = resolved.store.mappings.find((m) => m.bookmark === bookmark);
		if (!mapping) {
			ctx.notify(`No mapping for ${positional[1] ?? "(none)"}; map it first.\n${PR_USAGE}`, "error");
			return;
		}
		if (flags.get("apply") !== true) {
			const preview = await previewPR(resolved.root, resolved.store, mapping);
			ctx.notify(`${preview.text}\nA preview is not publication: re-run with --apply --confirm <op>.`, "info");
			return;
		}
		const confirm = flagString(flags, "confirm");
		const result = await publishPR(resolved.root, resolved.store, mapping, confirm);
		if (result.ok && result.prNumber && mapping.prNumber !== result.prNumber) {
			try {
				saveStore(resolved.storeDir, {
					...resolved.store,
					mappings: resolved.store.mappings.map((m) =>
						m.bookmark === bookmark ? { ...m, prNumber: result.prNumber, updatedAt: new Date().toISOString() } : m,
					),
				});
			} catch {
				result.incomplete.push("PR number was not persisted; record it with /jj-pr map --pr.");
			}
		}
		ctx.notify(result.detail, result.ok ? "info" : "error");
		return;
	}

	ctx.notify(PR_USAGE, "error");
}

export async function handleStackCommand(ctx: PrCommandCtx, args: string): Promise<void> {
	const { positional, flags } = parseFlags(splitArgs(args));
	const sub = positional[0] ?? "preview";
	const bookmarks = positional.slice(1).filter((t) => !t.startsWith("--"));

	if (sub === "preview") {
		if (bookmarks.length === 0) {
			ctx.notify(`Stack preview names each layer explicitly.\n${STACK_USAGE}`, "error");
			return;
		}
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		const layers = await resolveStack(resolved.root, resolved.store, bookmarks);
		const lines = [`Stack preview (${layers.length} layer(s)):`];
		for (const layer of layers) {
			if (layer.problem || !layer.mapping) {
				lines.push(`  ${layer.bookmark}: BLOCKED — ${layer.problem ?? "unresolvable"}`);
				continue;
			}
			const preview = await previewPR(resolved.root, resolved.store, layer.mapping);
			lines.push(`  --- ${layer.bookmark} ---`);
			lines.push(...preview.text.split("\n").map((l) => `  ${l}`));
		}
		ctx.notify(lines.join("\n"), layers.some((l) => l.problem) ? "error" : "info");
		return;
	}

	if (sub === "publish") {
		if (!requireMaster(ctx)) return;
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		if (bookmarks.length === 0) {
			ctx.notify(`Stack publish names each layer bottom-up.\n${STACK_USAGE}`, "error");
			return;
		}
		if (flags.get("apply") !== true) {
			ctx.notify("A preview is not publication: re-run with --apply --confirm <op>. See /jj-stack preview.", "error");
			return;
		}
		const result = await publishStackFlow(resolved.root, resolved.storeDir, resolved.store, bookmarks, flagString(flags, "confirm"));
		ctx.notify(result.text, result.ok ? "info" : "error");
		return;
	}

	if (sub === "restack") {
		const landed = cleanBookmark(positional[1] ?? "");
		const method = flagString(flags, "method");
		const onto = flagString(flags, "onto");
		const layersRaw = flagString(flags, "layers");
		if (!landed || (method !== "rebase" && method !== "squash" && method !== "merge") || !onto || !layersRaw) {
			ctx.notify(STACK_USAGE, "error");
			return;
		}
		const resolved = await needPrRoot(ctx);
		if (!resolved) return;
		const layers = await resolveStack(
			resolved.root,
			resolved.store,
			layersRaw.split(",").map((s) => s.trim()).filter(Boolean),
		);
		const planned = await planRestack(resolved.root, resolved.store, layers, landed, method as MergeMethod, onto);
		if (planned.stopped) {
			ctx.notify(`Restack stopped: ${planned.stopped}`, "error");
			return;
		}
		const plan = planned.plan as { toAbandon: string[]; rebases: Array<{ source: string; dest: string }>; notes: string[] };
		const fresh = await fingerprint(resolved.root);
		const lines = [
			`Restack plan (${method} of ${landed} onto ${onto}):`,
			...plan.notes.map((n) => `  - ${n}`),
			plan.toAbandon.length > 0 ? `  abandon: ${plan.toAbandon.map((c) => c.slice(0, 8)).join(", ")}` : "  abandon: none",
			...plan.rebases.map((r) => `  rebase ${r.source.slice(0, 8)} onto ${r.dest.slice(0, 8)}`),
			`To apply: /jj-stack restack ${landed} --method ${method} --onto ${onto} --layers ${layersRaw} --apply --confirm ${(fresh.opId ?? "").slice(0, 12)}`,
		];
		if (flags.get("apply") !== true) {
			ctx.notify(lines.join("\n"), "info");
			return;
		}
		if (!requireMaster(ctx)) return;
		const applied = await applyRestack(resolved.root, plan, flagString(flags, "confirm"));
		ctx.notify(applied.ok ? `Restack applied: ${applied.detail}` : `Restack failed: ${applied.detail}`, applied.ok ? "info" : "error");
		return;
	}

	ctx.notify(STACK_USAGE, "error");
}

async function publishStackFlow(
	root: string,
	storeDir: string,
	store: PRStoreData,
	bookmarks: string[],
	confirm: string | undefined,
): Promise<{ ok: boolean; text: string }> {
	const lines: string[] = [`Stack publish (${bookmarks.length} layer(s), bottom-up):`];
	const start = await fingerprint(root);
	// Authorization is mandatory: a missing confirm refuses before any external side effect.
	if (!confirm) {
		return { ok: false, text: "stack publish requires an explicit authorization token: re-run /jj-stack preview and pass --apply --confirm <op>. Nothing was pushed." };
	}
	if (!start.opId || (confirm !== start.opId && confirm !== start.opId.slice(0, 12))) {
		return { ok: false, text: "state changed since the preview; re-run /jj-stack preview. Nothing was pushed." };
	}
	// Chain validation first: no layer pushes until every layer resolves.
	const layers = await resolveStack(root, store, bookmarks);
	const broken = layers.filter((l) => l.problem || !l.mapping);
	if (broken.length > 0) {
		return {
			ok: false,
			text: [...lines, ...broken.map((l) => `  ${l.bookmark}: BLOCKED — ${l.problem ?? "unresolvable"}`), "Nothing was pushed."].join("\n"),
		};
	}
	// Policy gates first: every layer runs the same preview checks publishPR enforces
	// (stale mappings, empty scratch tips, strict no-rewrite) before the first push.
	for (const layer of layers) {
		if (!layer.mapping) {
			return { ok: false, text: [...lines, `  ${layer.bookmark}: BLOCKED — unresolvable`, "Nothing was pushed."].join("\n") };
		}
		const preview = await previewPR(root, store, layer.mapping);
		if (preview.problems.length > 0) {
			return {
				ok: false,
				text: [...lines, `  ${layer.bookmark}: BLOCKED —`, ...preview.problems.map((p) => `    - ${p}`), "Nothing was pushed."].join("\n"),
			};
		}
	}
	let expected = start;
	let data = store;
	for (const layer of layers) {
		const mapping = data.mappings.find((m) => m.bookmark === layer.bookmark);
		if (!mapping) {
			lines.push(`  ${layer.bookmark}: BLOCKED — mapping vanished; stopping. Earlier layers already pushed as reported above.`);
			return { ok: false, text: lines.join("\n") };
		}
		const now = await fingerprint(root);
		if (drifted(expected, now)) {
			lines.push(`  ${layer.bookmark}: BLOCKED — state moved underfoot; re-run preview. Earlier layers already pushed as reported above.`);
			return { ok: false, text: lines.join("\n") };
		}
		// Same gates as single publication: the carried fingerprint is the fresh token.
		const result = await publishPR(root, data, mapping, expected.opId);
		lines.push(`  ${layer.bookmark}: ${result.ok ? "published" : "FAILED"} — ${result.detail.split("\n")[0]}`);
		if (result.prNumber && mapping.prNumber !== result.prNumber) {
			const next = { ...data, mappings: data.mappings.map((m) => (m.bookmark === layer.bookmark ? { ...m, prNumber: result.prNumber, updatedAt: new Date().toISOString() } : m)) };
			try {
				saveStore(storeDir, next);
				data = next;
			} catch {
				lines.push(`  ${layer.bookmark}: warning — PR number not persisted.`);
			}
		}
		if (!result.ok || !result.pushed) {
			lines.push("  stopping: no further layers pushed.");
			return { ok: false, text: lines.join("\n") };
		}
		expected = await fingerprint(root);
	}
	return { ok: true, text: lines.join("\n") };
}
