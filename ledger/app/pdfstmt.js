/* Ledger Desk: read the transactions in a bank or credit card PDF statement.
   The PDF is read in this browser (pdf.js); nothing is sent anywhere. The text on each page is put back into lines,
   lines that start with a date and end with an amount become transactions, and the result is checked against the
   statement's own beginning and ending balance before anything is imported. */
(function (root) {
  'use strict';
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const MONEY = /^\(?-?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:-|CR|cr|DR|dr))?$/;
  const DATE = /^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/;
  const DATE_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;
  const r2 = n => Math.round(n * 100) / 100;
  const money = s => { const neg = /^\(|-|\)$|\bCR\b/i.test(s.replace(/^\$/, '')) && !/DR$/i.test(s); const v = Number(s.replace(/[^\d.]/g, '')); return { v, neg, cr: /CR$/i.test(s.trim()) }; };

  // ---- sections: which way the money goes ----
  const SKIP = /daily (ending )?balance|balance summary|ending daily|summary of (your )?account|account summary|interest charge calculation|year.to.date totals|fees? summary|total for this period|overdraft and returned item fees|important information|rewards summary/i;
  const IN = /deposits?|credits?|additions|payments?(,| and)? (and other )?credits|refunds|money in|interest (paid|earned)/i;
  const OUT = /withdrawals?|debits?|checks? paid|checks? cleared|checks in (number|check) order|purchases?|new charges|charges|fees charged|interest charged|electronic payments|payments? (and|&) (other )?debits|money out|card activity|atm|subtractions/i;
  const CHECKS = /checks? (paid|cleared)|checks in (number|check) order|^checks$/i;

  // tokens → text lines; tokens are { x, w, str }
  function parse(lines, opts) {
    opts = opts || {};
    const text = lines.map(l => l.tokens.map(t => t.str).join(' ')).join('\n');
    const kind = /credit card|card ?member|minimum payment|credit (limit|line)|new balance|payment due date|cash advance/i.test(text) && !/checking|savings account|money market/i.test(text.slice(0, 3000)) ? 'credit' : 'bank';
    // statement period → years for M/D dates
    let pEnd = null, pStart = null;
    const wordDate = s => { const m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s); return m ? [Number(m[3]), MON[m[1].toLowerCase().slice(0, 3)], Number(m[2])] : null; };
    const numDate = s => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s); return m ? [Number(m[3].length === 2 ? '20' + m[3] : m[3]), Number(m[1]), Number(m[2])] : null; };
    {
      const per = /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:-|–|—|to|through|thru)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(text);
      if (per) { pStart = wordDate(per[1]) || numDate(per[1]); pEnd = wordDate(per[2]) || numDate(per[2]); }
      if (!pEnd) { const m = /(statement|closing|ending|period ending|as of)\s*(date)?:?\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(text); if (m) pEnd = wordDate(m[3]) || numDate(m[3]); }
    }
    const endY = pEnd ? pEnd[0] : (opts.year || new Date().getFullYear()), endM = pEnd ? pEnd[1] : 12;
    const iso = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const toDate = (m, d, y) => { if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null; y = y ? Number(String(y).length === 2 ? '20' + y : y) : (m > endM ? endY - 1 : endY); return iso(y, m, d); };
    // balances
    const amtAfter = re => {
      for (const l of lines) {
        const s = l.tokens.map(t => t.str).join(' '), m = re.exec(s); if (!m) continue;
        const rest = s.slice(m.index + m[0].length), ms = rest.match(/\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?CR)?/g);
        if (ms) { const x = money(ms[0]); return x.neg ? -x.v : x.v; }
      }
      return null;
    };
    const begin = amtAfter(/\b(beginning|previous|opening|starting|prior) (statement )?balance\b|balance (last|previous) statement|balance forward/i);
    const end = amtAfter(/\b(ending|new|closing) (statement )?balance\b|balance (this|on this) statement/i);
    // account number (last 4)
    let last4 = '';
    { const m = /(?:account|acct|card)\s*(?:number|no\.?|#)?\s*(?:ending(?: in)?)?\s*:?\s*([0-9xX*•.\-\s]{4,30})/i.exec(text); if (m) { const dg = m[1].replace(/\D/g, ''); if (dg.length >= 4) last4 = dg.slice(-4); } }
    const bankName = (/(american express|chase|citi(?:bank)?|capital one|discover|wells fargo|bank of america|us bank|pnc|fifth third|first (?:national )?bank|old national|german american|peoples bank|field & main|synchrony|barclays)/i.exec(text.slice(0, 2500)) || [])[1] || '';

    // column headers: x ranges for money out / money in / balance
    let cols = null, section = '', inChecks = false, skip = false;
    const txns = [], warn = [];
    const isMoney = t => MONEY.test(t.str.trim());
    const center = t => t.x + (t.w || 0) / 2;
    for (const l of lines) {
      const toks = l.tokens.filter(t => t.str.trim());
      if (!toks.length) continue;
      const s = toks.map(t => t.str).join(' ').trim();
      const firstIsDate = DATE.test(toks[0].str.trim()) || (DATE_WORD.test(toks[0].str.trim()) && toks[1] && /^\d{1,2}$/.test(toks[1].str.trim()));
      const amts = toks.filter(isMoney);
      // a header row with column names
      if (!firstIsDate && /(withdrawal|debit|charge|payment|subtraction|amount)/i.test(s) && /(deposit|credit|addition|balance|amount)/i.test(s) && /date/i.test(s) && !amts.length) {
        const find = re => toks.filter(t => re.test(t.str)).map(center);
        const o = find(/withdrawal|debit|charges?|subtraction|payments? ?(made)?$/i), i = find(/deposit|credit|addition/i), b = find(/balance/i), a = find(/^amount$/i);
        cols = { out: o[0], in: i[0], bal: b[0], amt: a[0] };
        if (/check (no|number|#)/i.test(s)) inChecks = true;
        continue;
      }
      if (!firstIsDate) {
        if (SKIP.test(s)) { skip = true; section = ''; continue; }
        if (s.length < 80 && !amts.length) {
          if (CHECKS.test(s)) { section = 'out'; inChecks = true; skip = false; cols = null; continue; }
          if (OUT.test(s) && !/total/i.test(s)) { section = 'out'; inChecks = false; skip = false; continue; }
          if (IN.test(s) && !/total/i.test(s)) { section = 'in'; inChecks = false; skip = false; continue; }
        }
        // continuation of the last transaction's description
        if (!amts.length && txns.length && !skip && l.page === txns[txns.length - 1]._page && Math.abs(l.y - txns[txns.length - 1]._y) < 30 && s.length < 90 && !/page \d|continued|total|denotes|^\*/i.test(s)) {
          const t = txns[txns.length - 1]; t.memo = (t.memo ? t.memo + ' ' : '') + s;
        }
        continue;
      }
      if (skip || !amts.length) continue;
      if (/^(total|subtotal)/i.test(s.replace(/^[\d\/\-\s]+/, ''))) continue;
      // several checks on one line: date, number, amount, date, number, amount…
      const plain = toks.map(t => t.str.trim());
      const triples = [];
      for (let i = 0; i + 2 < plain.length;) {
        if (DATE.test(plain[i]) && /^\d{2,7}\*?$/.test(plain[i + 1]) && MONEY.test(plain[i + 2])) { triples.push([plain[i], plain[i + 1].replace('*', ''), plain[i + 2]]); i += 3; }
        else if (/^\d{2,7}\*?$/.test(plain[i]) && DATE.test(plain[i + 1]) && MONEY.test(plain[i + 2])) { triples.push([plain[i + 1], plain[i].replace('*', ''), plain[i + 2]]); i += 3; }
        else i++;
      }
      if (triples.length && (inChecks || triples.length > 1) && triples.length * 3 >= plain.length - 1) {
        triples.forEach(([d, n, a]) => { const m = DATE.exec(d), dt = toDate(+m[1], +m[2], m[3]), x = money(a); if (dt) txns.push({ date: dt, payee: 'CHECK ' + n, memo: '', amount: -x.v, checkNum: n, _page: l.page, _y: l.y, how: 'checks' }); });
        continue;
      }
      // one transaction: date [date] description … amount [balance]
      let k = 0, date;
      if (DATE.test(plain[0])) { const m = DATE.exec(plain[0]); date = toDate(+m[1], +m[2], m[3]); k = 1; if (plain[1] && DATE.test(plain[1])) k = 2; }
      else { const mo = MON[plain[0].toLowerCase().replace('.', '').slice(0, 3)]; date = toDate(mo, +plain[1]); k = 2; }
      if (!date) continue;
      const amtIdx = toks.map((t, i) => isMoney(t) ? i : -1).filter(i => i >= k);
      if (!amtIdx.length) continue;
      const desc = toks.slice(k, amtIdx[0]).map(t => t.str.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
      if (!desc && !inChecks) continue;
      let amtTok = toks[amtIdx[0]], balTok = null;
      if (amtIdx.length >= 2) { balTok = toks[amtIdx[amtIdx.length - 1]]; amtTok = toks[amtIdx[amtIdx.length - 2]]; }
      const x = money(amtTok.str);
      let sign = 0, how = '';
      if (cols && (cols.out != null || cols.in != null)) {
        const c = center(amtTok), dOut = cols.out != null ? Math.abs(c - cols.out) : 1e9, dIn = cols.in != null ? Math.abs(c - cols.in) : 1e9, dBal = cols.bal != null ? Math.abs(c - cols.bal) : 1e9;
        if (amtIdx.length === 1 && dBal < Math.min(dOut, dIn)) continue; // only a balance on this line
        if (Math.min(dOut, dIn) < 200) { sign = dOut < dIn ? -1 : 1; how = 'column'; }
      }
      if (!sign && x.neg) { sign = kind === 'credit' ? 1 : -1; how = 'sign'; }
      if (!sign && kind === 'bank' && /^\s*-|\(/.test(amtTok.str)) { sign = -1; how = 'sign'; }
      if (!sign && section) { sign = (section === 'in') === (kind === 'bank') ? 1 : -1; if (kind === 'credit') sign = section === 'in' ? 1 : -1; how = 'section'; }
      if (!sign) { sign = /deposit|credit|refund|interest paid|transfer from|payment.*thank|thank you/i.test(desc) ? 1 : -1; how = 'words'; }
      const chk = /^(check|chk|ck)\s*#?\s*(\d{2,7})$/i.exec(desc) || (inChecks && /^(\d{2,7})\*?$/.exec(desc) ? [null, null, desc.replace('*', '')] : null);
      txns.push({ date, payee: chk ? 'CHECK ' + chk[2] : desc, memo: '', amount: sign * x.v, checkNum: chk ? chk[2] : '', bal: balTok ? (money(balTok.str).neg ? -money(balTok.str).v : money(balTok.str).v) : null, _page: l.page, _y: l.y, how });
    }
    // a running balance column fixes any sign we guessed
    const withBal = txns.filter(t => t.bal != null);
    if (withBal.length >= Math.max(2, txns.length * 0.7) && begin != null) {
      let prev = begin, fixed = 0;
      txns.forEach(t => { if (t.bal == null) return; const d = r2(t.bal - prev); if (Math.abs(Math.abs(d) - Math.abs(t.amount)) < 0.005 && Math.sign(d) !== Math.sign(t.amount) && d !== 0) { t.amount = d; fixed++; } prev = t.bal; });
      if (fixed) warn.push(fixed + ' sign(s) corrected from the running balance');
    }
    // check the math: begin + money in − money out = end (cards: charges raise what you owe)
    const sum = r2(txns.reduce((s, t) => s + t.amount, 0));
    let diff = null;
    if (begin != null && end != null) diff = kind === 'credit' ? r2(end - (begin - sum)) : r2(end - (begin + sum));
    txns.forEach(t => { delete t._page; delete t._y; delete t.bal; });
    const dates = txns.map(t => t.date).sort();
    return { kind, last4, bankName, begin, end, diff, ok: diff != null && Math.abs(diff) < 0.01, txns, from: dates[0] || '', to: dates[dates.length - 1] || '', periodEnd: pEnd ? iso(pEnd[0], pEnd[1], pEnd[2]) : '', warn, text: text.length };
  }

  // ---- opening a PDF, repairing a broken page tree if needed ----
  const DAMAGED = 'This PDF is damaged and couldn\'t be read. Open it in Chrome and use Print → Save as PDF, then upload the new file.';
  const docOpts = () => { const o = { isEvalSupported: false, useWasm: false }; try { if (typeof document !== 'undefined') o.wasmUrl = new URL('vendor/wasm/', document.baseURI).href; } catch (e) {} return o; };
  const toLatin = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
  const fromLatin = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
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
  function repairPdf(u8) {
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
  // Open a PDF with pdf.js. A damaged page tree is repaired and retried once. Returns { doc, bytes, repaired }.
  async function openPdf(file, lib, bytes) {
    bytes = bytes || new Uint8Array(await file.arrayBuffer());
    const tryOpen = async b => { const doc = await lib.getDocument(Object.assign({ data: b.slice() }, docOpts())).promise; if (!doc.numPages) throw new Error('no pages'); await doc.getPage(1); return doc; };
    let err;
    try { return { doc: await tryOpen(bytes), bytes, repaired: false }; } catch (e) { err = e; }
    if (err && (err.name === 'PasswordException' || /password/i.test(err.message || ''))) throw new Error('This PDF is password-protected. Open it, remove the password (Print → Save as PDF), then upload the new file.');
    let fixed = null; try { fixed = repairPdf(bytes); } catch (e) {}
    if (fixed) { try { return { doc: await tryOpen(fixed), bytes: fixed, repaired: true }; } catch (e) {} }
    throw new Error(DAMAGED);
  }
  // ---- pdf.js text → lines ----
  async function readPages(doc) {
    const pageItems = [], bad = [], refs = new Set();
    for (let p = 1; p <= doc.numPages; p++) {
      try { const page = await doc.getPage(p); if (page.ref) refs.add(page.ref.num); pageItems.push((await page.getTextContent()).items.filter(i => i.str && i.str.trim())); }
      catch (e) { pageItems.push(null); bad.push(p); }
    }
    return { pageItems, bad, refs };
  }
  async function readLines(file, lib) {
    let { doc, bytes, repaired } = await openPdf(file, lib);
    let got = await readPages(doc);
    // Some pages failed, or the page list disagrees with the page objects in the file (pdf.js can quietly skip a page when the list is wrong):
    // read it again from a repaired copy and keep whichever copy gave more pages with text.
    const score = g => g.pageItems.filter(i => i && i.length).length;
    if (!repaired) {
      try {
        const fixed = repairPdf(bytes);
        if (fixed && (got.bad.length || fixed.pageNums.some(n => !got.refs.has(n)))) {
          const d2 = await openPdf(file, lib, fixed), g2 = await readPages(d2.doc);
          if (g2.bad.length < got.bad.length || (g2.bad.length === got.bad.length && score(g2) > score(got))) { doc = d2.doc; got = g2; repaired = true; }
        }
      } catch (e) {}
    }
    const lines = [], warn = got.bad.map(p => 'Page ' + p + ' of this PDF couldn\'t be read, check those transactions.');
    if (got.bad.length === doc.numPages) throw new Error(DAMAGED);
    if (repaired) warn.unshift('This PDF had a damaged page list and was repaired while reading. Check the totals.');
    got.pageItems.forEach((items, idx) => {
      if (!items) return; const p = idx + 1;
      const rows = [];
      items.forEach(i => { const y = i.transform[5], x = i.transform[4]; let r = rows.find(r => Math.abs(r.y - y) < 2.5); if (!r) rows.push(r = { y, items: [] }); r.items.push({ x, w: i.width || 0, str: i.str }); });
      rows.sort((a, b) => b.y - a.y).forEach(r => {
        r.items.sort((a, b) => a.x - b.x);
        // merge pieces that touch, split pieces that hold several columns
        const toks = [];
        r.items.forEach(it => {
          const parts = it.str.split(/\s{2,}/), cw = it.w / Math.max(1, it.str.length);
          let off = 0;
          parts.forEach(pt => { const at = it.str.indexOf(pt, off); off = at + pt.length; const t = { x: it.x + at * cw, w: pt.length * cw, str: pt }; const last = toks[toks.length - 1];
            if (last && t.x - (last.x + last.w) < 1.5 && !MONEY.test(t.str.trim()) && !MONEY.test(last.str.trim())) { last.str += t.str; last.w = t.x + t.w - last.x; } else toks.push(t); });
        });
        lines.push({ page: p, y: 1e4 - r.y, tokens: toks.map(t => ({ x: t.x, w: t.w, str: t.str.trim() })).filter(t => t.str) });
      });
    });
    return { lines, pages: doc.numPages, warn };
  }
  async function readStatement(file, lib) {
    const { lines, pages, warn } = await readLines(file, lib);
    const r = parse(lines);
    r.pages = pages;
    if (warn.length) r.warn = warn.concat(r.warn || []);
    return r;
  }
  root.LedgerPdfStatement = { parse, readStatement, openPdf, repairPdf };
})(typeof window !== 'undefined' ? window : globalThis);
