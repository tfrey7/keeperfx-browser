// Saved games and settings in browser storage (site/js/storage.js), run by `node --test`.
// A fake Emscripten FS and a fake IndexedDB stand in for the browser's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SAVES, mountSaves, countSaves, forgetSaves } from "../../site/js/storage.js";

function fakeFS(files) {
  const mounts = [];
  const synced = [];
  return {
    mounts,
    synced,
    filesystems: { IDBFS: "IDBFS" },
    analyzePath: (path) => ({ exists: path === SAVES && mounts.length > 0 }),
    mkdir: () => {},
    mount: (type, opts, at) => mounts.push({ type, opts, at }),
    syncfs: (populate, done) => (synced.push(populate), done(null)),
    readdir: () => [".", "..", ...files],
  };
}

// Just enough of indexedDB for countSaves and forgetSaves: one database of path keys.
function fakeIDB(dbs) {
  const later = (fn) => setTimeout(fn, 0);
  return {
    databases: async () => Object.keys(dbs).map((name) => ({ name })),
    open(name) {
      const req = {};
      later(() => {
        const keys = dbs[name] ?? null;
        req.result = {
          objectStoreNames: { contains: (store) => store === "FILE_DATA" && keys !== null },
          close: () => {},
          transaction: () => ({ objectStore: () => ({ getAllKeys() {
            const all = {};
            later(() => ((all.result = keys), all.onsuccess()));
            return all;
          } }) }),
        };
        req.onsuccess();
      });
      return req;
    },
    deleteDatabase(name) {
      const req = {};
      later(() => (delete dbs[name], req.onsuccess()));
      return req;
    },
  };
}

test("the engine's save folder is mounted from IndexedDB with autoPersist and read back before main", async () => {
  const FS = fakeFS(["settings.toml", "fx1g0000.sav", "fx1g0003.sav", "scr_dkpr.dat"]);
  const games = await mountSaves(FS);
  assert.deepEqual(FS.mounts, [{ type: "IDBFS", opts: { autoPersist: true }, at: "/keeperfx/save" }]);
  assert.deepEqual(FS.synced, [true]);
  assert.deepEqual(games, ["fx1g0000.sav", "fx1g0003.sav"]);
});

test("countSaves counts the saved games and the settings kept, and nothing when none are", async () => {
  const idb = fakeIDB({
    "/keeperfx/save": ["/keeperfx/save", "/keeperfx/save/settings.toml", "/keeperfx/save/fx1g0000.sav",
      "/keeperfx/save/fx1g0001.sav", "/keeperfx/save/scr_dkpr.dat"],
  });
  assert.deepEqual(await countSaves(idb), { games: 2, settings: true });
  assert.deepEqual(await countSaves(fakeIDB({})), { games: 0, settings: false });
});

test("forgetSaves clears the saves and settings, and leaves the player's files", async () => {
  const dbs = { "/keeperfx/save": ["/keeperfx/save/fx1g0000.sav"], "/keeperfx/player": ["/keeperfx/player/data"] };
  await forgetSaves(fakeIDB(dbs));
  assert.deepEqual(Object.keys(dbs), ["/keeperfx/player"]);
});
