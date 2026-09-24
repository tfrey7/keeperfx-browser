// Starts the real KeeperFX engine (keeperfx.js + keeperfx.wasm, built by scripts/build_wasm.py).
//
// The engine runs in the game directory ROOT, with the player's kept files linked in by
// storage.js, exactly as the files page leaves them, and its save folder (saved games and
// settings) kept in this browser by storage.js too. KeeperFX writes its log to a file,
// ROOT/keeperfx.log, flushing every line; this page mirrors each new line to the console and
// the page, so the engine's own startup log can be read even when it stops for want of files.

import { ROOT, SAVES, mountStore, mountSaves, persistSaves } from "./storage.js";
import { loadKfxData } from "./kfxdata.js";
import { endedMessage, setUpView, showEnded } from "./view.js";

const LOG_FILE = `${ROOT}/keeperfx.log`;
const status = document.getElementById("engine-status");
const logView = document.getElementById("engine-log");

setUpView({
  stage: document.getElementById("stage"),
  canvas: document.getElementById("canvas"),
  fullscreenButton: document.getElementById("fullscreen"),
  logButton: document.getElementById("toggle-log"),
  logPanel: document.getElementById("log-panel"),
});

function show(line, isError = false) {
  (isError ? console.error : console.log)(line);
  // Follows the newest line unless the reader has scrolled back up the log.
  const atEnd = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 4;
  logView.append(`${line}\n`);
  if (atEnd) logView.scrollTop = logView.scrollHeight;
}

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
  // When the engine fails, its log is the explanation: open the drawer.
  if (kind === "bad" && document.getElementById("log-panel").hidden) {
    document.getElementById("toggle-log").click();
  }
}

function persist() {
  persistSaves(engine.FS).catch((err) => show(`page: saves not kept: ${err}`, true));
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
    // main has returned: the player quit from the main menu (code 0), or the engine gave up.
    onExit: (code) => {
      mirrorLog(engine.FS);
      persist();
      const { text, kind } = endedMessage(code);
      setStatus(text, kind);
      showEnded({
        notice: document.getElementById("ended"),
        text: document.getElementById("ended-text"),
        restartButton: document.getElementById("restart"),
      }, text);
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

const MB = 2 ** 20;
let loadedData;
try {
  loadedData = await loadKfxData(engine.FS, ROOT, (done, total) =>
    setStatus(`Loading KeeperFX's data: ${Math.round(done / MB)} of ${Math.round(total / MB)} MB…`));
} catch (err) {
  setStatus(`KeeperFX's data failed to load: ${err.message}`, "bad");
  throw err;
}
show(loadedData === null
  ? "page: this server has no KeeperFX data (scripts/serve.py --kfx-data); the engine will stop at its config"
  : `page: ${loadedData} KeeperFX data files loaded into ${ROOT}`);
const kept = await mountStore(engine.FS);
const saves = await mountSaves(engine.FS);
engine.FS.chdir(ROOT);
show(`page: ${kept.length} of the player's files are linked into ${ROOT}`);
show(`page: ${saves.length} saved game(s) kept in this browser, in ${SAVES}; starting main()`);
// Each save is written back as the engine closes it (autoPersist); this catches anything else.
document.addEventListener("visibilitychange", () => document.hidden && persist());
window.addEventListener("pagehide", persist);
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
