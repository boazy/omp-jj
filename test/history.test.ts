/**
 * History previews: scope resolution, published/immutable signals, and drift detection.
 * All previews are `--ignore-working-copy` reads; the op log stays untouched by inspection.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	drifted,
	fingerprint,
	formatScope,
	immutableCommits,
	listCommits,
	previewAbsorb,
	previewRebase,
	previewSplit,
	previewSquash,
	publishedCommits,
	workingCopyFiles,
} from "../src/history.ts";
import { runJj } from "../src/recovery.ts";
import { clearWorkspaceCache } from "../src/workspace.ts";
import {
	bareBranches,
	cleanupScratch,
	hasJj,
	makeBareRemote,
	makeRepo,
	opCount,
} from "./harness.ts";
beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

async function jj(root: string, args: string[]): Promise<void> {
	const result = await runJj(root, args, { timeoutMs: 30_000 });
	if (result.code !== 0) throw new Error(`jj ${args.join(" ")} failed: ${result.err}`);
}

describe.skipIf(!hasJj)("history previews", () => {
	test("absorb scope names ancestors and working-copy files", async () => {
		const repo = await makeRepo();
		await Bun.write(join(repo, "fix.txt"), "v1\n");
		await jj(repo, ["describe", "-m", "feature"]);
		await Bun.write(join(repo, "fix.txt"), "v2\n");
		// Read-only previews see recorded state: snapshot first so the files resolve.
		await jj(repo, ["st"]);

		const scope = await previewAbsorb(repo);
		if ("unavailable" in scope) throw new Error(scope.unavailable);
		expect(scope.files).toContain("fix.txt");
		expect(scope.revs.length).toBeGreaterThan(0);
		// Ancestor scopes always span the immutable root: this is why the guardrail skips
		// the frozen check for absorb and enforces published policy instead.
		expect(immutableCommits(scope).length).toBeGreaterThan(0);
		expect(publishedCommits(scope).length).toBe(0);
	});

	test("immutable() resolves with the immutable flag set", async () => {
		const repo = await makeRepo();
		const frozen = await listCommits(repo, "immutable()");
		expect(frozen).toBeDefined();
		expect((frozen ?? []).length).toBeGreaterThan(0);
		expect((frozen ?? []).every((c) => c.immutable)).toBe(true);
		const head = await listCommits(repo, "@");
		expect(head?.[0]?.immutable).toBe(false);
	});

	test("published signal appears after pushing a bookmark to a bare remote", async () => {
		const repo = await makeRepo();
		const remote = await makeBareRemote();
		await Bun.write(join(repo, "ship.txt"), "x\n");
		await jj(repo, ["describe", "-m", "ship it"]);
		await jj(repo, ["bookmark", "create", "feat"]);
		await jj(repo, ["git", "remote", "add", "origin", remote]);
		await jj(repo, ["git", "push", "--bookmark", "feat"]);
		expect(await bareBranches(remote)).toContain("feat");

		const scope = await previewSquash(repo, {});
		if ("unavailable" in scope) throw new Error(scope.unavailable);
		expect(publishedCommits(scope).length).toBeGreaterThan(0);
	});

	test("rebase needs explicit source and destination", async () => {
		const repo = await makeRepo();
		expect(await previewRebase(repo, {})).toMatchObject({ unavailable: expect.stringContaining("source") });
		expect(await previewRebase(repo, { source: "@" })).toMatchObject({ unavailable: expect.stringContaining("destination") });
		expect(await previewRebase(repo, { source: "nope!!!", dest: "@-" })).toMatchObject({ unavailable: expect.anything() });
	});

	test("split defaults to @ and lists working-copy files", async () => {
		const repo = await makeRepo();
		await Bun.write(join(repo, "split.txt"), "s\n");
		await jj(repo, ["st"]);
		const scope = await previewSplit(repo, {});
		if ("unavailable" in scope) throw new Error(scope.unavailable);
		expect(scope.files).toContain("split.txt");
		expect(scope.revs[0]?.changeId).toBeTruthy();
	});

	test("fingerprint drift detects concurrent operations and nothing else", async () => {
		const repo = await makeRepo();
		const before = await fingerprint(repo);
		expect(before.opId).toBeTruthy();
		const same = await fingerprint(repo);
		expect(drifted(before, same)).toBe(false);
		await jj(repo, ["describe", "-m", "concurrent edit"]);
		const after = await fingerprint(repo);
		expect(drifted(before, after)).toBe(true);
	});

	test("formatScope stays terse unless verbose", async () => {
		const repo = await makeRepo();
		await Bun.write(join(repo, "f.txt"), "x\n");
		const scope = await previewAbsorb(repo);
		if ("unavailable" in scope) throw new Error(scope.unavailable);
		const brief = formatScope(scope, false);
		expect(brief).toContain("rewrites");
		expect(brief.split("\n")).toHaveLength(1);
		expect(formatScope(scope, true).split("\n").length).toBeGreaterThan(1);
	});

	test("inspection creates no operations", async () => {
		const repo = await makeRepo();
		await Bun.write(join(repo, "read.txt"), "r\n");
		const before = await opCount(repo);
		await previewAbsorb(repo);
		await previewSquash(repo, {});
		await previewSplit(repo, {});
		await previewRebase(repo, { source: "@", dest: "@-" });
		expect(await opCount(repo)).toBe(before);
	});
});
