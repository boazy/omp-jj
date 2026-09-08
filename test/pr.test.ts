/**
 * PR identity, policy, and publication: explicit groups, preview-then-authorized publish,
 * drift tokens, strict-policy stops, and honest incomplete reporting. Bare local remotes
 * plus a fake gh stand in for GitHub; no live mutation.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadStore, policyFor, PR_PRESETS } from "../src/pr.ts";
import { runJj } from "../src/recovery.ts";
import { resolveStorePath } from "../src/repo.ts";
import { clearWorkspaceCache } from "../src/workspace.ts";
import {
	bareBranches,
	cleanupScratch,
	hasJj,
	makeBareRemote,
	makeDir,
	makeFakeGh,
	makeRepo,
	startExtension,
	withPathPrefix,
} from "./harness.ts";

async function jj(root: string, args: string[]): Promise<string> {
	const result = await runJj(root, args, { timeoutMs: 60_000 });
	if (result.code !== 0) throw new Error(`jj ${args.join(" ")} failed: ${result.err}`);
	return result.out.trim();
}

async function changeOf(root: string, rev: string): Promise<string> {
	return jj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", rev, "-T", "change_id"]);
}

/** Repo with a base commit, remote, and fake gh on PATH. */
async function setupPub() {
	const host = startExtension();
	const repo = await makeRepo();
	const remote = await makeBareRemote();
	const gh = await makeFakeGh();
	const restorePath = withPathPrefix(gh.dir);
	try {
		await Bun.write(join(repo, "base.txt"), "base\n");
		await jj(repo, ["describe", "-m", "base"]);
		await jj(repo, ["bookmark", "create", "main", "-r", "@"]);
		await jj(repo, ["git", "remote", "add", "origin", remote]);
		await jj(repo, ["new"]);
		await Bun.write(join(repo, "feat.txt"), "feat\n");
		await jj(repo, ["describe", "-m", "feat: work"]);
		await jj(repo, ["bookmark", "create", "feat"]);
		const featChange = await changeOf(repo, "feat");
		return { host, repo, remote, gh, restorePath, featChange };
	} catch (error) {
		restorePath();
		throw error;
	}
}

function ghCalls(gh: { log: string }): Promise<string> {
	return readFile(gh.log, "utf8").catch(() => "");
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe("policy model", () => {
	test("presets separate shape, updates, and published constraints", () => {
		expect(PR_PRESETS.single.policy).toMatchObject({ initialShape: "single-commit", reviewUpdates: "rewrite" });
		expect(PR_PRESETS.atomic.policy).toMatchObject({ initialShape: "atomic-multi", reviewUpdates: "rewrite" });
		expect(PR_PRESETS["per-round"].policy).toMatchObject({ reviewUpdates: "per-round", publishedSha: "prohibit-rewrite" });
		expect(policyFor({ preset: "atomic" })).toEqual(PR_PRESETS.atomic.policy);
		expect(policyFor({ preset: "single" }, { bookmark: "b", base: "m", changes: [], tipChange: "c", policy: { publishedSha: "prohibit-rewrite" }, updatedAt: "" }).publishedSha).toBe("prohibit-rewrite");
	});
});

describe.skipIf(!hasJj)("mapping", () => {
	test("groups are explicit: missing --changes refuses with candidates", async () => {
		const { host, repo, restorePath } = await setupPub();
		try {
			const refused = (await host.command("jj-pr", "map feat --base main", repo)).join("\n");
			expect(refused).toContain("explicit group");
			expect(refused).toContain("never inferred");
			const status = (await host.command("jj-pr", "status", repo)).join("\n");
			expect(status).toContain("none yet");
		} finally {
			restorePath();
		}
	});

	test("explicit mapping persists shared-repo-scoped across workspaces", async () => {
		const { host, repo, restorePath, featChange } = await setupPub();
		try {
			await host.command("jj-pr", `map feat --base main --changes ${featChange}`, repo);
			const status = (await host.command("jj-pr", "status", repo)).join("\n");
			expect(status).toContain("feat → main");
			expect(status).toContain("1 change(s)");

			const storeDir = resolveStorePath(repo) as string;
			expect(loadStore(storeDir).data.mappings.map((m) => m.bookmark)).toContain("feat");

			const parent = await makeDir("omp-jj-ws-parent-");
			const secondary = join(parent, "ws");
			await jj(repo, ["workspace", "add", secondary]);
			clearWorkspaceCache();
			const other = resolveStorePath(secondary) as string;
			expect(other).toBe(storeDir);
			expect(loadStore(other).data.mappings.map((m) => m.bookmark)).toContain("feat");
		} finally {
			restorePath();
		}
	});

	test("empty scratch tips are refused at preview", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await jj(repo, ["bookmark", "create", "tip"]);
		const atChange = await changeOf(repo, "@");
		const mapped = await host.command("jj-pr", `map tip --base @- --changes ${atChange}`, repo);
		expect(mapped.join("\n")).toContain("Preview with");
		const preview = (await host.command("jj-pr", "preview tip", repo)).join("\n");
		expect(preview).toContain("empty scratch");
	});

	test("unmap removes mappings without touching history", async () => {
		const { host, repo, restorePath, featChange } = await setupPub();
		try {
			await host.command("jj-pr", `map feat --base main --changes ${featChange}`, repo);
			expect((await host.command("jj-pr", "unmap feat", repo)).join("\n")).toContain("Removed mapping");
			expect((await host.command("jj-pr", "status", repo)).join("\n")).toContain("none yet");
			expect((await host.command("jj-pr", "unmap feat", repo)).join("\n")).toContain("No mapping");
		} finally {
			restorePath();
		}
	});

	test("policy shows and sets presets, rejecting unknown names", async () => {
		const { host, repo, restorePath } = await setupPub();
		try {
			expect((await host.command("jj-pr", "policy", repo)).join("\n")).toContain("atomic");
			expect((await host.command("jj-pr", "policy per-round", repo)).join("\n")).toContain("per-round");
			expect((await host.command("jj-pr", "policy bogus", repo)).join("\n")).toContain("Unknown preset");
		} finally {
			restorePath();
		}
	});

	test("publish without --apply previews instead of pushing", async () => {
		const { host, repo, remote, gh, restorePath, featChange } = await setupPub();
		try {
			await host.command("jj-pr", `map feat --base main --changes ${featChange}`, repo);
			const note = (await host.command("jj-pr", "publish feat", repo)).join("\n");
			expect(note).toContain("not publication");
			expect(await bareBranches(remote)).toEqual([]);
			expect(await ghCalls(gh)).not.toContain("pr create");
		} finally {
			restorePath();
		}
	});
});

describe.skipIf(!hasJj)("publication", () => {
	test("preview never publishes: remote and gh untouched", async () => {
		const { host, repo, remote, gh, restorePath, featChange } = await setupPub();
		try {
			await host.command("jj-pr", `map feat --base main --changes ${featChange}`, repo);
			const preview = (await host.command("jj-pr", "preview feat", repo)).join("\n");
			expect(preview).toContain("PR preview: feat → main");
			expect(preview).toContain("Group (1 change(s)");
			expect(preview).toContain("--confirm");

			expect(await bareBranches(remote)).toEqual([]);
			expect(await ghCalls(gh)).not.toContain("pr create");
		} finally {
			restorePath();
		}
	});

	test("publish pushes narrow refs, records the PR, and verifies", async () => {
		const { host, repo, remote, gh, restorePath, featChange } = await setupPub();
		try {
			await host.command("jj-pr", `map feat --base main --changes ${featChange}`, repo);
			const preview = (await host.command("jj-pr", "preview feat", repo)).join("\n");
			const token = /--confirm ([0-9a-f]+)/.exec(preview)?.[1] as string;
			expect(token).toBeTruthy();

			const published = (await host.command("jj-pr", `publish feat --apply --confirm ${token}`, repo)).join("\n");
			expect(published).toContain("Pushed feat");
			expect(published).toContain("https://example.com/o/r/pull/8");
			expect(await bareBranches(remote)).toContain("feat");
			expect(await ghCalls(gh)).toContain("pr create");

			const status = (await host.command("jj-pr", "status", repo)).join("\n");
			expect(status).toContain("PR #8");
		} finally {
			restorePath();
		}
	});

	test("drifted confirm tokens stop publication without pushing", async () => {
		const { host, repo, remote, restorePath, featChange } = await setupPub();
		try {
			await host.command("jj-pr", `map feat --base main --changes ${featChange}`, repo);
			const preview = (await host.command("jj-pr", "preview feat", repo)).join("\n");
			const token = /--confirm ([0-9a-f]+)/.exec(preview)?.[1] as string;

			await jj(repo, ["describe", "-m", "concurrent drift"]);
			const refused = (await host.command("jj-pr", `publish feat --apply --confirm ${token}`, repo)).join("\n");
			expect(refused).toContain("changed since the preview");
			expect(await bareBranches(remote)).toEqual([]);
		} finally {
			restorePath();
		}
	});

	test("strict no-rewrite policy stops published publication", async () => {
		const { host, repo, remote, restorePath, featChange } = await setupPub();
		try {
			await host.command("jj-pr", `map feat --base main --changes ${featChange}`, repo);
			await jj(repo, ["git", "push", "--bookmark", "feat"]);
			expect(await bareBranches(remote)).toContain("feat");
			await host.command("jj-pr", "policy per-round", repo);

			const preview = (await host.command("jj-pr", "preview feat", repo)).join("\n");
			expect(preview).toContain("strict no-rewrite");
		} finally {
			restorePath();
		}
	});

	test("existing PRs verify metadata without creating", async () => {
		const { host, repo, gh, restorePath, featChange } = await setupPub();
		try {
			await Bun.write(join(gh.dir, "pr-exists"), "1\n");
			await host.command("jj-pr", `map feat --base main --changes ${featChange} --pr 7`, repo);
			const preview = (await host.command("jj-pr", "preview feat", repo)).join("\n");
			const token = /--confirm ([0-9a-f]+)/.exec(preview)?.[1] as string;
			const published = (await host.command("jj-pr", `publish feat --apply --confirm ${token}`, repo)).join("\n");
			expect(published).toContain("pull/7");
			expect(await ghCalls(gh)).not.toContain("pr create");
		} finally {
			restorePath();
		}
	});

	test("gh failure still pushes refs and reports honestly", async () => {
		const { host, repo, remote, gh, restorePath, featChange } = await setupPub();
		try {
			await Bun.write(join(gh.dir, "create-fails"), "1\n");
			await host.command("jj-pr", `map feat --base main --changes ${featChange}`, repo);
			const preview = (await host.command("jj-pr", "preview feat", repo)).join("\n");
			const token = /--confirm ([0-9a-f]+)/.exec(preview)?.[1] as string;
			const published = (await host.command("jj-pr", `publish feat --apply --confirm ${token}`, repo)).join("\n");
			expect(published).toContain("Incomplete");
			expect(await bareBranches(remote)).toContain("feat");
		} finally {
			restorePath();
		}
	});

	test("squash-replaced changes mark the mapping stale", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await Bun.write(join(repo, "one.txt"), "1\n");
		await jj(repo, ["describe", "-m", "one"]);
		const c1 = await changeOf(repo, "@");
		await jj(repo, ["new"]);
		await Bun.write(join(repo, "two.txt"), "2\n");
		await jj(repo, ["describe", "-m", "two"]);
		const c2 = await changeOf(repo, "@");
		await jj(repo, ["bookmark", "create", "duo", "-r", "@"]);

		await host.command("jj-pr", `map duo --base ${c1}- --changes ${c1},${c2}`, repo);
		await jj(repo, ["squash", "--from", c2, "--into", c1]);
		const status = (await host.command("jj-pr", "status", repo)).join("\n");
		expect(status).toContain("STALE");
		const preview = (await host.command("jj-pr", "preview duo", repo)).join("\n");
		expect(preview).toContain("no longer resolve");
	}, 15_000);
});

