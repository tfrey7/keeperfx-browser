"""Cheap checks on the wasm build's inputs. The build itself is heavy and lives in heavy_wasm.py."""
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_wasm  # noqa: E402
import vendor  # noqa: E402

PATCHES = sorted((ROOT / "patches" / "keeperfx").glob("*.patch"))
NOTES = (ROOT / "docs" / "PORTING-NOTES.md").read_text(encoding="utf-8")


class PinTest(unittest.TestCase):
    def test_vendor_pin_matches_the_porting_notes(self):
        self.assertIn(f"`{vendor.KEEPERFX_COMMIT}`", NOTES)

    def test_build_pins_one_emscripten_version(self):
        self.assertRegex(build_wasm.EMSDK_VERSION, r"^\d+\.\d+\.\d+$")
        self.assertIn(build_wasm.EMSDK_VERSION, NOTES)

    def test_build_never_runs_more_than_four_compilers(self):
        self.assertLessEqual(build_wasm.MAX_JOBS, 4)


class PatchTest(unittest.TestCase):
    def test_every_patch_is_listed_in_the_porting_notes(self):
        for patch in PATCHES:
            self.assertIn(patch.name, NOTES, f"{patch.name} must be listed in docs/PORTING-NOTES.md")

    def test_patches_apply_to_the_pinned_commit(self):
        engine = ROOT / "vendor" / "keeperfx"
        have = subprocess.run(["git", "cat-file", "-e", f"{vendor.KEEPERFX_COMMIT}^{{commit}}"],
                              cwd=engine, capture_output=True).returncode == 0 if engine.is_dir() else False
        if not have:
            self.skipTest("vendor/keeperfx not fetched; run scripts/vendor.py")
        # Apply the series to a scratch index built from the pinned commit, never the work tree.
        index = ROOT / "build" / "patch-check.index"
        index.parent.mkdir(exist_ok=True)
        env = {"GIT_INDEX_FILE": str(index)}
        run = lambda *a: subprocess.run(a, cwd=engine, capture_output=True, text=True,  # noqa: E731
                                        env={**__import__("os").environ, **env})
        self.assertEqual(run("git", "read-tree", vendor.KEEPERFX_COMMIT).returncode, 0)
        try:
            for patch in PATCHES:
                proc = run("git", "apply", "--cached", str(patch))
                self.assertEqual(proc.returncode, 0, f"{patch.name}: {proc.stderr}")
        finally:
            index.unlink(missing_ok=True)


class LockTest(unittest.TestCase):
    HELD = "run-a build_wasm pid 4242\n2026-09-23T19:47:28"

    def test_our_own_lock_from_a_dead_build_is_cleared(self):
        self.assertTrue(build_wasm.is_our_dead_lock(self.HELD, "run-a", alive=lambda pid: False))

    def test_our_own_lock_is_kept_while_that_build_runs(self):
        self.assertFalse(build_wasm.is_our_dead_lock(self.HELD, "run-a", alive=lambda pid: True))

    def test_anybody_elses_lock_is_waited_for(self):
        self.assertFalse(build_wasm.is_our_dead_lock(self.HELD, "run-b", alive=lambda pid: False))
        self.assertFalse(build_wasm.is_our_dead_lock("ut-browser job 7", "run-a", alive=lambda pid: False))


if __name__ == "__main__":
    unittest.main()
