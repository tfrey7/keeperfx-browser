// Measures the engine's frame rate in the first level (PLAN.md phase 7), in a real headless
// Chrome against the page as served, with a real Dungeon Keeper copy. It starts the level through
// the menus the way a player does, then measures three scenes the same way every time:
//
//   quiet       the opening dungeon, imps at work
//   fight       fifty creatures fighting: 25 of the keeper's and 25 heroes, made with the
//               engine's own cheat commands (the page starts it with -alex, KeeperFX's cheat switch)
//   possession  one of the creatures in that fight possessed, seen through its eyes
//
//   node scripts/measure_fps.mjs --url https://dungeonkeeper.tfrey7.com/ --dk "<Dungeon Keeper folder>" \
//        --debug-port <port> --work <scratch dir> --shots <dir> --label before \
//        [--page-from site] [--engine-from site]
//
// --page-from <dir> answers the page's own files (*.html, *.css, js/*) from that folder, and
// --engine-from <dir> the engine (keeperfx.js, keeperfx.wasm), while KeeperFX's data still comes
// from the URL: a page or an engine build measured on the live site before it lands.
//
// For each scene it prints the engine's presents a second and the browser's frames a second
// (site/js/fps.js), writes fps-<label>-<scene>.png, and keeps a CPU profile of the scene,
// summarised as the functions that took the most time (wasm names from keeperfx.js.symbols).
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Browser } from "./cdp.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const url = new URL(arg("--url", "https://dungeonkeeper.tfrey7.com/"));
const dk = arg("--dk");
const work = path.resolve(arg("--work", "fps-work"));
const shots = path.resolve(arg("--shots", work));
const label = arg("--label", "run");
const debugPort = Number(arg("--debug-port", "8811"));
const pageFrom = arg("--page-from");
const engineFrom = arg("--engine-from");
const seconds = Number(arg("--seconds", "10"));
if (!dk) throw new Error("--dk <your Dungeon Keeper folder> is required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- input on the engine's 640x480 canvas ----------------------------------------------------

async function canvasPoint(b, x, y) {
  const r = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { left: r.left, top: r.top, sx: r.width / 640, sy: r.height / 480 }; })()`);
  return { x: r.left + x * r.sx, y: r.top + y * r.sy };
}

async function move(b, x, y) {
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await canvasPoint(b, x, y)) });
  await sleep(300);
}

async function click(b, x, y, button = "left") {
  const at = await canvasPoint(b, x, y);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await sleep(300);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button, clickCount: 1 });
  await sleep(120);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button, clickCount: 1 });
  await sleep(300);
}

const KEYS = { Enter: 13, Escape: 27 };
async function key(b, name) {
  const params = { windowsVirtualKeyCode: KEYS[name], key: name, code: name };
  await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
  await sleep(120);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await sleep(300);
}

async function type(b, text) {
  for (const ch of text) {
    await b.send("Input.dispatchKeyEvent", { type: "char", text: ch });
    await sleep(40);
  }
}

// A cheat command, typed into the game's own message line: Enter, !command, Enter.
async function command(b, text) {
  await key(b, "Enter");
  await type(b, `!${text}`);
  await key(b, "Enter");
  await sleep(500);
}

async function shootCanvas(b, file) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  writeFileSync(file, Buffer.from(data, "base64"));
}

// --- the engine's state, from its own log ----------------------------------------------------

const state = (b) => b.eval(`(document.getElementById("engine-log").textContent
  .match(/state change from \\d+ \\(\\w+\\) into \\d+ \\(\\w+\\)/g) || [""]).slice(-1)[0].replace(/.* into /, "")`);

async function waitForState(b, name, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await state(b)).includes(name)) return;
    await sleep(250);
  }
  throw new Error(`the engine never entered ${name} (last: ${await state(b)})`);
}

async function choose(b, x, y, into) {
  for (let tries = 0; tries < 3; tries++) {
    await click(b, x, y);
    try {
      await waitForState(b, into, 8000);
      return;
    } catch { /* the first click on a fading-in menu can be lost */ }
  }
  throw new Error(`never reached ${into} (last state: ${await state(b)})`);
}

// --- measuring -------------------------------------------------------------------------------

function symbols() {
  // --symbols names the map for an engine that is not served from here (the live site has none).
  const file = arg("--symbols") || path.join(path.resolve(engineFrom || "site"), "keeperfx.js.symbols");
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) map.set(Number(line.slice(0, at)), line.slice(at + 1).trim());
  }
  return map;
}
const SYMBOLS = symbols();

// Self time per function from a CPU profile, the biggest first, as percentages of the whole.
function topFunctions(profile, count = 15) {
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  let total = 0;
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    let name = f.functionName || "(anonymous)";
    const wasm = /^\$?wasm-function\[(\d+)\]$/.exec(name) || /^\$(\d+)$/.exec(name);
    if (wasm && SYMBOLS.has(Number(wasm[1]))) name = SYMBOLS.get(Number(wasm[1]));
    self.set(name, (self.get(name) || 0) + (dt[i] || 0));
    total += dt[i] || 0;
  });
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, count)
    .map(([name, t]) => `${((100 * t) / total).toFixed(1).padStart(5)}%  ${name}`);
}

const results = [];
async function measure(b, scene) {
  await b.send("Profiler.enable");
  await b.send("Profiler.setSamplingInterval", { interval: 200 });
  const a = await b.eval("kfxFps()");
  const t0 = Date.now();
  await b.send("Profiler.start");
  await sleep(seconds * 1000);
  const { profile } = await b.send("Profiler.stop");
  const z = await b.eval("kfxFps()");
  const s = (Date.now() - t0) / 1000;
  const r = {
    scene,
    engine: +((z.presents - a.presents) / s).toFixed(1),
    shown: +((z.shown - a.shown) / s).toFixed(1),
  };
  results.push(r);
  console.log(`${label} ${scene}: engine ${r.engine} fps, browser ${r.shown} fps over ${s.toFixed(1)}s`);
  const top = topFunctions(profile);
  console.log(top.map((l) => `    ${l}`).join("\n"));
  writeFileSync(path.join(work, `profile-${label}-${scene}.cpuprofile`), JSON.stringify(profile));
  writeFileSync(path.join(work, `profile-${label}-${scene}.txt`), top.join("\n") + "\n");
  await shootCanvas(b, path.join(shots, `fps-${label}-${scene}.png`));
}

// --- the page and engine from local folders (--page-from, --engine-from) ---------------------

const ENGINE = ["keeperfx.js", "keeperfx.wasm"];
function localFile(rel) {
  const dir = ENGINE.includes(rel) ? engineFrom : pageFrom;
  return dir && !rel.startsWith("kfxdata/") && path.join(path.resolve(dir), rel);
}

async function serveLocal(b) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
  await b.send("Fetch.enable", { patterns: [{ urlPattern: `${url.origin}/*`, requestStage: "Request" }] });
  b.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const rel = new URL(request.url).pathname.slice(1) || "index.html";
    const type = TYPES[path.extname(rel)];
    let body;
    try {
      body = type && localFile(rel) && readFileSync(localFile(rel));
    } catch { /* not ours: from the URL */ }
    if (!body) {
      await b.send("Fetch.continueRequest", { requestId });
      return;
    }
    await b.send("Fetch.fulfillRequest", {
      requestId, responseCode: 200, body: body.toString("base64"),
      responseHeaders: [{ name: "Content-Type", value: type }, { name: "Cache-Control", value: "no-store" }],
    });
  });
  console.log(`page from ${pageFrom || url.origin}, engine from ${engineFrom || url.origin}`);
}

// --- the run ---------------------------------------------------------------------------------

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(shots, { recursive: true });
const b = await Browser.launch({ profile: path.join(work, "profile"), port: debugPort, height: 1300 });
try {
  if (pageFrom || engineFrom) await serveLocal(b);

  // The player's folder, then the engine with the readout on and its cheat switch.
  await b.goto(url.href);
  await b.waitFor(`document.body.dataset.state === "ask"`, 30000);
  await b.setFiles("#pick-folder", [path.resolve(dk)]);
  await b.waitFor(`document.body.dataset.state === "ready"`, 60000);
  const opened = b.once("Page.loadEventFired");
  await b.eval(`location.href = new URL("engine.html?fps&args=-alex", location.href).href`);
  await opened;
  await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
    Number(arg("--data-timeout", "240000")));
  await waitForState(b, "FeSt_MAIN_MENU", 120000);
  await sleep(2500);

  // Into the first level: Start New Game, then Eversmile on the land view.
  await choose(b, 320, 115, "FeSt_LAND_VIEW");
  await choose(b, 320, 205, "FeSt_INITIAL");
  await sleep(20000);
  await measure(b, "quiet");

  // A fight in the middle of the view: the keeper's creatures and heroes, 25 each, level 4.
  await move(b, 320, 250);
  await command(b, "create.creature 250 4 25");
  await command(b, "create.creature 249 4 25 PLAYER_GOOD");
  await sleep(3000);
  await measure(b, "fight");

  // Possess one of the keeper's creatures in the fight: the power, then a click on the creature.
  await command(b, "power.give POWER_POSSESS");
  await click(b, 64, 169); // the spells tab
  await click(b, 26, 256); // its first power: Possess Creature
  await click(b, 320, 250); // a creature in the thick of the fight
  await sleep(2000);
  await measure(b, "possession");
} finally {
  writeFileSync(path.join(work, `console-${label}.txt`), b.console.join("\n") + "\n");
  writeFileSync(path.join(work, `fps-${label}.json`), JSON.stringify(results, null, 2) + "\n");
  await b.close();
}
