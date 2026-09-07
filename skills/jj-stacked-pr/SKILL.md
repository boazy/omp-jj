---
name: jj-stacked-pr
description: Publish and maintain a stack of JJ change groups as chained GitHub PRs
---

# JJ stacked PRs

A stack is a chain of PR groups, each with a bookmark at its tip. Name every
layer's commit range and bookmark explicitly before doing anything. Do not
infer a linear stack from every mutable ancestor/descendant.

## Publication (`/jj-stack`)

1. Map every layer with `/jj-pr map` (each layer is an ordinary PR group with
   its own base — the layer below).
2. Preview the whole chain: `/jj-stack preview <bottom> ... <top>`. Each
   layer gets the full `/jj-pr` preview treatment, and the chain itself is
   verified (every upper base equals the lower tip). Breaks stop the flow.
3. Publish bottom-up: `/jj-stack publish <bottom> ... <top> --apply
   --confirm <op>`. Layers publish in order with drift revalidation between
   them; a failure stops later layers and reports exactly what already
   pushed. Review-round updates follow the same path: organize the round's
   commits locally first, then publish the affected layers.

Preserving review rounds is distinct from never rewriting published SHAs: a
linear restack can satisfy the former while violating the latter. If the
selected policy forbids the required rewrite, stop and explain the tradeoff;
never silently switch policy or create merge commits.

## After a lower PR lands

1. Inspect the actual merge outcome (rebase, squash, or merge commit) —
   assume nothing about what the remote did.
2. Fetch the relevant target only as an authorized sync step.
3. Restack only the unmerged work: `/jj-stack restack <landed> --method
   <rebase|squash|merge> --onto <rev> --layers <remaining...> [--apply
   --confirm <op>]`. The plan abandons superseded lower-layer commits so
   squash/rebase merges do not reappear in upper diffs, rebases each remaining
   layer explicitly, and moves bookmarks with their commits. Merely calling
   `gh pr edit --base` can reintroduce already-merged changes into the next
   PR's diff — never use it as the restack.
4. Preview and re-push affected bookmarks before updating PR bases.

## Safety notes

- Keep merging, remote branch deletion, and completed-stack cleanup explicit
  user actions.
- A restack preview that reports problems (unresolvable layers, strict-policy
  conflicts) blocks execution until resolved.
- Whole-stack publication to a fresh remote works the same way bottom-up;
  local bare remotes exercise the mechanics without touching GitHub.
