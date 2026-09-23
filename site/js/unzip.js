// Reads a .zip in the browser with no library: the zip's own directory tells us every name,
// and only the entries we want are read and inflated (with the browser's DecompressionStream).
// Handles the "stored" and "deflate" methods, which is what every common zip tool writes.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function bytes(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

// Returns [{ name, method, compressedSize, size, localOffset }] for every file in the zip.
export async function listZip(blob) {
  // The end record sits in the last 22 bytes plus a comment of up to 64 KiB.
  const tailStart = Math.max(0, blob.size - 22 - 0xffff);
  const tail = await bytes(blob, tailStart, blob.size);
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new Error("This is not a .zip file (or it is damaged).");
  const count = tail.getUint16(at + 10, true);
  const dirSize = tail.getUint32(at + 12, true);
  const dirOffset = tail.getUint32(at + 16, true);
  if (dirOffset === 0xffffffff || count === 0xffff) {
    throw new Error("This .zip is too large to read here; choose the folder instead.");
  }

  const dir = await bytes(blob, dirOffset, dirOffset + dirSize);
  const decoder = new TextDecoder();
  const entries = [];
  for (let p = 0, n = 0; n < count; n++) {
    if (dir.getUint32(p, true) !== CENTRAL) throw new Error("This .zip's directory is damaged.");
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const commentLength = dir.getUint16(p + 32, true);
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength));
    if (!name.endsWith("/")) {
      entries.push({
        name,
        method: dir.getUint16(p + 10, true),
        compressedSize: dir.getUint32(p + 20, true),
        size: dir.getUint32(p + 24, true),
        localOffset: dir.getUint32(p + 42, true),
      });
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Returns the entry's contents as a Uint8Array.
export async function readZipEntry(blob, entry) {
  const local = await bytes(blob, entry.localOffset, entry.localOffset + 30);
  if (local.getUint32(0, true) !== LOCAL) throw new Error(`${entry.name}: damaged in the .zip.`);
  const start = entry.localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const data = blob.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return new Uint8Array(await data.arrayBuffer());
  if (entry.method === 8) {
    const inflated = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(inflated).arrayBuffer());
  }
  throw new Error(`${entry.name}: packed in a way this page cannot unpack (method ${entry.method}).`);
}
