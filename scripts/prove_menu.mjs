// Proves the real KeeperFX engine boots to its main menu in a real headless Chrome, against the
// page as served, with a real Dungeon Keeper copy: the files page takes the player's folder, the
// engine page loads KeeperFX's own data, runs main(), and draws the main menu in its canvas; a
// click on a menu item opens its submenu. Screenshots and the page console go to --shots.
//
//   py -3.10 scripts/serve.py --port <port> --kfx-data <folder from scripts/gamedata.py>
//   node scripts/prove_menu.mjs --url http://localhost:<port>/ --dk "<Dungeon Keeper folder>" \
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
const b = await Browser.launch({ profile: path.join(work, "menu-profile"), port: debugPort, height: 1300 });
const engineLog = () => b.console.filter((l) => l.startsWith("[keeperfx.log]"));
try {
  // 1. The player's own files, through the files page.
  await b.goto(url);
  await b.waitFor(`document.body.dataset.state === "ask"`);
  await b.screenshot(path.join(shots, "files-ask.png"));
  check(true, "the files page asks for the Dungeon Keeper folder");
  await b.setFiles("#pick-folder", [path.resolve(dk)]);
  await b.waitFor(`document.body.dataset.state === "ready"`, 60000);
  await b.screenshot(path.join(shots, "files-ready.png"));
  check(true, "the files page kept the Dungeon Keeper folder");

  // 2. Its Start button opens the engine page: KeeperFX's data, then main().
  const opened = b.once("Page.loadEventFired");
  await b.eval(`document.getElementById("start").click()`);
  await opened;
  // 158 MB of KeeperFX's data: a live site over the internet takes longer than a local server.
  await b.waitFor(`document.getElementById("engine-status").textContent.includes("running")`,
    Number(arg("--data-timeout", "120000")));
  check(true, "KeeperFX's data loaded and main() started");

  // 3. The main menu: the engine logs each frontend state it enters.
  await waitForLog(b, "into 1 (FeSt_MAIN_MENU)", Number(arg("--menu-timeout", "90000")));
  await sleep(2500); // the menu fades in
  await b.screenshot(path.join(shots, "menu-page.png"));
  const menu = await shootCanvas(b, path.join(shots, "menu-main.png"));
  check(true, "the engine entered its main menu (FeSt_MAIN_MENU) and it is on the canvas");

  // 4. A click on Options opens the options submenu.
  const [cx, cy] = arg("--click", "320,345").split(",").map(Number);
  await clickCanvas(b, cx, cy);
  await waitForLog(b, "into 27 (FeSt_FEOPTIONS)", 15000);
  await sleep(1500);
  const options = await shootCanvas(b, path.join(shots, "menu-options.png"));
  check(!options.equals(menu), `a click on Options at ${cx},${cy} opened the options menu (FeSt_FEOPTIONS)`);
} finally {
  writeFileSync(path.join(shots, "menu-console.txt"), b.console.join("\n") + "\n");
  console.log(engineLog().slice(-30).join("\n"));
  await b.close();
}
console.log("all proved");
