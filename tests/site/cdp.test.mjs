// Whether the proof scripts' Chrome driver (scripts/cdp.mjs) gets past the engine page's "click to
// play" panel, run by `node --test` in a real headless Chrome. The page here is a stand-in for
// engine.html with the real site/js/soundgate.js: held back until a click, it says "running" only
// once the browser has let its sound start. Skipped where there is no Chrome or Edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../scripts/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "http://kfx.test";
const hasChrome = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].some((p) => p && existsSync(p));

const PAGE = `<!doctype html>
<p id="engine-status">Loading</p>
<div id="click-to-play" hidden><button type="button" id="play">Play with sound</button></div>
<script type="module">
  import { soundIsBlocked, waitForClick } from "./js/soundgate.js";
  window.wasHeld = await soundIsBlocked();
  if (wasHeld) await waitForClick({ panel: document.getElementById("click-to-play"), button: document.getElementById("play") });
  const sound = new AudioContext();
  await Promise.race([sound.resume(), new Promise((r) => setTimeout(r, 1000))]);
  document.getElementById("engine-status").textContent = sound.state === "running" ? "The engine is running." : "silent";
</script>`;

// A port nobody holds, for Chrome's DevTools: never a fixed one, other runs share this machine.
function freePort() {
  return new Promise((ok) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

// The stand-in page and the real sound gate, answered by the driver rather than by a server.
async function servePage(b) {
  await b.send("Fetch.enable", { patterns: [{ urlPattern: `${ORIGIN}/*`, requestStage: "Request" }] });
  b.on("Fetch.requestPaused", ({ requestId, request }) => {
    const rel = new URL(request.url).pathname;
    if (rel !== "/engine.html" && !rel.startsWith("/js/")) {
      b.send("Fetch.fulfillRequest", { requestId, responseCode: 404 }); // the favicon
      return;
    }
    const [body, type] = rel === "/engine.html"
      ? [Buffer.from(PAGE), "text/html"]
      : [readFileSync(path.join(ROOT, "site", rel)), "text/javascript"];
    b.send("Fetch.fulfillRequest", {
      requestId, responseCode: 200, body: body.toString("base64"),
      responseHeaders: [{ name: "Content-Type", value: type }],
    });
  });
}

test("a game page opened directly is started, with sound, by pressing its panel", { skip: !hasChrome && "no Chrome or Edge" }, async () => {
  const profile = path.join(ROOT, ".state", `cdp-test-profile-${process.pid}`);
  const b = await Browser.launch({ profile, port: await freePort(), width: 640, height: 480 });
  try {
    await servePage(b);
    await b.goto(`${ORIGIN}/engine.html`);
    await b.waitForEngine(10000);
    assert.equal(await b.eval("wasHeld"), true, "the page held its sound back until a click");
  } finally {
    const gone = b.proc.exitCode === null && new Promise((ok) => b.proc.once("exit", ok));
    await b.close();
    await gone; // Chrome lets go of its profile only once it has exited
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
