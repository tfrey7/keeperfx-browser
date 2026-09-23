// Keeps the player's game files in this browser, inside an Emscripten module's filesystem.
//
// The files live in IndexedDB through Emscripten's IDBFS, mounted at STORE. The engine reads its
// game directory ROOT, whose data/, sound/, music/ and ldata/ will also hold KeeperFX's own
// files, so the player's files are not mounted over those folders: each is linked into place
// instead (ROOT/data/bluepal.dat -> STORE/data/bluepal.dat). The engine build mounts the same way.

import { ALL } from "./manifest.js";

export const ROOT = "/keeperfx";
export const STORE = `${ROOT}/player`;
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
