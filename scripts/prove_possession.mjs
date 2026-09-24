// Proves that possessing a creature locks the mouse to the game and turns it for as long as the
// mouse keeps moving, as the desktop game does, and that leaving the creature lets the mouse go.
//
//   node scripts/prove_possession.mjs --url https://dungeonkeeper.tfrey7.com/ --dk "<Dungeon Keeper folder>" \
//        --debug-port <port> --work <scratch> --shots <folder> [--engine-from site]
//
// --engine-from <dir> answers keeperfx.js and keeperfx.wasm from that folder, so an engine build is
// tried on the live page before it lands. It starts level 1 with the cheat switch, starts a fight,
// possesses one of the keeper's creatures in it, then moves the mouse right, far past the edge of the
// page, and shoots the view at the start, halfway and at the end. Exits 1 if the page never held
// pointer lock while possessing, or still held it after leaving.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Browser } from "./cdp.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const url = new URL(arg("--url", "https://dungeonkeeper.tfrey7.com/"));
const dk = arg("--dk");
const work = path.resolve(arg("--work", "possession-work"));
const shots = path.resolve(arg("--shots", work));
const debugPort = Number(arg("--debug-port", "8812"));
const engineFrom = arg("--engine-from");
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

const KEYS = { Enter: 13 };
async function key(b, name) {
  const params = { windowsVirtualKeyCode: KEYS[name], key: name, code: name };
  await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
  await sleep(120);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await sleep(300);
}

// A cheat command, typed into the game's own message line: Enter, !command, Enter.
async function command(b, text) {
  await key(b, "Enter");
  for (const ch of `!${text}`) {
    await b.send("Input.dispatchKeyEvent", { type: "char", text: ch });
    await sleep(40);
  }
  await key(b, "Enter");
  await sleep(500);
}

async function shootCanvas(b, file) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log("shot", file);
}

const locked = (b) => b.eval(`document.pointerLockElement?.id ?? null`);

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

// --- the engine from a local folder (--engine-from) ------------------------------------------

async function serveEngine(b) {
  const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm" };
  await b.send("Fetch.enable", { patterns: [
    { urlPattern: `${url.origin}/keeperfx.js`, requestStage: "Request" },
    { urlPattern: `${url.origin}/keeperfx.wasm`, requestStage: "Request" },
  ] });
  b.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const rel = new URL(request.url).pathname.slice(1);
    await b.send("Fetch.fulfillRequest", {
      requestId, responseCode: 200, body: readFileSync(path.join(path.resolve(engineFrom), rel)).toString("base64"),
      responseHeaders: [{ name: "Content-Type", value: TYPES[path.extname(rel)] }, { name: "Cache-Control", value: "no-store" }],
    });
  });
  console.log(`engine from ${engineFrom}`);
}

// --- the run ---------------------------------------------------------------------------------

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(shots, { recursive: true });
const b = await Browser.launch({ profile: path.join(work, "profile"), port: debugPort, height: 1300 });
let failed = false;
try {
  if (engineFrom) await serveEngine(b);
  // Headless Chrome's page never has focus, and a page without focus is refused pointer lock.
  await b.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // Every pointer-lock request, change and refusal, in order, to tell a refused lock from none asked.
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.lockLog = [];
    const ask = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function (...a) {
      lockLog.push("request " + this.id + (navigator.userActivation.isActive ? "" : " (no user activation)") + " focus=" + document.hasFocus() + " " + document.visibilityState + " top=" + (window === top));
      const r = ask.apply(this, a);
      r?.catch?.((e) => lockLog.push("refused: " + e.message));
      return r;
    };
    document.addEventListener("pointerlockchange", () => lockLog.push("locked " + (document.pointerLockElement?.id ?? "nothing")));
    document.addEventListener("pointerlockerror", () => lockLog.push("error"));` });

  await b.goto(url.href);
  await b.waitFor(`document.body.dataset.state === "ask"`, 30000);
  await b.setFiles("#pick-folder", [path.resolve(dk)]);
  await b.waitFor(`document.body.dataset.state === "ready"`, 60000);
  const opened = b.once("Page.loadEventFired");
  await b.eval(`location.href = new URL("engine.html?args=-alex", location.href).href`);
  await opened;
  // The browser also refuses the lock to a page whose view does not have focus.
  await b.send("Page.bringToFront");
  await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
    Number(arg("--data-timeout", "240000")));
  await waitForState(b, "FeSt_MAIN_MENU", 120000);
  await sleep(2500);

  // Level 1, and a fight in the middle of the view, as measure_fps.mjs makes it: the keeper's
  // creatures and heroes, 25 each, which crowd together, so a click there lands on one.
  await choose(b, 320, 115, "FeSt_LAND_VIEW");
  await choose(b, 320, 205, "FeSt_INITIAL");
  await sleep(15000);
  await move(b, 320, 250);
  await command(b, "create.creature 250 4 25");
  await command(b, "create.creature 249 4 25 PLAYER_GOOD");
  await command(b, "power.give POWER_POSSESS");
  await sleep(3000);
  const before = await locked(b);

  // Possess Creature from the spells tab, then a click on a creature in the thick of the fight.
  await click(b, 64, 169);
  await click(b, 26, 256);
  await click(b, 320, 250);
  await sleep(3000);
  const possessing = await locked(b);
  await shootCanvas(b, path.join(shots, "possess-start.png"));

  // Keep moving the mouse right: 60 steps of 20 canvas pixels, ending 900 pixels past the right
  // edge. A pointer that is not locked stops at the edge of the page, and turning stops with it.
  const steps = 60;
  for (let i = 1; i <= steps; i++) {
    const at = await canvasPoint(b, 320 + 20 * i, 240);
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    await sleep(50);
    if (i === steps / 2) await shootCanvas(b, path.join(shots, "possess-turn-half.png"));
  }
  await sleep(300);
  await shootCanvas(b, path.join(shots, "possess-turn-end.png"));
  const stillLocked = await locked(b);

  // Right-click leaves the creature, and with it the lock.
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 10, button: "right", clickCount: 1 });
  await sleep(120);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 10, button: "right", clickCount: 1 });
  await sleep(3000);
  const after = await locked(b);
  await shootCanvas(b, path.join(shots, "possess-left.png"));

  console.log(`pointer lock: before possessing ${before}, possessing ${possessing}, ` +
    `after turning ${stillLocked}, after leaving ${after}`);
  console.log("pointer lock events:", (await b.eval("lockLog")).join("; ") || "none");
  failed = before !== null || possessing !== "canvas" || stillLocked !== "canvas" || after !== null;
  console.log(failed ? "FAIL" : "OK");
} finally {
  writeFileSync(path.join(work, "console.txt"), b.console.join("\n") + "\n");
  await b.close();
}
process.exit(failed ? 1 : 0);
