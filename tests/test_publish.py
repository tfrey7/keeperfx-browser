"""The published site: what build_site.py puts in it, and how deploy.py judges the live one."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_site  # noqa: E402
import deploy  # noqa: E402


class BuildSiteTest(unittest.TestCase):
    def test_every_file_the_player_supplies_is_banned(self):
        banned = build_site.original_files()
        self.assertIn("data/bluepal.dat", banned)
        self.assertIn("sound/bullfrog.sbk", banned)
        self.assertIn("music/keeper02.ogg", banned)
        self.assertGreaterEqual(len(banned), 26)

    def test_an_original_file_in_the_site_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "kfxdata" / "data").mkdir(parents=True)
            (out / "kfxdata" / "data" / "creature.jty").write_bytes(b"kfx's own")
            build_site.refuse_originals(out)
            (out / "kfxdata" / "data" / "BLUEPAL.DAT").write_bytes(b"the player's")
            with self.assertRaises(build_site.SiteError):
                build_site.refuse_originals(out)

    def test_the_game_itself_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "KEEPER95.EXE").write_bytes(b"")
            with self.assertRaises(build_site.SiteError):
                build_site.refuse_originals(Path(tmp))

    def test_changes_page_has_one_dated_line_per_landing(self):
        page = build_site.changes_page([("2026-09-23", "a9429ad", "feat: boot <engine>"),
                                        ("2026-09-22", "4443b89", "feat: compile")])
        self.assertEqual(page.count("<li>"), 2)
        self.assertIn("<time>2026-09-23</time> feat: boot &lt;engine&gt;", page)
        self.assertIn(f"{build_site.SOURCE_URL}/commit/a9429ad", page)

    def test_landings_read_the_main_line(self):
        rows = build_site.landings()
        self.assertTrue(rows)
        self.assertRegex(rows[0][0], r"^\d{4}-\d\d-\d\d$")

    def test_pages_link_the_source(self):
        for page in ("index.html", "engine.html"):
            text = (ROOT / "site" / page).read_text(encoding="utf-8")
            self.assertIn(build_site.SOURCE_URL, text)
            self.assertIn('href="changes.html"', text)

    def test_files_page_leads_to_the_engine(self):
        self.assertIn('href="engine.html"', (ROOT / "site" / "index.html").read_text(encoding="utf-8"))


def site(pages):
    """A fake fetch answering from {url suffix: (status, headers, body)}."""
    def get(url, timeout=0):
        path = url.removeprefix(deploy.LIVE_URL).split("?", 1)[0]
        return pages.get(path, (404, {}, b""))
    return get


GOOD = {
    "": (200, {}, b"<h2>Where is your Dungeon Keeper?</h2>"),
    "engine.html": (200, {}, b'<script src="keeperfx.js">'),
    "keeperfx.wasm": (200, {"Content-Type": "application/wasm"}, b"\0asm\1\0\0\0"),
    "kfxdata/index.json": (200, {}, json.dumps({"files": [["new folder/a b.txt", 3]]}).encode()),
    "kfxdata/new%20folder/a%20b.txt": (200, {}, b"abc"),
    "changes.html": (200, {}, b"<li><time>2026-09-23</time>"),
    "version.json": (200, {}, b'{"sha": "abc1234def56"}'),
}


class DeployTest(unittest.TestCase):
    def test_a_good_live_site_passes(self):
        self.assertEqual(deploy.check_live(get=site(GOOD)), [])

    def test_a_missing_engine_is_named(self):
        pages = dict(GOOD, **{"keeperfx.wasm": (404, {}, b"")})
        wrong = deploy.check_live(get=site(pages))
        self.assertEqual(len(wrong), 1)
        self.assertIn("keeperfx.wasm", wrong[0])

    def test_waits_until_the_commit_is_live(self):
        answers = iter([b'{"sha": "0000000"}', b'{"sha": "abc1234def56"}'])
        get = lambda url, timeout=0: (200, {}, next(answers))  # noqa: E731
        got = deploy.wait_for("abc1234", get=get, sleep=lambda s: None, has=lambda a, b: False)
        self.assertEqual(got, "abc1234def56")

    def test_a_later_commit_that_carries_it_counts(self):
        got = deploy.wait_for("1111111", get=site(GOOD), sleep=lambda s: None, has=lambda a, b: True)
        self.assertEqual(got, "abc1234def56")

    def test_gives_up_when_it_never_arrives(self):
        clock = iter(range(0, 10_000, 100))
        got = deploy.wait_for("1111111", get=site(GOOD), wait_s=300, sleep=lambda s: None,
                              clock=lambda: next(clock), has=lambda a, b: False)
        self.assertEqual(got, "")

    def test_failure_is_loud_for_the_console(self):
        lines = deploy.loud("it failed", "because").splitlines()
        self.assertEqual(lines[1:3], ["!! it failed", "!! because"])

    def test_fleet_runs_it_after_every_landing(self):
        hook = json.loads((ROOT / "fleet.json").read_text(encoding="utf-8"))["restartHook"]
        self.assertIn("scripts/deploy.py", hook)
        self.assertIn("{sha}", hook)


if __name__ == "__main__":
    unittest.main()
