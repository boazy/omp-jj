# Unified `wt` / `wtm` Workspace Helper

One command behind the familiar `wt` and `wtm` workflows across **JJ** and **Git** repositories.

- **JJ repos** (including colocated): workspaces live at `~/.local/workspaces/<repo-key>/<name>`
  - `<repo-key>` is `<primary-dir>-<hash8>`, derived from the shared repo store so two clones of the same remote never collide while any workspace of the same repo resolves identically.
  - Managed root override: set `WT_WORKSPACES_HOME` in your environment.
- **Git repos** (no `.jj`): worktrees live at `$MAIN_REPO/.local/trees/<name>`
  - `$MAIN_REPO` is the main worktree root (first entry of `git worktree list --porcelain`), not relative to whichever linked worktree you are inside.

Discovery is deterministic: walking up from `$PWD`, a `.jj` directory wins even when colocated with `.git`. Discovery failure is an error, never a silent backend switch.

---

## Shell contract

The helper executable **prints selected paths** to standard output and exits:

- It **cannot** change the calling shell's directory (`cd` is a shell builtin).
- It prints **only the resolved path** on `select` (and `main` / `wtm`) so wrappers can safely capture stdout.
- Diagnostics, notes, warnings, and prompts flow to `stderr`.
- On error: prints a clear explanation to `stderr` and exits `1`. **Never prints a partial or misleading path to `stdout`.**
- On interactive cancellation (`Esc` or `Ctrl-C` in `fzf`): emits **no output** and exits `2`.

### Shell wrapper configuration

Update or replace the functions in `~/dots/zsh/custom/git.zsh` (or `~/.bashrc`):

```zsh
# Wrapper for wt (unified workspace / worktree manager)
function wt() {
  local cmd="$1"
  if [[ "$cmd" == "cd" ]]; then
    shift
    local dir
    # Exit 2 (cancellation) or 1 (error) prevents cd
    dir="$(command wt select "$@")" || return $?
    [[ -n "$dir" ]] && cd "$dir"
    return 0
  fi
  command wt "$@"
}

# cd to the primary checkout/workspace, mirroring the current subdirectory
function wtm() {
  local dir
  dir="$(command wt main "$@")" || return $?
  [[ -n "$dir" ]] && cd "$dir"
}
```

---

## Dotfiles installation / linking

Keep the helper inside this repository deliverable and symlink it into your dotfiles bin:

```bash
# Executable permissions are already set (+x), but verify:
chmod +x /Users/boaz.yaniv/projects/small/agent-extensions/omp-jj/helper/wt.py
chmod +x /Users/boaz.yaniv/projects/small/agent-extensions/omp-jj/helper/wtm.py

# Symlink into ~/dots/bin (or any PATH directory):
ln -sf /Users/boaz.yaniv/projects/small/agent-extensions/omp-jj/helper/wt.py ~/dots/bin/wt
ln -sf /Users/boaz.yaniv/projects/small/agent-extensions/omp-jj/helper/wtm.py ~/dots/bin/wtm
```

Because `wt.py` includes a self-contained PEP 723 metadata block and `#!/usr/bin/env -S uv run --script` shebang, it runs with zero virtualenv setup on any machine with `uv` (or Python ≥ 3.14).

---

## Subcommands and flags

| Command | Aliases | Purpose |
|---|---|---|
| `list` | `ls` | List registered worktrees/workspaces. Default: managed only. Pass `-a` / `--all` to include external locations. |
| `select` | `sel` | Print the path of a worktree. Interactively picks via `fzf` if `[name]` is omitted. |
| `cd` | — | Shell contract guard: fails with an actionable message directing to the shell wrapper. |
| `add` | — | Create a new worktree/workspace under the managed root. Names must not escape (`/`, `..`, absolute paths rejected). |
| `remove` | `rm` | Remove a worktree/workspace. Safeguards refuse dirty/untracked states without `--force`. |
| `copy` | `cp` | Copy the worktree path to the clipboard via `platform-copy`. Pass `-r` / `--relative` for cwd-relative. |
| `main` | `wtm` | Resolve primary checkout/workspace, mirroring the current relative sub-directory if it exists there. |

### Global flags

- `-a`, `--all`: Include external / non-managed locations (e.g. primary checkouts, manually placed workspaces).
- `-f`, `--force`: Override dirty/untracked safeguards and nested-destination warnings.
- `-r`, `--from`, `--revision`: (on `add`) Explicit base revision. Defaults to `@` in JJ repos, `HEAD` in Git repos.
- `-r`, `--relative`: (on `copy`) Copy relative path based on `$PWD`.
- `--delete-dir`: (on `remove`) Also delete the directory on disk for JJ workspaces (requires `--force`).
- `--json`: Machine-readable JSON output for the TypeScript extension.

---

## Safeguards and placement rules

### Nested-destination guard

Before creating a workspace at `<dest>`, the helper walks upward from `<dest>` checking for `.jj` or `.git` boundaries:

- Refuses creation if `<dest>` lies under **any** existing repository (including a home-directory dotfiles repo or an existing `.local/trees`), **unless** effective ignore coverage can be verified via `git check-ignore`.
- If ignore coverage cannot be verified, creation is blocked unless `--force` is provided, preventing accidental auto-snapshotting or commit-sweeps of foreign repositories.
- Re-checks existing registrations before creation to refuse collisions.

### Removal safeguards

- **JJ repos:** inspects the target workspace's working copy (`jj st`) and compares tracked files against disk:
  - Refuses without `--force` if the working copy has unsnapshotted edits, conflicts, or untracked/ignored files.
  - Native removal runs `jj workspace forget <name>`.
  - **Never implicitly abandons or deletes commits.** Working-copy changes remain in JJ's repository history and can be inspected via `jj log`.
  - Directory deletion is **not automatic**: use `--delete-dir --force` if you want the disk directory wiped.
- **Git repos:** inspects `git status --porcelain --ignored`:
  - Refuses without `--force` if the worktree contains modified, untracked, or ignored files.
  - Native removal runs `git worktree remove [--force]`.
  - Prunes stale registrations if the directory was already deleted outside Git.
- **Primary protection:** refuses to remove the primary workspace or main Git worktree.

### Dual-registration deduplication

In colocated repositories where both JJ and Git might report the same canonical directory, the inventory outputs a single row: `backend=jj`, with Git capability noted (`[also registered as git worktree]`).

---

## Machine-readable mode (`--json`)

Used by the OMP JJ extension:

```bash
wt list --json
wt list --json -a
wt select <name> --json
wt main --json
```

Sample `wt list --json` output:

```json
[
  {
    "backend": "jj",
    "name": "feat-x",
    "branch": "feat-x",
    "change": "plqrxmtlpoky",
    "state": "clean",
    "path": "/Users/boaz.yaniv/.local/workspaces/omp-jj-a1b2c3d4/feat-x",
    "managed": true,
    "primary": false,
    "stale": false,
    "note": ""
  }
]
```
