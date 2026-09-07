/**
 * Guardrails: repo-aware pre-execution hooks over model-driven shell commands. Block verdicts
 * redirect with explanations; ordinary Git repositories and undeterminable commands pass
 * through untouched.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runJj } from "../src/recovery.ts";
import { clearWorkspaceCache } from "../src/workspace.ts";
import {
	cleanupScratch,
	hasJj,
	makeBareRemote,
	makeDir,
	makeRepo,
	startExtension,
} from "./harness.ts";
import { loadStore, saveStore } from "../src/pr.ts";
import { resolveStorePath } from "../src/repo.ts";

let callSeq = 4000;
function nextId(): string {
	callSeq += 1;
	return `guard-call-${callSeq}`;
}

interface Verdict {
	block?: boolean;
	reason?: string;
}

async function guard(
	host: ReturnType<typeof startExtension>,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<Verdict | undefined> {
	const result = (await host.guard({ toolCallId: nextId(), toolName, input }, cwd)) as Verdict | undefined;
	return result ?? undefined;
}

async function bash(host: ReturnType<typeof startExtension>, command: string, cwd: string): Promise<Verdict | undefined> {
	return guard(host, "bash", { command }, cwd);
}

async function changeOf(root: string, rev: string): Promise<string> {
	const result = await runJj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", rev, "-T", "change_id"], { timeoutMs: 10_000 });
	if (result.code !== 0) throw new Error(`change lookup failed: ${result.err}`);
	return result.out.trim();
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe.skipIf(!hasJj)("git habits in JJ roots", () => {
	test("staged-index mutations are blocked with a JJ redirect", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		for (const command of ["git add .", "git commit -m x", "git stash", "git push origin main", "git checkout -b feat", "git switch main"]) {
			const verdict = await bash(host, command, repo);
			expect(verdict?.block).toBe(true);
			expect(verdict?.reason ?? "").toContain("JJ-managed workspace");
		}
	});

	test("quoted mentions and read-only git pass through", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		expect(await bash(host, 'echo "git commit"', repo)).toBeUndefined();
		for (const command of ["git status", "git log --oneline", "git diff", "git show HEAD", "git branch", "git fetch origin"]) {
			expect(await bash(host, command, repo)).toBeUndefined();
		}
	});

	test("composed commands are checked per segment", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		const verdict = await bash(host, "cd sub && git stash push -m wip", repo);
		expect(verdict?.block).toBe(true);
		expect(await bash(host, "git status && echo done", repo)).toBeUndefined();
	});

	test("-C/--repository flags scope the check to the named repo", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const plain = await makeDir();
		await host.emit("session_start", {}, plain);

		expect((await bash(host, `git -C ${repo} add .`, plain))?.block).toBe(true);
		expect((await bash(host, `jj -R ${repo} st`, plain))).toBeUndefined();
	});

	test("ordinary Git repositories are never touched", async () => {
		const host = startExtension();
		const git = await makeDir("plain-git-");
		const proc = Bun.spawn(["git", "init", "-q", git], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		clearWorkspaceCache();
		await host.emit("session_start", {}, git);

		for (const command of ["git add .", "git commit -m x", "git stash", "git checkout -b feat", "gh pr create --title t"]) {
			expect(await bash(host, command, git)).toBeUndefined();
		}
	});
});

describe.skipIf(!hasJj)("gh and stack tools", () => {
	test("implicit branch assumptions are blocked with bookmark guidance", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		for (const command of ["gh pr create --title t --body b", "gh pr checkout 12", "gh pr merge 12"]) {
			const verdict = await bash(host, command, repo);
			expect(verdict?.block).toBe(true);
		}
		expect(await bash(host, "gh pr view 12", repo)).toBeUndefined();
		expect(await bash(host, "gh pr checkout 12", await makeDir())).toBeUndefined();
	});

	test("git-based stack tools are redirected", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		for (const command of ["gh-stack submit", "git-town sync", "gt ss"]) {
			const verdict = await bash(host, command, repo);
			expect(verdict?.block).toBe(true);
			expect(verdict?.reason ?? "").toContain("/jj-stack");
		}
	});
});

describe.skipIf(!hasJj)("jj history operations", () => {
	test("clean absorb and reads are allowed", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await Bun.write(join(repo, "a.txt"), "a\n");
		await host.emit("session_start", {}, repo);

		expect(await bash(host, "jj absorb", repo)).toBeUndefined();
		expect(await bash(host, "jj st && jj log --limit 3", repo)).toBeUndefined();
		expect(await bash(host, "jj git push --bookmark nothing-here", repo)).toBeUndefined();
	});

	test("immutable targets are blocked with scope", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		const frozen = await runJj(repo, ["--ignore-working-copy", "log", "--no-graph", "-r", "immutable()", "-T", "commit_id ++ \"\\n\""], { timeoutMs: 10_000 });
		const target = frozen.out.trim().split("\n")[0] as string;
		expect(target).toBeTruthy();
		const verdict = await bash(host, `jj squash --from ${target} --into @`, repo);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason ?? "").toContain("immutable");
	});

	test("destructive restores redirect to session recovery", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		for (const command of ["jj undo", "jj op restore abc123", "jj op abandon abc123"]) {
			const verdict = await bash(host, command, repo);
			expect(verdict?.block).toBe(true);
			expect(verdict?.reason ?? "").toContain("/jj-recover");
		}
	});

	test("workspace and config surgery need explicit user action", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		for (const command of ["jj workspace add ../ws2", "jj config set ui.editor vim"]) {
			const verdict = await bash(host, command, repo);
			expect(verdict?.block).toBe(true);
		}
		expect(await bash(host, "jj workspace list", repo)).toBeUndefined();
	});

	test("master-off disables guardrails; snapshots-off does not", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		await host.command("jj", "off", repo);
		expect(await bash(host, "jj undo", repo)).toBeUndefined();

		await host.command("jj", "on", repo);
		await host.command("jj-snapshots", "off", repo);
		expect((await bash(host, "git add .", repo))?.block).toBe(true);
	});

	test("mapped bookmark deletion is redirected to unmap", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await Bun.write(join(repo, "f.txt"), "x\n");
		await host.emit("session_start", {}, repo);
		const change = await changeOf(repo, "@");
		await runJj(repo, ["bookmark", "create", "feat"], { timeoutMs: 10_000 });
		await host.command("jj-pr", `map feat --base @- --changes ${change}`, repo);

		const verdict = await bash(host, "jj bookmark delete feat", repo);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason ?? "").toContain("/jj-pr unmap");
		expect(await bash(host, "jj bookmark delete unrelated", repo)).toBeUndefined();
	});

	test("per-round policy blocks absorbing published rounds", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const remote = await makeBareRemote();
		await Bun.write(join(repo, "r.txt"), "r\n");
		await runJj(repo, ["describe", "-m", "round one"], { timeoutMs: 10_000 });
		await host.emit("session_start", {}, repo);
		const change = await changeOf(repo, "@");
		await runJj(repo, ["bookmark", "create", "feat"], { timeoutMs: 10_000 });
		await host.command("jj-pr", `map feat --base @- --changes ${change}`, repo);
		await runJj(repo, ["git", "remote", "add", "origin", remote], { timeoutMs: 10_000 });
		await runJj(repo, ["git", "push", "--bookmark", "feat"], { timeoutMs: 30_000 });
		// Hand-written store override: per-round updates without a published-SHA ban.
		const storeDir = resolveStorePath(repo) as string;
		const stored = loadStore(storeDir).data;
		saveStore(storeDir, {
			...stored,
			mappings: stored.mappings.map((m) => ({
				...m,
				policy: { reviewUpdates: "per-round", publishedSha: "permit-restack" },
			})),
		});

		const verdict = await bash(host, "jj absorb", repo);
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason ?? "").toContain("one-commit-per-round");
	});

	test("unresolvable scopes and remote sync verbs behave", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		expect(await bash(host, "jj squash --from '!!!'", repo)).toBeUndefined();
		expect((await bash(host, "jj git fetch", repo))?.block).toBe(true);
		expect(await bash(host, "jj backout -r @", repo)).toBeUndefined();
	});

	test("blocked tools take no checkpoint", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await Bun.write(join(repo, "blocked.txt"), "b\n");
		await host.emit("session_start", {}, repo);

		await host.toolCall({ toolCallId: nextId(), toolName: "bash", input: { command: "git add ." } }, repo);
		expect(host.snapshotReasons()).toEqual(["session_start"]);
	});
});
