import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import gamedata  # noqa: E402


class GameDataTest(unittest.TestCase):
    def test_web_config_for_the_browser(self):
        """The pinned keeperfx.cfg asks for OpenGL, whose render thread kills startup on the web."""
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "keeperfx.cfg"
            cfg.write_text("; comment\nRENDERER=OPENGL\nFRONTEND_RES=640x480w32 DESKTOP DESKTOP\n"
                           "INGAME_RES=DESKTOP\nRELATIVE_MOUSE_MODE=ON\nLANGUAGE=ENG\n", encoding="utf-8")
            gamedata.web_config(cfg)
            lines = cfg.read_text(encoding="utf-8").splitlines()
        self.assertIn("RENDERER=SOFTWARE", lines)
        # Relative mode needs pointer lock in a browser; without it every mouse move is lost.
        self.assertIn("RELATIVE_MOUSE_MODE=OFF", lines)
        self.assertIn("FRONTEND_RES=640x480w32 640x480w32 640x480w32", lines)
        self.assertIn("INGAME_RES=640x480w32", lines)
        self.assertIn("LANGUAGE=ENG", lines)

    def test_trim_keeps_what_the_menu_needs(self):
        keep = ["keeperfx.cfg", "data/tmapa000.dat", "fxdata/gtext_eng.dat", "sound/sound.dat",
                "sound/speech_eng.dat", "ldata/front.raw", "campgns/keeporig.cfg",
                "campgns/keeporig/map00001.dat", "campgns/keeporig_lnd/rgmap00.raw"]
        drop = ["keeperfx.exe", "sdl2.dll", "ldata/intromix.smk", "sound/speech_ger.dat",
                "fxdata/gtext_ger.dat", "campgns/ancntkpr.cfg", "campgns/ancntkpr/map00001.dat"]
        for rel in keep:
            self.assertTrue(gamedata.wanted(rel), rel)
        for rel in drop:
            self.assertFalse(gamedata.wanted(rel), rel)

    def test_lua_modules_keep_their_case(self):
        """Level scripts failed with "module 'classes.Pos3d' not found" when it was pos3d.lua."""
        self.assertEqual(gamedata.dest_path("fxdata/lua/classes/Pos3d.lua"), "fxdata/lua/classes/Pos3d.lua")
        self.assertEqual(gamedata.dest_path("FXDATA/Lua/classes/Pos3d.lua"), "fxdata/lua/classes/Pos3d.lua")
        self.assertEqual(gamedata.dest_path("Data/TMAPA000.DAT"), "data/tmapa000.dat")


if __name__ == "__main__":
    unittest.main()
