---
name: jj-atomic
description: Shape working-copy edits into atomic JJ commits with absorb, split, and squash
---

# JJ atomic changes

Follow the loop: describe intent → edit and verify → refine description →
`jj new` at a coherent boundary. Session and prompt boundaries are not
automatically change boundaries. Never run `jj new`, replace a description, or
reshape history merely because a prompt or response finished.

## Describe before work

Before the first agent-owned mutation of an undescribed working change, state
the intent (what the change is for) in one or two sentences. Read-only
investigations need no new change or description.

The session's first checkpoint per repository is the ownership baseline:
content already present there is pre-existing user work. Never rename or
replace its descriptions. Never infer ownership merely because a file appears
in `@`; use the baseline plus explicit user instructions to distinguish
continuing an existing change from starting unrelated work.

## Operations

All consequential operations take the same shape: preview scope explicitly
(sources, destinations, affected descendants/bookmarks, associated PRs),
revalidate state right before executing, and stop plus refresh the preview if
anything moved. The `/jj-explain` toggle controls how much narrative is shown;
turning it off never disables ownership checks, revision validation, immutable
protections, or required authorization. Use argument arrays and deliberate
noninteractive flags throughout.

- `jj absorb`: corrections whose owning ancestor is clear. Limit destinations
  to the relevant, owned changes that the applicable PR policy permits
  rewriting. Line attribution is not proof of semantic ownership — inspect the
  resulting patch. Under a one-commit-per-round policy, never absorb a
  published round away: append a new commit for the round instead.
- `jj split`: separate independently understandable concerns. Prefer
  noninteractive file selection (`jj split <paths>`); same-file hunks need a
  controlled, inspectable route — never drive an interactive editor
  unattended. Splitting replaces change IDs: re-select any PR group that
  referenced the old ones.
- `jj squash`: combine one concern, fold corrections into their owner, or
  produce a selected single-commit publication shape. Squashing replaces
  change IDs the same way splitting does.
- Leave ambiguous edits in place and explain what could not be assigned
  confidently. Never force every edit through every command.
- Check resulting patch boundaries and run the relevant verification when
  history editing changes intermediate commit contents.

## Constraints

- Published review-round policy takes precedence over splitting one published
  round into several commits.
- Rewriting a commit that carries remote bookmarks rewrites published SHAs:
  stop under a strict no-rewrite policy and explain the tradeoff instead of
  switching policy silently.
- The extension's guardrails enforce the same scope checks on every
  model-issued history command; a blocked command explains itself and names
  the remedy. `jj undo` and `jj op restore` are always redirected to
  `/jj-recover`.
