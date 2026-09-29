// Waits on what the game itself shows, rather than on a fixed number of seconds: a line in the
// engine's own log (which the page mirrors into #engine-log), or the canvas coming to rest once a
// fade, a zoom or a level's opening is over. Every wait has a hard timeout and fails saying what
// it was waiting for, so a proof that stalls says where.
//
// Used by the proof scripts (prove_*.mjs, measure_fps.mjs) with a Browser from cdp.mjs.

// The whole of the engine's log so far, as the page shows it.
export const engineLog = (b) => b.eval(`document.getElementById("engine-log").textContent`);

// The frontend state the engine is in now, from its last "state change from .. into N (FeSt_X)".
export const lastState = (b) => b.eval(`(document.getElementById("engine-log").textContent
  .match(/state change from \\d+ \\(\\w+\\) into \\d+ \\(\\w+\\)/g) || [""]).slice(-1)[0].replace(/.* into /, "")`);

// Resolves when the engine's log next grows (the page appends each new line to it), or after ms,
// whichever comes first: woken by the page itself, through a MutationObserver, not by polling.
const logGrows = (b, ms) => b.eval(`new Promise((done) => {
  const watch = new MutationObserver(() => { watch.disconnect(); clearTimeout(timer); done(); });
  watch.observe(document.getElementById("engine-log"), { childList: true, characterData: true, subtree: true });
  const timer = setTimeout(() => { watch.disconnect(); done(); }, ${Math.max(1, Math.round(ms))});
})`);

// Resolves once ready() holds, looking again each time the engine logs a line.
async function untilLogged(b, ready, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= end) break;
    await logGrows(b, end - Date.now());
  }
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what} (last state: ${await lastState(b) || "none"})`);
}

// Resolves once the engine's log holds `text`. Fails after timeoutMs naming `what`.
export const waitForLog = (b, text, timeoutMs, what = `the engine to log "${text}"`) =>
  untilLogged(b, () => b.eval(`document.getElementById("engine-log").textContent.includes(${JSON.stringify(text)})`),
    timeoutMs, what);

// Resolves once the engine is in frontend state `name` (FeSt_LAND_VIEW, FeSt_INITIAL, ...).
export const waitForState = (b, name, timeoutMs) =>
  untilLogged(b, async () => (await lastState(b)).includes(name), timeoutMs, `the engine to enter ${name}`);

// A small picture of the canvas, as the browser shows it: `size` cells across, each cell the
// average colour of its part of the canvas, read back as numbers. WebGL keeps no readable copy of
// what it drew, so the picture is the browser's own screenshot, shrunk as it is taken.
async function thumbnail(b, size) {
  const box = await b.eval(`(() => { const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: size / box.width } });
  return b.eval(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), (c) => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const g = new OffscreenCanvas(img.width, img.height).getContext("2d");
    g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(0, 0, img.width, img.height).data.filter((_, i) => i % 4 !== 3));
  })()`);
}

// Resolves once the canvas has come to rest: several small pictures of it in a row differ by less
// than `tolerance` (average change of a colour, 0-255) and it is not black. A fade, the land view's
// zoom and a level's opening all move the whole picture; a torch flickering or an imp walking moves
// too little of it to count. Fails after timeoutMs naming `what`.
export async function waitForStill(b, what, { timeoutMs = 20000, tolerance = 2, calm = 3, every = 150, size = 32 } = {}) {
  const end = Date.now() + timeoutMs;
  let last = null;
  let still = 0;
  let change = Infinity;
  while (Date.now() < end) {
    const now = await thumbnail(b, size);
    const light = now.reduce((sum, v) => sum + v, 0) / now.length;
    if (last) {
      change = now.reduce((sum, v, i) => sum + Math.abs(v - last[i]), 0) / now.length;
      still = change < tolerance && light > 8 ? still + 1 : 0;
      if (still >= calm) return;
    }
    last = now;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what} (the canvas still changing by ${change.toFixed(1)} a colour)`);
}

// Resolves once a level the engine has just started or loaded is on screen and playing: it logs
// "Level load timing" when the level is ready, then flashes and fades the view in over about two
// seconds. In play the whole view pulses gently (about 5 a colour between pictures), so a level
// counts as settled below 10, where the opening moved it by 20 to 120.
export async function waitForLevel(b, what, timeoutMs = 120000) {
  await waitForLog(b, "Level load timing", timeoutMs, `${what}: the engine to finish loading the level`);
  await waitForStill(b, `${what}: the level's opening to finish`, { tolerance: 10, calm: 5 });
}
