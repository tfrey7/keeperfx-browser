"""Put the published site together in build/web: the page, the engine, and KeeperFX's own data.

    py -3.10 scripts/build_site.py --kfx-data <folder from scripts/gamedata.py> [--sha <commit>]

It needs the built engine and reader in site/ (scripts/build_wasm.py, scripts/build_reader.py).
Besides site/ it writes version.json (the commit, read back by scripts/deploy.py) and
changes.html, one dated line per landing on the main line.

It refuses to publish any original Dungeon Keeper file: every name the page asks the player for
(site/js/manifest.js) and the game's own executables. Those stay in the player's browser.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = ROOT / "build" / "web"
SOURCE_URL = "https://github.com/tfrey7/keeperfx-browser"

#: What the published site must hold, beside the pages themselves.
BUILT = ("keeperfx.js", "keeperfx.wasm", "reader.js", "reader.wasm")
#: Build output that is only for reading a stack locally, never published.
LEFT_OUT = {"keeperfx.js.symbols"}
#: The original game's executables, which prove a folder is a real Dungeon Keeper.
ORIGINAL_PROGRAMS = {"keeper.exe", "keeper95.exe", "deeper.exe"}


class SiteError(Exception):
    pass


def original_files() -> set[str]:
    """The player's files by path, lower case, as the page lists them in manifest.js."""
    text = (SITE / "js" / "manifest.js").read_text(encoding="utf-8")
    return set(re.findall(r'"((?:data|sound|music|ldata)/[^"/]+)"', text))


def refuse_originals(out: Path) -> None:
    banned = original_files()
    found = []
    for path in out.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(out).as_posix().lower()
        # The engine's own data sits under kfxdata/, laid out like the game folder.
        inner = rel.removeprefix("kfxdata/")
        if inner in banned or path.name.lower() in ORIGINAL_PROGRAMS:
            found.append(rel)
    if found:
        raise SiteError("original Dungeon Keeper files must never be published: " + ", ".join(sorted(found)))


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                          encoding="utf-8").stdout.strip()


def landings(ref: str = "HEAD") -> list[tuple[str, str, str]]:
    """(date, short commit, subject) for every commit on the main line, newest first."""
    out = git("log", "--first-parent", "--date=short", "--format=%ad%x09%h%x09%s", ref)
    return [tuple(line.split("\t", 2)) for line in out.splitlines() if line.count("\t") >= 2]


def changes_page(rows: list[tuple[str, str, str]]) -> str:
    items = "\n".join(
        f'    <li><time>{html.escape(date)}</time> {html.escape(subject)} '
        f'<a class="commit" href="{SOURCE_URL}/commit/{html.escape(sha)}">{html.escape(sha)}</a></li>'
        for date, sha, subject in rows)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recent changes · KeeperFX in the browser</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
<main>
  <h1>Recent changes</h1>
  <p class="lede">Every change that went live, newest first. <a href="./">Back to the game</a>.</p>
  <section class="panel">
    <ul class="changes">
{items}
    </ul>
  </section>
  <footer>
    This site's source: <a href="{SOURCE_URL}">github.com/tfrey7/keeperfx-browser</a>.
    KeeperFX is free software under the GNU GPL v2:
    <a href="https://github.com/dkfans/keeperfx">source code</a>.
  </footer>
</main>
</body>
</html>
"""


def build(kfx_data: Path, sha: str = "", out: Path = OUT) -> dict:
    missing = [name for name in BUILT if not (SITE / name).is_file()]
    if missing:
        raise SiteError("not built yet: " + ", ".join(f"site/{m}" for m in missing))
    if not (kfx_data / "index.json").is_file():
        raise SiteError(f"{kfx_data} has no index.json: lay it out with scripts/gamedata.py")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SITE, out, ignore=lambda _dir, names: [n for n in names if n in LEFT_OUT])
    shutil.copytree(kfx_data, out / "kfxdata")
    sha = sha or git("rev-parse", "--short", "HEAD")
    (out / "version.json").write_text(json.dumps({
        "sha": sha,
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }) + "\n", encoding="utf-8")
    (out / "changes.html").write_text(changes_page(landings()), encoding="utf-8")
    refuse_originals(out)
    files = [p for p in out.rglob("*") if p.is_file()]
    return {"out": out, "files": len(files), "bytes": sum(p.stat().st_size for p in files), "sha": sha}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--kfx-data", type=Path, required=True, help="the folder scripts/gamedata.py wrote")
    parser.add_argument("--sha", default="", help="the commit being published (default: HEAD)")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    try:
        made = build(args.kfx_data.resolve(), args.sha, args.out.resolve())
    except SiteError as err:
        raise SystemExit(f"site not built: {err}")
    print(f"built {made['out']}: {made['files']} files, {made['bytes'] / 2**20:.0f} MB, commit {made['sha']}")


if __name__ == "__main__":
    main()
