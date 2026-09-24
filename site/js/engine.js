// Starts the real KeeperFX engine (keeperfx.js + keeperfx.wasm, built by scripts/build_wasm.py).
//
// The engine runs in the game directory ROOT, with the player's kept files linked in by
// storage.js, exactly as the files page leaves them. KeeperFX writes its log to a file,
// ROOT/keeperfx.log, flushing every line; this page mirrors each new line to the console and
// the page, so the engine's own startup log can be read even when it stops for want of files.

import { ROOT, mountStore } from "./storage.js";

const LOG_FILE = `${ROOT}/keeperfx.log`;
const status = document.getElementById("engine-status");
const logView = document.getElementById("engine-log");

function show(line, isError = false) {
  (isError ? console.error : console.log)(line);
  logView.append(`${line}\n`);
}

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
}

// Mirrors whatever the engine has appended to its log since the last look.
let logRead = 0;
function mirrorLog(FS) {
  if (!FS.analyzePath(LOG_FILE).exists) return;
  const bytes = FS.readFile(LOG_FILE);
  if (bytes.length < logRead) logRead = 0; // the engine started a fresh log
  if (bytes.length === logRead) return;
  const text = new TextDecoder().decode(bytes.subarray(logRead));
  logRead = bytes.length;
  for (const line of text.split("\n")) {
    if (line.trim()) show(`[keeperfx.log] ${line.trimEnd()}`);
  }
}

let engine;
try {
  engine = await KeeperFX({
    canvas: document.getElementById("canvas"),
    print: (line) => show(line),
    printErr: (line) => show(line, true),
    onExit: (code) => {
      mirrorLog(engine.FS);
      setStatus(`The engine stopped (exit code ${code}). Its log is below.`, code ? "bad" : "");
    },
    onAbort: (what) => {
      mirrorLog(engine.FS);
      setStatus(`The engine aborted: ${what}`, "bad");
    },
  });
} catch (err) {
  setStatus(`The engine failed to load: ${err}`, "bad");
  throw err;
}
window.kfx = engine; // for the proof driver and for anyone debugging in the console

const kept = await mountStore(engine.FS);
engine.FS.chdir(ROOT);
show(`page: ${kept.length} of the player's files are linked into ${ROOT}; starting main()`);
setStatus("The engine is running.", "good");

const timer = setInterval(() => mirrorLog(engine.FS), 100);
try {
  // With Asyncify, callMain returns at the engine's first yield; main carries on after it.
  engine.callMain([]);
} catch (err) {
  // exit() arrives here as an ExitStatus; onExit has already reported it.
  if (err?.name !== "ExitStatus") {
    setStatus(`The engine threw: ${err}`, "bad");
    show(String(err?.stack ?? err), true);
  }
} finally {
  mirrorLog(engine.FS);
}
window.addEventListener("pagehide", () => clearInterval(timer));
