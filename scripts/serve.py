"""Serve site/ over HTTP, as it will be published.

    py -3.10 scripts/serve.py --port 8840

Binds every address (0.0.0.0) so the link opens from another device too, though the browser only
treats the page as a secure context on localhost or over https. The page serves only itself and
the engine: the player's game files never reach the server.
"""
from __future__ import annotations

import argparse
import functools
import http.server
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self) -> None:
        # Always fresh while developing: a stale reader.js against a new page proves nothing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--bind", default="0.0.0.0")
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=str(SITE))
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"serving {SITE} on http://localhost:{args.port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
