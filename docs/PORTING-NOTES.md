# Porting notes: KeeperFX to WebAssembly

Job 1 of [PLAN.md](../PLAN.md): a survey, with no engine build. Written 2026-09-23.

- **Upstream pinned at** `dkfans/keeperfx` commit
  **`211438fa1c7fad37f867e26c61409c344faf4a0c`** (2026-09-23, "Allow console + commands during
  packetload (#5355)"). Clone it into `vendor/keeperfx` (gitignored) and check out that commit.
- **Toolchain on this machine:** emsdk at `G:/emsdk`, Emscripten **6.0.9**. This is the same pin
  ut-browser uses.

Paths below are relative to `vendor/keeperfx` unless they say otherwise.

---

## 0. The short version

The plan was right about the overall shape but wrong about several facts. KeeperFX has moved on
since the plan was written:

| PLAN.md said | Actually, at the pin |
|---|---|
| SDL2, SDL2_mixer, SDL2_net | **SDL3 3.4.12, SDL3_mixer 3.2.4 (`MIX_*` API), SDL3_image 3.4.4.** There is no SDL_net at all: networking is enet6 plus curl plus raw sockets. |
| lua "compiles as plain C" | **It is LuaJIT, which cannot target wasm.** PUC Lua 5.1.5 with about 15 lines of shim is a near drop-in replacement (§3.7). |
| libpng | Not used. **spng** is used, for custom sprites only. |
| ffmpeg for movies | True. It is confined to one file (`bflib_fmvids.cpp`), so stubbing it is easy. |
| (missing) | **OpenAL** (openal-soft) carries all sound effects. Emscripten ships an OpenAL (`-lopenal`). |
| (missing) | **An optional OpenGL 3.3 renderer that runs on its own thread.** The software renderer is the default, so the web build leaves OpenGL out. |
| (missing) | **minizip, centijson, astronomy, curl, miniupnpc, natpmp.** The first three are compiled from source; the last three are stubbed with networking. |
| "Emscripten ports cover SDL2, SDL2_mixer, zlib, libpng" | emsdk 6.0.9 has ports for **`sdl3` (3.4.2)** and `zlib`. It has **no `sdl3_mixer` and no `sdl3_image` port**, so both are built from source with `emcmake`. |
| Asyncify or set_main_loop: undecided | **Asyncify.** The engine has 10 nested blocking loops (§3.5). A single yield in `RendererPresentFrame` covers them all and leaves upstream's loops untouched. |
| Deploy "like ut-browser" to GitHub Pages | ut-browser actually deploys to **Cloudflare Pages** (see §1.3 and §6). |
| The player's DK folder is copied in | Only about **14 small files** come from the original game (§4). Everything else is KeeperFX's own data, and it is not in the git repo, only in the release "complete" archive. Its licence needs checking (§4.4). |

The good news:

- The engine **already has a POSIX platform layer**: `src/kfx/platform/PlatformLinux.cpp`.
- **Every Win32 call is already behind `_WIN32`.**
- The x86 `cpuid` assembly is already guarded.
- There are **no SIMD intrinsics**.
- The software renderer is the default.

Most of the port is build-system work plus four stub switches.

---

## 1. How the existing browser ports were built

### 1.1 DevilutionX (Diablo), diasurgical/devilutionX (HEAD `4138a82`)

- **State.** `docs/building.md` still says the Emscripten port is a work in progress: it builds
  and does little more. No CI job builds it and there is no official demo. The well-known browser
  Diablo, DiabloWeb (d07RiV), is a separate codebase.
- **Build.**
  - `CMake/platforms/emscripten.cmake` turns off networking (`DISABLE_TCP`,
    `DISABLE_ZERO_TIER`), tests and the assets MPQ.
  - Dependencies come from Emscripten ports: `USE_SDL=2`, `USE_ZLIB`, `USE_BZIP2`,
    `USE_SDL_IMAGE=2`.
  - Link flags (`CMakeLists.txt:422-436`): `-sASYNCIFY -sALLOW_MEMORY_GROWTH=1
    -sFORCE_FILESYSTEM=1 -lidbfs.js`, `--preload-file assets`,
    `--shell-file Packaging/emscripten/index.html` and `--pre-js emscripten_pre.js`.
  - LTO is turned off.
- **Main loop: Asyncify, with the upstream loop kept.** `Source/engine/dx.cpp:295,323` call
  `emscripten_sleep(1)` after `SDL_RenderPresent`. Loading is forced onto the main thread
  (`interfac.cpp:50`), because Asyncify cannot unwind across threads.
- **Threads.** SDL is linked with pthreads, but `sdl_thread.h` runs thread bodies inline and
  `sdl_mutex.h` turns mutexes into no-ops, so in practice the game is single-threaded.
- **The player's files.**
  - A "File Manager" modal (`Packaging/emscripten/file-manager.js`) takes a drag-and-drop or an
    `<input type=file accept=".mpq">`.
  - It writes the file with `FS.writeFile` under SDL's pref path, calls `FS.syncfs(false)`, then
    reloads the page.
- **Saves.**
  - IDBFS is mounted at `/libsdl/diasurgical` in `preRun`, and `FS.syncfs(true)` runs under
    `addRunDependency`, so saves exist before `main`.
  - After each save, C calls `emscripten_run_script("Module.saveToIndexedDB()")`.
  - A 30-second interval and `beforeunload` also trigger a sync.
- **Serving.** Only `emrun` is used.

### 1.2 OpenRCT2, OpenRCT2/OpenRCT2 (HEAD `b1258fa`)

- **Build.**
  - `scripts/build-emscripten` runs inside a Docker image and uses
    `-DDISABLE_NETWORK=ON -DDISABLE_OPENGL=ON -DDISABLE_HTTP=ON -DDISABLE_TTF=ON`.
  - Flags: `USE_SDL=2 USE_ZLIB USE_LIBPNG -pthread -O3`,
    `-sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=2GB -sSTACK_SIZE=8MB -sPTHREAD_POOL_SIZE=120`,
    `-sMODULARIZE -sEXPORT_NAME=OPENRCT2_WEB`,
    `-sEXPORTED_RUNTIME_METHODS=ccall,FS,callMain,...`, `-lidbfs.js` and
    `--js-library emscripten/deps.js`.
  - CI (`ci.yml`, job `emscripten`) builds and uploads an artifact but deploys nothing.
- **Main loop: refactored.** `Context.cpp:1204` calls
  `emscripten_set_main_loop_arg(RunFrame, ...)`, and the blocking loop is compiled out. This worked
  because OpenRCT2 already had a single `RunFrame`. KeeperFX does not (§3.5).
- **Threads: real pthreads.** The page refuses to start without `SharedArrayBuffer`, so it needs
  COOP/COEP headers.
- **The player's files.**
  - The page asks for a **zip** and unpacks it with JSZip.
  - It checks a sentinel file (`Data/ch.dat`) and writes into IDBFS mounts with
    `autoPersist: true`.
  - A version file decides when to re-extract OpenRCT2's own assets.
  - The module is created with `noInitialRun`, then `callMain([...paths])` runs once the mounts
    are ready.
- **Saves.**
  - `deps.js` offers `showSaveFilePicker`, with an `<a download>` link as the fallback.
  - Loading is asynchronous: JS calls an exported C function (`LoadGameCallback`) when the file
    arrives, so C never blocks on it.

### 1.3 ut-browser (ours, `G:/Claude Stuff/ut-browser`)

- **Toolchain.**
  - `scripts/toolchain.py` finds emsdk (`$EMSDK`, then `tools.json`, then `G:/emsdk`, ...).
  - It runs `upstream/emscripten/em++.py` with **the SDK's own bundled python**, because the
    `emcc.bat` shim calls a bare `python`, which on Windows is the Store stub.
  - CI pins emsdk 6.0.9.
  - Upstream source is a pinned checkout plus `vendor/patches/*.patch`, applied by
    `scripts/vendor.py`. The patches are kept LF-only via `.gitattributes`.
- **Heavy builds: `scripts/buildlock.py`.**
  - One machine-wide lock, with a file recording who holds it.
  - The `-j` value comes from `UT_BUILD_JOBS`; CI uses 4.
  - Compilers run at below-normal priority.
  - A per-object compile cache lives beside the checkout, not on C:.
  - Tests that build the engine are marked `@heavy` and left out of the quick suite.
- **Main loop: the page owns the frames.** The engine runs in a Web Worker and the page calls
  `ut_frame_step` on each `requestAnimationFrame`. `web/tick.js` reports stalls
  (`STALL_MS`, `DEADLINE_MS`), so a hung loop is never silent. The engine has no Asyncify and no
  pthreads.
- **The player's files.**
  - Chrome uses `showDirectoryPicker`; other browsers fall back to `<input webkitdirectory>`.
  - Files are copied into OPFS (`web/store.js`) with a manifest.
  - `navigator.storage.persist()` is wrapped in a 4-second timeout, because it sometimes never
    resolves.
  - The worker mounts the files through WORKERFS, so large data never enters the wasm heap.
- **Saves.** Changed ini files go to OPFS and are mounted back at start.
- **Proof in the served page.**
  - `scripts/serve.py` picks a free port and serves `build/site` with the production `_headers`.
  - `scripts/live_proof.py` drives headless Chrome over raw CDP (no Playwright). It answers the
    file picker with `DOM.setFileInputFiles`, reads state with `Runtime.evaluate`, and saves a
    screenshot plus `state.json`.
  - `live_check.py` checks claims against the deployed site.
- **Deploy.** GitHub Actions builds, then `wrangler pages deploy` publishes to **Cloudflare
  Pages**. Every script URL gets `?v=<commit>` added, and a `version.json` names the commit.
- **Lessons from its docs, which carry over here:**
  - Proof from disk or from a harness missed real browser faults twice. Only the served page,
    loaded fresh, counts.
  - A test that greps our source for function names proves nothing.
  - Four parallel builds froze the PC, which is where the lock comes from.
  - Caches on C: filled the disk.
  - `COEP: require-corp` broke cross-origin loads, so it uses `credentialless`.
  - Cloudflare caches `.js` files for 4 hours.

### 1.4 What KeeperFX takes from each

- **Main loop:** DevilutionX's Asyncify-with-yield approach (§3.5), plus ut-browser's
  stall/deadline reporting in the page.
- **Threads:** none, as in DevilutionX in practice. Without pthreads, no COOP/COEP headers are
  needed, and GitHub Pages cannot set them anyway.
- **The player's files:** ut-browser's folder picker, falling back to `webkitdirectory`, plus
  OpenRCT2's zip route and sentinel check. The data is small (§4), so plain IDBFS is enough; no
  WORKERFS is needed.
- **Startup:** OpenRCT2's `noInitialRun` + `callMain` and version file, so storage is mounted
  and synced before `main`.
- **Saves:** DevilutionX's IDBFS plus a `syncfs` call after each save from C, plus a
  `beforeunload` sync.
- **Build infrastructure and proof:** ut-browser's toolchain finder, build lock, patch series,
  CDP driver and free-port server. Copy the scripts in, adapted; don't import them across repos.

---

## 2. Upstream build system

- **CMake is current** (`CMakeLists.txt` plus `build/cmake/modules/*.cmake`, driven by
  `build-cmake.sh`).
  - The `Makefile` is the older MinGW-only build.
  - `docs/build_instructions.txt` is stale.
- **Sources** (`BuildTargets.cmake:3-36`):
  - `GLOB_RECURSE src/*.c src/*.cpp`, excluding `src/ftests/`.
  - Non-Windows builds also exclude `PlatformWindows.cpp` and `WindowCompositorWin.cpp`.
  - It produces two executables, `keeperfx` and `keeperfx_hvlog`. The web build needs only
    `keeperfx`.
- **Language standards:** C11 and C++20. There is no `-m32` anywhere.
- **Emscripten sets `UNIX`, so it falls into the Linux branch** of `Platforms.cmake`. That branch
  would break on:
  - `-march=x86-64 -O3 -g -Werror` (`Helpers.cmake:31-35`)
  - `-rdynamic` (`:60`)
  - `pkg_check_modules(... REQUIRED)` for ffmpeg, openal, luajit, spng, minizip and zlib
    (`Dependencies.cmake:167-172`)
  - prebuilt **lin64** archives for astronomy, centijson, enet6 and curl (`:175-183`)
  - `find_package(OpenGL REQUIRED)` plus glad, always linked
  - `miniupnpc natpmp dl`
  
  → **Do not patch the Linux branch.** Our own `native/CMakeLists.txt` (§7) builds upstream's
  sources with our own dependency list instead.
- **`src/ver_defs.h`** is generated from `ver_defs.h.in` and needs `git describe` plus
  `version.mk`. Generate it ourselves from the pin.
- **Native tools are not needed for the engine.** `png2bestpal`, `po2ngdat`, `sndbanker` and the
  rest are used only for packaging. The runtime data they produce (`fxdata/gtext_*.dat` and the
  graphics) comes from the release package (§4.3).

---

## 3. What blocks an Emscripten build

### 3.1 x86 assembly and intrinsics: essentially clean

- `bflib_cpu.c:38,47` uses `cpuid`, but it is already behind
  `#if defined(__i386__) || defined(__x86_64__)`. On wasm it falls back to defaults.
- `bflib_math.c` uses `_BitScanReverse` only under `_MSC_VER`, and `__builtin_clz` otherwise.
- There is no `xmmintrin`, `rdtsc` or `__builtin_ia32`.

### 3.2 Windows-only APIs: already isolated

- `src/kfx/platform/PlatformManager.cpp:28-32` picks `PlatformWindows` or `PlatformLinux`.
- `PlatformLinux.cpp` (122 lines) holds `main()`. It stubs Redbook CD audio and Steam, and uses
  `SDL_GetPrefPath`, `opendir` and `fnmatch(FNM_CASEFOLD)`. **We use it unchanged.**
- Every Windows header and call elsewhere is behind `_WIN32` or `__MINGW32__`.
- **The one real problem is `bflib_crash.c:29-31`.** It turns on `BF_POSIX_CRASH` for any
  non-Windows target, which pulls in `<execinfo.h>` (absent in Emscripten), `backtrace()` and
  `sigaction(SA_SIGINFO)`.
  → A one-line patch: `#if defined(__linux__)`. Emscripten does not define `__linux__`, so the web
  build takes the plain `signal()` fallback instead.

### 3.3 Threads: none needed

| Where | What | Web |
|---|---|---|
| `kfx/renderer/RenderThreadManager.cpp` | the OpenGL render thread | excluded with OpenGL |
| `net_portforward.cpp` | `std::thread` for UPnP | stubbed with networking |
| `net_matchmaking.c` | 5× `SDL_CreateThread` | stubbed with networking |
| `bflib_sndlib.cpp`, `bflib_mshandler.cpp`, `bflib_mspointer.cpp`, … | `std::mutex` only | fine without pthreads |
| `bflib_fmvids.cpp:414` | `std::this_thread::sleep_for` busy-waits on the main thread | change to `SDL_Delay` if movies return |

**Build without `-pthread`.** Once OpenGL and networking are out, no `std::thread` is ever
constructed.

### 3.4 Files and paths

- **The data root is the current directory.** `keeper_runtime_directory = "."`
  (`config_keeperfx.c:1188`). Nothing looks at argv[0] or `SDL_GetBasePath`.
  - Every group is lower case under `./`: `data`, `ldata`, `fxdata`, `sound`, `music`, `save`,
    `scrshots`, `creatrs`, `campgns`, `levels`, `multiplayer` (`config.c:1280-1395`).
  - `INSTALL_PATH` in `keeperfx.cfg` moves only `ldata`, `levels`, campaign levels and media.
  
  → The web build **`chdir`s to the game root `/keeperfx` before `main`** (via `callMain`
  arguments or `preRun`). That is the folder the game-files page already fills
  ([GAME-FILES.md](GAME-FILES.md)).
- **Case sensitivity.** `bflib_fileio.c:46-116` matches only the *last* path component
  case-insensitively, and only for `LbFileOpen`/`LbFileExists`. Many opens bypass it: `fopen` in
  6 files, `unzOpen`, `MIX_LoadAudio`, `luaL_dofile`, `avformat_open_input`.
  → **The page lower-cases every path as it copies** (this is also what the launcher does).
- **Backslashes:** no hard-coded backslash paths in `src/`.
- **Where things are written:**
  - saves → `./save/`
  - screenshots → `./scrshots/`
  - `renderer_prefs.ini` → `SDL_GetPrefPath("keeperfx","keeperfx")`, which is under `/libsdl/`
    with SDL3 on Emscripten
  - the engine also rebuilds and writes these into **`./data/`** when they are missing:
    `tables.dat`, `alpha.col`, `colours.col`, `redpal.col`, `whitepal.col`, `mapfadeg.dat`
  
  → Persist `save/`, the pref path, `keeperfx.cfg` and `data/` with IDBFS.
- **Web saves will not load in the Windows build, and the reverse.** Saves write a raw
  `#pragma pack(1) struct Game` (`game_saves.c:159`), which contains a
  `long double process_turn_time` (`game_legacy.h:389`). A `long double` is 16 bytes on wasm and
  12 bytes on i686. Web saves are consistent with one another, which is all phase 6 needs.

### 3.5 The main loop: Asyncify, not `emscripten_set_main_loop`

The call chain is `main` (`PlatformLinux.cpp:119`) → `kfxmain` (`main.cpp:2223`, wrapped in
`try{}catch(...)`) → `LbBullfrogMain` → `game_loop()` (`game_loop.c:1053`).

There are **10 distinct blocking loops**, each doing draw, present, sleep, repeat, and some are
nested:

1. the outer `game_loop()` (`game_loop.c:1059`)
2. the frontend menu loop `wait_at_frontend()` (`:919-976`), paced by `LbSleepUntil`
3. `keeper_gameplay_loop()` (`:722`), which waits in `keeper_wait_for_next_turn` →
   `LbSleepUntilExt`
4. the delta-time catch-up loop `while (process_turn_time < 1.0) gameplay_loop_draw();` (`:626`)
5. `keeper_wait_for_screen_focus()` (`:345`)
6. the splash screens, `show_rawimage_screen()` (`front_simple.c:197`)
7. the "installation file not found" wait (`front_simple.c:405`)
8. palette fades: `ProperFadePalette` / `ProperForcedFadePalette` (`vidfade.c:237,268`) and
   `LbPaletteFade` (`bflib_video.c`)
9. movie playback (`bflib_fmvids.cpp:396-470`), which runs inside the frontend loop
10. the network waits (`net_exchange_common.c`, `net_lobby.c`, `bflib_enet.cpp`), which are
    multiplayer only and stubbed

Turning these into `emscripten_set_main_loop` would mean rewriting `game_loop.c`,
`front_simple.c`, `vidfade.c`, `bflib_video.c` and `bflib_fmvids.cpp` as state machines. That
means large diffs to upstream that would conflict on every rebase. **Decision: Asyncify.**

- **Every one of these loops presents a frame.** One patch covers them all: add
  `emscripten_sleep(0)` after `PresentFrame()` in **`RendererPresentFrame()`
  (`src/kfx/renderer/RendererManager.cpp:140`)**.
- **SDL3's `SDL_Delay` already calls `emscripten_sleep` under Asyncify**, so the `LbSleep*`
  helpers (`bflib_datetm.cpp:289-369`) yield on their own. Their final stretch busy-spins on
  `LbTimerClock()` (`:302,316`); change those spins to `SDL_Delay(1)`, so they don't burn a whole
  core.
- **Exceptions:**
  - The engine throws (47 sites) and catches in `kfxmain`, so the web build needs
    `-fexceptions` (JS-based exceptions).
  - Asyncify does not work with `-fwasm-exceptions`; JSPI does, and could be a later move.
  - Asyncify through the `invoke_*` wrappers works, but costs size and speed.
- **Later optimisation:** restrict instrumentation with `-sASYNCIFY_ADD`/`ASYNCIFY_ONLY` once the
  real call stack is known (phase 7).

### 3.6 Networking: stub it behind one switch

- The code that pulls in third-party networking libraries is in 5 files: `bflib_enet.cpp`,
  `net_lan.c`, `net_holepunch.c`, `net_matchmaking.c` and `net_portforward.cpp`.
- The rest of the engine reaches them only through small APIs: `InitEnetSP`, `lan_*`,
  `matchmaking_*`, `holepunch_*`, `port_forward_*`, `GetPing` and a few `enet_*` helpers.
  - → Replace the 5 files with one **`native/stubs/net_stub.c`**, in which `InitEnetSP` fails
    and everything else is a no-op.
  - That drops **enet6, curl, miniupnpc and natpmp**.
- The rest of `net_*.c` is game logic and stays.
- `api.c` (a local TCP JSON API) compiles on Emscripten and is off unless `api_enabled`; leave it
  off.

### 3.7 Dependencies, one by one

| Dependency | Upstream | Used by | Web build |
|---|---|---|---|
| **SDL3** | 3.4.12 | 21 files | **`-sUSE_SDL=3` port (3.4.2 in emsdk 6.0.9).** If upstream uses a 3.4.3+ API, build SDL3 3.4.12 from source with `emcmake` instead. |
| **SDL3_mixer** | 3.2.4 (`MIX_*`) | `bflib_sndlib.cpp` (music) | **No port. Build from source** with `emcmake`, with only its built-in decoders (WAV, stb_vorbis for OGG, dr_mp3, dr_flac) enabled and no external codec libraries. |
| **SDL3_image** | 3.4.4 | icon load (`WindowSystemSDL.cpp:27`), PNG screenshots (`RendererSoftware.cpp:227`) | **No port.** Build it from source with its built-in stb/PNG backends, or stub the 2 calls behind a switch. Build it; it is small. |
| **OpenAL** | openal-soft | `bflib_sndlib.cpp` (all SFX) | **Emscripten's `-lopenal`.** Check that the `alext.h` constants (`AL_FORMAT_*_MSADPCM_SOFT`, `ALC_ENUMERATE_ALL_EXT`) exist there; if they don't, add a patch that falls back. |
| **LuaJIT** | kfx-deps 20250418 | 44 files (level scripts, lenses) | **Cannot target wasm. Use PUC Lua 5.1.5** compiled as C, plus a shim header for `luaL_setfuncs` (7 uses) and `luaL_newlib` (4 uses). Lua 5.4 is worse: `luaL_checkint` (9 uses) is gone. Compile Lua as C++ or keep it as C, and never yield from inside `lua_pcall` (setjmp plus Asyncify). |
| **ffmpeg** | avformat, avcodec, avutil, swresample (≥ 5.1) | `bflib_fmvids.cpp` only | **Stub:** `play_smk` returns false and the intros are skipped. Later, a minimal build with the smacker demuxer and decoders only, `--disable-asm --disable-threads`. |
| **zlib** | kfx-deps | net resync, minizip | `-sUSE_ZLIB=1` |
| **minizip** | from zlib | `custom_sprites.c`, `custom_zip.c`, `sound_manager.cpp`, `gui_soundmsgs.cpp` | Compile `unzip.c` and `ioapi.c` from zlib's `contrib/minizip`. |
| **spng** | kfx-deps | `custom_sprites.c` | Compile `spng.c` from source (needs zlib). |
| **libpng** | not used | — | — |
| **centijson** | kfx-deps prebuilt | `api.c`, `custom_*.c`, centitoml | Compile from source (small C). |
| **centitoml** | vendored `deps/centitoml` | 9 config files | Compiles as it is. |
| **dr_mp3** | vendored header | `bflib_sndlib.cpp` | Header-only, fine. |
| **astronomy** | kfx-deps | `moonphase.c` | Compile `astronomy.c` from source (one file). |
| **enet6, curl, miniupnpc, natpmp** | kfx-deps | networking only | **Stubbed** (§3.6). |
| **OpenGL + glad** | vendored glad (GL 3.3 core) | `kfx/renderer/opengl/*`, `RendererOpenGL.cpp`, `GLContextSDL.cpp` | **Excluded.** The software renderer is the default (`RendererManager.cpp:38-41`), and WebGL2 cannot run `#version 330 core` shaders. |
| **Tracy** | FetchContent | profiling | Off, as it is by default. |
| **Steam** | Windows runtime-load | — | Already stubbed by `PlatformLinux`. |

"Compile from source" dependencies are cloned at pinned tags into `vendor/`, the same way as the
engine, and compiled by our CMake. Nothing is fetched at build time without a pin.

### 3.8 Other awkward points

- **Stack.** Several functions have 10–16 KB of locals (`light_data.c:263`, `lua_api.c:2187`,
  `bflib_sndlib.cpp:1441`), and Asyncify deepens the stack. Use `-sSTACK_SIZE=4MB`; the default
  is 64 KB.
- **Memory.** `struct Game` alone is about 1.4 MB, and there are large static map arrays. Use
  `-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB`.
- **`long double`.** It appears 48 times, all in timing code. On wasm it is 128-bit soft-float,
  which is correct but slow; profile it in phase 7.
- **Packed structs** appear 304 times, which is fine: wasm tolerates unaligned access.
- **Mouse.** `SDL_WarpMouseInWindow` does nothing in the browser, and relative mode needs pointer
  lock. The game warps the cursor on level entry (`game_loop.c:1112`). This matters in phase 5.
- **Audio.** OpenAL and SDL3 each open their own AudioContext, and browsers start audio only
  after a user gesture. The page resumes both on the first click.

---

## 4. The player's original files: the page's manifest

- **Sources:**
  - `docs/files_required_from_original_dk.txt`
  - `docs/keeperfx_readme.txt:14-35`
  - the current launcher's check, `dkfans/keeperfx-launcher-qt` `src/dkfiles.cpp`
    (`DkFiles::isValidDkDir`), which only checks that files exist, not their sizes or hashes
  - cross-checked against what `src/` actually opens

### 4.1 Manifest

Paths are relative to the Dungeon Keeper root and matched case-insensitively. They are always
**written lower case**.

```
data/    required by the launcher's check; all small files
  bluepal.dat  redpall.dat  lightng.pal  dogpal.pal  vampal.pal   <- engine fails to start without these
  slab0-1.dat                                                      <- engine fails without it (640x480 GUI)
  slab0-0.dat                                                      <- 320x200 mode only
  redpal.col  whitepal.col                                         <- rebuilt by the engine if missing
  bluepall.dat  hitpall.dat                                        <- checked by the launcher, never opened
  main.pal  mapfadeg.dat                                           <- optional; copy if present
sound/   required by the launcher's check
  atmos1.sbk  atmos2.sbk  bullfrog.sbk                             <- not opened by this engine commit
music/   optional
  keeper02.ogg ... keeper07.ogg     <- in the DK root on GOG/Steam; destination music/
ldata/   optional (movies; stubbed at first)
  intromix.smk  bullfrog.smk  ea.smk  drag.smk                     <- presence in the originals unverified
```

The page (`site/js/manifest.js`) takes exactly this list: the `data/` and `sound/` files as
required, the rest as optional extras. It looks for the movies in any folder, since where each
edition keeps them is unverified.

- The engine's hard requirements are in `src/vidmode_data.cpp:103-108` and `vidmode.c:129`.
- The page follows the launcher's rule: **every `data/` and `sound/` file listed as "required" by
  the launcher must be present.** A folder where only the six engine-required files are present
  gets a clear warning, but is accepted.
- **Music:** the engine sorts every file in `music/`, uses only the best format available (flac,
  then wav, then ogg, then mp3), and plays CD track N from file N−2 (`bflib_sndlib.cpp:776-870`).

### 4.2 Where to find the folder, for the page's guide

- **GOG:** `C:\GOG Games\Dungeon Keeper Gold`, or
  `C:\Program Files (x86)\GOG Galaxy\Games\Dungeon Keeper Gold`. `DATA\` and `SOUND\` are loose
  files in the root; the CD image (`game.ins`/`game.gog`) is only for CD audio.
  - The old doc's note that GOG users "must extract the CD image" refers to the 2011 release.
- **Steam** (app 1996630): `<Steam library>\steamapps\common\Dungeon Keeper`. The music `.ogg`
  files are reportedly in the root (unverified).
- **EA / Origin:** `C:\Program Files (x86)\Origin Games\Dungeon Keeper\DATA`. The real root is
  that **inner** `DATA` folder. The page also searches one level down, so picking the outer folder
  works too.
- **CD:** the `KEEPER` folder on the disc.
- The page can confirm a real DK folder by `keeper.exe`, `keeper95.exe` or `deeper.exe`, as the
  launcher does.

### 4.3 What KeeperFX provides itself

All the rest comes from KeeperFX: configs (`keeperfx.cfg`, `fxdata/`, `creatrs/`), campaigns,
levels, `lang` text built into `fxdata/gtext_*.dat`, the graphics (`FXGraphics`: `data/tmap*`,
`creature.jty`, GUI and fonts, `ldata/front*`), and the sounds (`FXsounds`: `sound/sound.dat`,
`speech_*.dat`).

- **Most of it is not in the git repo.** Map binaries, the graphics and `gtext` are produced by
  the packaging tools, and `campgns/keeporig` in git holds only `.txt` files.
- The practical source is the release asset **`keeperfx_1_4_0_complete.7z`** (374,587,275 bytes,
  GitHub release v1.4.0), overlaid with the files from our pinned commit's config.
  - The pin is newer than 1.4.0. **Phase 3 must check that the 1.4.0 data loads with this engine**,
    or else pin the engine to the release tag, or build the data with the packaging makefiles.

### 4.4 Open question: can the page ship KeeperFX's data?

- `keeperfx_readme.txt:143` says "Some data files are copyrighted by Bullfrog Productions",
  although the FXGraphics and FXsounds repositories are labelled GPL-3.0.
- **Until that is settled, treat the KeeperFX data pack like the player's files.** The page fetches
  it at first run from its own GitHub release URL and never re-hosts it, or the player supplies it.
  - This matches ruling 4's intent and costs nothing, since the page already has an import
    step.
  - Ask Tim before shipping it from our own origin.

---

## 5. Persistence

- **Storage.** The data is small: the originals are under 1 MB, the KeeperFX pack about 400 MB
  unpacked. It all lives in **IDBFS**:
  - `/keeperfx`, the game root: the originals plus the KeeperFX pack, with `data/` writable
    - `/keeperfx/player` holds the originals; the page links each one into `data/`, `sound/`,
      `music/` or `ldata/` ([GAME-FILES.md](GAME-FILES.md))
  - `/keeperfx/save`
  - `/libsdl`, SDL's pref path
- **Before `main`.** `FS.syncfs(true)` runs under `addRunDependency`, and the module is created
  with `noInitialRun`, then `callMain` (OpenRCT2).
- **Keeping it saved.**
  - After each save, C calls `EM_ASM(Module.kfxPersist())`. That is one tiny patch in
    `game_saves.c`, behind `__EMSCRIPTEN__`.
  - A `beforeunload` sync and a 30-second interval cover everything else (DevilutionX).
- **If 400 MB in IDBFS proves slow**, switch the read-only pack to OPFS plus WORKERFS the way
  ut-browser does. That needs the engine in a worker; not first.
- **"Forget my files"** deletes the IDB database and the OPFS directory.
- **Versioning.** A `version.json` beside the files triggers re-import when the manifest changes
  (OpenRCT2 `updateAssets`).

---

## 6. Serving and deploy

- **Page and server.**
  - A single `site/index.html` with the Emscripten output.
  - No pthreads, so **no COOP/COEP is needed**.
  - A secure context is still needed for `showDirectoryPicker`: `localhost` works locally.
- **Local server.** Adapt ut-browser's `serve.py`:
  - bind `0.0.0.0` on a port from the run's block, never a fixed one
  - serve `.wasm` as `application/wasm`
  - `Cache-Control: no-cache`
- **Proof.** Adapt ut-browser's CDP driver (`live_proof.py`): headless Chrome, the file picker
  answered with `DOM.setFileInputFiles`, and a screenshot.
- **Deploy (phase 8).**
  - GitHub Pages as planned, via `actions/upload-pages-artifact` + `actions/deploy-pages`.
  - Pages cannot set headers, so it only works because we stay single-threaded.
  - Add `?v=<commit>` to asset URLs, plus a `version.json`.

---

## 7. Recipe for job 2: the first wasm compile

**Goal:** `build/web/keeperfx.js` + `keeperfx.wasm` produced from the pinned engine, with
networking, movies and OpenGL stubbed. The proof is the build log and the `.wasm`. No page yet.

1. **Vendor.** Write `scripts/vendor.py`. It clones, or fetches and checks out, at pinned
   commits:
   - `dkfans/keeperfx` @ `211438fa1c7fad37f867e26c61409c344faf4a0c` → `vendor/keeperfx`
   - `libsdl-org/SDL_mixer` @ `release-3.2.4` → `vendor/SDL_mixer`
   - `libsdl-org/SDL_image` @ `release-3.4.4` → `vendor/SDL_image`
   - Lua 5.1.5 source tarball → `vendor/lua-5.1.5` (check its sha256)
   - `randy408/libspng` (v0.7.4), `mity/centijson`, `cosinekitty/astronomy` (the tag or commit
     that kfx-deps "astronomy_fix" uses; check `dkfans/kfx-deps`), and zlib's `contrib/minizip`
     from the zlib tag that the Emscripten port uses
   
   Then it applies `vendor/patches/*.patch` in order. Add a `.gitattributes` rule so the patches
   stay LF.
2. **Upstream patches** (`vendor/patches/`). Each one is small, `__EMSCRIPTEN__`-guarded, and gets
   one line in this file:
   1. `bflib_crash.c`: `BF_POSIX_CRASH` only `#if defined(__linux__)`.
   2. `RendererManager.cpp`: `emscripten_sleep(0)` after `PresentFrame()`.
   3. `bflib_datetm.cpp`: make the busy-spin tails in `LbSleepFor`/`LbSleepUntil` call
      `SDL_Delay(1)`.
   4. `bflib_fmvids.cpp`: `play_smk` returns false under `KFX_NO_MOVIES` (the whole ffmpeg part
      is compiled out).
   5. `RendererManager.cpp` / `WindowSystemSDL.cpp`: compile out OpenGL references under
      `KFX_NO_OPENGL`.
   
   Anything else the compiler demands goes here too, and gets listed in this file.
3. **Our code.**
   - `native/stubs/net_stub.c`: the no-op networking API (§3.6).
   - `native/compat/lua_compat.h`: `luaL_setfuncs`/`luaL_newlib` for Lua 5.1, force-included
     into engine sources only.
   - `native/ver_defs.h`: generated by the build script from the pin.
4. **Build.** Write `native/CMakeLists.txt`, our own project and not upstream's:
   - **Engine sources:**
     - the same glob as `BuildTargets.cmake`
     - minus `PlatformWindows.cpp`, `WindowCompositorWin.cpp`, `src/kfx/renderer/opengl/*`,
       `RendererOpenGL.cpp`, `GLContextSDL.cpp`, `RenderThreadManager.cpp` (if only used by GL)
     - minus the 5 networking files and `src/ftests/`
   - **Defines:** `KFX_NO_MOVIES KFX_NO_OPENGL BFDEBUG_LEVEL=0 DEBUG=0`
   - **Includes:** `deps/centitoml`, `deps/`, and the vendored dependencies
   - **Libraries:** static libraries from the vendored dependencies (Lua, spng, centijson,
     minizip, astronomy); SDL3_mixer and SDL3_image through their own CMake with
     `-DBUILD_SHARED_LIBS=OFF`, the vendored codecs only, and SDL3 from the port
   - **Compile flags:** `-sUSE_SDL=3 -sUSE_ZLIB=1 -fexceptions -O1`
   - **Link flags:**
     `-sUSE_SDL=3 -sUSE_ZLIB=1 -lopenal -fexceptions -sASYNCIFY -sSTACK_SIZE=4MB
     -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sFORCE_FILESYSTEM=1 -lidbfs.js
     -sEXIT_RUNTIME=0 -sMODULARIZE=1 -sEXPORT_NAME=KeeperFX
     -sEXPORTED_RUNTIME_METHODS=FS,callMain -sINVOKE_RUN=0`
5. **Build script.** Write `scripts/build_wasm.py`, adapted from ut-browser's `toolchain.py` and
   `buildlock.py`. It:
   - finds `G:/emsdk` and runs `em++.py`/`emcmake` with the SDK's own python
   - **takes `G:/Claude Stuff/.heavy-build.lock`** (README rule), holding the job and time;
     refuses if the lock is under two hours old; removes it in `finally`
   - runs `cmake --build ... -j4`, at below-normal priority
   - writes `build/wasm-build.log`
6. **Fixing errors.** Expect compile errors in waves:
   - SDL3 port version gaps (3.4.2 vs 3.4.12)
   - OpenAL `alext.h` constants
   - Lua 5.1 API gaps
   - C++20 on the newer clang
   
   Fix each with a patch or a shim, never by rewriting game logic. Keep to three tries per
   distinct failure, then write down what is known here and hand it back.
7. **Tests.** Keep the quick suite quick. Add a `@heavy`-style test, outside the default
   discovery, that asserts `build/web/keeperfx.wasm` exists and has the `callMain` export. The
   default suite gains only cheap checks:
   - every patch in `vendor/patches` applies to the pinned commit (`git apply --check`)
   - the pin in `scripts/vendor.py` matches this file
8. **Record.** Add each stub and patch to the table below as it lands.

### Stubs and patches in force

| Switch / patch | What it removes | Why | Brought back in |
|---|---|---|---|
| `KFX_NO_NET` (`net_stub.c`) | enet6, curl, UPnP, NAT-PMP, LAN, matchmaking | no UDP in browsers | later phase (WebRTC/WebSocket) |
| `KFX_NO_MOVIES` | ffmpeg, the intro/outro movies | size; no port | later phase (smacker-only ffmpeg) |
| `KFX_NO_OPENGL` | the GL 3.3 renderer and its thread | GL 3.3 core ≠ WebGL2; needs threads | not planned; software renderer |
| LuaJIT → Lua 5.1.5 + compat | LuaJIT | JIT cannot target wasm | permanent |
| `bflib_crash.c` POSIX guard | backtrace/sigaction crash handler | no execinfo in Emscripten | permanent |

---

## 8. What in PLAN.md turned out wrong

1. **"Its dependencies are SDL2, SDL2_mixer, SDL2_net, enet, ffmpeg, lua, zlib, libpng and spng"**
   is wrong on several counts:
   - It is SDL3, SDL3_mixer and SDL3_image.
   - There is no SDL_net.
   - The Lua is LuaJIT.
   - libpng is not used.
   - OpenAL, minizip, centijson, astronomy, curl, miniupnpc and natpmp are missing from the list.
2. **"Emscripten ports cover SDL2, SDL2_mixer, zlib, libpng, and lua compiles as plain C."**
   - The relevant ports are `sdl3` and `zlib`; SDL3_mixer and SDL3_image must be built.
   - LuaJIT does not compile to wasm, so we swap in PUC Lua 5.1.5.
3. **"Networking (SDL2_net, enet) is stubbed first."** The intent stands, but the things to stub
   are enet6, curl, miniupnpc and natpmp, in 5 files.
4. **"The Windows build is 32-bit, so … save files should hold."** Struct layout holds, but saves
   are **not** compatible with native saves: `long double` inside `struct Game` is a different
   size on wasm.
5. **The Asyncify or `emscripten_set_main_loop` question is decided: Asyncify** (§3.5).
6. **"DevilutionX … is the closest model."** It is the closest for handling data and saves, but
   its web build is unfinished and has no demo. OpenRCT2 is the better model for the page's
   import and startup sequence.
7. **"ut-browser … GitHub Pages deploys."** ut-browser deploys to Cloudflare Pages. Phase 8 can
   still target GitHub Pages, because the port stays single-threaded.
8. **"The page can ship KeeperFX's own GPL assets."** Not yet settled. The KeeperFX data is not
   in git, and its readme says some data files are Bullfrog's (§4.4). Fetch it from KeeperFX's own
   release at first run until Tim decides.
9. **"ask for the player's Dungeon Keeper folder"** still stands, but it is only about 14 small
   files (§4.1). The page should also accept just those files, or a zip of them.
