// The game-files page: ask for the player's Dungeon Keeper folder (or a .zip of it), check it
// against the manifest, keep it in this browser, and show what the engine will see.
// Nothing here sends a byte anywhere: files go from the picker into IndexedDB and no further.

import { REQUIRED, OPTIONAL, matchFiles } from "./manifest.js";
import { listZip, readZipEntry } from "./unzip.js";
import { ROOT, mountStore, keepFiles, forgetFiles } from "./storage.js";

const $ = (id) => document.getElementById(id);
const panels = ["loading", "ask", "missing", "ready"];

function show(panel) {
  for (const p of panels) $(p).hidden = p !== panel;
  document.body.dataset.state = panel;
}

function fillList(list, names, cls) {
  list.replaceChildren(...names.map((name) => {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = name;
    return li;
  }));
}

function progress(text) {
  $("loading").querySelector(".progress").textContent = text;
  show("loading");
}

// The reader prints through Module.print; collect it while list_game_files runs.
let printed = [];
const reader = await createReader({ print: (line) => printed.push(line), printErr: console.error });
const FS = reader.FS;

function engineView() {
  printed = [];
  reader.ccall("list_game_files", "number", ["string"], [ROOT]);
  return printed.join("\n");
}

function showStored(stored) {
  if (!REQUIRED.every((name) => stored.includes(name))) {
    show("ask");
    return;
  }
  const extras = OPTIONAL.filter((name) => stored.includes(name)).length;
  $("ready-status").textContent =
    `All ${REQUIRED.length} required files are kept in this browser, and ${extras} of ${OPTIONAL.length} optional extras (music, palettes and movies).`;
  fillList($("ready-list"), stored, "found");
  $("engine-view").textContent = engineView();
  show("ready");
}

function showMissing(missing, problem = "") {
  $("missing-status").textContent = problem || `${missing.length} of ${REQUIRED.length} required files are missing.`;
  $("missing-lead").textContent = problem ? "Nothing was kept." : "That folder is missing these files, so nothing was kept:";
  fillList($("missing-list"), missing, "missing");
  show("missing");
}

// paths: the player's relative paths; read(path) gives that file's bytes.
async function take(paths, read) {
  const { found, missing } = matchFiles(paths);
  if (missing.length) {
    showMissing(missing);
    return;
  }
  const sources = new Map([...found].map(([name, path]) => [name, () => read(path)]));
  progress("Keeping your files in this browser…");
  const stored = await keepFiles(FS, sources, (done, total) => progress(`Keeping your files in this browser… ${done} of ${total}`));
  showStored(stored);
}

$("pick-folder").addEventListener("change", async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = "";
  const byPath = new Map(files.map((f) => [f.webkitRelativePath || f.name, f]));
  await take([...byPath.keys()], async (path) => new Uint8Array(await byPath.get(path).arrayBuffer()));
});

$("pick-zip").addEventListener("change", async (ev) => {
  const zip = ev.target.files[0];
  ev.target.value = "";
  if (!zip) return;
  try {
    progress("Reading the .zip…");
    const entries = new Map((await listZip(zip)).map((e) => [e.name, e]));
    await take([...entries.keys()], (path) => readZipEntry(zip, entries.get(path)));
  } catch (err) {
    showMissing([], err.message);
  }
});

$("try-again").addEventListener("click", () => show("ask"));

$("forget").addEventListener("click", async () => {
  progress("Forgetting your files…");
  await forgetFiles(FS);
  show("ask");
});

showStored(await mountStore(FS));
