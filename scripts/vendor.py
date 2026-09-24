"""Fetch the pinned KeeperFX engine and the libraries it needs into vendor/, then patch the engine.

Nothing under vendor/ is committed. This file is the whole record of which upstream sources the
web build uses, and patches/keeperfx/*.patch is every change we make to the engine. Run it from a
clean checkout and it lays down the same tree every time; run it again and it resets that tree.

    py -3.10 scripts/vendor.py
"""
from __future__ import annotations

import hashlib
import io
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
PATCHES = ROOT / "patches" / "keeperfx"

#: The engine. docs/PORTING-NOTES.md records the same commit; a test keeps the two in step.
KEEPERFX_COMMIT = "211438fa1c7fad37f867e26c61409c344faf4a0c"

#: Git sources, each fetched at one commit (the tag it came from is in the comment).
GIT = {
    "keeperfx": ("https://github.com/dkfans/keeperfx.git", KEEPERFX_COMMIT),
    # release-3.2.4, the SDL3_mixer upstream builds against
    "SDL_mixer": ("https://github.com/libsdl-org/SDL_mixer.git", "72a81869b45e249e8e67102db4e98dd2441f05a1"),
    # release-3.4.4, the SDL3_image upstream builds against
    "SDL_image": ("https://github.com/libsdl-org/SDL_image.git", "bec9134a26c7d0f31b36d6083c25296e04cabff5"),
    # v0.7.4
    "libspng": ("https://github.com/randy408/libspng.git", "fb768002d4288590083a476af628e51c3f1d47cd"),
    # master on 2026-09-23; centijson has no release tags
    "centijson": ("https://github.com/mity/centijson.git", "8c7a5fb42d9f55044d60592809288164adb4ca95"),
    # v1.3.2, the zlib Emscripten's port uses; only contrib/minizip is compiled
    "zlib": ("https://github.com/madler/zlib.git", "da607da739fa6047df13e66a2af6b8bec7c2a498"),
}

#: Single files and tarballs, checked by sha256.
ASTRONOMY = "https://raw.githubusercontent.com/cosinekitty/astronomy/61dc07020aaa6885d2c7f688a4d82beaf6edb9ef/source/c/"  # v2.1.19
FILES = {
    "astronomy/astronomy.c": (ASTRONOMY + "astronomy.c", "388920479d819713963ffd0f8ab0677944f66c6c94239ceddddd3b0d5d064432"),
    "astronomy/astronomy.h": (ASTRONOMY + "astronomy.h", "83a31011957c2b87e22f0828820f370f1a495aa4d51357bb57d714cde839dc00"),
}
LUA = ("https://www.lua.org/ftp/lua-5.1.5.tar.gz", "2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333")


def run(args, cwd=None):
    print("$", " ".join(str(a) for a in args), flush=True)
    subprocess.run(args, cwd=cwd, check=True)


def fetch_git(name: str, url: str, commit: str) -> None:
    dest = VENDOR / name
    if not (dest / ".git").is_dir():
        dest.mkdir(parents=True, exist_ok=True)
        run(["git", "init", "-q"], cwd=dest)
        run(["git", "remote", "add", "origin", url], cwd=dest)
    have = subprocess.run(["git", "cat-file", "-e", f"{commit}^{{commit}}"], cwd=dest,
                          capture_output=True).returncode == 0
    if not have:
        run(["git", "fetch", "-q", "--depth", "1", "origin", commit], cwd=dest)
    # Reset, so a second run leaves exactly the pinned tree and the patches apply cleanly again.
    run(["git", "checkout", "-q", "--force", "--detach", commit], cwd=dest)
    run(["git", "clean", "-q", "-fdx"], cwd=dest)


def download(url: str, sha256: str) -> bytes:
    print("$ fetch", url, flush=True)
    # curl, not urllib: it uses the system's certificate store, which stays current where
    # an old Python's bundled one may have expired.
    data = subprocess.run(["curl", "-fsSL", url], capture_output=True, check=True).stdout
    got = hashlib.sha256(data).hexdigest()
    if got != sha256:
        raise SystemExit(f"{url}: sha256 {got}, expected {sha256}")
    return data


def fetch_files() -> None:
    for rel, (url, sha256) in FILES.items():
        dest = VENDOR / rel
        if dest.is_file() and hashlib.sha256(dest.read_bytes()).hexdigest() == sha256:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(download(url, sha256))
    lua = VENDOR / "lua-5.1.5"
    if not (lua / "src" / "lua.h").is_file():
        with tarfile.open(fileobj=io.BytesIO(download(*LUA)), mode="r:gz") as tar:
            tar.extractall(VENDOR)


def patch_engine() -> int:
    patches = sorted(PATCHES.glob("*.patch"))
    for patch in patches:
        run(["git", "apply", "--whitespace=nowarn", str(patch)], cwd=VENDOR / "keeperfx")
    return len(patches)


def main() -> int:
    for name, (url, commit) in GIT.items():
        fetch_git(name, url, commit)
    fetch_files()
    applied = patch_engine()
    print(f"vendored keeperfx at {KEEPERFX_COMMIT[:12]}, {applied} patch(es) applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
