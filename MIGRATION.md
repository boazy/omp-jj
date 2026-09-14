# Migration: `jj-snapshot` → `omp-jj`

## What changed

| Area | `jj-snapshot` (legacy) | `omp-jj` |
| --- | --- | --- |
| Capture contract | `snapshot()` returned `void` (fire-and-forget) | `CaptureOutcome`: `ok` / `unchanged` / `partial` / `failed` / `skipped` with exact op + commit IDs |
| Records | None — restore points existed only as unnamed `jj op log` entries | Namespaced session entries per restorable capture: identity, commit/op IDs, tool-call linkage, boundary kind, outcome, request group |
| Recovery | Manual `jj undo` / `jj op restore` | `/jj-recover`: file vs. state restores, previews, pre-restore safety nets, explicit authorization |
| Toggles | None | `/jj`, `/jj-snapshots`, `/jj-explain` (session-scoped, persisted) |
| Context | None | Short per-prompt JJ context + five bundled skills |
| Guardrails | None | Repo-aware pre-execution hooks (git habits, history scope, published policy) |
| PRs / health / workspaces | None | `/jj-pr`, `/jj-stack`, `/jj-health`, `/jj-workspace` |

Classifier, workspace resolver, snapshot ordering (per-target roots, staged AST
rewrites, sync-mutator post boundaries), and their regression tests migrated
verbatim; behavior is preserved underneath the new contracts.

## Cutover (both engines must never run together)

`omp plugin install` enables `omp-jj` immediately, and the legacy engine has no runtime toggle.
Disable the legacy engine before the first session with `omp-jj`, and keep it installed but
disabled as a fallback until the new engine is verified.

1. Disable the legacy engine without deleting it: add `- extension-module:jj-snapshot` under
   `disabledExtensions` in `~/.omp/agent/config.yml`, or move
   `~/.omp/agent/extensions/jj-snapshot` out of that directory. The derived id is the entry
   directory and file: `jj-snapshot/index.ts` becomes `extension-module:jj-snapshot`.
2. Install `omp-jj` (`omp plugin install git+https://github.com/boazy/omp-jj`) and restart.
   `omp-jj` is then the only snapshot engine.
3. Exercise it: toggles, `/jj-recover list` after a few tool calls, `/jj-health`, prompt redraws
   and autocomplete creating no snapshots (op-log count is the oracle).
4. If verification fails, run `omp plugin disable omp-jj` and re-enable the legacy registration.
   Two engines would double-snapshot every boundary.
5. Once verified, delete the legacy registration and its `disabledExtensions` entry.

No data migration step exists or is needed (next section).

## Legacy records, honestly handled

The legacy extension wrote **no session entries** and kept **no metadata** —
there is no legacy checkpoint format to convert, and this extension does not
pretend otherwise:

- Restore points the old engine left in `jj op log` remain ordinary jj
  operations: restorable manually with `jj undo` / `jj op restore` while they
  exist. They never appear in `/jj-recover list`, which shows only checkpoints
  this extension recorded (exact IDs required).
- Unknown or malformed `custom` session entries (including any foreign
  `omp-jj-*` entries) are ignored during index rebuilds — they never crash
  loading and never surface as restorable points.
- Toggle state from earlier `omp-jj` sessions (`omp-jj-state` entries)
  continues to restore normally; checkpoint entries (`omp-jj-checkpoint`) are
  additive and version-stamped (`v: 1`).
