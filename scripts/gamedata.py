"""Lay out KeeperFX's own data (not the player's) in a folder the page can load from.

    py -3.10 scripts/gamedata.py --release <unpacked keeperfx_1_4_0_complete.7z> --out <folder>
    py -3.10 scripts/serve.py --port <port> --kfx-data <folder>

KeeperFX's graphics, sounds, campaigns and text are not in its git repo; they come with its
release "complete" archive. Whether this project may re-host them is still Tim's call
(PORTING-NOTES §4.4), so nothing here is committed or published: the folder lives outside the repo
and the local server hands it to the page at /kfxdata/.

The folder is the release, trimmed to what the web build uses, with the pinned engine's own
configuration laid over it (the engine is newer than the release, and reads its own config
version). The player's Dungeon Keeper files are never part of it. It also writes index.json, the
list of files the page fetches.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KFX = ROOT / "vendor" / "keeperfx"

#: Folders of the game directory the engine reads. Everything else in the release (the Windows
#: executables, DLLs and launchers) is left behind.
FOLDERS = ("campgns", "creatrs", "data", "fxdata", "ldata", "levels", "mods", "multiplayer", "sound")

#: Only the original campaign: the engine finds campaigns by scanning campgns/*.cfg, so the other
#: 250 MB of fan campaigns can come later without a code change.
CAMPAIGN = "keeporig"

#: The language the page runs in. Other languages' text and speech are left out.
LANGUAGE = "eng"

#: keeperfx.cfg lines the web build sets. The pinned config asks for the OpenGL renderer, which
#: starts a render thread (the web build has none) and needs GL 3.3 (WebGL2 is not); software is
#: the original renderer. Relative mouse mode means pointer lock in a browser, which the page does
#: not hold, and every mouse movement is lost; the grab-and-warp mode the engine falls back to
#: follows the pointer. The release asks for the desktop resolution, which in a browser is the
#: whole screen; the page's canvas is 640x480.
WEB_CONFIG = {
    "RENDERER": "SOFTWARE",
    "RELATIVE_MOUSE_MODE": "OFF",
    "FRONTEND_RES": "640x480w32 640x480w32 640x480w32",
    "INGAME_RES": "640x480w32",
}


def wanted(rel: str) -> bool:
    """Whether a release file (lower-case path relative to its root) goes into the folder."""
    parts = rel.split("/")
    top, name = parts[0], parts[-1]
    if top not in FOLDERS:
        return rel == "keeperfx.cfg"
    if name.endswith(".smk"):
        return False  # movies: the player's own files, never published (PORTING-NOTES §13)
    if top == "campgns":
        return len(parts) == 1 or parts[1] == f"{CAMPAIGN}.cfg" or parts[1] == CAMPAIGN \
            or parts[1] in (f"{CAMPAIGN}_{LANGUAGE}", f"{CAMPAIGN}_lnd", f"{CAMPAIGN}_crtr", "campgn_order.txt")
    if name.startswith("speech_") or name.startswith("gtext_"):
        return name.endswith(f"_{LANGUAGE}.dat")
    return True


#: Lua modules keep their own case: `require "classes.Pos3d"` looks for exactly
#: fxdata/lua/classes/Pos3d.lua, and the web filesystem is case-sensitive.
KEEP_CASE = "fxdata/lua/"


def dest_path(rel: str) -> str:
    """Where a release file goes: lower case (as the engine opens it), except Lua modules."""
    lower = rel.lower()
    return KEEP_CASE + rel[len(KEEP_CASE):] if lower.startswith(KEEP_CASE) else lower


def copy_tree(src_root: Path, out: Path, prefix: str = "") -> int:
    """Copies the wanted files under src_root to out/prefix, lower-casing paths (see dest_path)."""
    count = 0
    for src in sorted(src_root.rglob("*")):
        if not src.is_file():
            continue
        rel = prefix + src.relative_to(src_root).as_posix()
        if not wanted(rel.lower()):
            continue
        dest = out / dest_path(rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        count += 1
    return count


def web_config(cfg: Path) -> None:
    lines = cfg.read_text(encoding="utf-8", errors="replace").splitlines()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key in WEB_CONFIG:
            lines[i] = f"{key}={WEB_CONFIG[key]}"
    cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_index(out: Path) -> tuple[int, int]:
    files = sorted((p.relative_to(out).as_posix(), p.stat().st_size)
                   for p in out.rglob("*") if p.is_file() and p.name != "index.json")
    (out / "index.json").write_text(json.dumps({"files": files}), encoding="utf-8")
    return len(files), sum(size for _, size in files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--release", type=Path, required=True, help="the unpacked KeeperFX release")
    parser.add_argument("--out", type=Path, required=True, help="a folder outside the repo")
    args = parser.parse_args()
    out = args.out.resolve()
    if out.is_relative_to(ROOT) and not out.is_relative_to(ROOT / "gamedata"):
        raise SystemExit("--out must be outside the repo (or its gitignored gamedata/)")
    if not (KFX / "config").is_dir():
        raise SystemExit("vendor/keeperfx is missing: run  py -3.10 scripts/vendor.py  first")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    released = copy_tree(args.release, out)
    # The pinned engine's own configuration: config/ is laid out like the game folder.
    pinned = copy_tree(KFX / "config", out) + copy_tree(KFX / "campgns", out, "campgns/")
    web_config(out / "keeperfx.cfg")
    count, size = write_index(out)
    print(f"{released} files from the release, {pinned} from the pinned engine's config; "
          f"{count} files, {size / 2**20:.0f} MB in {out}")


if __name__ == "__main__":
    main()
