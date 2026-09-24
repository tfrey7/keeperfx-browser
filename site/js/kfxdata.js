// Loads KeeperFX's own data (graphics, sounds, configs, the original campaign; not the player's
// files) into the engine's game directory before main() runs.
//
// The data is not part of this site: whether it may be re-hosted is still open (PORTING-NOTES
// §4.4). For now the local server hands it over at DATA_URL from a folder outside the repo
// (scripts/gamedata.py, scripts/serve.py --kfx-data), described by DATA_URL/index.json.

export const DATA_URL = "kfxdata";
const PARALLEL = 8;

function mkdirs(FS, path) {
  let at = "";
  for (const part of path.split("/").slice(1, -1)) {
    at += `/${part}`;
    if (!FS.analyzePath(at).exists) FS.mkdir(at);
  }
}

// Returns how many files were loaded, or null when this server has no KeeperFX data.
export async function loadKfxData(FS, root, onProgress = () => {}) {
  const res = await fetch(`${DATA_URL}/index.json`, { cache: "no-store" });
  if (!res.ok) return null;
  const { files } = await res.json();
  const total = files.reduce((sum, [, size]) => sum + size, 0);
  let next = 0;
  let loaded = 0;
  async function worker() {
    while (next < files.length) {
      const [name, size] = files[next++];
      const got = await fetch(`${DATA_URL}/${name.split("/").map(encodeURIComponent).join("/")}`);
      if (!got.ok) throw new Error(`${DATA_URL}/${name}: HTTP ${got.status}`);
      const path = `${root}/${name}`;
      mkdirs(FS, path);
      FS.writeFile(path, new Uint8Array(await got.arrayBuffer()));
      loaded += size;
      onProgress(loaded, total);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return files.length;
}
