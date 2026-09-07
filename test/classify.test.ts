import { describe, expect, test } from "bun:test";
import { classify } from "../src/classify.ts";

describe("write", () => {
	test("names its target file", () => {
		expect(classify("write", { path: "src/a.ts", content: "x" })).toMatchObject({
			tool: "write",
			targets: ["src/a.ts"],
		});
	});

	test("falls back to the cwd when no path is given", () => {
		expect(classify("write", {}).targets).toBe("cwd");
	});

	test("unwraps an xdev device call to the inner tool and its paths", () => {
		expect(
			classify("write", {
				path: "xd://ast_edit",
				content: JSON.stringify({ paths: ["src"], ops: [] }),
			}),
		).toMatchObject({ tool: "ast_edit", targets: ["src"], stages: true });
	});

	test("classifies a read-only device as nothing to snapshot", () => {
		expect(classify("write", { path: "xd://recall", content: '{"query":"x"}' }).targets).toBeNull();
	});

	test("degrades to the cwd when device arguments do not parse", () => {
		// Losing a snapshot is worse than an extra one, so unknown payloads snapshot the cwd.
		expect(classify("write", { path: "xd://ast_edit", content: "{not json" }).targets).toBe("cwd");
	});

	test("marks xd://resolve as applying the staged rewrite", () => {
		expect(classify("write", { path: "xd://resolve", content: "go" })).toMatchObject({
			tool: "resolve",
			staged: "use",
			targets: "cwd",
		});
	});

	test("marks xd://reject as discarding staged roots without snapshotting", () => {
		expect(classify("write", { path: "xd://reject", content: "no" })).toMatchObject({
			tool: "reject",
			staged: "clear",
			targets: null,
		});
	});
});

describe("edit", () => {
	test("uses the section paths the host normalization injects", () => {
		expect(classify("edit", { path: "a.ts", paths: ["a.ts", "b.ts"] }).targets).toEqual([
			"a.ts",
			"b.ts",
			"a.ts",
		]);
	});

	test("also targets MV destinations, which are not section headers", () => {
		const targets = classify("edit", {
			paths: ["a.ts"],
			input: "PUT 1.=1:\n+x\nMV lib/moved.ts\n",
		}).targets;
		expect(targets).toEqual(["a.ts", "lib/moved.ts"]);
	});

	test("unquotes an MV destination containing spaces", () => {
		const targets = classify("edit", { paths: ["a.ts"], input: 'MV "dir with space/b.ts"' })
			.targets;
		expect(targets).toEqual(["a.ts", "dir with space/b.ts"]);
	});

	test("ignores MV-like text that is not a directive line", () => {
		const targets = classify("edit", { paths: ["a.ts"], input: "+// MV not-a-directive.ts" })
			.targets;
		expect(targets).toEqual(["a.ts"]);
	});
});

describe("lsp", () => {
	test.each([
		["rename", {}, true],
		["rename_file", {}, true],
		["rename", { apply: false }, false],
		["code_actions", { apply: true }, true],
		["code_actions", {}, false],
		["diagnostics", {}, false],
		["references", {}, false],
	])("%s %o writes: %p", (action, extra, writes) => {
		const targets = classify("lsp", { action, file: "a.ts", ...extra }).targets;
		expect(targets === null).toBe(!writes);
	});

	test("a workspace-wide file selector degrades to the cwd", () => {
		expect(classify("lsp", { action: "rename", file: "*" }).targets).toBe("cwd");
	});
});

describe("op-gated tools", () => {
	test.each([
		["github", { op: "pr_checkout" }, "cwd"],
		["github", { op: "pr_push" }, null],
		["github", { op: "file_read" }, null],
		["debug", { action: "launch" }, "cwd"],
		["debug", { action: "evaluate" }, null],
		["debug", { action: "write_memory" }, null],
	])("%s %o", (tool, input, expected) => {
		expect(classify(tool, input).targets).toBe(expected);
	});

	test("debug launch prefers the debuggee's own cwd", () => {
		expect(classify("debug", { action: "launch", cwd: "/srv/app" }).targets).toEqual(["/srv/app"]);
	});
});

describe("scope", () => {
	test.each(["bash", "eval", "task"])("%s writes anywhere, so it is cwd-scoped", (tool) => {
		expect(classify(tool, {}).targets).toBe("cwd");
	});

	test.each([
		"read",
		"grep",
		"glob",
		"ast_grep",
		"todo",
		"web_search",
		"security_scan",
		"recall",
		"rewind",
		"checkpoint",
		"generate_image",
		"tts",
	])("%s is out of scope", (tool) => {
		expect(classify(tool, { path: "a.ts", output_path: "a.mp3" }).targets).toBeNull();
	});
});
