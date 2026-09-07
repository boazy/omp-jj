/**
 * Harness tests: the real extension factory against real jj workspaces, driven through the same
 * handler sequence the agent loop uses. `jj op log` is the oracle — these assert that restore
 * points exist where they must, not that functions were called.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clearWorkspaceCache } from "../src/workspace.ts";
import {
	cleanupScratch,
	hasJj,
	makeDir,
	makeRepo,
	opCount,
	opIds,
	restoreOp,
	startExtension,
	type StubHost,
	touchFile,
} from "./harness.ts";

let callSeq = 0;
function nextId(): string {
	callSeq += 1;
	return `call-${callSeq}`;
}

/** Op deltas per workspace caused by one `tool_call`. */
async function deltaForToolCall(
	host: StubHost,
	repos: Record<string, string>,
	event: Record<string, unknown>,
	cwd: string,
): Promise<Record<string, number>> {
	const before: Record<string, number> = {};
	for (const [name, root] of Object.entries(repos)) before[name] = await opCount(root);
	await host.toolCall({ toolCallId: nextId(), ...event }, cwd);
	const after: Record<string, number> = {};
	for (const [name, root] of Object.entries(repos)) after[name] = await opCount(root);
	return Object.fromEntries(
		Object.keys(repos).map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)]),
	);
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe("registration", () => {
	test("registers the events it needs and labels itself", () => {
		const host = startExtension();
		expect(host.label).toBe("jj");
	});
});

describe.skipIf(!hasJj)("target scoping", () => {
	test("snapshots only the workspace owning the written file", async () => {
		const host = startExtension();
		const a = await makeRepo();
		const b = await makeRepo();
		await touchFile(a, "dirty.txt");
		await touchFile(b, "dirty.txt");
		const delta = await deltaForToolCall(
			host,
			{ a, b },
			{ toolName: "write", input: { path: join(a, "new.txt") } },
			a,
		);
		expect(delta).toEqual({ a: 1, b: 0 });
	});

	test("snapshots both workspaces when an edit moves a file across them", async () => {
		const host = startExtension();
		const a = await makeRepo();
		const b = await makeRepo();
		await touchFile(a, "dirty.txt");
		await touchFile(b, "dirty.txt");
		const delta = await deltaForToolCall(
			host,
			{ a, b },
			{
				toolName: "edit",
				input: { paths: [join(a, "x.ts")], input: `PUT 1.=1:\n+x\nMV ${join(b, "moved.ts")}\n` },
			},
			a,
		);
		expect(delta).toEqual({ a: 1, b: 1 });
	});

	test("does nothing when the target is outside any workspace", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const plain = await makeDir();
		await touchFile(repo, "dirty.txt");
		const delta = await deltaForToolCall(
			host,
			{ repo },
			{ toolName: "write", input: { path: join(plain, "out.txt") } },
			repo,
		);
		expect(delta).toEqual({ repo: 0 });
		expect(host.snapshotReasons()).toEqual([]);
	});

	test("scopes an opaque executor to the session workspace", async () => {
		const host = startExtension();
		const a = await makeRepo();
		const b = await makeRepo();
		await touchFile(a, "dirty.txt");
		await touchFile(b, "dirty.txt");
		const delta = await deltaForToolCall(
			host,
			{ a, b },
			{ toolName: "bash", input: { command: "true" } },
			b,
		);
		expect(delta).toEqual({ a: 0, b: 1 });
	});

	test("ignores a non-modifying tool", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await touchFile(repo, "dirty.txt");
		const delta = await deltaForToolCall(
			host,
			{ repo },
			{ toolName: "read", input: { path: join(repo, "dirty.txt") } },
			repo,
		);
		expect(delta).toEqual({ repo: 0 });
	});
});

describe.skipIf(!hasJj)("session lifecycle", () => {
	test("snapshots at session start and before compaction", async () => {
		const host = startExtension();
		const repo = await makeRepo();

		await touchFile(repo, "one.txt");
		const beforeStart = await opCount(repo);
		await host.emit("session_start", {}, repo);
		expect(await opCount(repo)).toBe(beforeStart + 1);

		await touchFile(repo, "two.txt");
		const beforeCompact = await opCount(repo);
		await host.emit("session_before_compact", {}, repo);
		expect(await opCount(repo)).toBe(beforeCompact + 1);
		expect(host.snapshotReasons()).toEqual(["session_start", "session_before_compact"]);
	});
});

describe.skipIf(!hasJj)("staged AST rewrites", () => {
	test("applies the staged roots when the rewrite is resolved from another directory", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const elsewhere = await makeDir();

		await touchFile(repo, "stage.txt");
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "ast_edit", input: { paths: [join(repo, "src")] } },
			repo,
		);

		// The apply names no file, and the session cwd is not the workspace: only the staged roots
		// can point at the tree about to change.
		await touchFile(repo, "apply.txt");
		const before = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: "xd://resolve", content: "go" } },
			elsewhere,
		);
		expect(await opCount(repo)).toBe(before + 1);
	});

	test("forgets staged roots once the rewrite is rejected", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const elsewhere = await makeDir();

		await touchFile(repo, "stage.txt");
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "ast_edit", input: { paths: [join(repo, "src")] } },
			repo,
		);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: "xd://reject", content: "no" } },
			elsewhere,
		);

		await touchFile(repo, "after.txt");
		const before = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: "xd://resolve", content: "go" } },
			elsewhere,
		);
		expect(await opCount(repo)).toBe(before);
	});
});

describe.skipIf(!hasJj)("batched calls", () => {
	/**
	 * The agent loop prepares every tool call in an assistant message before executing any of them,
	 * so both pre-tool hooks observe the same pre-batch tree. Without a post-execution snapshot the
	 * two writes would share one restore point and the first write could not be recovered.
	 */
	test("keeps a restore point between two batched writes", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await Bun.write(join(repo, "one.txt"), "one v1\n");
		await Bun.write(join(repo, "two.txt"), "two v1\n");
		await host.emit("session_start", {}, repo);

		const first = { toolCallId: nextId(), toolName: "write", input: { path: join(repo, "one.txt") } };
		const second = { toolCallId: nextId(), toolName: "write", input: { path: join(repo, "two.txt") } };

		// Prepare phase: both hooks, before either write executes.
		await host.toolCall(first, repo);
		await host.toolCall(second, repo);

		await Bun.write(join(repo, "one.txt"), "one v2\n");
		await host.toolResult(first, repo);
		const boundary = (await opIds(repo))[0];

		await Bun.write(join(repo, "two.txt"), "two v2\n");
		await host.toolResult(second, repo);

		await restoreOp(repo, boundary);
		expect(await Bun.file(join(repo, "one.txt")).text()).toBe("one v2\n");
		expect(await Bun.file(join(repo, "two.txt")).text()).toBe("two v1\n");
	});

	test("does not snapshot after an executor whose writes can outlive its result", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await touchFile(repo, "dirty.txt");

		for (const toolName of ["bash", "eval", "task", "debug"]) {
			const call = {
				toolCallId: nextId(),
				toolName,
				input: toolName === "debug" ? { action: "launch" } : {},
			};
			await host.toolCall(call, repo);
			await host.toolResult(call, repo);
		}

		// A background process may still be writing when its result arrives, so a post-snapshot
		// there would record a half-written tree.
		expect(host.snapshotReasons().filter((reason) => reason.endsWith(":after"))).toEqual([]);
	});

	test("snapshots after a synchronous mutator", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await touchFile(repo, "dirty.txt");
		const call = {
			toolCallId: nextId(),
			toolName: "write",
			input: { path: join(repo, "out.txt") },
		};
		await host.toolCall(call, repo);
		await host.toolResult(call, repo);
		expect(host.snapshotReasons()).toEqual(["write", "write:after"]);
	});

	test("snapshots after a failed tool, which may still have written", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await touchFile(repo, "dirty.txt");
		const call = {
			toolCallId: nextId(),
			toolName: "edit",
			input: { paths: [join(repo, "a.ts")] },
		};
		await host.toolCall(call, repo);
		await host.toolResult({ ...call, isError: true }, repo);
		expect(host.snapshotReasons()).toEqual(["edit", "edit:after"]);
	});
});

describe.skipIf(!hasJj)("recovery", () => {
	test("the pre-tool operation restores the content the tool overwrote", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		const file = join(repo, "story.txt");
		await Bun.write(file, "v1 the state before the tool\n");

		const call = { toolCallId: nextId(), toolName: "write", input: { path: file } };
		const before = await opIds(repo);
		await host.toolCall(call, repo);
		const created = (await opIds(repo)).find((id) => !before.includes(id));
		expect(created).toBeDefined();

		await Bun.write(file, "v2 clobbered by the tool\n");
		await host.toolResult(call, repo);

		await restoreOp(repo, created as string);
		expect(await Bun.file(file).text()).toBe("v1 the state before the tool\n");
	});
});

describe.skipIf(!hasJj)("resilience", () => {
	test("never reports a warning during ordinary operation", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await touchFile(repo, "dirty.txt");
		const call = { toolCallId: nextId(), toolName: "write", input: { path: join(repo, "a.txt") } };
		await host.emit("session_start", {}, repo);
		await host.toolCall(call, repo);
		await host.toolResult(call, repo);
		expect(host.warnings()).toEqual([]);
	});

	test("a tool_call handler returns nothing, so it can never block a tool", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		// A thrown or blocking pre-tool handler is fail-closed in the runtime; assert we stay quiet
		// even when the input is malformed.
		await host.toolCall({ toolCallId: nextId(), toolName: "write", input: {} }, repo);
		await host.toolCall({ toolCallId: nextId(), toolName: "edit" }, repo);
		expect(host.warnings()).toEqual([]);
	});
});
