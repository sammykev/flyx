// Generates PNG app icons (gradient + glass ring) with zero dependencies.
import zlib from "node:zlib";
import fs from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * (size * 4 + 1) + 1 + x * 4;
      let r = 20 + 30 * u, g = 40 + 120 * (1 - v) * u, b = 110 + 120 * v;
      const d = Math.hypot(u - .5, v - .5);
      const ring = Math.max(0, 1 - Math.abs(d - .27) / .045);
      const arc = (Math.atan2(v - .5, u - .5) + Math.PI) / (2 * Math.PI) < .72 ? 1 : .3;
      const k = ring * arc;
      r += (255 - r) * k * .9; g += (255 - g) * k * .9; b += (255 - b) * k * .9;
      raw.set([r, g, b, 255].map((n) => Math.min(255, n | 0)), i);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) fs.writeFileSync(`public/icon-${s}.png`, png(s));
console.log("icons written");
