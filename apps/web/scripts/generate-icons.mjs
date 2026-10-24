// Writes the PWA icons (placeholder: white "H" on the brand colour) with no image dependencies.
// Usage: npm run icons -w apps/web
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BRAND = [0x0f, 0x76, 0x6e];
const WHITE = [0xff, 0xff, 0xff];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number} size @param {number} padding fraction of size kept clear around the glyph */
function icon(size, padding) {
  const inner = size * (1 - 2 * padding);
  const left = size * padding;
  const stroke = inner * 0.16;
  /** @param {number} x @param {number} y */
  const isGlyph = (x, y) => {
    const gx = (x - left) / inner;
    const gy = (y - left) / inner;
    if (gx < 0.2 || gx > 0.8 || gy < 0.15 || gy > 0.85) return false;
    const s = stroke / inner;
    return gx < 0.2 + s || gx > 0.8 - s || (gy > 0.5 - s / 2 && gy < 0.5 + s / 2);
  };
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB
    for (let x = 0; x < size; x++) {
      const [r, g, b] = isGlyph(x, y) ? WHITE : BRAND;
      row.writeUInt8(r ?? 0, 1 + x * 3);
      row.writeUInt8(g ?? 0, 2 + x * 3);
      row.writeUInt8(b ?? 0, 3 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), icon(192, 0.1));
writeFileSync(new URL('icon-512.png', out), icon(512, 0.1));
// Maskable icons keep the glyph inside the central 80% safe zone.
writeFileSync(new URL('icon-maskable-512.png', out), icon(512, 0.2));
console.log('Wrote icons to apps/web/public/icons');
