"""The machine-wide build cache: every checkout on the machine reuses what any other compiled.

Every job gets a fresh working copy, so a cache inside the copy's own build/ starts empty every
time and the first build of each job recompiled all of KeeperFX and the SDL ports from nothing.
This cache lives outside every checkout, off the home drive, and nothing in it is committed:

    <cache>/objects/ab/<key>.json   which objects were compiled from a source, and from which headers
    <cache>/objects/ab/<id>.o       one compiled object
    <cache>/builds/<key>/           a finished engine (keeperfx.js, .wasm, .js.symbols)
    <cache>/em-cache/<version>/     Emscripten's own cache: SDL3 and the system libraries, per SDK

An object is keyed by the SDK version, its compile flags, its source's bytes and the bytes of every
header the compiler's depfile says it read, with the checkout's own path taken out so any copy's
objects serve any other. A finished engine is keyed by the ids of every object in it and the link
flags, so a copy whose sources all hit is restored whole, with no compiling, linking or lock.

Adapted from ut-browser's scripts/buildlock.py.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
from pathlib import Path

#: Where the cache lives unless KFX_BUILD_CACHE names another place: beside the heavy-build lock,
#: on the drive the checkouts are on.
DEFAULT_CACHE = Path("G:/Claude Stuff/.keeperfx-browser-cache")

#: How many finished engines the cache keeps, newest used first.
BUILDS_KEEP = 6
#: How many compiled objects (and as many manifests) it keeps. One engine is about 750.
OBJECTS_KEEP = 4000


def cache_dir() -> Path:
    """The shared cache: KFX_BUILD_CACHE, else DEFAULT_CACHE. Never under the home drive's users."""
    path = Path(os.environ.get("KFX_BUILD_CACHE") or DEFAULT_CACHE)
    if under_users(path):
        raise SystemExit(f"the build cache must not live under the users folder: {path}")
    return path


def under_users(path: Path) -> bool:
    """Whether a path is in a user's home folder on Windows (C:/Users/...), where caches never go.

    The system drive is the smallest disk on Tim's machine. Off Windows (GitHub's runners) every
    writable place is under the home folder, so there it is allowed.
    """
    if os.name != "nt":
        return False
    users = Path(os.path.expanduser("~")).resolve().parent
    return os.path.normcase(str(path.resolve())).startswith(os.path.normcase(str(users)) + os.sep)


def em_cache(sdk_version: str) -> Path:
    """Emscripten's cache for one SDK version, shared by every checkout. Emscripten locks it itself."""
    return cache_dir() / "em-cache" / sdk_version


def key(*parts) -> str:
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:20]


def hash_file(path: str, memo: dict) -> str:
    if path not in memo:
        try:
            memo[path] = hashlib.sha256(Path(path).read_bytes()).hexdigest()[:20]
        except OSError:
            memo[path] = "missing"
    return memo[path]


def portable(text: str, root: Path) -> str:
    """A path or flag with the checkout's own root taken out, so every checkout keys alike."""
    return text.replace(str(root), "$ROOT").replace(root.as_posix(), "$ROOT")


def dep_name(path: str, root: Path) -> str:
    full = os.path.normcase(os.path.abspath(path))
    base = os.path.normcase(str(root)) + os.sep
    return "$ROOT/" + Path(full[len(base):]).as_posix() if full.startswith(base) else Path(full).as_posix()


def dep_path(name: str, root: Path) -> str:
    return str(root / name[len("$ROOT/"):]) if name.startswith("$ROOT/") else name


def depfile_paths(text: str) -> list[str]:
    """The prerequisites of a make-style depfile written with `-MT x`, spaces unescaped."""
    body = text.replace("\\\r\n", " ").replace("\\\n", " ").partition(": ")[2]
    deps, cur, i = [], [], 0
    while i < len(body):
        c, nxt = body[i], body[i + 1:i + 2]
        if (c == "\\" and nxt in (" ", "#")) or (c == "$" and nxt == "$"):
            cur.append(nxt)
            i += 2
            continue
        if c.isspace():
            if cur:
                deps.append("".join(cur))
                cur = []
        else:
            cur.append(c)
        i += 1
    if cur:
        deps.append("".join(cur))
    return deps


def replace_with(src: Path, dest: Path) -> None:
    """Copy src over dest in one step, so a reader never sees half a file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(f"{dest.name}.part{os.getpid()}")
    shutil.copy2(src, part)
    os.replace(part, dest)


# --- objects ---------------------------------------------------------------------------------

def unit_key(sdk_version: str, argv: list[str], src: Path, root: Path, memo: dict) -> str:
    """A source's key before its headers are known: SDK, flags, where it is and what it holds."""
    return key("obj", sdk_version, [portable(a, root) for a in argv], dep_name(str(src), root),
               hash_file(str(src), memo))


def lookup(base: str, root: Path, memo: dict) -> str | None:
    """The id of a cached object for this key whose headers all still match, or None."""
    folder = cache_dir() / "objects" / base[:2]
    try:
        entries = json.loads((folder / f"{base}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for entry in reversed(entries):
        if (folder / f"{entry['obj']}.o").is_file() and \
                all(hash_file(dep_path(n, root), memo) == h for n, h in entry["deps"].items()):
            return entry["obj"]
    return None


def fetch(base: str, obj_id: str, obj: Path) -> None:
    """Put a cached object at obj, unless the one there already is it."""
    stamp = obj.with_suffix(".id")
    cached = cache_dir() / "objects" / base[:2] / f"{obj_id}.o"
    if not (obj.is_file() and stamp.is_file() and stamp.read_text(encoding="utf-8") == obj_id):
        replace_with(cached, obj)
        stamp.write_text(obj_id, encoding="utf-8")
    with contextlib.suppress(OSError):
        os.utime(cached)


def keep(base: str, obj: Path, depfile: Path, root: Path, memo: dict) -> str:
    """Put a freshly compiled object in the cache under what its depfile says it read; its id."""
    names = sorted({dep_name(p, root) for p in depfile_paths(depfile.read_text(encoding="utf-8"))})
    deps = {n: hash_file(dep_path(n, root), memo) for n in names}
    entry = {"obj": key(base, deps), "deps": deps}
    folder = cache_dir() / "objects" / base[:2]
    replace_with(obj, folder / f"{entry['obj']}.o")
    manifest = folder / f"{base}.json"
    try:
        entries = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        entries = []
    entries = [e for e in entries if e["obj"] != entry["obj"]][-5:] + [entry]
    part = manifest.with_name(f"{manifest.name}.part{os.getpid()}.{entry['obj']}")
    part.write_text(json.dumps(entries), encoding="utf-8")
    os.replace(part, manifest)
    obj.with_suffix(".id").write_text(entry["obj"], encoding="utf-8")
    return entry["obj"]


def prune_objects() -> None:
    cache = cache_dir() / "objects"
    if not cache.is_dir():
        return
    for pattern in ("*.o", "*.json"):
        found = sorted(cache.glob(f"*/{pattern}"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in found[OBJECTS_KEEP:]:
            with contextlib.suppress(OSError):
                old.unlink()


# --- finished builds -------------------------------------------------------------------------

def restore(entry_key: str, out: Path, names: list[str]) -> bool:
    """Copy a cached build's files into out, each swapped in whole. False when there is none."""
    entry = cache_dir() / "builds" / entry_key
    if not all((entry / name).is_file() for name in names):
        return False
    out.mkdir(parents=True, exist_ok=True)
    for name in names:
        replace_with(entry / name, out / name)
    os.utime(entry)
    return True


def store(entry_key: str, out: Path, names: list[str]) -> None:
    """Keep a finished build, then drop all but the BUILDS_KEEP most recently used."""
    builds = cache_dir() / "builds"
    builds.mkdir(parents=True, exist_ok=True)
    entry = builds / entry_key
    part = builds / f"{entry_key}.part{os.getpid()}"
    shutil.rmtree(part, ignore_errors=True)
    part.mkdir()
    for name in names:
        shutil.copy2(out / name, part / name)
    shutil.rmtree(entry, ignore_errors=True)
    os.replace(part, entry)
    kept = sorted((p for p in builds.iterdir() if p.is_dir() and ".part" not in p.name),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for old in kept[BUILDS_KEEP:]:
        shutil.rmtree(old, ignore_errors=True)
