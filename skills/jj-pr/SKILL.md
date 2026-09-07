---
name: jj-pr
description: Publish a JJ change group as a GitHub PR with explicit bookmark, base, and policy checks
---

# JJ PR

Publish one explicit group of JJ changes as a GitHub PR. A PR is a group of
changes with a bookmark at its tip — it may contain one or several commits.
Never assume the tip is `@` or `@-`; resolve it explicitly. Never assume one
change equals one PR.

## Policy first

Separate the initial shape from the review-update rule and from published-SHA
constraints. `/jj-pr policy` shows the repo default; one of three presets:

- `single`: continuously single-commit PR (rewrite updates, restacking
  permitted).
- `atomic`: atomic multi-commit PRs (rewrite updates, restacking permitted).
- `per-round`: one initial commit, then one commit per review round
  (append-only updates, rewriting published SHAs prohibited).

A review round is an explicitly identified batch of feedback — not an agent
response, a tool call, or a single review comment. Temporary local changes
may be organized and combined before publishing that round. After publication,
never absorb or squash the round away under the per-round policy. If no
policy is established, ask before the first publication rather than inferring
consent to rewrite.

## Workflow (`/jj-pr`)

1. Map the group explicitly: `/jj-pr map <bookmark> --base <base>
   --changes <c1,c2> [--remote R] [--repo OWNER/REPO] [--pr N]`. The bookmark
   must sit at the group tip. Candidates are shown when `--changes` is
   omitted, but the group is never inferred.
2. Inspect state: `/jj-health`, the selected group, ownership, conflicts, and
   policy. Mappings are validated against jj and GitHub; split/squash
   operations replace change IDs, so stale mappings must be re-selected, never
   reinterpreted.
3. Preview: `/jj-pr preview <bookmark>` shows the exact commit ranges,
   bookmark updates, PR creations/edits, and any published-history rewrites.
   A preview is not publication. Never use `gh pr create --dry-run` as the
   safety boundary (it may push); never rely on `--no-integrate-operation`;
   never reach for `--allow-conflicts` or `--ignore-immutable` as routine
   workarounds.
4. Obtain authorization, then publish: `/jj-pr publish <bookmark> --apply
   --confirm <op>`. The confirm token is bound to the previewed operation —
   moved state stops the publish instead of pushing stale intent. Execution
   pushes narrow refs (`jj git push --bookmark`) and manages metadata with
   `gh`, then verifies remote targets and PR head/base relationships.
5. Report URLs and any incomplete operations honestly. Publishing an empty
   scratch `@` is refused: select the intended tip.

## Safety notes

- Fork workflows resolve target repo, push remote, head bookmark, and PR base
  explicitly; non-`origin` remotes via `--remote`.
- A preview that reports problems (stale mapping, empty tip, strict-policy
  violation) blocks publication until resolved.
- Merging, remote branch deletion, and completed-stack cleanup stay explicit
  user actions. For chains of PRs see `jj-stacked-pr`.
