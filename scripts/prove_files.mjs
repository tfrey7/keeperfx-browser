// Proves the game-files page in a real headless Chrome, against the page as served:
// a folder missing two files is refused by name, a complete folder is kept and read back by the
// compiled reader, the files are still there after a reload, "forget my files" really forgets,
// and a .zip of the folder works too. Screenshots of each state go to --shots.
//
//   py -3.10 scripts/serve.py --port 8840          (in another terminal)
//   node scripts/prove_files.mjs --url http://localhost:8840/ --work <scratch dir> --shots docs/proof
//
// The game folders it hands the page are fakes it makes itself: the right names, dummy bytes.
// No original Dungeon Keeper file is used, or needed.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { Browser } from "./cdp.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const url = arg("--url", "http://localhost:8840/");
const work = path.resolve(arg("--work", "proof-work"));
const shots = path.resolve(arg("--shots", "docs/proof"));
const debugPort = Number(arg("--debug-port", "8841"));

const REQUIRED = ["bluepal.dat", "bluepall.dat", "dogpal.pal", "hitpall.dat", "lightng.pal", "redpal.col",
  "redpall.dat", "slab0-0.dat", "slab0-1.dat", "vampal.pal", "whitepal.col"].map((n) => `DATA/${n.toUpperCase()}`)
  .concat(["atmos1.sbk", "atmos2.sbk", "bullfrog.sbk"].map((n) => `SOUND/${n.toUpperCase()}`));
const MUSIC = [2, 3, 4, 5, 6, 7].map((n) => `KEEPER0${n}.OGG`);
// Files a real install also has, which the page must leave alone.
const OTHERS = ["KEEPER95.EXE", "DATA/TMAPA000.DAT", "SOUND/SOUND.DAT"];

// A fake GOG-style install: upper-case names, music in the root. Returns the folder.
function fakeInstall(name, leaveOut = []) {
  const dir = path.join(work, name, "Dungeon Keeper Gold");
  for (const rel of [...REQUIRED, ...MUSIC, ...OTHERS]) {
    if (leaveOut.includes(rel)) continue;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), `dummy ${rel}\n`);
  }
  return dir;
}

// A .zip (deflated) of a fake install, as a zip tool would make it.
function fakeZip(file) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const rel of [...REQUIRED, ...MUSIC, ...OTHERS]) {
    const name = Buffer.from(`Dungeon Keeper Gold/${rel}`);
    const data = Buffer.from(`dummy ${rel}\n`);
    const packed = deflateRawSync(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10); dir.writeUInt32LE(crc32(data), 16); dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(head, name, packed);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(dirBytes.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...locals, dirBytes, end]));
  return file;
}

function check(ok, what) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const incomplete = fakeInstall("incomplete", ["DATA/SLAB0-1.DAT", "SOUND/ATMOS2.SBK"]);
const complete = fakeInstall("complete");
const zip = fakeZip(path.join(work, "Dungeon Keeper Gold.zip"));

const state = (s) => `document.body.dataset.state === ${JSON.stringify(s)}`;
const text = (id) => `document.getElementById(${JSON.stringify(id)}).textContent`;

const b = await Browser.launch({ profile: path.join(work, "chrome-profile"), port: debugPort, height: 1000 });
try {
  await b.goto(url);
  await b.waitFor(state("ask"));
  check(true, "a first visit asks for the Dungeon Keeper folder");
  await b.eval(`document.querySelector("details.guide").open = true`);
  await b.screenshot(path.join(shots, "1-picker.png"));

  await b.setFiles("#pick-folder", [incomplete]);
  await b.waitFor(state("missing"));
  const missing = await b.eval(`[...document.querySelectorAll("#missing-list li")].map((li) => li.textContent).join(",")`);
  check(missing === "data/slab0-1.dat,sound/atmos2.sbk", `the missing files are named (${missing})`);
  await b.screenshot(path.join(shots, "2-missing.png"));

  await b.click("#try-again");
  await b.setFiles("#pick-folder", [complete]);
  await b.waitFor(state("ready"));
  let view = await b.eval(text("engine-view"));
  check(view.includes("/keeperfx/data/bluepal.dat") && view.includes("20 files readable"),
    "the reader reads all 20 files from the engine's folders");
  check(!view.includes("tmapa000") && !view.includes("keeper95"), "files outside the manifest are left alone");

  await b.goto(url);
  await b.waitFor(state("ready"));
  view = await b.eval(text("engine-view"));
  check(view.includes("20 files readable"), "after a reload the files are still there");
  await b.screenshot(path.join(shots, "3-after-reload.png"));

  await b.click("#forget");
  await b.waitFor(state("ask"));
  await b.goto(url);
  await b.waitFor(state("ask"));
  check(true, "forget my files empties the store, and a reload asks again");

  await b.setFiles("#pick-zip", [zip]);
  await b.waitFor(state("ready"));
  view = await b.eval(text("engine-view"));
  check(view.includes("/keeperfx/sound/bullfrog.sbk") && view.includes("20 files readable"), "a .zip of the folder works too");
  const requests = await b.eval(`performance.getEntriesByType("resource").map((e) => e.name).join(" ")`);
  check(!/\.(dat|sbk|ogg|zip)\b/i.test(requests), "the page made no request carrying a game file");
  await b.click("#forget");
  await b.waitFor(state("ask"));
} finally {
  await b.close();
}
console.log("all proved");
