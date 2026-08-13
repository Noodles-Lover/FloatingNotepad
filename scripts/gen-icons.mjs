// Generates a placeholder icon.png and icon.ico (PNG-payload ICO) for Tauri.
// No external deps — pure Node. Run: node scripts/gen-icons.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("src-tauri/icons");
fs.mkdirSync(OUT, { recursive: true });

const W = 32;
const H = 32;

// RGBA teal square.
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // PNG filter type 0 (none)
  for (let x = 0; x < W; x++) {
    const o = y * (W * 4 + 1) + 1 + x * 4;
    raw[o] = 0x1d; // R
    raw[o + 1] = 0x9e; // G
    raw[o + 2] = 0x75; // B
    raw[o + 3] = 255; // A
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const idat = zlib.deflateSync(raw);
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.writeFileSync(path.join(OUT, "icon.png"), png);

// ICO wrapping the PNG.
const pngSize = png.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry[0] = W; // width (0 means 256, but 32 fits)
entry[1] = H; // height
entry[2] = 0; // colors
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(pngSize, 8); // pixel data size
entry.writeUInt32LE(6 + 16, 12); // offset to pixel data
const ico = Buffer.concat([header, entry, png]);

fs.writeFileSync(path.join(OUT, "icon.ico"), ico);
console.log("wrote", path.join(OUT, "icon.png"), "and", path.join(OUT, "icon.ico"));
