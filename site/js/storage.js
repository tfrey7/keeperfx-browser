// Keeps the player's game files in this browser, inside an Emscripten module's filesystem.
//
// The files live in IndexedDB through Emscripten's IDBFS, mounted at STORE. The engine reads its
// game directory ROOT, whose data/, sound/, music/ and ldata/ will also hold KeeperFX's own
// files, so the player's files are not mounted over those folders: each is linked into place
// instead (ROOT/data/bluepal.dat -> STORE/data/bluepal.dat). The engine build mounts the same way.
//
// The engine writes its saved games and its settings (settings.toml) into ROOT/save, its own
// FGrp_Save folder. The engine page mounts a second IDBFS there, with Emscripten's autoPersist,
// so every file the engine closes after writing is copied to IndexedDB straight away; it syncs
// once more when the page is hidden. The files page never mounts it (a save is ~50 MB): it only
// counts and clears the saves, straight from that IndexedDB database.

import { ALL } from "./manifest.js";

export const ROOT = "/keeperfx";
export const STORE = `${ROOT}/player`;
export const SAVES = `${ROOT}/save`;
const SAVED_GAME = /^fx1g\d+\.sav$/; // the engine's saved_game_filename, fx1g%04d.sav
const FOLDERS = ["data", "sound", "music", "ldata"];

function exists(FS, path) {
  return FS.analyzePath(path).exists;
}

// populate true: IndexedDB -> memory; false: memory -> IndexedDB.
function sync(FS, populate) {
  return new Promise((ok, fail) => FS.syncfs(populate, (err) => (err ? fail(err) : ok())));
}

// Links every stored file into the engine's folders, replacing any link left from before.
function linkStored(FS) {
  for (const folder of FOLDERS) {
    if (!exists(FS, `${ROOT}/${folder}`)) FS.mkdir(`${ROOT}/${folder}`);
  }
  for (const name of ALL) {
    const link = `${ROOT}/${name}`;
    if (isLink(FS, link)) FS.unlink(link);
    if (exists(FS, `${STORE}/${name}`)) FS.symlink(`${STORE}/${name}`, link);
  }
}

function isLink(FS, path) {
  try {
    return FS.isLink(FS.lstat(path).mode);
  } catch {
    return false;
  }
}

// Which of the manifest's files are kept.
export function storedFiles(FS) {
  return ALL.filter((name) => exists(FS, `${STORE}/${name}`));
}

// Mounts the store, reads back whatever an earlier visit kept, and links it into place.
export async function mountStore(FS) {
  for (const dir of [ROOT, STORE]) {
    if (!exists(FS, dir)) FS.mkdir(dir);
  }
  FS.mount(FS.filesystems.IDBFS, {}, STORE);
  await sync(FS, true);
  linkStored(FS);
  return storedFiles(FS);
}

// Replaces whatever was kept with these files. sources: Map(manifest name -> async () => bytes).
export async function keepFiles(FS, sources, onProgress = () => {}) {
  removeStored(FS);
  for (const folder of FOLDERS) {
    if (!exists(FS, `${STORE}/${folder}`)) FS.mkdir(`${STORE}/${folder}`);
  }
  let done = 0;
  for (const [name, read] of sources) {
    FS.writeFile(`${STORE}/${name}`, await read());
    onProgress(++done, sources.size);
  }
  await sync(FS, false);
  linkStored(FS);
  return storedFiles(FS);
}

function removeStored(FS) {
  for (const name of ALL) {
    if (exists(FS, `${STORE}/${name}`)) FS.unlink(`${STORE}/${name}`);
  }
}

// "Forget my files": removes them from memory and from IndexedDB.
export async function forgetFiles(FS) {
  removeStored(FS);
  await sync(FS, false);
  linkStored(FS);
}

// --- Saved games and settings ----------------------------------------------------------------

// Mounts the engine's save folder from IndexedDB, before main(), and keeps it written back.
// Returns the saved games found.
export async function mountSaves(FS) {
  if (!exists(FS, SAVES)) FS.mkdir(SAVES);
  FS.mount(FS.filesystems.IDBFS, { autoPersist: true }, SAVES);
  await sync(FS, true);
  return FS.readdir(SAVES).filter((name) => SAVED_GAME.test(name));
}

// Writes anything not yet in IndexedDB back to it; for when the page is hidden or closed.
export function persistSaves(FS) {
  return sync(FS, false);
}

// IDBFS keeps each mount in an IndexedDB database named after the mount point, one record per
// path in its FILE_DATA store (Emscripten's libidbfs.js).
const SAVES_DB = SAVES;
const SAVES_TABLE = "FILE_DATA";

async function savesDbExists(idb) {
  if (!idb.databases) return true; // this browser cannot list them; opening one is harmless
  return (await idb.databases()).some((db) => db.name === SAVES_DB);
}

function savedPaths(idb) {
  return new Promise((ok, fail) => {
    const open = idb.open(SAVES_DB);
    open.onerror = () => fail(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(SAVES_TABLE)) {
        db.close();
        ok([]);
        return;
      }
      const keys = db.transaction(SAVES_TABLE, "readonly").objectStore(SAVES_TABLE).getAllKeys();
      keys.onerror = () => fail(keys.error);
      keys.onsuccess = () => {
        db.close();
        ok(keys.result.map(String));
      };
    };
  });
}

// How many saved games are kept in this browser, and whether the engine's settings are.
export async function countSaves(idb = indexedDB) {
  if (!(await savesDbExists(idb))) return { games: 0, settings: false };
  const names = (await savedPaths(idb)).map((path) => path.slice(path.lastIndexOf("/") + 1));
  return {
    games: names.filter((name) => SAVED_GAME.test(name)).length,
    settings: names.includes("settings.toml"),
  };
}

// "Forget my files" with "and my saves": the saved games and settings go too.
export function forgetSaves(idb = indexedDB) {
  return new Promise((ok, fail) => {
    const del = idb.deleteDatabase(SAVES_DB);
    del.onsuccess = () => ok();
    del.onerror = () => fail(del.error);
    // The game's own tab holds the database open; the delete waits and finishes once it closes.
    del.onblocked = () => fail(new Error("the game is still open in another tab: the saves go once it is closed"));
  });
}
