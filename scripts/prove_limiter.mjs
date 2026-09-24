// Proves that a big fight's sound effects stay under full scale: plays job 232's fight and meters
// what each of the page's audio contexts sends to the speakers.
//
//   node scripts/prove_limiter.mjs --url https://dungeonkeeper.tfrey7.com/ --dk "<Dungeon Keeper folder>" \
//        --debug-port <port> --work <scratch> --shots <folder> [--page-from site]
//
// --page-from <dir> answers the page's js/engine.js and js/limiter.js from that folder, so the
// limiter is tried on the live page before it lands; without it the live page is measured as it is.
// It starts level 3 with the cheat switch, makes 12 trolls and 8 bile demons for the keeper and 12
// knights and 12 wizards against them at the heart, and meters both contexts for 25 s: the peak,
// the samples over full scale and the 25 ms windows whose peak is over 1.0. OpenAL's context
// (the effects) is told from SDL's (the music) by who made it. Exits 1 if the effects went over.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Browser } from "./cdp.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const url = new URL(arg("--url", "https://dungeonkeeper.tfrey7.com/"));
const dk = arg("--dk");
const work = path.resolve(arg("--work", "limiter-work"));
const shots = path.resolve(arg("--shots", work));
const debugPort = Number(arg("--debug-port", "8812"));
const pageFrom = arg("--page-from");
const seconds = Number(arg("--seconds", "25"));
if (!dk) throw new Error("--dk <your Dungeon Keeper folder> is required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function canvasPoint(b, x, y) {
  const r = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { left: r.left, top: r.top, sx: r.width / 640, sy: r.height / 480 }; })()`);
  return { x: r.left + x * r.sx, y: r.top + y * r.sy };
}

async function key(b, name) {
  const params = { windowsVirtualKeyCode: 13, key: name, code: name };
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

// The meter, in the page before anything else: whatever connects to a context's destination is
// also fed to a ScriptProcessor that keeps that context's peak and counts. It wraps the browser's
// own connect, so with the limiter in place it hears the limiter's output, which is what is sent.
const METER = `
  window.kfxMeters = [];
  const Base = window.AudioContext;
  window.AudioContext = class extends Base {
    constructor(...a) {
      super(...a);
      const m = { who: /alc/i.test(new Error().stack) ? "effects (OpenAL)" : "music (SDL)",
        rate: this.sampleRate, peak: 0, over: 0, windows: 0, windowsOver: 0, win: 0, winPeak: 0, on: false };
      const tap = this.createScriptProcessor(1024, 2, 2);
      const winSize = Math.round(this.sampleRate * 0.025);
      tap.onaudioprocess = (e) => {
        if (!m.on) return;
        for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) {
          const d = e.inputBuffer.getChannelData(c);
          for (let i = 0; i < d.length; i++) {
            const a = Math.abs(d[i]);
            if (a > m.peak) m.peak = a;
            if (a > 1) m.over++;
          }
        }
        const d = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < d.length; i++) {
          const a = Math.max(Math.abs(d[i]), Math.abs(e.inputBuffer.getChannelData(e.inputBuffer.numberOfChannels - 1)[i]));
          if (a > m.winPeak) m.winPeak = a;
          if (++m.win === winSize) { m.windows++; if (m.winPeak > 1) m.windowsOver++; m.win = 0; m.winPeak = 0; }
        }
      };
      const mute = this.createGain();
      mute.gain.value = 0;
      m.tap = tap;
      kfxMeters.push(m);
      connect.call(tap, mute);
      connect.call(mute, this.destination);
    }
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    if (target instanceof AudioDestinationNode) {
      const m = kfxMeters.find((x) => x.tap.context === target.context);
      if (m && this !== m.tap) connect.call(this, m.tap);
    }
    return connect.call(this, target, ...rest);
  };`;

async function servePage(b) {
  await b.send("Fetch.enable", { patterns: [
    { urlPattern: `${url.origin}/js/engine.js`, requestStage: "Request" },
    { urlPattern: `${url.origin}/js/limiter.js`, requestStage: "Request" },
  ] });
  b.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const rel = new URL(request.url).pathname.slice(1);
    await b.send("Fetch.fulfillRequest", {
      requestId, responseCode: 200, body: readFileSync(path.join(path.resolve(pageFrom), rel)).toString("base64"),
      responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }],
    });
  });
  console.log(`page scripts from ${pageFrom}`);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(shots, { recursive: true });
const b = await Browser.launch({ profile: path.join(work, "profile"), port: debugPort, height: 1300 });
let failed = true;
try {
  if (pageFrom) await servePage(b);
  await b.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: METER });

  await b.goto(url.href);
  await b.waitFor(`document.body.dataset.state === "ask"`, 30000);
  await b.setFiles("#pick-folder", [path.resolve(dk)]);
  await b.waitFor(`document.body.dataset.state === "ready"`, 60000);
  const opened = b.once("Page.loadEventFired");
  await b.eval(`location.href = new URL("engine.html?args=-alex -level 3", location.href).href`);
  await opened;
  await b.send("Page.bringToFront");
  await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
    Number(arg("--data-timeout", "240000")));
  await b.waitFor(`document.getElementById("engine-log").textContent.includes("Started level 3")`, 180000);
  await sleep(12000);
  // A click on the view counts as the gesture browsers want before they play sound.
  const at = await canvasPoint(b, 320, 250);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await sleep(300);
  console.log("audio contexts:", JSON.stringify(await b.eval(`kfxMeters.map((m) => m.who + " " + m.tap.context.state)`)));

  // The fight at the heart, where level 3's view opens: the keeper's side, then the heroes.
  await command(b, "create.creature TROLL 4 12");
  await command(b, "create.creature BILE_DEMON 4 8");
  await command(b, "create.creature KNIGHT 4 12 PLAYER_GOOD");
  await command(b, "create.creature WIZARD 4 12 PLAYER_GOOD");
  await b.eval(`kfxMeters.forEach((m) => { m.on = true; })`);
  await sleep(seconds * 500);
  await shootCanvas(b, path.join(shots, pageFrom ? "fight-limited.png" : "fight-live.png"));
  await sleep(seconds * 500);
  const meters = await b.eval(`kfxMeters.map(({ who, rate, peak, over, windows, windowsOver }) =>
    ({ who, rate, peak: +peak.toFixed(3), over, windows, windowsOver }))`);
  for (const m of meters) {
    console.log(`${m.who}: peak ${m.peak}, ${m.over} samples over full scale, ` +
      `${m.windowsOver} of ${m.windows} 25 ms windows over 1.0`);
  }
  const effects = meters.find((m) => m.who.startsWith("effects"));
  failed = !effects || effects.windows === 0 || effects.over > 0;
  console.log(failed ? "FAIL" : "OK");
} finally {
  writeFileSync(path.join(work, "console.txt"), b.console.join("\n") + "\n");
  await b.close();
}
process.exit(failed ? 1 : 0);
