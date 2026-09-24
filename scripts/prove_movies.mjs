// Proves the original game's movies play through the engine's own movie player (FFmpeg, compiled
// in), in a real headless Chrome against the page as served:
//
// 1. the intro, intromix.smk, plays at start after the two splash screens, with its sound reaching
//    the speakers and its pictures changing on the canvas; Escape skips it to the main menu;
// 2. the campaign's outro, outromix.smk, plays when the last level (20) is won, and a click skips
//    it to the level's statistics, as on the desktop.
//
//   node scripts/prove_movies.mjs --url https://dungeonkeeper.tfrey7.com/ --dk "<Dungeon Keeper folder>" \
//        --debug-port <port> --work <scratch> --shots <folder> [--engine-from site]
//
// The Dungeon Keeper folder must hold the movies (GOG's LDATA has intromix, outromix and Drag).
// It is read where it is and never copied anywhere but the browser. --engine-from <dir> answers
// keeperfx.js, keeperfx.wasm and the page's modules (js/) from that folder, so a build can be
// tried on the live page before it lands. The Start button is pressed with a real mouse click:
// the browser lets a page start sound only after the player has used it, and the intro plays
// before the player touches the game.
// Exits 1 on the first thing not proved.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Browser } from "./cdp.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const url = new URL(arg("--url", "https://dungeonkeeper.tfrey7.com/"));
const dk = arg("--dk");
const work = path.resolve(arg("--work", "movies-work"));
const shots = path.resolve(arg("--shots", work));
const debugPort = Number(arg("--debug-port", "8812"));
const engineFrom = arg("--engine-from");
const only = arg("--only"); // "outro": skip the intro's part, to try the outro again quickly
if (!dk) throw new Error("--dk <your Dungeon Keeper folder> is required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

// --- input ------------------------------------------------------------------------------------

async function canvasPoint(b, x, y) {
  const r = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { left: r.left, top: r.top, sx: r.width / 640, sy: r.height / 480 }; })()`);
  return { x: r.left + x * r.sx, y: r.top + y * r.sy };
}

async function mouseClick(b, at, button = "left") {
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await sleep(200);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button, clickCount: 1 });
  await sleep(120);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button, clickCount: 1 });
}

const KEYS = { Enter: 13, Escape: 27, " ": 32 };
async function key(b, name, vk = KEYS[name]) {
  const params = { windowsVirtualKeyCode: vk, key: name, code: name === " " ? "Space" : name };
  await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
  await sleep(150);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await sleep(300);
}

// A key with Ctrl held, as the land view's cheat keys want.
async function ctrlKey(b, name, vk) {
  const ctrl = { windowsVirtualKeyCode: 17, key: "Control", code: "ControlLeft" };
  await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...ctrl, modifiers: 2 });
  await sleep(100);
  await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: vk, key: name, code: name, modifiers: 2 });
  await sleep(150);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, key: name, code: name, modifiers: 2 });
  await sleep(100);
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...ctrl });
}

async function shootCanvas(b, name) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  const bytes = Buffer.from(data, "base64");
  writeFileSync(path.join(shots, name), bytes);
  console.log("shot", name);
  return bytes;
}

// --- the engine's state, from its own log ------------------------------------------------------

const lastState = (b) => b.eval(`(document.getElementById("engine-log").textContent
  .match(/state change from \\d+ \\(\\w+\\) into \\d+ \\(\\w+\\)/g) || [""]).slice(-1)[0].replace(/.* into /, "")`);
const everState = (b, name) => b.eval(`document.getElementById("engine-log").textContent.includes("(${name})")`);

async function waitForState(b, name, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await lastState(b)).includes(name)) return;
    await sleep(100);
  }
  throw new Error(`the engine never entered ${name} (last: ${await lastState(b)})`);
}

// --- sound -------------------------------------------------------------------------------------

// Taps what the page sends to its speakers, as prove_speech.mjs does: window.__audioPeak(context)
// reads that context's loudest sample now. The movie's sound goes out through an SDL audio device,
// in SDL's own context, kfx.SDL3.audioContext.
const AUDIO_TAP = `(() => {
  const taps = new Map();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      let tap = taps.get(dest.context);
      if (!tap) { tap = dest.context.createAnalyser(); tap.fftSize = 2048; taps.set(dest.context, tap); }
      connect.call(this, tap);
    }
    return connect.call(this, dest, ...rest);
  };
  window.__audioPeak = (context) => {
    const tap = taps.get(context);
    if (!tap) return 0;
    const buf = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(buf);
    return buf.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0);
  };
})();`;

const sdlPeak = (b) => b.eval(`window.kfx?.SDL3?.audioContext ? window.__audioPeak(kfx.SDL3.audioContext) : 0`);

// Samples the sound every quarter second for `seconds`, shooting the canvas at the given moments.
async function listen(b, seconds, shotsAt, label) {
  const levels = [];
  const pictures = [];
  for (let i = 1; i <= seconds * 4; i++) {
    await sleep(250);
    levels.push(await sdlPeak(b));
    const shot = shotsAt.find((s) => s.at === i / 4);
    if (shot) pictures.push(await shootCanvas(b, shot.name));
  }
  writeFileSync(path.join(work, `${label}-levels.txt`),
    levels.map((v, i) => `${((i + 1) / 4).toFixed(2)}s ${v.toFixed(4)}`).join("\n") + "\n");
  return { peak: Math.max(...levels), heard: levels.filter((v) => v > 0.01).length / levels.length, pictures };
}

// --- the engine from a local folder (--engine-from) ------------------------------------------

async function serveEngine(b) {
  const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm" };
  await b.send("Fetch.enable", { patterns: [
    { urlPattern: `${url.origin}/keeperfx.js*`, requestStage: "Request" },
    { urlPattern: `${url.origin}/keeperfx.wasm*`, requestStage: "Request" },
    // The page's own modules too: the files page must know to keep the outro (manifest.js).
    { urlPattern: `${url.origin}/js/*`, requestStage: "Request" },
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

async function startEngine(b, query) {
  const opened = b.once("Page.loadEventFired");
  await b.eval(`location.href = new URL("engine.html${query}", location.href).href`);
  await opened;
  await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
    Number(arg("--data-timeout", "240000")));
}

// --- the run ---------------------------------------------------------------------------------

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(shots, { recursive: true });
const b = await Browser.launch({ profile: path.join(work, "profile"), port: debugPort, height: 1300 });
let failed = false;
try {
  if (engineFrom) await serveEngine(b);
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: AUDIO_TAP });

  // 0. The player's own files, movies included.
  await b.goto(url.href);
  await b.waitFor(`document.body.dataset.state === "ask"`, 30000);
  await b.setFiles("#pick-folder", [path.resolve(dk)]);
  await b.waitFor(`document.body.dataset.state === "ready"`, 120000);

  if (only !== "outro") {
    // 1. Start, with a real click, as a player does; the intro follows the splash screens.
    const start = await b.eval(`(() => { const r = document.getElementById("start").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const opened = b.once("Page.loadEventFired");
    await mouseClick(b, start);
    await opened;
    await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
      Number(arg("--data-timeout", "240000")));
    const kept = await b.eval(`["intromix", "outromix", "drag"].filter((m) => kfx.FS.analyzePath("/keeperfx/ldata/" + m + ".smk").exists)`);
    check(kept.includes("intromix") && kept.includes("outromix"), `the player's movies are in the game folder: ${kept.join(", ")}`);

    // The intro's sound is the first thing the game plays: no music before the main menu.
    const began = Date.now();
    while (Date.now() - began < 90000 && (await sdlPeak(b)) < 0.01 && !(await everState(b, "FeSt_MAIN_MENU"))) await sleep(100);
    check(!(await everState(b, "FeSt_MAIN_MENU")), "the intro was playing before the main menu");
    console.log(`intro sound began ${((Date.now() - began) / 1000).toFixed(1)} s after the engine started`);
    const intro = await listen(b, 12, [{ at: 4, name: "movie-intro-1.png" }, { at: 11, name: "movie-intro-2.png" }], "intro");
    const context = await b.eval(`kfx.SDL3.audioContext.state`);
    check(intro.peak > 0.05 && intro.heard > 0.5,
      `the intro's sound reached the speakers (peak ${intro.peak.toFixed(3)}, heard in ${Math.round(intro.heard * 100)}% of samples, SDL's context ${context})`);
    check(!intro.pictures[0].equals(intro.pictures[1]), "the intro's pictures moved on between the two screenshots");
    check(!(await everState(b, "FeSt_MAIN_MENU")), "still in the intro after 12 seconds of it");

    // Escape skips it, straight to the main menu.
    const pressed = Date.now();
    await key(b, "Escape");
    await waitForState(b, "FeSt_MAIN_MENU", 8000);
    check(true, `Escape skipped the intro: the main menu ${((Date.now() - pressed) / 1000).toFixed(1)} s later`);
    await sleep(2500);
    await shootCanvas(b, "movie-intro-skipped.png");
  }

  // 2. The last level, won with the cheat menu: the campaign's outro, which a click skips.
  // KeeperFX's -level switch would start level 20 directly, but it closes the game when the level
  // ends, so the campaign is advanced instead: on the land view, with cheats on, Ctrl+F10 moves
  // it on a level (front_landview.c), nineteen times, and its flag starts level 20.
  await startEngine(b, "?args=-alex%20-nointro");
  await waitForState(b, "FeSt_MAIN_MENU", 120000);
  await sleep(2500);
  await mouseClick(b, await canvasPoint(b, 320, 115)); // Start New Game
  await waitForState(b, "FeSt_LAND_VIEW", 30000);
  await sleep(6000); // the land view zooms in before it answers
  for (let i = 0; i < 19; i++) {
    await ctrlKey(b, "F10", 121);
    await sleep(1800); // each move reloads the map; a key pressed meanwhile is lost
  }
  await sleep(2000);
  await shootCanvas(b, "movie-land-level20.png");
  await mouseClick(b, await canvasPoint(b, 233, 160)); // level 20's flag, where the view settles
  await b.waitFor(`document.getElementById("engine-log").textContent.includes("Started level 20")`, 120000);
  await sleep(12000);
  // The tick under the mentor's briefing closes it; F12 opens the cheat menu where the pointer is,
  // and its "Win level" line answers a left click.
  await mouseClick(b, await canvasPoint(b, 182, 460));
  await sleep(1000);
  await key(b, "F12", 123);
  await sleep(1500);
  await mouseClick(b, await canvasPoint(b, 160, 450));
  await sleep(3000);
  await shootCanvas(b, "movie-level20-won.png");
  // "Success!": the level ends when the player carries on (Space), and the outro comes first.
  let outro = false;
  for (let i = 0; i < 20 && !outro; i++) {
    await key(b, " ");
    await sleep(1500);
    outro = await everState(b, "FeSt_OUTRO");
  }
  check(outro, `winning the last level led to the outro (last state: ${await lastState(b)})`);
  await sleep(1500);
  const ending = await listen(b, 10, [{ at: 3, name: "movie-outro-1.png" }, { at: 9, name: "movie-outro-2.png" }], "outro");
  check(ending.peak > 0.05, `the outro's sound reached the speakers (peak ${ending.peak.toFixed(3)})`);
  check(!ending.pictures[0].equals(ending.pictures[1]), "the outro's pictures moved on between the two screenshots");
  check((await lastState(b)).includes("FeSt_OUTRO"), "still in the outro after 10 seconds of it");

  const clicked = Date.now();
  await mouseClick(b, await canvasPoint(b, 320, 240));
  await waitForState(b, "FeSt_LEVEL_STATS", 8000);
  check(true, `a click skipped the outro to the statistics ${((Date.now() - clicked) / 1000).toFixed(1)} s later`);
  await sleep(2000);
  await shootCanvas(b, "movie-outro-skipped.png");
  const errors = (await b.eval(`document.getElementById("engine-log").textContent`))
    .split("\n").filter((l) => /smacker|play_smk|Movies are not|Error playing/i.test(l));
  check(errors.length === 0, `the engine logged no movie error${errors.length ? ": " + errors.join(" | ") : ""}`);
} catch (err) {
  failed = true;
  console.log(err.message);
} finally {
  writeFileSync(path.join(work, "console.txt"), b.console.join("\n") + "\n");
  await b.close();
}
console.log(failed ? "FAIL" : "all proved");
process.exit(failed ? 1 : 0);
