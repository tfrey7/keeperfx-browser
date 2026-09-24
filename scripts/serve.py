"""Serve site/ over HTTP, as it will be published.

    py -3.10 scripts/serve.py --port 8840 [--kfx-data <folder from scripts/gamedata.py>]

Binds every address (0.0.0.0) so the link opens from another device too, though the browser only
treats the page as a secure context on localhost or over https. The page serves only itself and
the engine: the player's game files never reach the server.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import urllib.parse
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
KFX_DATA_URL = "/kfxdata"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    #: KeeperFX's own data folder (scripts/gamedata.py), served at /kfxdata/; None serves none.
    kfx_data: Path | None = None

    def translate_path(self, path: str) -> str:
        if self.kfx_data and path.split("?", 1)[0].startswith(f"{KFX_DATA_URL}/"):
            rel = urllib.parse.unquote(path.split("?", 1)[0][len(KFX_DATA_URL) + 1:])
            target = (self.kfx_data / rel).resolve()
            if target.is_relative_to(self.kfx_data):
                return str(target)
        return super().translate_path(path)

    def end_headers(self) -> None:
        # Always fresh while developing: a stale reader.js against a new page proves nothing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--kfx-data", type=Path, help="KeeperFX's own data, from scripts/gamedata.py")
    args = parser.parse_args()
    if args.kfx_data:
        Handler.kfx_data = args.kfx_data.resolve()
        print(f"serving KeeperFX's data from {Handler.kfx_data} at {KFX_DATA_URL}/", flush=True)
    handler = functools.partial(Handler, directory=str(SITE))
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"serving {SITE} on http://localhost:{args.port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
