// Tests that PdfStudio opens damaged PDFs (broken page list, missing page object, bad xref, cut-off picture) from a repaired copy.
// Fake data only. Needs pdfjs-dist + pdf-lib from node_modules.
//   node scripts/t-repair.mjs
//   REAL_PDF=/path/to/file.pdf EXPECT_PAGES=39 node scripts/t-repair.mjs     (optional check on a real file, nothing is copied or printed)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-')), 'pdfrepair.mjs');
await esbuild.build({ entryPoints: [path.join(here, '../src/renderer/pdfrepair.ts')], outfile: out, bundle: true, format: 'esm', platform: 'node' });
const { openWithRepair, REPAIR_NOTICE } = await import(pathToFileURL(out).href);
const lib = await import(pathToFileURL(path.join(here, '../node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(here, '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
const OPTS = { isEvalSupported: false, useWasm: false, verbosity: 0 };

let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };

// ---- tiny PDF writer. N pages; each page has a text content stream and (optionally) an image stream ----
const N = 6;
function build(o = {}) {
  const objs = {}, pg = (i) => 4 + i, ct = (i) => 4 + N + i, im = (i) => 4 + 2 * N + i;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let kids = [];
  for (let i = 0; i < N; i++) {
    const c = 'BT /F1 14 Tf 40 700 Td (Fake page ' + (i + 1) + ') Tj ET' + (o.images ? ' q 100 0 0 100 40 500 cm /Im1 Do Q' : '');
    objs[pg(i)] = '<< /Type /Page /Parent 2 0 R /Contents ' + ct(i) + ' 0 R' + (o.images ? ' /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ' + im(i) + ' 0 R >> >>' : '') + ' >>';
    objs[ct(i)] = '<< /Length ' + c.length + ' >>\nstream\n' + c + '\nendstream';
    if (o.images) {
      const data = 'x'.repeat(30);   // too short for a 10x10 gray image = a cut-off picture
      objs[im(i)] = '<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 30 >>\nstream\n' + data + '\nendstream';
    }
    kids.push(pg(i) + ' 0 R');
  }
  if (o.kids) kids = o.kids(kids, pg);
  objs[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + kids.length + ' /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> >>';
  if (o.drop) o.drop.forEach((n) => delete objs[n]);       // object is missing from the file entirely
  if (o.noPagesObj) { delete objs[2]; objs[1] = '<< /Type /Catalog >>'; }
  let s = '%PDF-1.4\n'; const off = {};
  Object.keys(objs).map(Number).sort((a, b) => a - b).forEach((k) => { off[k] = s.length; s += k + ' 0 obj\n' + objs[k] + '\nendobj\n'; });
  const max = 4 + 3 * N, x = s.length;
  s += 'xref\n0 ' + (max + 1) + '\n0000000000 65535 f \n';
  for (let k = 1; k <= max; k++) s += (off[k] != null ? String(off[k] + (o.badXref ? 9 : 0)).padStart(10, '0') + ' 00000 n \n' : '0000000000 65535 f \n');
  s += 'trailer\n<< /Size ' + (max + 1) + ' /Root 1 0 R >>\nstartxref\n' + (o.badXref ? x + 40 : x) + '\n%%EOF\n';
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const cases = [
  ['good file (not touched)', build(), N, false],
  ['kid object missing from the file (like the real bank PDF)', build({ drop: [4 + 3], kids: (k) => k }), N - 1, true],
  ['two kids missing', build({ drop: [5, 8] }), N - 2, true],
  ['kid is a number, not a page', build({ kids: (k) => [k[0], '7', ...k.slice(1)] }), N, null],
  ['kid points at the font', build({ kids: (k) => [k[0], '3 0 R', ...k.slice(1)] }), N, null],
  ['kid points at a content stream', build({ kids: (k) => [k[0], (4 + N) + ' 0 R', ...k.slice(1)] }), N, null],
  ['page tree object gone', build({ noPagesObj: true }), N, true],
  ['bad xref offsets', build({ badXref: true }), N, null],
  ['cut-off pictures + a missing page', build({ images: true, drop: [6] }), N - 1, true],
];
for (const [name, bytes, pages, mustRepair] of cases) {
  let plain = 'opened';
  try { const d = await lib.getDocument({ ...OPTS, data: bytes.slice() }).promise; for (let p = 1; p <= d.numPages; p++) await d.getPage(p); plain = d.numPages + ' pages'; } catch (e) { plain = 'ERROR ' + e.message; }
  try {
    const r = await openWithRepair(lib, bytes, OPTS);
    const got = r.pdf.numPages - r.badPages.length;
    check(name, got === pages && (mustRepair === null || r.repaired === mustRepair), `plain pdf.js: ${plain}; PdfStudio: ${got} pages, repaired=${r.repaired}`);
    // saving works on the bytes we keep (pdf-lib is what Save uses)
    if (r.repaired) {
      const d = await PDFDocument.load(r.bytes, { ignoreEncryption: true }); const saved = await d.save();
      const d2 = await PDFDocument.load(saved);
      check('  save of repaired bytes keeps ' + pages + ' pages', d2.getPageCount() === pages, 'pdf-lib saw ' + d2.getPageCount());
      const again = await openWithRepair(lib, saved, OPTS);
      check('  saved copy opens clean', again.pdf.numPages === pages && !again.repaired);
    }
  } catch (e) { check(name, false, 'threw ' + e.message); }
}

// a normal PDF from the repo must open untouched
{ const f = path.join(here, '../samples/sample.pdf');
  if (fs.existsSync(f)) { const r = await openWithRepair(lib, new Uint8Array(fs.readFileSync(f)), OPTS); check('samples/sample.pdf opens untouched', !r.repaired && r.pdf.numPages > 0, r.pdf.numPages + ' pages'); } }

// garbage is still an error; a password error is passed through unchanged
try { await openWithRepair(lib, Uint8Array.from('not a pdf at all', (c) => c.charCodeAt(0)), OPTS); check('garbage still fails', false); } catch (e) { check('garbage still fails', true, e.message); }
{ const e0 = Object.assign(new Error('No password given'), { name: 'PasswordException', code: 1 });
  const fake = { getDocument: () => ({ promise: Promise.reject(e0) }) };
  try { await openWithRepair(fake, build(), {}); check('password error passes through', false); } catch (e) { check('password error passes through', e === e0); } }
check('notice wording', REPAIR_NOTICE(39) === 'This PDF was damaged. PdfStudio repaired it and opened 39 pages; some pages or pictures may be missing. Use Save As to keep the repaired copy.');

if (process.env.REAL_PDF) {
  const b = new Uint8Array(fs.readFileSync(process.env.REAL_PDF));
  const r = await openWithRepair(lib, b, OPTS), got = r.pdf.numPages - r.badPages.length;
  check('real file', got === Number(process.env.EXPECT_PAGES || got), `${got} pages open, ${r.badPages.length} blank, repaired=${r.repaired}`);
  const d = await PDFDocument.load(r.bytes, { ignoreEncryption: true }); check('real file saves via pdf-lib', (await d.save()).length > 0, d.getPageCount() + ' pages');
}
console.log(fails ? fails + ' FAILED' : 'ALL OK'); process.exit(fails ? 1 : 0);
