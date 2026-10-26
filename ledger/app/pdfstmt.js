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

  // ---- pdf.js text → lines ----
  async function readLines(file, lib) {
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, wasmUrl: '/vendor/wasm/', useWasm: false }).promise;
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p), items = (await page.getTextContent()).items.filter(i => i.str && i.str.trim());
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
    }
    return { lines, pages: doc.numPages };
  }
  async function readStatement(file, lib) {
    const { lines, pages } = await readLines(file, lib);
    const r = parse(lines);
    r.pages = pages;
    return r;
  }
  root.LedgerPdfStatement = { parse, readStatement };
})(typeof window !== 'undefined' ? window : globalThis);
