"""Cheap checks on the wasm build's inputs. The build itself is heavy and lives in heavy_wasm.py."""
import subprocess
import sys
import time
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


class SpeedTest(unittest.TestCase):
    def test_engine_is_compiled_and_linked_at_o2(self):
        # Phase 7: at -O1 a big fight cost about 7.4 ms a frame and the wasm was 13.5 MB;
        # at -O2 it is about 5.3 ms and 7.0 MB (PORTING-NOTES §12).
        self.assertIn("-O2", build_wasm.COMMON)
        self.assertIn("-O2", build_wasm.LINK)


class ExitTest(unittest.TestCase):
    def test_engine_tells_the_page_when_the_player_quits(self):
        # With EXIT_RUNTIME=0 main's return never reaches onExit: Quit left a black box.
        self.assertIn("-sEXIT_RUNTIME=1", build_wasm.LINK)


class SoundTest(unittest.TestCase):
    def test_mixer_decodes_mp3_for_the_mentors_speech(self):
        self.assertIn("-DDECODER_MP3_DRMP3", build_wasm.MIXER_DECODERS)

    def test_engine_keeps_its_own_dr_mp3_private_so_the_two_do_not_clash(self):
        flags = build_wasm.FILE_FLAGS["bflib_sndlib.cpp"]
        self.assertIn("-DDRMP3_API=static", flags)
        self.assertIn("-DDRMP3_PRIVATE=static", flags)


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

    def test_an_empty_lock_past_its_grace_is_nobodys(self):
        # Job 215: an empty lock from 05:52 held every build for two hours.
        self.assertTrue(build_wasm.stale_lock_reason("", build_wasm.EMPTY_LOCK_GRACE_SECONDS))
        self.assertTrue(build_wasm.stale_lock_reason("", 45 * 60))

    def test_an_empty_lock_just_made_is_a_build_still_naming_itself(self):
        self.assertFalse(build_wasm.stale_lock_reason("", 1))

    def test_a_lock_names_its_holder_from_the_instant_it_exists(self):
        # Job 218: a lock created first and named after was left empty, blocking every build.
        lock = ROOT / "build" / "test-heavy-lock" / "heavy-build.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.unlink(missing_ok=True)
        try:
            self.assertTrue(build_wasm.claim_lock(lock, self.HELD))
            self.assertEqual(lock.read_text(encoding="utf-8"), self.HELD)
            self.assertFalse(build_wasm.claim_lock(lock, "run-b build_wasm pid 1\n"))
            self.assertEqual(lock.read_text(encoding="utf-8"), self.HELD, "a second claim overwrote the first")
            self.assertEqual([p.name for p in lock.parent.iterdir()], [lock.name], "left its own file behind")
        finally:
            lock.unlink(missing_ok=True)

    def test_a_named_lock_is_live_until_two_hours(self):
        self.assertFalse(build_wasm.stale_lock_reason(self.HELD, 45 * 60))
        self.assertTrue(build_wasm.stale_lock_reason(self.HELD, build_wasm.LOCK_STALE_SECONDS))


class UtLockTest(unittest.TestCase):
    """KeeperFX's build honours ut-browser's engine-build lock, and holds it the same way."""

    # How ut-browser's scripts/buildlock.py takes its lock: byte 0 of the file, without waiting.
    UT_TRY = ("import msvcrt, sys, time; h = open(sys.argv[1], 'a+b'); h.seek(0)\n"
              "try: msvcrt.locking(h.fileno(), msvcrt.LK_NBLCK, 1)\n"
              "except OSError: print('refused', flush=True); sys.exit(0)\n"
              "print('took', flush=True); time.sleep(float(sys.argv[2]))")

    def setUp(self):
        if sys.platform != "win32":
            self.skipTest("ut-browser's lock is msvcrt's on this machine")
        self.lock = ROOT / "build" / "test-ut-lock" / "build.lock"
        self.lock.parent.mkdir(parents=True, exist_ok=True)

    def ut(self, hold: float) -> subprocess.Popen:
        return subprocess.Popen([sys.executable, "-c", self.UT_TRY, str(self.lock), str(hold)],
                                stdout=subprocess.PIPE, text=True)

    def test_keeperfx_waits_for_a_ut_browser_build_and_then_shuts_it_out(self):
        other = self.ut(1.5)
        self.assertEqual(other.stdout.readline().strip(), "took")
        started = time.time()
        handle = build_wasm.take_ut_lock(self.lock, poll=0.1)
        try:
            self.assertGreater(time.time() - started, 1.0, "took the lock while ut-browser held it")
            other.wait()
            late = self.ut(0)
            self.assertEqual(late.stdout.readline().strip(), "refused")
            late.wait()
            who = (self.lock.parent / "build.lock.who").read_text(encoding="utf-8")
            self.assertIn("keeperfx-browser", who)
        finally:
            build_wasm.release_ut_lock(handle)
        after = self.ut(0)
        self.assertEqual(after.stdout.readline().strip(), "took")
        after.wait()


if __name__ == "__main__":
    unittest.main()
