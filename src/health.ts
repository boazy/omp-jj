/**
 * Read-only repository health inspection.
 *
 * Every check is a `--ignore-working-copy` jj read or a filesystem stat: health inspection
 * never initializes repositories, converts colocation, rewrites configuration, fetches, or
 * publishes. Findings carry explicit remedies; acting on them is always a separate,
 * authorized step owned by the user (or by the narrow commands health points at).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGh } from "./pr.ts";
import { runJj } from "./recovery.ts";
import type { CheckpointRecord } from "./recovery.ts";

export type FindingLevel = "ok" | "info" | "warn" | "fail";

export interface HealthFinding {
	area: string;
	level: FindingLevel;
	summary: string;
	remedy?: string;
}

export interface HealthOptions {
	/** Session checkpoint records for snapshot-coverage warnings. */
	checkpoints?: CheckpointRecord[];
	/** Precomputed PR mapping status (index.ts owns the store; health only reports). */
	pr?: { mappings: number; stale: string[]; preset: string };
}

export interface HealthReport {
	root: string;
	classification: Classification;
	findings: HealthFinding[];
}

function ok(area: string, summary: string): HealthFinding {
	return { area, level: "ok", summary };
}

function info(area: string, summary: string, remedy?: string): HealthFinding {
	return { area, level: "info", summary, remedy };
}

function warn(area: string, summary: string, remedy?: string): HealthFinding {
	return { area, level: "warn", summary, remedy };
}

function fail(area: string, summary: string, remedy?: string): HealthFinding {
	return { area, level: "fail", summary, remedy };
}

async function jjRead(root: string, args: string[]): Promise<string | undefined> {
	const result = await runJj(root, ["--ignore-working-copy", ...args], { timeoutMs: 10_000 });
	if (result.code !== 0) return undefined;
	const trimmed = result.out.trim();
	return trimmed ? trimmed : undefined;
}

function parseLogBlocks(out: string): string[][] {
	return out
		.split("@@\n")
		.map((block) => block.split("\n"))
		.filter((lines) => lines[0]?.trim());
}

/** Classify a directory without running any jj command that could snapshot. */
export function classifyDir(dir: string): Classification {
	const hasJj = existsSync(join(dir, ".jj"));
	const hasGit = existsSync(join(dir, ".git"));
	if (hasJj) return hasGit ? "colocated" : "jj-workspace";
	if (hasGit) return "plain-git";
	return "non-repo";
}

export async function checkHealth(root: string, options?: HealthOptions): Promise<HealthReport> {
	const classification = classifyDir(root);
	const findings: HealthFinding[] = [];

	const version = await jjRead(root, ["--version"]);
	if (!version) {
		return {
			root,
			classification,
			findings: [fail("jj", "jj is not installed or not executable", "Install jj to enable JJ workflows; ordinary Git remains usable.")],
		};
	}
	findings.push(ok("jj", version.split("\n")[0] ?? version));

	if (classification === "non-repo") {
		findings.push(info("target", `${root} is not a repository; JJ rules do not apply here.`));
		return { root, classification, findings };
	}
	if (classification === "plain-git") {
		findings.push(
			info(
				"target",
				`${root} is an ordinary Git checkout (no .jj). Git workflows apply unchanged; JJ rules stay scoped to JJ roots.`,
			),
		);
		return { root, classification, findings };
	}

	findings.push(
		ok(
			"target",
			classification === "colocated"
				? `JJ workspace colocated with Git at ${root}; JJ owns workspace policy here.`
				: `JJ workspace at ${root}.`,
		),
	);

	// Identity, signing expectations, remotes, GitHub targeting.
	const identity = await jjRead(root, ["log", "--no-graph", "-r", "@", "-T", 'change_id ++ " " ++ commit_id']);
	if (identity) findings.push(ok("identity", `working copy @ ${identity.trim()}`));
	else findings.push(warn("identity", "working copy @ is unreadable", "Run `jj st` manually and report the error."));

	const signing = await jjRead(root, ["config", "list", "signing"]);
	findings.push(
		signing
			? ok("signing", `signing config: ${signing.split("\n").join("; ")}`)
			: info("signing", "no signing.* configuration; commits are unsigned unless the project configures it elsewhere."),
	);

	const remotes = await runJj(root, ["--ignore-working-copy", "git", "remote", "list"], { timeoutMs: 10_000 });
	if (remotes.code !== 0) findings.push(warn("remotes", "remote list is unreadable", "Run `jj git remote list` manually."));
	else if (!remotes.out.trim()) findings.push(info("remotes", "no git remotes configured; publication needs a remote first."));
	else findings.push(ok("remotes", `remotes: ${remotes.out.trim().split("\n").join("; ")}`));

	const gh = await runGh(root, ["repo", "view", "--json", "nameWithOwner,url", "--jq", ".nameWithOwner + \" \" + .url"], {
		timeoutMs: 10_000,
	});
	if (gh.code !== 0) {
		findings.push(
			info(
				"github",
				"GitHub targeting is unverified (gh missing, unauthenticated, or no such repo).",
				"Authenticate gh and confirm the target repo before the first publication.",
			),
		);
	} else {
		findings.push(ok("github", `GitHub target: ${gh.out.trim() || gh.err.trim()}`));
	}

	// Pre-existing changes, conflicts, divergent changes, conflicted bookmarks, stale workspaces.
	const status = await jjRead(root, ["st"]);
	if (status === undefined) findings.push(warn("working-copy", "status is unreadable", "Run `jj st` manually."));
	else if (/no changes/i.test(status)) findings.push(ok("working-copy", "clean working copy"));
	else findings.push(info("working-copy", "uncommitted working-copy changes present (treated as pre-existing work)."));

	// Ownership baseline: the session's earliest checkpoint for this repo. Content already
	// present there is pre-existing user work; absorb/split/squash must not rename it.
	const baseline = (options?.checkpoints ?? []).find((c) => c.commitId);
	if (baseline?.commitId) {
		findings.push(
			ok("ownership-baseline", `session baseline ${baseline.commitId.slice(0, 8)} (${baseline.boundary} checkpoint${baseline.requestId ? ` ${baseline.requestId}` : ""}); earlier content is pre-existing user work.`),
		);
	} else {
		findings.push(info("ownership-baseline", "no session checkpoints yet; the first capture becomes the ownership baseline."));
	}
	const conflicts = await jjRead(root, ["log", "--no-graph", "-r", "conflicts()", "-T", 'change_id.shortest(8) ++ " " ++ description.first_line() ++ "\\n@@\\n"']);
	if (conflicts === undefined) findings.push(warn("conflicts", "conflict query failed", "Run `jj log -r 'conflicts()'` manually."));
	else if (conflicts) {
		findings.push(
			fail("conflicts", `${parseLogBlocks(conflicts).length} conflicting commit(s):\n${conflicts.split("@@\n").filter(Boolean).map((l) => `  ${l.trim()}`).join("\n")}`, "Resolve conflicts before publishing or restacking."),
		);
	} else findings.push(ok("conflicts", "no conflicting commits"));

	const divergent = await jjRead(root, ["log", "--no-graph", "-r", "divergent()", "-T", 'change_id.shortest(8) ++ "\\n@@\\n"']);
	if (divergent === undefined) findings.push(warn("divergent", "divergent-change query failed."));
	else if (divergent) {
		findings.push(
			warn(
				"divergent",
				`${parseLogBlocks(divergent).length} divergent change(s) (one change id, several commits).`,
				"Abandon the obsolete versions explicitly; never assume which copy wins.",
			),
		);
	} else findings.push(ok("divergent", "no divergent changes"));

	const bookmarkList = await jjRead(root, ["bookmark", "list", "-a"]);
	if (bookmarkList === undefined) findings.push(warn("bookmarks", "bookmark list is unreadable."));
	else {
		const conflicted = bookmarkList.split("\n").filter((line) => /conflict/i.test(line));
		if (conflicted.length > 0) {
			findings.push(fail("bookmarks", `conflicted bookmark(s):\n${conflicted.map((l) => `  ${l}`).join("\n")}`, "Resolve with explicit `jj bookmark` moves; do not push conflicted bookmarks."));
		} else findings.push(ok("bookmarks", "no conflicted bookmarks"));
	}

	const workspaces = await jjRead(root, ["workspace", "list"]);
	if (workspaces === undefined) findings.push(warn("workspaces", "workspace list is unreadable."));
	else {
		const stale: string[] = [];
		for (const line of workspaces.split("\n")) {
			const match = /^([^:]+):\s*(\S+)/.exec(line.trim());
			if (!match) continue;
			const dir = resolve(root, match[2] as string);
			try {
				if (!statSync(dir).isDirectory() || !existsSync(join(dir, ".jj"))) stale.push(`${match[1]} (${dir})`);
			} catch {
				stale.push(`${match[1]} (${dir})`);
			}
		}
		if (stale.length > 0) {
			findings.push(warn("workspaces", `stale workspace registration(s): ${stale.join("; ")}`, "Forget them explicitly with `jj workspace forget` after verifying their contents."));
		} else findings.push(ok("workspaces", "all registered workspaces resolve"));
	}

	// PR policy/mapping consistency, undescribed publication candidates, immutable revisions.
	if (options?.pr) {
		if (options.pr.stale.length > 0) {
			findings.push(
				warn(
					"pr-mappings",
					`${options.pr.stale.length} stale PR mapping(s): ${options.pr.stale.join("; ")}`,
					"Re-select the published group explicitly (split/squash replaced the mapped changes).",
				),
			);
		} else if (options.pr.mappings > 0) findings.push(ok("pr-mappings", `${options.pr.mappings} PR mapping(s) validate (preset ${options.pr.preset}).`));
		else findings.push(info("pr-mappings", `no PR mappings yet (preset ${options.pr.preset}); establish one before the first publication.`));
	}

	const undescribed = await jjRead(
		root,
		["log", "--no-graph", "-r", "mutable()", "-T", 'change_id.shortest(8) ++ "\\n" ++ description.first_line() ++ "\\n@@\\n"'],
	);
	if (undescribed !== undefined) {
		const blocks = parseLogBlocks(undescribed);
		const empty = blocks.filter((lines) => !(lines[1] ?? "").trim());
		if (empty.length > 0) {
			findings.push(
				info(
					"publication-candidates",
					`${empty.length} undescribed mutable change(s)${empty.length > 10 ? " (first 10)" : ""}: ${empty.slice(0, 10).map((l) => l[0]).join(", ")}`,
					"Describe intent before publishing; never publish an empty scratch @.",
				),
			);
		} else findings.push(ok("publication-candidates", "no undescribed mutable changes"));
	}

	const frozen = await jjRead(root, ["log", "--no-graph", "-r", "immutable()", "-T", 'commit_id.shortest(8) ++ "\\n"']);
	if (frozen !== undefined) {
		const count = frozen.split("\n").filter(Boolean).length;
		findings.push(info("immutable", `${count} immutable commit(s) in view; history tools refuse these without an explicit policy path.`));
	}

	// Snapshot coverage from session records (partial captures leave gaps).
	const partials = (options?.checkpoints ?? []).filter((c) => c.status === "partial");
	if (partials.length > 0) {
		findings.push(
			warn(
				"snapshots",
				`${partials.length} partial checkpoint(s): skipped files were never protected${partials[0]?.message ? ` (e.g. ${partials[0].message.split("\n")[0]})` : ""}.`,
				"Back up oversized/untracked files explicitly; ignored files are never protected.",
			),
		);
	} else findings.push(ok("snapshots", "no partial checkpoint gaps recorded this session"));

	// Workspace path/ignore coverage and dual-registration consistency.
	try {
		const nested: string[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === ".jj" || entry.name === ".git" || entry.name.startsWith(".")) continue;
			if (existsSync(join(root, entry.name, ".jj"))) nested.push(entry.name);
		}
		if (nested.length > 0) {
			findings.push(
				info("nested", `nested JJ repositories (managed separately): ${nested.join(", ")}`, "Check ignore coverage before creating workspace contents inside them."),
			);
		} else findings.push(ok("nested", "no nested repositories one level down"));
	} catch {
		findings.push(warn("nested", "directory scan failed."));
	}
	if (classification === "colocated") {
		findings.push(
			info(
				"dual-registration",
				"colocated Git registration present; recorded as a capability, not a separate workspace.",
				"Push JJ refs with `jj git push`; keep read-only git for inspection.",
			),
		);
	}

	// Project checks jj does not invoke, plus unsupported Git features.
	if (classification === "colocated" || existsSync(join(root, ".git"))) {
		try {
			const hooks: string[] = [];
			for (const entry of readdirSync(join(root, ".git", "hooks"))) {
				if (entry.endsWith(".sample")) continue;
				try {
					const st = statSync(join(root, ".git", "hooks", entry));
					if (st.isFile() && (st.mode & 0o111) !== 0) hooks.push(entry);
				} catch {
					// Ignore unreadable entries; absence of evidence is reported as-is.
				}
			}
			if (hooks.length > 0) {
				findings.push(
					warn("git-hooks", `executable git hooks jj never invokes: ${hooks.join(", ")}`, "Run the equivalent project checks explicitly (lint/test/typecheck) before publishing."),
				);
			} else findings.push(ok("git-hooks", "no executable git hooks to mirror"));
		} catch {
			findings.push(info("git-hooks", "hook directory unreadable; verify project checks manually."));
		}
	}
	try {
		if (existsSync(join(root, ".gitattributes"))) {
			const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
			if (/filter=lfs/m.test(attrs)) {
				findings.push(warn("lfs", "Git LFS filters present; jj tooling does not manage LFS objects.", "Verify large objects explicitly before publishing."));
			}
		}
		if (existsSync(join(root, ".gitmodules"))) {
			findings.push(warn("submodules", ".gitmodules present; submodules are an unsupported Git feature here.", "Handle submodule state with git directly and keep it out of JJ-published ranges."));
		}
	} catch {
		// Best-effort file reads; silence keeps health total, not partial.
	}

	return { root, classification, findings };
}

/** Stable text rendering: area, level, summary, indented remedy. */
export function formatReport(report: HealthReport): string {
	const lines = [`JJ health: ${report.root} (${report.classification})`];
	for (const finding of report.findings) {
		lines.push(`  [${finding.level}] ${finding.area}: ${finding.summary.split("\n").join("\n    ")}`);
		if (finding.remedy) lines.push(`    → ${finding.remedy}`);
	}
	return lines.join("\n");
}
