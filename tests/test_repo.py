import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Extensions of the original Dungeon Keeper data. The player supplies these; they are never ours.
GAME_DATA = {".dat", ".tab", ".pal", ".sbk", ".wad", ".raw", ".dk", ".sav", ".col", ".clm", ".tng", ".slb", ".own", ".apt", ".lif", ".wib"}


def tracked_files():
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True)
    return [line for line in out.stdout.splitlines() if line]


class RepoTest(unittest.TestCase):
    def test_no_original_game_data_is_tracked(self):
        found = [f for f in tracked_files() if Path(f).suffix.lower() in GAME_DATA and not f.startswith("vendor/")]
        self.assertEqual(found, [], "original Dungeon Keeper files must never be committed")

    def test_plan_keeps_its_rulings(self):
        plan = (ROOT / "PLAN.md").read_text(encoding="utf-8")
        for ruling in ("Compile the real engine", "page as actually served", "One heavy engine build at a time"):
            self.assertIn(ruling, plan)


if __name__ == "__main__":
    unittest.main()
