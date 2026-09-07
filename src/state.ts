/**
 * Session-scoped feature toggles for the JJ extension.
 *
 * Three switches: the master extension gate, automatic snapshots + session-linked recovery,
 * and extra explanations for history editing. Turning explanations off suppresses the
 * narrative/preview presentation only — ownership checks, revision validation, and required
 * authorization stay on.
 *
 * State lives in a per-session map (never a process-global singleton: one process can host
 * several sessions, and subagents get their own runner). Each change is also appended as a
 * namespaced `custom` session entry (`CustomEntry` with `customType "omp-jj-state"`), so a
 * resumed session reconstructs its toggles by scanning entries — the exact pattern the
 * session-entry docs prescribe. Child preferences survive the master switch: master-off only
 * changes what is *effective*, never what is configured.
 */

export interface JJSettings {
	master: boolean;
	snapshots: boolean;
	explain: boolean;
}

export type SettingKey = keyof JJSettings;

export const SETTING_KEYS: readonly SettingKey[] = ["master", "snapshots", "explain"];

/** New sessions start fully on; user/repository configuration overrides these defaults. */
export const DEFAULT_SETTINGS: JJSettings = { master: true, snapshots: true, explain: true };

/** Custom entry type this module persists with and scans for. */
export const STATE_CUSTOM_TYPE = "omp-jj-state";

export interface PersistedState {
	settings: JJSettings;
}

function isSettings(value: unknown): value is JJSettings {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.master === "boolean" &&
		typeof record.snapshots === "boolean" &&
		typeof record.explain === "boolean"
	);
}

/** Session id for scoping, defensive: the manager always has one, but never throw for state. */
export function sessionIdOf(ctx: {
	sessionManager?: { getSessionId?: () => string };
}): string {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id) return id;
	} catch {
		// Fall through to the shared fallback below.
	}
	return "default";
}

export class ToggleStore {
	private readonly settings = new Map<string, JJSettings>();

	get(sessionId: string): JJSettings {
		return { ...(this.settings.get(sessionId) ?? DEFAULT_SETTINGS) };
	}

	set(sessionId: string, settings: JJSettings): void {
		this.settings.set(sessionId, { ...settings });
	}

	toggle(sessionId: string, key: SettingKey): JJSettings {
		const next = this.get(sessionId);
		next[key] = !next[key];
		this.settings.set(sessionId, next);
		return { ...next };
	}

	setKey(sessionId: string, key: SettingKey, value: boolean): JJSettings {
		const next = this.get(sessionId);
		next[key] = value;
		this.settings.set(sessionId, next);
		return { ...next };
	}

	/** Latest persisted settings in a session entry list, or undefined when absent. */
	restore(entries: readonly unknown[]): JJSettings | undefined {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
			if (!entry || typeof entry !== "object") continue;
			if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
			const data = entry.data as { settings?: unknown } | undefined;
			if (data && isSettings(data.settings)) return { ...data.settings };
		}
		return undefined;
	}

	/** Reconstruct one session's settings from its entries (resume/switch). */
	refresh(sessionId: string, entries: readonly unknown[]): JJSettings {
		const restored = this.restore(entries);
		const next = restored ?? DEFAULT_SETTINGS;
		this.settings.set(sessionId, { ...next });
		return { ...next };
	}
}

/** Effective runtime state: configured toggles intersected with repository reality. */
export interface EffectiveState {
	master: boolean;
	snapshots: boolean;
	explain: boolean;
	/** Why the extension is inactive, when it is. */
	inactiveReason?: string;
}

export function effectiveState(
	settings: JJSettings,
	options: { jjAvailable: boolean; repoActive: boolean },
): EffectiveState {
	if (!options.jjAvailable) {
		return { master: false, snapshots: false, explain: false, inactiveReason: "jj not installed" };
	}
	if (!options.repoActive) {
		return {
			master: false,
			snapshots: false,
			explain: false,
			inactiveReason: "not a JJ repository",
		};
	}
	if (!settings.master) {
		return { master: false, snapshots: false, explain: false, inactiveReason: "JJ disabled" };
	}
	return { master: true, snapshots: settings.snapshots, explain: settings.explain };
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

/** One-line status for the master switch, distinguishing configured from effective. */
export function masterStatus(settings: JJSettings, effective: EffectiveState): string {
	if (effective.inactiveReason && settings.master) return `JJ: inactive (${effective.inactiveReason})`;
	return `JJ: ${onOff(settings.master)}`;
}

/** One-line status for a child switch, naming the master gate when it overrides. */
export function childStatus(
	name: "snapshots" | "explain",
	settings: JJSettings,
	effective: EffectiveState,
): string {
	const label = name === "snapshots" ? "JJ snapshots" : "JJ explanations";
	if (effective.inactiveReason && settings.master)
		return `${label}: inactive (${effective.inactiveReason})`;
	if (!settings.master) return `${label}: ${onOff(settings[name])} (JJ disabled)`;
	return `${label}: ${onOff(effective[name])}`;
}

export type ToggleArg = "on" | "off" | "status" | "toggle";

/** Parses a toggle argument. Bare invocation toggles; anything else must be exact. */
export function parseToggleArg(raw: string): ToggleArg | undefined {
	const arg = raw.trim().toLowerCase();
	if (!arg || arg === "toggle") return "toggle";
	if (arg === "on" || arg === "off" || arg === "status") return arg;
	return undefined;
}
