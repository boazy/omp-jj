import { afterAll, describe, expect, test } from "bun:test";
import { createSnapshotter } from "../src/snapshot.ts";
import { cleanupScratch, hasJj, makeDir, makeFakeJj, makeRepo, opCount, opIds } from "./harness.ts";

interface Captured {
	level: "debug" | "warn";
	message: string;
	fields?: Record<string, unknown>;
}

function recorder() {
	const entries: Captured[] = [];
	return {
		entries,
		logger: {
			debug: (message: string, fields?: Record<string, unknown>) =>
				void entries.push({ level: "debug", message, fields }),
			warn: (message: string, fields?: Record<string, unknown>) =>
				void entries.push({ level: "warn", message, fields }),
		},
	};
}

afterAll(async () => {
	await cleanupScratch();
});

describe("createSnapshotter", () => {
	test("does nothing when jj is not installed", async () => {
		const { entries, logger } = recorder();
		const dir = await makeDir();
		const outcome = await createSnapshotter({ logger, binary: null }).snapshot(dir, "test");
		expect(outcome).toMatchObject({ status: "skipped" });
		expect(entries).toEqual([]);
	});

	test("kills a snapshot that exceeds the deadline and reports no restore point", async () => {
		const { entries, logger } = recorder();
		const dir = await makeDir();
		// The handler budget is hard: an over-running snapshot must not outlive the wait, because
		// the extension runner turns a slow tool_call handler into a blocked tool. The read side
		// fails fast so only the capturing run consumes the deadline.
		const binary = await makeFakeJj('if [ "$1" = "--ignore-working-copy" ]; then exit 1; fi\nexec sleep 30');
		const startedAt = Date.now();
		const outcome = await createSnapshotter({ logger, binary, waitMs: 250 }).snapshot(dir, "test");
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(outcome).toMatchObject({ status: "failed" });
		expect(entries.at(-1)?.message).toContain("timed out");
		expect(entries.some((entry) => entry.message === "jj snapshot")).toBe(false);
	});

	test("reports a failing jj without throwing", async () => {
		const { entries, logger } = recorder();
		const dir = await makeDir();
		const binary = await makeFakeJj('echo "boom" >&2\nexit 3');
		const outcome = await createSnapshotter({ logger, binary }).snapshot(dir, "test");
		expect(outcome.status).toBe("failed");
		expect(outcome.message).toContain("boom");
		expect(entries).toMatchObject([
			{ level: "warn", message: "jj snapshot failed", fields: { exitCode: 3, stderr: "boom" } },
		]);
	});

	test("surfaces stderr on success, since jj reports skipped files there", async () => {
		const { entries, logger } = recorder();
		const dir = await makeDir();
		// A file over snapshot.max-new-file-size is NOT in the snapshot; silence would hide the gap.
		const binary = await makeFakeJj('echo "warning: file too large" >&2');
		const outcome = await createSnapshotter({ logger, binary }).snapshot(dir, "test");
		expect(outcome.status).toBe("partial");
		expect(outcome.message).toContain("file too large");
		expect(entries.map((entry) => entry.message)).toEqual([
			"jj snapshot warning",
			"jj snapshot",
		]);
	});

	test("reports a slow snapshot", async () => {
		const { entries, logger } = recorder();
		const dir = await makeDir();
		const binary = await makeFakeJj("sleep 0.4");
		await createSnapshotter({ logger, binary, slowMs: 100 }).snapshot(dir, "test");
		expect(entries.map((entry) => entry.message)).toEqual(["jj snapshot slow", "jj snapshot"]);
	});

	test("coalesces concurrent snapshots of one root into a single jj run", async () => {
		const { entries, logger } = recorder();
		const dir = await makeDir();
		const binary = await makeFakeJj("sleep 0.2");
		const snapshotter = createSnapshotter({ logger, binary });
		const outcomes = await Promise.all([
			snapshotter.snapshot(dir, "a"),
			snapshotter.snapshot(dir, "b"),
			snapshotter.snapshot(dir, "c"),
		]);
		expect(entries.filter((entry) => entry.message === "jj snapshot")).toHaveLength(1);
		expect(new Set(outcomes.map((o) => o.status)).size).toBe(1);
	});

	test("runs again after the previous snapshot settles", async () => {
		const { entries, logger } = recorder();
		const dir = await makeDir();
		const binary = await makeFakeJj("true");
		const snapshotter = createSnapshotter({ logger, binary });
		await snapshotter.snapshot(dir, "first");
		await snapshotter.snapshot(dir, "second");
		expect(entries.map((entry) => entry.fields?.reason)).toEqual(["first", "second"]);
	});
});

describe.skipIf(!hasJj)("against real jj", () => {
	test("reports ok with the new operation id when the working copy changed", async () => {
		const { logger } = recorder();
		const root = await makeRepo();
		const before = await opCount(root);
		await Bun.write(`${root}/a.txt`, "content\n");
		const outcome = await createSnapshotter({ logger }).snapshot(root, "test");
		expect(await opCount(root)).toBe(before + 1);
		expect(outcome.status).toBe("ok");
		// Outcomes carry full ids for exact recovery; the harness oracle reads short ids.
		expect(outcome.opId?.slice(0, 12)).toBe((await opIds(root))[0]);
		expect(outcome.commitId).toMatch(/^[0-9a-f]+$/);
	});

	test("reports unchanged with the shared operation id when nothing changed", async () => {
		const { logger } = recorder();
		const root = await makeRepo();
		const snapshotter = createSnapshotter({ logger });
		await Bun.write(`${root}/a.txt`, "content\n");
		const first = await snapshotter.snapshot(root, "first");
		expect(first.status).toBe("ok");
		const settled = await opCount(root);
		const second = await snapshotter.snapshot(root, "second");
		// jj records an operation only for an actual change, so repeated snapshots are free.
		expect(await opCount(root)).toBe(settled);
		expect(second.status).toBe("unchanged");
		expect(second.opId).toBe(first.opId);
	});

	test("reports failed outside any workspace without throwing", async () => {
		const { logger } = recorder();
		const dir = await makeDir();
		const outcome = await createSnapshotter({ logger }).snapshot(dir, "test");
		expect(outcome.status).toBe("failed");
		expect(outcome.opId).toBeUndefined();
	});
});
