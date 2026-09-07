---
name: jj-recovery
description: Recover files or repository state from session-linked JJ snapshots
---

# JJ recovery (foundation)

The extension snapshots the working copy around mutating tools; each capture
leaves a restore point in `jj op log` recoverable with `jj undo` /
`jj op restore`. Use exact commit and operation IDs — a change ID identifies
an evolving change and cannot restore an earlier version.

## Workflow

Prefer the session-linked command; fall back to manual `jj` only when it cannot
express the situation:

1. List candidates: `/jj-recover list` shows this session's checkpoints grouped
   by user request (before/after tool boundaries plus session boundaries).
   `jj op log` (read-only; prefer `--ignore-working-copy` for pure inspection)
   is the underlying oracle.
2. Choose one of two distinct actions:
   - `/jj-recover files <n> [-- <paths...>]`: preview restoring file contents
     (optionally selected paths) without rewinding bookmark positions, then
     re-run with `--apply` to execute.
   - `/jj-recover state <n>`: preview restoring whole-repository state with
     the affected heads/bookmarks/workspaces diff, then re-run with
     `--apply --confirm <op>` to execute.
3. Before restoring, the command inspects current state and captures a
   recoverable pre-restore checkpoint when possible. Show unrelated or
   subsequently created work at risk.
4. Report missing or incomplete checkpoint state honestly — never silently
   substitute a nearby revision. The command validates the exact operation and
   commit IDs and refuses unavailable targets without changing anything.

## Constraints

- Conversation navigation must not automatically change files.
- Whole-repository restoration needs explicit authorization and must consider
  other sessions/workspaces. It does not undo pushes or PR changes, and must
  not auto-fetch remotes as a hidden side effect.
- Disabling snapshots (`/jj-snapshots off`) suspends recovery actions while
  keeping records for re-enablement; it never deletes checkpoint history.
