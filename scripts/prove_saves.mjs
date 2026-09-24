// Proves saved games and settings survive a page reload (PLAN.md phase 6), in a real headless
// Chrome against the page as served, with a real Dungeon Keeper copy. It plays into the first
// level, turns the sound effects down in the game's own sound options, saves from the game's own
// menu, reloads the page, and loads the save back from the main menu's Load Game.
//
//   node scripts/prove_saves.mjs --url https://dungeonkeeper.tfrey7.com/ --dk "<Dungeon Keeper folder>" \
//        --debug-port <port> --work <scratch dir> --shots docs/proof [--page-from site]
//
// --page-from <dir> answers the page's own files (*.html, *.css, js/*) from that folder instead
// of the URL, while the engine and KeeperFX's data still come from the URL: a page change proved
// on the live site before it lands. Leave it off once it has landed.
//
// Screenshots: saves-saved.png (the dungeon as saved), saves-loadmenu.png (the game's Load Game
// menu after the reload), saves-loaded.png (the dungeon loaded back); the page console goes to
// saves-console.txt. Canvas coordinates are the engine's own 640x480.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Browser } from "./cdp.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const url = new URL(arg("--url", "https://dungeonkeeper.tfrey7.com/"));
const dk = arg("--dk");
const work = path.resolve(arg("--work", "proof-work"));
const shots = path.resolve(arg("--shots", "docs/proof"));
const debugPort = Number(arg("--debug-port", "8851"));
const pageFrom = arg("--page-from");
const SAVE_NAME = "web";
if (!dk) throw new Error("--dk <your Dungeon Keeper folder> is required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

// --- the engine's canvas and log -------------------------------------------------------------

async function canvasPoint(b, x, y) {
  const r = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { left: r.left, top: r.top, sx: r.width / 640, sy: r.height / 480 }; })()`);
  return { x: r.left + x * r.sx, y: r.top + y * r.sy };
}

async function click(b, x, y) {
  const at = await canvasPoint(b, x, y);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await sleep(300);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await sleep(120);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
  await sleep(300);
}

// Drags with the left button held, as a slider wants.
async function drag(b, from, to) {
  const a = await canvasPoint(b, ...from);
  const z = await canvasPoint(b, ...to);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...a });
  await sleep(300);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", ...a, button: "left", clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    await sleep(80);
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: a.x + ((z.x - a.x) * i) / 10, y: a.y + ((z.y - a.y) * i) / 10, buttons: 1,
    });
  }
  await sleep(200);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...z, button: "left", clickCount: 1 });
  await sleep(300);
}

const KEYS = { Escape: 27, Enter: 13, Delete: 46 };
async function key(b, name) {
  const params = { windowsVirtualKeyCode: KEYS[name], key: name, code: name };
  await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
  await sleep(150);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await sleep(500);
}

async function type(b, text) {
  for (const ch of text) {
    const params = { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, ...params });
    await sleep(60);
    await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    await sleep(60);
  }
}

async function shootCanvas(b, file) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  writeFileSync(file, Buffer.from(data, "base64"));
}

// The engine's last frontend state, from its own log ("... into 3 (FeSt_LAND_VIEW)").
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

// Clicks a menu item until the engine enters the state it leads to (the first click on a
// fading-in menu can be lost).
async function choose(b, x, y, into, what) {
  for (let tries = 0; tries < 3; tries++) {
    await click(b, x, y);
    try {
      await waitForState(b, into, 8000);
      check(true, what);
      return;
    } catch { /* again */ }
  }
  throw new Error(`FAILED: ${what} (last state: ${await state(b)})`);
}

const readSetting = (b, name) => b.eval(`(() => {
  const text = new TextDecoder().decode(kfx.FS.readFile("/keeperfx/save/settings.toml"));
  return Number(text.match(/^${name} = (\\d+)/m)?.[1]); })()`);
const keptSaves = (b) => b.eval(`import("./js/storage.js").then((m) => m.countSaves())`);
const pageLog = (b, text) => b.eval(`document.getElementById("engine-log").textContent.includes(${JSON.stringify(text)})`);

async function startEngine(b) {
  await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
    Number(arg("--data-timeout", "240000")));
  await waitForState(b, "FeSt_MAIN_MENU", 120000);
  await sleep(2500); // the menu fades in
}

// --- the page's own files from a local folder (--page-from) ----------------------------------

async function servePageFrom(b, dir) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  await b.send("Fetch.enable", { patterns: [{ urlPattern: `${url.origin}/*`, requestStage: "Request" }] });
  b.on("Fetch.requestPaused", async ({ requestId, request }) => {
    let rel = new URL(request.url).pathname.slice(1) || "index.html";
    const type = TYPES[path.extname(rel)];
    const local = type && !["keeperfx.js", "reader.js"].includes(rel) && path.join(dir, rel);
    let body;
    try {
      body = local && readFileSync(local);
    } catch { /* not a page file here: from the URL */ }
    if (!body) {
      await b.send("Fetch.continueRequest", { requestId });
      return;
    }
    await b.send("Fetch.fulfillRequest", {
      requestId, responseCode: 200, body: body.toString("base64"),
      responseHeaders: [{ name: "Content-Type", value: type }, { name: "Cache-Control", value: "no-store" }],
    });
  });
  console.log(`the page's own files come from ${dir}; the engine and its data from ${url.origin}`);
}

// --- the proof -------------------------------------------------------------------------------

rmSync(work, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const b = await Browser.launch({ profile: path.join(work, "saves-profile"), port: debugPort, height: 1300 });
try {
  if (pageFrom) await servePageFrom(b, path.resolve(pageFrom));

  // 1. The player's folder, then the engine to its main menu, with no saves yet.
  await b.goto(url.href);
  await b.waitFor(`document.body.dataset.state === "ask"`, 30000);
  await b.setFiles("#pick-folder", [path.resolve(dk)]);
  await b.waitFor(`document.body.dataset.state === "ready"`, 60000);
  const opened = b.once("Page.loadEventFired");
  await b.eval(`document.getElementById("start").click()`);
  await opened;
  await startEngine(b);
  check(await pageLog(b, "page: 0 saved game(s) kept"), "the engine started with no saved games kept");

  // 2. Into the first level: Start New Game, then Eversmile on the land view.
  await choose(b, 320, 115, "FeSt_LAND_VIEW", "Start New Game opened the land view");
  await choose(b, 320, 205, "FeSt_INITIAL", "a click on Eversmile started level 1");
  await sleep(8000);
  await key(b, "Delete"); // turn the view, so the saved camera is not the level's opening one
  await key(b, "Delete");
  await sleep(20000); // let the imps get about their work

  // 3. A setting: the sound effects slider in the game's own Sound Options, turned down.
  const before = await readSetting(b, "sound_volume");
  await key(b, "Escape");
  await click(b, 415, 240);
  await drag(b, [440, 191], [370, 191]);
  const volume = await readSetting(b, "sound_volume");
  check(volume < before, `the sound effects volume went from ${before} to ${volume} (settings.toml)`);
  await key(b, "Escape");

  // 4. Save from the game's own menu: Options, Save, the first slot, a name.
  await key(b, "Escape");
  await click(b, 320, 240);
  await click(b, 390, 128);
  await type(b, SAVE_NAME);
  await key(b, "Enter");
  await sleep(1000);
  await shootCanvas(b, path.join(shots, "saves-saved.png"));
  let kept = { games: 0 };
  for (let i = 0; i < 40 && !(kept.games && kept.settings); i++) {
    await sleep(500);
    kept = await keptSaves(b);
  }
  check(kept.games === 1 && kept.settings, `the save and the settings reached IndexedDB (${JSON.stringify(kept)})`);

  // 5. Reload the page: the save and the setting come back from browser storage.
  const reloaded = b.once("Page.loadEventFired");
  await b.send("Page.reload", { ignoreCache: true });
  await reloaded;
  await startEngine(b);
  check(await pageLog(b, "page: 1 saved game(s) kept"), "after the reload the page found the saved game");
  check(await readSetting(b, "sound_volume") === volume, `after the reload the sound effects volume is still ${volume}`);

  // 6. The game's own Load Game menu lists it, and loading it goes back into the dungeon.
  await choose(b, 320, 253, "FeSt_FELOAD_GAME", "Load Game opened the load menu");
  await sleep(1500);
  await shootCanvas(b, path.join(shots, "saves-loadmenu.png"));
  await choose(b, 107, 170, "FeSt_INITIAL", `a click on the save "${SAVE_NAME}" loaded it`);
  await sleep(6000);
  await shootCanvas(b, path.join(shots, "saves-loaded.png"));
  check(await pageLog(b, "Loaded level 1"), "the engine loaded level 1 from the save");
} finally {
  writeFileSync(path.join(shots, "saves-console.txt"), b.console.join("\n") + "\n");
  await b.close();
}
console.log("all proved");
