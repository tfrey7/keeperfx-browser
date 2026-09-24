"""Configure the FFmpeg subset the engine's movie player needs, once, into native/ffmpeg/.

    py -3.10 scripts/ffmpeg_config.py --work <scratch folder without spaces in its own name>

KeeperFX plays the original game's Smacker movies (ldata/*.smk) through FFmpeg, in one file,
src/bflib_fmvids.cpp. The web build compiles only what that needs: the Smacker demuxer, the
Smacker video and audio decoders, the file protocol, and the parts of libavutil, libavcodec,
libavformat and libswresample they reach. No other codec, no programs, no threads, no assembly.

FFmpeg's own configure writes the headers that choose all that (config.h and the component
lists). It is a shell script that runs hundreds of compiler tests, so it runs here, by hand,
whenever the FFmpeg pin or the options below change, never on every build. What it wrote is
committed in native/ffmpeg/, together with sources.txt, the list of .c files FFmpeg's Makefiles
would compile under that configuration; scripts/build_wasm.py compiles exactly that list.

It needs a POSIX shell (Git Bash on Windows) and the Emscripten SDK on PATH (emcc, emar...).
FFmpeg refuses to configure out of tree from a path with spaces, so it configures a copy of
vendor/FFmpeg made inside --work, with its temporary files there too.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = ROOT / "vendor" / "FFmpeg"
OUT = ROOT / "native" / "ffmpeg"

#: Everything off, then only the Smacker demuxer and its two decoders, reading from a file.
#: --enable-small trades a little speed for size; the movies are 320x200 at 15 frames a second.
CONFIGURE = [
    "--target-os=none", "--arch=wasm", "--enable-cross-compile",
    "--disable-asm", "--disable-inline-asm", "--disable-simd128", "--disable-runtime-cpudetect",
    "--disable-pthreads", "--disable-w32threads", "--disable-os2threads",
    "--disable-programs", "--disable-doc", "--disable-network", "--disable-debug", "--disable-stripping",
    "--disable-everything", "--disable-autodetect", "--disable-iconv",
    "--disable-avdevice", "--disable-avfilter", "--disable-swscale",
    "--enable-small",
    "--enable-demuxer=smacker", "--enable-decoder=smacker,smackaud", "--enable-protocol=file",
    "--cc=emcc", "--cxx=em++", "--ar=emar", "--ranlib=emranlib", "--nm=emnm",
    "--host-cc=emcc", "--host-ld=emcc", "--pkg-config=false",
]

LIBRARIES = ["libavutil", "libavcodec", "libavformat", "libswresample"]

#: configure's output that the sources include, relative to the FFmpeg tree. avconfig.h is the one
#: FFmpeg's public headers include, so it goes to include/, the only folder the engine is given:
#: the rest (config.h above all) would shadow the engine's own headers of the same name.
PUBLIC = ["libavutil/avconfig.h"]
GENERATED = PUBLIC + [
    "config.h", "config_components.h",
    "libavcodec/codec_list.c", "libavcodec/parser_list.c", "libavcodec/bsf_list.c",
    "libavformat/demuxer_list.c", "libavformat/muxer_list.c", "libavformat/protocol_list.c",
]


def make_vars(config_mak: Path) -> dict[str, str]:
    """The variables configure wrote to ffbuild/config.mak (CONFIG_*, HAVE_*, ARCH, ...)."""
    found = {}
    for line in config_mak.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(!?[A-Za-z0-9_]+)\s*=\s*(.*)$", line)
        if m:
            found[m.group(1)] = m.group(2).strip()
    return found


def expand(text: str, env: dict[str, str]) -> str:
    """$(NAME) references, innermost first, as make would expand them (unset is empty)."""
    pattern = re.compile(r"\$\(([A-Za-z0-9_\-]+)(?::%=([^)]*))?\)")

    def value(m: re.Match) -> str:
        words = env.get(m.group(1), "")
        if m.group(2) is None:
            return words
        # A substitution reference, $(NAME:%=before%after), applied to each word.
        return " ".join(m.group(2).replace("%", w, 1) for w in words.split())

    while True:
        new = pattern.sub(value, text)
        if new == text:
            return new
        text = new


def read_makefile(path: Path, env: dict[str, str], src: Path) -> None:
    """Applies a library Makefile's variable assignments to env, following its includes.

    Only what decides the object list matters: `X = ...`, `X += ...` and `include`. Rules (lines
    with a colon before the assignment) and the tablegen conditionals are skipped.
    """
    text = path.read_text(encoding="utf-8").replace("\\\n", " ")
    for line in text.splitlines():
        line = line.split("#", 1)[0].rstrip()
        inc = re.match(r"^-?include\s+(.*)$", line)
        if inc:
            target = Path(expand(inc.group(1), env).replace("$(SRC_PATH)", "").lstrip("/"))
            target = src / target
            if target.is_file():
                read_makefile(target, env, src)
            elif not line.startswith("-"):
                raise SystemExit(f"{path}: cannot follow {line}")
            continue
        m = re.match(r"^([^\s:=+]+)\s*(\+=|=|:=)\s*(.*)$", line)
        if not m:
            continue
        name, op, value = expand(m.group(1), env), m.group(2), expand(m.group(3), env)
        env[name] = (env.get(name, "") + " " + value).strip() if op == "+=" else value


def library_sources(src: Path, lib: str, config: dict[str, str]) -> list[str]:
    env = dict(config, SRC_PATH="", SUBDIR=f"{lib}/")
    read_makefile(src / lib / "Makefile", env, src)
    arch = src / lib / config.get("ARCH", "") / "Makefile"
    if config.get("ARCH") and arch.is_file():
        read_makefile(arch, env, src)
    read_makefile(src / "ffbuild" / "arch.mak", env, src)
    objects = (env.get("OBJS", "") + " " + env.get("OBJS-yes", "") + " "
               + env.get("STLIBOBJS", "") + " " + env.get("STLIBOBJS-yes", "")).split()
    sources = []
    for obj in sorted(set(objects)):
        c = Path(lib) / (obj[:-2] + ".c")
        if not (src / c).is_file():
            raise SystemExit(f"{lib}: {obj} has no C source (assembly is disabled, so it should not be listed)")
        sources.append(c.as_posix())
    return sources


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", type=Path, required=True, help="a scratch folder for the configure run")
    parser.add_argument("--bash", default="bash", help="a POSIX shell")
    parser.add_argument("--reuse", action="store_true", help="read an earlier configure run in --work")
    args = parser.parse_args()
    if not (FFMPEG / "configure").is_file():
        raise SystemExit("vendor/FFmpeg is missing: run  py -3.10 scripts/vendor.py  first")
    copy = args.work.resolve() / "ffsrc"
    if not args.reuse:
        if copy.exists():
            shutil.rmtree(copy)
        subprocess.run(["git", "clone", "-q", str(FFMPEG), str(copy)], check=True)
        (copy / "tmpd").mkdir()
        # TMPDIR relative to the copy: configure's own temporary paths must hold no spaces either.
        script = "TMPDIR=tmpd ./configure " + " ".join(CONFIGURE)
        print("$", script, flush=True)
        subprocess.run([args.bash, "-c", script], cwd=copy, check=True)

    config = make_vars(copy / "ffbuild" / "config.mak")
    if OUT.exists():
        shutil.rmtree(OUT)
    for rel in GENERATED:
        dest = OUT / ("include/" + rel if rel in PUBLIC else rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(copy / rel, dest)
    # make writes ffversion.h (ffbuild/version.sh); the release number is enough here.
    release = (copy / "RELEASE").read_text(encoding="utf-8").strip()
    (OUT / "libavutil").mkdir(exist_ok=True)
    (OUT / "libavutil" / "ffversion.h").write_text(
        f'#ifndef AVUTIL_FFVERSION_H\n#define AVUTIL_FFVERSION_H\n#define FFMPEG_VERSION "{release}"\n#endif\n',
        encoding="utf-8")
    sources = [s for lib in LIBRARIES for s in library_sources(copy, lib, config)]
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=FFMPEG, capture_output=True, text=True).stdout.strip()
    (OUT / "sources.txt").write_text(
        f"# FFmpeg {commit}, configured by scripts/ffmpeg_config.py; one source per line.\n"
        + "\n".join(sources) + "\n", encoding="utf-8")
    print(f"{len(sources)} FFmpeg sources and {len(GENERATED)} generated files in {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
