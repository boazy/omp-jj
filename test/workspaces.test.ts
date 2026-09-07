/**
 * Workspace client contract: the TypeScript side parses and validates helper `--json`
 * output, maps exit codes, bounds time, and passes names/flags through verbatim. All
 * placement, naming, collision, and safeguard rules stay in the helper — the passthrough
 * tests prove refusals arrive unedited from the fixture, never from TS logic.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addWorkspace,
	formatError,
	formatRow,
	listWorkspaces,
	mainWorkspace,
	removeWorkspace,
	selectWorkspace,
} from "../src/workspaces.ts";
import { clearWorkspaceCache } from "../src/workspace.ts";
import { cleanupScratch, hasJj, makeDir, makeRepo, startExtension } from "./harness.ts";

async function makeFixture(): Promise<{ bin: string; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "omp-jj-wt-fixture-"));
	const bin = join(dir, "wt");
	await writeFile(
		bin,
		[
			"#!/bin/sh",
			'dir=$(dirname "$0")',
			'echo "wt $@" >> "$dir/calls.log"',
			'if [ "$1" = "list" ]; then',
			'  if [ "$2" = "--json" ] && [ "$3" = "--all" ]; then',
			'    printf \'[{"backend":"jj","name":"feat","branch":"feat","change":"abc","state":"clean","path":"/ws/feat","managed":true,"primary":false,"stale":false,"note":""},{"backend":"jj","name":"ext","branch":"","change":"","state":"clean","path":"/elsewhere/ext","managed":false,"primary":false,"stale":false,"note":""}]\'',
			"    exit 0",
			"  fi",
			'  if [ "$2" = "--json" ]; then',
			'    printf \'[{"backend":"jj","name":"feat","branch":"feat","change":"abc","state":"clean","path":"/ws/feat","managed":true,"primary":false,"stale":false,"note":"also registered as git worktree"},{"backend":"git","name":"old","branch":"main","change":"def","state":"dirty","path":"/ws/old","managed":true,"primary":true,"stale":false,"note":""}]\'',
			"    exit 0",
			"  fi",
			"  exit 1",
			"fi",
			'if [ "$1" = "select" ]; then',
			'  if [ "$2" = "gone" ]; then echo "wt: No worktree named" >&2; exit 1; fi',
			'  if [ "$2" = "cancelled" ]; then exit 2; fi',
			'  if [ "$2" = "malformed" ]; then echo "not json"; exit 0; fi',
			'  if [ "$2" = "slow" ]; then sleep 30; exit 0; fi',
			'  printf \'{"path":"/ws/%s"}\' "$2"',
			"  exit 0",
			"fi",
			'if [ "$1" = "main" ]; then',
			'  printf \'{"backend":"jj","root":"/repo","prefix":"sub","path":"/repo/sub"}\'',
			"  exit 0",
			"fi",
			'if [ "$1" = "add" ]; then',
			'  if [ "$2" = "bad/name" ]; then echo "wt: invalid workspace name" >&2; exit 1; fi',
			'  printf \'{"backend":"jj","name":"%s","path":"/ws/%s"}\' "$2" "$2"',
			"  exit 0",
			"fi",
			'if [ "$1" = "remove" ]; then',
			'  if [ "$2" = "dirty" ]; then echo "wt: workspace has changes; pass --force" >&2; exit 1; fi',
			'  printf \'{"backend":"jj","name":"%s","path":"/ws/%s","registration_removed":true,"dir_deleted":false,"notes":["kept history"]}\' "$2" "$2"',
			"  exit 0",
			"fi",
			'if [ "$1" = "malformed" ]; then echo "not json"; exit 0; fi',
			'if [ "$1" = "slow" ]; then sleep 30; exit 0; fi',
			'echo "wt: unknown fixture command" >&2; exit 1',
			"",
		].join("\n"),
	);
	await chmod(bin, 0o755);
	return { bin, dir };
}

async function callsLog(dir: string): Promise<string> {
	return readFile(join(dir, "calls.log"), "utf8").catch(() => "");
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe("workspace client contract", () => {
	test("list parses rows and surfaces dual-registration notes as-is", async () => {
		const { bin } = await makeFixture();
		const cwd = await makeDir();
		const result = await listWorkspaces({ cwd, helper: bin });
		if (!result.ok) throw new Error(formatError(result.error));
		expect(result.value).toHaveLength(2);
		expect(result.value[0]).toMatchObject({ backend: "jj", name: "feat", managed: true, note: "also registered as git worktree" });
		expect(formatRow(result.value[0] as never)).toContain("also registered as git worktree");
	});

	test("list --all passes through and includes external rows", async () => {
		const { bin, dir } = await makeFixture();
		const cwd = await makeDir();
		const result = await listWorkspaces({ cwd, helper: bin, all: true });
		if (!result.ok) throw new Error(formatError(result.error));
		expect(result.value.some((r) => !r.managed)).toBe(true);
		expect(await callsLog(dir)).toContain("--all");
	});

	test("select resolves paths; failures and cancellation map distinctly", async () => {
		const { bin } = await makeFixture();
		const cwd = await makeDir();
		const found = await selectWorkspace({ cwd, helper: bin, name: "feat" });
		if (!found.ok) throw new Error(formatError(found.error));
		expect(found.value).toBe("/ws/feat");

		const missing = await selectWorkspace({ cwd, helper: bin, name: "gone" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error.kind).toBe("failed");
			expect(formatError(missing.error)).toContain("No worktree named");
		}
		const cancelled = await selectWorkspace({ cwd, helper: bin, name: "cancelled" });
		expect(cancelled.ok).toBe(false);
		if (!cancelled.ok) expect(cancelled.error.kind).toBe("cancelled");
	});

	test("main parses the primary response", async () => {
		const { bin } = await makeFixture();
		const cwd = await makeDir();
		const result = await mainWorkspace({ cwd, helper: bin });
		if (!result.ok) throw new Error(formatError(result.error));
		expect(result.value).toMatchObject({ backend: "jj", root: "/repo", path: "/repo/sub" });
	});

	test("add passes names verbatim; helper refusals surface unedited", async () => {
		const { bin, dir } = await makeFixture();
		const cwd = await makeDir();
		const created = await addWorkspace({ cwd, helper: bin, name: "fresh", revision: "main" });
		if (!created.ok) throw new Error(formatError(created.error));
		expect(created.value).toMatchObject({ name: "fresh", path: "/ws/fresh" });
		const calls = await callsLog(dir);
		expect(calls).toContain("add fresh --json --revision main");

		// No TS-side name validation: even a path-shaped name reaches the helper.
		const refused = await addWorkspace({ cwd, helper: bin, name: "bad/name" });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(formatError(refused.error)).toContain("invalid workspace name");
		expect(await callsLog(dir)).toContain("add bad/name");
	});

	test("remove surfaces safeguard notes and refusals verbatim", async () => {
		const { bin } = await makeFixture();
		const cwd = await makeDir();
		const removed = await removeWorkspace({ cwd, helper: bin, name: "feat" });
		if (!removed.ok) throw new Error(formatError(removed.error));
		expect(removed.value.notes).toEqual(["kept history"]);
		expect(removed.value.registrationRemoved).toBe(true);

		const dirty = await removeWorkspace({ cwd, helper: bin, name: "dirty" });
		expect(dirty.ok).toBe(false);
		if (!dirty.ok) expect(formatError(dirty.error)).toContain("pass --force");
	});

	test("malformed output, timeouts, and missing helpers report actionably", async () => {
		const { bin } = await makeFixture();
		const cwd = await makeDir();

		const malformed = await selectWorkspace({ cwd, helper: bin, name: "malformed" });
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.error.kind).toBe("malformed");

		const timed = await selectWorkspace({ cwd, helper: bin, name: "slow", timeoutMs: 300 });
		expect(timed.ok).toBe(false);
		if (!timed.ok) expect(timed.error.kind).toBe("timeout");

		const missing = await listWorkspaces({ cwd, helper: "/nonexistent/wt" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error.kind).toBe("missing");
			expect(formatError(missing.error)).toContain("helper/README.md");
		}
	});
});

describe.skipIf(!hasJj)("jj-workspace command", () => {
	test("list, select, and main read through the bundled helper", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);

		const listed = (await host.command("jj-workspace", "list -a", repo)).join("\n");
		expect(listed).toContain("Workspaces (");
		expect(listed).toContain("jj ");
		expect(listed).toContain("default");
		const selected = (await host.command("jj-workspace", "select default -a", repo)).join("\n");
		expect(selected).toContain(repo);
		const main = (await host.command("jj-workspace", "main", repo)).join("\n");
		expect(main).toContain("primary:");
		const missing = (await host.command("jj-workspace", "select nope", repo)).join("\n");
		expect(missing).toContain("[failed]");
	});

	test("add previews without side effects, then creates under a temp home", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);
		const home = await makeDir("omp-jj-wt-home-");
		const previous = process.env.WT_WORKSPACES_HOME;
		process.env.WT_WORKSPACES_HOME = home;
		try {
			const preview = (await host.command("jj-workspace", "add w1", repo)).join("\n");
			expect(preview).toContain("Will create workspace 'w1'");
			expect(preview).toContain("--apply");

			const created = (await host.command("jj-workspace", "add w1 --apply", repo)).join("\n");
			expect(created).toContain("Created jj workspace 'w1'");
			const listed = (await host.command("jj-workspace", "list", repo)).join("\n");
			expect(listed).toContain("w1");
		} finally {
			if (previous === undefined) delete process.env.WT_WORKSPACES_HOME;
			else process.env.WT_WORKSPACES_HOME = previous;
		}
	});

	test("remove previews safeguards and forgets with explicit confirm", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);
		const home = await makeDir("omp-jj-wt-home-");
		const previous = process.env.WT_WORKSPACES_HOME;
		process.env.WT_WORKSPACES_HOME = home;
		try {
			await host.command("jj-workspace", "add w2 --apply", repo);
			const preview = (await host.command("jj-workspace", "remove w2", repo)).join("\n");
			expect(preview).toContain("Would remove:");
			expect(preview).toContain("--confirm w2");

			const removed = (await host.command("jj-workspace", "remove w2 --apply --confirm w2", repo)).join("\n");
			expect(removed).toContain("Removed 'w2'");
			const listed = (await host.command("jj-workspace", "list", repo)).join("\n");
			expect(listed).not.toContain(" w2 ");
		} finally {
			if (previous === undefined) delete process.env.WT_WORKSPACES_HOME;
			else process.env.WT_WORKSPACES_HOME = previous;
		}
	});

	test("creation and removal suspend while master is off", async () => {
		const host = startExtension();
		const repo = await makeRepo();
		await host.emit("session_start", {}, repo);
		await host.command("jj", "off", repo);
		expect((await host.command("jj-workspace", "add w3 --apply", repo)).join("\n")).toContain("suspended");
		expect((await host.command("jj-workspace", "remove w3 --apply --confirm w3", repo)).join("\n")).toContain("suspended");
		expect((await host.command("jj-workspace", "list", repo)).join("\n")).toContain("Workspaces (");
	});
});
