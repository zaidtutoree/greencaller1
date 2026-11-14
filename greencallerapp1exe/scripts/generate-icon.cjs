/**
 * Regenerates app-icon.ico (and build/icon.ico) from the existing artwork.
 *
 * Why this exists:
 *   The previous icons were produced by `png-to-ico`, which embeds EVERY size
 *   (16,32,48,...) as a PNG-encoded entry. Electron's own decoder renders those
 *   fine (so the in-window title bar and the tray looked correct), but the
 *   Windows *shell* — the taskbar button and the icon embedded into the .exe —
 *   expects the small sizes to be classic BMP/DIB entries. When they're all PNG
 *   the shell falls back to the default Electron icon, which is exactly the
 *   "Electron logo in the taskbar" bug.
 *
 *   This script keeps the artwork pixel-identical (it reads the existing 256px
 *   master out of app-icon.ico) and re-encodes it as a proper ICO:
 *     - 16/32/48/64/128  -> 32-bit BMP/DIB entries
 *     - 256              -> PNG entry (the conventional, smaller form)
 *
 * Run:  node scripts/generate-icon.cjs
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const SRC_ICO = path.join(ROOT, "public", "app-icon.ico");
const OUT_FILES = [
  path.join(ROOT, "public", "app-icon.ico"),
  path.join(ROOT, "build", "icon.ico"),
];

const BMP_SIZES = [16, 32, 48, 64, 128];
const PNG_SIZES = [256];

/** Pull the largest image (the 256px master) out of an existing .ico as PNG bytes. */
function extractLargestPng(icoBuf) {
  const count = icoBuf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = icoBuf.readUInt8(o) || 256;
    const size = icoBuf.readUInt32LE(o + 8);
    const offset = icoBuf.readUInt32LE(o + 12);
    if (!best || w > best.w) best = { w, size, offset };
  }
  if (!best) throw new Error("No images found in source ICO");
  const data = icoBuf.subarray(best.offset, best.offset + best.size);
  // Entry may be PNG or BMP; let sharp normalise it to a PNG buffer below.
  return data;
}

/** Build a 32-bit BMP/DIB icon image (no file header) for use inside an ICO. */
async function buildBmpEntry(masterPng, size) {
  const { data } = await sharp(masterPng)
    .resize(size, size, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true }); // RGBA, top-down

  // BITMAPINFOHEADER: height is doubled to account for the AND mask.
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  // XOR bitmap: BGRA, bottom-up.
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = data[s + 2]; // B
      xor[d + 1] = data[s + 1]; // G
      xor[d + 2] = data[s]; // R
      xor[d + 3] = data[s + 3]; // A
    }
  }

  // AND mask: 1bpp, rows padded to 4 bytes. Alpha channel already handles
  // transparency, so a zeroed mask (fully "opaque") is correct.
  const andRowBytes = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(andRowBytes * size, 0);

  return Buffer.concat([header, xor, andMask]);
}

async function buildPngEntry(masterPng, size) {
  return sharp(masterPng).resize(size, size, { fit: "fill" }).png().toBuffer();
}

async function main() {
  const srcIco = fs.readFileSync(SRC_ICO);
  const master = await sharp(extractLargestPng(srcIco)).png().toBuffer();

  const entries = [];
  for (const size of BMP_SIZES) {
    entries.push({ size, data: await buildBmpEntry(master, size) });
  }
  for (const size of PNG_SIZES) {
    entries.push({ size, data: await buildPngEntry(master, size) });
  }

  // Assemble the ICO container.
  const count = entries.length;
  const dir = Buffer.alloc(6 + count * 16);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(count, 4);

  let offset = dir.length;
  const bodies = [];
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o); // width  (0 => 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1); // height (0 => 256)
    dir.writeUInt8(0, o + 2); // color count
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bit count
    dir.writeUInt32LE(e.data.length, o + 8); // bytes in resource
    dir.writeUInt32LE(offset, o + 12); // offset
    offset += e.data.length;
    bodies.push(e.data);
  });

  const ico = Buffer.concat([dir, ...bodies]);
  for (const out of OUT_FILES) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, ico);
    console.log(`Wrote ${out} (${ico.length} bytes, ${count} sizes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
