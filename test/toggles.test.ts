/**
 * Toggle behavior through the real extension: master/child interaction, immediate feedback,
 * persistence across the session boundary, and snapshot gating.
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
	startExtension,
	touchFile,
} from "./harness.ts";

let callSeq = 1000;
function nextId(): string {
	callSeq += 1;
	return `toggle-call-${callSeq}`;
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe.skipIf(!hasJj)("toggle commands", () => {
	test("bare invocation toggles and reports the effective status", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		expect(await host.command("jj", "", repo)).toEqual(["JJ: off"]);
		expect(await host.command("jj", "status", repo)).toEqual(["JJ: off"]);
		expect(await host.command("jj", "on", repo)).toEqual(["JJ: on"]);
	});

	test("master-off suspends snapshots but preserves child preferences", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		// Child on while master on: plain "on".
		expect(await host.command("jj-snapshots", "status", repo)).toEqual(["JJ snapshots: on"]);

		// Master off: snapshots report their configured value plus the gate reason ...
		expect(await host.command("jj", "off", repo)).toEqual(["JJ: off"]);
		expect(await host.command("jj-snapshots", "status", repo)).toEqual([
			"JJ snapshots: on (JJ disabled)",
		]);

		// ... and no snapshot is captured while gated ...
		await touchFile(repo, "gated.txt");
		const before = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(repo, "gated-out.txt") } },
			repo,
		);
		expect(await opCount(repo)).toBe(before);

		// ... but re-enabling the master restores the child's configured preference.
		expect(await host.command("jj", "on", repo)).toEqual(["JJ: on"]);
		expect(await host.command("jj-snapshots", "status", repo)).toEqual(["JJ snapshots: on"]);
		await touchFile(repo, "ungated.txt");
		const beforeSecond = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(repo, "ungated-out.txt") } },
			repo,
		);
		expect(await opCount(repo)).toBe(beforeSecond + 1);
	});

	test("snapshots-off suspends capture while the master stays on", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		expect(await host.command("jj-snapshots", "off", repo)).toEqual(["JJ snapshots: off"]);
		await touchFile(repo, "quiet.txt");
		const before = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(repo, "quiet-out.txt") } },
			repo,
		);
		expect(await opCount(repo)).toBe(before);
		expect(host.snapshotReasons()).toEqual(["session_start"]);

		// A rewrite staged while armed must not fire after the switch: disabling clears it.
		const elsewhere = await makeDir();
		expect(await host.command("jj-snapshots", "on", repo)).toEqual(["JJ snapshots: on"]);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "ast_edit", input: { paths: [join(repo, "src")] } },
			repo,
		);
		expect(await host.command("jj-snapshots", "off", repo)).toEqual(["JJ snapshots: off"]);
		await touchFile(repo, "stale.txt");
		const beforeApply = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: "xd://resolve", content: "go" } },
			elsewhere,
		);
		expect(await opCount(repo)).toBe(beforeApply);
		expect(await host.command("jj-snapshots", "on", repo)).toEqual(["JJ snapshots: on"]);
	});

	test("invalid input reports usage without changing state", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		expect(await host.command("jj", "bogus", repo)).toEqual(["Usage: /jj [on|off|status]"]);
		expect(await host.command("jj-explain", "status", repo)).toEqual(["JJ explanations: on"]);
	});

	test("settings survive the session boundary through persisted entries", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);
		expect(await host.command("jj-snapshots", "off", repo)).toEqual(["JJ snapshots: off"]);

		// A resume replays session_start against the same persisted entries; the restored
		// settings must still gate capture.
		await host.emit("session_start", {}, repo);
		expect(await host.command("jj-snapshots", "status", repo)).toEqual(["JJ snapshots: off"]);
		await touchFile(repo, "resumed.txt");
		const before = await opCount(repo);
		await host.toolCall(
			{ toolCallId: nextId(), toolName: "write", input: { path: join(repo, "resumed-out.txt") } },
			repo,
		);
		expect(await opCount(repo)).toBe(before);
	});

	test("non-JJ cwd reports inactive instead of defaulting to on", async () => {
		const host = startExtension();
		const plain = await makeDir();
		await host.emit("session_start", {}, plain);
		expect(await host.command("jj", "status", plain)).toEqual([
			"JJ: inactive (not a JJ repository)",
		]);
		expect(await host.command("jj-snapshots", "status", plain)).toEqual([
			"JJ snapshots: inactive (not a JJ repository)",
		]);
	});
});
