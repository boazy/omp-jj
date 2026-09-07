# Explicit-Isolation Policy Note

This note documents the explicit-isolation policy and operational boundaries governing workspace and worktree tooling (`wt` and `wtm`) across Jujutsu (JJ) and Git repositories. It serves as the reference for agent instruction mechanisms and bundled skills (such as `jj-isolation` and `git-worktrees`).

---

## 1. Core Principles

1. **Explicit authorization only:**
   - Create or remove a workspace/worktree **only** when the user explicitly requests it (e.g., "use a worktree", "isolate this in a separate workspace", "clean up that workspace").
   - **Never** create or remove workspaces on your own initiative.
   - **Never** auto-create workspaces merely because a session opens, starts, resumes, or forks.
   - **Never** delete, forget, or clean up workspaces merely because a task finishes or a prompt completes.

2. **Unified management surface:**
   - Both JJ workspaces and Git worktrees are managed through the unified `wt` helper (`helper/wt.py`), installed at `~/dots/bin/wt`.
   - The TypeScript extension delegates workspace inventory, creation, and removal to `wt --json` rather than implementing parallel placement rules.

3. **Placement invariants:**
   - **JJ repositories:** `~/.local/workspaces/<repo-key>/<name>`
     - `<repo-key>` is `<primary-dir>-<hash8>`, derived from the canonical shared repository store (`.jj/repo`).
     - Clones of the same remote at different paths receive distinct keys; all workspaces of one repository resolve to the same key.
   - **Git repositories:** `$MAIN_REPO/.local/trees/<name>`
     - `$MAIN_REPO` is resolved via `git worktree list --porcelain` (first entry), remaining stable regardless of which linked worktree the command runs in.

---

## 2. Creation Safeguards

1. **Name escape rejection:**
   - Workspace names must be single path components: `/`, `\`, `..`, `.`, and absolute paths are rejected before filesystem interaction.
2. **Collision refusal:**
   - Refuse creation if the name is already registered in the repository's inventory or if the destination directory exists and is non-empty.
3. **Nested-destination guard:**
   - If the destination path lies within any existing repository (including a home dotfiles repository or existing `.local/trees`), creation is blocked unless effective ignore coverage is verified via `git check-ignore`.
   - If ignore coverage cannot be verified, creation requires explicit `--force` and outputs a visible warning.

---

## 3. Removal Safeguards

1. **Unsnapshotted / dirty work inspection:**
   - **JJ:** target workspace status is inspected via `jj st`. If the working copy has uncommitted modifications, conflicts, or untracked files, removal is refused without `--force`.
   - **Git:** inspected via `git status --porcelain --ignored`. Uncommitted edits or ignored/untracked contents refuse removal without `--force`.
2. **No implicit data loss:**
   - Native removal uses `jj workspace forget <name>` (for JJ) or `git worktree remove` (for Git).
   - `jj workspace forget` stops tracking the working copy in the repository view but **never** abandons, squashes, or deletes commits or bookmarks implicitly. Changes remain intact in repository history.
3. **Explicit directory cleanup:**
   - In JJ repositories, forgetting a workspace leaves directory contents on disk by default.
   - Disk directory deletion requires both `--force` and `--delete-dir`, and is restricted strictly to paths located within the managed root (`~/.local/workspaces/<repo-key>`).
4. **Primary checkout protection:**
   - The helper refuses removal of the primary workspace or main Git worktree.
