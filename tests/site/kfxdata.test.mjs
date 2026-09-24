// The KeeperFX data loader's time limit and retries, run by `node --test` (tests/test_site.py runs this).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKfxData } from "../../site/js/kfxdata.js";

const FAST = { stallMs: 50, retryDelayMs: 1, tries: 3 };

// A stand-in for the engine's FS that just keeps what is written.
function fakeFS() {
  const dirs = new Set(["/"]);
  const files = new Map();
  return {
    files,
    analyzePath: (p) => ({ exists: dirs.has(p) || files.has(p) }),
    mkdir: (p) => dirs.add(p),
    writeFile: (p, bytes) => files.set(p, new TextDecoder().decode(bytes)),
  };
}

// A server holding `data` (name -> text); `answer(name, attempt)` may override any request.
function fakeFetch(data, answer = () => undefined) {
  const attempts = new Map();
  const fetch = async (url, { signal }) => {
    const name = decodeURIComponent(url.replace(/^kfxdata\//, ""));
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    const special = answer(name, attempt, signal);
    if (special) return special;
    if (name === "index.json") {
      const files = Object.entries(data).map(([n, text]) => [n, text.length]);
      return new Response(JSON.stringify({ files }));
    }
    return name in data ? new Response(data[name]) : new Response("", { status: 404 });
  };
  return { fetch, attempts };
}

// A response whose headers arrive but whose body never finishes, until the page gives up on it.
function hangingResponse(signal) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("par"));
      signal.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
  return new Response(body);
}

const DATA = { "data/a.dat": "alpha", "new folder/b.cfg": "beta" };

test("every file lands in the game directory and progress reaches the total", async () => {
  const FS = fakeFS();
  const seen = [];
  const { fetch } = fakeFetch(DATA);
  const count = await loadKfxData(FS, "/keeperfx", (done, total) => seen.push([done, total]), { ...FAST, fetch });
  assert.equal(count, 2);
  assert.equal(FS.files.get("/keeperfx/data/a.dat"), "alpha");
  assert.equal(FS.files.get("/keeperfx/new folder/b.cfg"), "beta");
  assert.deepEqual(seen.at(-1), [9, 9]);
});

test("a download that stalls halfway is dropped and fetched again", async () => {
  const FS = fakeFS();
  const { fetch, attempts } = fakeFetch(DATA, (name, attempt, signal) =>
    name === "data/a.dat" && attempt === 1 ? hangingResponse(signal) : undefined);
  assert.equal(await loadKfxData(FS, "/keeperfx", undefined, { ...FAST, fetch }), 2);
  assert.equal(attempts.get("data/a.dat"), 2);
  assert.equal(FS.files.get("/keeperfx/data/a.dat"), "alpha");
});

test("a request that never answers at all is dropped and fetched again", async () => {
  const FS = fakeFS();
  const { fetch, attempts } = fakeFetch(DATA, (name, attempt, signal) =>
    name === "new folder/b.cfg" && attempt === 1
      ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
      : undefined);
  assert.equal(await loadKfxData(FS, "/keeperfx", undefined, { ...FAST, fetch }), 2);
  assert.equal(attempts.get("new folder/b.cfg"), 2);
});

test("a server error is retried; a file that stalls every time fails with a plain message", async () => {
  const { fetch, attempts } = fakeFetch(DATA, (name, attempt, signal) => {
    if (name === "new folder/b.cfg" && attempt === 1) return new Response("", { status: 503 });
    if (name === "data/a.dat") return hangingResponse(signal);
  });
  await assert.rejects(loadKfxData(fakeFS(), "/keeperfx", undefined, { ...FAST, fetch }),
    /kfxdata\/data\/a\.dat: no data for 0\.05 s/);
  assert.equal(attempts.get("data/a.dat"), 3);
  assert.equal(attempts.get("new folder/b.cfg"), 2);
});

test("a missing file is not retried, and a server with no index has no data", async () => {
  const { fetch, attempts } = fakeFetch({ ...DATA, "gone.dat": "x" }, (name) =>
    name === "gone.dat" ? new Response("", { status: 404 }) : undefined);
  await assert.rejects(loadKfxData(fakeFS(), "/keeperfx", undefined, { ...FAST, fetch }), /gone\.dat: HTTP 404/);
  assert.equal(attempts.get("gone.dat"), 1);

  const empty = fakeFetch({}, (name) => (name === "index.json" ? new Response("", { status: 404 }) : undefined));
  assert.equal(await loadKfxData(fakeFS(), "/keeperfx", undefined, { ...FAST, fetch: empty.fetch }), null);
});
