# keeperfx-browser

KeeperFX (the open-source Dungeon Keeper engine) compiled to WebAssembly and played in a web page
with the player's own original game files. The plan and the rulings every job follows are in
[PLAN.md](PLAN.md). Read them before changing anything.

## Run it

The page (phase 3, the player's own files) runs with a small stand-in reader until the engine
is built; see [docs/GAME-FILES.md](docs/GAME-FILES.md).

```
py -3.10 scripts/build_reader.py          # needs the Emscripten SDK
py -3.10 scripts/serve.py --port 8000
```

The real engine boots to its main menu at `/engine.html` once the files page has the player's
folder. It also needs KeeperFX's own data, which is not in this repo: unpack KeeperFX's
`keeperfx_1_4_0_complete.7z` outside the repo, then

```
py -3.10 scripts/vendor.py && py -3.10 scripts/build_wasm.py      # heavy build, see below
py -3.10 scripts/gamedata.py --release <unpacked release> --out <folder outside the repo>
py -3.10 scripts/serve.py --port 8000 --kfx-data <that folder>
```

[docs/PORTING-NOTES.md §9](docs/PORTING-NOTES.md) has the details and the proof script.

## Where it is published

<https://dungeonkeeper.tfrey7.com/>, on GitHub Pages. Every push to `master` is built and
published by GitHub (`.github/workflows/publish.yml`): the engine with Emscripten (kept between
runs while its inputs are unchanged), KeeperFX's own GPL release data from KeeperFX's GitHub
release (`scripts/fetch_release.py`, then `scripts/gamedata.py`), and the site put together by
`scripts/build_site.py`, which refuses any original Dungeon Keeper file. Nothing heavy runs on
this machine. After each landing the console runs `scripts/deploy.py` (fleet.json's
`restartHook`), which waits for the live site to name the landed commit and checks it answers.
The site's `changes.html` lists every landing, one dated line each.

## Test it

```
py -3.10 -m unittest discover -s tests -v
```

## One heavy build at a time

Only one engine build runs on this machine at a time, KeeperFX's or ut-browser's. There are two
locks, and a KeeperFX build holds both while it compiles, always taken in this order. Both, and
the build cache, live in the one folder every project's builds on the machine share:
`H:/Claude Stuff/.build-cache`, or wherever `SHARED_BUILD_CACHE` names. Never G: (it failed on
2026-09-25 and is off limits): nothing a build reads, writes or runs is on it.

1. **KeeperFX's own**: `heavy-build.lock` in that folder, a file holding who made it and when
   (written first and linked into place, so it is never seen empty),
   removed when the build ends. If it exists and is less than two hours old, another KeeperFX build
   is running: wait for it. An empty one names no holder, so after a minute it is nobody's: clear it.
2. **The engine-build lock**: `build.lock` in that folder (or wherever
   `KFX_UT_BUILD_LOCK` names), the lock ut-browser's own `scripts/buildlock.py` takes. It is not a
   file that exists or not: the build locks its first byte, and the operating system lets go when
   that process ends, however it ends. `build.lock.who` beside it names the holder. A KeeperFX
   build waits for it and then takes it, so ut-browser's engine builds wait for KeeperFX's in turn.

Cap parallelism at `-j4`.

`scripts/build_wasm.py` does all of that itself, logging the time it waits for, takes and releases
each lock, and keeps what it builds in a cache shared by every
checkout on the machine: `keeperfx-browser` in the shared folder (or wherever `KFX_BUILD_CACHE`
names, but never under `C:/Users`). It holds each compiled object, keyed by its source, flags and
headers; the last few linked engines; and Emscripten's own cache (SDL3 and the system libraries),
one per SDK version. So a fresh checkout with nothing changed gets the engine back in seconds
without taking the lock, and one that changed a file recompiles only that and relinks. Nothing in
the cache is committed; delete the folder to start cold.

## Never commit

Original Dungeon Keeper files (`*.dat`, `*.tab`, `*.pal`, `*.sbk`, `*.wad`, `*.raw`, `*.dk`,
`*.sav`, levels and sounds from the game), build output, or the Emscripten SDK. `tests/` enforces
the first.
