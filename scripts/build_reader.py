"""Build the small reader that stands in for the engine: tools/reader/reader.c -> site/reader.js
and site/reader.wasm (both build output, never committed).

    py -3.10 scripts/build_reader.py [--emsdk G:/emsdk]

A one-file compile, not a heavy engine build, so it takes no build lock. It links Emscripten's
IDBFS, the browser storage the engine will mount the player's files from.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def emcc(emsdk: str | None) -> tuple[list[str], dict]:
    """The argv prefix that runs emcc, and its environment.

    The SDK's emcc.exe shim shells out to a bare `python`, which on Windows is often the
    Microsoft Store stub; running emcc.py with the SDK's own Python always works.
    """
    for base in (emsdk, os.environ.get("EMSDK"), "G:/emsdk", "C:/emsdk", Path.home() / "emsdk"):
        if not base:
            continue
        root = Path(base)
        driver = root / "upstream" / "emscripten" / "emcc.py"
        if not driver.is_file():
            continue
        env = dict(os.environ, EMSDK=str(root))
        if (root / ".emscripten").is_file():
            env["EM_CONFIG"] = str(root / ".emscripten")
        pythons = sorted((root / "python").glob("*/python.exe"))
        python = str(pythons[-1]) if pythons else (shutil.which("python3") or sys.executable)
        # emcc builds missing system libraries through the same shims, so they need it too.
        env["PATH"] = str(Path(python).parent) + os.pathsep + env.get("PATH", "")
        env["EMSDK_PYTHON"] = python
        return [python, str(driver)], env
    sys.exit("Emscripten SDK not found: pass --emsdk or set EMSDK")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--emsdk", help="the Emscripten SDK folder")
    args = parser.parse_args()

    prefix, env = emcc(args.emsdk)
    cmd = prefix + [
        str(ROOT / "tools" / "reader" / "reader.c"),
        "-O2", "-o", str(ROOT / "site" / "reader.js"),
        "-lidbfs.js",
        "-sMODULARIZE=1", "-sEXPORT_NAME=createReader",
        "-sFORCE_FILESYSTEM=1",
        "-sEXPORTED_RUNTIME_METHODS=FS,ccall",
        "-sEXPORTED_FUNCTIONS=_list_game_files",
        "-sALLOW_MEMORY_GROWTH=1",
    ]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True, env=env)
    print("built site/reader.js and site/reader.wasm")


if __name__ == "__main__":
    main()
