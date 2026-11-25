// Run:  node ledger/test/pdfrepair.test.mjs
// Builds small broken PDFs (fake data only) and checks Ledger Desk's PDF statement reader copes with them.
// Needs pdfjs-dist (same version as ledger/app/vendor) from pdfstudio/node_modules; skipped if it is not installed.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require('../app/pdfstmt.js'); const API = globalThis.LedgerPdfStatement;
let lib;
try { lib = await import(pathToFileURL(path.join(here, '../../pdfstudio/node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href); }
catch (e) { console.log('SKIP: pdfjs-dist not installed (run npm install in pdfstudio)'); process.exit(0); }
lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(here, '../../pdfstudio/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

// ---- tiny PDF writer: objs = { num: 'raw body' } (body may include stream); raw = keep xref honest unless badXref ----
const PAGES = [
  ['Sample Bank Statement', 'Account ending 1234', 'Beginning Balance $1,000.00', 'Statement Period January 1, 2025 - January 31, 2025', 'Deposits and Credits', '01/05  Deposit Payroll  500.00  1,500.00'],
  ['Statement page 2', 'Withdrawals', '01/09  Check 1001  100.00  1,400.00', '01/12  Withdrawal Grocery  50.00  1,350.00'],
  ['Statement page 3', 'Deposits and Credits', '01/20  Interest Paid  2.50  1,352.50', 'Ending Balance $1,352.50'],
];
function content(lines) { let y = 740; return 'BT /F1 11 Tf ' + lines.map(l => { let x = 40; const t = l.split(/ {2,}/).map(c => { const r = '1 0 0 1 ' + x + ' ' + y + ' Tm (' + c + ') Tj '; x += 12 + c.length * 6; return r; }).join(''); y -= 18; return t; }).join('') + 'ET'; }
function build(o = {}) {
  // 1 catalog, 2 pages, 3 font, 4.. pages, then contents
  const n = PAGES.length, objs = {};
  const pg = i => 4 + i, ct = i => 4 + n + i;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let kids = PAGES.map((_, i) => pg(i) + ' 0 R');
  PAGES.forEach((p, i) => {
    const c = content(p);
    objs[pg(i)] = '<< /Type /Page /Parent 2 0 R ' + (o.noMediaOnPage === false ? '/MediaBox [0 0 612 792] ' : '') + '/Contents ' + ct(i) + ' 0 R >>';
    objs[ct(i)] = '<< /Length ' + c.length + ' >>\nstream\n' + c + '\nendstream';
  });
  if (o.kids) kids = o.kids(kids, pg);
  objs[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> >>';
  if (o.noPagesObj) { delete objs[2]; objs[1] = '<< /Type /Catalog >>'; }
  if (o.extra) o.extra(objs);
  let out = '%PDF-1.4\n', off = {};
  Object.keys(objs).map(Number).sort((a, b) => a - b).forEach(k => { off[k] = out.length; out += k + ' 0 obj\n' + objs[k] + '\nendobj\n'; });
  const max = Math.max(...Object.keys(objs).map(Number)), x = out.length;
  out += 'xref\n0 ' + (max + 1) + '\n0000000000 65535 f \n';
  for (let k = 1; k <= max; k++) out += (off[k] != null ? String(off[k] + (o.badXref ? 7 : 0)).padStart(10, '0') + ' 00000 n \n' : '0000000000 65535 f \n');
  out += 'trailer\n<< /Size ' + (max + 1) + ' /Root 1 0 R >>\nstartxref\n' + (o.badXref ? x + 50 : x) + '\n%%EOF\n';
  return out;
}
const file = (s, name = 'x.pdf') => ({ name, arrayBuffer: async () => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; } });
const cases = {
  good: { s: build(), pages: 3 },
  'a: kid is a number': { s: build({ kids: (k) => [k[0], '7', k[1], k[2]] }), pages: 3, reproduce: true },
  'a2: kid is a stream': { s: build({ kids: (k) => [k[0], (4 + PAGES.length) + ' 0 R', k[1], k[2]] }), pages: 3, reproduce: true },
  'a3: first kid is missing object': { s: build({ kids: (k) => ['99 0 R', k[0], k[1], k[2]] }), pages: 3 },
  'b: extra bogus kid ref': { s: build({ kids: (k) => [...k, '3 0 R'] }), pages: 3 },
  'c: page tree gone': { s: build({ noPagesObj: true }), pages: 3 },
  'd: broken xref offsets': { s: build({ badXref: true }), pages: 3 },
  'e: kid pointing at the font dictionary': { s: build({ kids: (k) => [k[0], '3 0 R', k[1], k[2]] }), pages: 3 },
};
if (process.env.DBG) { const {lines}=await (async()=>{const f=file(cases.good.s);const o=await API.openPdf(f,lib);const p=await o.doc.getPage(2);return {lines:(await p.getTextContent()).items.map(i=>[i.str,i.transform[4],i.width])}})(); console.log(JSON.stringify(lines)); }
let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.log('  FAIL', m); } };
for (const [name, c] of Object.entries(cases)) {
  console.log(name);
  // before: plain pdf.js
  let before = 'opened';
  try { const d = await lib.getDocument({ data: new Uint8Array(await file(c.s).arrayBuffer()), isEvalSupported: false, useWasm: false }).promise; for (let p = 1; p <= d.numPages; p++) await d.getPage(p); before = 'opened (' + d.numPages + ' pages)'; } catch (e) { before = 'ERROR: ' + e.message; }
  console.log('  plain pdf.js:', before);
  if (c.reproduce) ok(/wrong type|ERROR/.test(before), 'expected plain pdf.js to fail');
  try {
    const r = await API.readStatement(file(c.s), lib);
    const text = r.txns.map(t => t.payee).join('|');
    console.log('  ledger: txns=' + r.txns.length + ' begin=' + r.begin + ' end=' + r.end + ' diff=' + r.diff + ' pages=' + r.pages + ' warn=' + JSON.stringify(r.warn));
    ok(r.txns.length === 4, 'expected 4 transactions, got ' + r.txns.length);
    ok(r.begin === 1000 && r.end === 1352.5 && r.ok, 'balances should reconcile');
  } catch (e) { fail++; console.log('  FAIL threw:', e.message); }
}
// a normal PDF from the repo must open untouched (no repair, no warnings)
{ const fs = await import('fs'); const f = path.join(here, '../../pdfstudio/samples/sample.pdf');
  if (fs.existsSync(f)) { const b = fs.readFileSync(f); const r = await API.openPdf({ arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }, lib); console.log('sample.pdf repaired?', r.repaired, 'pages', r.doc.numPages); ok(!r.repaired, 'normal PDF should not be repaired'); } }
// totally unreadable bytes: plain-words error
try { await API.readStatement(file('not a pdf at all'), lib); fail++; console.log('FAIL garbage should throw'); } catch (e) { console.log('garbage ->', e.message); ok(/damaged/.test(e.message), 'plain damaged message'); }
console.log(fail ? fail + ' FAILED' : 'ALL OK'); process.exit(fail ? 1 : 0);
