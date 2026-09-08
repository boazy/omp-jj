---
name: jj-isolation
description: Isolate risky JJ work in a separate workspace under the managed root
---

# JJ isolation (foundation)

Do risky work in a separate JJ workspace, never by copying directories around.

## Workflow

1. Create workspaces through `/jj-workspace add` with an explicit base
   revision. The command reads the same `workspace_dir` configuration as
   `wt`; `/jj-workspace root` reports the resolved directory.
2. Keep JJ as the management backend when a directory is JJ-managed, even if
   a Git registration is also present (record it as a capability, not a
   separate workspace).
3. Check whether a requested destination lies under any existing repository
   before creating nested contents, and require effective ignore coverage.
4. Removal is explicit and authorized: account for unsnapshotted files and
   ignored/untracked contents, use native JJ registration removal, and never
   abandon, squash, or delete changes/bookmarks implicitly. Never clean up
   isolation automatically when a task ends.

## Constraints

- Never relocate or remove existing workspaces merely because a session opens
  or finishes.
- Use `/jj-workspace` for root, list, select, main, add, and remove operations.
  The bundled fallback is JJ-only; the full `wt` CLI remains separate.
