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
| (missing) | **An optional OpenGL 3.3 renderer that runs on its own thread.** The software renderer is the code's default, but the shipped `keeperfx.cfg` picks OpenGL, so the web config sets `RENDERER=SOFTWARE` (§9). |
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
  after a user gesture. The page resumes both on the first click. Desktop OpenAL Soft limits its
  output; Emscripten's OpenAL wires every source through one gain straight to the speakers, so a
  big fight clipped (peak 1.42). `site/js/limiter.js` routes whatever connects to a context's
  destination through a hard-knee compressor, trimmed so sound under -3 dB passes unchanged;
  `scripts/prove_limiter.mjs` plays level 3's fight and meters both contexts (effects 0.82 with it).

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
| `KFX_NO_NET`: `native/stubs/net_stub.c` replaces `bflib_enet.cpp`, `net_lan.c`, `net_holepunch.c`, `net_matchmaking.c`, `net_portforward.cpp` in the source list (no upstream edit) | enet6, curl, UPnP, NAT-PMP, LAN, matchmaking; `InitEnetSP` returns NULL so the engine's own code reports no network | no UDP in browsers | later phase (WebRTC/WebSocket) |
| `KFX_NO_MOVIES`: patch `0002-fmvids-kfx-no-movies-switch.patch` | ffmpeg includes and the movie player in `bflib_fmvids.cpp`; `play_smk` logs and returns false. The FLIC recorder in the same file is kept | size; no port | later phase (smacker-only ffmpeg) |
| LuaJIT → Lua 5.1.5 + `native/compat/lua_compat.h` (force-included, no upstream edit) | LuaJIT; the header adds `LUA_OK`, `lua_rawlen`, `luaL_setfuncs`, `luaL_newlib` | JIT cannot target wasm | permanent |
| `bflib_crash.c` POSIX guard: patch `0001-crash-no-posix-handler-on-emscripten.patch` | backtrace/sigaction crash handler, off under `__EMSCRIPTEN__`; the two Win32 `SIGBREAK` branches become `#elif defined(SIGBREAK)` | no execinfo or `SIGBREAK` in Emscripten | permanent |
| OpenAL Soft MSADPCM tags: `native/compat/al_compat.h` (force-included, no upstream edit) | nothing: defines `AL_FORMAT_{MONO,STEREO}_MSADPCM_SOFT` (0x1302/0x1303), which `bflib_sndlib.cpp` uses only as WAV-reader tags, never passed to OpenAL | Emscripten's OpenAL lacks the extension | permanent |
| OpenGL: **no switch needed so far** | nothing: the GL renderer and glad are compiled as they are and never selected, because the web `keeperfx.cfg` says `RENDERER=SOFTWARE` (§9) | fewer upstream edits than `KFX_NO_OPENGL` | — |
| Web `keeperfx.cfg` (`scripts/gamedata.py`, no upstream edit) | `RENDERER=SOFTWARE`, `RELATIVE_MOUSE_MODE=OFF`, 640x480 windowed `FRONTEND_RES`/`INGAME_RES` | the pinned config asks for OpenGL (a render thread) and relative mouse (pointer lock); see §9 | — |

### How job 2 built it

- `scripts/vendor.py` fetches every source at a pinned commit (or sha256 for the Lua tarball and
  astronomy's two files) into `vendor/`, resets it, and applies `patches/keeperfx/*.patch`.
  Patches live outside `vendor/`, which is gitignored.
- `scripts/build_wasm.py` pins **Emscripten 6.0.9** (`$EMSDK`, `./emsdk` or `G:/emsdk` if it is
  that version, otherwise it installs `./emsdk`). There is no CMake on this machine, so it drives
  `emcc.py`/`em++.py` directly, one process per source, four at once, below-normal priority,
  with its own `EM_CACHE` (SDL3 and the system libraries are built there once).
  - Since job 195 that `EM_CACHE`, every compiled object and the last few linked engines live in
    one machine-wide cache outside every checkout (`scripts/buildcache.py`, adapted from
    ut-browser's `buildlock.py`; the README says where). An object is keyed by the SDK version,
    its flags, its source and every header its depfile names, with the checkout's path taken out;
    an engine by all its objects and the link flags. A fresh checkout with nothing changed is
    restored whole without the lock; a changed file recompiles alone and relinks.
  - `EMSDK_PYTHON` must point at the SDK's python: port builds spawn `emcc.exe`, which otherwise
    runs the Windows Store `python` stub and fails with 9009.
  - SDL3_mixer is compiled with only its built-in decoders (WAV, AIFF, VOC, AU, stb_vorbis,
    dr_flac, dr_mp3); SDL3_image with PNG (stb) and BMP. The engine compiles its own dr_mp3 in
    `bflib_sndlib.cpp` too, and the two copies clashed at link, so job 2 left MP3 out of the
    mixer. Since job 200 that one file is compiled with `-DDRMP3_API=static
    -DDRMP3_PRIVATE=static` (`FILE_FLAGS` in `build_wasm.py`): the engine's copy stays private
    to it and the mixer's is the only one the linker sees. No patch to either.
  - `deps/centitoml/toml_conv.c` is not compiled on its own: `toml_api.c` `#include`s it, as
    upstream's Makefile has it.
  - `ver_defs.h` and the window icon C array (both CMake-generated upstream) are generated into
    `build/generated/`.
- Output: `site/keeperfx.js` + `site/keeperfx.wasm` (gitignored), log in `build/wasm-build.log`.
- `site/engine.html` loads them, mounts the player's kept files (`storage.js`), `chdir`s to
  `/keeperfx` and calls `main()`. KeeperFX logs only to a file, `/keeperfx/keeperfx.log`, flushed
  per line; the page mirrors each new line to the console and the page.
- Proof (`scripts/prove_engine.mjs`, headless Chrome against the served page): the engine prints
  its banner `Dungeon Keeper FX ver 1.4.0.0 web (standard release) git:211438f`, then stops at
  `resolve_startup_config: Configuration load error` for want of `keeperfx.cfg` and game files.
  Screenshot, page console and build log in `docs/proof/engine-*`.
- Known gap: when `main()` returns without `exit()`, the page still says "The engine is running."

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

---

## 9. Phase 4: booting to the main menu

The real engine now starts in `site/engine.html`, reads the player's own Dungeon Keeper files and
KeeperFX's own data, and draws its main menu; a click on **Options** opens the Options menu.
Proved against the served page in headless Chrome with a real Steam copy of Dungeon Keeper,
read from where it is installed (`scripts/prove_menu.mjs`; screenshots `docs/proof/menu-*.png`,
page console `docs/proof/menu-console.txt`).

**No engine source was changed and no patch was added.** Every fault was in how the page fed the
engine or in its configuration:

| What stopped it | Where | Fix |
|---|---|---|
| No KeeperFX data: the engine stopped at `resolve_startup_config` (job 2's proof) | the page | `scripts/gamedata.py` lays out KeeperFX's own data from the unpacked `keeperfx_1_4_0_complete.7z`, with the pinned engine's `config/` and `campgns/` over it, in a folder **outside the repo**; `scripts/serve.py --kfx-data <folder>` serves it at `/kfxdata/`; `site/js/kfxdata.js` loads it into `/keeperfx` (MEMFS) before `main()`. Only the original campaign, English text and speech, and no movies: 158 MB, 2,155 files. |
| `Exception raised!` in `kfxmain` right after the first screen setup | config | The pinned `config/keeperfx.cfg` says `RENDERER=OPENGL` (§3.7 said software was the default: it is the *code's* default, not the shipped config's). `RendererOpenGL::Init` starts a `std::thread`, which throws `system_error` without pthreads. The web config sets `RENDERER=SOFTWARE`. Found by pausing on the throw in Chrome's debugger and reading the stack through the new symbol map. |
| The game's cursor never moved, so clicks landed nowhere | config | The pinned config says `RELATIVE_MOUSE_MODE=ON`. The engine grabs the mouse at startup, and in relative mode SDL3 asks the browser for pointer lock, which the page never gets, so every motion event is dropped. With it `OFF` the engine uses grab-and-warp, and SDL3's Emscripten backend reports canvas-relative positions, so the game's cursor follows the pointer. |
| The page said nothing when a data file failed to load | the page | `engine.js` reports it; `kfxdata.js` encodes each path segment (the release has a folder called `new folder`) and `serve.py` decodes it. |

Also new:

- `build_wasm.py` links with `--emit-symbol-map`: `site/keeperfx.js.symbols` (gitignored) maps
  wasm function indices to names, so a stack from the browser can be read. The wasm is unchanged.
- The engine presents through SDL's `opengles2` renderer (WebGL). The page cannot read the
  canvas pixels back, so the proof screenshots through the browser and waits for the engine's own
  log lines (`Frontend state change ... into 1 (FeSt_MAIN_MENU)`, `into 27 (FeSt_FEOPTIONS)`).

To run it:

```
py -3.10 scripts/vendor.py && py -3.10 scripts/build_wasm.py   # heavy: takes the lock, -j4
"C:/Program Files/7-Zip/7z.exe" x keeperfx_1_4_0_complete.7z -o<somewhere outside the repo>/kfx140
py -3.10 scripts/gamedata.py --release <...>/kfx140 --out <...>/kfxdata
py -3.10 scripts/build_reader.py
py -3.10 scripts/serve.py --port <port> --kfx-data <...>/kfxdata
node scripts/prove_menu.mjs --url http://localhost:<port>/ --dk "<your Dungeon Keeper folder>" \
     --debug-port <another port> --work <scratch> --shots docs/proof
```

Open ends, for the phases they belong to:

- **Where KeeperFX's data comes from when published** is still §4.4's open question for Tim. Until
  then it is served only by the local server, from a folder outside the repo.
- It loads all 158 MB into memory on every visit (about 40 s from the local Python server). Keeping
  it in IDBFS, or fetching lazily, is phase 6/7 work.
- `WindowSystemSDL::IsCursorInWindow` compares SDL's "global" mouse position, which on Emscripten
  is the page's `clientX/clientY`, with a window it believes is at 0,0. It only matters when the
  mouse is *not* grabbed (a paused game with `UNLOCK_CURSOR_WHEN_GAME_PAUSED=ON`); expect a
  platform-layer patch in phase 5.
- The engine rebuilds `data/colours.col`, `tables.dat` and `alpha.col` on every start, because
  `data/` is not persisted yet (phase 6).
- `fxdata/font12.fxfont`/`font16.fxfont` (Unifont, for Asian languages) are not in the 1.4.0 pack;
  English does not use them.
- Left idle on the main menu the engine plays its attract demo and credits, as the original does.

---

## 10. Phase 5: playing the first level (job 193, in progress)

From the main menu, **Start New Game** opens the land view, a click on Eversmile starts level 1,
and the level loads and draws: the dungeon heart, the panel, the mentor's text, and the original
music (`Playing track 3`). The keyboard scrolls (W/A/S/D) and rotates (Delete/Page Down) the view,
and the game's cursor follows the pointer. Screenshots `docs/proof/level-*.png`.

| What stopped it | Where | Fix |
|---|---|---|
| `module 'classes.Pos3d' not found`: every level's global Lua script failed to load | the data layout | `scripts/gamedata.py` lower-cased every path, but Lua's `require` names modules in mixed case and the web filesystem is case-sensitive. Files under `fxdata/lua/` now keep their case (`dest_path`). |
| In a level the game cursor ran off to the canvas edge and the view scrolled off the map | engine input, patch `0003-inputctrl-follow-pointer-on-emscripten.patch` | In game the engine grabs the mouse and moves its cursor by deltas, recentring the OS pointer whenever it nears the window edge. A browser cannot warp the pointer, so every recentre turned the next motion into a bogus jump. Under `__EMSCRIPTEN__` the motion handler sets the game cursor from the pointer's canvas position instead. |
| Possessing a creature never locked the mouse, so the pointer ran off the game and turning stopped at the screen edge (job 230) | engine input, patch `0004-inputctrl-pointer-lock-in-possession-on-emscripten.patch` | Possession turns by how far the cursor moved from the centre each frame, which needs raw movement, and a browser gives that only under pointer lock (SDL's relative mode). Under `__EMSCRIPTEN__` the engine switches to relative mode while the local player possesses a creature, so SDL asks for pointer lock (the possess click's user activation covers it; a later click takes it back if the player pressed Esc), and the motion handler moves the game cursor by the locked movement. Leaving the creature (or pausing, when `UNLOCK_CURSOR_WHEN_GAME_PAUSED` is on) lets the lock go and the cursor follows the pointer again. `scripts/prove_possession.mjs` possesses a creature in a fight and moves the mouse 900 px past the page's edge: on the live engine the view stops turning at the edge and nothing is locked; with the patch the canvas holds the lock, the view keeps turning, and the lock goes on leaving (`docs/proof/possession-pointer-lock.png`). Headless Chrome grants the lock only with `Emulation.setFocusEmulationEnabled` and `Page.bringToFront`. |
| One of 2,155 data fetches never completed once, so the page sat at "158 of 158 MB" | local server, then the live site | It recurred on the live site. `kfxdata.js` now abandons any download that goes 20 s without a byte (waiting for the headers included) and tries it again, up to 4 times with a doubling pause; server errors (5xx, 429) are retried too, a 404 is not. |

Job 201 played on, in the page as served, with the player's GOG copy, by mouse and keyboard only
(no engine change was needed):

- **Digging**: with the hand, a left-drag over earth tags it (`level-dig-tagged.png`); the imps dig
  it out within seconds (`level-dig-dug.png`).
- **Rooms**: the Treasure Room from the room panel, clicked tile by tile over claimed floor; at
  nine tiles the mentor says "Expertly done" and asks for gold (`level-treasure-room.png`). The
  gold vein east, tagged, mines 9,000 gold; the Lair follows (`level-lair.png`).
- **The hand**: a left-click on the Creature Panel's idle-imp count picks an imp up, it dangles
  from the hand, and a right-click on floor drops it (`level-hand-imp.png`,
  `level-hand-dropped.png`). Over a wall the hand turns back to a pointer and will not drop.
- **The portal**: a tunnel tagged from the heart north to the portal claims it; a fly comes
  through (picked up in the hand, `level-hand-fly.png`), then a beetle, announced by the mentor
  and sleeping in the Lair (`level-portal-beetle.png`).
- **Fast forward** (Ctrl+=, the engine's own frame-skip key) works in the page, "Fast Forward x2"
  and on, which is how the tutorial's timers were got through.

Things a proof driver must know: the camera is made repeatable by opening the map (top-left book)
and clicking the heart, which faces it north; synthetic DOM key events stick SDL's modifier
state, so keys go through CDP's `Input.dispatchKeyEvent` with a real `code` (`ControlLeft`,
`Equal`); and room placement wants one click per tile, not a drag.

- **Heroes and the fight**: a Hatchery follows, the script sends a thief party and a tunneller
  ("Intruders approach", `level-intruders.png`), then the Lord of the Land (`level-lord-arrives.png`);
  the player's creatures kill them all and the level is won: "Success! The land is yours"
  (`level-won.png`). At fast forward x8 the fights were over between screenshots, so the combat
  itself is proved by its outcome (the heroes dead, the win) rather than a picture mid-blow; a
  picture of a blow wants a run at normal speed with the camera on the heart.

Also open:

- ~~The mentor's spoken briefings are silent~~ (`Cannot load "./campgns/keeporig_eng/good01.mp3"`):
  fixed by job 200, SDL3_mixer now decodes MP3 (§7). The briefings are MP3 and play on the land
  view while the pointer rests on a land, through SDL_mixer's speech track.
  `scripts/prove_speech.mjs` proves it in the page as served: it takes the music away, rests the
  pointer on Eversmile, and samples SDL's own audio context. The old build logs `Cannot load`
  and its mixer stays at 0.000 for all 8 seconds; the new one plays good01.mp3 at peaks up to
  about 0.49 (`docs/proof/speech-levels.txt`, `speech-landview.png`).

---

## 11. Phase 6: saves and settings survive a reload (job 202)

On <https://dungeonkeeper.tfrey7.com/>, from the first level: the sound effects slider in the
game's own Sound Options turned down (127 → 17), a save made from the game's own Options → Save,
the page reloaded, and the save is listed in the main menu's **Load Game** and loads back to the
same dungeon, with the volume still 17. Screenshots `docs/proof/saves-saved.png` (as saved),
`saves-loadmenu.png` (the load menu after the reload), `saves-loaded.png` (loaded back); the page
console is `saves-console.txt`. `saves-forget-ask.png` is the new "forget my files" question.

**No engine source was changed, no patch was added and the engine was not rebuilt.** The
engine's own save and load code worked in the browser from the start: saving wrote
`save/fx1g0000.sav` (about 53 MB) and `save/settings.toml`, and the load menu read them. The
fault was the filesystem: `save/` was plain MEMFS, so a reload lost it.

| What stopped it | Where | Fix |
|---|---|---|
| A reload lost every save and every setting | the page's filesystem | The engine writes both into its own `FGrp_Save` folder, `./save/` (`config.c:1312`; `game_saves.c` for `fx1g%04d.sav` and the continue file, `config_settings.c:401,529` for `settings.toml`; high scores go there too). `site/js/storage.js` `mountSaves` mounts an IDBFS at `/keeperfx/save` before `main()`, reads it back with `FS.syncfs(true)`, and mounts it with Emscripten's **`autoPersist`**: every file the engine closes after writing is copied to IndexedDB in the same frame, so a save is kept the moment the game says it saved. `engine.js` also syncs on `visibilitychange` (hidden) and `pagehide`. This replaces §5's plan of an `EM_ASM` call patched into `game_saves.c`: `autoPersist` catches the saves, the settings and anything else the engine writes there, with no engine change. |
| "Forget my files" forgot only the player's files | the files page | When saves or settings are kept, it now asks: **Forget files, keep my saves** or **Forget files and saves**. The files page does not mount the saves (they are large): `countSaves` and `forgetSaves` read and delete IDBFS's own IndexedDB database for that mount, which is named after the mount point, `/keeperfx/save`. If the game's tab still holds it open, the delete waits and finishes when that tab closes, and the page says so. |

Nothing is uploaded: the saves go from the engine's filesystem to this browser's IndexedDB and
no further (`tests/test_site.py` still refuses any upload call in the page's scripts).

How it was proved: `scripts/prove_saves.mjs` drives it in headless Chrome. Before this landed,
`--page-from site` answered the page's own files from the checkout while the engine and
KeeperFX's data came from the live site; after landing, run it without that flag.

```
node scripts/prove_saves.mjs --url https://dungeonkeeper.tfrey7.com/ --dk "<your Dungeon Keeper folder>" \
     --debug-port <port> --work <scratch> --shots docs/proof [--page-from site]
```

Open ends:

- **A save is about 53 MB**, most of it the raw `struct Game`. Eight saves are 400 MB of IndexedDB,
  within any browser's quota for a site the player uses, but each save takes a moment to copy.
- `data/` is still not kept, so the engine still rebuilds `colours.col`, `tables.dat` and
  `alpha.col` on every start (§9).
- The live site's data load stuck once at "158 of 158 MB" and was fine on a reload, the same fault
  §10 saw on the local server: `kfxdata.js` wants a timeout and retry per file.

## 12. Quitting from the main menu (job 214)

Main menu → Quit left the canvas black for good while the page still said "The engine is
running." and offered no way back. The engine itself quit properly: `LbBullfrogMain` shut the
renderer down and returned from `main`. The page never heard, because the engine was linked
with `-sEXIT_RUNTIME=0`: under that setting Emscripten never calls `onExit`, and under Asyncify
`main`'s late return (after its first yield) is dropped altogether.

| What stopped it | Where | Fix |
|---|---|---|
| The page never learned the engine had ended | `scripts/build_wasm.py` `LINK` | `-sEXIT_RUNTIME=1`. Asyncify then holds the runtime alive across every sleep and lets it end when `main` returns, which calls the page's `onExit`. Play, save, reload and load still pass `prove_saves.mjs` with it. |
| Nothing said the game had closed, and nothing restarted it | `site/engine.html`, `site/js/engine.js`, `site/js/view.js` | `onExit` keeps the saves, says "The game has closed." in the bar and over the canvas, leaves full screen, and offers **Play again** (the page loads afresh; the engine cannot run `main` twice in one page, and the player's files are kept, so it goes straight back to the main menu) and **Your game files**. Any exit code but 0 says the engine stopped and opens its log. |

Proved with `scripts/prove_quit.mjs` against a local server (`quit-closed.png`, `quit-again.png`):

```
node scripts/prove_quit.mjs --url http://localhost:<port>/ --dk "<your Dungeon Keeper folder>" \
     --debug-port <port> --work <scratch> --shots docs/proof
```

In KeeperFX 1.4.0 the main menu's Quit ends the game at once, with no tick to confirm; the proof
clicks a tick only if the engine asks.


## 12. Phase 7: speed (job 210)

**The goal was already met before this job changed anything.** On
<https://dungeonkeeper.tfrey7.com/> the first level runs above the screen's 60 frames a second in
every scene tried, and the game logic keeps its proper 20 turns a second; the battle test (job
208) saw the same, 90–108 fps with no drops. The job measured where the time goes, landed the one
change that clearly paid, and left the tools for the next person.

**How it is measured.** `engine.html?fps` shows the engine's presents and the browser's frames a
second above the game (`site/js/fps.js`; it counts SDL's WebGL `clear()` once per present, so the
engine is untouched), and `window.kfxFps()` gives the counters to a driver.
`engine.html?args=-alex` passes the engine desktop command-line options (`-alex` is KeeperFX's
cheat switch). `scripts/measure_fps.mjs` starts level 1 through the menus as a player does, then
measures three scenes for ten seconds each, with a screenshot and a CPU profile of each:

- **quiet**: the opening dungeon, 20 s in, imps at work
- **fight**: 25 of the keeper's creatures and 25 heroes, level 4, made with the engine's own
  `!create.creature` command, fighting in the middle of the view
- **possession**: `!power.give POWER_POSSESS`, then Possess Creature on a creature in that fight

```
node scripts/measure_fps.mjs --url https://dungeonkeeper.tfrey7.com/ --dk "<your Dungeon Keeper folder>" \
     --debug-port <port> --work <scratch> --shots docs/proof --label after [--page-from site] [--engine-from <dir>]
```

`--engine-from` serves a local `keeperfx.js`/`.wasm` over the live page, so an engine build is
measured on the live site before it lands. Frames a second alone are a poor measure here: the
engine is not CPU-bound, and the fight is random (creature kinds, who dies first), so the script's
profiles also give **busy time per frame**, which is what the table uses.

**Results** (`docs/proof/fps-results.txt`, three runs each, headless Chrome on Tim's PC; screenshots
`docs/proof/fps-before-*.png` and `fps-after-*.png`):

| Scene | Before (-O1, live) | After (-O2) |
|---|---|---|
| quiet | 127–132 fps, 3.2 ms a frame | 130–133 fps, 3.0 ms a frame |
| fight | 75–92 fps, 7.4 ms a frame | 94–107 fps, **5.3 ms** a frame |
| possession | 80–123 fps, 5.3 ms a frame | 101–122 fps, 4.4 ms a frame |
| `keeperfx.wasm` | 13.5 MB | **7.0 MB** |

**Where the time goes** (the fight, -O2, self time): idle 47%; the software renderer's triangle
rasteriser `trig` 15% and `draw_gpoly` 8%; `software_execute_world_from_ir` 3.5%; the palette blit
`Blit1to4` 3.4%; sprite drawing about 5%; the WebGL upload `texSubImage2D` 1.4%. Sound does not
show. The quiet scene is paced, not busy: about 3 ms of work per 7.6 ms frame.

| Change | Why |
|---|---|
| **`-O2` for every object and the link** (`scripts/build_wasm.py`, was `-O1`) | About a quarter less work per frame in the fight, and the engine's download halves (binaryen's `-O2` also optimises the Asyncify-instrumented code). KeeperFX's own desktop release is `RelWithDebInfo`, i.e. `-O2`, so the web build now matches it. `tests/test_build.py` `SpeedTest` holds it there. |

Tried and not taken:

- **`-O3 -msimd128`**: no better than `-O2` in any scene (fight 5.4 vs 4.9 ms a frame in paired
  runs) and a larger wasm (7.6 MB), so not worth the extra browser requirement.
- **Replacing Asyncify with `emscripten_set_main_loop`**: §3.5 still stands. The profile shows no
  Asyncify cost worth the rewrite of ten nested loops; the time is in the renderer.
- **The canvas blit** (`Blit1to4` plus the upload) is under 5% of a busy frame; not worth a change
  to upstream's renderer.
- **LTO**: not tried; with the fight's run-to-run spread (±15%) a few per cent would not show.
