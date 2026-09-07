#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""wt — unified worktree/workspace manager for JJ and Git repositories.

One helper behind the familiar `wt` / `wtm` command names. Placement rules:

    JJ:  ~/.local/workspaces/<repo-key>/<name>   (override: $WT_WORKSPACES_HOME)
    Git: $MAIN_REPO/.local/trees/<name>

The executable prints selected paths; the shell wrapper performs `cd`.
See README.md next to this file for the shell contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path

# ---------------------------------------------------------------------------
# errors / exit codes


class WtError(Exception):
    """User-facing error. Exit code 1."""

    def __init__(self, msg: str, code: int = 1):
        super().__init__(msg)
        self.code = code


def fail(msg: str, code: int = 1) -> None:
    raise WtError(msg, code)


# ---------------------------------------------------------------------------
# subprocess helpers (injectable for tests)


def _run(
    argv: list[str],
    cwd: str | Path | None = None,
    input: str | None = None,
    capture_output: bool = True,
) -> subprocess.CompletedProcess:
    if capture_output:
        return subprocess.run(
            argv,
            cwd=str(cwd) if cwd else None,
            input=input,
            capture_output=True,
            text=True,
            check=False,
        )
    return subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        input=input,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        check=False,
    )

def _have(tool: str) -> bool:
    return shutil.which(tool) is not None


# ---------------------------------------------------------------------------
# paths and repository detection


def canon(path: Path) -> Path:
    return Path(os.path.normpath(str(path)))


def find_repo_root(start: Path) -> Path | None:
    """Walk up from `start`. At each level .jj wins over .git (colocation)."""
    cur = canon(start)
    if cur.is_file():
        cur = cur.parent
    while True:
        if (cur / ".jj").is_dir():
            return cur
        if (cur / ".git").exists():  # dir (repo) or file (linked worktree)
            return cur
        if cur.parent == cur:
            return None
        cur = cur.parent


def shared_jj_repo_dir(ws_root: Path) -> Path:
    """Canonical path of the shared .jj/repo store for a workspace root.

    A primary checkout has .jj/repo as a directory; secondary workspaces have
    it as a regular file containing a relative path back to the primary.
    """
    repo = ws_root / ".jj" / "repo"
    if repo.is_dir():
        return Path(os.path.realpath(repo))
    if repo.is_file():
        rel = repo.read_text(encoding="utf-8").strip()
        if rel:
            return Path(os.path.realpath(os.path.normpath(str(repo.parent / rel))))
    raise WtError(f"cannot resolve shared JJ store from {ws_root}")


def jj_repo_key(ws_root: Path) -> str:
    """Readable, disambiguated managed-root key for a shared JJ repository.

    basename of the canonical shared-store path (the primary checkout name)
    plus a short hash of its realpath, so two clones of the same remote do not
    collide while any workspace of one repo resolves to the same key.
    """
    store = shared_jj_repo_dir(ws_root)
    # Readable prefix: the primary workspace directory name holding the store
    base = store.parent.parent.name if store.parent.name == ".jj" else store.name
    base = base or "repo"
    digest = hashlib.sha256(str(store).encode()).hexdigest()[:8]
    return f"{base}-{digest}"


@dataclass
class Repo:
    kind: str  # "jj" | "git"
    root: Path  # canonical workspace/repo root the user is inside
    key: str  # managed-root namespace key


def detect_repo(cwd: Path) -> Repo | None:
    root = find_repo_root(cwd)
    if root is None:
        return None
    if (root / ".jj").is_dir():
        return Repo("jj", Path(os.path.realpath(root)), jj_repo_key(root))
    return Repo("git", Path(os.path.realpath(root)), "trees")


def jj_workspaces_home() -> Path:
    env = os.environ.get("WT_WORKSPACES_HOME")
    return Path(env).expanduser() if env else Path.home() / ".local" / "workspaces"


def managed_root(repo: Repo) -> Path:
    if repo.kind == "jj":
        return jj_workspaces_home() / repo.key
    return repo.root / ".local" / "trees"


def git_main_root(repo: Repo) -> Path:
    """Main worktree root: first entry of `git worktree list --porcelain`."""
    proc = _run(["git", "worktree", "list", "--porcelain"], cwd=repo.root)
    if proc.returncode != 0:
        raise WtError(f"git worktree list failed: {proc.stderr.strip()}")
    for line in proc.stdout.splitlines():
        if line.startswith("worktree "):
            return Path(os.path.realpath(line[len("worktree ") :]))
    raise WtError("git worktree list returned no entries")


# ---------------------------------------------------------------------------
# inventory entries


@dataclass
class Entry:
    backend: str  # "jj" | "git"
    name: str  # managed name, or path string for external entries
    branch: str  # bookmarks / branch, "" if none
    change: str  # change id / HEAD sha, "" if none
    state: str  # clean | dirty | conflict | stale | missing
    path: Path
    managed: bool
    primary: bool = False
    stale: bool = False
    note: str = ""
    extra: dict = field(default_factory=dict)

    def as_dict(self, relative_to: Path | None = None) -> dict:
        p = str(self.path)
        if relative_to is not None:
            try:
                p = os.path.relpath(self.path, relative_to)
            except ValueError:
                pass
        return {
            "backend": self.backend,
            "name": self.name,
            "branch": self.branch,
            "change": self.change,
            "state": self.state,
            "path": p,
            "managed": self.managed,
            "primary": self.primary,
            "stale": self.stale,
            "note": self.note,
        }


JJ_WS_TEMPLATE = (
    'self.name() ++ "\\t" ++ self.root() ++ "\\t" ++ self.target().change_id().short()'
    ' ++ "\\t" ++ self.target().bookmarks().join(",")'
    ' ++ "\\t" ++ self.target().description().first_line()'
    ' ++ "\\t" ++ if(self.target().conflict(), "conflict", "ok")'
    ' ++ "\\t" ++ if(self.target().empty(), "empty", "dirty") ++ "\\n"'
)


def jj_entries(repo: Repo) -> list[Entry]:
    """All workspaces registered with the shared JJ repository."""
    proc = _run(
        ["jj", "--no-pager", "--ignore-working-copy", "workspace", "list", "-T", JJ_WS_TEMPLATE],
        cwd=repo.root,
    )
    if proc.returncode != 0:
        raise WtError(f"jj workspace list failed: {proc.stderr.strip()}")
    shared = shared_jj_repo_dir(repo.root)
    primary_root = shared.parent.parent
    out: list[Entry] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        parts += [""] * (7 - len(parts))
        name, root_s, change, bookmarks, _desc, conflict, emptiness = parts
        stale = root_s == ""
        if stale:
            path = managed_root(repo) / name
            state = "stale"
        else:
            path = Path(root_s)
            state = "conflict" if conflict == "conflict" else ("dirty" if emptiness == "dirty" else "clean")
            if not path.exists():
                state = "missing"
        out.append(
            Entry(
                backend="jj",
                name=name,
                branch=bookmarks,
                change=change,
                state=state,
                path=path,
                managed=Path(os.path.realpath(path)) == Path(os.path.realpath(managed_root(repo) / name)),
                primary=path == primary_root,
                stale=stale or state == "missing",
            )
        )
    return out


def git_entries(repo: Repo) -> list[Entry]:
    """All worktrees registered with the Git repository."""
    proc = _run(["git", "worktree", "list", "--porcelain"], cwd=repo.root)
    if proc.returncode != 0:
        raise WtError(f"git worktree list failed: {proc.stderr.strip()}")
    main_root = git_main_root(repo)
    trees_root = managed_root(repo)
    out: list[Entry] = []
    cur: dict = {}
    blocks: list[dict] = []
    for line in proc.stdout.splitlines() + [""]:
        if line == "":
            if cur:
                blocks.append(cur)
                cur = {}
            continue
        key, _, value = line.partition(" ")
        cur[key] = value
    for blk in blocks:
        path = Path(os.path.realpath(blk["worktree"]))
        branch = "(detached)" if "detached" in blk else ("(bare)" if "bare" in blk else "")
        if "branch" in blk:
            branch = blk["branch"].removeprefix("refs/heads/")
        state = "clean"
        if "prunable" in blk or not path.exists():
            state = "missing"
        else:
            st = _run(["git", "-C", str(path), "status", "--porcelain"])
            if st.returncode == 0 and st.stdout.strip():
                state = "dirty"
        mroot = canon(trees_root)
        managed = mroot == path or mroot in path.parents
        name = os.path.relpath(path, mroot) if managed else str(path)
        out.append(
            Entry(
                backend="git",
                name=name,
                branch=branch,
                change=blk.get("HEAD", ""),
                state=state,
                path=path,
                managed=managed,
                primary=path == main_root,
                stale=state == "missing",
            )
        )
    return out


def dedupe(entries: list[Entry]) -> list[Entry]:
    """Merge dual registrations: same canonical path reported by jj and git
    becomes a single row, backend=jj, git recorded as a note."""
    by_path: dict[Path, Entry] = {}
    order: list[Path] = []
    for e in entries:
        key = Path(os.path.realpath(e.path))
        if key in by_path:
            kept = by_path[key]
            if e.backend == "jj" and kept.backend == "git":
                kept = replace(kept, backend="jj", note="also registered as git worktree")
            elif kept.backend == "jj" and e.backend == "git":
                kept = replace(kept, note="also registered as git worktree")
            by_path[key] = kept
        else:
            by_path[key] = e
            order.append(key)
    return [by_path[k] for k in order]


def build_inventory(repo: Repo, include_all: bool) -> list[Entry]:
    entries = jj_entries(repo) if repo.kind == "jj" else git_entries(repo)
    entries = dedupe(entries)
    if not include_all:
        entries = [e for e in entries if e.managed]
    return entries


# ---------------------------------------------------------------------------
# name validation, collisions, nested-destination guard


def validate_name(name: str) -> None:
    if not name:
        fail("workspace name must not be empty")
    if name in (".", ".."):
        fail(f"invalid workspace name: {name!r}")
    if os.path.isabs(name) or name.startswith("/") or name.startswith("~"):
        fail(f"workspace name must not be a path: {name!r}")
    if "/" in name or "\\" in name or os.sep in name or (os.altsep and os.altsep in name):
        fail(f"workspace name must not contain path separators: {name!r}")


def check_new_destination(repo: Repo, name: str, dest: Path, inventory: list[Entry]) -> None:
    """Refuse name escapes, existing registrations, and path collisions."""
    for e in inventory:
        if e.managed and e.name == name:
            fail(f"a workspace named {name!r} is already registered ({e.path})")
        if Path(os.path.realpath(dest)) == Path(os.path.realpath(e.path)):
            fail(f"destination is already registered as {e.backend}/{e.name} ({e.path})")
    if dest.exists() and any(dest.iterdir()):
        fail(f"destination exists and is not empty: {dest}")


def nested_dest_reason(dest: Path, repo: Repo, run=_run) -> str | None:
    """Reason the destination lies under an existing repository, if any.

    Covers the home dotfiles repo and existing .local/trees. Effective ignore
    coverage (git check-ignore) makes it safe; otherwise --force is required.
    """
    dest = canon(dest)
    dest = Path(os.path.realpath(dest)) if dest.exists() else dest
    cur = dest.parent
    while True:
        jj_here = (cur / ".jj").is_dir()
        git_here = (cur / ".git").is_dir()
        if jj_here or git_here:
            rel = os.path.relpath(dest, cur)
            proc = run(["git", "-C", str(cur), "check-ignore", "-q", "--", rel])
            if proc.returncode not in (0, 1):
                ignored = False  # unable to verify (e.g. non-colocated jj repo)
            else:
                ignored = proc.returncode == 0
            same = Path(os.path.realpath(cur)) == repo.root
            if ignored:
                return None
            scope = "this repository" if same else f"another repository ({cur})"
            return (
                f"destination lies under {scope} and is not ignored by it; "
                f"nested workspace contents would be swept into that repository "
                f"(verify ignore coverage, or pass --force)"
            )
        if cur.parent == cur:
            return None
        cur = cur.parent


def ensure_not_nested(dest: Path, repo: Repo, force: bool, run=_run) -> None:
    if repo.kind == "jj":
        home = jj_workspaces_home()
        try:
            rel = dest.relative_to(home)
        except ValueError:
            rel = None
        if rel is not None and len(rel.parts) != 2:
            fail(
                f"destination must be {home}/<repo-key>/<name> (one level per part); got {dest}"
            )
    reason = nested_dest_reason(dest, repo, run=run)
    if reason is None:
        return
    if force:
        print(f"wt: warning: {reason}", file=sys.stderr)
        return
    fail(reason)


# ---------------------------------------------------------------------------
# selection (fzf)


def selection_rows(entries: list[Entry]) -> list[str]:
    rows = []
    for e in entries:
        ident = e.branch or e.change or "-"
        rows.append(f"{e.name}\t{ident}\t{e.state}\t{e.path}")
    return rows


def pick_with_fzf(entries: list[Entry], run=_run, have=_have) -> str:
    """Interactive pick; returns the selected first field (name)."""
    if not have("fzf"):
        raise WtError("fzf is required for interactive selection; pass a NAME argument")
    rows = selection_rows(entries)
    input_text = "\n".join(rows) + "\n"
    proc = run(
        ["fzf", "--delimiter=\t", "--nth=1", "--accept-nth=1"],
        cwd=None,
        input=input_text,
        capture_output=False,
    )
    if proc.returncode != 0:
        # cancellation (Esc / Ctrl-C) or no match: no output, exit 2
        raise WtError("cancelled", code=2)
    selected = proc.stdout.strip().split("\t")[0].strip()
    if not selected:
        raise WtError("cancelled", code=2)
    return selected


def resolve_entry(repo: Repo, name: str | None, include_all: bool, run=_run, have=_have) -> Entry:
    inventory = build_inventory(repo, include_all)
    if not inventory:
        scope = "worktrees" if include_all else "managed worktrees (use --all for external ones)"
        fail(f"no {scope}")
    if name is None:
        name = pick_with_fzf(inventory, run=run, have=have)
    for e in inventory:
        if e.name == name:
            return e
    if include_all:
        try:
            target = Path(os.path.realpath(name))
        except OSError:
            target = None
        for e in inventory:
            if target and Path(os.path.realpath(e.path)) == target:
                return e
    fail(f"No worktree named {name}")

# ---------------------------------------------------------------------------
# output helpers


def resolve_path_output(entry: Entry, relative: bool) -> str:
    path = str(entry.path)
    if relative:
        path = os.path.relpath(entry.path, Path.cwd())
    return path


def print_json(data) -> None:
    print(json.dumps(data, indent=2))


# ---------------------------------------------------------------------------
# commands


def cmd_list(repo: Repo, args) -> None:
    entries = build_inventory(repo, args.all)
    if args.json:
        print_json([e.as_dict() for e in entries])
        return
    if not entries:
        print(f"no worktrees (use --all to include external locations)")
        return
    for e in entries:
        ident = e.branch or e.change or "-"
        flags = []
        if e.primary:
            flags.append("primary")
        if e.note:
            flags.append(e.note)
        suffix = f"  [{', '.join(flags)}]" if flags else ""
        print(f"{e.backend:<3} {e.name:<24} {ident:<20} {e.state:<9} {e.path}{suffix}")


def cmd_select(repo: Repo, args) -> None:
    entry = resolve_entry(repo, args.name, args.all)
    if entry.stale:
        fail(f"worktree {entry.name!r} is stale or missing on disk ({entry.path})")
    if args.json:
        print_json({"path": str(entry.path)})
    else:
        print(str(entry.path))


def cmd_cd(repo: Repo, args) -> None:
    fail("cd must be performed by the shell wrapper; see helper/README.md")


def cmd_add(repo: Repo, args) -> None:
    validate_name(args.name)
    mroot = managed_root(repo)
    dest = mroot / args.name
    inventory = build_inventory(repo, True)
    check_new_destination(repo, args.name, dest, inventory)
    ensure_not_nested(dest, repo, args.force)
    mroot.mkdir(parents=True, exist_ok=True)

    if repo.kind == "jj":
        revision = args.revision or "@"
        proc = _run(
            ["jj", "workspace", "add", str(dest), "--name", args.name, "-r", revision],
            cwd=repo.root,
        )
        if proc.returncode != 0:
            fail(f"jj workspace add failed: {proc.stderr.strip() or proc.stdout.strip()}")
    else:
        argv = ["git", "worktree", "add", str(dest)]
        if args.revision:
            argv.append(args.revision)
        if args.force:
            argv.append("--force")
        proc = _run(argv, cwd=repo.root)
        if proc.returncode != 0:
            fail(f"git worktree add failed: {proc.stderr.strip() or proc.stdout.strip()}")

    if args.json:
        print_json({"backend": repo.kind, "name": args.name, "path": str(dest)})
    else:
        print(f"Created {repo.kind} workspace at {dest}")


def cmd_remove(repo: Repo, args) -> None:
    entry = resolve_entry(repo, args.name, args.all)
    notes: list[str] = []
    registration_removed = False
    dir_deleted = False

    if entry.primary:
        fail(
            f"refusing to remove the primary {'workspace' if repo.kind == 'jj' else 'worktree'} "
            f"({entry.name!r}); run from elsewhere if you really intend this"
        )

    if repo.kind == "jj":
        # safeguard: unsnapshotted/dirty state and untracked/ignored contents
        if entry.path.exists():
            st = _run(["jj", "st", "-R", str(entry.path)], cwd=repo.root)
            err = st.stderr.strip()
            if st.returncode != 0:
                if "doesn't have a working-copy commit" in err or "No working copy" in err:
                    notes.append("workspace has no working-copy commit (stale)")
                    if not args.force:
                        fail(f"workspace {entry.name!r} is stale; pass --force to forget it")
                else:
                    fail(f"jj st failed: {err}")
            else:
                if "The working copy has no changes." not in st.stdout:
                    notes.append("working copy has unsnapshotted changes")
                    if not args.force:
                        fail(
                            f"workspace {entry.name!r} has changes; commit them or pass --force "
                            f"(forgetting never abandons or deletes them)"
                        )
                tracked = _run(["jj", "--no-pager", "--ignore-working-copy", "file", "list", "-R", str(entry.path)])
                if tracked.returncode == 0:
                    tracked_set = set(tracked.stdout.splitlines())
                    on_disk: list[str] = []
                    for dirpath, dirnames, filenames in os.walk(entry.path):
                        dirnames[:] = [d for d in dirnames if d not in (".jj", ".git")]
                        for fn in filenames:
                            rel = os.path.relpath(os.path.join(dirpath, fn), entry.path)
                            if rel not in tracked_set:
                                on_disk.append(rel)
                    if on_disk:
                        notes.append(
                            f"{len(on_disk)} untracked/ignored file(s) will remain on disk "
                            f"(e.g. {on_disk[0]})"
                        )
                        if not args.force:
                            fail(
                                f"workspace {entry.name!r} contains untracked/ignored files "
                                f"(first: {on_disk[0]}); pass --force to forget anyway, "
                                f"delete them first, or keep the directory"
                            )
            registration_removed = _forget_jj(repo, entry.name)
        else:
            notes.append("workspace directory already missing; forgetting registration")
            registration_removed = _forget_jj(repo, entry.name)
        if registration_removed:
            notes.append(
                "registration forgotten; its changes remain in the repository history "
                "(clean up explicitly if desired)"
            )
        if args.delete_dir:
            if not args.force:
                fail("--delete-dir requires --force")
            mroot = managed_root(repo)
            if Path(os.path.realpath(managed_root(repo))) not in Path(
                os.path.realpath(entry.path)
            ).parents:
                fail("--delete-dir is only allowed for workspaces under the managed root")
            if entry.path.exists():
                shutil.rmtree(entry.path)
                dir_deleted = True
                notes.append(f"directory deleted: {entry.path}")
            else:
                notes.append("directory already gone")
    else:
        if entry.path.exists():
            st = _run(["git", "-C", str(entry.path), "status", "--porcelain", "--ignored"])
            if st.returncode != 0:
                fail(f"git status failed: {st.stderr.strip()}")
            if st.stdout.strip():
                notes.append("worktree contains modified, untracked, or ignored files")
                if not args.force:
                    fail(
                        f"worktree {entry.name!r} is not clean; commit/stash first or pass --force"
                    )
            argv = ["git", "worktree", "remove", str(entry.path)]
            if args.force:
                argv.append("--force")
            proc = _run(argv, cwd=repo.root)
            if proc.returncode != 0:
                fail(f"git worktree remove failed: {proc.stderr.strip()}")
            registration_removed = True
        else:
            proc = _run(["git", "worktree", "prune"], cwd=repo.root)
            if proc.returncode != 0:
                fail(f"git worktree prune failed: {proc.stderr.strip()}")
            registration_removed = True
            notes.append("directory already missing; pruned stale registration")

    if args.json:
        print_json(
            {
                "backend": entry.backend,
                "name": entry.name,
                "path": str(entry.path),
                "registration_removed": registration_removed,
                "dir_deleted": dir_deleted,
                "notes": notes,
            }
        )
    else:
        for n in notes:
            print(f"wt: {n}", file=sys.stderr)


def _forget_jj(repo: Repo, name: str) -> bool:
    proc = _run(["jj", "workspace", "forget", name], cwd=repo.root)
    if proc.returncode != 0:
        fail(f"jj workspace forget failed: {proc.stderr.strip()}")
    return True


def cmd_copy(repo: Repo, args) -> None:
    entry = resolve_entry(repo, args.name, args.all)
    if entry.stale:
        fail(f"worktree {entry.name!r} is stale or missing on disk ({entry.path})")
    path = resolve_path_output(entry, args.relative)
    if not _have("platform-copy"):
        fail("platform-copy is required for `wt copy`; install it or select manually")
    p = subprocess.run(["platform-copy"], input=path, text=True, capture_output=True, check=False)
    if p.returncode != 0:
        fail(f"platform-copy failed: {p.stderr.strip()}")
    if args.json:
        print_json({"copied": path, "relative": args.relative})
    else:
        print(f"wt: copied: {path}", file=sys.stderr)


def cmd_main(repo: Repo, args) -> None:
    """Resolve the primary checkout, mirroring the current subdirectory (wtm)."""
    if repo.kind == "jj":
        shared = shared_jj_repo_dir(repo.root)
        primary = shared.parent.parent
        if not (primary / ".jj").is_dir():
            fail(
                f"cannot determine primary JJ checkout (shared store points at {primary}); "
                f"was the primary checkout moved or deleted?"
            )
        ws_root_proc = _run(["jj", "--no-pager", "--ignore-working-copy", "workspace", "root"], cwd=repo.root)
        if ws_root_proc.returncode != 0:
            fail(f"jj workspace root failed: {ws_root_proc.stderr.strip()}")
        ws_root = Path(os.path.realpath(ws_root_proc.stdout.strip()))
    else:
        primary = git_main_root(repo)
        ws_root = repo.root

    prefix = ""
    try:
        rel = Path.cwd().relative_to(ws_root)
        prefix = str(rel) if str(rel) != "." else ""
    except ValueError:
        prefix = ""

    target = primary
    if prefix:
        candidate = primary / prefix
        if candidate.is_dir():
            target = candidate
    if args.json:
        print_json({"backend": repo.kind, "root": str(primary), "prefix": prefix, "path": str(target)})
    else:
        print(str(target))


# ---------------------------------------------------------------------------
# CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wt",
        description="Unified worktree/workspace manager for JJ and Git repositories.",
        epilog="The executable prints paths; the shell wrapper performs cd. "
        "See wt.readme.md (or helper/README.md) for the shell contract.",
    )
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")

    def common(p, *, all_=True, force=False, relative=False, json_=True, name=True, revision=False):
        if name:
            p.add_argument("name", nargs="?", default=None, help="worktree/workspace name (omit to pick with fzf)")
        if all_:
            p.add_argument("-a", "--all", action="store_true", help="include external (non-managed) locations")
        if force:
            p.add_argument("-f", "--force", action="store_true", help="override safety checks")
        if relative:
            p.add_argument("-r", "--relative", action="store_true", help="relative path (based on current directory)")
        if revision:
            p.add_argument(
                "--from",
                "-r",
                dest="revision",
                default=None,
                metavar="REV",
                help="base revision (default: @ in JJ repos, HEAD in Git repos)",
            )
        if json_:
            p.add_argument("--json", action="store_true", help="machine-readable JSON output")

    p = sub.add_parser("list", aliases=["ls"], help="List worktrees")
    common(p, name=False, force=False, relative=False)
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("select", aliases=["sel"], help="Print the path of a worktree (wrapper uses this for cd)")
    common(p, force=False, relative=False)
    p.set_defaults(func=cmd_select)

    p = sub.add_parser("cd", help="Handled by the shell wrapper")
    common(p, force=False, relative=False)
    p.set_defaults(func=cmd_cd)

    p = sub.add_parser("add", help="Add a new worktree/workspace")
    common(p, all_=False, force=True, relative=False, json_=True, name=True, revision=True)
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("remove", aliases=["rm"], help="Remove a worktree/workspace (safeguards apply)")
    common(p, force=True, relative=False)
    p.add_argument(
        "--delete-dir",
        action="store_true",
        help="also delete the directory on disk (managed JJ workspaces only; requires --force)",
    )
    p.set_defaults(func=cmd_remove)

    p = sub.add_parser("copy", aliases=["cp"], help="Copy a worktree path to the clipboard")
    common(p, force=False, relative=True)
    p.set_defaults(func=cmd_copy)

    p = sub.add_parser("main", aliases=["wtm"], help="Print the primary checkout, mirroring the current subdirectory")
    p.add_argument("--json", action="store_true", help="machine-readable JSON output")
    p.set_defaults(func=cmd_main)

    return parser


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    # invoked through a `wtm` binary or symlink -> behave as `wt main`
    if os.path.basename(sys.argv[0]) == "wtm":
        if not argv or argv[0].startswith("-"):
            argv = ["main", *argv]
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help(sys.stderr)
        raise SystemExit(1)
    cwd = Path.cwd()
    repo = detect_repo(cwd)
    if repo is None:
        print("wt: not inside a git or jj repository", file=sys.stderr)
        raise SystemExit(1)
    try:
        args.func(repo, args)
    except WtError as exc:
        if exc.code != 2:  # cancellation stays silent
            print(f"wt: {exc}", file=sys.stderr)
        raise SystemExit(exc.code)


if __name__ == "__main__":
    main()
