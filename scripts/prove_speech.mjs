// Proves the mentor speaks in a real headless Chrome, against the page as served: from the main
// menu, Start New Game opens the land view, and resting the pointer on Eversmile plays level 1's
// briefing, campgns/keeporig_eng/good01.mp3, through SDL_mixer. The engine must load and play it
// (no "Cannot load"/"Cannot play" from play_streamed_sample) and the mixer's output must carry
// it; the music is taken away first so the briefing is all the mixer plays. A click on Eversmile
// then starts the level. Screenshots, the audio levels and the page console go to --shots.
//
//   py -3.10 scripts/serve.py --port <port> --kfx-data <folder from scripts/gamedata.py>
//   node scripts/prove_speech.mjs --url http://localhost:<port>/ --dk "<Dungeon Keeper folder>" \
//        --debug-port <another port> --work <scratch dir> --shots docs/proof
//
// The Dungeon Keeper folder is read where it is and never copied anywhere but the browser.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Browser } from "./cdp.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const url = arg("--url", "http://localhost:8850/");
const dk = arg("--dk");
const work = path.resolve(arg("--work", "proof-work"));
const shots = path.resolve(arg("--shots", "docs/proof"));
const debugPort = Number(arg("--debug-port", "8851"));
if (!dk) throw new Error("--dk <your Dungeon Keeper folder> is required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

const engineLog = (b) => b.console.filter((l) => l.startsWith("[keeperfx.log]"));

async function waitForLog(b, text, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (engineLog(b).some((l) => l.includes(text))) return;
    await sleep(250);
  }
  throw new Error(`the engine never logged "${text}"`);
}

// Clicks the canvas at (x, y) in its own 640x480 pixels, as a mouse would.
async function pointAt(b, x, y) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { left: r.left, top: r.top, sx: r.width / 640, sy: r.height / 480 }; })()`);
  const at = { x: box.left + x * box.sx, y: box.top + y * box.sy };
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  return at;
}

async function clickCanvas(b, x, y) {
  const at = await pointAt(b, x, y);
  await sleep(300);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await sleep(120);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
}

async function shootCanvas(b, file) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  writeFileSync(file, Buffer.from(data, "base64"));
}

// Taps what the page sends to its speakers: each node connected to a destination is also
// connected to an analyser, and window.__audioPeak(context) reads that context's loudest sample
// now. SDL_mixer (music and speech) plays through SDL's own context, kfx.SDL3.audioContext; the
// effects go through OpenAL's.
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

rmSync(work, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const b = await Browser.launch({ profile: path.join(work, "speech-profile"), port: debugPort, height: 1300 });
const levels = [];
try {
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: AUDIO_TAP });

  // 1. The player's own files, then the engine page.
  await b.goto(url);
  await b.waitFor(`document.body.dataset.state === "ask"`);
  await b.setFiles("#pick-folder", [path.resolve(dk)]);
  await b.waitFor(`document.body.dataset.state === "ready"`, 60000);
  const opened = b.once("Page.loadEventFired");
  await b.eval(`document.getElementById("start").click()`);
  await opened;
  await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
    Number(arg("--data-timeout", "120000")));
  // No music, so what reaches the speakers in the level is the briefing: the page's links to the
  // music go (the kept files themselves stay), and the engine carries on without its tracks.
  await b.eval(`(() => { const dir = "/keeperfx/music";
    for (const f of kfx.FS.readdir(dir)) if (f.endsWith(".ogg")) kfx.FS.unlink(dir + "/" + f); })()`);
  await waitForLog(b, "into 1 (FeSt_MAIN_MENU)", 90000);
  await sleep(2500);
  check(true, "the engine reached its main menu");

  // 2. Start New Game opens the land view; the pointer on Eversmile plays its briefing.
  await clickCanvas(b, 320, 115);
  await waitForLog(b, "(FeSt_LAND_VIEW)", 30000);
  await sleep(4000); // the land view zooms in before its lands answer the pointer
  await pointAt(b, 318, 208);
  await waitForLog(b, "good01.mp3", 30000);

  // 3. The briefing: loaded and played, and SDL_mixer's output sampled for 8 seconds.
  for (let i = 0; i < 32; i++) {
    await sleep(250);
    levels.push(await b.eval(`window.__audioPeak(kfx.SDL3.audioContext)`));
  }
  await shootCanvas(b, path.join(shots, "speech-landview.png"));
  const failed = engineLog(b).filter((l) => /Cannot (load|play) .*good01\.mp3/.test(l));
  check(failed.length === 0, `the engine loaded and played good01.mp3${failed.length ? ": " + failed[0] : ""}`);
  const peak = Math.max(...levels);
  check(peak > 0.01, `the mixer sent the briefing to the speakers, with no music playing (peak ${peak.toFixed(3)})`);

  // 4. A click on Eversmile starts level 1.
  await clickCanvas(b, 318, 208);
  await waitForLog(b, "into 7 (FeSt_START_KPRLEVEL)", 30000);
  check(true, "Eversmile started level 1");
} finally {
  writeFileSync(path.join(shots, "speech-console.txt"), b.console.join("\n") + "\n");
  writeFileSync(path.join(shots, "speech-levels.txt"),
    levels.map((v, i) => `${((i + 1) * 0.25).toFixed(2)}s ${v.toFixed(4)}`).join("\n") + "\n");
  console.log(engineLog(b).filter((l) => /mp3|speech|streamed|Error/i.test(l)).slice(-20).join("\n"));
  await b.close();
}
console.log("all proved");
