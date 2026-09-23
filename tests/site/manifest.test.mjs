// The manifest matcher and the zip reader, run by `node --test` (tests/test_site.py runs this).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { REQUIRED, OPTIONAL, matchFiles } from "../../site/js/manifest.js";
import { listZip, readZipEntry } from "../../site/js/unzip.js";

const upper = (names, root) => names.map((n) => `${root}/${n.toUpperCase()}`);

test("a GOG copy in upper case matches every file, music from the root", () => {
  const extras = OPTIONAL.map((n) =>
    n.startsWith("data/") ? `Dungeon Keeper Gold/${n.toUpperCase()}` : `Dungeon Keeper Gold/${n.split("/")[1].toUpperCase()}`);
  const { found, missing, missingOptional } = matchFiles([...upper(REQUIRED, "Dungeon Keeper Gold"), ...extras]);
  assert.deepEqual(missing, []);
  assert.deepEqual(missingOptional, []);
  assert.equal(found.get("data/bluepal.dat"), "Dungeon Keeper Gold/DATA/BLUEPAL.DAT");
  assert.equal(found.get("music/keeper02.ogg"), "Dungeon Keeper Gold/KEEPER02.OGG");
});

test("the survey's optional extras are picked up: palettes from data/, movies from any folder", () => {
  const paths = ["DK/DATA/MAIN.PAL", "DK/DATA/MAPFADEG.DAT", "DK/LDATA/INTROMIX.SMK", "DK/BULLFROG.SMK", "DK/mapfadeg.dat"];
  const { found, missing, missingOptional } = matchFiles([...upper(REQUIRED, "DK"), ...paths]);
  assert.deepEqual(missing, []);
  assert.equal(found.get("data/main.pal"), "DK/DATA/MAIN.PAL");
  assert.equal(found.get("data/mapfadeg.dat"), "DK/DATA/MAPFADEG.DAT");
  assert.equal(found.get("ldata/intromix.smk"), "DK/LDATA/INTROMIX.SMK");
  assert.equal(found.get("ldata/bullfrog.smk"), "DK/BULLFROG.SMK");
  assert.ok(missingOptional.includes("ldata/ea.smk") && missingOptional.includes("ldata/drag.smk"));
});

test("missing required files are named, and music is only optional", () => {
  const paths = REQUIRED.filter((n) => n !== "data/slab0-1.dat" && n !== "sound/atmos2.sbk").map((n) => `DK/${n}`);
  const { missing, missingOptional } = matchFiles(paths);
  assert.deepEqual(missing, ["data/slab0-1.dat", "sound/atmos2.sbk"]);
  assert.equal(missingOptional.length, OPTIONAL.length);
});

test("an Origin copy nested one level deeper is found, the shallowest copy wins", () => {
  const paths = [...upper(REQUIRED, "Dungeon Keeper/DATA"), "Dungeon Keeper/DATA/BACKUP/DATA/BLUEPAL.DAT"];
  const { found, missing } = matchFiles(paths);
  assert.deepEqual(missing, []);
  assert.equal(found.get("data/bluepal.dat"), "Dungeon Keeper/DATA/DATA/BLUEPAL.DAT");
});

test("a data file outside a data folder does not count", () => {
  const { missing } = matchFiles(["DK/bluepal.dat", "DK/sound/bluepal.dat"]);
  assert.ok(missing.includes("data/bluepal.dat"));
});

// A zip with one stored and one deflated entry, as zip tools write them.
function zipOf(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text, method] of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const body = method === 8 ? deflateRawSync(data) : data;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(method, 8); head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(method, 10); dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(offset, 42);
    parts.push(head, nameBytes, body);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Blob([...parts, dir, end]);
}

test("the zip reader lists entries and reads stored and deflated ones", async () => {
  const zip = zipOf([["DK/DATA/BLUEPAL.DAT", "stored bytes", 0], ["DK/SOUND/ATMOS1.SBK", "deflated ".repeat(50), 8]]);
  const entries = await listZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["DK/DATA/BLUEPAL.DAT", "DK/SOUND/ATMOS1.SBK"]);
  const text = async (e) => new TextDecoder().decode(await readZipEntry(zip, e));
  assert.equal(await text(entries[0]), "stored bytes");
  assert.equal(await text(entries[1]), "deflated ".repeat(50));
});

test("a file that is not a zip says so", async () => {
  await assert.rejects(listZip(new Blob(["not a zip at all"])), /not a \.zip/);
});
