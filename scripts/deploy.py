"""Wait for a landing to go live at https://dungeonkeeper.tfrey7.com/, then check the live site.

    py -3.10 scripts/deploy.py --sha <commit> [--item <job>]

This machine builds and uploads nothing. Every push to master is built and published by GitHub
(.github/workflows/publish.yml); fleet.json's restartHook runs this after each landing, so the
landing is not called live until the site says so. It waits for the live version.json to name the
commit (or a later one that carries it), then checks the live pages, the engine and KeeperFX's
data answer. The outcome is written to .state/deploy.json.

A failure is loud: a block of "!!" lines, the first saying what failed and the second why, which
the console repeats in the room. The live site is then still the previous build.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".state"
LIVE_URL = "https://dungeonkeeper.tfrey7.com/"
ACTIONS_URL = "https://github.com/tfrey7/keeperfx-browser/actions"
#: Inside the console's 15 minutes for a landing's hook. A publish with the engine already built
#: takes about five; one that rebuilds the engine can take longer, and says so.
WAIT_S = 13 * 60
POLL_S = 20


def fetch(url: str, timeout: float = 60) -> tuple[int, dict, bytes]:
    """(status, headers, body); status 0 when the site did not answer."""
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "keeperfx-deploy"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers or {}), b""
    except (urllib.error.URLError, OSError, ValueError):
        return 0, {}, b""


def live_sha(url: str = LIVE_URL, get=fetch) -> str:
    status, _, body = get(f"{url}version.json?t={int(time.time())}", 30)
    try:
        return json.loads(body).get("sha", "") if status == 200 else ""
    except ValueError:
        return ""


def same(a: str, b: str) -> bool:
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


def carries(later: str, sha: str) -> bool:
    """Whether commit `later` already has commit `sha` in it."""
    return subprocess.run(["git", "merge-base", "--is-ancestor", sha, later], cwd=ROOT,
                          capture_output=True).returncode == 0


def wait_for(sha: str, get=fetch, wait_s: float = WAIT_S, poll_s: float = POLL_S,
             sleep=time.sleep, clock=time.monotonic, has=carries) -> str:
    """The live commit once it is `sha` or carries it; "" if that never happens in time."""
    deadline = clock() + wait_s
    while True:
        got = live_sha(get=get)
        if got and (same(got, sha) or has(got, sha)):
            return got
        if clock() >= deadline:
            return ""
        sleep(poll_s)


def check_live(url: str = LIVE_URL, get=fetch) -> list[str]:
    """What is wrong with the live site, or [] when every part answers as it should."""
    wrong = []
    status, _, body = get(url)
    if status != 200 or b"Where is your Dungeon Keeper" not in body:
        wrong.append(f"the files page answered {status or 'nothing'} without asking for the folder")
    status, _, body = get(f"{url}engine.html")
    if status != 200 or b"keeperfx.js" not in body:
        wrong.append(f"engine.html answered {status or 'nothing'}")
    status, headers, body = get(f"{url}keeperfx.wasm", 180)
    kind = {k.lower(): v for k, v in headers.items()}.get("content-type", "")
    if status != 200 or not body.startswith(b"\0asm") or "wasm" not in kind:
        wrong.append(f"keeperfx.wasm answered {status or 'nothing'} ({kind or 'no type'})")
    status, _, body = get(f"{url}kfxdata/index.json")
    try:
        files = json.loads(body).get("files", []) if status == 200 else []
    except ValueError:
        files = []
    if not files:
        wrong.append(f"KeeperFX's data list answered {status or 'nothing'} with no files")
    else:
        name = files[0][0]
        status, _, _ = get(f"{url}kfxdata/{'/'.join(urllib.request.quote(p) for p in name.split('/'))}")
        if status != 200:
            wrong.append(f"KeeperFX's data file {name} answered {status or 'nothing'}")
    status, _, body = get(f"{url}changes.html")
    if status != 200 or b"<time>" not in body:
        wrong.append(f"the recent changes page answered {status or 'nothing'}")
    return wrong


def loud(what: str, why: str) -> str:
    bar = "!" * 72
    return f"{bar}\n!! {what}\n!! {why}\n{bar}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sha", required=True)
    parser.add_argument("--item", default="")
    parser.add_argument("--wait", type=float, default=WAIT_S, help="seconds to wait for GitHub's publish")
    args = parser.parse_args(argv)
    sha = args.sha[:12]
    record = {"sha": sha, "item": args.item, "url": LIVE_URL, "at": time.strftime("%Y-%m-%d %H:%M:%S")}
    got = wait_for(sha, wait_s=args.wait)
    if not got:
        record.update(ok=False, why=f"GitHub had not published it after {round(args.wait / 60)} minutes")
        print(loud(f"dungeonkeeper.tfrey7.com is not showing {sha} yet",
                   f"{record['why']}; the live site is still the previous build, see {ACTIONS_URL}"))
    else:
        wrong = check_live()
        record.update(ok=not wrong, live=got, wrong=wrong)
        if wrong:
            print(loud(f"dungeonkeeper.tfrey7.com went live with {got} but fails its live check",
                       "; ".join(wrong)))
        else:
            print(f"{LIVE_URL} is live with {got}: files page, engine, KeeperFX's data and changes all answer")
    STATE.mkdir(exist_ok=True)
    (STATE / "deploy.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return 0 if record["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
