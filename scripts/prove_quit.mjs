// Proves that quitting from KeeperFX's main menu ends the game the way a player expects, in a
// real headless Chrome against the page as served, with a real Dungeon Keeper copy: main menu,
// Quit, tick; then the page says the game has closed and offers Play again, which goes straight
// back to the main menu. Screenshots and the page console go to --shots.
//
//   py -3.10 scripts/serve.py --port <port> --kfx-data <folder from scripts/gamedata.py>
//   node scripts/prove_quit.mjs --url http://localhost:<port>/ --dk "<Dungeon Keeper folder>" \
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

// Waits for a line in the engine's own log, mirrored to the page console.
async function waitForLog(b, text, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (b.console.some((l) => l.startsWith("[keeperfx.log]") && l.includes(text))) return;
    if (await b.eval(`/stopped|aborted|threw|failed/.test(document.getElementById("engine-status").textContent)`)) break;
    await sleep(250);
  }
  throw new Error(`the engine never logged "${text}"`);
}

// Clicks the canvas at (x, y) in its own 640x480 pixels, as a mouse would.
async function clickCanvas(b, x, y) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { left: r.left, top: r.top, sx: r.width / 640, sy: r.height / 480 }; })()`);
  const at = { x: box.left + x * box.sx, y: box.top + y * box.sy };
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await sleep(300);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await sleep(120);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
}

// Screenshots just the canvas, as the browser shows it (the engine presents through WebGL, so
// the page itself cannot read its pixels back). Returns the PNG bytes.
async function shootCanvas(b, file) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  const png = Buffer.from(data, "base64");
  writeFileSync(file, png);
  return png;
}

rmSync(work, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const b = await Browser.launch({ profile: path.join(work, "quit-profile"), port: debugPort, height: 900 });
const statusText = () => b.eval(`document.getElementById("engine-status").textContent`);
const toMenu = async () => {
  await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
    Number(arg("--data-timeout", "120000")));
  await waitForLog(b, "into 1 (FeSt_MAIN_MENU)", Number(arg("--menu-timeout", "90000")));
  await sleep(2500); // the menu fades in
};
try {
  // 1. The player's files, then the engine's main menu.
  await b.goto(url);
  await b.waitFor(`document.body.dataset.state === "ask"`);
  await b.setFiles("#pick-folder", [path.resolve(dk)]);
  await b.waitFor(`document.body.dataset.state === "ready"`, 60000);
  const opened = b.once("Page.loadEventFired");
  await b.eval(`document.getElementById("start").click()`);
  await opened;
  await toMenu();
  await shootCanvas(b, path.join(shots, "quit-1-menu.png"));
  check(true, "the engine reached its main menu");

  // 2. Quit, then the tick.
  const [qx, qy] = arg("--quit", "320,437").split(",").map(Number);
  await clickCanvas(b, qx, qy);
  await sleep(700);
  // The whole page: once the engine lets go, SDL may leave the canvas with no size at all.
  await b.screenshot(path.join(shots, "quit-2-confirm.png"));
  // Where the engine asks first, the tick confirms; where it quits at once, there is none.
  if (!b.console.some((l) => l.includes("into 9 (FeSt_QUIT_GAME)"))) {
    const [tx, ty] = arg("--tick", "280,260").split(",").map(Number);
    await clickCanvas(b, tx, ty);
  }
  await waitForLog(b, "into 9 (FeSt_QUIT_GAME)", 10000);
  check(true, "Quit left the engine's main menu (FeSt_QUIT_GAME)");

  // 3. The page hears that the engine ended and says so over the canvas.
  await b.waitFor(`!document.getElementById("ended").hidden`, 20000);
  await sleep(500);
  await b.screenshot(path.join(shots, "quit-3-closed.png"));
  const said = await statusText();
  check(!/running/.test(said), `the page no longer says the engine is running: "${said}"`);
  check(await b.eval(`document.getElementById("ended-text").textContent === "The game has closed."`),
    "the notice says the game has closed");

  // 4. Play again goes straight back to the main menu, with the files kept.
  b.console.length = 0;
  const again = b.once("Page.loadEventFired");
  await b.eval(`document.getElementById("restart").click()`);
  await again;
  await toMenu();
  await b.screenshot(path.join(shots, "quit-4-again.png"));
  check(true, "Play again started the engine again, back at the main menu");
} finally {
  writeFileSync(path.join(shots, "quit-console.txt"), b.console.join("\n") + "\n");
  await b.close();
}
console.log("all proved");
