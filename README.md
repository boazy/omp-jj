# omp-jj

JJ-native OMP extension: repository-scoped context, mutation-boundary snapshots with
session-linked recovery, toggleable workflows, repository health, guardrails, grouped PR
publication with stacks, and JJ workspace actions through a bundled fallback.

## Install

### 1. Register the extension

Place (or symlink) this package where OMP discovers extensions, keeping the
`omp.extensions: ["./src/index.ts"]` entry in `package.json` intact:

```bash
ln -s /path/to/omp-jj ~/.omp/agent/extensions/omp-jj
```

Verify it loads (label `jj`), then see MIGRATION.md if you are replacing the
legacy `jj-snapshot` extension — keep the old one active until this one is
verified, and never register both at once.

### 2. Place the skills

The extension ships five skills under `skills/` (`jj-pr`, `jj-stacked-pr`,
`jj-atomic`, `jj-recovery`, `jj-isolation`) in standard `SKILL.md` layout. Put
them on OMP's skill path so the `skill` tool can load them by name:

```bash
# user scope (all projects)
for s in jj-pr jj-stacked-pr jj-atomic jj-recovery jj-isolation; do
  ln -s /path/to/omp-jj/skills/$s ~/.omp/agent/skills/$s
done
# or project scope: <project>/.omp/skills/<name>
```

The short prompt context references these skill names; full workflows live there.

### 3. Workspace fallback

`/jj-workspace` invokes `helper/jj-workspace.py` directly. The dependency-free
fallback supports `root`, `list`, `select`, `main`, `add`, and `remove` for JJ
workspaces. Run the script directly for CLI use; every command also supports
`--json` for the extension.

The full `wt` CLI is maintained separately and is not required on `PATH`.
The fallback reads the same `workspace_dir` configuration so both tools place
workspaces consistently.

## Toggles

Session-scoped, persisted for resume. Each supports bare (toggle), `on`,
`off`, `status`, and always reports the effective state immediately.

| Command | Controls |
| --- | --- |
| `/jj` | Master switch. Off suspends context injection, snapshots, guardrails, and mutating commands. Records are kept. |
| `/jj-snapshots` | Automatic capture plus session-linked recovery actions. Off suspends both; records are kept for re-enablement. |
| `/jj-explain` | Extra narrative for history-operation scope. Off suppresses presentation only — checks, validation, and authorization stay on. |

Missing `jj` or a non-JJ target is *inactive*, never a reason to initialize a
repository or mutate Git: `JJ: inactive (not a JJ repository)`.

## Commands

| Command | Purpose |
| --- | --- |
| `/jj-recover list` | Session checkpoints grouped by user request (pre/post tool boundaries, session boundaries). |
| `/jj-recover files <n> [-- paths] [--apply]` | Preview, then restore file contents without rewinding bookmarks. |
| `/jj-recover state <n> [--apply --confirm <op>]` | Preview (op diff + impact), then restore whole-repository state with explicit authorization. |
| `/jj-health` | Read-only inspection: availability, identity, conflicts, PR consistency, snapshot gaps, hooks/LFS/submodules, ownership baseline. Never repairs, fetches, or publishes. |
| `/jj-pr status\|policy\|map\|unmap\|preview\|publish` | Grouped-change PRs: explicit bookmark groups, presets, preview-then-authorized narrow push + `gh` metadata. |
| `/jj-stack preview\|publish\|restack` | Bottom-up stack publication and merge-method-aware restacking. |
| `/jj-workspace root\|list\|select\|main\|add\|remove` | Read the configured root and manage JJ workspaces through the bundled fallback. Add and remove use previews and explicit authorization. |

Every mutating command previews first and refuses drifted or missing
authorization with zero side effects. Conversation navigation never restores
files; restores never undo pushes/PRs and never auto-fetch remotes.

## Recovery model

Each extension-managed capture that records restorable state persists a
checkpoint entry: repo/workspace identity, exact commit + operation IDs,
tool-call linkage (call id, pre/post boundary), capture outcome, and the user
request it belongs to. Read-only requests leave no checkpoints; unchanged
captures share the operation ID; nothing is ever created (no changes, no
bookmarks) just to manufacture a checkpoint. File restore rewinds contents
only; state restore rewinds the repo to an operation (shown with impact first).
A pre-restore checkpoint is captured whenever possible, so every restore is
itself recoverable. Unavailable state is reported, never replaced by a nearby
revision.

## PR policies

Presets (`/jj-pr policy [single|atomic|per-round]`):

- `single` — continuously single-commit PR, rewrite updates, restacking permitted.
- `atomic` — atomic multi-commit PRs, rewrite updates, restacking permitted.
- `per-round` — one initial commit plus one commit per review round, rewriting published SHAs prohibited.

Mappings (bookmark → base + explicit change list) persist shared-repo-scoped
beside the JJ store, validate against `jj` and `gh` before publication, and go
stale honestly when split/squash replaces change IDs. A stack is an explicit
chain of mapped groups; chain breaks stop publication before the first push.

## Workspace configuration

The fallback reads `workspace_dir` from these files, in order:

1. `~/dots/config/wt.toml`
2. `<primary-workspace>/.local/wt.toml`

The repository-local value overrides the global value. Relative paths resolve
from the primary workspace. If neither file configures the directory, the
fallback uses `<primary-workspace>/.local/workspaces`.

`jj workspace add` owns creation. `/jj-workspace root` reports the resolved
directory before any changes.

## Configuration defaults

New sessions start fully on (`master/snapshots/explain: true`). The PR preset
defaults to `atomic` per shared repo (`/jj-pr policy` persists it). Workspace
placement follows the `workspace_dir` configuration described above.
