"""Fetch and unpack KeeperFX's own release, the source of its data (graphics, sounds, campaigns).

    py -3.10 scripts/fetch_release.py --into <folder>     # prints the unpacked release's path

The archive is KeeperFX's GPL release from its own GitHub page, checked by sha256. It holds no
file of the player's: KeeperFX needs about 14 files from the original Dungeon Keeper, and the
player supplies those in the browser. Downloads are kept in <folder>, so a second run only
unpacks. GitHub's publish runs this; nothing it fetches is committed.
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

VERSION = "1.4.0"
NAME = "keeperfx_1_4_0_complete.7z"
URL = f"https://github.com/dkfans/keeperfx/releases/download/v{VERSION}/{NAME}"
SHA256 = "82d9d5634e8ea6cabb8f62fbd4830b758919893863cd313517af256a3040a279"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download(into: Path) -> Path:
    archive = into / NAME
    if archive.is_file() and sha256_of(archive) == SHA256:
        return archive
    into.mkdir(parents=True, exist_ok=True)
    partial = archive.with_suffix(".part")
    print(f"$ fetch {URL}", flush=True)
    subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", str(partial), URL], check=True)
    got = sha256_of(partial)
    if got != SHA256:
        partial.unlink()
        raise SystemExit(f"{URL}: sha256 {got}, expected {SHA256}")
    partial.replace(archive)
    return archive


def seven_zip() -> str:
    for name in ("7z", "7zz", "7za", "C:/Program Files/7-Zip/7z.exe"):
        found = shutil.which(name) or (name if Path(name).is_file() else None)
        if found:
            return found
    raise SystemExit("7-Zip is needed to unpack the release (7z, 7zz or 7za)")


def unpack(archive: Path, into: Path) -> Path:
    out = into / f"keeperfx-{VERSION}"
    if out.exists():
        shutil.rmtree(out)
    subprocess.run([seven_zip(), "x", "-y", "-bso0", "-bsp0", f"-o{out}", str(archive)], check=True)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--into", type=Path, required=True, help="where to keep the download and unpack it")
    args = parser.parse_args()
    out = unpack(download(args.into.resolve()), args.into.resolve())
    print(out)


if __name__ == "__main__":
    sys.exit(main())
