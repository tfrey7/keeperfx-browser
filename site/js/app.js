// The game-files page: ask for the player's Dungeon Keeper folder (or a .zip of it), check it
// against the manifest, keep it in this browser, and show what the engine will see.
// Nothing here sends a byte anywhere: files go from the picker into IndexedDB and no further.

import { REQUIRED, OPTIONAL, matchFiles } from "./manifest.js";
import { listZip, readZipEntry } from "./unzip.js";
import { ROOT, mountStore, keepFiles, forgetFiles, countSaves, forgetSaves } from "./storage.js";

const $ = (id) => document.getElementById(id);
const panels = ["loading", "ask", "missing", "ready", "forget-ask"];

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

// "3 saved games and your settings", or "" when nothing is kept.
function describeSaves({ games, settings }) {
  const parts = [];
  if (games) parts.push(`${games} saved game${games === 1 ? "" : "s"}`);
  if (settings) parts.push("your settings");
  return parts.join(" and ");
}

async function showSaves() {
  const kept = describeSaves(await countSaves());
  $("saves-status").textContent = kept ? `Also kept in this browser, from playing: ${kept}.` : "";
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
  showSaves();
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

// Forgets the player's files, and their saves and settings too when clearSaves.
async function forget(clearSaves) {
  progress("Forgetting your files…");
  await forgetFiles(FS);
  if (clearSaves) {
    try {
      await forgetSaves();
    } catch (err) {
      showMissing([], `Your files are forgotten, but not your saves yet: ${err.message}.`);
      return;
    }
  }
  show("ask");
}

// With saves or settings kept, ask whether they go too; with none, just forget the files.
$("forget").addEventListener("click", async () => {
  const kept = describeSaves(await countSaves());
  if (!kept) {
    await forget(false);
    return;
  }
  $("forget-saves-status").textContent =
    `This browser also keeps ${kept} from playing. Keep them for next time, or clear them too?`;
  show("forget-ask");
});
$("forget-keep").addEventListener("click", () => forget(false));
$("forget-all").addEventListener("click", () => forget(true));
$("forget-cancel").addEventListener("click", () => show("ready"));

showStored(await mountStore(FS));
