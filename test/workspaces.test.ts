import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalize } from "../src/repo.ts";
import {
	bundledHelperPath,
	listWorkspaces,
	mainWorkspace,
	selectWorkspace,
	workspaceRoot,
} from "../src/workspaces.ts";
import { cleanupScratch, hasJj, makeDir, makeFakeJj, makeRepo, opCount, startExtension } from "./harness.ts";

async function configure(repo: string, directory: string): Promise<void> {
	await mkdir(join(repo, ".local"), { recursive: true });
	await Bun.write(join(repo, ".local", "wt.toml"), `workspace_dir = ${JSON.stringify(directory)}\n`);
}

async function runFallback(
	cwd: string,
	fakeJj: string,
	args: string[],
): Promise<{ code: number; out: string; err: string }> {
	const bin = dirname(fakeJj);
	await symlink(fakeJj, join(bin, "jj"));
	const proc = Bun.spawn([bundledHelperPath(), ...args], {
		cwd,
		env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, out, err };
}

afterAll(async () => {
	await cleanupScratch();
});

describe.skipIf(!hasJj)("bundled workspace fallback", () => {
	test("resolves wt-compatible repository configuration instead of a hardcoded home", async () => {
		const repo = await makeRepo();
		const canonicalRepo = canonicalize(repo);
		await configure(repo, "var/jj-workspaces");

		const result = await workspaceRoot({ cwd: repo });
		expect(result).toEqual({
			ok: true,
			value: {
				backend: "jj",
				root: canonicalRepo,
				path: join(canonicalRepo, "var", "jj-workspaces"),
			},
		});
	});

	test("previews and creates in the configured root while reads remain snapshot-free", async () => {
		const repo = await makeRepo();
		const canonicalRepo = canonicalize(repo);
		const managed = await makeDir("omp-jj-managed-");
		const canonicalManaged = canonicalize(managed);
		await configure(repo, managed);
		const host = startExtension();
		const beforePreview = await opCount(repo);

		expect(await host.command("jj-workspace", "root", repo)).toEqual([
			`Configured workspace root: ${canonicalManaged}\nPrimary workspace: ${canonicalRepo}`,
		]);
		expect((await host.command("jj-workspace", "add feature", repo))[0]).toContain(canonicalManaged);
		expect(await opCount(repo)).toBe(beforePreview);

		expect(await host.command("jj-workspace", "add feature --apply", repo)).toEqual([
			`Created jj workspace 'feature' at ${join(canonicalManaged, "feature")}`,
		]);
		expect(existsSync(join(managed, "feature", ".jj"))).toBe(true);

		const beforeReads = await opCount(repo);
		const listed = await listWorkspaces({ cwd: repo });
		expect(listed.ok && listed.value.map((row) => row.name)).toEqual(["feature"]);
		expect(await selectWorkspace({ cwd: repo, name: "feature" })).toEqual({
			ok: true,
			value: join(canonicalManaged, "feature"),
		});
		expect(await mainWorkspace({ cwd: join(managed, "feature") })).toEqual({
			ok: true,
			value: { backend: "jj", root: canonicalRepo, prefix: "", path: canonicalRepo },
		});
		expect(await opCount(repo)).toBe(beforeReads);

		expect(
			(await host.command(
				"jj-workspace",
				"remove feature --apply --confirm feature --force --delete-dir",
				repo,
			))[0],
		).toContain(`Removed 'feature'`);
		expect(existsSync(join(managed, "feature"))).toBe(false);
	});

	test("refuses to delete a malicious registered name that escapes the configured root", async () => {
		const repo = await makeDir("omp-jj-fake-repo-");
		const managed = join(repo, "managed");
		const escaped = join(repo, "escaped");
		await mkdir(join(repo, ".jj", "repo"), { recursive: true });
		await mkdir(managed);
		await mkdir(escaped);
		await Bun.write(join(escaped, "keep.txt"), "keep\n");
		await configure(repo, "managed");
		const fakeJj = await makeFakeJj("printf '../escaped\\t\\tabc\\t\\tok\\tempty\\n'");

		const result = await runFallback(repo, fakeJj, [
			"remove",
			"../escaped",
			"--all",
			"--force",
			"--delete-dir",
			"--json",
		]);

		expect(result.code).toBe(1);
		expect(result.err).toContain("strictly under the configured root");
		expect(existsSync(join(escaped, "keep.txt"))).toBe(true);
	});

	test("forced stale cleanup skips file inventory and forgets the registration", async () => {
		const repo = await makeDir("omp-jj-fake-repo-");
		const managed = join(repo, "managed");
		const stale = join(managed, "stale");
		const forgot = join(repo, "forgot");
		const scanned = join(repo, "scanned");
		await mkdir(join(repo, ".jj", "repo"), { recursive: true });
		await mkdir(stale, { recursive: true });
		await configure(repo, "managed");
		const fakeJj = await makeFakeJj(`
case "$*" in
  *"workspace list"*) printf 'stale\\t%s\\tabc\\t\\tok\\tempty\\n' ${JSON.stringify(stale)} ;;
  *" st -R "*) echo "Error: This workspace doesn't have a working-copy commit" >&2; exit 1 ;;
  *" file list "*) printf scanned > ${JSON.stringify(scanned)}; exit 9 ;;
  *" workspace forget "*) printf forgot > ${JSON.stringify(forgot)} ;;
esac
`);

		const result = await runFallback(repo, fakeJj, [
			"remove",
			"stale",
			"--all",
			"--force",
			"--json",
		]);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.out).registration_removed).toBe(true);
		expect(existsSync(forgot)).toBe(true);
		expect(existsSync(scanned)).toBe(false);
	});

	test("reports invalid configured directories instead of silently using a default", async () => {
		const repo = await makeRepo();
		await mkdir(join(repo, ".local"), { recursive: true });
		await Bun.write(join(repo, ".local", "wt.toml"), "workspace_dir = []\n");

		const result = await workspaceRoot({ cwd: repo });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("failed");
			expect(result.error.detail).toContain("workspace_dir must be a non-empty string");
		}
	});
});
