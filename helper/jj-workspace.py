#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Minimal JJ workspace helper using wt-compatible directory configuration."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tomllib
from dataclasses import asdict, dataclass
from pathlib import Path


class WorkspaceError(Exception):
    """A user-facing workspace error."""


def fail(message: str) -> None:
    raise WorkspaceError(message)


def run_jj(root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["jj", "--no-pager", *args],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )


def canonical(path: Path) -> Path:
    return Path(os.path.realpath(os.path.normpath(path)))


def find_workspace(start: Path) -> Path | None:
    current = canonical(start)
    if current.is_file():
        current = current.parent
    while True:
        if (current / ".jj").is_dir():
            return current
        if current.parent == current:
            return None
        current = current.parent


def shared_repo_dir(workspace: Path) -> Path:
    pointer = workspace / ".jj" / "repo"
    if pointer.is_dir():
        return canonical(pointer)
    if pointer.is_file():
        target = pointer.read_text(encoding="utf-8").strip()
        if target:
            return canonical(pointer.parent / target)
    fail(f"cannot resolve shared JJ store from {workspace}")


def primary_workspace(workspace: Path) -> Path:
    primary = shared_repo_dir(workspace).parent.parent
    if not (primary / ".jj").is_dir():
        fail(
            f"cannot determine primary JJ workspace (shared store points at {primary}); "
            "was it moved or deleted?"
        )
    return primary


def read_directory_config(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    try:
        with path.open("rb") as config_file:
            data = tomllib.load(config_file)
    except tomllib.TOMLDecodeError as error:
        fail(f"invalid config {path}: {error}")
    except OSError as error:
        fail(f"cannot read config {path}: {error}")
    value = data.get("workspace_dir")
    if value is None:
        return {}
    if not isinstance(value, str) or not value.strip():
        fail(f"{path}: workspace_dir must be a non-empty string")
    return {"workspace_dir": value}


def configured_root(workspace: Path) -> Path:
    primary = primary_workspace(workspace)
    values: dict[str, str] = {}
    for path in (
        Path.home() / "dots" / "config" / "wt.toml",
        primary / ".local" / "wt.toml",
    ):
        values.update(read_directory_config(path))
    configured = Path(values.get("workspace_dir", ".local/workspaces")).expanduser()
    if not configured.is_absolute():
        configured = primary / configured
    return canonical(configured)


@dataclass
class Workspace:
    backend: str
    name: str
    branch: str
    change: str
    state: str
    path: str
    managed: bool
    primary: bool
    stale: bool
    note: str = ""


JJ_WORKSPACE_TEMPLATE = (
    'self.name() ++ "\\t" ++ self.root() ++ "\\t" ++ '
    'self.target().change_id().short() ++ "\\t" ++ '
    'self.target().bookmarks().join(",") ++ "\\t" ++ '
    'if(self.target().conflict(), "conflict", "ok") ++ "\\t" ++ '
    'if(self.target().empty(), "empty", "dirty") ++ "\\n"'
)


def inventory(workspace: Path, include_all: bool) -> list[Workspace]:
    proc = run_jj(
        workspace,
        ["--ignore-working-copy", "workspace", "list", "-T", JJ_WORKSPACE_TEMPLATE],
    )
    if proc.returncode != 0:
        fail(f"jj workspace list failed: {proc.stderr.strip()}")
    primary = primary_workspace(workspace)
    managed_root = configured_root(workspace)
    rows: list[Workspace] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        name, root_text, change, bookmarks, conflict, emptiness = (
            line.split("\t") + [""] * 6
        )[:6]
        stale = not root_text
        path = managed_root / name if stale else Path(root_text)
        path = canonical(path)
        managed = path == canonical(managed_root / name)
        state = (
            "stale"
            if stale
            else "missing"
            if not path.exists()
            else "conflict"
            if conflict == "conflict"
            else "dirty"
            if emptiness == "dirty"
            else "clean"
        )
        rows.append(
            Workspace(
                backend="jj",
                name=name,
                branch=bookmarks,
                change=change,
                state=state,
                path=str(path),
                managed=managed,
                primary=path == primary,
                stale=stale or state == "missing",
            )
        )
    return rows if include_all else [row for row in rows if row.managed]


def resolve_workspace(workspace: Path, name: str, include_all: bool) -> Workspace:
    rows = inventory(workspace, include_all)
    for row in rows:
        if row.name == name:
            return row
    if include_all:
        target = canonical(Path(name))
        for row in rows:
            if canonical(Path(row.path)) == target:
                return row
    scope = "workspace" if include_all else "managed workspace"
    fail(f"no {scope} named {name!r}")


def validate_name(name: str) -> None:
    if not name or name in {".", ".."}:
        fail(f"invalid workspace name: {name!r}")
    if Path(name).is_absolute() or name.startswith("~") or "/" in name or "\\" in name:
        fail(f"workspace name must not be a path: {name!r}")


def destination_is_ignored(destination: Path, root: Path) -> bool | None:
    relative = os.path.relpath(destination, root)
    if (root / ".git").exists():
        argv = ["git", "-C", str(root), "check-ignore", "-q", "--", relative]
    elif (root / ".jj").is_dir():
        backing = run_jj(root, ["--ignore-working-copy", "git", "root"])
        if backing.returncode != 0 or not backing.stdout.strip():
            return None
        argv = [
            "git",
            "--git-dir",
            backing.stdout.strip(),
            "--work-tree",
            str(root),
            "check-ignore",
            "-q",
            "--",
            relative,
        ]
    else:
        return None
    proc = subprocess.run(argv, cwd=root, capture_output=True, check=False)
    return proc.returncode == 0 if proc.returncode in (0, 1) else None


def nested_destination_reason(destination: Path, workspace: Path) -> str | None:
    primary = primary_workspace(workspace)
    current = destination.parent
    while True:
        if (current / ".jj").is_dir() or (current / ".git").exists():
            if destination_is_ignored(destination, current):
                return None
            scope = (
                "this repository"
                if canonical(current) in {workspace, primary}
                else f"another repository ({current})"
            )
            return (
                f"destination lies under {scope} and is not ignored; nested workspace "
                "contents would be swept into that repository (verify ignore coverage, or pass --force)"
            )
        if current.parent == current:
            return None
        current = current.parent


def cmd_root(workspace: Path, args: argparse.Namespace) -> None:
    primary = primary_workspace(workspace)
    data = {
        "backend": "jj",
        "root": str(primary),
        "path": str(configured_root(workspace)),
    }
    print_json(data) if args.json else print(data["path"])


def cmd_list(workspace: Path, args: argparse.Namespace) -> None:
    rows = inventory(workspace, args.all)
    if args.json:
        print_json([asdict(row) for row in rows])
        return
    for row in rows:
        identity = row.branch or row.change or "-"
        flags = ", ".join(
            flag
            for flag in (
                "primary" if row.primary else "",
                "external" if not row.managed else "",
                "stale" if row.stale else "",
            )
            if flag
        )
        print(
            f"{row.name}\t{identity}\t{row.state}\t{row.path}{f' [{flags}]' if flags else ''}"
        )


def cmd_select(workspace: Path, args: argparse.Namespace) -> None:
    row = resolve_workspace(workspace, args.name, args.all)
    if row.stale:
        fail(f"workspace {row.name!r} is stale or missing on disk ({row.path})")
    data = {"path": row.path}
    print_json(data) if args.json else print(row.path)


def cmd_main(workspace: Path, args: argparse.Namespace) -> None:
    primary = primary_workspace(workspace)
    prefix = ""
    try:
        relative = Path.cwd().relative_to(workspace)
        prefix = "" if relative == Path(".") else str(relative)
    except ValueError:
        pass
    target = primary
    if prefix and (primary / prefix).is_dir():
        target = primary / prefix
    data = {
        "backend": "jj",
        "root": str(primary),
        "prefix": prefix,
        "path": str(target),
    }
    print_json(data) if args.json else print(target)


def cmd_add(workspace: Path, args: argparse.Namespace) -> None:
    validate_name(args.name)
    root = configured_root(workspace)
    destination = root / args.name
    for row in inventory(workspace, True):
        if row.name == args.name:
            fail(f"a workspace named {args.name!r} is already registered ({row.path})")
        if canonical(Path(row.path)) == canonical(destination):
            fail(f"destination is already registered as {row.name!r} ({row.path})")
    if destination.exists() and any(destination.iterdir()):
        fail(f"destination exists and is not empty: {destination}")
    reason = nested_destination_reason(destination, workspace)
    if reason and not args.force:
        fail(reason)
    if reason:
        print(f"jj-workspace: warning: {reason}", file=sys.stderr)
    root.mkdir(parents=True, exist_ok=True)
    proc = run_jj(
        workspace,
        [
            "workspace",
            "add",
            str(destination),
            "--name",
            args.name,
            "-r",
            args.revision or "@",
        ],
    )
    if proc.returncode != 0:
        fail(f"jj workspace add failed: {proc.stderr.strip() or proc.stdout.strip()}")
    data = {"backend": "jj", "name": args.name, "path": str(destination)}
    print_json(data) if args.json else print(f"Created JJ workspace at {destination}")


def untracked_files(path: Path) -> list[str]:
    proc = run_jj(path, ["--ignore-working-copy", "file", "list", "-R", str(path)])
    if proc.returncode != 0:
        fail(f"jj file list failed: {proc.stderr.strip()}")
    tracked = set(proc.stdout.splitlines())
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [name for name in dirnames if name not in {".jj", ".git"}]
        for filename in filenames:
            if filename in {".jj", ".git"}:
                continue
            relative = os.path.relpath(Path(dirpath) / filename, path)
            if relative not in tracked:
                found.append(relative)
    return found


def require_delete_containment(workspace: Path, path: Path) -> None:
    root = canonical(configured_root(workspace))
    target = canonical(path)
    if root not in target.parents:
        fail(
            "--delete-dir is only allowed for workspaces strictly under the "
            "configured root"
        )


def cmd_remove(workspace: Path, args: argparse.Namespace) -> None:
    row = resolve_workspace(workspace, args.name, args.all)
    path = Path(row.path)
    if row.primary:
        fail(f"refusing to remove the primary workspace ({row.name!r})")
    if args.delete_dir:
        if not args.force:
            fail("--delete-dir requires --force")
        require_delete_containment(workspace, path)
    notes: list[str] = []
    if path.exists():
        status = run_jj(path, ["st", "-R", str(path)])
        if status.returncode != 0:
            error = status.stderr.strip()
            if (
                "doesn't have a working-copy commit" not in error
                and "No working copy" not in error
            ):
                fail(f"jj st failed: {error}")
            notes.append("workspace has no working-copy commit (stale)")
            if not args.force:
                fail(f"workspace {row.name!r} is stale; pass --force to forget it")
        else:
            if "The working copy has no changes." not in status.stdout:
                notes.append("workspace has unsnapshotted changes")
                if not args.force:
                    fail(
                        f"workspace {row.name!r} has changes; commit them or pass --force "
                        "(forgetting never abandons or deletes them)"
                    )
            untracked = untracked_files(path)
            if untracked:
                notes.append(
                    f"{len(untracked)} untracked/ignored file(s) will remain on disk "
                    f"(e.g. {untracked[0]})"
                )
                if not args.force:
                    fail(
                        f"workspace {row.name!r} contains untracked/ignored files "
                        f"(first: {untracked[0]}); pass --force to forget anyway, "
                        "delete them first, or keep the directory"
                    )
    else:
        notes.append("workspace directory already missing; forgetting registration")
    proc = run_jj(workspace, ["workspace", "forget", row.name])
    if proc.returncode != 0:
        fail(f"jj workspace forget failed: {proc.stderr.strip()}")
    notes.append("registration forgotten; its changes remain in repository history")
    deleted = False
    if args.delete_dir:
        if path.exists():
            require_delete_containment(workspace, path)
            shutil.rmtree(path)
            deleted = True
            notes.append(f"directory deleted: {path}")
        else:
            notes.append("directory already gone")
    data = {
        "backend": "jj",
        "name": row.name,
        "path": str(path),
        "registration_removed": True,
        "dir_deleted": deleted,
        "notes": notes,
    }
    if args.json:
        print_json(data)
    else:
        for note in notes:
            print(f"jj-workspace: {note}", file=sys.stderr)


def print_json(value: object) -> None:
    print(json.dumps(value, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    root = commands.add_parser("root", help="Print the configured workspaces directory")
    root.add_argument("--json", action="store_true")
    root.set_defaults(handler=cmd_root)

    listing = commands.add_parser(
        "list", aliases=["ls"], help="List registered JJ workspaces"
    )
    listing.add_argument(
        "-a",
        "--all",
        action="store_true",
        help="Include workspaces outside the configured directory",
    )
    listing.add_argument("--json", action="store_true")
    listing.set_defaults(handler=cmd_list)

    select = commands.add_parser(
        "select", aliases=["sel"], help="Print a workspace path"
    )
    select.add_argument("name")
    select.add_argument(
        "-a",
        "--all",
        action="store_true",
        help="Include workspaces outside the configured directory",
    )
    select.add_argument("--json", action="store_true")
    select.set_defaults(handler=cmd_select)

    main = commands.add_parser(
        "main", help="Print the primary workspace, preserving an existing subdirectory"
    )
    main.add_argument("--json", action="store_true")
    main.set_defaults(handler=cmd_main)

    add = commands.add_parser(
        "add", help="Create a workspace in the configured directory"
    )
    add.add_argument("name")
    add.add_argument("--revision", "--from", "-r", default=None, metavar="REV")
    add.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Override the nested-destination guard",
    )
    add.add_argument("--json", action="store_true")
    add.set_defaults(handler=cmd_add)

    remove = commands.add_parser(
        "remove", aliases=["rm"], help="Forget a workspace registration"
    )
    remove.add_argument("name")
    remove.add_argument(
        "-a",
        "--all",
        action="store_true",
        help="Include workspaces outside the configured directory",
    )
    remove.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Allow dirty, stale, or untracked contents",
    )
    remove.add_argument(
        "--delete-dir",
        action="store_true",
        help="Delete a managed workspace directory; requires --force",
    )
    remove.add_argument("--json", action="store_true")
    remove.set_defaults(handler=cmd_remove)

    return parser


def main() -> None:
    args = build_parser().parse_args()
    workspace = find_workspace(Path.cwd())
    if workspace is None:
        print("jj-workspace: not inside a JJ workspace", file=sys.stderr)
        raise SystemExit(1)
    try:
        args.handler(workspace, args)
    except WorkspaceError as error:
        print(f"jj-workspace: {error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
