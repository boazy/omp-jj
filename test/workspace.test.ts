import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clearWorkspaceCache, resolveTargetRoot, rootsFor } from "../src/workspace.ts";
import { cleanupScratch, makeDir } from "./harness.ts";

/** A `.jj` directory is all discovery looks for, so these tests need no jj binary. */
async function makeWorkspace(): Promise<string> {
	const dir = await makeDir("jj-snapshot-ws-");
	await mkdir(join(dir, ".jj"));
	return dir;
}

beforeEach(() => {
	clearWorkspaceCache();
});

afterAll(async () => {
	await cleanupScratch();
});

describe("resolveTargetRoot", () => {
	test("finds the workspace owning a nested file", async () => {
		const root = await makeWorkspace();
		await mkdir(join(root, "src", "deep"), { recursive: true });
		await Bun.write(join(root, "src", "deep", "a.ts"), "x");
		expect(resolveTargetRoot(join(root, "src", "deep", "a.ts"), root)).toBe(root);
	});

	test("resolves a file that does not exist yet from its nearest existing parent", async () => {
		const root = await makeWorkspace();
		expect(resolveTargetRoot(join(root, "not", "created", "yet.ts"), root)).toBe(root);
	});

	test("resolves a relative path against the session cwd", async () => {
		const root = await makeWorkspace();
		expect(resolveTargetRoot("src/a.ts", root)).toBe(root);
	});

	test("returns null outside any workspace", async () => {
		const plain = await makeDir("jj-snapshot-plain-");
		expect(resolveTargetRoot(join(plain, "a.ts"), plain)).toBeNull();
	});

	test("picks the innermost workspace for nested workspaces", async () => {
		const outer = await makeWorkspace();
		const inner = join(outer, "vendor", "lib");
		await mkdir(join(inner, ".jj"), { recursive: true });
		expect(resolveTargetRoot(join(inner, "a.ts"), outer)).toBe(inner);
	});

	test("unwraps a file:// URL", async () => {
		const root = await makeWorkspace();
		expect(resolveTargetRoot(`file://${join(root, "a.ts")}`, root)).toBe(root);
	});

	test.each(["xd://resolve", "local://plan.md", "memory://abc", "artifact://1", "https://x.dev/a"])(
		"treats %s as a non-filesystem target",
		async (uri) => {
			const root = await makeWorkspace();
			expect(resolveTargetRoot(uri, root)).toBeNull();
		},
	);

	test("ignores a trailing archive or database selector", async () => {
		const root = await makeWorkspace();
		// `pkg.zip:inner/file` names an archive member; the containing directory is what matters.
		expect(resolveTargetRoot(join(root, "pkg.zip:inner/file.txt"), root)).toBe(root);
	});

	test("sees a workspace created after a negative lookup once the cache is cleared", async () => {
		const dir = await makeDir("jj-snapshot-late-");
		expect(resolveTargetRoot(join(dir, "a.ts"), dir)).toBeNull();
		await mkdir(join(dir, ".jj"));
		clearWorkspaceCache();
		expect(resolveTargetRoot(join(dir, "a.ts"), dir)).toBe(dir);
	});
});

describe("rootsFor", () => {
	test("returns nothing for a non-modifying classification", async () => {
		const root = await makeWorkspace();
		expect(rootsFor(null, root)).toEqual([]);
	});

	test("maps the cwd sentinel to the session workspace", async () => {
		const root = await makeWorkspace();
		expect(rootsFor("cwd", root)).toEqual([root]);
	});

	test("deduplicates several targets in one workspace", async () => {
		const root = await makeWorkspace();
		expect(rootsFor([join(root, "a.ts"), join(root, "b.ts"), "c.ts"], root)).toEqual([root]);
	});

	test("returns one root per distinct workspace", async () => {
		const first = await makeWorkspace();
		const second = await makeWorkspace();
		const roots = rootsFor([join(first, "a.ts"), join(second, "b.ts")], first);
		expect(roots.toSorted()).toEqual([first, second].toSorted());
	});

	test("drops targets outside any workspace but keeps the rest", async () => {
		const root = await makeWorkspace();
		const plain = await makeDir("jj-snapshot-plain-");
		expect(rootsFor([join(plain, "a.ts"), join(root, "b.ts")], root)).toEqual([root]);
	});
});
