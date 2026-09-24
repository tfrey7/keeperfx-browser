"""Compile the real KeeperFX engine to WebAssembly: site/keeperfx.js + site/keeperfx.wasm.

    py -3.10 scripts/vendor.py        # once: the pinned sources, patched
    py -3.10 scripts/build_wasm.py    # the engine; incremental after the first run

What goes in is upstream's own source list (src/**/*.c, *.cpp) with three switches for the web,
all recorded in docs/PORTING-NOTES.md:

- KFX_NO_NET     the five networking files are replaced by native/stubs/net_stub.c
- KFX_NO_MOVIES  ffmpeg is compiled out of bflib_fmvids.cpp by a patch; play_smk() returns false
- LuaJIT         is replaced by PUC Lua 5.1.5 plus native/compat/lua_compat.h

The script drives Emscripten's compiler directly, one process per source file; no CMake needed.
It is a heavy build, so it takes the machine-wide lock the README describes, runs at most four
compilers at once at below-normal priority, and writes everything it says to build/wasm-build.log.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
KFX = VENDOR / "keeperfx"
BUILD = ROOT / "build"
OBJ = BUILD / "obj"
GENERATED = BUILD / "generated"
SITE = ROOT / "site"
LOG = BUILD / "wasm-build.log"

#: The Emscripten SDK this build is made with. Any other version is refused, not tried.
EMSDK_VERSION = "6.0.9"
EMSDK_REPO = "https://github.com/emscripten-core/emsdk.git"

#: README rule: one heavy build machine-wide; a lock younger than this is live.
HEAVY_LOCK = Path(os.environ.get("KFX_HEAVY_BUILD_LOCK", "G:/Claude Stuff/.heavy-build.lock"))
LOCK_STALE_SECONDS = 2 * 60 * 60
#: README rule: -j4 at most.
MAX_JOBS = 4

#: KFX_NO_NET: upstream's networking files, replaced by our stub.
NET_FILES = {"bflib_enet.cpp", "net_lan.c", "net_holepunch.c", "net_matchmaking.c", "net_portforward.cpp"}
#: Windows-only files, excluded exactly as upstream's own Linux build does.
WINDOWS_FILES = {"PlatformWindows.cpp", "WindowCompositorWin.cpp"}

COMMON = ["-O1", "-w", "-sUSE_SDL=3", "-sUSE_ZLIB=1", "-fexceptions"]

LINK = [
    "-O1", "-sUSE_SDL=3", "-sUSE_ZLIB=1", "-lopenal", "-fexceptions",
    # The engine's blocking loops yield to the browser through Asyncify (PORTING-NOTES §3.5).
    "-sASYNCIFY=1", "-sASYNCIFY_STACK_SIZE=1048576",
    "-sSTACK_SIZE=4MB", "-sINITIAL_MEMORY=256MB", "-sALLOW_MEMORY_GROWTH=1",
    "-sFORCE_FILESYSTEM=1", "-lidbfs.js",
    # The page mounts the game folder, then calls main itself.
    "-sMODULARIZE=1", "-sEXPORT_NAME=KeeperFX", "-sINVOKE_RUN=0", "-sEXIT_RUNTIME=0",
    "-sEXPORTED_RUNTIME_METHODS=FS,callMain",
]


# --- logging ---------------------------------------------------------------------------------

_log_file = None


def say(*parts) -> None:
    line = " ".join(str(p) for p in parts)
    print(line, flush=True)
    if _log_file:
        _log_file.write(line + "\n")
        _log_file.flush()


# --- the SDK ---------------------------------------------------------------------------------

def sdk_version(root: Path) -> str | None:
    try:
        return json.loads((root / "upstream" / "emscripten" / "emscripten-version.txt").read_text())
    except (OSError, ValueError):
        return None


def find_emsdk() -> Path:
    """The pinned SDK: $EMSDK, ./emsdk, or G:/emsdk if it is that version; else install ./emsdk."""
    for guess in (os.environ.get("EMSDK"), ROOT / "emsdk", "G:/emsdk"):
        if guess and sdk_version(Path(guess)) == EMSDK_VERSION:
            return Path(guess)
    local = ROOT / "emsdk"
    say(f"no Emscripten {EMSDK_VERSION} found; installing it into {local}")
    if not (local / "emsdk.py").is_file():
        subprocess.run(["git", "clone", "--depth", "1", EMSDK_REPO, str(local)], check=True)
    for step in ("install", "activate"):
        subprocess.run([sys.executable, str(local / "emsdk.py"), step, EMSDK_VERSION], cwd=local, check=True)
    if sdk_version(local) != EMSDK_VERSION:
        raise SystemExit(f"emsdk install did not produce Emscripten {EMSDK_VERSION}")
    return local


def toolchain() -> tuple[list[str], list[str], dict]:
    """emcc and em++ run through the SDK's own python (the .bat shims call a bare `python`)."""
    root = find_emsdk()
    pythons = sorted((root / "python").glob("*/python.exe"))
    python = str(pythons[0]) if pythons else sys.executable
    em = root / "upstream" / "emscripten"
    # EMSDK_PYTHON: the port builds run emcc.exe, which otherwise looks for a bare `python`.
    env = dict(os.environ, EMSDK=str(root), EMSDK_PYTHON=python)
    if (root / ".emscripten").is_file():
        env["EM_CONFIG"] = str(root / ".emscripten")
    # Our own cache: the SDK may be shared with other projects, and SDL3's port and the system
    # libraries are built into the cache. EMCC_CORES caps those builds at the same -j4.
    env["EM_CACHE"] = str(BUILD / "em-cache")
    env["EMCC_CORES"] = str(jobs())
    say(f"emscripten {sdk_version(root)} at {root}")
    return [python, str(em / "emcc.py")], [python, str(em / "em++.py")], env


def jobs() -> int:
    named = os.environ.get("KFX_BUILD_JOBS", "")
    return min(MAX_JOBS, int(named)) if named.isdigit() and int(named) > 0 else MAX_JOBS


# --- the machine-wide lock ------------------------------------------------------------------

def run_name() -> str:
    return os.environ.get("FLEET_RUN_NAME", "keeperfx-browser")


def pid_alive(pid: int) -> bool:
    """Whether a process still runs. Off Windows we cannot tell cheaply, so assume it does."""
    if os.name != "nt":
        return True
    import ctypes
    kernel = ctypes.windll.kernel32
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        kernel.GetExitCodeProcess(handle, ctypes.byref(code))
        return code.value == 259  # STILL_ACTIVE
    finally:
        kernel.CloseHandle(handle)


def is_our_dead_lock(holder: str, name: str, alive=pid_alive) -> bool:
    """A lock this run's own earlier build left behind when it was killed: ours to clear.

    Anybody else's lock, or ours while that build still runs, is waited for as the README says.
    """
    first = holder.splitlines()[0].split() if holder else []
    if len(first) != 4 or first[0] != name or first[1:3] != ["build_wasm", "pid"] or not first[3].isdigit():
        return False
    return not alive(int(first[3]))


def take_lock() -> None:
    who = f"{run_name()} build_wasm pid {os.getpid()}"
    told = False
    while True:
        try:
            fd = os.open(HEAVY_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - HEAVY_LOCK.stat().st_mtime
                holder = HEAVY_LOCK.read_text(encoding="utf-8").strip()
            except OSError:
                continue  # released between the two calls
            if age >= LOCK_STALE_SECONDS:
                say(f"removing a stale heavy-build lock ({int(age)}s old): {holder}")
                HEAVY_LOCK.unlink(missing_ok=True)
                continue
            if is_our_dead_lock(holder, run_name()):
                say(f"removing our own lock from a build that died: {holder}")
                HEAVY_LOCK.unlink(missing_ok=True)
                continue
            if not told:
                say(f"waiting for the heavy-build lock, held by: {holder}")
                told = True
            time.sleep(30)
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(f"{who}\n{datetime.now().isoformat(timespec='seconds')}\n")
        say(f"took the heavy-build lock at {HEAVY_LOCK}")
        return


def release_lock() -> None:
    try:
        if f"pid {os.getpid()}" in HEAVY_LOCK.read_text(encoding="utf-8"):
            HEAVY_LOCK.unlink()
            say("released the heavy-build lock")
    except OSError:
        pass


# --- what is compiled ------------------------------------------------------------------------

def generate() -> list[Path]:
    """ver_defs.h from the pin, and the window icon upstream's CMake embeds as a C array."""
    GENERATED.mkdir(parents=True, exist_ok=True)
    version = dict(line.split("=", 1) for line in (KFX / "version.mk").read_text().splitlines()
                   if "=" in line and not line.startswith("#"))
    major, minor, release = (version.get(k, "0").strip() for k in ("VER_MAJOR", "VER_MINOR", "VER_RELEASE"))
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=KFX, capture_output=True,
                            text=True).stdout.strip() or "unknown"
    write_if_changed(GENERATED / "ver_defs.h", "\n".join([
        f"#define VER_MAJOR       {major}", f"#define VER_MINOR       {minor}",
        f"#define VER_RELEASE     {release}", "#define VER_BUILD       0",
        f'#define VER_STRING      "{major}.{minor}.{release}.0 web"', '#define PACKAGE_SUFFIX  "web"',
        f'#define GIT_REVISION    "{commit}"', ""]))
    icon = (KFX / "res" / "keeperfx_icon256-24bpp.png").read_bytes()
    write_if_changed(GENERATED / "window_icon.c",
                     "const unsigned char kfx_window_icon_png[] = {" + ",".join(str(b) for b in icon) + "};\n"
                     "const unsigned int kfx_window_icon_png_size = sizeof(kfx_window_icon_png);\n")
    return [GENERATED / "window_icon.c"]


def write_if_changed(path: Path, text: str) -> None:
    if not path.is_file() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8")


def engine_sources() -> list[Path]:
    found = []
    for pattern in ("*.c", "*.cpp"):
        for src in sorted((KFX / "src").rglob(pattern)):
            rel = src.relative_to(KFX / "src").as_posix()
            if rel.startswith("ftests/") or src.name in NET_FILES or src.name in WINDOWS_FILES:
                continue
            found.append(src)
    found.append(KFX / "deps" / "centitoml" / "toml_api.c")  # it #includes toml_conv.c itself
    found.append(KFX / "deps" / "glad" / "src" / "glad.c")
    found.append(ROOT / "native" / "stubs" / "net_stub.c")
    return found


ENGINE_INCLUDES = [
    KFX / "src", GENERATED, KFX / "deps" / "centitoml", KFX / "deps", KFX / "deps" / "glad" / "include",
    VENDOR / "lua-5.1.5" / "src", VENDOR / "centijson" / "src", VENDOR / "libspng" / "spng",
    VENDOR / "zlib" / "contrib", VENDOR / "astronomy",
    VENDOR / "SDL_mixer" / "include", VENDOR / "SDL_image" / "include",
]


def components() -> list[tuple[str, list[Path], list[str]]]:
    """(name, sources, flags) for the engine and each library it links."""
    inc = lambda dirs: [f"-I{d}" for d in dirs]  # noqa: E731
    lua = VENDOR / "lua-5.1.5" / "src"
    mixer = VENDOR / "SDL_mixer"
    image = VENDOR / "SDL_image"
    return [
        ("lua", [p for p in sorted(lua.glob("*.c")) if p.name not in {"lua.c", "luac.c", "print.c"}],
         ["-DLUA_USE_POSIX"]),
        ("centijson", [VENDOR / "centijson" / "src" / f for f in ("json.c", "json-dom.c", "json-ptr.c", "value.c")],
         []),
        ("spng", [VENDOR / "libspng" / "spng" / "spng.c"], ["-DSPNG_STATIC=1"]),
        ("minizip", [VENDOR / "zlib" / "contrib" / "minizip" / f for f in ("unzip.c", "ioapi.c")],
         ["-DIOAPI_NO_64"]),
        ("astronomy", [VENDOR / "astronomy" / "astronomy.c"], []),
        ("SDL_mixer", sorted((mixer / "src").glob("*.c")),
         ["-DBUILD_SDL", "-DSDL_BUILD_MAJOR_VERSION=3", "-DSDL_BUILD_MINOR_VERSION=2",
          "-DSDL_BUILD_MICRO_VERSION=4", "-DDECODER_WAV", "-DDECODER_AIFF", "-DDECODER_VOC",
          "-DDECODER_AU", "-DDECODER_OGGVORBIS_STB", "-DDECODER_FLAC_DRFLAC"]
         # No DECODER_MP3_DRMP3: the engine compiles its own dr_mp3 (bflib_sndlib.cpp) and the
         # two copies clash at link. The engine decodes MP3 itself.
         + inc([mixer / "include", mixer / "src", mixer / "src" / "codecs"])),
        ("SDL_image", [image / "src" / f for f in (
            "IMG.c", "IMG_WIC.c", "IMG_ani.c", "IMG_anim_encoder.c", "IMG_anim_decoder.c", "IMG_avif.c",
            "IMG_bmp.c", "IMG_gif.c", "IMG_gpu.c", "IMG_jpg.c", "IMG_jxl.c", "IMG_lbm.c", "IMG_pcx.c",
            "IMG_png.c", "IMG_pnm.c", "IMG_qoi.c", "IMG_stb.c", "IMG_svg.c", "IMG_tga.c", "IMG_tif.c",
            "IMG_webp.c", "IMG_xcf.c", "IMG_xpm.c", "IMG_xv.c", "IMG_libpng.c", "xmlman.c")],
         ["-DBUILD_SDL", "-DSDL_BUILD_MAJOR_VERSION=3", "-DSDL_BUILD_MINOR_VERSION=4",
          "-DSDL_BUILD_MICRO_VERSION=4", "-DLOAD_PNG", "-DSAVE_PNG=1", "-DLOAD_BMP", "-DUSE_STBIMAGE",
          "-DSDL_IMAGE_USE_COMMON_BACKEND"] + inc([image / "include", image / "src"])),
        ("engine", engine_sources() + generate(),
         ["-DBFDEBUG_LEVEL=0", "-DDEBUG=0", "-DKFX_NO_MOVIES", "-DKFX_NO_NET", "-DSPNG_STATIC=1",
          "-include", str(ROOT / "native" / "compat" / "lua_compat.h"),
          "-include", str(ROOT / "native" / "compat" / "al_compat.h")] + inc(ENGINE_INCLUDES)),
    ]


# --- compiling -------------------------------------------------------------------------------

def object_for(name: str, src: Path) -> Path:
    try:
        rel = src.relative_to(ROOT)
    except ValueError:
        rel = Path(src.name)
    return OBJ / name / rel.with_suffix(rel.suffix + ".o")


def up_to_date(obj: Path) -> bool:
    """An object is current if it is newer than every file its depfile names."""
    dep = obj.with_suffix(".d")
    if not obj.is_file() or not dep.is_file():
        return False
    built = obj.stat().st_mtime
    body = dep.read_text(encoding="utf-8").replace("\\\n", " ").partition(": ")[2]
    for name in body.replace("\\ ", "\0").split():
        path = Path(name.replace("\0", " "))
        if not path.is_file() or path.stat().st_mtime > built:
            return False
    return True


def compile_all(emcc: list[str], empp: list[str], env: dict) -> bool:
    units = []
    for name, sources, flags in components():
        stamp = OBJ / name / "flags.json"
        wanted = json.dumps([COMMON, flags])
        if stamp.is_file() and stamp.read_text(encoding="utf-8") != wanted:
            say(f"{name}: flags changed, recompiling it")
            shutil.rmtree(OBJ / name)
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(wanted, encoding="utf-8")
        for src in sources:
            obj = object_for(name, src)
            if not up_to_date(obj):
                driver, std = (empp, "-std=gnu++20") if src.suffix == ".cpp" else (emcc, "-std=gnu11")
                if name != "engine" and src.suffix == ".c":
                    std = "-std=gnu99"
                units.append((name, src, obj, driver + [std] + COMMON + flags))
    total = sum(len(s) for _, s, _ in components())
    say(f"{len(units)} of {total} sources to compile, {jobs()} at a time")

    failures = []

    def one(unit):
        name, src, obj, argv = unit
        obj.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(argv + ["-MD", "-MF", str(obj.with_suffix(".d")), "-c", str(src), "-o", str(obj)],
                              env=env, capture_output=True, text=True, errors="replace",
                              creationflags=getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0))
        return unit, proc

    started = time.time()
    with ThreadPoolExecutor(max_workers=jobs()) as pool:
        for done, future in enumerate(as_completed([pool.submit(one, u) for u in units]), 1):
            unit, proc = future.result()
            name, src, obj, _ = unit
            rel = src.relative_to(ROOT) if src.is_relative_to(ROOT) else src
            if proc.returncode != 0:
                failures.append(rel)
                obj.unlink(missing_ok=True)
                say(f"[{done}/{len(units)}] FAILED {rel}\n{proc.stderr.strip()}")
            else:
                say(f"[{done}/{len(units)}] {rel}")
                if proc.stderr.strip():
                    say(proc.stderr.strip())
    say(f"compiled in {round(time.time() - started)}s, {len(failures)} failure(s)")
    for rel in failures:
        say(f"  failed: {rel}")
    return not failures


def link(empp: list[str], env: dict) -> bool:
    objects = [str(object_for(name, src)) for name, sources, _ in components() for src in sources]
    SITE.mkdir(exist_ok=True)
    rsp = BUILD / "link.rsp"
    rsp.write_text("\n".join(f'"{o}"' for o in objects), encoding="utf-8")
    say("linking site/keeperfx.js + site/keeperfx.wasm")
    started = time.time()
    proc = subprocess.run(empp + [f"@{rsp}", "-o", str(SITE / "keeperfx.js")] + LINK,
                          env=env, capture_output=True, text=True, errors="replace",
                          creationflags=getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0))
    if proc.stdout.strip():
        say(proc.stdout.strip())
    if proc.stderr.strip():
        say(proc.stderr.strip())
    if proc.returncode != 0:
        say("link FAILED")
        return False
    wasm = SITE / "keeperfx.wasm"
    digest = hashlib.sha256(wasm.read_bytes()).hexdigest()[:16]
    say(f"linked in {round(time.time() - started)}s: {wasm.name} {wasm.stat().st_size:,} bytes, sha256 {digest}")
    return True


def main() -> int:
    global _log_file
    if not (KFX / "src").is_dir():
        print("vendor/keeperfx is missing: run  py -3.10 scripts/vendor.py  first")
        return 2
    BUILD.mkdir(exist_ok=True)
    _log_file = open(LOG, "w", encoding="utf-8")
    say(f"keeperfx web build, {datetime.now().isoformat(timespec='seconds')}")
    emcc, empp, env = toolchain()
    take_lock()
    try:
        ok = compile_all(emcc, empp, env) and link(empp, env)
    finally:
        release_lock()
    say("BUILD OK" if ok else "BUILD FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
