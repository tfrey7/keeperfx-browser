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

## Test it

```
py -3.10 -m unittest discover -s tests -v
```

## One heavy build at a time

Before compiling the engine, create `G:/Claude Stuff/.heavy-build.lock` holding your job number
and the time, and remove it when the build ends. If the file exists and is less than two hours old,
another heavy build (ut-browser's too) is running: wait for it, do not build alongside. Cap
parallelism at `-j4`.

## Never commit

Original Dungeon Keeper files (`*.dat`, `*.tab`, `*.pal`, `*.sbk`, `*.wad`, `*.raw`, `*.dk`,
`*.sav`, levels and sounds from the game), build output, or the Emscripten SDK. `tests/` enforces
the first.
