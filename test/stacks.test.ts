/**
 * Stacked PRs: chain verification, bottom-up publication, and merge-method-aware
 * restacking. Bare remotes plus the fake gh stand in for GitHub; restack scenarios run
 * entirely on isolated temp repos.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runJj } from "../src/recovery.ts";
import { clearWorkspaceCache } from "../src/workspace.ts";
import {
	bareBranches,
	cleanupScratch,
	hasJj,
	makeBareRemote,
	makeFakeGh,
	makeRepo,
	opIds,
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

async function commitOf(root: string, rev: string): Promise<string> {
	return jj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", rev, "-T", "commit_id"]);
}

/** Two-layer stack (base main, l1, l2) with a bare remote and fake gh on PATH. */
async function setupStack() {
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
		await Bun.write(join(repo, "l1.txt"), "layer one\n");
		await jj(repo, ["describe", "-m", "layer one"]);
		await jj(repo, ["bookmark", "create", "l1"]);
		const l1Change = await changeOf(repo, "l1");
		await jj(repo, ["new"]);
		await Bun.write(join(repo, "l2.txt"), "layer two\n");
		await jj(repo, ["describe", "-m", "layer two"]);
		await jj(repo, ["bookmark", "create", "l2"]);
		const l2Change = await changeOf(repo, "l2");
		await host.command("jj-pr", `map l1 --base main --changes ${l1Change}`, repo);
		await host.command("jj-pr", `map l2 --base l1 --changes ${l2Change}`, repo);
		return { host, repo, remote, gh, restorePath, l1Change, l2Change };
	} catch (error) {
		restorePath();
		throw error;
	}
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe.skipIf(!hasJj)("stack preview and publish", () => {
	test("chain breaks are reported, never assumed", async () => {
		const { host, repo, restorePath } = await setupStack();
		try {
			const preview = (await host.command("jj-stack", "preview l1 l2", repo)).join("\n");
			expect(preview).toContain("Stack preview (2 layer(s))");
			expect(preview).not.toContain("BLOCKED");

			const broken = (await host.command("jj-stack", "preview l2 l1", repo)).join("\n");
			expect(broken).toContain("BLOCKED");
			expect(broken).toContain("not stacked on");
		} finally {
			restorePath();
		}
	});

	test("unmapped layers and drifted tokens stop the flow", async () => {
		const { host, repo, remote, restorePath } = await setupStack();
		try {
			const missing = (await host.command("jj-stack", "preview l1 ghost", repo)).join("\n");
			expect(missing).toContain("BLOCKED");
			expect(missing).toContain("no PR mapping");

			const refused = (
				await host.command("jj-stack", "publish l1 l2 --apply --confirm deadbeefdead", repo)
			).join("\n");
			expect(refused).toContain("changed since the preview");
			expect(await bareBranches(remote)).toEqual([]);
		} finally {
			restorePath();
		}
	});

	test("bottom-up publish pushes every layer", async () => {
		const { host, repo, remote, restorePath } = await setupStack();
		try {
			const preview = (await host.command("jj-stack", "preview l1 l2", repo)).join("\n");
			const token = /--confirm ([0-9a-f]+)/.exec(
				(await host.command("jj-pr", "preview l1", repo)).join("\n"),
			)?.[1] as string;
			expect(preview).toContain("l1");
			const published = (
				await host.command("jj-stack", `publish l1 l2 --apply --confirm ${token}`, repo)
			).join("\n");
			expect(published).toContain("l1: published");
			expect(published).toContain("l2: published");
			expect(await bareBranches(remote)).toEqual(expect.arrayContaining(["l1", "l2"]));
		} finally {
			restorePath();
		}
	});

	test("missing confirm refuses stack publish with zero side effects", async () => {
		const { host, repo, remote, gh, restorePath } = await setupStack();
		try {
			const refused = (
				await host.command("jj-stack", "publish l1 l2 --apply", repo)
			).join("\n");
			expect(refused).toContain("--confirm");
			expect(refused).toContain("Nothing was pushed");
			expect(await bareBranches(remote)).toEqual([]);
			expect(await readFile(gh.log, "utf8").catch(() => "")).not.toContain("pr create");
		} finally {
			restorePath();
		}
	});

	test("strict policy stops stack publish with the tradeoff, pushing nothing", async () => {
		const { host, repo, remote, gh, restorePath } = await setupStack();
		try {
			// Publish markers first (direct push, not the command under test).
			await jj(repo, ["git", "push", "--bookmark", "l1"]);
			await jj(repo, ["git", "push", "--bookmark", "l2"]);
			// Clear the setup pushes so any command-driven push is observable.
			const git = Bun.which("git") as string;
			for (const branch of ["l1", "l2"]) {
				const wipe = Bun.spawn([git, "--git-dir", remote, "update-ref", "-d", `refs/heads/${branch}`], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				await wipe.exited;
			}
			expect(await bareBranches(remote)).toEqual([]);
			await host.command("jj-pr", "policy per-round", repo);

			// A blocked preview issues no token — and the stack gate stops a fresh,
			// drift-valid token with the same tradeoff before the first push.
			const preview = (await host.command("jj-pr", "preview l1", repo)).join("\n");
			expect(preview).toContain("strict no-rewrite");
			expect(preview).not.toContain("To publish");
			const fresh = (await opIds(repo))[0] as string;
			const stopped = (
				await host.command("jj-stack", `publish l1 l2 --apply --confirm ${fresh}`, repo)
			).join("\n");
			expect(stopped).toContain("strict no-rewrite");
			expect(stopped).toContain("Nothing was pushed");
			expect(await bareBranches(remote)).toEqual([]);
			expect(await readFile(gh.log, "utf8").catch(() => "")).not.toContain("pr create");
		} finally {
			restorePath();
		}
	});
});

describe.skipIf(!hasJj)("restacking", () => {
	test("squash-merge restack abandons superseded commits and preserves upper work", async () => {
		const { host, repo, restorePath, l1Change, l2Change } = await setupStack();
		try {
			// Simulate the squash merge landing on main: a new commit with l1's content.
			await jj(repo, ["new", "main"]);
			await Bun.write(join(repo, "l1.txt"), "layer one\n");
			await jj(repo, ["describe", "-m", "l1 squashed to main"]);
			const landedBase = await commitOf(repo, "@");

			const preview = (
				await host.command("jj-stack", `restack l1 --method squash --onto ${landedBase} --layers l1,l2`, repo)
			).join("\n");
			expect(preview).toContain("abandon");
			expect(preview).toContain("rebase");
			const token = /--confirm ([0-9a-f]+)/.exec(preview)?.[1] as string;

			const applied = (
				await host.command(
					"jj-stack",
					`restack l1 --method squash --onto ${landedBase} --layers l1,l2 --apply --confirm ${token}`,
					repo,
				)
			).join("\n");
			expect(applied).toContain("Restack applied");

			// Old lower-layer commits are gone; upper work survives on the new base.
			// (@ stays where it was — restack moves commits, not the working copy.)
			const l2content = await jj(repo, ["file", "show", "-r", "l2", "l2.txt"]);
			expect(l2content).toBe("layer two");
			const gone = await runJj(repo, ["--ignore-working-copy", "log", "--no-graph", "-r", l1Change, "-T", "commit_id"], { timeoutMs: 10_000 });
			expect(gone.code).not.toBe(0);
			const l2Tip = await changeOf(repo, "l2");
			expect(l2Tip).toBe(l2Change);
		} finally {
			restorePath();
		}
	});

	test("rebase-merge restack keeps landed commits and moves upper layers", async () => {
		const { host, repo, restorePath, l2Change } = await setupStack();
		try {
			// Simulate a fast-forward merge: main advances to the l1 tip.
			await jj(repo, ["bookmark", "set", "main", "-r", "l1"]);
			const landedBase = await commitOf(repo, "main");

			const preview = (
				await host.command("jj-stack", `restack l1 --method rebase --onto ${landedBase} --layers l1,l2`, repo)
			).join("\n");
			expect(preview).toContain("already under");
			expect(preview).toContain("abandon: none");

			const token = /--confirm ([0-9a-f]+)/.exec(preview)?.[1] as string;
			const applied = (
				await host.command(
					"jj-stack",
					`restack l1 --method rebase --onto ${landedBase} --layers l1,l2 --apply --confirm ${token}`,
					repo,
				)
			).join("\n");
			expect(applied).toContain("Restack applied");
			expect(await Bun.file(join(repo, "l2.txt")).text()).toBe("layer two\n");
			expect(await changeOf(repo, "l2")).toBe(l2Change);
		} finally {
			restorePath();
		}
	});

	test("strict policy stops restacks that would rewrite published layers", async () => {
		const { host, repo, restorePath } = await setupStack();
		try {
			await jj(repo, ["git", "push", "--bookmark", "l2"]);
			await host.command("jj-pr", "policy per-round", repo);
			const preview = (
				await host.command("jj-stack", "restack l1 --method squash --onto main --layers l1,l2", repo)
			).join("\n");
			expect(preview).toContain("strict no-rewrite");
		} finally {
			restorePath();
		}
	});
});
