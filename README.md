# omp-jj

JJ-native OMP extension: repository-scoped context, mutation-boundary snapshots with
session-linked recovery, toggleable workflows, repository health, guardrails, grouped PR
publication with stacks, and unified workspace actions through the bundled helper.

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

### 3. Link the workspace helper (optional, for `wt` / `/jj-workspace`)

The helper stays in this repo at `helper/wt.py`. Linking it into a PATH
directory and wiring shell wrappers is a dotfiles change owned separately —
see `helper/README.md` and `dots-integration/` (dry-run installer, wrapper
patch, rollback). The extension resolves the bundled copy directly, so
`/jj-workspace` works with or without the symlinks. Do not hand-edit
`~/dots/bin/wt`, `wtm`, or shell integration as part of this install; that is
a separate workstream.

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
| `/jj-workspace list\|select\|main\|add\|remove` | Workspace actions through the helper contract (preview + explicit auth for add/remove). |

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

## Workspace layouts

- JJ (including colocated): `~/.local/workspaces/<repo-key>/<name>` (`WT_WORKSPACES_HOME` overrides).
- Git (no `.jj`): `$MAIN_REPO/.local/trees/<name>`.

`jj workspace add` owns creation; colocated directories list once as
JJ-managed. See `helper/README.md` for placement, collision,
nested-destination, and removal safeguards — the extension never reimplements
them.

## Configuration defaults

New sessions start fully on (`master/snapshots/explain: true`). The PR preset
defaults to `atomic` per shared repo (`/jj-pr policy` persists it). Managed
workspace home follows the helper (`WT_WORKSPACES_HOME` or
`~/.local/workspaces`).
