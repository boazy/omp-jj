/**
 * Session-linked recovery: checkpoint records group tool boundaries per user request, and the
 * `jj-recover` command restores file contents or whole-repository state with previews,
 * pre-restore safety nets, and honest missing-state handling. `jj op log` is the oracle.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { canonicalize } from "../src/repo.ts";
import { CHECKPOINT_CUSTOM_TYPE, readCheckpointEntries } from "../src/recovery.ts";
import { clearWorkspaceCache } from "../src/workspace.ts";
import {
	cleanupScratch,
	hasJj,
	makeDir,
	makeRepo,
	opCount,
	startExtension,
} from "./harness.ts";

let callSeq = 3000;
function nextId(): string {
	callSeq += 1;
	return `recover-call-${callSeq}`;
}

/** Index (#N) of the first list line whose boundary tag matches, e.g. "/pre]". */
function findIndex(listText: string, boundary: string): number {
	for (const line of listText.split("\n")) {
		const match = new RegExp(`^\\s*#(\\d+) \\[[^\\]]*/${boundary}\\]`).exec(line);
		if (match) return Number(match[1]);
	}
	throw new Error(`no ${boundary} checkpoint in:\n${listText}`);
}

function opOf(listText: string, index: number): string {
	const line = listText.split("\n").find((l) => l.trimStart().startsWith(`#${index} `));
	const match = /op:([0-9a-f]+)/.exec(line ?? "");
	if (!match) throw new Error(`no op id on line for #${index}:\n${listText}`);
	return match[1] as string;
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe("checkpoint entries", () => {
	test("only well-formed omp-jj-checkpoint entries rebuild the index", () => {
		const entries = [
			{ type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: { v: 1, boundary: "nope", root: "/r", workspace: "w", storeKey: "1:2", status: "ok", at: "t" } },
			{ type: "custom", customType: "other", data: { v: 1 } },
			{
				type: "custom",
				customType: CHECKPOINT_CUSTOM_TYPE,
				data: { v: 1, requestId: "req-1", boundary: "pre", root: "/r", workspace: "w", storeKey: "1:2", status: "ok", at: "t" },
			},
		];
		expect(readCheckpointEntries(entries)).toHaveLength(1);
		expect(readCheckpointEntries([])).toEqual([]);
	});
});

describe.skipIf(!hasJj)("file restore", () => {
	test("restores pre-tool contents and keeps the pre-restore state recoverable", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const file = join(repo, "story.txt");
		await Bun.write(file, "v1 the state before the tool\n");
		await host.emit("session_start", {}, repo);
		await host.prompt(repo);

		const call = { toolCallId: nextId(), toolName: "write", input: { path: file } };
		await host.toolCall(call, repo);
		await Bun.write(file, "v2 clobbered by the tool\n");
		await host.toolResult(call, repo);

		const list = (await host.command("jj-recover", "list", repo)).join("\n");
		const pre = findIndex(list, "pre");

		const preview = (await host.command("jj-recover", `files ${pre}`, repo)).join("\n");
		expect(preview).toContain("Will restore");
		expect(preview).toContain("Bookmarks and heads are untouched");
		expect(preview).toContain("--apply");

		const applied = (await host.command("jj-recover", `files ${pre} --apply`, repo)).join("\n");
		expect(applied).toContain("Restored");
		expect(await Bun.file(file).text()).toBe("v1 the state before the tool\n");

		const after = (await host.command("jj-recover", "list", repo)).join("\n");
		expect(after).toContain("/pre-restore]");
		const shelter = findIndex(after, "pre-restore");

		// The pre-restore checkpoint brings back the clobbered version: recoverability round-trips.
		await host.command("jj-recover", `files ${shelter} --apply`, repo);
		expect(await Bun.file(file).text()).toBe("v2 clobbered by the tool\n");
	});

	test("selected paths restore only those files", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const a = join(repo, "a.txt");
		const b = join(repo, "b.txt");
		await Bun.write(a, "a1\n");
		await Bun.write(b, "b1\n");
		await host.emit("session_start", {}, repo);
		await host.prompt(repo);

		const call = { toolCallId: nextId(), toolName: "write", input: { path: a } };
		await host.toolCall(call, repo);
		await Bun.write(a, "a2\n");
		await Bun.write(b, "b2\n");
		await host.toolResult(call, repo);

		const list = (await host.command("jj-recover", "list", repo)).join("\n");
		const pre = findIndex(list, "pre");
		await host.command("jj-recover", `files ${pre} --apply -- ${a}`, repo);
		expect(await Bun.file(a).text()).toBe("a1\n");
		expect(await Bun.file(b).text()).toBe("b2\n");
	});

	test("the picker selects a checkpoint when no index is given", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const file = join(repo, "picked.txt");
		await Bun.write(file, "before\n");
		await host.emit("session_start", {}, repo);
		await host.prompt(repo);

		const call = { toolCallId: nextId(), toolName: "write", input: { path: file } };
		await host.toolCall(call, repo);
		await Bun.write(file, "after\n");
		await host.toolResult(call, repo);

		const list = (await host.command("jj-recover", "list", repo)).join("\n");
		const pre = findIndex(list, "pre");
		host.pick(pre - 1);
		const preview = (await host.command("jj-recover", "files", repo)).join("\n");
		expect(preview).toContain(`Checkpoint #${pre}`);
		expect(preview).toContain("Will restore");
	});
});

describe.skipIf(!hasJj)("whole-repository restore", () => {
	test("preview shows impact and apply requires the confirm token", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const file = join(repo, "state.txt");
		await Bun.write(file, "v1\n");
		await host.emit("session_start", {}, repo);
		await host.prompt(repo);

		const call = { toolCallId: nextId(), toolName: "write", input: { path: file } };
		await host.toolCall(call, repo);
		await Bun.write(file, "v2\n");
		await host.toolResult(call, repo);

		const list = (await host.command("jj-recover", "list", repo)).join("\n");
		const pre = findIndex(list, "pre");
		const token = /--confirm ([0-9a-f]+)/.exec(
			(await host.command("jj-recover", `state ${pre}`, repo)).join("\n"),
		)?.[1];
		expect(token).toBe(opOf(list, pre).slice(0, 12));

		const preview = (await host.command("jj-recover", `state ${pre}`, repo)).join("\n");
		expect(preview).toContain("Impact");
		expect(preview).toContain("WARNING");
		expect(preview).toContain("Other sessions");
		expect(preview).toContain("never contacts remotes");

		// No token, no restore.
		const before = await opCount(repo);
		const refused = (await host.command("jj-recover", `state ${pre} --apply`, repo)).join("\n");
		expect(refused).toContain("Nothing was changed");
		expect(await Bun.file(file).text()).toBe("v2\n");
		expect(await opCount(repo)).toBe(before);

		const applied = (
			await host.command("jj-recover", `state ${pre} --apply --confirm ${token}`, repo)
		).join("\n");
		expect(applied).toContain("Restored");
		expect(await Bun.file(file).text()).toBe("v1\n");
	});
});

describe.skipIf(!hasJj)("missing and stale state", () => {
	test("unknown operations and commits are reported, never replaced", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const file = join(repo, "steady.txt");
		await Bun.write(file, "steady\n");
		await host.emit("session_start", {}, repo);

		host.setEntries([
			...host.entries(),
			{
				type: "custom",
				customType: CHECKPOINT_CUSTOM_TYPE,
				data: {
					v: 1,
					requestId: null,
					boundary: "pre",
					tool: "write",
					root: canonicalize(repo),
					workspace: "ghost",
					storeKey: "0:0",
					opId: "deadbeef",
					commitId: "deadbeef",
					status: "ok",
					at: new Date().toISOString(),
				},
			},
		]);
		// Rebuild the index without snapshotting: navigation must not restore or record.
		await host.emit("session_switch", {}, repo);

		const list = (await host.command("jj-recover", "list", repo)).join("\n");
		const ghost = list.split("\n").filter((line) => /^\s*#\d+ /.test(line)).length;
		const filesMsg = (await host.command("jj-recover", `files ${ghost}`, repo)).join("\n");
		expect(filesMsg).toContain("no longer available");
		expect(filesMsg).toContain("never replaced");
		const stateMsg = (await host.command("jj-recover", `state ${ghost} --apply --confirm deadbeef`, repo)).join(
			"\n",
		);
		expect(stateMsg).toContain("no longer available");
		expect(await Bun.file(file).text()).toBe("steady\n");
	});
});

describe.skipIf(!hasJj)("navigation and read-only requests", () => {
	test("session events never restore files or record checkpoints", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const file = join(repo, "nav.txt");
		await Bun.write(file, "navigated-away\n");
		await host.emit("session_start", {}, repo);
		const settled = await opCount(repo);

		await Bun.write(file, "changed elsewhere\n");
		await host.emit("session_switch", {}, repo);
		await host.emit("session_branch", {}, repo);
		await host.emit("session_tree", {}, repo);

		expect(await Bun.file(file).text()).toBe("changed elsewhere\n");
		expect(await opCount(repo)).toBe(settled);
	});

	test("read-only prompts leave no checkpoints", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);
		await host.prompt(repo);
		await host.prompt(repo);
		const list = (await host.command("jj-recover", "list", repo)).join("\n");
		expect(list).toContain("JJ recovery points (1):");
	});
});

describe.skipIf(!hasJj)("unchanged sharing", () => {
	test("repeated captures share one operation and manufacture no history", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await Bun.write(join(repo, "same.txt"), "same\n");
		await host.emit("session_start", {}, repo);
		await host.prompt(repo);
		const before = await opCount(repo);

		const first = { toolCallId: nextId(), toolName: "write", input: { path: join(repo, "same.txt") } };
		await host.toolCall(first, repo);
		const second = { toolCallId: nextId(), toolName: "edit", input: { paths: [join(repo, "same.txt")] } };
		await host.toolCall(second, repo);

		// Nothing changed, so neither pre-boundary records a new operation.
		expect(await opCount(repo)).toBe(before);
		const list = (await host.command("jj-recover", "list", repo)).join("\n");
		const ids = list
			.split("\n")
			.map((line) => /op:([0-9a-f]+)/.exec(line)?.[1])
			.filter(Boolean);
		expect(ids.length).toBeGreaterThanOrEqual(3);
		expect(new Set(ids).size).toBe(1);

		const jj = Bun.which("jj") as string;
		const proc = Bun.spawn([jj, "bookmark", "list"], {
			cwd: repo,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		expect(code).toBe(0);
		expect(out.trim()).toBe("");
	});
});

describe.skipIf(!hasJj)("resume reconstruction", () => {
	test("a resumed session rebuilds its checkpoints from persisted entries", async () => {
		const first = startExtension({ sessionId: "resume-1" });
		const repo = await makeRepo();
		const file = join(repo, "resume.txt");
		await Bun.write(file, "r1\n");
		await first.emit("session_start", {}, repo);
		await first.prompt(repo);
		const call = { toolCallId: nextId(), toolName: "write", input: { path: file } };
		await first.toolCall(call, repo);
		await Bun.write(file, "r2\n");
		await first.toolResult(call, repo);
		const before = (await first.command("jj-recover", "list", repo)).join("\n");
		expect(before).toContain("/pre]");

		// A new host on the same session file sees the same records, from an unrelated cwd.
		const plain = await makeDir();
		const second = startExtension({ sessionId: "resume-1" });
		second.setEntries(first.entries());
		await second.emit("session_start", {}, plain);
		const after = (await second.command("jj-recover", "list", plain)).join("\n");
		expect(after).toBe(before);
	});
});

describe.skipIf(!hasJj)("suspension gating", () => {
	test("disabled snapshots suspend restores but keep records for re-enablement", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const file = join(repo, "gated.txt");
		await Bun.write(file, "g1\n");
		await host.emit("session_start", {}, repo);
		await host.prompt(repo);
		const call = { toolCallId: nextId(), toolName: "write", input: { path: file } };
		await host.toolCall(call, repo);
		await Bun.write(file, "g2\n");
		await host.toolResult(call, repo);

		const list = (await host.command("jj-recover", "list", repo)).join("\n");
		const pre = findIndex(list, "pre");

		expect(await host.command("jj-snapshots", "off", repo)).toEqual(["JJ snapshots: off"]);
		const before = await opCount(repo);
		const refused = (await host.command("jj-recover", `files ${pre} --apply`, repo)).join("\n");
		expect(refused).toContain("suspended");
		expect(await Bun.file(file).text()).toBe("g2\n");
		expect(await opCount(repo)).toBe(before);

		const listed = (await host.command("jj-recover", "list", repo)).join("\n");
		expect(listed).toContain(`#${pre} `);
		expect(listed).toContain("suspended");

		expect(await host.command("jj-snapshots", "on", repo)).toEqual(["JJ snapshots: on"]);
		await host.command("jj-recover", `files ${pre} --apply`, repo);
		expect(await Bun.file(file).text()).toBe("g1\n");
	});
});
