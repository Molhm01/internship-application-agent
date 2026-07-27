/**
 * Generates the extension's PNG icons so no binary assets need to live in git.
 * Run with `node scripts/generate-icons.mjs` after changing the design.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'public', 'icons');

const BACKGROUND = [47, 91, 215]; // matches --accent
const GLYPH = [255, 255, 255];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Solid rounded square with a centered "A" cut out of the fill. */
function pixel(x, y, size) {
  const radius = size * 0.22;
  const inCorner =
    (x < radius && y < radius && (x - radius) ** 2 + (y - radius) ** 2 > radius ** 2) ||
    (x > size - radius &&
      y < radius &&
      (x - (size - radius)) ** 2 + (y - radius) ** 2 > radius ** 2) ||
    (x < radius &&
      y > size - radius &&
      (x - radius) ** 2 + (y - (size - radius)) ** 2 > radius ** 2) ||
    (x > size - radius &&
      y > size - radius &&
      (x - (size - radius)) ** 2 + (y - (size - radius)) ** 2 > radius ** 2);

  if (inCorner) return [0, 0, 0, 0];

  const nx = x / size;
  const ny = y / size;
  const stroke = 0.1;
  // Two diagonal legs plus a crossbar form the "A".
  const leftLeg = Math.abs(nx - (0.5 - (ny - 0.2) * 0.42)) < stroke / 2 && ny > 0.2 && ny < 0.82;
  const rightLeg = Math.abs(nx - (0.5 + (ny - 0.2) * 0.42)) < stroke / 2 && ny > 0.2 && ny < 0.82;
  const bar = ny > 0.58 && ny < 0.58 + stroke * 0.8 && nx > 0.33 && nx < 0.67;

  return leftLeg || rightLeg || bar ? [...GLYPH, 255] : [...BACKGROUND, 255];
}

function makePng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, makePng(size));
  console.log(`wrote ${file}`);
}
