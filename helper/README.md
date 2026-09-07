# Unified `wt` and `wtm` Workspace Helper

The `wt` and `wtm` tools manage workspaces and worktrees across Jujutsu (JJ) and Git repositories from a single command interface.

## Managed roots

- **JJ repositories (including colocated checkouts):** Workspaces live at `~/.local/workspaces/<repo-key>/<name>`.
  - `<repo-key>` is `<primary-dir>-<hash8>`, derived from the shared repository store so distinct clones of the same repository never collide.
  - To override this directory, set `WT_WORKSPACES_HOME` in your environment.
- **Git repositories (without `.jj`):** Worktrees live at `$MAIN_REPO/.local/trees/<name>`.
  - `$MAIN_REPO` is the main worktree root reported by `git worktree list --porcelain`.

Backend discovery is deterministic. When walking up from `$PWD`, the helper selects `.jj` before `.git`. If discovery fails, the helper exits with an error instead of switching backends.

## Shell contract

Because `cd` is a shell builtin, the executable prints paths to standard output and leaves directory changes to the shell wrapper.

- On `select` and `main`, the helper prints only the resolved target path to standard output.
- The helper sends warnings, prompts, and error messages to standard error.
- On error, the helper prints an explanation to standard error and exits with code `1`. It writes nothing to standard output.
- When an interactive selection is canceled (`Esc` or `Ctrl-C` in `fzf`), the helper writes nothing to standard output and exits with code `2`.

### Shell wrapper configuration

Add or update these wrapper functions in `~/dots/zsh/custom/git.zsh` or your shell configuration:

```zsh
# Wrapper for wt (unified workspace and worktree manager)
function wt() {
  local cmd="$1"
  if [[ "$cmd" == "cd" ]]; then
    shift
    local dir
    # Exit code 2 (cancellation) or 1 (error) aborts cd
    dir="$(command wt select "$@")" || return $?
    [[ -n "$dir" ]] && cd "$dir"
    return 0
  fi
  command wt "$@"
}

# Change directory to the primary checkout or workspace, mirroring the current subdirectory
function wtm() {
  local dir
  dir="$(command wt main "$@")" || return $?
  [[ -n "$dir" ]] && cd "$dir"
}
```

## Installation

Copy the helper scripts and documentation into `~/dots/bin` (or another directory in your `PATH`):

```bash
# Copy the helpers and documentation:
cp ~/projects/small/agent-extensions/omp-jj/helper/wt.py ~/dots/bin/wt
cp ~/projects/small/agent-extensions/omp-jj/helper/wtm.py ~/dots/bin/wtm
cp ~/projects/small/agent-extensions/omp-jj/helper/README.md ~/dots/bin/wt.readme.md

# Set executable permissions:
chmod +x ~/dots/bin/wt ~/dots/bin/wtm
```
The scripts contain PEP 723 metadata and a `#!/usr/bin/env -S uv run --script` shebang. Direct execution requires `uv` on `PATH`. Explicit invocation via `python3 <script>` requires Python 3.14 or later.

## Commands and options

| Command | Aliases | Purpose |
|---|---|---|
| `list` | `ls` | List registered workspaces or worktrees. Lists managed paths by default. Pass `-a` or `--all` to include external locations. |
| `select` | `sel` | Print the path of a workspace. Opens an interactive `fzf` prompt when `[name]` is omitted. |
| `cd` | — | Guard command. Rejects direct execution with instructions to use the shell wrapper. |
| `add` | — | Create a workspace under the managed root. Rejects path traversal (`/`, `..`, absolute paths). |
| `remove` | `rm` | Remove a workspace. Rejects dirty or untracked state unless `--force` is passed. |
| `copy` | `cp` | Copy the workspace path to the clipboard using `platform-copy`. Pass `-r` or `--relative` for a path relative to `$PWD`. |
| `main` | `wtm` | Print the primary checkout path, mirroring the current relative subdirectory when it exists there. |

### Global flags

- `-a`, `--all`: Include external or unmanaged locations, such as primary checkouts or manually created workspaces.
- `-f`, `--force`: Bypass dirty state, untracked file safeguards, and nested-destination warnings.
- `-r`, `--from`, `--revision`: (For `add`) Base revision for the new workspace. Defaults to `@` in JJ repositories and `HEAD` in Git repositories.
- `-r`, `--relative`: (For `copy`) Output a relative path based on `$PWD`.
- `--delete-dir`: (For `remove`) Delete the directory from disk for JJ workspaces. Requires `--force`.
- `--json`: Output machine-readable JSON for the OMP extension.

## Safeguards and placement rules

### Nested destination guard

Before creating a workspace at `<dest>`, the helper walks upward from `<dest>` to inspect parent directory boundaries:

- If `<dest>` lies inside an existing Git or JJ repository, the helper verifies ignore coverage using `git check-ignore`.
- If the path is not ignored, the helper refuses creation unless `--force` is provided. This prevents accidental commit sweeps or snapshots of foreign repositories.
- The helper checks existing registrations and rejects colliding workspace names.

### Removal safeguards

- **JJ repositories:** The helper inspects working copy status via `jj status` and compares files on disk against tracked repository files:
  - If the working copy contains uncommitted edits, conflicts, or untracked or ignored files on disk, the helper requires `--force`.
  - Removal executes `jj workspace forget <name>`.
  - JJ retains commit history in the repository store. Forgetting a workspace does not delete commits.
  - The helper preserves the directory on disk unless both `--delete-dir` and `--force` are passed.
- **Git repositories:** The helper inspects `git status --porcelain --ignored`:
  - If the worktree contains modified, untracked, or ignored files, the helper requires `--force`.
  - Removal executes `git worktree remove`.
  - If the directory was already deleted outside Git, the helper prunes the stale registration.
- **Primary workspace protection:** The helper refuses to remove the primary workspace or main Git worktree.

### Colocated repository deduplication

When JJ and Git manage the same checkout, the inventory outputs a single row:

- `backend` is set to `"jj"`.
- `note` records `"[also registered as git worktree]"`.

## Machine-readable mode (`--json`)

The OMP JJ extension queries the helper through `--json`:

```bash
wt list --json
wt list --json -a
wt select <name> --json
wt main --json
```

Example output from `wt list --json` (paths in actual output are expanded absolute paths; `~` is shown below for brevity):

```json
[
  {
    "backend": "jj",
    "name": "feat-x",
    "branch": "feat-x",
    "change": "plqrxmtlpoky",
    "state": "clean",
    "path": "~/.local/workspaces/omp-jj-a1b2c3d4/feat-x",
    "managed": true,
    "primary": false,
    "stale": false,
    "note": ""
  }
]
```
