import { describe, expect, test } from "bun:test";
import {
	childStatus,
	effectiveState,
	masterStatus,
	parseToggleArg,
	ToggleStore,
	STATE_CUSTOM_TYPE,
	type JJSettings,
} from "../src/state.ts";

const ON: JJSettings = { master: true, snapshots: true, explain: true };

describe("parseToggleArg", () => {
	test("bare invocation toggles", () => {
		expect(parseToggleArg("")).toBe("toggle");
		expect(parseToggleArg("  ")).toBe("toggle");
		expect(parseToggleArg("toggle")).toBe("toggle");
	});
	test("accepts explicit verbs case-insensitively", () => {
		expect(parseToggleArg("on")).toBe("on");
		expect(parseToggleArg("OFF")).toBe("off");
		expect(parseToggleArg(" status ")).toBe("status");
	});
	test("rejects anything else", () => {
		expect(parseToggleArg("bogus")).toBeUndefined();
		expect(parseToggleArg("on please")).toBeUndefined();
	});
});

describe("effectiveState", () => {
	test("a missing jj deactivates everything", () => {
		expect(effectiveState(ON, { jjAvailable: false, repoActive: true })).toMatchObject({
			master: false,
			snapshots: false,
			explain: false,
			inactiveReason: "jj not installed",
		});
	});
	test("a non-JJ target is inactive, never a reason to init", () => {
		expect(effectiveState(ON, { jjAvailable: true, repoActive: false })).toMatchObject({
			master: false,
			inactiveReason: "not a JJ repository",
		});
	});
	test("master-off suspends children but keeps their configuration", () => {
		const settings: JJSettings = { master: false, snapshots: true, explain: true };
		const effective = effectiveState(settings, { jjAvailable: true, repoActive: true });
		expect(effective).toMatchObject({ master: false, snapshots: false, explain: false });
		expect(effective.inactiveReason).toBe("JJ disabled");
	});
	test("an enabled child stays enabled when the repo is active", () => {
		expect(
			effectiveState(ON, { jjAvailable: true, repoActive: true }),
		).toMatchObject({ master: true, snapshots: true, explain: true });
	});
});

describe("status lines", () => {
	test("master distinguishes configured from effective", () => {
		expect(masterStatus(ON, effectiveState(ON, { jjAvailable: true, repoActive: true }))).toBe("JJ: on");
		expect(
			masterStatus({ ...ON, master: false }, effectiveState({ ...ON, master: false }, { jjAvailable: true, repoActive: true })),
		).toBe("JJ: off");
		expect(masterStatus(ON, effectiveState(ON, { jjAvailable: true, repoActive: false }))).toBe(
			"JJ: inactive (not a JJ repository)",
		);
	});
	test("children name the master gate when it overrides them", () => {
		const off: JJSettings = { ...ON, master: false };
		const effective = effectiveState(off, { jjAvailable: true, repoActive: true });
		expect(childStatus("snapshots", off, effective)).toBe("JJ snapshots: on (JJ disabled)");
		expect(childStatus("explain", off, effective)).toBe("JJ explanations: on (JJ disabled)");
		expect(childStatus("snapshots", ON, effectiveState(ON, { jjAvailable: true, repoActive: true }))).toBe(
			"JJ snapshots: on",
		);
	});
});

describe("ToggleStore", () => {
	test("defaults are fully on and per-session", () => {
		const store = new ToggleStore();
		expect(store.get("a")).toEqual(ON);
		store.setKey("a", "master", false);
		expect(store.get("a").master).toBe(false);
		expect(store.get("b")).toEqual(ON);
	});
	test("restores the latest persisted entry and ignores other custom types", () => {
		const store = new ToggleStore();
		const entries = [
			{ type: "custom", customType: "other-extension", data: { settings: { master: false, snapshots: false, explain: false } } },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { settings: { master: true, snapshots: false, explain: true } } },
			{ type: "user", text: "hello" },
		];
		expect(store.refresh("s", entries)).toEqual({ master: true, snapshots: false, explain: true });
		expect(store.get("s").snapshots).toBe(false);
	});
	test("a session with no persisted state resets to defaults", () => {
		const store = new ToggleStore();
		store.setKey("s", "explain", false);
		expect(store.refresh("s", [])).toEqual(ON);
	});
	test("malformed persisted settings are ignored, not applied", () => {
		const store = new ToggleStore();
		const entries = [{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { settings: { master: "yes" } } }];
		expect(store.refresh("s", entries)).toEqual(ON);
	});
});
