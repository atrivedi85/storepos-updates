/* Ledger Desk: restore a company from QuickBooks exports (Desktop or Online).
   Reads the Chart of Accounts list and the Journal report (.xlsx, .csv or .iif) and
   turns them into Ledger Desk books. No DOM here, so it also runs in Node for testing. */
(function (root) {
  'use strict';

  // ---------------- small helpers ----------------
  const r2 = n => Math.round(n * 100) / 100;
  const str = v => (v == null ? '' : String(v)).replace(/ /g, ' ').trim();
  const pad = n => String(n).padStart(2, '0');
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function toDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial date (1900 system)
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    const s = str(v);
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(s);
    if (m) { let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900; return y + '-' + pad(+m[1]) + '-' + pad(+m[2]); }
    m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s);
    if (m && MONTHS[m[1].toLowerCase()]) return m[3] + '-' + pad(MONTHS[m[1].toLowerCase()]) + '-' + pad(+m[2]);
    m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2,4})$/.exec(s);
    if (m && MONTHS[m[2].toLowerCase()]) { let y = +m[3]; if (y < 100) y += 2000; return y + '-' + pad(MONTHS[m[2].toLowerCase()]) + '-' + pad(+m[1]); }
    if (/^\d{5}(\.0+)?$/.test(s)) return toDate(+s);
    return '';
  }
  function toAmount(v) {
    if (typeof v === 'number') return r2(v);
    let s = str(v);
    if (!s) return 0;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
    s = s.replace(/[$,\s]/g, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    const n = parseFloat(s);
    if (isNaN(n)) return 0;
    return r2(neg ? -n : n);
  }

  // ---------------- file readers ----------------
  function parseCSV(text, delim) {
    text = text.replace(/^﻿/, '');
    if (!delim) {
      const first = text.split(/\r?\n/).slice(0, 10).join('\n');
      delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
    }
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Minimal .xlsx reader: unzip with the built-in DecompressionStream, then read the sheet XML.
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  async function unzip(buf, want) {
    const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This Excel file looks damaged. Save it again from QuickBooks.');
    const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const files = {}, dec = new TextDecoder();
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (!want(name)) continue;
      const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true);
      const data = b.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
      files[name] = dec.decode(method === 0 ? data : await inflateRaw(data));
    }
    return files;
  }
  const xmlText = s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
  const colIndex = ref => { const L = /^[A-Z]+/.exec(ref)[0]; let n = 0; for (const ch of L) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  async function readXLSX(buf) {
    const files = await unzip(buf, n => /^xl\/(sharedStrings\.xml|workbook\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)$/.test(n));
    const shared = [];
    const ss = files['xl/sharedStrings.xml'] || '';
    (ss.match(/<si>[\s\S]*?<\/si>/g) || []).forEach(si => {
      const parts = []; si.replace(/<t[^>]*>([\s\S]*?)<\/t>/g, (_, t) => { parts.push(t); return ''; });
      shared.push(xmlText(parts.join('')));
    });
    // Sheets in workbook order, with their names
    const order = [];
    const wb = files['xl/workbook.xml'] || '', rels = files['xl/_rels/workbook.xml.rels'] || '';
    const relMap = {}; rels.replace(/<Relationship\b[^>]*>/g, r => { const id = /Id="([^"]+)"/.exec(r), t = /Target="([^"]+)"/.exec(r); if (id && t) relMap[id[1]] = 'xl/' + t[1].replace(/^\/?xl\//, '').replace(/^\//, ''); return ''; });
    wb.replace(/<sheet\b[^>]*>/g, s => { const nm = /name="([^"]*)"/.exec(s), rid = /r:id="([^"]+)"/.exec(s); if (rid && relMap[rid[1]]) order.push({ name: xmlText(nm ? nm[1] : ''), path: relMap[rid[1]] }); return ''; });
    if (!order.length) Object.keys(files).filter(k => /worksheets\//.test(k)).sort().forEach(k => order.push({ name: k, path: k }));
    return order.filter(o => files[o.path]).map(o => {
      const rows = [];
      (files[o.path].match(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || []).forEach(rx => {
        const rn = /\br="(\d+)"/.exec(rx); const ri = rn ? +rn[1] - 1 : rows.length;
        const row = [];
        (rx.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []).forEach(cx => {
          const ref = /\br="([A-Z]+)\d+"/.exec(cx); const ci = ref ? colIndex(ref[1]) : row.length;
          const t = (/\bt="([^"]+)"/.exec(cx) || [])[1] || 'n';
          const v = /<v>([\s\S]*?)<\/v>/.exec(cx);
          let val = '';
          if (t === 's') val = v ? shared[+v[1]] || '' : '';
          else if (t === 'inlineStr') { const parts = []; cx.replace(/<t[^>]*>([\s\S]*?)<\/t>/g, (_, x) => { parts.push(x); return ''; }); val = xmlText(parts.join('')); }
          else if (t === 'str' || t === 'e') val = v ? xmlText(v[1]) : '';
          else if (t === 'b') val = v ? v[1] === '1' : '';
          else val = v ? parseFloat(v[1]) : '';
          row[ci] = val;
        });
        for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
        rows[ri] = row;
      });
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      return { name: o.name, rows };
    });
  }

  // ---------------- account types ----------------
  function mapType(qbType) {
    const t = str(qbType).toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (/non.?posting/.test(t)) return { skip: true };
    if (/receivable|^ar$/.test(t)) return { type: 'asset', detail: 'other' };
    if (/payable|^ap$/.test(t)) return { type: 'liability', detail: 'other' };
    if (/credit ?card|^ccard$/.test(t)) return { type: 'liability', detail: 'credit' };
    if (/long.?term|^ltliab$/.test(t)) return { type: 'liability', detail: 'loan' };
    if (/liab/.test(t)) return { type: 'liability', detail: 'other' };
    if (/^bank|checking|savings|money market/.test(t)) return { type: 'asset', detail: 'bank' };
    if (/asset/.test(t)) return { type: 'asset', detail: 'other' };
    if (/equity/.test(t)) return { type: 'equity', detail: 'other' };
    if (/cost of goods|cogs|expense|^exp$|^exexp$/.test(t)) return { type: 'expense', detail: 'other' };
    if (/income|revenue|^inc$|^exinc$/.test(t)) return { type: 'income', detail: 'other' };
    return null;
  }
  // When an account is only in the Journal, guess its type from its name (shown to the user to check)
  function guessType(name) {
    const n = name.toLowerCase();
    if (/receivable/.test(n)) return { type: 'asset', detail: 'other' };
    if (/payable|liabilit|accrued|withholding/.test(n)) return { type: 'liability', detail: 'other' };
    if (/loan|mortgage|line of credit|\bloc\b|\bnote\b/.test(n)) return { type: 'liability', detail: 'loan' };
    if (/credit card|\bcard\b|visa|mastercard|amex|american express|discover/.test(n)) return { type: 'liability', detail: 'credit' };
    if (/charge|fee|expense|cost|suppl|repair|maint|utilit|payroll|wage|salar|rent|insurance|advertis|\btax|interest exp|travel|meal|depreciation exp|commission|cleaning|laundry|software|telephone|internet/.test(n)) return { type: 'expense', detail: 'other' };
    if (/checking|savings|bank|petty cash|cash on hand|money market/.test(n)) return { type: 'asset', detail: 'bank' };
    if (/undeposited|equipment|furniture|vehicle|building|land|depreciation|inventory|prepaid|deposit|asset/.test(n)) return { type: 'asset', detail: 'other' };
    if (/equity|capital|draw|distribution|retained|contribution|owner/.test(n)) return { type: 'equity', detail: 'other' };
    if (/income|sales|revenue|earned|refund|rental/.test(n)) return { type: 'income', detail: 'other' };
    return { type: 'expense', detail: 'other' };
  }
  // Find the header row: the first row (in the top 30) that has all the wanted columns
  const norm = s => str(s).toLowerCase().replace(/\s+/g, ' ');
  function findCol(hdr, patterns) {
    for (const re of patterns) { const i = hdr.findIndex(h => re.test(h)); if (i >= 0) return i; }
    return -1;
  }
  function titleRows(rows, hdrIdx) {
    const out = [];
    for (let i = 0; i < hdrIdx && i < 8; i++) { const v = (rows[i] || []).map(str).filter(Boolean); if (v.length === 1 || (v.length && v.length <= 2)) out.push(v[0]); }
    return out;
  }
  function companyFromTitles(titles) {
    return titles.find(t => !/journal|account list|accounts list|account listing|chart of accounts|general ledger|^all dates|^as of|^\w+ \d{1,2}(,| -)|\d{4}|^accrual|^cash basis|^transactions/i.test(t)) || '';
  }
  function asOfFromTitles(titles) {
    for (const t of titles) { const m = /as of (.+)$/i.exec(t); if (m) { const d = toDate(m[1].trim()); if (d) return d; } }
    return '';
  }

  // ---------------- Chart of Accounts list ----------------
  function parseAccountRows(rows) {
    for (let h = 0; h < Math.min(rows.length, 30); h++) {
      const hdr = (rows[h] || []).map(norm);
      const cName = findCol(hdr, [/^account$/, /^full ?name$/, /^account name$/, /^name$/]);
      const cType = findCol(hdr, [/^type$/, /^account type$/]);
      if (cName < 0 || cType < 0) continue;
      if (hdr.some(x => /^debit$/.test(x))) continue; // that's a journal
      const cBal = findCol(hdr, [/^balance total$/, /^balance$/, /^quickbooks balance$/, /^total balance$/, /^current balance$/]);
      const cNum = findCol(hdr, [/^accnt\.? ?#$/, /^account ?#$/, /^number$/, /^account number$/, /^acct ?#$/]);
      const cDesc = findCol(hdr, [/^description$/]);
      const cDetail = findCol(hdr, [/^detail type$/]);
      const accounts = [];
      for (let i = h + 1; i < rows.length; i++) {
        const r = rows[i] || [];
        const name = str(r[cName]), qbType = str(r[cType]);
        if (!name || !qbType) continue;
        if (/^total\b/i.test(name)) continue;
        const mt = mapType(qbType);
        if (!mt) continue;
        if (mt.skip) continue;
        const a = { name: name.replace(/\s*:\s*/g, ':'), qbType, type: mt.type, detail: mt.detail, number: cNum >= 0 ? str(r[cNum]) : '', description: cDesc >= 0 ? str(r[cDesc]) : '' };
        if (cDetail >= 0 && mt.type === 'asset' && /checking|savings|money market|cash on hand/i.test(str(r[cDetail]))) a.detail = 'bank';
        if (cBal >= 0 && str(r[cBal]) !== '') a.balance = toAmount(r[cBal]);
        accounts.push(a);
      }
      if (accounts.length) {
        const titles = titleRows(rows, h);
        return { kind: 'accounts', accounts, company: companyFromTitles(titles), asOf: asOfFromTitles(titles), hasBalances: cBal >= 0 };
      }
    }
    return null;
  }
  function parseIIF(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.split('\t'));
    let accHdr = null, trnsHdr = null, splHdr = null;
    const accounts = [], groups = []; let cur = null;
    lines.forEach(c => {
      const tag = str(c[0]).toUpperCase();
      if (tag === '!ACCNT') { accHdr = c.map(x => str(x).toUpperCase()); return; }
      if (tag === '!TRNS') { trnsHdr = c.map(x => str(x).toUpperCase()); return; }
      if (tag === '!SPL') { splHdr = c.map(x => str(x).toUpperCase()); return; }
      if (tag === 'ACCNT' && accHdr) {
        const get = k => str(c[accHdr.indexOf(k)]);
        const mt = mapType(get('ACCNTTYPE'));
        if (!mt || mt.skip || !get('NAME')) return;
        accounts.push({ name: get('NAME'), qbType: get('ACCNTTYPE'), type: mt.type, detail: mt.detail, number: get('ACCNUM'), description: get('DESC') });
        return;
      }
      if ((tag === 'TRNS' || tag === 'SPL') && (tag === 'TRNS' ? trnsHdr : splHdr)) {
        const h = tag === 'TRNS' ? trnsHdr : splHdr, get = k => h.indexOf(k) >= 0 ? str(c[h.indexOf(k)]) : '';
        if (tag === 'TRNS') { cur = { date: toDate(get('DATE')), type: get('TRNSTYPE'), num: get('DOCNUM'), name: get('NAME'), memo: get('MEMO'), lines: [] }; groups.push(cur); }
        if (!cur) return;
        const amt = toAmount(get('AMOUNT'));
        if (get('ACCNT') && amt) cur.lines.push({ account: get('ACCNT'), debit: amt, name: get('NAME'), memo: get('MEMO') });
        return;
      }
      if (tag === 'ENDTRNS') cur = null;
    });
    const out = [];
    if (accounts.length) out.push({ kind: 'accounts', accounts, company: '', asOf: '', hasBalances: false });
    if (groups.length) out.push(finishJournal(groups, ''));
    return out;
  }

  // ---------------- Journal report ----------------
  function parseJournalRows(rows) {
    for (let h = 0; h < Math.min(rows.length, 30); h++) {
      const hdr = (rows[h] || []).map(norm);
      const cAcct = findCol(hdr, [/^account$/, /^account full name$/, /^distribution account$/, /^account name$/, /^full name$/, /^split account$/, /^account #$/]);
      const cDr = findCol(hdr, [/^debit$/, /^debits$/]), cCr = findCol(hdr, [/^credit$/, /^credits$/]);
      const cAmt = findCol(hdr, [/^amount$/]);
      if (cAcct < 0 || ((cDr < 0 || cCr < 0) && cAmt < 0)) continue;
      const cDate = findCol(hdr, [/^date$/, /^transaction date$/, /^trans date$/, /^txn date$/]);
      if (cDate < 0) continue;
      const cTrans = findCol(hdr, [/^trans ?#$/, /^trans no\.?$/, /^transaction id$/, /^transaction #$/]);
      const cType = findCol(hdr, [/^type$/, /^transaction type$/]);
      const cNum = findCol(hdr, [/^num$/, /^no\.?$/, /^#$/, /^ref ?no\.?$/, /^check ?#$/, /^doc ?num$/]);
      const cName = findCol(hdr, [/^name$/, /^payee$/, /^customer\/vendor$/, /^vendor$/, /^customer$/]);
      const cMemo = findCol(hdr, [/^memo$/, /^memo\/description$/, /^description$/, /^line description$/]);
      const groups = []; let cur = null;
      const balanced = g => g && g.lines.length >= 2 && Math.abs(r2(g.lines.reduce((s, l) => s + l.debit, 0))) < 0.005;
      for (let i = h + 1; i < rows.length; i++) {
        const r = rows[i] || [];
        const account = str(r[cAcct]);
        const dr = cDr >= 0 ? toAmount(r[cDr]) : 0, cr = cCr >= 0 ? toAmount(r[cCr]) : 0;
        const debit = cDr >= 0 ? r2(dr - cr) : toAmount(r[cAmt]);
        const firstText = r.map(str).find(Boolean) || '';
        if (!account) { // total line, blank line, or a TOTAL row: closes the transaction
          if (cur && (dr || cr || !firstText || /^total/i.test(firstText))) cur = null;
          continue;
        }
        if (/^total\b/i.test(firstText) && !str(r[cDate])) { cur = null; continue; }
        const trans = cTrans >= 0 ? str(r[cTrans]) : '';
        const date = toDate(r[cDate]);
        let start = false;
        if (!cur) start = true;
        else if (cTrans >= 0 && trans && trans !== cur.trans) start = true;
        else if (!(cTrans >= 0 && trans) && date && balanced(cur)) start = true;
        if (start) {
          cur = { trans, date: date || (cur ? cur.date : ''), type: cType >= 0 ? str(r[cType]) : '', num: cNum >= 0 ? str(r[cNum]) : '', name: cName >= 0 ? str(r[cName]) : '', memo: '', lines: [] };
          groups.push(cur);
        } else {
          if (!cur.date && date) cur.date = date;
          if (!cur.type && cType >= 0) cur.type = str(r[cType]);
          if (!cur.num && cNum >= 0) cur.num = str(r[cNum]);
          if (!cur.name && cName >= 0) cur.name = str(r[cName]);
        }
        if (!debit) continue;
        cur.lines.push({ account: account.replace(/\s*:\s*/g, ':'), debit, name: cName >= 0 ? str(r[cName]) : '', memo: cMemo >= 0 ? str(r[cMemo]) : '' });
      }
      const titles = titleRows(rows, h);
      return finishJournal(groups, companyFromTitles(titles));
    }
    return null;
  }
  function finishJournal(groups, company) {
    const ok = [], unbalanced = [];
    groups.forEach(g => {
      g.lines = g.lines.filter(l => l.debit);
      if (!g.lines.length) return;
      const sum = r2(g.lines.reduce((s, l) => s + l.debit, 0));
      if (!g.date || Math.abs(sum) >= 0.005) { g.off = sum; unbalanced.push(g); } else ok.push(g);
    });
    const dates = ok.map(g => g.date).sort();
    return { kind: 'journal', groups: ok, unbalanced, company, from: dates[0] || '', to: dates[dates.length - 1] || '' };
  }

  // ---------------- read any QuickBooks export ----------------
  async function readExport(name, buf) {
    const lower = name.toLowerCase();
    if (/\.(qbb|qbw|qbm|qbx|tlg|nd|qba)$/.test(lower)) throw new Error('QuickBooks backup files (' + lower.split('.').pop().toUpperCase() + ') can only be opened by QuickBooks itself. Export the Chart of Accounts and the Journal report instead (see the steps on this screen).');
    if (/\.xls$/.test(lower)) throw new Error('This is an old-style Excel file (.xls). In Excel choose File > Save As > Excel Workbook (.xlsx), or export from QuickBooks as CSV.');
    if (/\.(qbo|qfx|ofx)$/.test(lower)) throw new Error('This is a bank statement file. Use Import .QBO for it.');
    let tables = [];
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) tables = (await readXLSX(buf)).map(s => s.rows);
    else {
      const text = new TextDecoder().decode(bytes);
      if (/^﻿?!(ACCNT|TRNS|HDR|CUST|VEND)/m.test(text.slice(0, 4000))) {
        const res = parseIIF(text);
        if (!res.length) throw new Error('No accounts or transactions were found in this .IIF file.');
        return res;
      }
      tables = [parseCSV(text)];
    }
    for (const rows of tables) {
      const j = parseJournalRows(rows); if (j && j.groups.length + j.unbalanced.length) return [j];
      const a = parseAccountRows(rows); if (a) return [a];
    }
    throw new Error('This file is not a QuickBooks Chart of Accounts or Journal report. Check the export steps on this screen.');
  }

  // ---------------- build the books ----------------
  // parts: results from readExport. helpers: { uid, freshSystemAccounts } from the app.
  function build(parts, opts) {
    const uid = opts.uid;
    const accLists = parts.filter(p => p.kind === 'accounts'), journals = parts.filter(p => p.kind === 'journal');
    const accounts = [], byKey = {}, report = { guessed: [], adjustments: [], unbalanced: [], accounts: 0, txns: 0, compare: [] };
    const key = s => str(s).toLowerCase().replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ');
    const stripNum = s => str(s).replace(/^\d[\d.\-]*\s*(·|•|-|–)?\s+/, '');
    const leafName = s => { const p = s.split(':'); return p[p.length - 1]; };
    const leafCount = {};
    function addAccount(src, guessed) {
      const name = stripNum(src.name) || src.name;
      if (byKey[key(name)]) return byKey[key(name)];
      const a = { id: uid(), name: name.replace(/:/g, ': '), type: src.type, detail: src.detail, sys: '' };
      if (src.number) a.qbNumber = src.number;
      if (src.description) a.description = src.description;
      accounts.push(a);
      byKey[key(name)] = a;
      if (src.number) { byKey[key(src.number + ' ' + name)] = a; byKey[key(src.number + ' · ' + name)] = a; byKey[key(src.number)] = byKey[key(src.number)] || a; }
      const lf = key(leafName(name)); leafCount[lf] = (leafCount[lf] || 0) + 1; if (leafCount[lf] === 1) byKey['leaf:' + lf] = a; else delete byKey['leaf:' + lf];
      if (guessed) report.guessed.push(a);
      return a;
    }
    accLists.forEach(l => l.accounts.forEach(a => addAccount(a, false)));
    function find(name) {
      const k = key(name);
      return byKey[k] || byKey[key(stripNum(name))] || byKey['leaf:' + key(leafName(stripNum(name)))] || null;
    }
    // Ledger Desk's own system accounts: reuse QuickBooks' matching ones when the type fits
    function sysAccount(sys, name, type) {
      let a = accounts.find(x => x.name.toLowerCase() === name.toLowerCase() && x.type === type);
      if (!a) {
        let nm = name; if (accounts.some(x => x.name.toLowerCase() === nm.toLowerCase())) nm += ' (Ledger Desk)';
        a = { id: uid(), name: nm, type, detail: 'other', sys };
        accounts.push(a);
        if (!byKey[key(nm)]) byKey[key(nm)] = a; // so Journal lines with this name use it
      }
      a.sys = sys; return a;
    }
    const obe = sysAccount('obe', 'Opening Balance Equity', 'equity');
    sysAccount('deposits', 'Bank Deposits (not income)', 'liability');
    sysAccount('uncatIn', 'Uncategorized Money In', 'equity');
    sysAccount('uncatOut', 'Uncategorized Expense', 'expense');

    const txns = []; let seq = 1;
    const isReg = a => a.type === 'asset' || a.type === 'liability';
    journals.forEach(j => {
      report.unbalanced = report.unbalanced.concat(j.unbalanced);
      j.groups.forEach(g => {
        // account for every line (create missing ones from the name)
        const lines = g.lines.map(l => { let a = find(l.account); if (!a) a = addAccount(Object.assign({ name: l.account }, guessType(stripNum(l.account))), true); return Object.assign({}, l, { acc: a }); });
        // pivot = the bank / card / loan side with the biggest amount (or the biggest line)
        const money = lines.filter(l => isReg(l.acc) && l.acc.detail !== 'other'); // bank, card, loan
        const regs = lines.filter(l => isReg(l.acc));
        const pool = money.length ? money : regs.length ? regs : lines;
        const pivot = pool.reduce((m, l) => Math.abs(l.debit) > Math.abs(m.debit) ? l : m, pool[0]);
        const label = g.type + (g.num ? ' #' + g.num : '');
        lines.forEach(l => {
          if (l === pivot || l.acc === pivot.acc) return; // same-account lines net into the pivot automatically
          txns.push({
            id: uid(), seq: seq++, date: g.date,
            payee: l.name || g.name || pivot.name || g.type || 'QuickBooks entry',
            memo: [l.memo || pivot.memo || g.memo, label].filter(Boolean).join(' · '),
            amount: r2(-l.debit), accountId: pivot.acc.id, categoryId: l.acc.id, source: 'qb'
          });
        });
      });
    });

    // Compare with the Chart of Accounts balances; add starting balances where QuickBooks has more history
    const deb = {};
    txns.forEach(t => { deb[t.accountId] = (deb[t.accountId] || 0) + t.amount; deb[t.categoryId] = (deb[t.categoryId] || 0) - t.amount; });
    const natural = (a, d) => r2((a.type === 'asset' || a.type === 'expense') ? (d || 0) : -(d || 0));
    const firstDate = txns.reduce((m, t) => !m || t.date < m ? t.date : m, '');
    const asOf = (accLists.find(l => l.asOf) || {}).asOf || opts.today;
    const dayBefore = d => { const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - 864e5); return x.getUTCFullYear() + '-' + pad(x.getUTCMonth() + 1) + '-' + pad(x.getUTCDate()); };
    const openDate = firstDate ? dayBefore(firstDate) : asOf;
    accLists.forEach(l => l.accounts.forEach(src => {
      if (src.balance == null) return;
      const a = find(src.name); if (!a || !isReg(a)) return;
      const have = natural(a, deb[a.id]);
      const diff = r2(src.balance - have);
      report.compare.push({ account: a, qb: src.balance, restored: have, diff });
      if (Math.abs(diff) < 0.005 || opts.skipOpening) return;
      const debit = a.type === 'asset' ? diff : -diff;
      txns.push({ id: uid(), seq: 0, date: openDate, payee: 'Opening balance', memo: 'Starting balance from the QuickBooks Chart of Accounts', amount: r2(debit), accountId: a.id, categoryId: obe.id, source: 'opening' });
      report.adjustments.push({ account: a, amount: diff, date: openDate });
    }));
    report.accounts = accounts.length;
    report.txns = txns.length;
    report.from = firstDate; report.to = txns.reduce((m, t) => t.date > m ? t.date : m, '');
    const company = str(opts.company) || (journals.find(j => j.company) || accLists.find(l => l.company) || {}).company || 'My Company';
    return {
      books: { ver: 1, company, theme: opts.theme || 'system', accounts, txns, rules: [], deleted: [], migr1: true, migr2: true, restoredFromQB: opts.today },
      report
    };
  }

  root.LedgerQB = { readExport, build, parseCSV, readXLSX, toDate, toAmount, mapType };
})(typeof window !== 'undefined' ? window : globalThis);
