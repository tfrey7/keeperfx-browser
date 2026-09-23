# KeeperFX in the browser: the plan

Goal: Dungeon Keeper, as the open-source KeeperFX engine
(<https://github.com/dkfans/keeperfx>, GPLv2), playable in a web page. It is played with the
player's own copy of the original game files and is proved in the page as actually served.

## Rulings (from the ut-browser port; they bind every job)

1. **Compile the real engine; never rewrite or imitate the game.** KeeperFX is C/C++ with SDL2.
   It goes through Emscripten to WebAssembly. Anything that cannot compile is stubbed behind a
   switch and listed in `docs/PORTING-NOTES.md`, never reimplemented in JavaScript. ut-browser lost
   days to imitations that proved nothing.
2. **Prove every step in the page as actually served**: the built `site/` served over HTTP and
   opened in a real browser, with a screenshot. A side harness, a unit test or a native build
   alone proves nothing.
3. **One heavy engine build at a time, machine-wide.** Four parallel builds froze Tim's PC. A job
   that builds the engine takes the lock described in the README first and caps its parallelism
   (`-j4` at most).
4. **No original Dungeon Keeper file is ever committed, shipped or uploaded.** The player
   supplies their own (see below). The test suite fails if one appears in the tree.

## What exists already (quick look, 2026-09-23)

- No browser or WebAssembly port of KeeperFX turned up. Community forks exist for native Linux
  (ForkedInTime/keeperfx-linux-alpha), macOS arm64 (matthewdeaves/keeperfx) and an SDL3 refactor
  (edorien/keeperfx-refactor). They show the engine now builds off Windows with CMake, so its
  platform layer is portable. Job 1 confirms this.
- **DevilutionX (Diablo)** has a WebAssembly build. The player loads their own `DIABDAT.MPQ`
  through a built-in file picker, and saves and settings persist in IndexedDB. This is the
  closest model for handling game data.
- **OpenRCT2** runs in the browser via Emscripten and asks the player to pick their RCT2 data
  folder on first load.
- **ut-browser**, our own port, is the house example of the build scripts, the served-page
  proof, the live check and GitHub Pages deploys.

Upstream facts that shape the port:

- The Windows build is 32-bit (i686 MinGW). wasm32 is also 32-bit, so pointer-size assumptions in
  structs and save files should hold.
- Its dependencies are SDL2, SDL2_mixer, SDL2_net, enet, ffmpeg, lua, zlib, libpng and spng.
  Emscripten ports cover SDL2, SDL2_mixer, zlib and libpng, and lua compiles as plain C.
  **Networking (SDL2_net, enet) is stubbed first**, since browsers have no raw UDP.
  **ffmpeg (intro and cut-scene movies) is stubbed first**: skip the movies, then bring them back
  later.
- The engine runs its own blocking main loop. The browser needs either Asyncify or a refactor to
  `emscripten_set_main_loop`, whichever keeps upstream code intact. Job 1 decides.

## The player's own game files

KeeperFX requires the original Dungeon Keeper (Gold) files as proof of ownership, from the CDs
or from the GOG, EA or Steam editions. The page will:

1. On first visit, ask for the player's Dungeon Keeper folder, via a folder picker
   (`<input webkitdirectory>` / File System Access API) or a `.zip` of it, with a short guide
   for where GOG and Steam put it.
2. Check the files **in the browser** against a manifest of required names and sizes or hashes,
   and name anything missing.
3. Copy the files into browser storage (OPFS, or IndexedDB via Emscripten's IDBFS) and mount them
   at the engine's game directory. They never leave the player's machine: nothing is uploaded and
   the server only serves the engine.
4. Keep them for later visits, keep saves and settings the same way, and offer a "forget my
   files" button.

The page can ship KeeperFX's own GPL assets. It ships only those, and links the source to meet
GPLv2.

## Phases

| # | Phase | Proof in the served page |
|---|-------|--------------------------|
| 1 | Survey and porting notes (no engine build) | `docs/PORTING-NOTES.md` |
| 2 | Toolchain + vendored KeeperFX at a pinned commit; engine compiles to wasm with net and movies stubbed | build log, `.wasm` produced |
| 3 | Player's own files: picker, manifest check, persistent mount | files listed from inside the wasm filesystem |
| 4 | Boot to the main menu | screenshot of the KeeperFX menu in the page |
| 5 | Play: start the first level, dig, drop imps, fight; mouse and keys; sound | screenshots mid-level, audio heard |
| 6 | Saves and settings persist across reloads | save, reload, load |
| 7 | Speed: full frame rate at the default resolution | fps readout |
| 8 | Publish to GitHub Pages; battle test by playing it | live URL |
| later | movies via ffmpeg, multiplayer over WebRTC/WebSocket | |

Jobs 1–3 are the first round. Jobs 4 onward are filed as each phase lands.
