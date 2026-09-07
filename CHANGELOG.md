# Changelog

## 0.1.0

First distributable release: the `jj-snapshot` prototype grown into a JJ-native
OMP extension package.

- **Extension foundation** (`package.json`, `src/index.ts`): distributable
  package with session state, three toggles (`/jj`, `/jj-snapshots`,
  `/jj-explain`), short per-prompt repository context, palette provider wrapper
  with live toggle descriptions, and five bundled skill skeletons.
- **Snapshots and session-linked recovery** (`src/snapshot.ts`,
  `src/recovery.ts`, `/jj-recover`): explicit capture outcomes (`ok`,
  `unchanged`, `partial`, `failed`, `skipped`), persisted checkpoint records
  grouped per user request, file vs. whole-state restores with previews,
  pre-restore safety nets, and explicit authorization. Missing state is
  reported, never substituted.
- **JJ workflows and safeguards** (`src/history.ts`, `src/health.ts`,
  `/jj-health`): describe-before-work loop with a session ownership baseline,
  absorb/split/squash scope previews with drift revalidation, read-only health
  inspection across identity/conflicts/PR consistency/snapshot coverage/hooks,
  and repo-aware guardrails (git-habit redirects, history scope + published
  policy, destructive-restore redirection). Explanations gate on
  `/jj-explain`; checks never do.
- **PR workflows** (`src/pr.ts`, `/jj-pr`, `/jj-stack`): explicit
  bookmark-tip groups (never inferred), `single`/`atomic`/`per-round`
  policies with shared-repo-scoped persistence, preview-then-authorized
  narrow push + `gh` metadata with drift tokens, empty-scratch refusal,
  strict no-rewrite stops, bottom-up stack publication, and
  merge-method-aware restacking without silent policy switches.
- **Workspace tooling** (`src/workspaces.ts`, `/jj-workspace`,
  `helper/wt.py`): single-contract client over the helper's `--json`
  interface — placement, naming, collision, nested-destination, and removal
  rules stay in the helper. Creation/removal are preview-then-authorized;
  reads never snapshot. Fixed symlink-aware managed-root comparison.
