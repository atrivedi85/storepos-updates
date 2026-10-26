/* Ledger Desk: read the check pictures in a bank's PDF statement.
   The PDF is opened in this browser (pdf.js, served from this Ledger Desk server). Each check picture is cut out
   and sent to the AI on the server PC, one at a time. Nothing changes in the books until you click Apply. */
(function () {
  'use strict';
  const L = window.ledgerDeskApp, SV = window.ledgerServer;
  if (!L || !SV || !L.viewState.ai) return;
  const { C, acts, afterRender, esc, money, usDate, toast, acc } = L;
  const ST = L.viewState.ai, S = () => L.S, H = () => ST.h || {};
  let PJ = null;
  async function pdfLib() {
    if (!PJ) { PJ = await import('/vendor/pdf.min.js'); PJ.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js'; }
    return PJ;
  }

  // ---- find picture boxes on a page from its drawing commands ----
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  function imageBoxes(ops, OPS, vp) {
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = [], out = [];
    const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject].filter(x => x != null));
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, Array.from(a));
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a && a[0] && a[0].length === 6) ctm = mul(ctm, Array.from(a[0])); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (IMG.has(fn)) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => vp.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        out.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
      }
    }
    return out;
  }
  const isCheckShape = (b, W, H2) => b.w >= W * 0.18 && b.h >= 40 && b.w / b.h >= 1.6 && b.w / b.h <= 3.6 && b.w * b.h < W * H2 * 0.6;

  // ---- printed text next to a picture (number, date, amount the bank printed) ----
  function nearText(items, vp, b) {
    const pad = 6, below = Math.max(110, b.h * 0.5), above = 4;
    return items.filter(it => {
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - above && y <= b.y + b.h + below && !(y > b.y + 8 && y < b.y + b.h - 8 && x > b.x + 8 && x < b.x + b.w - 8);
    }).map(it => it.str).join(' ');
  }
  function parseText(s) {
    const out = { label: /check\s*(?:number|no\b|#)/i.test(s) };
    const a = /\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})\b/.exec(s) || /\b(\d{1,3}(?:,\d{3})*\.\d{2})\b/.exec(s);
    if (a) out.amount = Number(a[1].replace(/,/g, ''));
    const d = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
    if (d) out.md = [Number(d[1]), Number(d[2]), d[3] ? Number(d[3].length === 2 ? '20' + d[3] : d[3]) : 0];
    // the check number: what's left after taking out dates and amounts
    const rest = s.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ').replace(/\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\b/g, ' ');
    const n = /(?:check|chk|ck)\s*(?:number|no\.?|#)?\s*:?\s*#?\s*(\d{2,12})\b/i.exec(rest) || (out.label && /\b(\d{2,12})\b/.exec(rest)) || /#\s*(\d{3,7})\b/.exec(rest);
    if (n) out.n = n[1];
    out.any = !!(out.amount || out.md);
    // A long "check number" is a customer's check you deposited; a caption with only a date and amount is a deposit slip.
    out.deposit = (out.n && out.n.length > 7) || (out.any && !out.label && !out.n);
    return out;
  }
  // ---- match a check to a bank line in the books ----
  const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
  function findMatch(c, used) {
    const cands = L.live().filter(t => t.amount < 0 && !used.has(t.id) && (acc(t.accountId) || {}).type === 'asset');
    const num = c.n ? String(Number(c.n)) : '';
    const hasNum = t => num && (String(Number(t.checkNum || 0)) === num || new RegExp('(^|\\D)0*' + num + '(\\D|$)').test(t.payee + ' ' + (t.memo || '')));
    const sameAmt = t => c.amount && Math.abs(-t.amount - c.amount) < 0.005;
    let hit = cands.find(t => hasNum(t) && sameAmt(t));
    if (hit) return { t: hit, how: 'check # and amount' };
    hit = cands.find(t => hasNum(t)); if (hit) return { t: hit, how: 'check # only. Amount differs, double-check' };
    const loose = cands.filter(t => sameAmt(t) && /check|chk/i.test(t.payee) && (!c.date || Math.abs(days(c.date, t.date)) <= 60));
    if (loose.length === 1) return { t: loose[0], how: 'amount' };
    return null;
  }

  // ---- read a PDF ----
  function crop(cv, b, maxSide) {
    const k = Math.min(1, maxSide / Math.max(b.w, b.h)), o = document.createElement('canvas');
    o.width = Math.max(1, Math.round(b.w * k)); o.height = Math.max(1, Math.round(b.h * k));
    o.getContext('2d').drawImage(cv, b.x, b.y, b.w, b.h, 0, 0, o.width, o.height);
    return o.toDataURL('image/jpeg', 0.88);
  }
  async function readPdf(file, into) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Choose the PDF statement from your bank.'); return; }
    const P = into || (ST.pc = {}); Object.assign(P, { name: file.name, busy: true, progress: 'Opening the PDF…', items: [], note: '', deposits: 0, scanned: false, none: false }); L.render();
    try {
      const lib = await pdfLib();
      const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, wasmUrl: '/vendor/wasm/', useWasm: false }).promise;
      const found = [], scanned = []; let deposits = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        P.progress = 'Looking for checks on page ' + p + ' of ' + doc.numPages + '…'; L.render();
        const page = await doc.getPage(p), vp = page.getViewport({ scale: 3 });
        const ops = await page.getOperatorList(), boxes = imageBoxes(ops, lib.OPS, vp);
        const checks = boxes.filter(b => isCheckShape(b, vp.width, vp.height));
        if (!checks.length) { if (boxes.some(b => b.w * b.h > vp.width * vp.height * 0.5)) scanned.push(p); continue; }
        const cv = document.createElement('canvas'); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        const text = (await page.getTextContent()).items;
        checks.sort((a, b) => Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x).forEach(b => { const raw = nearText(text, vp, b), t = parseText(raw); if (t.deposit) { deposits++; return; } found.push({ p, img: crop(cv, b, 1500), thumb: crop(cv, b, 640), t }); });
      }
      if (!found.length) {
        P.deposits = deposits; P.scanned = !!scanned.length; P.none = true;
        P.busy = false; P.note = deposits ? 'Only deposit slips and deposited checks were found in this PDF. No checks you wrote this month.' : scanned.length ? 'This PDF is a scanned picture, so the checks aren\'t separate. Take a screenshot of each check and add those pictures instead.' : 'No check pictures found in this PDF. Some banks only show check pictures on their website. Open each check there, take a screenshot, and add those pictures instead.';
        L.render(); return P;
      }
      const year = (S().txns.map(t => t.date).sort().pop() || L.today()).slice(0, 4);
      for (let i = 0; i < found.length; i++) {
        P.progress = 'AI is reading check picture ' + (i + 1) + ' of ' + found.length + '…'; L.render();
        const f = found[i]; let r = {};
        try { r = await SV.post('/api/ai/check', { image: f.img }); } catch (e) { r = { err: e.message }; }
        const tdate = f.t.md ? (f.t.md[2] || year) + '-' + String(f.t.md[0]).padStart(2, '0') + '-' + String(f.t.md[1]).padStart(2, '0') : '';
        const item = { p: f.p, thumb: f.thumb, n: f.t.n || r.checkNumber || '', amount: f.t.amount || r.amount || 0, date: tdate || r.date, payee: r.payee || '', memo: r.memo || '', err: r.err || '', aiAmount: r.amount || 0, printed: !!(f.t.n || f.t.amount) };
        if (!item.payee && !item.aiAmount && !f.t.n) continue; // back of a check, or an unreadable picture with nothing printed next to it
        const dup = P.items.find(x => x.n && x.n === item.n && Math.abs(x.amount - item.amount) < 0.005);
        if (dup) { if (!dup.payee && item.payee) Object.assign(dup, item); continue; }
        P.items.push(item);
      }
      const used = new Set();
      P.items.forEach(x => { x.warn = x.printed && x.aiAmount && Math.abs(x.aiAmount - x.amount) >= 0.005 ? 'The AI read ' + money(x.aiAmount) + ' on the check; the bank printed ' + money(x.amount) + '.' : ''; const m = findMatch(x, used); if (m) { used.add(m.t.id); x.tid = m.t.id; x.how = m.how; } });
      P.progress = 'Suggesting categories…'; L.render();
      await suggestCats(P.items.filter(x => x.tid && x.payee));
      P.note = P.items.length ? '' : 'Check pictures were found, but the AI couldn\'t read them. Try a clearer copy, or screenshots of each check.';
    } catch (e) { P.note = 'Couldn\'t read this PDF: ' + e.message; }
    P.busy = false; P.progress = ''; L.render(); return P;
  }
  // First page of a PDF as a picture (for a bill or invoice that came as a PDF)
  async function pdfPageImage(file) {
    const lib = await pdfLib();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, wasmUrl: '/vendor/wasm/', useWasm: false }).promise;
    const page = await doc.getPage(1), v0 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: Math.min(3, 1700 / Math.max(v0.width, v0.height)) });
    const cv = document.createElement('canvas'); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    return { img: cv.toDataURL('image/jpeg', 0.9), pages: doc.numPages, text: (await page.getTextContent()).items.map(i => i.str).join(' ').slice(0, 3000) };
  }
  async function suggestCats(list) {
    const h = H(); if (!list.length || !h.categoryList) return;
    list.forEach(x => { const t = S().txns.find(y => y.id === x.tid); const r = C.matchRule(S().rules, { payee: x.payee, memo: x.memo, amount: t.amount }); if (r && L.allowedCat(t, r.categoryId)) { x.cat = r.categoryId; x.ai = ''; x.why = 'Your Bank Rule "' + r.match + '"'; } });
    const todo = list.filter(x => !x.cat); if (!todo.length) return;
    const cats = h.categoryList(), byName = {}; cats.forEach(c => { if (!byName[c.name]) byName[c.name] = c.id; });
    try {
      const r = await SV.post('/api/ai/categorize', { business: S().company, notes: H().notesFor ? H().notesFor() : S().aiNotes || '', categories: cats.map(c => ({ name: c.name, type: c.type })), rules: h.rulesForAI(), examples: h.examples(),
        txns: todo.map(x => { const t = S().txns.find(y => y.id === x.tid), a = acc(t.accountId) || {}; return { id: t.id, date: t.date, payee: x.payee, memo: 'Paper check' + (x.memo ? ': ' + x.memo : ''), amount: t.amount, account: a.name, accountKind: 'bank', bankDeposit: false }; }) });
      r.results.forEach(res => { const x = todo.find(y => y.tid === res.id), t = S().txns.find(y => y.id === res.id), id = byName[res.category]; if (x && id && L.allowedCat(t, id)) { x.cat = id; x.ai = id; x.why = res.reason; x.conf = res.confidence; } });
    } catch (e) { /* categories are optional; the owner can pick */ }
  }

  function apply(x, tr, payee, category) {
    const t = S().txns.find(y => y.id === x.tid); if (!t) return false;
    const pay = payee != null ? payee : tr ? tr.querySelector('[data-f=payee]').value.trim() : x.payee, cat = category != null ? category : tr ? tr.querySelector('select.cat').value : x.cat;
    if (pay) { if (!t.origPayee) t.origPayee = t.payee; t.payee = pay; }
    const memo = 'Check #' + (x.n || '?') + (x.memo ? ' · ' + x.memo : '');
    if (!(t.memo || '').includes('Check #')) t.memo = (t.memo ? t.memo + ' · ' : '') + memo;
    if (x.n) t.checkNum = String(Number(x.n));
    if (cat && L.allowedCat(t, cat)) { t.categoryId = cat; if (x.ai && H().logResult) H().logResult(t, x.ai, cat); t.why = 'From the check picture' + (x.why ? ': ' + x.why : ''); }
    x.done = true; return true;
  }
  acts.pcApply = b => { const tr = b.closest('tr'), x = ST.pc.items[Number(tr.dataset.i)]; if (apply(x, tr)) { L.save(); L.updateBadge(); L.render(); toast('Check ' + (x.n || '') + ' applied'); } };
  acts.pcApplyAll = () => {
    let n = 0; document.querySelectorAll('#main tr[data-pc]').forEach(tr => { const x = ST.pc.items[Number(tr.dataset.i)]; if (x && x.tid && !x.done && !x.warn && tr.querySelector('select.cat').value && tr.querySelector('[data-f=payee]').value.trim() && apply(x, tr)) n++; });
    L.save(); L.updateBadge(); L.render(); toast(n + ' check' + (n === 1 ? '' : 's') + ' applied');
  };
  acts.pcClear = () => { ST.pc = null; L.render(); };
  acts.pcZoom = b => { const x = ST.pc.items[Number(b.closest('tr').dataset.i)]; L.modal(`<h2>Check ${esc(x.n || '')}</h2><img src="${x.thumb}" alt="Check picture" style="width:100%;border-radius:6px"><div class="actions"><button class="btn" id="pcZ">Close</button></div>`, card => { card.querySelector('#pcZ').onclick = L.closeModal; }); };

  ST.h2 = { readPdf, pdfPageImage, applyCheck: apply };
  ST.checksPanel = () => {
    const P = ST.pc, ok = H().visionReady && H().visionReady();
    const left = P ? P.items.filter(x => x.tid && !x.done && !x.warn).length : 0;
    return `<div class="panel" style="margin-top:14px"><div class="page-head" style="margin:0 0 8px"><div><h2 style="margin:0">Checks from a bank statement (PDF)</h2>
      <p class="sub small">Pick the PDF statement from your bank. Ledger Desk finds the check pictures in it, the AI reads who each check was paid to, and it's matched to the CHECK line in your books. The PDF stays on your computer; only the check pictures go to the AI on the server PC.</p></div>
      <div class="toolbar" style="margin:0">${P && !P.busy ? '<button class="link" data-act="pcClear">Clear</button>' : ''}${P && left ? `<button class="btn" data-act="pcApplyAll">Apply all ${left} matched</button>` : ''}<label class="btn${P && P.busy || !ok ? '" style="opacity:.55;pointer-events:none' : ' primary'}" for="pcIn">${P && P.busy ? '<span class="spin"></span>' + esc(P.progress) : 'Choose a PDF statement…'}</label><input type="file" id="pcIn" accept="application/pdf,.pdf" hidden></div></div>
      ${P && P.note ? `<p class="small" style="background:var(--warn-soft);padding:8px 10px;border-radius:6px">${esc(P.note)}</p>` : ''}
      ${P && P.items.length ? `<p class="small muted" style="margin:0 0 6px">${esc(P.name)} · ${P.items.length} check${P.items.length === 1 ? '' : 's'} read. Compare each name with the picture before applying. Handwriting can be misread.</p>
      <div class="table-wrap"><table><thead><tr><th>Check</th><th>#</th><th class="num">Amount</th><th>Paid to</th><th>In your books</th><th>Category</th><th></th></tr></thead><tbody>
      ${P.items.map((x, i) => { const t = x.tid && S().txns.find(y => y.id === x.tid); return `<tr data-i="${i}" data-pc="1"${x.done ? ' style="opacity:.6"' : ''}>
        <td><img src="${x.thumb}" alt="Check ${esc(x.n)}" data-act="pcZoom" style="width:150px;border:1px solid var(--line);border-radius:4px;cursor:zoom-in"></td>
        <td class="num">${esc(x.n || '?')}<div class="memo">${x.date ? usDate(x.date) : ''}</div></td>
        <td class="num">${x.amount ? money(-x.amount) : '?'}${x.warn ? `<div class="small neg" style="max-width:170px;white-space:normal;font-family:inherit;text-align:left">⚠️ ${esc(x.warn)}</div>` : ''}</td>
        <td><input type="text" data-f="payee" value="${esc(x.payee)}" placeholder="Type who it was paid to" style="width:180px"${x.done ? ' disabled' : ''}>${x.err ? '<div class="small neg">AI couldn\'t read it: ' + esc(x.err) + '</div>' : ''}${x.memo ? '<div class="memo">Memo: ' + esc(x.memo) + '</div>' : ''}</td>
        <td class="small">${t ? `<b>${esc(t.payee)}</b><div class="memo">${usDate(t.date)} · ${esc((acc(t.accountId) || {}).name || '')} · matched by ${esc(x.how)}</div>` : '<span class="muted">Not in your books yet. Import this bank statement first, then read the PDF again.</span>'}</td>
        <td>${t ? `<select class="cat" aria-label="Category"${x.done ? ' disabled' : ''}><option value="">Choose…</option>${L.catOptions(x.cat || (L.isUncat(t) ? '' : t.categoryId), t.accountId, false)}</select>${x.conf ? ` <span class="conf ${x.conf}">${x.conf}</span>` : ''}${x.why ? `<div class="ai-reason">${esc(x.why)}</div>` : ''}` : ''}</td>
        <td>${x.done ? '<span class="pos small">✓ Applied</span>' : t ? '<button class="btn sm primary" data-act="pcApply">Apply</button>' : ''}</td></tr>`; }).join('')}
      </tbody></table></div>` : ''}</div>`;
  };
  const prevAfter = afterRender.ai;
  afterRender.ai = () => {
    if (prevAfter) prevAfter();
    const f = document.querySelector('#pcIn'); if (f) f.addEventListener('change', () => { if (f.files[0]) readPdf(f.files[0]); });
  };
})();
