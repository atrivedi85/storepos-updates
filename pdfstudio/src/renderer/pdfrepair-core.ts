// @ts-nocheck
// Page-tree repair for damaged PDFs. Ported from ledger/app/pdfstmt.js (`repairPdf`) - keep the two in step.
// Rebuilds the page list from the /Type /Page objects that are really in the file. Untyped on purpose (raw byte text work).
export const toLatin = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
export const fromLatin = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
// raw text of the value after /Key inside a PDF dictionary body: {start,end,val}
function keySpan(body, key) {
  const m = new RegExp('/' + key + '(?![A-Za-z0-9])').exec(body); if (!m) return null;
  let i = m.index + m[0].length; while (i < body.length && /\s/.test(body[i])) i++;
  const st = i;
  if (body.startsWith('<<', i) || body[i] === '[') {
    let depth = 0;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === '(') { for (i++; i < body.length && body[i] !== ')'; i++) if (body[i] === '\\') i++; continue; }
      if (c === '<' && body[i + 1] === '<') { depth++; i++; } else if (c === '>' && body[i + 1] === '>') { depth--; i++; if (!depth) { i++; break; } }
      else if (c === '[') depth++; else if (c === ']') { depth--; if (!depth) { i++; break; } }
    }
  } else { const r = /^(\d+\s+\d+\s+R|\/?[^\s\/<>\[\]()]+)/.exec(body.slice(i)); if (!r) return null; i += r[0].length; }
  return { start: m.index, end: i, val: body.slice(st, i) };
}
// Rebuild the page tree: find every /Type /Page object in the raw bytes, then append a new flat /Pages + /Catalog
// and a fresh xref/trailer (an incremental update). Returns null when no page objects can be found.
export function repairPdf(u8) {
  const s = toLatin(u8), objs = new Map(), re = /(?:^|[\r\n\s>])(\d{1,7})[ \t]+(\d{1,5})[ \t]+obj\b/g; let m;
  while ((m = re.exec(s))) { const num = +m[1]; objs.delete(num); objs.set(num, { n: num, g: +m[2], at: m.index + m[0].indexOf(m[1]), bodyAt: m.index + m[0].length }); }   // last definition wins
  const list = [...objs.values()].sort((a, b) => a.at - b.at);
  list.forEach((o, i) => { const e = s.indexOf('endobj', o.bodyAt), nx = list[i + 1] ? list[i + 1].at : s.length; o.body = s.slice(o.bodyAt, e >= 0 && e < nx ? e : nx); });
  const bodyOf = n => (objs.get(n) || {}).body || '';
  const dictOf = b => { const i = b.indexOf('<<'); if (i < 0) return ''; const k = keySpan('/X ' + b.slice(i, i + 30000), 'X'); return k ? k.val : ''; };
  const pages = list.filter(o => /\/Type\s*\/Page(?![A-Za-z])/.test(dictOf(o.body)));
  if (!pages.length) return null;
  const maxN = Math.max(...list.map(o => o.n)), pagesN = maxN + 1, catN = maxN + 2;
  const inherit = (o, key) => {   // MediaBox, Resources... may live on an old /Pages parent
    let d = dictOf(o.body), seen = 0;
    for (;;) {
      const k = keySpan(d, key); if (k) return k.val;
      const par = keySpan(d, 'Parent'), pm = par && /^(\d+)\s+\d+\s+R/.exec(par.val); if (!pm || ++seen > 20) return null;
      d = dictOf(bodyOf(+pm[1]));
    }
  };
  const out = []; let pos = u8.length + 1; const offs = [];
  const add = (n, g, txt) => { offs.push({ n, g, off: pos }); const t = n + ' ' + g + ' obj\n' + txt + '\nendobj\n'; out.push(t); pos += t.length; };
  pages.forEach(o => {
    let d = dictOf(o.body); const par = keySpan(d, 'Parent'); if (par) d = d.slice(0, par.start) + d.slice(par.end);
    let extra = '/Parent ' + pagesN + ' 0 R';
    ['MediaBox', 'Resources', 'CropBox', 'Rotate'].forEach(k => { if (!keySpan(d, k)) { const v = inherit(o, k) || (k === 'MediaBox' ? '[0 0 612 792]' : k === 'Resources' ? '<< >>' : null); if (v) extra += ' /' + k + ' ' + v; } });
    add(o.n, o.g, d.replace(/>>\s*$/, '') + ' ' + extra + ' >>');
  });
  add(pagesN, 0, '<< /Type /Pages /Kids [' + pages.map(o => o.n + ' ' + o.g + ' R').join(' ') + '] /Count ' + pages.length + ' >>');
  add(catN, 0, '<< /Type /Catalog /Pages ' + pagesN + ' 0 R >>');
  const xrefAt = pos, sorted = offs.slice().sort((a, b) => a.n - b.n);
  let x = 'xref\n0 1\n0000000000 65535 f \n';
  for (let i = 0; i < sorted.length;) { let j = i; while (j + 1 < sorted.length && sorted[j + 1].n === sorted[j].n + 1) j++; x += sorted[i].n + ' ' + (j - i + 1) + '\n'; for (let k = i; k <= j; k++) x += String(sorted[k].off).padStart(10, '0') + ' ' + String(sorted[k].g).padStart(5, '0') + ' n \n'; i = j + 1; }
  const sx = [...s.matchAll(/startxref\s+(\d+)/g)].pop(), prev = sx && +sx[1] < u8.length && /^\s*(xref|\d+\s+\d+\s+obj)/.test(s.slice(+sx[1], +sx[1] + 40)) ? +sx[1] : null;
  const enc = [...s.matchAll(/\/Encrypt\s+(\d+\s+\d+\s+R)/g)].pop(), id = [...s.matchAll(/\/ID\s*(\[[^\]]*\])/g)].pop();
  x += 'trailer\n<< /Size ' + (catN + 1) + ' /Root ' + catN + ' 0 R' + (prev != null ? ' /Prev ' + prev : '') + (enc ? ' /Encrypt ' + enc[1] : '') + (id ? ' /ID ' + id[1] : '') + ' >>\nstartxref\n' + xrefAt + '\n%%EOF\n';
  const res = fromLatin(s + '\n' + out.join('') + x); res.pageNums = pages.map(o => o.n); return res;
}
