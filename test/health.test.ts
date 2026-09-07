/**
 * Health inspection: read-only findings across classifications, snapshot gaps, hooks, and
 * unsupported Git features. The op log proves inspection never mutates.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkHealth, classifyDir, formatReport } from "../src/health.ts";
import { runJj } from "../src/recovery.ts";
import { clearWorkspaceCache } from "../src/workspace.ts";
import { cleanupScratch, hasJj, makeDir, makeRepo, opCount, startExtension } from "./harness.ts";

async function jj(root: string, args: string[]): Promise<void> {
	const result = await runJj(root, args, { timeoutMs: 30_000 });
	if (result.code !== 0) throw new Error(`jj ${args.join(" ")} failed: ${result.err}`);
}

async function makePlainGit(): Promise<string> {
	const git = Bun.which("git") as string;
	const dir = await makeDir("omp-jj-plain-");
	const proc = Bun.spawn([git, "init", "-q", dir], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	if ((await proc.exited) !== 0) throw new Error("git init failed");
	clearWorkspaceCache();
	return dir;
}

function areasOf(text: string): string[] {
	return text.split("\n").map((line) => /\[(\w+)\] (\S+):/.exec(line)?.[2] ?? "").filter(Boolean);
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe("classifyDir", () => {
	test("distinguishes workspaces, plain git, and plain dirs without jj", async () => {
		const repo = await makeRepo();
		expect(classifyDir(repo)).toBe("colocated");
		expect(classifyDir(await makePlainGit())).toBe("plain-git");
		expect(classifyDir(await makeDir())).toBe("non-repo");
	});
});

describe.skipIf(!hasJj)("health inspection", () => {
	test("covers the expected areas and mutates nothing", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await Bun.write(join(repo, "health.txt"), "h\n");
		await host.emit("session_start", {}, repo);

		const before = await opCount(repo);
		const notified = await host.command("jj-health", "", repo);
		const text = notified.join("\n");
		expect(await opCount(repo)).toBe(before);

		expect(text).toContain("JJ health:");
		const areas = areasOf(text);
		for (const expected of ["jj", "target", "identity", "remotes", "working-copy", "ownership-baseline", "conflicts", "snapshots"]) {
			expect(areas).toContain(expected);
		}
	});

	test("plain-git and non-repo targets stay informational", async () => {
		const host = startExtension();
		const git = await makePlainGit();
		const gitText = (await host.command("jj-health", "", git)).join("\n");
		expect(gitText).toContain("plain-git");
		expect(gitText).toContain("Git workflows apply unchanged");

		const plain = await makeDir();
		const plainText = (await host.command("jj-health", "", plain)).join("\n");
		expect(plainText).toContain("non-repo");
	});

	test("partial checkpoints surface as snapshot coverage warnings", async () => {
		const repo = await makeRepo();
		const report = await checkHealth(repo, {
			checkpoints: [
				{
					v: 1, requestId: "req-1", boundary: "pre", root: repo, workspace: "w", storeKey: "1:2",
					status: "partial", message: "skipped huge.bin (over size limit)", at: new Date().toISOString(),
				},
			],
		});
		const snapshots = report.findings.filter((f) => f.area === "snapshots");
		expect(snapshots.some((f) => f.level === "warn" && f.summary.includes("huge.bin"))).toBe(true);
	});

	test("executable hooks, LFS, and submodules are reported, never acted on", async () => {
		const repo = await makeRepo();
		const hook = join(repo, ".git", "hooks", "pre-commit");
		await Bun.write(hook, "#!/bin/sh\nexit 0\n");
		await chmod(hook, 0o755);
		await Bun.write(join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs\n");
		await Bun.write(join(repo, ".gitmodules"), '[submodule "dep"]\n\tpath = dep\n');

		const report = await checkHealth(repo);
		const byArea = new Map(report.findings.map((f) => [f.area, f]));
		expect(byArea.get("git-hooks")?.level).toBe("warn");
		expect(byArea.get("git-hooks")?.summary).toContain("pre-commit");
		expect(byArea.get("lfs")?.level).toBe("warn");
		expect(byArea.get("submodules")?.level).toBe("warn");
		expect(formatReport(report)).toContain("never invokes");
	});

	test("missing workspaces fail loudly", async () => {
		const repo = await makeRepo();
		const parent = await makeDir("omp-jj-ws-parent-");
		const secondary = join(parent, "ws");
		await jj(repo, ["workspace", "add", secondary]);
		await rm(secondary, { recursive: true, force: true });

		const report = await checkHealth(repo);
		const ws = report.findings.find((f) => f.area === "workspaces");
		expect(ws && ws.level !== "ok").toBe(true);
	});
});
