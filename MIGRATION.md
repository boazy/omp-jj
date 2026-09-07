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

1. Install `omp-jj` alongside the legacy extension and exercise it: toggles,
   `/jj-recover list` after a few tool calls, `/jj-health`, prompt redraws and
   autocomplete creating no snapshots (op-log count is the oracle).
2. Only when capture/recovery behavior is verified, remove (or disable)
   `~/.omp/agent/extensions/jj-snapshot` registration so exactly one snapshot
   engine runs. Two engines would double-snapshot every boundary.
3. No data migration step exists or is needed (next section).

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
