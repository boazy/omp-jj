# omp-jj

An OMP extension for Jujutsu (`jj`) repositories. It adds repository context to each prompt,
captures restorable state at mutation boundaries, and links those checkpoints to two recovery
workflows: file-content restores and whole-repository restores. It also provides guarded history
editing, PR publication for explicit change groups and stacks, a read-only health report, and JJ
workspace management.

The extension registers under the label `jj`. Without a `jj` binary or inside a non-JJ directory
it stays inactive: it never initializes a repository and never mutates Git.

## Requirements

| Tool | Needed for |
| --- | --- |
| `jj` | All functionality. Without it the extension reports `JJ: inactive (jj not installed)` and does nothing. |
| `gh` | Required for GitHub PR metadata in `/jj-pr` and `/jj-stack`. |
| `uv` | `/jj-workspace` only. The bundled helper runs as a PEP 723 script through `uv run --script` and declares Python 3.14 or newer. |

## Install

```bash
omp plugin install git+https://github.com/boazy/omp-jj
```

The install registers the extension entry declared in `package.json#omp.extensions`
(`./src/index.ts`) and places the bundled `skills/` directory where the `omp-plugins` skill
provider discovers it. Restart OMP to load the extension; the label is `jj`. Nothing needs to be
copied into `~/.omp/agent/extensions` or `~/.omp/agent/skills`; a second copy would load the
extension twice and snapshot every boundary twice.

Pass `--scope project` to install into the current project (`.omp/plugins`) instead of the user
plugin root.

To pin a revision, append the commit to the spec:

```bash
omp plugin install git+https://github.com/boazy/omp-jj#<commit-sha>
```

To work from a local checkout, link it instead of copying. From the checkout root, remove an
installed copy first (`omp plugin uninstall omp-jj`, then delete a leftover
`~/.omp/plugins/node_modules/omp-jj` directory), then run `omp plugin install .`.

To update, run `omp plugin install` again with the spec you want. There is no separate update
command; the new spec replaces the recorded dependency. To remove the extension, run
`omp plugin uninstall omp-jj`.

If you are replacing the legacy `jj-snapshot` extension, only one snapshot engine may run at a
time. Disable the legacy engine before the first session with this extension: add
`- extension-module:jj-snapshot` under `disabledExtensions` in `~/.omp/agent/config.yml`, or move
`~/.omp/agent/extensions/jj-snapshot` out of that directory. Leave it installed as a fallback.

Verify the new engine as [MIGRATION.md](MIGRATION.md) describes, then delete the legacy
registration. To fall back instead, run `omp plugin disable omp-jj` and re-enable the legacy
entry.

## Toggles

All three commands are session-scoped and persist across resume. Each accepts a bare toggle,
`on`, `off`, or `status` and reports the resulting state immediately.

| Command | Controls |
| --- | --- |
| `/jj` | Master switch. Off suspends prompt context, snapshots, guardrails, and mutating commands; existing records are kept. |
| `/jj-snapshots` | Automatic capture and session-linked recovery. Off suspends both; existing records are kept for re-enablement. |
| `/jj-explain` | Extra narrative for history-operation scope. Off suppresses presentation only; checks, validation, and authorization stay on. |

Missing `jj` or a non-JJ target makes the extension inactive and reports the reason, for example
`JJ: inactive (not a JJ repository)`.

## Commands

| Command | Purpose |
| --- | --- |
| `/jj-recover list` | List session checkpoints grouped by user request, covering pre/post tool boundaries and session boundaries. |
| `/jj-recover files <n> [-- <paths>] [--apply]` | Preview or apply a file-content restore; bookmarks stay where they are. |
| `/jj-recover state <n> [--apply --confirm <op>]` | Preview or apply a whole-repository restore to one recorded operation. |
| `/jj-health` | Inspect the repository without changing it. |
| `/jj-pr status\|policy\|map\|unmap\|preview\|publish` | Manage grouped-change PRs. |
| `/jj-stack preview\|publish\|restack` | Publish a stack bottom-up, then restack it after a merge. |
| `/jj-workspace root\|list\|select\|main\|add\|remove` | Read the configured workspace root and manage JJ workspaces through the bundled helper. |

`/jj-health` covers availability, identity, conflicts, PR consistency, snapshot coverage, hooks,
LFS, submodules, and the ownership baseline. It never repairs, fetches, or publishes.

Every command that mutates the repository previews its effect first. A preview whose state has
drifted, or a publication without the matching confirm token, stops with no side effects.
Conversation navigation never restores files, restores never undo a push or a PR, and no command
fetches a remote on its own.

## Recovery model

Each capture that records restorable state writes one checkpoint entry. The entry holds the
repository and workspace identity, the exact commit and operation IDs, the tool call it belongs
to, the capture outcome, and the user request it belongs to.

- Read-only requests leave no checkpoints.
- An unchanged capture shares the operation ID of the capture that already recorded state.
- The extension never creates a change or a bookmark to manufacture a checkpoint.
- A file restore rewinds file contents only and never moves a bookmark.
- A state restore rewinds the repository to a recorded operation, after showing the operation
  diff and its impact.
- A pre-restore checkpoint is captured whenever possible, so a restore is itself recoverable.
- State that is no longer available is reported. The extension never substitutes a nearby
  revision for a missing one.

## PR policies

`/jj-pr policy [single|atomic|per-round]` selects one of three presets:

- `single` keeps one commit in the PR tip, allowing rewrite updates and restacking.
- `atomic` keeps a multi-commit PR with rewrite updates and restacking.
- `per-round` publishes one initial commit, then one commit per review round, and prohibits
  rewriting published SHAs.

A mapping records a bookmark, its base, and an explicit change list. Mappings are stored in the
shared JJ store at `<store>/omp-jj/pr.json`, so every workspace of the same repository sees the
same mappings. They are validated against `jj` and `gh` before publication.

A split or squash replaces change IDs and leaves the mapping stale. The extension reports that
and requires you to map the group again; it never reinterprets a stale mapping.

Publication previews the change set first, then pushes narrow refs (`jj git push --bookmark`)
and manages PR metadata with `gh`. A stack is an explicit chain of mapped groups, and a break in
the chain stops publication before the first push.

## Skills

The five bundled skills load from the plugin install and are readable by name through
`skill://<name>`. The prompt context references them; the full workflows live in the skill text.

| Skill | Covers |
| --- | --- |
| `jj-pr` | Publishing a change group as a GitHub PR with explicit bookmark, base, and policy checks. |
| `jj-stacked-pr` | Publishing and maintaining a stack of change groups as chained PRs. |
| `jj-atomic` | Shaping working-copy edits into atomic commits with absorb, split, and squash. |
| `jj-recovery` | Recovering files or repository state from session-linked snapshots. |
| `jj-isolation` | Isolating risky work in a separate workspace under the managed root. |

## Workspaces

`/jj-workspace` runs the bundled `helper/jj-workspace.py`, a dependency-free script that needs
`uv` on `PATH`. It supports `root`, `list`, `select`, `main`, `add`, and `remove`; adding and
removing require a preview and explicit authorization. Run the script directly for command-line
use, and pass `--json` for machine-readable output.

The helper reads the same `workspace_dir` configuration as the separate `wt` CLI, which is not
required on `PATH`. Resolution order:

1. `~/dots/config/wt.toml`
2. `<primary-workspace>/.local/wt.toml`

The repository-local value overrides the global one, and relative paths resolve from the primary
workspace. If neither file sets the directory, the helper uses
`<primary-workspace>/.local/workspaces`. `jj workspace add` owns creation.
`/jj-workspace root` prints the resolved directory before you change anything.

## Configuration defaults

A new session starts with all three toggles on (`master`, `snapshots`, and `explain`). The PR
preset defaults to `atomic` and is stored per shared repository.
