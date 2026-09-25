"""The machine-wide build cache: what makes an object or a whole engine reusable, and what does not."""
import os
import shutil
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import buildcache  # noqa: E402
import build_wasm  # noqa: E402

SCRATCH = ROOT / "build" / "test-buildcache"


class CacheTest(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(SCRATCH, ignore_errors=True)
        self.cache = SCRATCH / "cache"
        patcher = mock.patch.dict(os.environ, {"KFX_BUILD_CACHE": str(self.cache)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, SCRATCH, True)

    def checkout(self, name: str) -> Path:
        """A stand-in checkout with one source and one header, compiled into build/a.o."""
        root = SCRATCH / name
        (root / "src").mkdir(parents=True)
        (root / "src" / "a.c").write_bytes(b'#include "a.h"\n')
        (root / "src" / "a.h").write_bytes(b"int a;\n")
        return root

    def compile(self, root: Path) -> str:
        """Pretend to compile: an object and the depfile the compiler would write, then keep it."""
        obj = root / "build" / "a.o"
        obj.parent.mkdir(parents=True, exist_ok=True)
        obj.write_bytes(b"object of " + (root / "src" / "a.h").read_bytes())
        spaced = str(root / "src").replace(" ", "\\ ")
        obj.with_suffix(".d").write_text(f"x: {spaced}/a.c \\\n  {spaced}/a.h\n", encoding="utf-8")
        return buildcache.keep(self.base(root), obj, obj.with_suffix(".d"), root, {})

    def base(self, root: Path) -> str:
        return buildcache.unit_key("6.0.9", ["emcc", f"-I{root / 'src'}"], root / "src" / "a.c", root, {})

    def test_a_second_checkout_reuses_the_first_ones_object(self):
        first, second = self.checkout("one"), self.checkout("two with space")
        made = self.compile(first)
        self.assertEqual(self.base(first), self.base(second))
        self.assertEqual(buildcache.lookup(self.base(second), second, {}), made)
        buildcache.fetch(self.base(second), made, second / "build" / "a.o")
        self.assertEqual((second / "build" / "a.o").read_bytes(), b"object of int a;\n")

    def test_a_changed_header_misses(self):
        root = self.checkout("one")
        self.compile(root)
        (root / "src" / "a.h").write_text("int b;\n", encoding="utf-8")
        self.assertIsNone(buildcache.lookup(self.base(root), root, {}))

    def test_changing_a_header_back_hits_again(self):
        root = self.checkout("one")
        made = self.compile(root)
        (root / "src" / "a.h").write_bytes(b"int b;\n")
        self.compile(root)
        (root / "src" / "a.h").write_bytes(b"int a;\n")
        self.assertEqual(buildcache.lookup(self.base(root), root, {}), made)

    def test_a_changed_source_or_flag_is_another_key(self):
        root = self.checkout("one")
        before = self.base(root)
        self.assertNotEqual(before, buildcache.unit_key("6.0.9", ["emcc", "-O2"], root / "src" / "a.c", root, {}))
        self.assertNotEqual(before, buildcache.unit_key("6.0.10", ["emcc", f"-I{root / 'src'}"],
                                                        root / "src" / "a.c", root, {}))
        (root / "src" / "a.c").write_text("int c;\n", encoding="utf-8")
        self.assertNotEqual(before, self.base(root))

    def test_a_stored_engine_is_restored_and_only_the_newest_are_kept(self):
        out = SCRATCH / "site"
        out.mkdir(parents=True)
        for n in range(buildcache.BUILDS_KEEP + 2):
            (out / "e.wasm").write_text(f"engine {n}", encoding="utf-8")
            buildcache.store(f"k{n}", out, ["e.wasm"])
            os.utime(self.cache / "builds" / f"k{n}", (n, n))
        self.assertEqual(len(list((self.cache / "builds").iterdir())), buildcache.BUILDS_KEEP)
        self.assertFalse(buildcache.restore("k0", out, ["e.wasm"]))
        self.assertTrue(buildcache.restore("k3", out, ["e.wasm"]))
        self.assertEqual((out / "e.wasm").read_text(encoding="utf-8"), "engine 3")


class PlaceTest(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "the users-folder rule is for Tim's Windows machine")
    def test_the_cache_is_never_under_the_users_folder(self):
        home = Path(os.path.expanduser("~"))
        self.assertTrue(buildcache.under_users(home / "cache"))
        self.assertFalse(buildcache.under_users(buildcache.DEFAULT_CACHE))
        with mock.patch.dict(os.environ, {"KFX_BUILD_CACHE": str(home / "kfx-cache")}):
            with self.assertRaises(SystemExit):
                buildcache.cache_dir()

    def test_locks_and_cache_share_one_folder_off_g(self):
        # G: failed on 2026-09-25 and is off limits: nothing a build uses may default to it.
        defaults = (buildcache.DEFAULT_CACHE, build_wasm.HEAVY_LOCK, build_wasm.UT_LOCK)
        if not any(k in os.environ for k in ("SHARED_BUILD_CACHE", "KFX_BUILD_CACHE",
                                               "KFX_HEAVY_BUILD_LOCK", "KFX_UT_BUILD_LOCK")):
            for path in defaults:
                self.assertEqual(path.parent, buildcache.SHARED_ROOT, path)
                self.assertNotEqual(path.drive.upper(), "G:", path)
        with open(Path(build_wasm.__file__), encoding="utf-8") as f:
            self.assertNotIn("G:/emsdk", f.read())

    def test_the_cache_is_outside_the_checkout(self):
        self.assertFalse(buildcache.DEFAULT_CACHE.resolve().is_relative_to(ROOT))

    def test_emscripten_cache_is_shared_per_sdk_version(self):
        self.assertEqual(buildcache.em_cache(build_wasm.EMSDK_VERSION).parent.name, "em-cache")
        self.assertEqual(buildcache.em_cache(build_wasm.EMSDK_VERSION).name, build_wasm.EMSDK_VERSION)

    def test_depfile_paths_unescape_spaces(self):
        text = "x: G:/Claude\\ Stuff/a.c \\\n G:/b.h\n"
        self.assertEqual(buildcache.depfile_paths(text), ["G:/Claude Stuff/a.c", "G:/b.h"])


if __name__ == "__main__":
    unittest.main()
