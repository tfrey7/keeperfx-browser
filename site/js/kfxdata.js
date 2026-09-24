// Loads KeeperFX's own data (graphics, sounds, configs, the original campaign; not the player's
// files) into the engine's game directory before main() runs.
//
// The data is not part of this site: whether it may be re-hosted is still open (PORTING-NOTES
// §4.4). For now the local server hands it over at DATA_URL from a folder outside the repo
// (scripts/gamedata.py, scripts/serve.py --kfx-data), described by DATA_URL/index.json.
//
// Every download gives up once it has gone STALL_MS without a byte arriving and is tried again,
// up to TRIES times: one of the ~2,000 fetches once never finished, and the page sat at
// "158 of 158 MB" until it was reloaded.

export const DATA_URL = "kfxdata";
const PARALLEL = 8;
const STALL_MS = 20_000;
const TRIES = 4;
const RETRY_DELAY_MS = 1_000; // doubled after each failed try

// An answer the server gave on purpose (a 404, say): trying again will not change it.
class HttpError extends Error {
  constructor(url, status) {
    super(`${url}: HTTP ${status}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One GET, abandoned when no bytes arrive for stallMs (waiting for the headers counts too).
async function getOnce(url, { fetch, stallMs }, init) {
  const abort = new AbortController();
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(), stallMs);
  };
  touch();
  try {
    const res = await fetch(url, { ...init, signal: abort.signal });
    if (!res.ok) throw new HttpError(url, res.status);
    const reader = res.body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      chunks.push(value);
      length += value.length;
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`${url}: no data for ${stallMs / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// getOnce, tried again after a stall, a network failure or a server error (5xx, 429).
async function get(url, options, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getOnce(url, options, init);
    } catch (err) {
      const final = err instanceof HttpError && err.status < 500 && err.status !== 429;
      if (final || attempt >= options.tries) throw err;
      console.warn(`kfxdata: ${err.message}; trying again (${attempt + 1} of ${options.tries})`);
      await sleep(options.retryDelayMs * 2 ** (attempt - 1));
    }
  }
}

function mkdirs(FS, path) {
  let at = "";
  for (const part of path.split("/").slice(1, -1)) {
    at += `/${part}`;
    if (!FS.analyzePath(at).exists) FS.mkdir(at);
  }
}

// Returns how many files were loaded, or null when this server has no KeeperFX data.
// The last argument is for tests: a stand-in fetch and shorter waits.
export async function loadKfxData(FS, root, onProgress = () => {}, overrides = {}) {
  const options = {
    fetch: globalThis.fetch.bind(globalThis),
    stallMs: STALL_MS,
    tries: TRIES,
    retryDelayMs: RETRY_DELAY_MS,
    ...overrides,
  };
  let index;
  try {
    index = await get(`${DATA_URL}/index.json`, options, { cache: "no-store" });
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
  const { files } = JSON.parse(new TextDecoder().decode(index));
  const total = files.reduce((sum, [, size]) => sum + size, 0);
  let next = 0;
  let loaded = 0;
  async function worker() {
    while (next < files.length) {
      const [name, size] = files[next++];
      const bytes = await get(`${DATA_URL}/${name.split("/").map(encodeURIComponent).join("/")}`, options);
      const path = `${root}/${name}`;
      mkdirs(FS, path);
      FS.writeFile(path, bytes);
      loaded += size;
      onProgress(loaded, total);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return files.length;
}
