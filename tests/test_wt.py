#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Unit and smoke tests for the unified wt / wtm helper.

Run via:
    python3 tests/test_wt.py
or
    uv run --script tests/test_wt.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Load helper/wt.py dynamically without installing or messing with sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
WT_SCRIPT = REPO_ROOT / "helper" / "wt.py"
WT_M_SCRIPT = REPO_ROOT / "helper" / "wtm.py"

spec = importlib.util.spec_from_file_location("wt_helper", WT_SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {WT_SCRIPT}")
wt = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = wt
spec.loader.exec_module(wt)


# ---------------------------------------------------------------------------
# Unit tests: pure logic & algorithms


class TestPlacementKeys(unittest.TestCase):
    """Placement key generation and disambiguation rules."""

    def test_same_repo_resolves_same_key_from_primary_and_secondary(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            primary = base / "my-repo"
            primary_jj_repo = primary / ".jj" / "repo"
            primary_jj_repo.mkdir(parents=True)

            # Secondary workspace has .jj/repo as a regular file pointing to primary
            secondary = base / "my-workspace"
            sec_jj = secondary / ".jj"
            sec_jj.mkdir(parents=True)
            sec_repo_file = sec_jj / "repo"
            # Relative path from secondary/.jj to primary/.jj/repo
            rel_target = os.path.relpath(primary_jj_repo, sec_jj)
            sec_repo_file.write_text(rel_target + "\n", encoding="utf-8")

            key_primary = wt.jj_repo_key(primary)
            key_secondary = wt.jj_repo_key(secondary)

            self.assertEqual(key_primary, key_secondary)
            self.assertTrue(key_primary.startswith("my-repo-"))

    def test_two_clones_same_basename_have_distinct_keys(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            clone1 = base / "dirA" / "project"
            (clone1 / ".jj" / "repo").mkdir(parents=True)

            clone2 = base / "dirB" / "project"
            (clone2 / ".jj" / "repo").mkdir(parents=True)

            key1 = wt.jj_repo_key(clone1)
            key2 = wt.jj_repo_key(clone2)

            self.assertNotEqual(key1, key2)
            # Both derive readable part from store dir name, but hashes differ
            self.assertEqual(key1.split("-")[0], key2.split("-")[0])


class TestNameValidation(unittest.TestCase):
    """Workspace names must not escape the managed directory."""

    def test_valid_names_accepted(self):
        for good in ("feature", "issue-123", "v2.0", "user_work", "alpha1"):
            try:
                wt.validate_name(good)
            except wt.WtError as e:
                self.fail(f"valid name {good!r} raised WtError: {e}")

    def test_path_escapes_rejected(self):
        bad_names = (
            "",
            ".",
            "..",
            "../escape",
            "foo/bar",
            "foo/../../bar",
            "/absolute",
            "~/homedir",
            "nested\\backslash",
        )
        for bad in bad_names:
            with self.subTest(bad=bad):
                with self.assertRaises(wt.WtError):
                    wt.validate_name(bad)


class TestCollisionRefusal(unittest.TestCase):
    """Refuse creation on collision with existing registrations or dirs."""

    def test_refuse_if_name_already_registered(self):
        inventory = [
            wt.Entry(
                backend="jj",
                name="my-ws",
                branch="",
                change="abc",
                state="clean",
                path=Path("/tmp/workspaces/repo-key/my-ws"),
                managed=True,
            )
        ]
        repo = wt.Repo("jj", Path("/tmp/my-repo"), "repo-key")
        dest = Path("/tmp/workspaces/repo-key/my-ws")

        with self.assertRaises(wt.WtError) as ctx:
            wt.check_new_destination(repo, "my-ws", dest, inventory)
        self.assertIn("already registered", str(ctx.exception))

    def test_refuse_if_destination_path_already_registered(self):
        inventory = [
            wt.Entry(
                backend="jj",
                name="registered-name",
                branch="",
                change="abc",
                state="clean",
                path=Path("/tmp/workspaces/repo-key/existing-dir"),
                managed=True,
            )
        ]
        repo = wt.Repo("jj", Path("/tmp/my-repo"), "repo-key")
        dest = Path("/tmp/workspaces/repo-key/existing-dir")

        with self.assertRaises(wt.WtError) as ctx:
            wt.check_new_destination(repo, "new-name", dest, inventory)
        self.assertIn("already registered", str(ctx.exception))

    def test_refuse_if_destination_exists_non_empty(self):
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "dirty-dest"
            dest.mkdir()
            (dest / "leftover.txt").write_text("not empty")

            repo = wt.Repo("jj", Path(td) / "repo", "repo-key")
            with self.assertRaises(wt.WtError) as ctx:
                wt.check_new_destination(repo, "dirty-dest", dest, [])
            self.assertIn("exists and is not empty", str(ctx.exception))


class TestDedupeLogic(unittest.TestCase):
    """Dual registrations (same path reported by jj and git) must dedupe."""

    def test_dual_registration_keeps_jj_backend_and_notes_git(self):
        with tempfile.TemporaryDirectory() as td:
            common_path = Path(td) / "common-dir"
            common_path.mkdir()

            entries = [
                wt.Entry(
                    backend="jj",
                    name="default",
                    branch="",
                    change="xyz",
                    state="clean",
                    path=common_path,
                    managed=False,
                    primary=True,
                ),
                wt.Entry(
                    backend="git",
                    name="main",
                    branch="main",
                    change="123",
                    state="clean",
                    path=common_path,
                    managed=False,
                    primary=True,
                ),
            ]

            deduped = wt.dedupe(entries)
            self.assertEqual(len(deduped), 1)
            entry = deduped[0]
            self.assertEqual(entry.backend, "jj")
            self.assertEqual(entry.name, "default")
            self.assertIn("also registered as git worktree", entry.note)

    def test_distinct_paths_not_merged(self):
        with tempfile.TemporaryDirectory() as td:
            p1 = Path(td) / "path1"
            p2 = Path(td) / "path2"
            p1.mkdir()
            p2.mkdir()

            entries = [
                wt.Entry("jj", "ws1", "", "1", "clean", p1, True),
                wt.Entry("git", "ws2", "main", "2", "clean", p2, True),
            ]
            deduped = wt.dedupe(entries)
            self.assertEqual(len(deduped), 2)


class TestNestedDestGuard(unittest.TestCase):
    """Refuse nested destinations under repositories without ignore coverage."""

    def test_allowed_when_ignore_coverage_effective(self):
        def fake_run(argv, cwd=None):
            # git check-ignore returns 0 -> covered
            return subprocess.CompletedProcess(argv, returncode=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td) / "enclosing"
            (repo_root / ".git").mkdir(parents=True)
            dest = repo_root / ".local" / "trees" / "target"

            my_repo = wt.Repo("git", repo_root, "trees")
            reason = wt.nested_dest_reason(dest, my_repo, run=fake_run)
            self.assertIsNone(reason)

    def test_refused_when_ignore_coverage_missing(self):
        def fake_run(argv, cwd=None):
            # git check-ignore returns 1 -> uncovered
            return subprocess.CompletedProcess(argv, returncode=1, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td) / "dotfiles"
            (repo_root / ".git").mkdir(parents=True)
            dest = repo_root / ".local" / "workspaces" / "target"

            my_repo = wt.Repo("jj", Path(td) / "different-repo", "some-key")
            reason = wt.nested_dest_reason(dest, my_repo, run=fake_run)
            self.assertIsNotNone(reason)
            self.assertIn("destination lies under another repository", reason)


# ---------------------------------------------------------------------------
# Real smoke tests: live JJ + Git subprocess execution


@unittest.skipUnless(shutil.which("jj") is not None, "jj binary required for smoke tests")
class TestJJSmoke(unittest.TestCase):
    """End-to-end smoke test against real JJ 0.45+ workspaces."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.repo_dir = self.base / "main-repo"
        self.ws_home = self.base / "custom-workspaces"
        self.ws_home.mkdir(parents=True)

        # Initialize colocated repo
        proc = subprocess.run(
            ["jj", "git", "init", "--colocate", str(self.repo_dir)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            # fallback to plain jj git init
            subprocess.run(
                ["jj", "git", "init", str(self.repo_dir)],
                check=True,
                capture_output=True,
            )

        # Initial commit so there is a valid parent revision
        (self.repo_dir / "README").write_text("hello\n")
        subprocess.run(["jj", "describe", "-m", "initial commit"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["jj", "new"], cwd=self.repo_dir, check=True, capture_output=True)

    def tearDown(self):
        self.tmp.cleanup()

    def _run_wt(self, *args, cwd=None) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["WT_WORKSPACES_HOME"] = str(self.ws_home)
        return subprocess.run(
            [sys.executable, str(WT_SCRIPT), *args],
            cwd=str(cwd or self.repo_dir),
            capture_output=True,
            text=True,
            env=env,
        )

    def test_full_workspace_lifecycle_smoke(self):
        # 1. Add workspace
        add_res = self._run_wt("add", "smoke-ws")
        self.assertEqual(add_res.returncode, 0, f"add failed: {add_res.stderr}")

        # 2. List --json shows the new workspace
        list_res = self._run_wt("list", "--json")
        self.assertEqual(list_res.returncode, 0)
        items = json.loads(list_res.stdout)
        names = [item["name"] for item in items]
        self.assertIn("smoke-ws", names)
        ws_item = next(item for item in items if item["name"] == "smoke-ws")
        self.assertEqual(ws_item["backend"], "jj")
        self.assertTrue(ws_item["managed"])
        self.assertEqual(ws_item["state"], "clean")
        ws_path = Path(ws_item["path"])
        self.assertTrue(ws_path.is_dir())

        # 3. Select prints exactly the workspace path
        sel_res = self._run_wt("select", "smoke-ws")
        self.assertEqual(sel_res.returncode, 0)
        self.assertEqual(sel_res.stdout.strip(), str(ws_path))

        # 4. Dirty safeguard: touch a file, remove without --force must refuse
        (ws_path / "dirty.txt").write_text("unsaved work\n")
        # Trigger jj snapshot so working copy change is known
        subprocess.run(["jj", "st"], cwd=ws_path, capture_output=True)

        rm_dirty = self._run_wt("remove", "smoke-ws")
        self.assertNotEqual(rm_dirty.returncode, 0, "remove without --force on dirty ws should fail")
        self.assertIn("has changes", rm_dirty.stderr)

        # 5. Remove with --force and --delete-dir cleans registration and directory
        rm_force = self._run_wt("remove", "smoke-ws", "--force", "--delete-dir")
        self.assertEqual(rm_force.returncode, 0, f"remove --force failed: {rm_force.stderr}")
        self.assertFalse(ws_path.exists(), "directory should have been deleted")

        # Confirm registration gone from inventory
        list_after = self._run_wt("list", "--json")
        items_after = json.loads(list_after.stdout)
        self.assertNotIn("smoke-ws", [item["name"] for item in items_after])

    def test_main_subcommand_wtm(self):
        # Create a workspace, create a mirrored subdirectory, run `wt main`
        self._run_wt("add", "nav-ws")
        list_res = self._run_wt("list", "--json")
        ws_path = Path(next(i for i in json.loads(list_res.stdout) if i["name"] == "nav-ws")["path"])

        # Create matching subdirs in primary and secondary
        (self.repo_dir / "src" / "deep").mkdir(parents=True, exist_ok=True)
        sec_deep = ws_path / "src" / "deep"
        sec_deep.mkdir(parents=True, exist_ok=True)

        # Running `main` from inside sec_deep should mirror to primary's src/deep
        main_res = self._run_wt("main", cwd=sec_deep)
        self.assertEqual(main_res.returncode, 0, f"main failed: {main_res.stderr}")
        expected = str((self.repo_dir / "src" / "deep").resolve())
        self.assertEqual(main_res.stdout.strip(), expected)

        # Test companion wtm.py shim behaves identically
        wtm_res = subprocess.run(
            [sys.executable, str(WT_M_SCRIPT)],
            cwd=str(sec_deep),
            capture_output=True,
            text=True,
            env={"WT_WORKSPACES_HOME": str(self.ws_home), **dict(os.environ)},
        )
        self.assertEqual(wtm_res.returncode, 0)
        self.assertEqual(wtm_res.stdout.strip(), expected)


class TestGitSmoke(unittest.TestCase):
    """End-to-end smoke test against pure Git repositories."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.repo_dir = self.base / "git-repo"
        self.repo_dir.mkdir(parents=True)

        subprocess.run(["git", "init", "-q"], cwd=self.repo_dir, check=True)
        subprocess.run(["git", "-C", str(self.repo_dir), "config", "user.email", "smoke@test.local"], check=True)
        subprocess.run(["git", "-C", str(self.repo_dir), "config", "user.name", "Smoke User"], check=True)

        # Ignore .local/ per the git-worktrees convention
        (self.repo_dir / ".gitignore").write_text(".local/\n", encoding="utf-8")
        (self.repo_dir / "README.md").write_text("# Test Repo\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.repo_dir), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo_dir), "commit", "-qm", "initial commit"], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def _run_wt(self, *args, cwd=None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(WT_SCRIPT), *args],
            cwd=str(cwd or self.repo_dir),
            capture_output=True,
            text=True,
        )

    def test_git_worktree_lifecycle_and_wtm(self):
        # 1. Add git worktree
        add_res = self._run_wt("add", "feat-git")
        self.assertEqual(add_res.returncode, 0, f"git add failed: {add_res.stderr}")
        dest = self.repo_dir / ".local" / "trees" / "feat-git"
        self.assertTrue(dest.is_dir())

        # 2. List --json shows managed worktree
        list_res = self._run_wt("list", "--json")
        self.assertEqual(list_res.returncode, 0)
        items = json.loads(list_res.stdout)
        names = [i["name"] for i in items]
        self.assertIn("feat-git", names)
        item = next(i for i in items if i["name"] == "feat-git")
        self.assertEqual(item["backend"], "git")
        self.assertTrue(item["managed"])

        # 3. Select prints path
        sel_res = self._run_wt("select", "feat-git")
        self.assertEqual(sel_res.returncode, 0)
        self.assertEqual(sel_res.stdout.strip(), str(dest))

        # 4. Main / wtm sub-directory navigation
        (self.repo_dir / "pkg" / "lib").mkdir(parents=True, exist_ok=True)
        wt_sub = dest / "pkg" / "lib"
        wt_sub.mkdir(parents=True, exist_ok=True)

        main_res = self._run_wt("main", cwd=wt_sub)
        self.assertEqual(main_res.returncode, 0)
        expected = str((self.repo_dir / "pkg" / "lib").resolve())
        self.assertEqual(main_res.stdout.strip(), expected)

        # 5. Dirty safeguard
        (dest / "uncommitted.txt").write_text("changes\n")
        rm_dirty = self._run_wt("remove", "feat-git")
        self.assertNotEqual(rm_dirty.returncode, 0)
        self.assertIn("not clean", rm_dirty.stderr)

        # 6. Remove with --force removes worktree and directory
        rm_force = self._run_wt("remove", "feat-git", "--force")
        self.assertEqual(rm_force.returncode, 0, f"git remove --force failed: {rm_force.stderr}")
        self.assertFalse(dest.exists())


if __name__ == "__main__":
    unittest.main()
