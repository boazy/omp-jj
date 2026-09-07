# Dotfiles Integration: Unified `wt` / `wtm` Workspace Tooling

This directory integrates the unified `wt` workspace helper from this repository into the user's dotfiles (`~/dots`), updating the binary links and shell functions for both Jujutsu (JJ) and Git repositories.

---

## What changes in shell behavior

### 1. VCS backend discovery
- **JJ repositories (including colocated):** JJ is always chosen when `.jj` is present, even if `.git` is colocated. Workspaces are created and managed via native `jj workspace` commands under `~/.local/workspaces/<repo-key>/<name>`.
- **Pure Git repositories (no `.jj`):** Git worktrees are managed under `$MAIN_REPO/.local/trees/<name>`, where `$MAIN_REPO` resolves to the primary worktree root (`git worktree list --porcelain` first entry), not relative to the current linked worktree.
- **Strict discovery:** Failure to detect a repository or failure of the detected tool produces an explicit error—never a silent backend switch.

### 2. Managed vs. external (`--all`)
- Default commands (`wt list`, `wt select`, `wt remove`) only show and operate on workspaces within the managed roots.
- Flag `-a` / `--all` exposes all registered locations (including primary checkouts and externally registered workspaces or worktrees).

### 3. Cancellation and exit code discipline
- **Cancellation (`Esc` or `Ctrl-C` in `fzf`):** Exits with code `2` and prints **no output**.
- **Errors:** Error messages print strictly to `stderr` and exit with code `1`. No partial or fallback path is ever emitted to `stdout`.
- **Shell wrapper safety:** The updated wrapper in `git.zsh` checks the exit code (`dir="$(command wt select "$@")" || return $?`). If selection was canceled or failed, the shell aborts navigation cleanly without attempting `cd ""` or switching to `$HOME`.

### 4. Single contract for TypeScript extension
- Extension workspace actions use `wt --json` as their single contract.
- Placement rules, disambiguated repo-key calculation (`<primary-dir>-<hash8>`), nested-destination guards, and deduplication logic remain centralized in `helper/wt.py` rather than duplicated in TypeScript.

---

## Installation

### Step 1: Run dry-run inspection
Preview the symlinking and backup actions without touching `~/dots`:

```bash
./dots-integration/install.sh --dry-run
```

### Step 2: Install symlinks
Backs up existing non-symlink `wt` and `wtm` binaries to `wt.bak` and `wtm.bak`, sets executable permissions on `helper/*.py`, and symlinks the helper scripts:

```bash
./dots-integration/install.sh
```

### Step 3: Apply shell wrapper patch
Update `wt()` and `wtm()` in `~/dots/zsh/custom/git.zsh`:

```bash
patch -p1 -d ~/dots < dots-integration/git.zsh.patch
```

### Step 4: Reload shell functions
In your running zsh session:

```bash
source ~/dots/zsh/custom/git.zsh
```

---

## Rollback procedure

To completely revert dotfiles back to the original bash implementation:

```bash
# 1. Remove symlinks and restore backups
rm -f ~/dots/bin/wt ~/dots/bin/wtm
mv ~/dots/bin/wt.bak ~/dots/bin/wt
mv ~/dots/bin/wtm.bak ~/dots/bin/wtm

# 2. Reverse the shell wrapper patch
patch -R -p1 -d ~/dots < dots-integration/git.zsh.patch

# 3. Reload shell functions
source ~/dots/zsh/custom/git.zsh
```
