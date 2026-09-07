/**
 * Repository identity and instruction delivery: nested-repo resolution, colocated detection,
 * shared-repo keys, non-JJ inactivity, mixed JJ+Git sessions, and snapshot-free reads.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clearWorkspaceCache } from "../src/workspace.ts";
import { canonicalize, describeWorkspace, resolveRepoTargets } from "../src/repo.ts";
import {
	cleanupScratch,
	hasJj,
	makeColocatedRepo,
	makeDir,
	makeRepo,
	opCount,
	startExtension,
	touchFile,
} from "./harness.ts";

const JJ = Bun.which("jj");

async function jj(root: string, args: string[]): Promise<void> {
	const proc = Bun.spawn([JJ as string, ...args], {
		cwd: root,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	if ((await proc.exited) !== 0) throw new Error(`jj ${args.join(" ")} failed in ${root}`);
}

let callSeq = 2000;
function nextId(): string {
	callSeq += 1;
	return `repo-call-${callSeq}`;
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe.skipIf(!hasJj)("nested repositories", () => {
	test("inner and outer workspaces resolve independently", async () => {
		const outer = await makeRepo();
		const inner = join(outer, "nested");
		await mkdir(inner, { recursive: true });
		// A real nested repo, not just a stray .jj directory.
		await jj(inner, ["git", "init", "--quiet"]);
		clearWorkspaceCache();

		const targets = resolveRepoTargets({ cwd: outer, paths: [join(inner, "f.txt"), join(outer, "g.txt")] });
		// Roots canonicalize (macOS /tmp is a symlink), so compare against canonical paths.
		expect(targets.repos.map((r) => r.root).sort()).toEqual(
			[canonicalize(inner), canonicalize(outer)].sort(),
		);
		expect(targets.nonJj).toEqual([]);
	});
	test("writes to the inner repo do not snapshot the outer repo and vice versa", async () => {
		const host = startExtension();
		const outer = await makeRepo();
		const inner = join(outer, "nested");
		await mkdir(inner, { recursive: true });
		await jj(inner, ["git", "init", "--quiet"]);
		clearWorkspaceCache();

		await touchFile(inner, "dirty.txt");
		await touchFile(outer, "dirty.txt");
		const beforeInner = await opCount(inner);
		const beforeOuter = await opCount(outer);

		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(inner, "new.txt") } },
			outer,
		);
		expect(await opCount(inner)).toBe(beforeInner + 1);
		expect(await opCount(outer)).toBe(beforeOuter);

		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(outer, "new.txt") } },
			outer,
		);
		expect(await opCount(outer)).toBe(beforeOuter + 1);
		expect(await opCount(inner)).toBe(beforeInner + 1);
	});
});

describe.skipIf(!hasJj)("colocated repositories", () => {
	test("a colocated root is JJ-owned and snapshots normally", async () => {
		const host = startExtension();
		const repo = await makeColocatedRepo();
		clearWorkspaceCache();

		const identity = describeWorkspace(repo);
		expect(identity?.colocated).toBe(true);

		await touchFile(repo, "dirty.txt");
		const before = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(repo, "new.txt") } },
			repo,
		);
		expect(await opCount(repo)).toBe(before + 1);
	});

	test("prompt context names colocation instead of deferring to git", async () => {
		const host = startExtension();
		const repo = await makeColocatedRepo();
		await host.emit("session_start", {}, repo);
		const result = (await host.prompt(repo)) as { systemPrompt?: string[] } | undefined;
		const text = (result?.systemPrompt ?? []).join("\n");
		expect(text).toContain("[JJ repository]");
		expect(text).toContain("colocated with Git");
	});
});

describe.skipIf(!hasJj)("shared-repo keys", () => {
	test("workspaces of one repo share a key; independent clones differ", async () => {
		const primary = await makeRepo();
		const parent = await makeDir("omp-jj-ws-parent-");
		const secondary = join(parent, "ws");
		await jj(primary, ["workspace", "add", secondary]);
		clearWorkspaceCache();

		const a = describeWorkspace(primary);
		const b = describeWorkspace(secondary);
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a?.root).not.toBe(b?.root);
		expect(b?.storeKey).toBe(a?.storeKey);

		const clone = await makeRepo();
		clearWorkspaceCache();
		expect(describeWorkspace(clone)?.storeKey).not.toBe(a?.storeKey);
	});
});

describe.skipIf(!hasJj)("non-JJ inactivity", () => {
	test("prompt context is absent outside any JJ workspace", async () => {
		const host = startExtension();
		const plain = await makeDir();
		await host.emit("session_start", {}, plain);
		expect(await host.prompt(plain)).toBeUndefined();
	});

	test("tool calls outside any workspace snapshot nothing and warn nothing", async () => {
		const host = startExtension();
		const plain = await makeDir();
		await host.emit("session_start", {}, plain);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(plain, "out.txt") } },
			plain,
		);
		expect(host.snapshotReasons()).toEqual([]);
		expect(host.warnings()).toEqual([]);
	});

	test("master-off produces no prompt context even inside a JJ repo", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);
		await host.command("jj", "off", repo);
		expect(await host.prompt(repo)).toBeUndefined();
	});
});

describe.skipIf(!hasJj)("mixed JJ and Git sessions", () => {
	test("Git-targeted writes leave the JJ repo alone; JJ-targeted writes snapshot it", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const gitDir = await makeDir("plain-git-");
		await touchFile(repo, "dirty.txt");
		await host.emit("session_start", {}, repo);

		const before = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(gitDir, "out.txt") } },
			repo,
		);
		expect(await opCount(repo)).toBe(before);

		// The session_start snapshot consumed the earlier dirt; a new change is needed for the
		// JJ-targeted write to record a new operation.
		await touchFile(repo, "jj-work.txt");
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(repo, "out.txt") } },
			repo,
		);
		expect(await opCount(repo)).toBe(before + 1);
	});
});

describe.skipIf(!hasJj)("instruction delivery", () => {
	test("prompt context is short, repo-scoped, and flags pre-existing work", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await touchFile(repo, "user-work.txt", "the user wrote this before the session");
		await host.emit("session_start", {}, repo);

		// Settle the session_start snapshot so the prompt reads recorded state only.
		const result = (await host.prompt(repo)) as { systemPrompt?: string[] } | undefined;
		const additions = (result?.systemPrompt ?? []).filter((s) => s.includes("[JJ repository]"));
		expect(additions).toHaveLength(1);
		expect(additions[0]).toContain(canonicalize(repo));
		expect(additions[0]).toContain("pre-existing work");
		expect(additions[0]).toContain("jj-pr");
		expect(additions[0].split("\n").length).toBeLessThan(20);
	});

	test("prompt redraws and autocomplete create no snapshots", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await touchFile(repo, "dirty.txt");
		await host.emit("session_start", {}, repo);

		const settled = await opCount(repo);
		// Repeated prompt renders ...
		await host.prompt(repo);
		await host.prompt(repo);
		// ... and both autocomplete paths (async suggestions + sync slash completion) ...
		const wrapped = host.wrapProvider({
			getSuggestions: async () => ({
				items: [
					{ value: "/jj", label: "/jj", description: "static" },
					{ value: "/other", label: "/other", description: "untouched" },
				],
				prefix: "/",
			}),
			trySyncSlashCompletion: (text: string) => ({
				items: [{ value: "/jj-snapshots", label: "/jj-snapshots", description: "static" }],
				prefix: text,
			}),
			applyCompletion: (...args: never[]) => args as never,
		});
		const suggestions = (await (
			wrapped.getSuggestions as (
				lines: string[],
				line: number,
				col: number,
			) => Promise<{ items: Array<{ value: string; description?: string }>; prefix: string }>
		)(["/j"], 0, 2)) as { items: Array<{ value: string; description?: string }>; prefix: string };
		expect(suggestions.items.find((i) => i.value === "/jj")?.description).toContain("JJ:");
		expect(suggestions.items.find((i) => i.value === "/other")?.description).toBe("untouched");
		const sync = (
			wrapped.trySyncSlashCompletion as (text: string) => {
				items: Array<{ value: string; description?: string }>;
				prefix: string;
			}
		)("/jj-s");
		expect(sync.items[0]?.description).toContain("JJ snapshots:");
		// ... must not snapshot.
		expect(await opCount(repo)).toBe(settled);
	});
});
