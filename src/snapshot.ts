/**
 * Runs `jj status` for its side effect. Any jj command snapshots the working copy, so each run
 * leaves a restore point in `jj op log`; the printed status is discarded.
 */

export interface SnapshotLogger {
	debug(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

export interface SnapshotterOptions {
	logger: SnapshotLogger;
	/**
	 * `undefined` probes `PATH` for `jj` once; `null` forces "not installed". Tests pass a stub
	 * binary to exercise the slow and failing paths deterministically.
	 */
	binary?: string | null;
	/**
	 * Hard deadline for one `jj status`. Must stay well under `extensionHandlers.toolCallTimeoutMs`
	 * (default 30_000): the extension runner turns a timed-out `tool_call` handler into
	 * `{ block: true }`, so an over-running snapshot would block the tool, not merely delay it.
	 */
	waitMs?: number;
	/** Snapshots slower than this are reported; a warm snapshot is sub-second. */
	slowMs?: number;
}

/**
 * What a capture attempt produced. `opId` names the recorded repository view the caller can
 * restore with `jj op restore`; it is present on `ok` and `unchanged` (an unchanged working
 * copy shares the previous operation id) whenever the read side succeeds. `commitId`/`changeId`
 * name the working-copy commit after capture. `message` carries the human-readable reason for
 * any non-`ok` outcome.
 */
export type CaptureStatus = "ok" | "unchanged" | "partial" | "failed" | "skipped";

export interface CaptureOutcome {
	status: CaptureStatus;
	opId?: string;
	commitId?: string;
	changeId?: string;
	message?: string;
}

export interface Snapshotter {
	/**
	 * Snapshots one workspace root, awaiting a dead jj process. Never rejects; the outcome
	 * describes what was recorded.
	 */
	snapshot(root: string, reason: string): Promise<CaptureOutcome>;
}

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_SLOW_MS = 2_000;
/** Milliseconds allowed for reading buffered stderr once the process has exited. */
const STDERR_DRAIN_MS = 250;
/** Deadline for the read-only inspection commands; they must never block a tool. */
const READ_MS = 5_000;

/**
 * Reads what jj already wrote to stderr, giving up rather than waiting on a pipe some surviving
 * grandchild still holds open. Diagnostics are worth a short wait, never an unbounded one.
 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
	const deadline = new Promise<string>((resolve) => {
		setTimeout(() => resolve(""), STDERR_DRAIN_MS).unref?.();
	});
	try {
		return await Promise.race([new Response(stream).text(), deadline]);
	} catch {
		return "";
	}
}

/** Reads a piped stdout stream with a hard deadline. Returns undefined on any failure. */
async function readOutput(
	binary: string,
	args: string[],
	root: string,
	waitMs: number,
): Promise<string | undefined> {
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	try {
		proc = Bun.spawn([binary, ...args], {
			cwd: root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: waitMs,
			killSignal: "SIGKILL",
		});
		const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		if (code !== 0 || proc.signalCode === "SIGKILL") return undefined;
		const trimmed = text.trim();
		return trimmed ? trimmed : undefined;
	} catch {
		return undefined;
	} finally {
		try {
			proc?.kill("SIGKILL");
		} catch {
			// Already exited; the kill is only belt-and-braces for a wedged spawn.
		}
	}
}

export function createSnapshotter(options: SnapshotterOptions): Snapshotter {
	const { logger } = options;
	const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
	const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
	let binary = options.binary;
	/**
	 * One snapshot per root at a time. Concurrent runs would only queue on jj's working-copy lock,
	 * and a caller that arrives mid-snapshot wants that snapshot, not a second one.
	 */
	const inFlight = new Map<string, Promise<CaptureOutcome>>();

	/**
	 * Reads recorded state only. `--ignore-working-copy` is essential: without it the inspection
	 * command would snapshot the working copy and perturb what it is measuring, and an op-id
	 * comparison could never report `unchanged`.
	 */
	const readOpId = (root: string): Promise<string | undefined> => {
		if (!binary) return Promise.resolve(undefined);
		return readOutput(
			binary,
			["--ignore-working-copy", "op", "log", "--limit", "1", "--no-graph", "-T", "id"],
			root,
			READ_MS,
		);
	};

	const readWorkingCopy = (root: string): Promise<{ commitId: string; changeId: string } | undefined> =>
		(async () => {
			if (!binary) return undefined;
			const out = await readOutput(
				binary,
			["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id ++ \"\\n\" ++ change_id"],
				root,
				READ_MS,
			);
			if (!out) return undefined;
			const [commitId, changeId] = out.split("\n");
			if (!commitId || !changeId) return undefined;
			return { commitId, changeId };
		})();

	const finish = async (
		root: string,
		status: CaptureStatus,
		opId: string | undefined,
		message?: string,
	): Promise<CaptureOutcome> => {
		const wc = await readWorkingCopy(root);
		return {
			status,
			...(opId ? { opId } : {}),
			...(wc ? { commitId: wc.commitId, changeId: wc.changeId } : {}),
			...(message ? { message } : {}),
		};
	};

	const run = async (root: string, reason: string): Promise<CaptureOutcome> => {
		if (binary === undefined) binary = Bun.which("jj");
		if (!binary) return { status: "skipped", message: "jj not installed" };

		const beforeOp = await readOpId(root);

		const startedAt = Date.now();
		const proc = Bun.spawn([binary, "status"], {
			cwd: root,
			stdin: "ignore",
			// The status text is discarded by design; a very dirty repo would otherwise buffer and
			// log a large payload on every tool call. stderr stays piped for warnings/failures.
			stdout: "ignore",
			stderr: "pipe",
			// Enforced by Bun, and `proc.exited` still resolves, so jj is always dead before this
			// returns. Leaving it running while the caller's tool mutates the same working copy
			// would capture a half-applied change instead of the pre-tool state. SIGKILL rather
			// than SIGTERM because the handler budget is hard: jj's working-copy lock is an
			// flock-backed descriptor released on death and its store writes land via atomic
			// rename, so the only casualty is the partial snapshot itself.
			timeout: waitMs,
			killSignal: "SIGKILL",
		});

		// Deliberately sequential, not `Promise.all`: the spawn deadline bounds `exited`, but a
		// grandchild that inherited the stderr pipe keeps it open after jj dies, and awaiting the
		// stream alongside the exit would hang the handler well past its budget — the exact
		// tool-blocking failure the deadline exists to prevent.
		const exitCode = await proc.exited;
		const elapsedMs = Date.now() - startedAt;

		// `proc.killed` is true after any reaped exit, so it cannot detect the timeout; the kill
		// signal can, and SIGKILL is only ever sent by the spawn deadline. Checked before touching
		// stderr, because a killed jj is exactly the case whose pipe may never close.
		if (proc.signalCode === "SIGKILL") {
			logger.warn("jj snapshot timed out and was killed; no restore point for this call", {
				root,
				reason,
				elapsedMs,
			});
			return {
				status: "failed",
				message: "jj snapshot timed out and was killed; no restore point for this call",
			};
		}

		const stderr = await drain(proc.stderr);

		if (exitCode !== 0) {
			logger.warn("jj snapshot failed", { root, reason, exitCode, stderr: stderr.trim() });
			return {
				status: "failed",
				message: `jj status exited ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
			};
		}
		// jj reports skipped oversized files on stderr; those are NOT in the snapshot, so surface it.
		const partial = stderr.trim().length > 0;
		if (partial) logger.warn("jj snapshot warning", { root, reason, stderr: stderr.trim() });
		if (elapsedMs >= slowMs) logger.warn("jj snapshot slow", { root, reason, elapsedMs });
		logger.debug("jj snapshot", { root, reason, elapsedMs });

		const afterOp = await readOpId(root);
		if (partial) return finish(root, "partial", afterOp ?? beforeOp, stderr.trim());
		// A clean working copy records no new operation, so identical ids mean "nothing to
		// record", not a lost checkpoint. When the read side failed, `beforeOp` is undefined;
		// report `ok` rather than claim nothing changed.
		if (beforeOp !== undefined && afterOp === beforeOp) {
			return finish(root, "unchanged", afterOp);
		}
		return finish(root, "ok", afterOp);
	};

	return {
		snapshot(root, reason) {
			const existing = inFlight.get(root);
			if (existing) return existing;
			const task = run(root, reason)
				.catch((error: unknown) => {
					logger.warn("jj snapshot errored", { root, reason, error: String(error) });
					return { status: "failed", message: String(error) } as CaptureOutcome;
				})
				.finally(() => {
					inFlight.delete(root);
				});
			inFlight.set(root, task);
			return task;
		},
	};
}
