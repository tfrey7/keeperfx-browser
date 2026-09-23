# The player's own game files

How the page takes the original Dungeon Keeper files, keeps them, and hands them to the engine.
Phase 3 of [PLAN.md](../PLAN.md). The page is `site/`; its screenshots are in `proof/`.

## The manifest

`site/js/manifest.js`, taken from KeeperFX's own installer
([keeperfx-launcher-qt `src/dkfiles.cpp`](https://github.com/dkfans/keeperfx-launcher-qt/blob/04f7b3dcaab2ad0b750b7632be8a21cf05a1399e/src/dkfiles.cpp)):

- **Required** (14): `data/` bluepal.dat, bluepall.dat, dogpal.pal, hitpall.dat, lightng.pal,
  redpal.col, redpall.dat, slab0-0.dat, slab0-1.dat, vampal.pal, whitepal.col; `sound/`
  atmos1.sbk, atmos2.sbk, bullfrog.sbk.
- **Optional** (6): `music/keeper02.ogg` to `keeper07.ogg`. The digital editions keep them in
  their root folder; the game plays without them.

The installer checks names only, case-insensitively, and so does the page: without a real copy
in hand we have no sizes or hashes to check against. The older list in KeeperFX's
`docs/files_required_from_original_dk.txt` also names `main.pal` and `mapfadeg.dat`; the installer
dropped them (KeeperFX ships or generates both), so the page does not ask for them. If the
engine turns out to need them, add them to `REQUIRED`.

A `data/` or `sound/` file must sit in a folder of that name, anywhere under what the player
chose, so the outer GOG, Steam or EA folder works as well as the inner one. When a name turns
up more than once, the shallowest copy wins.

## Where the files live

| Path in the Emscripten filesystem | What |
|---|---|
| `/keeperfx` | the engine's game directory |
| `/keeperfx/player` | an IDBFS mount: the kept files, in IndexedDB (`data/`, `sound/`, `music/`, all lower case) |
| `/keeperfx/data/<name>` etc. | a symlink to `/keeperfx/player/data/<name>` |

The player's files are linked in rather than mounted over `data/`, because KeeperFX's own GPL
files go in the same folders. `site/js/storage.js` does all of it: `mountStore(FS)` mounts,
reads back what an earlier visit kept and makes the links; `keepFiles` replaces the kept set;
`forgetFiles` removes it from IndexedDB. The engine build calls `mountStore(Module.FS)` before
`main` runs (in `preRun`, holding a run dependency until it resolves) and links `-lidbfs.js`.

IDBFS was chosen over OPFS because the engine can mount it with no threads: Emscripten's OPFS
backend needs WasmFS and pthreads, so cross-origin isolation, for no gain here.

## Proving it

```
py -3.10 scripts/build_reader.py                 # site/reader.js + reader.wasm
py -3.10 scripts/serve.py --port <port>
node scripts/prove_files.mjs --url http://localhost:<port>/ --debug-port <another port> --work <scratch> --shots docs/proof
```

`tools/reader/reader.c` stands in for the engine: it lists `data/`, `sound/` and `music/` under
`/keeperfx` with plain stdio, opening and reading every file. `prove_files.mjs` makes fake
installs (right names, dummy bytes) and drives the served page in headless Chrome: a folder
missing two files is refused by name, a complete folder is kept, it survives a reload, "forget
my files" forgets it, and a `.zip` of the folder works too.
