# keeperfx-browser

KeeperFX (the open-source Dungeon Keeper engine) compiled to WebAssembly and played in a web page
with the player's own original game files. The plan and the rulings every job follows are in
[PLAN.md](PLAN.md). Read them before changing anything.

## Run it

Nothing to run yet. Phase 2 adds the build script and phase 3 the page.

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
