import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class SiteTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_page_scripts(self):
        """The page's manifest matcher and zip reader (tests/site/*.test.mjs)."""
        tests = sorted(str(p) for p in (ROOT / "tests" / "site").glob("*.test.mjs"))
        out = subprocess.run(["node", "--test", *tests], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def test_page_uploads_nothing(self):
        """The page's scripts never send anything: no fetch, XHR, beacon or form post."""
        for script in (ROOT / "site" / "js").glob("*.js"):
            text = script.read_text(encoding="utf-8")
            calls = ["XMLHttpRequest", "sendBeacon", "WebSocket", "<form"]
            if script.name != "kfxdata.js":
                calls.append("fetch(")
            for call in calls:
                self.assertNotIn(call, text, f"{script.name} must not upload the player's files")

    def test_kfx_data_loader_only_downloads(self):
        """kfxdata.js fetches KeeperFX's own data with plain GETs and never sees the player's files."""
        text = (ROOT / "site" / "js" / "kfxdata.js").read_text(encoding="utf-8")
        # "body:" would be a request body; reading the answer's stream (res.body) is fine.
        for word in ("method", "body:", "storage.js", "STORE"):
            self.assertNotIn(word, text)


if __name__ == "__main__":
    unittest.main()
