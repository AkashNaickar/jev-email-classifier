// Pure-Node PNG icon generator. No dependencies.
// Draws a rounded indigo tile with a white envelope glyph at 16/32/48/128 px.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, '..', 'public', 'icons');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// Signed distance to a rounded rectangle centred at (cx,cy).
function roundedRectSdf(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size;
  // Palette: indigo tile, white envelope, indigo flap.
  const bg = [79, 70, 229];
  const bgTop = [99, 102, 241];
  const white = [255, 255, 255];
  const flap = [67, 56, 202];

  const pad = Math.round(s * 0.06);
  const tileHalf = s / 2 - pad;
  const radius = s * 0.24;

  // Envelope geometry.
  const envW = s * 0.56;
  const envH = s * 0.40;
  const envHalfW = envW / 2;
  const envHalfH = envH / 2;
  const envCy = s * 0.52;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      const tile = roundedRectSdf(px, py, s / 2, s / 2, tileHalf, tileHalf, radius);
      const tileCov = Math.min(1, Math.max(0, 0.5 - tile));
      if (tileCov > 0) {
        const t = py / s;
        r = mix(bgTop[0], bg[0], t);
        g = mix(bgTop[1], bg[1], t);
        b = mix(bgTop[2], bg[2], t);
        a = tileCov * 255;

        // Envelope body (white rounded rect).
        const body = roundedRectSdf(px, py, s / 2, envCy, envHalfW, envHalfH, s * 0.06);
        const bodyCov = Math.min(1, Math.max(0, 0.5 - body));
        if (bodyCov > 0) {
          r = mix(r, white[0], bodyCov);
          g = mix(g, white[1], bodyCov);
          b = mix(b, white[2], bodyCov);
        }

        // Flap: two diagonal edges from the top corners toward the centre.
        const topY = envCy - envHalfH;
        const cx = s / 2;
        if (py >= topY && py <= envCy) {
          const progress = (py - topY) / (envCy - topY);
          const edge = envHalfW * (1 - progress);
          const insideFlap = Math.abs(px - cx) < edge - s * 0.015;
          if (insideFlap && bodyCov > 0) {
            r = mix(r, flap[0], 0.92);
            g = mix(g, flap[1], 0.92);
            b = mix(b, flap[2], 0.92);
          }
        }
      }

      const i = (y * s + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a);
    }
  }
  return encodePng(s, rgba);
}

export async function generateIcons() {
  await mkdir(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await writeFile(join(outDir, `icon${size}.png`), renderIcon(size));
  }
  console.log(`wrote icons to ${outDir}`);
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  generateIcons().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
