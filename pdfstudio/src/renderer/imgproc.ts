// Image maths for the camera scanner. No browser APIs in here (works on plain RGBA arrays), so it can be tested in node:
//   node scripts/t-scan-math.mjs
export interface Img { data: Uint8ClampedArray; width: number; height: number }
export type Pt = [number, number];
/** Corners in this order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];
export type Filter = 'color' | 'gray' | 'bw' | 'original';

export const newImg = (width: number, height: number): Img => ({ data: new Uint8ClampedArray(width * height * 4), width, height });

// ---------- small helpers ----------
export function toGray(img: Img): Uint8ClampedArray {
  const n = img.width * img.height, g = new Uint8ClampedArray(n), d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 151 + d[j + 2] * 28) >> 8;
  return g;
}

/** Box blur (radius r), done as two running-sum passes. */
export function boxBlur(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h), out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / (2 * r + 1);
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Sobel gradient strength (0..255). Used to look for strong edges around the page. */
export function sobel(g: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -g[i - w - 1] + g[i - w + 1] - 2 * g[i - 1] + 2 * g[i + 1] - g[i + w - 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      out[i] = Math.min(255, Math.abs(gx) + Math.abs(gy) >> 2);
    }
  }
  return out;
}

export function otsu(g: Uint8ClampedArray): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

/** Shrink to at most `max` pixels on the long side (box average). */
export function downscale(img: Img, max: number): { img: Img; scale: number } {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  if (s >= 1) return { img, scale: 1 };
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const out = newImg(w, h);
  const fx = img.width / w, fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * fy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * fx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const j = (yy * img.width + xx) * 4; r += img.data[j]; g += img.data[j + 1]; b += img.data[j + 2]; n++; }
      const o = (y * w + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
    }
  }
  return { img: out, scale: s };
}

// ---------- document edge detection ----------
export function insetQuad(w: number, h: number, f = 0.05): Quad {
  const x0 = w * f, x1 = w * (1 - f), y0 = h * f, y1 = h * (1 - f);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

const cross = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
export const quadArea = (q: Quad) => Math.abs(q.reduce((s, p, i) => { const n = q[(i + 1) % 4]; return s + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
function isConvex(q: Quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-6) return false;
    const s = c > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/**
 * Finds the page in a photo: grayscale, blur, Otsu threshold to pick the bright area, keep the biggest connected bright blob,
 * take its four extreme corners, and accept it only if it fills most of that quadrilateral (so it really is a sheet of paper).
 * Returns the corners in the image's own pixels (TL, TR, BR, BL), or null when nothing page-like is found.
 */
export function detectDocument(img: Img): Quad | null {
  const { img: small, scale } = downscale(img, 320);
  const w = small.width, h = small.height, n = w * h;
  const blurred = boxBlur(toGray(small), w, h, 2);
  const thr = otsu(blurred);
  let mask = new Uint8Array(n);
  let bright = 0;
  for (let i = 0; i < n; i++) if (blurred[i] > thr) { mask[i] = 1; bright++; }
  // the bright side should be the smaller one (paper on a darker desk); if it is more than 80% the picture is not separable
  if (bright < n * 0.08 || bright > n * 0.92) return null;
  // biggest connected bright blob (4-neighbour flood fill)
  const label = new Int32Array(n);
  let bestId = 0, bestSize = 0, id = 0;
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s]) continue;
    id++;
    let sp = 0, size = 0;
    stack[sp++] = s; label[s] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (p >= w && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
      if (p < n - w && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
  }
  mask = new Uint8Array(0);
  if (!bestId || bestSize < n * 0.1) return null;
  // extreme points of that blob
  let tl = Infinity, br = -Infinity, tr = -Infinity, bl = Infinity;
  const P: [Pt, Pt, Pt, Pt] = [[0, 0], [0, 0], [0, 0], [0, 0]];
  for (let p = 0; p < n; p++) {
    if (label[p] !== bestId) continue;
    const x = p % w, y = (p / w) | 0;
    const a = x + y, b = x - y;
    if (a < tl) { tl = a; P[0] = [x, y]; }
    if (b > tr) { tr = b; P[1] = [x, y]; }
    if (a > br) { br = a; P[2] = [x, y]; }
    if (b < bl) { bl = b; P[3] = [x, y]; }
  }
  const q = P.map(([x, y]) => [x + 0.5, y + 0.5] as Pt) as Quad;
  const area = quadArea(q);
  if (!isConvex(q) || area < n * 0.12 || area > n * 0.96) return null;
  if (bestSize / area < 0.72) return null;                  // the blob is not shaped like a sheet
  const out = q.map(([x, y]) => [Math.min(img.width, x / scale), Math.min(img.height, y / scale)] as Pt) as Quad;
  // the outermost pixel centres sit half a pixel inside the true edge: nudge outwards a little
  const cx = (out[0][0] + out[1][0] + out[2][0] + out[3][0]) / 4, cy = (out[0][1] + out[1][1] + out[2][1] + out[3][1]) / 4;
  return out.map(([x, y]) => [Math.min(img.width, Math.max(0, x + Math.sign(x - cx) * 0.5 / scale)), Math.min(img.height, Math.max(0, y + Math.sign(y - cy) * 0.5 / scale))] as Pt) as Quad;
}

// ---------- perspective warp ----------
/** Solves the 8 unknowns of the projective map taking the 4 `from` points to the 4 `to` points. Returns [a..h] (h33 = 1). */
export function homography(from: Quad | Pt[], to: Quad | Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('Corners are in a line');
    for (let k = c; k < 9; k++) A[c][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (!f) continue;
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((r) => r[8]);
}
export function applyH(H: number[], x: number, y: number): Pt {
  const d = H[6] * x + H[7] * y + 1;
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Natural size of the straightened page, long side capped at `maxSide`. */
export function outputSize(q: Quad, maxSide = 2000): { w: number; h: number } {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(8, Math.round(w * s)); h = Math.max(8, Math.round(h * s));
  return { w, h };
}

/** Cuts the quadrilateral out of `src` and stretches it to a flat w x h picture (bilinear). */
export function warpPerspective(src: Img, q: Quad, w: number, h: number): Img {
  const out = newImg(w, h);
  // map output pixel -> source pixel
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], q);
  const sd = src.data, sw = src.width, sh = src.height, od = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = H[6] * px + H[7] * py + 1;
      let sx = (H[0] * px + H[1] * py + H[2]) / d - 0.5, sy = (H[3] * px + H[4] * py + H[5]) / d - 0.5;
      sx = Math.min(sw - 1, Math.max(0, sx)); sy = Math.min(sh - 1, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        od[o + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

// ---------- filters ----------
/** Stretch the brightness range so the paper becomes white and the ink dark (1%..99% levels). */
function levels(data: Uint8ClampedArray, gray: boolean) {
  const hist = new Uint32Array(256), n = data.length / 4;
  for (let i = 0; i < n; i++) hist[(data[i * 4] * 77 + data[i * 4 + 1] * 151 + data[i * 4 + 2] * 28) >> 8]++;
  let lo = 0, hi = 255, acc = 0;
  for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= n * 0.01) { lo = t; break; } }
  acc = 0;
  for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= n * 0.12) { hi = t; break; } }   // paper is the bright mass: 12% brightest -> white
  if (hi - lo < 30) return;
  const k = 255 / (hi - lo);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    if (gray) {
      const g = ((data[j] * 77 + data[j + 1] * 151 + data[j + 2] * 28) >> 8);
      data[j] = data[j + 1] = data[j + 2] = (g - lo) * k;
    } else {
      data[j] = (data[j] - lo) * k; data[j + 1] = (data[j + 1] - lo) * k; data[j + 2] = (data[j + 2] - lo) * k;
    }
  }
}

/** Adaptive (local-average) threshold: good for receipts and shaded pages. Works in place on a grayscale copy. */
function adaptive(img: Img) {
  const w = img.width, h = img.height, g = toGray(img);
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += g[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  const r = Math.max(7, Math.round(Math.max(w, h) / 40)), C = 12;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = g[y * w + x] > mean - C ? 255 : 0;
      const o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
    }
  }
}

/** Returns a new picture with the chosen look. `original` returns the same picture untouched. */
export function applyFilter(img: Img, f: Filter): Img {
  if (f === 'original') return img;
  const out: Img = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  if (f === 'color') levels(out.data, false);
  else if (f === 'gray') levels(out.data, true);
  else adaptive(out);
  return out;
}
