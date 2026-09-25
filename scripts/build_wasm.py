"""Compile the real KeeperFX engine to WebAssembly: site/keeperfx.js + site/keeperfx.wasm.

    py -3.10 scripts/vendor.py        # once: the pinned sources, patched
    py -3.10 scripts/build_wasm.py    # the engine; from the machine-wide cache when it can

What goes in is upstream's own source list (src/**/*.c, *.cpp) with two switches for the web,
all recorded in docs/PORTING-NOTES.md:

- KFX_NO_NET     the five networking files are replaced by native/stubs/net_stub.c
- LuaJIT         is replaced by PUC Lua 5.1.5 plus native/compat/lua_compat.h

The movies play through FFmpeg as on the desktop, compiled from source down to the Smacker
demuxer and decoders: native/ffmpeg/ holds the configuration and the source list
(scripts/ffmpeg_config.py writes them).

The script drives Emscripten's compiler directly, one process per source file; no CMake needed.
It is a heavy build, so it takes the machine-wide locks the README describes (its own and
ut-browser's), runs at most four compilers at once at below-normal priority, and writes everything
it says to build/wasm-build.log.

Every object it compiles, and every engine it links, goes into the machine-wide build cache
(scripts/buildcache.py), which every checkout shares. A checkout whose sources, headers and flags
all match a cached engine gets it back in seconds and takes no lock; one that changed a file
compiles only what that change reaches, then links.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import buildcache  # noqa: E402

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
HEAVY_LOCK = Path(os.environ.get("KFX_HEAVY_BUILD_LOCK") or buildcache.SHARED_ROOT / "heavy-build.lock")
LOCK_STALE_SECONDS = 2 * 60 * 60
#: A build's lock names it from the instant it exists (claim_lock), so an empty one older than this
#: was left by something else: nobody holds it.
EMPTY_LOCK_GRACE_SECONDS = 60
#: ut-browser's engine-build lock (its scripts/buildlock.py machine_lock): a byte lock the OS holds
#: for the process that took it. Every KeeperFX build waits for it too, and holds it while it
#: builds, so neither project's engine build runs alongside the other's. It sits in the shared
#: folder, where ut-browser's builds are pointed at it too.
UT_LOCK = Path(os.environ.get("KFX_UT_BUILD_LOCK") or buildcache.SHARED_ROOT / "build.lock")
#: README rule: -j4 at most.
MAX_JOBS = 4

#: KFX_NO_NET: upstream's networking files, replaced by our stub.
NET_FILES = {"bflib_enet.cpp", "net_lan.c", "net_holepunch.c", "net_matchmaking.c", "net_portforward.cpp"}
#: Windows-only files, excluded exactly as upstream's own Linux build does.
WINDOWS_FILES = {"PlatformWindows.cpp", "WindowCompositorWin.cpp"}

COMMON = ["-O2", "-w", "-sUSE_SDL=3", "-sUSE_ZLIB=1", "-fexceptions"]

LINK = [
    "-O2", "-sUSE_SDL=3", "-sUSE_ZLIB=1", "-lopenal", "-fexceptions",
    # The engine's blocking loops yield to the browser through Asyncify (PORTING-NOTES §3.5).
    "-sASYNCIFY=1", "-sASYNCIFY_STACK_SIZE=1048576",
    "-sSTACK_SIZE=4MB", "-sINITIAL_MEMORY=256MB", "-sALLOW_MEMORY_GROWTH=1",
    "-sFORCE_FILESYSTEM=1", "-lidbfs.js",
    # The page mounts the game folder, then calls main itself. EXIT_RUNTIME=1 lets the engine end:
    # when the player quits, main returns and the page's onExit hears it; without it the canvas
    # goes black while the page still says the engine is running.
    "-sMODULARIZE=1", "-sEXPORT_NAME=KeeperFX", "-sINVOKE_RUN=0", "-sEXIT_RUNTIME=1",
    "-sEXPORTED_RUNTIME_METHODS=FS,callMain",
    # keeperfx.js.symbols: wasm function index -> name, so a stack from the browser can be read.
    "--emit-symbol-map",
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
    """The pinned SDK: $EMSDK or ./emsdk if it is that version; else install ./emsdk. Never G:."""
    for guess in (os.environ.get("EMSDK"), ROOT / "emsdk"):
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
    # libraries are built into the cache. It is machine-wide, one per SDK version, so each is built
    # once for every checkout. EMCC_CORES caps those builds at the same -j4.
    env["EM_CACHE"] = str(buildcache.em_cache(EMSDK_VERSION))
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


def stale_lock_reason(holder: str, age: float) -> str:
    """Why a heavy-build lock this old, naming this holder, is nobody's any more; "" while live."""
    if age >= LOCK_STALE_SECONDS:
        return f"stale ({int(age)}s old)"
    if not holder and age >= EMPTY_LOCK_GRACE_SECONDS:
        return f"empty, naming no holder ({int(age)}s old)"
    return ""


def claim_lock(lock: Path, holder: str) -> bool:
    """Put a lock file naming its holder in place, all at once; False if one is there already.

    The holder is written to a file of our own first and then hard-linked to the lock's name,
    which fails if the lock exists. So the lock is never seen empty, and a build killed at any
    moment leaves either no lock or one that names it (job 218: an empty lock blocked every build).
    """
    mine = lock.with_name(f"{lock.name}.{run_name()}.{os.getpid()}.tmp")
    mine.write_text(holder, encoding="utf-8")
    try:
        os.link(mine, lock)
        return True
    except FileExistsError:
        return False
    finally:
        mine.unlink(missing_ok=True)


def take_lock() -> None:
    who = f"{run_name()} build_wasm pid {os.getpid()}"
    told = False
    while not claim_lock(HEAVY_LOCK, f"{who}\n{datetime.now().isoformat(timespec='seconds')}\n"):
        try:
            age = time.time() - HEAVY_LOCK.stat().st_mtime
            holder = HEAVY_LOCK.read_text(encoding="utf-8").strip()
        except OSError:
            continue  # released between the two calls
        reason = stale_lock_reason(holder, age)
        if reason:
            say(f"removing a heavy-build lock that is {reason}: {holder or '(empty)'}")
            HEAVY_LOCK.unlink(missing_ok=True)
            continue
        if is_our_dead_lock(holder, run_name()):
            say(f"removing our own lock from a build that died: {holder}")
            HEAVY_LOCK.unlink(missing_ok=True)
            continue
        if not told:
            say(f"{stamp()} waiting for the heavy-build lock, held by: {holder}")
            told = True
        time.sleep(30)
    say(f"{stamp()} took the heavy-build lock at {HEAVY_LOCK}")


def release_lock() -> None:
    try:
        if f"pid {os.getpid()}" in HEAVY_LOCK.read_text(encoding="utf-8"):
            HEAVY_LOCK.unlink()
            say(f"{stamp()} released the heavy-build lock")
    except OSError:
        pass


def _try_byte_lock(handle) -> bool:
    """Lock byte 0 of the file without waiting, exactly as ut-browser's buildlock.py does."""
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def ut_holder(lock: Path) -> str:
    """Who holds ut-browser's lock, from the note its holder writes beside it."""
    try:
        who = json.loads(lock.with_name(lock.name + ".who").read_text(encoding="utf-8"))
        return f"{who['what']} (pid {who['pid']}, for {int(time.time() - who['since'])}s)"
    except (OSError, ValueError, KeyError):
        return "another build"


def take_ut_lock(lock: Path = UT_LOCK, poll: float = 1.0, while_waiting=lambda: None):
    """Wait for ut-browser's engine-build lock, take it and name ourselves in its .who note.

    Returns the open handle; the lock lasts until release_ut_lock, or until this process dies.
    while_waiting runs on every poll: the build uses it to keep its own heavy-build lock fresh,
    so a long wait here does not make that lock look stale to the next KeeperFX build.
    """
    lock.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock, "a+b")
    waited = time.time()
    told = False
    while not _try_byte_lock(handle):
        if not told:
            say(f"{stamp()} waiting for ut-browser's engine build lock, held by: {ut_holder(lock)}")
            told = True
        while_waiting()
        time.sleep(poll)
    lock.with_name(lock.name + ".who").write_text(json.dumps(
        {"what": f"keeperfx-browser: {run_name()} build_wasm", "pid": os.getpid(), "since": time.time()}),
        encoding="utf-8")
    say(f"{stamp()} took ut-browser's engine build lock at {lock}"
        + (f" after waiting {round(time.time() - waited)}s" if told else ""))
    return handle


def release_ut_lock(handle) -> None:
    with contextlib.suppress(OSError):
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    handle.close()
    say(f"{stamp()} released ut-browser's engine build lock")


@contextlib.contextmanager
def heavy_build():
    """Both machine-wide locks, always ours first and then ut-browser's, so two waiters never
    hold one each and wait on each other."""
    take_lock()
    try:
        ut = take_ut_lock(while_waiting=touch_lock)
        try:
            yield
        finally:
            release_ut_lock(ut)
    finally:
        release_lock()


def touch_lock() -> None:
    with contextlib.suppress(OSError):
        os.utime(HEAVY_LOCK)


def stamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


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


FFMPEG = VENDOR / "FFmpeg"
#: What scripts/ffmpeg_config.py wrote: FFmpeg's configuration and the sources it compiles.
FFMPEG_CONFIG = ROOT / "native" / "ffmpeg"

ENGINE_INCLUDES = [
    KFX / "src", GENERATED, KFX / "deps" / "centitoml", KFX / "deps", KFX / "deps" / "glad" / "include",
    VENDOR / "lua-5.1.5" / "src", VENDOR / "centijson" / "src", VENDOR / "libspng" / "spng",
    VENDOR / "zlib" / "contrib", VENDOR / "astronomy",
    VENDOR / "SDL_mixer" / "include", VENDOR / "SDL_image" / "include",
    FFMPEG, FFMPEG_CONFIG / "include",
]


def ffmpeg_sources() -> list[Path]:
    lines = (FFMPEG_CONFIG / "sources.txt").read_text(encoding="utf-8").splitlines()
    return [FFMPEG / line for line in lines if line and not line.startswith("#")]


#: FFmpeg's own compiler flags from its configure (ffbuild/config.mak), for size (-Oz).
FFMPEG_FLAGS = ["-std=c17", "-Oz", "-fno-math-errno", "-fno-signed-zeros", "-DHAVE_AV_CONFIG_H",
                "-D_ISOC11_SOURCE", "-D_FILE_OFFSET_BITS=64", "-D_LARGEFILE_SOURCE",
                "-D_POSIX_C_SOURCE=200112", "-D_XOPEN_SOURCE=600"]


#: SDL_mixer's built-in decoders; no external codec libraries. MP3 is for the mentor's speech
#: (MIX_LoadAudio in bflib_sndlib.cpp).
MIXER_DECODERS = ["-DDECODER_WAV", "-DDECODER_AIFF", "-DDECODER_VOC", "-DDECODER_AU",
                  "-DDECODER_OGGVORBIS_STB", "-DDECODER_FLAC_DRFLAC", "-DDECODER_MP3_DRMP3"]

#: Flags for one source file only, on top of its component's.
FILE_FLAGS = {
    # bflib_sndlib.cpp compiles its own copy of dr_mp3 for custom sounds; SDL_mixer compiles
    # another for speech. Static here, the engine's copy never meets the mixer's at link.
    "bflib_sndlib.cpp": ["-DDRMP3_API=static", "-DDRMP3_PRIVATE=static"],
}


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
          "-DSDL_BUILD_MICRO_VERSION=4"] + MIXER_DECODERS
         + inc([mixer / "include", mixer / "src", mixer / "src" / "codecs"])),
        ("SDL_image", [image / "src" / f for f in (
            "IMG.c", "IMG_WIC.c", "IMG_ani.c", "IMG_anim_encoder.c", "IMG_anim_decoder.c", "IMG_avif.c",
            "IMG_bmp.c", "IMG_gif.c", "IMG_gpu.c", "IMG_jpg.c", "IMG_jxl.c", "IMG_lbm.c", "IMG_pcx.c",
            "IMG_png.c", "IMG_pnm.c", "IMG_qoi.c", "IMG_stb.c", "IMG_svg.c", "IMG_tga.c", "IMG_tif.c",
            "IMG_webp.c", "IMG_xcf.c", "IMG_xpm.c", "IMG_xv.c", "IMG_libpng.c", "xmlman.c")],
         ["-DBUILD_SDL", "-DSDL_BUILD_MAJOR_VERSION=3", "-DSDL_BUILD_MINOR_VERSION=4",
          "-DSDL_BUILD_MICRO_VERSION=4", "-DLOAD_PNG", "-DSAVE_PNG=1", "-DLOAD_BMP", "-DUSE_STBIMAGE",
          "-DSDL_IMAGE_USE_COMMON_BACKEND"] + inc([image / "include", image / "src"])),
        ("ffmpeg", ffmpeg_sources(),
         FFMPEG_FLAGS + inc([FFMPEG_CONFIG, FFMPEG_CONFIG / "include", FFMPEG, FFMPEG / "compat" / "stdbit"])),
        ("engine", engine_sources() + generate(),
         ["-DBFDEBUG_LEVEL=0", "-DDEBUG=0", "-DKFX_NO_NET", "-DSPNG_STATIC=1",
          "-include", str(ROOT / "native" / "compat" / "lua_compat.h"),
          "-include", str(ROOT / "native" / "compat" / "al_compat.h")] + inc(ENGINE_INCLUDES)),
    ]


# --- compiling -------------------------------------------------------------------------------

#: What a link makes, and what the build cache keeps of a finished engine.
OUTPUTS = ["keeperfx.js", "keeperfx.wasm", "keeperfx.js.symbols"]


class Unit:
    """One source to compile: where its object goes, how it is compiled, and its cache key."""

    def __init__(self, name: str, src: Path, flags: list[str], emcc: list[str], empp: list[str]):
        self.src, self.obj = src, object_for(name, src)
        driver, std = (empp, "-std=gnu++20") if src.suffix == ".cpp" else (emcc, "-std=gnu11")
        if name != "engine" and src.suffix == ".c":
            std = "-std=gnu99"
        self.flags = [std] + COMMON + flags
        self.driver = driver
        # The key names the driver (emcc or em++), not where this copy's SDK happens to live.
        self.what = [Path(driver[-1]).stem] + self.flags
        self.base = ""
        self.cached: str | None = None  # the id of the cached object that serves it, if one does


def object_for(name: str, src: Path) -> Path:
    try:
        rel = src.relative_to(ROOT)
    except ValueError:
        rel = Path(src.name)
    return OBJ / name / rel.with_suffix(rel.suffix + ".o")


def plan(units: list[Unit], memo: dict) -> list[Unit]:
    """Look every unit up in the shared cache; the ones it cannot serve."""
    missing = []
    for unit in units:
        unit.base = buildcache.unit_key(EMSDK_VERSION, unit.what, unit.src, ROOT, memo)
        unit.cached = buildcache.lookup(unit.base, ROOT, memo)
        if unit.cached is None:
            missing.append(unit)
    return missing


def engine_key(units: list[Unit]) -> str:
    """A finished engine's key: the objects in it, in link order, and how they are linked."""
    return buildcache.key("engine", EMSDK_VERSION, LINK, [u.cached for u in units])


def compile_units(units: list[Unit], env: dict) -> bool:
    """Compile the units the cache could not serve, and keep each object in the cache."""
    say(f"{len(units)} source(s) to compile, {jobs()} at a time")
    memo: dict = {}
    failures = []

    def one(unit: Unit):
        unit.obj.parent.mkdir(parents=True, exist_ok=True)
        depfile = unit.obj.with_suffix(".d")
        proc = subprocess.run(unit.driver + unit.flags + ["-MD", "-MF", str(depfile), "-MT", "x",
                                                          "-c", str(unit.src), "-o", str(unit.obj)],
                              env=env, capture_output=True, text=True, errors="replace",
                              creationflags=getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0))
        return unit, proc

    started = time.time()
    with ThreadPoolExecutor(max_workers=jobs()) as pool:
        for done, future in enumerate(as_completed([pool.submit(one, u) for u in units]), 1):
            unit, proc = future.result()
            rel = unit.src.relative_to(ROOT) if unit.src.is_relative_to(ROOT) else unit.src
            if proc.returncode != 0:
                failures.append(rel)
                unit.obj.unlink(missing_ok=True)
                say(f"[{done}/{len(units)}] FAILED {rel}\n{proc.stderr.strip()}")
                continue
            unit.cached = buildcache.keep(unit.base, unit.obj, unit.obj.with_suffix(".d"), ROOT, memo)
            say(f"[{done}/{len(units)}] {rel}")
            if proc.stderr.strip():
                say(proc.stderr.strip())
    say(f"compiled in {round(time.time() - started)}s, {len(failures)} failure(s)")
    for rel in failures:
        say(f"  failed: {rel}")
    return not failures


def link(units: list[Unit], empp: list[str], env: dict) -> bool:
    SITE.mkdir(exist_ok=True)
    rsp = BUILD / "link.rsp"
    rsp.write_text("\n".join(f'"{u.obj}"' for u in units), encoding="utf-8")
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
    say(f"linked in {round(time.time() - started)}s: {describe_wasm()}")
    return True


def describe_wasm() -> str:
    wasm = SITE / "keeperfx.wasm"
    digest = hashlib.sha256(wasm.read_bytes()).hexdigest()[:16]
    return f"{wasm.name} {wasm.stat().st_size:,} bytes, sha256 {digest}"


def build(emcc: list[str], empp: list[str], env: dict) -> bool:
    """Restore the engine whole if the cache has it; else compile what it lacks, link, keep it."""
    units = [Unit(name, src, flags + FILE_FLAGS.get(src.name, []), emcc, empp)
             for name, sources, flags in components() for src in sources]
    started = time.time()
    missing = plan(units, {})
    say(f"build cache {buildcache.cache_dir()}: {len(units) - len(missing)} of {len(units)} "
        f"objects cached, looked up in {time.time() - started:.1f}s")
    if not missing and buildcache.restore(engine_key(units), SITE, OUTPUTS):
        say(f"restored the engine from the build cache, no lock needed: {describe_wasm()}")
        return True
    with heavy_build():
        # Another checkout may have built what this one lacks while it waited for the locks.
        missing = plan(units, {})
        if not missing and buildcache.restore(engine_key(units), SITE, OUTPUTS):
            say(f"restored the engine, built by another checkout while this one waited: {describe_wasm()}")
            return True
        for unit in units:
            if unit.cached:
                buildcache.fetch(unit.base, unit.cached, unit.obj)
        if not compile_units(missing, env) or not link(units, empp, env):
            return False
        buildcache.store(engine_key(units), SITE, OUTPUTS)
        buildcache.prune_objects()
        return True


def main() -> int:
    global _log_file
    if not (KFX / "src").is_dir():
        print("vendor/keeperfx is missing: run  py -3.10 scripts/vendor.py  first")
        return 2
    BUILD.mkdir(exist_ok=True)
    _log_file = open(LOG, "w", encoding="utf-8")
    started = time.time()
    say(f"keeperfx web build, {datetime.now().isoformat(timespec='seconds')}")
    emcc, empp, env = toolchain()
    ok = build(emcc, empp, env)
    say(f"BUILD {'OK' if ok else 'FAILED'} in {time.time() - started:.1f}s")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
