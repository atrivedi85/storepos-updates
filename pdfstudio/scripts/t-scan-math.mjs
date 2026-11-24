// Tests the scanner maths (edge detection, homography warp, filters) on a synthetic photo, no browser needed.
//   node scripts/t-scan-math.mjs
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scanmath-')), 'imgproc.mjs');
await esbuild.build({ entryPoints: [path.join(here, '../src/renderer/imgproc.ts')], outfile: out, bundle: true, format: 'esm', platform: 'node' });
const m = await import(pathToFileURL(out).href);

let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };

// 1. homography maps the 4 points exactly
const A = [[0, 0], [100, 0], [100, 50], [0, 50]], B = [[12, 8], [190, 30], [170, 140], [20, 120]];
const H = m.homography(A, B);
check('homography maps 4 corners', A.every((p, i) => { const r = m.applyH(H, p[0], p[1]); return Math.hypot(r[0] - B[i][0], r[1] - B[i][1]) < 1e-6; }));
const mid = m.applyH(H, 50, 25);
check('homography centre inside quad', mid[0] > 60 && mid[0] < 140 && mid[1] > 40 && mid[1] < 110, mid.map((v) => v.toFixed(1)).join(','));

// 2. synthetic photo: dark desk, a slightly rotated/skewed white sheet with dark "text" lines
const W = 640, Hh = 480;
const quad = [[120, 60], [520, 90], [490, 420], [90, 380]];
const img = m.newImg(W, Hh);
const inside = (x, y) => {
  let s = 0;
  for (let i = 0; i < 4; i++) { const a = quad[i], b = quad[(i + 1) % 4]; const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]); s += c > 0 ? 1 : -1; }
  return Math.abs(s) === 4;
};
for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
  const o = (y * W + x) * 4;
  let v = 40 + ((x * 7 + y * 13) % 9);                       // dark desk with a little noise
  if (inside(x, y)) { v = 235; if (y % 24 < 4 && x % 50 < 38) v = 40; }   // paper with dark text-like dashes
  img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v - 5; img.data[o + 3] = 255;
}
const det = m.detectDocument(img);
check('page found', !!det);
if (det) {
  const err = Math.max(...det.map((p, i) => Math.hypot(p[0] - quad[i][0], p[1] - quad[i][1])));
  check('corners within 6px (1%) of the truth', err < 6, `max error ${err.toFixed(2)}px  found ${JSON.stringify(det.map((p) => p.map((v) => +v.toFixed(1))))}`);
}
// 3. a plain dark picture has no page -> null (caller falls back to a 5% inset)
const flat = m.newImg(200, 150); flat.data.fill(60); for (let i = 3; i < flat.data.length; i += 4) flat.data[i] = 255;
check('no page in a flat picture -> null', m.detectDocument(flat) === null);
const inset = m.insetQuad(1000, 800);
check('5% inset fallback', Math.abs(inset[0][0] - 50) < 1e-9 && Math.abs(inset[2][1] - 760) < 1e-9);

// 4. warp the detected page flat: result is mostly paper-white and has the text dashes
const q = det || quad;
const sz = m.outputSize(q);
const flatImg = m.warpPerspective(img, q, sz.w, sz.h);
let white = 0, dark = 0;
for (let i = 0; i < sz.w * sz.h; i++) { const v = flatImg.data[i * 4]; if (v > 200) white++; else if (v < 90) dark++; }
check('warped output is mostly paper', white / (sz.w * sz.h) > 0.8, `${(100 * white / (sz.w * sz.h)).toFixed(1)}% white, ${sz.w}x${sz.h}`);
check('warped output keeps the text', dark / (sz.w * sz.h) > 0.03 && dark / (sz.w * sz.h) < 0.3, `${(100 * dark / (sz.w * sz.h)).toFixed(1)}% dark`);
// exact warp of a known pattern: sample a checker, warp with an axis-aligned quad = crop
const ck = m.newImg(100, 100);
for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) { const v = ((x >> 3) + (y >> 3)) & 1 ? 255 : 0; const o = (y * 100 + x) * 4; ck.data[o] = ck.data[o + 1] = ck.data[o + 2] = v; ck.data[o + 3] = 255; }
const crop = m.warpPerspective(ck, [[10, 10], [90, 10], [90, 90], [10, 90]], 80, 80);
let same = 0; for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) if (Math.abs(crop.data[(y * 80 + x) * 4] - ck.data[((y + 10) * 100 + x + 10) * 4]) < 8) same++;
check('axis-aligned warp equals a plain crop', same / 6400 > 0.99, (same / 64).toFixed(1) + '%');

// 5. filters
const b = m.applyFilter(flatImg, 'bw');
let onlyBW = true, bwWhite = 0; for (let i = 0; i < sz.w * sz.h; i++) { const v = b.data[i * 4]; if (v !== 0 && v !== 255) onlyBW = false; if (v === 255) bwWhite++; }
check('black & white has only 2 levels', onlyBW);
check('black & white keeps paper white and text black', bwWhite / (sz.w * sz.h) > 0.7 && bwWhite / (sz.w * sz.h) < 0.98, (100 * bwWhite / (sz.w * sz.h)).toFixed(1) + '% white');
const g = m.applyFilter(flatImg, 'gray');
check('grayscale has equal channels', g.data[40] === g.data[41] && g.data[41] === g.data[42]);
check('original is untouched', m.applyFilter(flatImg, 'original') === flatImg);
process.exit(fails ? 1 : 0);
