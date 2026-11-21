// Renders the IssueLint [≡] toolbar icons into public/icons/icon{16,32,48,128}.png.
// Run: node scripts/make-icons.mjs  — output PNGs are committed, so this is only needed to change the art.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const S = 4; // supersampling
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const [pr, pg, pb, pa] = pixel((x + (sx + .5) / S) / size, (y + (sy + .5) / S) / size);
        r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = (a / (S * S)) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
};
const distSeg = (px, py, ax, ay, bx, by) => {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
};
// IssueLint [≡] mark: forest-charcoal tile, off-white square brackets, three sage lint bars.
const BG = [0x12, 0x17, 0x14], INK = [0xee, 0xf2, 0xef], SAGE = [0x98, 0xb9, 0x9f];
const artFor = (size) => {
  // Small sizes get heavier strokes so the mark survives 16px rendering.
  const small = size <= 16, mid = size <= 32;
  const stroke = small ? 0.11 : mid ? 0.085 : 0.06;     // bracket stroke width
  const bar = small ? 0.11 : mid ? 0.085 : 0.07;        // lint bar thickness
  const top = 0.2, bottom = 0.8, left = 0.17, right = 0.83, arm = small ? 0.17 : 0.14;
  const bars = small ? [0.34, 0.5, 0.66] : [0.36, 0.5, 0.64];
  const barX0 = left + stroke + (small ? 0.1 : 0.12), barX1 = right - stroke - (small ? 0.1 : 0.12);
  return (x, y) => {
    if (!inRoundRect(x, y, 0.0, 0.0, 1.0, 1.0, 0.18)) return [0, 0, 0, 0];
    const inBox = (x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const bracket =
      inBox(left, top, left + stroke, bottom) || inBox(left, top, left + arm, top + stroke) || inBox(left, bottom - stroke, left + arm, bottom) ||
      inBox(right - stroke, top, right, bottom) || inBox(right - arm, top, right, top + stroke) || inBox(right - arm, bottom - stroke, right, bottom);
    if (bracket) return [...INK, 1];
    for (const cy of bars) if (inBox(barX0, cy - bar / 2, barX1, cy + bar / 2)) return [...SAGE, 1];
    return [...BG, 1];
  };
};
const dir = new URL("../public/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`icon${size}.png`, dir), png(size, artFor(size)));
console.log("icons written");
