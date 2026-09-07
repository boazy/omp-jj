# OMP JJ extension implementation plan

Status: agreed feature direction; implementation has not started.

## Goal

Turn `~/.omp/agent/extensions/jj-snapshot` into a JJ-native OMP extension. Make repository state, change ownership, PR history policy, and recovery options explicit without recreating the entire JJ CLI or imposing Git's staged-index workflow.

This repository will own the extension package and its bundled instructions. The workspace-navigation work also affects `~/dots/bin/wt`, its shell integration, and the existing worktree skill. Those integrations are part of the deliverable, not optional follow-up work.

## Settled decisions

| Area | Decision |
| --- | --- |
| Instructions | Automatically provide short, repository-scoped JJ context; load detailed workflows through bundled skills. |
| Local workflow | Encourage describe intent, edit and verify, refine description, then `jj new` at a coherent boundary. |
| Atomic changes | Use `jj absorb`, `jj split`, and `jj squash` selectively, subject to ownership and published-history policy. |
| PRs | Support one or several changes per PR, single PRs and stacks, and user-selectable commit/review policies. |
| Snapshots | Keep mutation-tool boundaries. Do not snapshot when displaying a prompt or computing autocomplete. |
| Recovery | Make session-linked recovery the interface to the existing snapshot mechanism. |
| JJ workspace location | `~/.local/workspaces/<repo-key>/<name>`. This is a home-level directory, not a directory inside each repository. |
| Git worktree location | Preserve the existing skill's `$MAIN_REPO/.local/trees/<name>` convention. Do not move existing Git worktrees. |
| Workspace navigation | Keep `wt` as the common interface for JJ workspaces and Git worktrees. |
| Toggles | Separate controls for the whole extension, snapshots plus recovery, and history explanations. |
| Palette state | Use the supported autocomplete-provider wrapper for live state; retain static descriptions as a compatibility fallback. Always report status after a toggle. |
| VCS status display | Defer the colocated-repository `detached` issue to the upstream OMP fix. No local display workaround. |
| Extra features | Include session-linked recovery, repository health checks, explicitly requested isolation, and explainable history editing. |

### Non-goals

- No automatic conversion of existing repositories, remote publication, workspace creation, or workspace deletion merely because a session opens or finishes.
- No automatic `jj new`, description replacement, or history reshaping after every prompt or agent response.
- No automatic translation of arbitrary Git shell commands into JJ commands.
- No Git HEAD reattachment to make a colocated repository look like a conventional Git checkout.
- No guarantee that regex rules intercept every process the model could launch.
- No replacement footer, monkey-patching of OMP's VCS detector, or extension-owned fix for the deferred status-display bug.

## Verified feasibility and compatibility

The investigation used OMP 18.1.12 and JJ 0.45.1. Recheck the installed APIs and command capabilities when implementation starts; do not assume that every Pi extension API is implemented identically in OMP.

### Live toggle descriptions do not require an upstream change

`registerCommand` exposes a static description rather than the callback used by built-in `/advisor`. However, the public `ctx.ui.addAutocompleteProvider(factory)` API lets an extension wrap the current provider.

A disposable extension was exercised in the installed OMP TUI:

1. Opening the palette showed `Palette probe: off`.
2. Executing its slash command displayed `Palette probe toggled: on`.
3. Reopening the palette showed `Palette probe: on`, without reloading OMP.

The wrapper decorated only its own command suggestions and delegated other provider methods. Both asynchronous suggestions and synchronous slash completion need coverage. Headless modes do not render this UI.

Therefore the condition for opening an upstream enhancement ticket was not met, and no ticket was opened. Keep a static registered description and immediate command feedback regardless. On hosts without the supported wrapper, use that static description rather than private API access.

### Other OMP boundaries

- `before_agent_start` supports per-prompt model context; `context` supports context transformation before provider calls. Model context and TUI status are separate surfaces.
- There is no dedicated public extension event for every cwd/additional-directory transition in the inspected version. Recheck cwd on later events and discover newly targeted repositories through tool activity.
- `resources_discover` has types and a runner method but no active session callers in the inspected runtime. Do not rely on it for loading bundled skills.
- Repository-aware `tool_call` hooks are the primary guardrails. Globally installed TTSR rules do not have a filesystem predicate that reliably distinguishes JJ from ordinary Git targets.

### Native JJ workspace creation

Let `jj workspace add` own creation. Do not independently call `git worktree add` for the same destination.

In an isolated JJ 0.45.1 probe, a colocated primary repository produced a secondary JJ workspace without `.git` metadata or a paired Git worktree registration. Do not assume all JJ versions create colocated secondary workspaces. If a supported version creates dual registrations, list the directory once and keep JJ as its management backend.

## Repository context and instruction delivery

### Repository identity and discovery

Use the existing snapshot extension's nearest-workspace resolution as the starting point. Extend it to maintain separate identities for:

- The shared JJ repository.
- Each workspace root and workspace name.
- The session and conversation branch currently using it.

Detect `.jj` ownership even when `.git` is colocated. Do not reuse OMP's Git-first colocated classification as the instruction or workspace-management policy.

Resolve targets from session cwd, explicit tool paths, cwd overrides, and supported repository flags. Canonicalize paths and distinguish nested repositories. One session may contain both JJ and ordinary Git roots; JJ rules apply only to the relevant targets.

Refresh context on session start/switch/resume and when cwd or targeted roots change. Before the first mutation in a newly encountered JJ repository, ensure the model has received its JJ instructions and ownership constraints. A directory already added to a session must become discoverable without requiring a new session; if the host does not expose the full directory set, identify roots on first access and before mutation.

Subagents should receive the applicable instructions and initial feature settings through normal extension loading. Keep mutable state session-scoped rather than in a process-global singleton. Missing JJ or a non-JJ target makes repository actions inactive, not a reason to initialize or fall back to mutating Git.

### Instruction layers

1. **Short automatic context:** repository/workspace identity, working change, pre-existing work, selected PR policy, and the few workflow constraints needed immediately.
2. **Bundled skills:** ordinary PRs, stacked PRs, atomic history editing, recovery, and workspace isolation.
3. **Structured tools:** state and health inspection, recovery selection, history-operation previews, and publication workflows where exact revision selection matters.
4. **Hooks:** repository-aware command checks and snapshot boundaries.

Keep stable instructions separate from changing state. Refresh state without repeatedly inserting a complete JJ guide into the system prompt. Reconstruct applicable state on resume and after compaction; do not depend solely on a one-time conversational reminder.

Explicitly scope existing Git, Git-worktree, and `gh-stack` guidance so it does not prescribe Git mutation workflows for JJ roots. Do not inject a session-wide prohibition against Git when another target is an ordinary Git repository.

Load packaged skills through a supported OMP package/discovery mechanism. The repository context should direct the model to the relevant skill; it must not depend on the currently inactive `resources_discover` event.

## Changes, ownership, and explainable history editing

### Describe-before-work

Encourage this loop:

```text
describe intent -> edit and verify -> refine description -> jj new
```

Give a reminder before the first agent-owned mutation of an undescribed working change. Do not rename or replace descriptions of pre-existing user work. Read-only investigations require no new change or description. Session and prompt boundaries are not automatically change boundaries.

Record the initial working-copy state before agent mutations. Use that baseline and explicit user instructions to distinguish continuing an existing change from starting unrelated work. Never infer ownership merely because a file is in `@`.

### Atomic changes

- Use `absorb` for corrections whose owning ancestor is clear. Limit destinations to the relevant, owned changes that policy permits rewriting. Inspect the operation result; line attribution is not proof of semantic ownership.
- Use `split` to separate independently understandable concerns. Support noninteractive file selection and a controlled, inspectable route for same-file hunk selection; do not depend on an unattended interactive editor.
- Use `squash` to combine one concern, fold corrections into their owner, or produce a selected single-commit publication shape.
- Leave ambiguous edits in place and explain what could not be assigned confidently. Do not force every edit through every command.
- Check the resulting patch boundaries and run the relevant verification when history editing changes intermediate commit contents.

These rules are best-effort semantic guidance, not a claim that tooling can prove atomicity. Published review-round policy takes precedence over splitting one published round into several commits.

### Explanations and execution

For consequential history operations, identify the source and destination changes, affected descendants/bookmarks, and associated PRs. Explain whether published commits will be rewritten and which review rounds remain intact.

Use the same explicit targets for preview and execution. Revalidate the relevant repository state before acting; if it changed, stop and refresh the preview rather than executing stale intent. Do not use an unscoped latest-operation undo as an automatic rollback after concurrent activity.

Turning explanations off suppresses the extra narrative/preview presentation. It does not disable ownership checks, revision validation, immutable protections, or required authorization.

Use argument arrays and deliberate noninteractive flags. Ordinary JJ CLI operations remain available; do not build a generic wrapper for every subcommand.

## Snapshots and session-linked recovery

### One capture mechanism

Evolve the current snapshotter rather than adding a second checkpoint engine.

- Preserve pre-mutation snapshots and the post-execution boundaries required for batched synchronous mutations.
- Preserve path scoping across multiple workspaces and the existing staged AST rewrite/resolve handling.
- Keep opaque or background work explicitly coarse-grained. A tool result that merely starts a process is not a completed-work checkpoint.
- Keep bounded snapshot execution, per-root coordination, and visible diagnostics for failure or skipped files. Do not introduce UI-refresh snapshots.
- Replace the current fire-and-forget metadata contract with an explicit capture outcome: successful state reference, unchanged state, partial coverage, or failed/skipped capture.
- Associate identifiers with a consistent recorded repository view. Do not race a snapshot against an unrelated later operation and label that later operation as the checkpoint.

A display or passive inspection can use `--ignore-working-copy`. Explain that this reads recorded state and may be stale. Commands that intentionally edit history continue to use JJ's normal working-copy behavior.

### Session records

Persist checkpoint metadata in namespaced OMP session entries. Each record needs the repository/workspace identity, exact commit/change/operation identifiers, conversation entry and tool-call linkage, boundary kind, and capture outcome.

Use exact commit and operation IDs for recovery. A change ID identifies an evolving change and is not sufficient to restore an earlier version.

Group checkpoints under each user request, exposing before/after states and optional intermediate tool boundaries. Read-only requests need no artificial checkpoint. Unchanged states can share identifiers; do not create changes or bookmarks solely to manufacture checkpoints.

Reconstruct the index when sessions resume, fork, or navigate their trees. Keep checkpoint association separate from filesystem restoration. Validate whether referenced state is still available; session metadata does not guarantee indefinite retention of JJ objects.

### Recovery actions

Provide a session-linked picker/command with two distinct actions:

- Restore file contents, optionally selected paths, without rewinding bookmark positions.
- Restore repository state, explicitly showing affected heads, bookmarks, and workspaces.

Before a restore, inspect current state and capture a recoverable pre-restore state when possible. Show unrelated or subsequently created work at risk. Missing or incomplete checkpoint state must be reported, not silently replaced by a nearby revision.

Conversation navigation must not automatically change files. Whole-repository restoration requires explicit authorization and consideration of other sessions/workspaces. It does not undo pushes or PR changes, and must not automatically fetch remotes as a hidden recovery side effect.

Disabling the snapshots feature suspends both extension-managed capture and its recovery actions. Keep existing records for later re-enablement. Normal JJ commands may still snapshot; this switch does not alter JJ itself.

## PRs and stacked PRs

### Policy and identity

Model a PR as an explicit group of changes with a bookmark at its tip. A PR may contain one or several changes, and a stack is a chain of these groups. Do not assume one change equals one PR or infer a linear stack from every mutable ancestor/descendant.

Separate the initial shape from the review update policy:

| Policy dimension | Choices |
| --- | --- |
| Initial shape | One commit, or several atomic commits. |
| Review updates | Rewrite owning commits, or append one commit per review round. |
| Published SHA constraints | Permit necessary restacking, or prohibit rewriting published commits. |

Provide presets for a continuously single-commit PR, atomic multi-commit PRs, and one initial commit followed by one commit per review round. Store repository defaults with per-PR overrides. If no policy is established, ask before the first publication rather than inferring consent to rewrite.

A review round is an explicitly identified batch of feedback, not an agent response, a tool call, or a single review comment. Temporary local changes can be organized and combined before publishing that round. After publication, do not absorb or squash it away under the review-round policy.

Persist the PR-to-bookmark/group mapping and policy outside a single conversation's transient state, scoped to the shared repository. Retain full change IDs for identity where useful, but account for split/squash operations that replace or abandon changes. Verify mappings against JJ and GitHub before publication.

### Publication workflow

1. Inspect repository state, selected groups, ownership, conflicts, and policy.
2. Resolve the target repository, push remote, head bookmark, and PR base explicitly, including fork workflows.
3. Preview the exact commit ranges, bookmark updates, PR creations/edits, and any published-history rewrites.
4. Obtain authorization for the actual external changes and revalidate the preview's state.
5. Use narrow `jj git push` operations for refs and `gh` for PR metadata.
6. Verify remote targets and resulting PR head/base relationships; report URLs and any incomplete operations honestly.

A preview is not publication. Do not use `gh pr create --dry-run` as the safety boundary: its help explicitly allows pushing Git changes. Likewise, JJ's `--no-integrate-operation` does not prevent external side effects. Avoid broad pushes and bypass flags such as `--allow-conflicts` or `--ignore-immutable` as routine workarounds.

Publishing an empty scratch `@` instead of the intended PR tip must be caught by explicit selection. Do not assume the tip is always `@-` either.

### Stack maintenance and merges

When rewriting a lower change, account for every affected upper group. JJ preserves change identity across a rebase, but Git commit SHAs can change.

Preserving review rounds is distinct from never rewriting published SHAs. A linear restack can satisfy the former while violating the latter. If the selected policy forbids the required rewrite, stop and explain the tradeoff; do not silently switch policy or create merge commits.

After a lower PR lands, inspect its actual merge outcome, fetch the relevant target when performing the authorized sync, restack only the unmerged work, and preview/re-push affected bookmarks before updating PR bases as appropriate. Squash and rebase merges can require removing the old lower-layer commits from the remaining stack. Merely calling `gh pr edit --base` can reintroduce already-merged changes into the next PR's diff.

Keep merging, remote branch deletion, and completed-stack cleanup explicit user actions. Do not copy automatic destructive closeout behavior from another extension.

## Workspace management and unified `wt`

### Placement and identity

Use these distinct layouts:

```text
JJ:  ~/.local/workspaces/<repo-key>/<workspace-name>
Git: $MAIN_REPO/.local/trees/<worktree-name>
```

Namespace the home-level JJ directory by repository to avoid collisions between common workspace names. Derive a readable, disambiguated key from the shared repository identity, not the current workspace path or only the remote URL. Independent clones of the same remote must not accidentally share a namespace. The same repository must resolve to the same managed root from any of its workspaces.

Names must not escape the managed directory. Check canonical destination paths and existing registrations before creation. Refuse collisions instead of adopting arbitrary directories. Resolve the main Git root consistently with the existing skill, rather than reproducing `wt`'s current current-worktree-relative path calculation.

Do not automatically relocate or remove existing workspaces/worktrees. Expose registered external locations through `--all`.

### Creation, colocation, and removal

Create JJ workspaces through `jj workspace add`; choose the base revision explicitly. Its default parent selection is not equivalent to blindly checking out `@`. Preserve JJ's sparse-workspace behavior unless the user requests otherwise.

Prefer colocated primary repositories for Git-tool compatibility, but support non-colocated JJ workspaces. Report their compatibility implications in the health check and use explicit GitHub repository targeting. Do not create a second Git worktree merely to manufacture colocation.

If both VCS inventories report a directory, deduplicate by canonical path and identify it as JJ-managed when it is a JJ workspace. Record its Git registration as a capability, not a separate selectable workspace.

The default home-level JJ layout avoids placing secondary workspaces inside the primary checkout. Still check whether a requested destination lies under any existing repository, including a home-directory dotfiles repository. Require effective ignore coverage before creating nested workspace contents. Check the existing Git `.local/trees/` location as well; do not automatically edit ignore files without authorization.

Workspace removal must preserve the history the user intends to keep, account for unsnapshotted files and ignored/untracked contents, and use native JJ/Git registration removal as appropriate. Do not use a clean Git status alone as the safety test for a JJ workspace. Forgetting/removing a workspace must not implicitly abandon, squash, or delete its changes/bookmarks. Never clean up isolation automatically when a task ends.

### `wt` interface and implementation

Keep `list`, `select`, `cd`, `add`, `remove`, and `copy`, plus their existing useful aliases and the managed-versus-`--all` distinction. Show backend, name, branch/change identity, state, and path. Default creation to JJ in JJ repositories, including colocated ones, and to Git in ordinary Git repositories. Discovery failure is an error, not permission to switch backends.

Use a self-contained Python script run with `uv run --script`, with PEP 723 dependency metadata. Preserve the command name and shell-facing contract. The executable returns selected paths; the shell wrapper performs `cd`. Preserve cancellation and error behavior without emitting a misleading path.

Make the extension and CLI use one workspace-management contract and implementation where practical. Prefer a small machine-readable mode on the helper over independently implementing placement and deletion rules in TypeScript and Python. Avoid requiring the user's private dotfiles layout for a distributable extension; keep the helper with the deliverable and install/link `wt` through dotfiles.

Update `wtm` and its shell integration to resolve the corresponding primary checkout/workspace while preserving its current same-subdirectory navigation behavior. Update the worktree/workspace instruction mechanism to use the same helper and explicit-isolation policy.

## Repository health and command guardrails

### Health inspection

Provide an explicit, read-only health view covering:

- JJ availability/version and whether the target is a JJ workspace, colocated primary repository, or ordinary Git checkout.
- Identity, signing expectations, remotes, and GitHub repository targeting.
- Pre-existing changes, conflicts, divergent changes, conflicted bookmarks, and stale workspaces.
- PR policy/mapping consistency, undescribed or unexpected publication candidates, and immutable/private revisions.
- Snapshot coverage warnings, including skipped oversized or untracked files; do not imply ignored files are protected.
- Workspace path/ignore coverage and dual-registration consistency.
- Project checks normally performed by Git hooks that JJ does not automatically invoke, and relevant unsupported Git features such as LFS or submodules.

Report findings and suggested explicit remedies. Health inspection must not initialize repositories, convert colocation, rewrite configuration, fetch, or publish automatically.

### Guardrails

Use repo-aware pre-execution hooks for recognized commands and structured tool actions. Cover ordinary Bash calls, supported cwd/repository flags, and relevant device/tool routes. Inspect known eval/process-launch routes where targets can be determined, but document opaque execution gaps instead of promising total interception.

- Redirect staged-index Git habits in JJ roots with an explanation; do not silently translate commands with different semantics.
- Allow read-only Git where it is useful, while warning about mismatched revision ranges when relevant.
- Catch implicit Git branch assumptions in `gh pr create`, `gh pr checkout`, and Git-based stack tools.
- Check revision scope, ownership, and policy for absorb/split/squash/rebase and destructive restoration.
- Preserve JJ's native push and immutable protections; do not suggest bypass flags as a default fix.

TTSR is optional supplementary guidance. Do not install a global `git ...` interrupt rule that also fires in ordinary Git repositories. Project-local rules remain unsuitable as the sole gate when a command explicitly targets a different repository. Instructions, TTSR, and hooks are workflow aids, not a security sandbox.

## Toggle commands and state

| Command | Feature |
| --- | --- |
| `/jj` | Master extension switch. |
| `/jj-snapshots` | Automatic snapshot capture and session-linked recovery. |
| `/jj-explain` | Additional explanations for history editing. |

Each command supports bare invocation to toggle and explicit `on`, `off`, and `status` arguments. Every successful command reports the effective new/current status immediately, including an inactive reason where applicable. Invalid input reports usage without changing state.

Use session-scoped settings persisted for resume, with user/repository configuration providing defaults for new sessions. Preserve child preferences when the master switch is off. Distinguish configured state from effective state, such as `JJ snapshots: off (JJ disabled)` or `JJ: inactive (not a JJ repository)`.

Keep control commands registered while disabled. Master-off prevents new automatic repository actions, instruction injection, and guardrail intervention; it does not erase JJ data or checkpoint records. Reconcile any already-running capture safely instead of leaving a process unmanaged. Update model-facing feature state so earlier injected instructions are not treated as a still-active automation contract.

For TUI autocomplete, wrap the existing provider and decorate only this extension's command rows. Preserve other providers, completion application, inline hints, synchronous slash completion, and cancellation. Read in-memory state only; no JJ subprocesses or snapshotting in the render/completion path. Avoid accumulating wrappers on session transitions.

Always register useful static descriptions. If the host lacks supported provider wrapping, use those descriptions and immediate command feedback. Non-TUI modes use textual feedback. Do not make the extension depend on a new upstream palette API.

## Implementation sequence

### Extension foundation

- Establish a distributable OMP extension package and supported bundled-skill loading.
- Migrate the existing classifier, workspace resolver, snapshot runner, and relevant regression coverage rather than introducing parallel implementations.
- Add session-scoped feature state, repository identity, activation, short instructions, and the three toggle commands.
- Verify actual palette behavior and the static/text fallback before adding more workflow commands.

### Recovery integration

- Return explicit snapshot outcomes and consistent state identifiers from the capture path.
- Persist session/tool boundary associations and expose grouped recovery points.
- Implement file and repository restore previews with authorization, stale-state checks, and honest missing/partial-state handling.

### JJ workflows and safeguards

- Add the describe-before-work and atomic-change skills.
- Add the health inspection and narrow history/state tool surface.
- Add repository-aware guardrails and explanations using the same resolved targets as execution.

### PR workflows

- Implement grouped-change PR identity and policy persistence.
- Add explicit publication previews and authorized narrow push/PR operations.
- Add stacked publication, review-round updates, and merge-method-aware restacking.

### Workspace tooling

- Implement the unified Python `wt` helper and distinct managed roots.
- Integrate extension workspace actions, shell navigation, `wtm`, and instruction updates with that helper.
- Verify both native backends, external locations, collisions, cancellation, and removal safeguards.

### Integrated verification and deployment

- Exercise the scenarios below with the real OMP and JJ commands, not only mocked handlers.
- Keep the existing snapshot extension active until its replacement's capture/recovery behavior is verified. At deployment, replace its registration so both snapshot engines cannot run together.
- Deliver usage/configuration/recovery documentation and migration notes alongside the extension and helper.
- Keep the upstream VCS status-display issue deferred; evaluate its fix separately when available.

## Acceptance and verification

Use isolated temporary repositories for destructive scenarios. Local bare remotes can exercise publication mechanics without contacting GitHub. Real GitHub mutation checks require an explicitly authorized disposable target. Do not call a local simulation proof of live GitHub behavior.

Retain the existing behavioral regression tests that protect snapshot ordering and failure handling. Add permanent tests for genuinely uncertain transitions and safety boundaries; use disposable scripts and real-program smoke checks for straightforward new API behavior. Run shared validation after integrating the changes, not concurrently against partial implementations.

| Area | Required evidence |
| --- | --- |
| Activation | Start/resume in JJ, Git, and non-repository directories; move or first access a second root; confirm instructions and guardrails stay repository-specific. |
| Toggles | Real TUI off/on/off palette updates and immediate command feedback; master/child interaction; resume persistence; disabled and non-TUI behavior. |
| Snapshot purity | Prompt redraws, autocomplete, and passive status create no snapshots. |
| Capture | Batched synchronous edits retain intermediate states; multi-root changes resolve correctly; staged AST apply is covered; timeout/partial/background boundaries are not presented as complete. |
| Recovery | Restore selected files and full state; preserve pre-restore recoverability; navigate conversation without restoring; reject unavailable/stale targets and show cross-workspace impact. |
| History | Absorb leaves ambiguous edits visible; split/squash preserve intended content; pre-existing user work and published review rounds are not rewritten without policy permission. |
| PRs | Single-commit and multi-commit groups; one commit per explicit review round; non-`origin` and fork targeting; narrow pushes; no publication during preview. |
| Stacks | Lower-layer edits update the intended descendants; squash/rebase-merged layers do not reappear in upper diffs; strict no-rewrite policy stops incompatible restacking. |
| Workspaces | Run from primary and secondary locations; two clones of one remote do not collide; JJ and Git roots remain separate; paired registrations dedupe; nested destinations require ignore coverage. |
| Navigation/removal | Exercise actual `wt` selection, shell `cd`, copy, `wtm`, cancellation, stale registrations, protected work, and explicitly authorized removal. |
| Health/guardrails | Findings cause no automatic repair; ordinary Git repositories remain usable; wrong implicit PR targets and dangerous JJ scopes produce actionable feedback. |
| Cutover | Only the new extension captures snapshots after deployment; existing session records and any unavailable legacy information are handled honestly. |

Completion means all in-scope behavior above works end to end. Static palette descriptions are an accepted compatibility fallback, not a reason to omit immediate status feedback. The deferred upstream branch/status display is intentionally excluded from this implementation's completion criteria.

## References

- Existing implementation: `~/.omp/agent/extensions/jj-snapshot/{index,classify,workspace,snapshot}.ts` and its tests.
- Existing navigation: `~/dots/bin/wt`, `~/dots/bin/wtm`, and `~/dots/zsh/custom/git.zsh`.
- Existing placement policy: `skill://git-worktrees`.
- Python helper conventions: `skill://self-contained-python-scripts`.
- [OMP extension API](https://github.com/can1357/oh-my-pi/blob/1adcef9762b065c0cef15703fd3e78ecaaa52a3b/packages/coding-agent/src/extensibility/extensions/types.ts).
- [OMP built-in advisor command](https://github.com/can1357/oh-my-pi/blob/1adcef9762b065c0cef15703fd3e78ecaaa52a3b/packages/coding-agent/src/slash-commands/builtin-collaboration.ts).
- [OMP autocomplete provider contract](https://github.com/can1357/oh-my-pi/blob/1adcef9762b065c0cef15703fd3e78ecaaa52a3b/packages/tui/src/autocomplete.ts).
- [manojlds/pi-jj](https://github.com/manojlds/pi-jj): recovery metadata and PR previews; do not inherit its one-change-per-PR assumption or base-only sync.
- [ProbabilityEngineer/pi-jj-git-align](https://github.com/ProbabilityEngineer/pi-jj-git-align): useful state visibility; do not inherit Git HEAD reattachment or Git-based publishing alignment.
- [cole/pi-jj](https://github.com/cole/pi-jj): scoped prompt and command guidance; avoid automatic Git translation.
- [atomdmac/pi-jj](https://github.com/atomdmac/pi-jj): explicit native workspace lifecycle ideas.
- [JJ GitHub workflows](https://docs.jj-vcs.dev/latest/github/), [working copies/workspaces](https://docs.jj-vcs.dev/latest/working-copy/), and [Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/).
