/* Ledger Desk AI Bookkeeper: drop any file (bank/card statements, PDF statements with checks, receipts, bills),
   the AI does the work and only asks about what it can't figure out. Every answer is applied right away and
   anything it did on its own can be undone. The AI runs on the Ledger Desk server PC; nothing goes anywhere else. */
(function () {
  'use strict';
  const L = window.ledgerDeskApp, SV = window.ledgerServer;
  if (!L || !SV || !L.viewState.ai) return;
  const { C, acts, afterRender, esc, money, usDate, toast, acc } = L;
  const ST = L.viewState.ai, S = () => L.S, H = () => ST.h || {}, H2 = () => ST.h2 || {};
  const BK = ST.bk = { msgs: [], q: [], cur: null, busy: '', auto: [], stats: { auto: 0, rules: 0, asked: 0, skipped: 0 } };
  const ready = () => ST.status && ST.status.ok && ST.status.hasText;
  const say = (html, who) => { BK.msgs.push({ who: who || 'a', html }); };
  const me = text => say(esc(text), 'q');
  const draw = () => { if (L.view === 'ai' && ST.tab === 'chat') L.render(); };
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const busy = t => { BK.busy = t; draw(); };
  const queuedIds = () => new Set(BK.q.concat(BK.cur ? [BK.cur] : []).flatMap(x => x.ids || (x.tid ? [x.tid] : [])));

  // ---------------- files in ----------------
  async function handleFiles(files) {
    files = Array.from(files || []); if (!files.length) return;
    if (BK.busy) { toast('One moment, still working on the last files.'); return; }
    BK.started = true;
    if (BK.cur) { BK.q.unshift(BK.cur); BK.cur = null; } // keep the open question for after these files
    me('📎 ' + files.map(f => f.name).join(', '));
    const kind = f => /\.(qbo|qfx|ofx)$/i.test(f.name) ? 'stmt' : /\.pdf$/i.test(f.name) || f.type === 'application/pdf' ? 'pdf'
      : /\.(heic|heif)$/i.test(f.name) ? 'heic' : /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name) ? 'img'
      : /\.(csv|xlsx|xls|iif|qbb|qbw|txt)$/i.test(f.name) ? 'qb' : 'other';
    const by = {}; files.forEach(f => (by[kind(f)] = by[kind(f)] || []).push(f));
    if (by.heic) say(`${esc(by.heic.map(f => f.name).join(', '))}: that's an iPhone HEIC photo, which browsers can't open. On the iPhone, go to Settings › Camera › Formats › <b>Most Compatible</b>, or send the photo as a screenshot, and drop it again.`);
    if (by.qb) say(`${esc(by.qb.map(f => f.name).join(', '))}: spreadsheets and QuickBooks files aren't bank statements. To bring over a whole QuickBooks company, use <b>Company &amp; Backup › Restore from QuickBooks</b>. For bank or card transactions, download the <b>QuickBooks Web Connect (.QBO)</b> file from the bank instead. See <b>Get statements</b> for where.`);
    if (by.other) say(`I can't read ${esc(by.other.map(f => f.name).join(', '))}. I can read bank and card statements (.QBO, .QFX, .OFX), PDF statements with check pictures, and pictures or PDFs of receipts, bills and invoices.`);
    if (!ready() && (by.pdf || by.img)) { say('The AI on the server PC isn\'t ready right now, so I can\'t read PDFs or pictures. Check that Ollama is running on that PC.', 'err'); delete by.pdf; delete by.img; }
    try {
      if (by.stmt) { const goOn = await statements(by.stmt); if (!goOn) { BK.later = { pdf: by.pdf || [], img: by.img || [] }; busy(''); next(); return; } }
      for (const f of by.pdf || []) await pdfFile(f);
      for (const f of by.img || []) await picture(f, await H().shrink(f), f.name);
    } catch (e) { say('Something went wrong: ' + esc(e.message), 'err'); }
    busy('');
    if (by.stmt || L.live().some(L.isUncat)) { await sortWaiting(true); busy(''); }
    next();
  }

  // bank and card statements (.QBO/.QFX/.OFX), for any company
  let pendingRoutes = 0;
  async function statements(files) {
    busy('Reading the statement files…');
    const routed = await L.stmtFiles(files);
    routed.filter(r => r.error).forEach(r => say(`${esc(r.fileName)}: I couldn't read it (${esc(r.error)}). Download it again from the bank as QuickBooks (.QBO).`, 'err'));
    const ok = routed.filter(r => !r.error && r.n);
    if (!ok.length) { if (!routed.some(r => r.error)) say('Those files have no transactions in them. Try downloading a longer date range, like "year to date".'); return true; }
    const unknown = ok.filter(r => !r.known);
    if (unknown.length) {
      pendingRoutes = unknown.length;
      unknown.forEach(r => BK.q.unshift({ type: 'route', r }));
      say(`${plural(unknown.length, 'account')} ${unknown.length === 1 ? 'is' : 'are'} new to me. Tell me which company ${unknown.length === 1 ? 'it belongs' : 'each belongs'} to and I'll bring ${unknown.length === 1 ? 'it' : 'them'} in.`);
      return false; // continues in importNow() after the answers
    }
    return importNow();
  }
  async function importNow() {
    busy('Bringing in the transactions…');
    const res = await L.stmtImport();
    if (res === null) { say('Some of these are for another company. I\'m moving over to it now; you\'ll see the results there.'); return false; }
    res.forEach(r => say(r.error ? `${esc(r.account)}: ${esc(r.error)}` : `<b>${esc(r.account)}</b>${r.newAccount ? ' (new account)' : ''}: ${plural(r.n, 'new transaction')}${r.auto ? ', ' + r.auto + ' sorted by your rules and past choices' : ''}${r.matched ? ', ' + plural(r.matched, 'card payment') + ' matched' : ''}.` +
      (r.stmtBalance != null ? (Math.abs(r.balance - r.stmtBalance) < 0.01 ? ` Balance <b>${money(r.balance)}</b> <span class="pos">✓ matches the bank</span>.` : ` <span class="neg">Balance ${money(r.balance)} doesn't match the bank's ${money(r.stmtBalance)} on ${usDate(r.stmtDate)}.</span> Something is missing or doubled. Download "year to date" and drop it again.`) : ''), r.error ? 'err' : 'a'));
    return true;
  }

  // PDFs: check pictures in a bank statement, or a bill/invoice that came as a PDF
  // A PDF bank or card statement: read its transactions (checked against the statement's own balances), then its check pictures
  let PJ = null;
  const pdfLib = async () => { if (!PJ) { PJ = await import('/vendor/pdf.min.js'); PJ.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js'; } return PJ; };
  async function pdfStatement(f) {
    if (!window.LedgerPdfStatement) return false;
    let r; try { r = await window.LedgerPdfStatement.readStatement(f, await pdfLib()); } catch (e) { return false; }
    if (!r || r.txns.length < 2 || (r.begin == null && r.end == null && r.txns.length < 5)) return false;
    const want = r.kind === 'credit' ? isCard : isBank;
    let acct = BK.forceAcct ? acc(BK.forceAcct) : null;
    if (!acct && r.last4) acct = S().accounts.find(a => want(a) && !a.archived && (String(a.ofxId || '').replace(/\D/g, '').endsWith(r.last4) || a.name.includes(r.last4)));
    let elsewhere = '';
    if (!acct && r.last4 && SV.companies) { const co = SV.companies().find(c => c.file !== SV.current().file && (c.ofxIds || []).some(id => String(id).replace(/\D/g, '').endsWith(r.last4))); if (co) elsewhere = co.plainName || co.name; }
    { let at = 0; BK.q.forEach((y, i) => { if (y.type === 'route' || y.type === 'pdfstmt') at = i + 1; }); BK.q.splice(at, 0, { type: 'pdfstmt', r, f, acct: acct ? acct.id : '', elsewhere }); }
    return true;
  }
  async function importPdfStatement(x, acctId, newName) {
    const r = x.r, a = acctId ? acc(acctId) : null;
    const txns = r.txns.map((t, i) => ({ date: t.date, payee: t.payee, memo: t.memo || '', amount: t.amount, fitid: 'pdf:' + t.date + ':' + t.amount.toFixed(2) + ':' + (t.checkNum || t.payee).slice(0, 24) + ':' + i, checkNum: t.checkNum || '' }));
    const st = { source: 'pdf', kind: r.kind, acctId: a && a.ofxId ? a.ofxId : 'pdf-' + (r.bankName || 'bank').toLowerCase().replace(/\W+/g, '') + '-' + (r.last4 || 'x'), org: r.bankName, txns, fileName: x.f.name,
      target: a ? a.id : 'new', newName: newName || ((r.bankName ? r.bankName.replace(/\b\w/g, c => c.toUpperCase()) + ' ' : '') + (r.kind === 'credit' ? 'Credit Card' : 'Checking') + (r.last4 ? ' •' + r.last4 : '')),
      ledgerBalance: r.end, ledgerDate: r.periodEnd || r.to };
    st.setOpening = !a && r.end != null; st.balInput = r.end == null ? null : (r.kind === 'credit' ? Math.abs(r.end) : r.end);
    const res = L.doImport(st);
    if (L.smartCategorizeExisting) L.smartCategorizeExisting();
    L.save(); L.updateBadge();
    return res;
  }

  async function pdfFile(f) {
    busy('Reading ' + f.name + '…');
    if (await pdfStatement(f)) return;
    const P = {}; await H2().readPdf(f, P);
    if (P.items && P.items.length) {
      const inBooks = P.items.filter(x => x.tid && !x.done), missing = P.items.filter(x => !x.tid);
      say(`${esc(f.name)}: I found ${plural(P.items.length, 'check')} you wrote.${inBooks.length ? ' I\'ll show you each one so you can confirm who it was paid to.' : ''}`);
      if (missing.length) say(`${missing.length === 1 ? 'Check' : 'Checks'} ${missing.map(x => '#' + esc(x.n || '?')).join(', ')} ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} in your books yet. Drop the bank's .QBO file for that month first, then this PDF again.`);
      inBooks.forEach(x => BK.q.push({ type: 'check', x, tid: x.tid }));
      return;
    }
    if (P.deposits) { say(`${esc(f.name)}: this statement only has deposit slips and deposited checks, no checks you wrote. Nothing to do. For the transactions themselves, use the bank's .QBO file.`); return; }
    if (/couldn't read/i.test(P.note || '')) { say(esc(f.name) + ': ' + esc(P.note), 'err'); return; }
    // no check pictures: treat it as a bill, invoice or receipt
    busy('Reading ' + f.name + ' as a bill or receipt…');
    const pg = await H2().pdfPageImage(f);
    if (/statement|beginning balance|ending balance|account summary/i.test(pg.text) && pg.pages > 1) {
      say(`${esc(f.name)} looks like a bank statement without check pictures. I can't take transactions out of a PDF reliably. Drop the bank's <b>QuickBooks (.QBO)</b> file instead (see <b>Get statements</b>).`); return;
    }
    await picture(null, pg.img, f.name);
  }

  // receipts, bills, invoices (a picture, or the first page of a PDF)
  async function picture(file, img, name) {
    busy('Reading ' + name + '…');
    let d;
    try { d = await SV.post('/api/ai/document', { image: img, categories: H().expenseNames() }); }
    catch (e) { say(esc(name) + ': the AI couldn\'t read it (' + esc(e.message) + ').', 'err'); return; }
    if (!d.total && !d.vendor) { say(esc(name) + ': I couldn\'t make out a vendor or a total. Try a sharper, straight-on photo.'); return; }
    const matches = H().docMatches(d);
    const kind = { receipt: 'receipt', bill: 'bill', invoice: 'invoice', check: 'check', other: 'document' }[d.kind] || 'document';
    if (!matches.length) { say(`${esc(name)}: a ${kind} from <b>${esc(d.vendor || '?')}</b> for <b>${d.total ? money(d.total) : '?'}</b>${d.date ? ' on ' + usDate(d.date) : ''}. I don't see that charge in your books yet. Drop the bank or card statement it's on first, then this ${kind} again.`); return; }
    const sug = S().accounts.find(a => a.name === d.category && !a.archived);
    BK.q.push({ type: 'doc', d, img, name, kind, matches: matches.map(t => t.id), tid: matches[0].id, cat: sug ? sug.id : '' });
  }

  // ---------------- credit card payments ----------------
  // Paying a card from the bank moves money between the business's own accounts: it's never income, an expense or an owner's draw.
  const PAYWORD = /\b(payment|pymt|pmt|paymnt|thank you|autopay|auto pay|epay|e-payment|epayment|online pmt)\b/i;
  const ISSUER = /\b(amex|american express|chase|citi|citibank|citicard|discover|capital one|capitalone|barclay|barclaycard|synchrony|card services|cardmember|credit card|crcard|apple ?card|us bank|wells fargo card|bank of america|boa|bk of amer)\b/i;
  const accOf = t => acc(t.accountId) || {};
  const isCard = a => a && a.type === 'liability' && a.detail === 'credit';
  const isBank = a => a && a.type === 'asset' && a.detail === 'bank';
  function isCardPay(t) {
    const hay = t.payee + ' ' + (t.memo || ''), a = accOf(t);
    if (isCard(a)) return t.amount > 0 && PAYWORD.test(hay) && !/\b(refund|return|credit adj|cashback|cash back|reward)\b/i.test(hay);
    if (isBank(a)) return t.amount < 0 && ISSUER.test(hay) && PAYWORD.test(hay);
    return false;
  }
  ST.isCardPay = isCardPay;
  const wrongPlace = t => { const c = acc(t.categoryId); return c && !L.isUncat(t) && (c.type === 'equity' || c.type === 'income' || c.type === 'expense') && c.sys !== 'deposits'; };
  // Fixes card payments filed as income/expense/draw, matches both sides, and queues a question for the rest.
  function fixCardPayments() {
    const s = S(), memo = s.cardPayFrom || (s.cardPayFrom = {});
    const pays = L.live().filter(t => !t.transferWith && isCardPay(t));
    let moved = 0;
    pays.filter(t => wrongPlace(t) && !t.personalCard).forEach(t => { const was = acc(t.categoryId); if (t.aiCat && H().logResult) { /* the AI got it wrong: count it */ } t.categoryId = L.defaultCat(t); t.why = 'Card payment: was under ' + was.name; delete t.aiCat; moved++; });
    const matched = L.matchTransfers ? L.matchTransfers() : 0;
    // card side: use the bank account the owner told us before
    let remembered = 0;
    L.live().filter(t => !t.transferWith && isCardPay(t) && L.isUncat(t) && isCard(accOf(t)) && memo[t.accountId] && acc(memo[t.accountId])).forEach(t => { t.categoryId = memo[t.accountId]; t.why = 'Card payment from ' + acc(memo[t.accountId]).name; remembered++; });
    if (moved || matched || remembered) { L.save(); L.updateBadge(); }
    const left = L.live().filter(t => !t.transferWith && !t.personalCard && isCardPay(t) && L.isUncat(t));
    const queued = new Set(BK.q.filter(x => x.type === 'cardpay').flatMap(x => x.ids));
    const g = {};
    left.filter(t => !queued.has(t.id)).forEach(t => { const k = t.accountId; (g[k] = g[k] || { type: 'cardpay', acct: t.accountId, ids: [], total: 0, dates: [] }); g[k].ids.push(t.id); g[k].total += Math.abs(t.amount); g[k].dates.push(t.date); });
    const qs = Object.values(g); qs.forEach(x => x.dates.sort()); { let at = 0; BK.q.forEach((y, i) => { if (y.type === 'route' || y.type === 'pdfstmt') at = i + 1; }); BK.q.splice(at, 0, ...qs); }
    if (moved) say(`I found ${plural(moved, 'credit card payment')} filed as income, an expense or Owner's Draw. Paying a card from your bank just moves money between your own accounts, so it isn't income or a draw. I took ${moved === 1 ? 'it' : 'them'} out of there${matched ? ' and matched ' + plural(matched, 'payment') + ' with the bank side' : ''}.`);
    else if (matched) say(`I matched ${plural(matched, 'credit card payment')} with the bank side.`);
    if (remembered) say(`${plural(remembered, 'card payment')} filed under the bank account you told me before.`);
    return qs.length;
  }

  // ---------------- sort what's waiting ----------------
  async function sortWaiting(fromFiles) {
    const h = H(); if (!h.candidates) return;
    if (!ready()) { say('The AI on the server PC isn\'t ready right now, so I can\'t sort. Check that Ollama is running on that PC.', 'err'); return; }
    fixCardPayments();
    const rulesN = L.applyRulesToUncat ? L.applyRulesToUncat() : 0; if (rulesN) { L.save(); BK.stats.rules += rulesN; }
    const skip = queuedIds(), list = h.candidates().filter(t => !skip.has(t.id)).slice(0, 300);
    if (!list.length) { if (rulesN) say(`Sorted ${plural(rulesN, 'transaction')} with your Bank Rules.`); else if (!fromFiles) say('Nothing is waiting for a category. 👍'); return; }
    const cats = h.categoryList(), byName = {}; cats.forEach(c => { if (!byName[c.name]) byName[c.name] = c.id; });
    const res = {};
    for (let i = 0; i < list.length; i += 20) {
      const batch = list.slice(i, i + 20);
      busy('Sorting ' + (i + 1) + '–' + (i + batch.length) + ' of ' + list.length + '…');
      try {
        const r = await SV.post('/api/ai/categorize', { business: S().company, notes: H().notesFor ? H().notesFor() : S().aiNotes || '', categories: cats.map(c => ({ name: c.name, type: c.type })), rules: h.rulesForAI(), examples: h.examples(),
          txns: batch.map(t => { const a = acc(t.accountId) || {}; return { id: t.id, date: t.date, payee: t.payee, memo: t.memo || '', amount: t.amount, account: a.name, accountKind: a.detail === 'credit' ? 'credit card' : a.detail === 'loan' ? 'loan' : 'bank', bankDeposit: L.isBankDeposit(t) }; }) });
        r.results.forEach(x => { const t = S().txns.find(y => y.id === x.id), id = byName[x.category]; if (t && id && L.allowedCat(t, id)) res[t.id] = { id, conf: x.confidence, reason: x.reason }; });
      } catch (e) { busy(''); say('The AI stopped: ' + esc(e.message), 'err'); return; }
    }
    // sure → done now (can be undone); not sure → one question per payee
    const run = Date.now(); let autoN = 0;
    list.forEach(t => {
      const r = res[t.id]; if (!r || r.conf !== 'high' || BK.noAuto) return;
      BK.auto.push({ id: t.id, prev: t.categoryId, run });
      t.categoryId = r.id; t.why = 'Sorted by the AI Bookkeeper: ' + r.reason; h.logResult(t, r.id, r.id); autoN++;
    });
    const groups = {};
    list.filter(t => L.isUncat(t)).forEach(t => {
      const k = C.normPayee(t.payee) + '|' + (t.amount < 0 ? 'o' : 'i'), g = groups[k] || (groups[k] = { type: 'group', key: k, ids: [], payee: t.payee, sign: t.amount < 0 ? 'o' : 'i', total: 0, dates: [], accts: new Set(), votes: {} });
      g.ids.push(t.id); g.total += t.amount; g.dates.push(t.date); g.accts.add((acc(t.accountId) || {}).name || '');
      const r = res[t.id]; if (r) { const v = g.votes[r.id] || (g.votes[r.id] = { n: 0, r }); v.n++; }
    });
    const gl = Object.values(groups).map(g => { const best = Object.values(g.votes).sort((a, b) => b.n - a.n)[0]; g.ai = best ? best.r.id : ''; g.cat = g.ai; g.reason = best ? best.r.reason : ''; g.conf = best ? best.r.conf : ''; g.accts = Array.from(g.accts).filter(Boolean); g.dates.sort(); return g; })
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    gl.forEach(g => BK.q.push(g));
    L.save(); L.updateBadge();
    const parts = [];
    if (rulesN) parts.push(plural(rulesN, 'transaction') + ' by your Bank Rules');
    if (autoN) parts.push(plural(autoN, 'transaction') + ' I was sure about');
    say((parts.length ? 'I sorted ' + parts.join(' and ') + '. ' : '') + (gl.length ? `I have ${plural(gl.length, 'question')} about the rest${gl.length > 1 ? ', biggest first' : ''}.` : 'That\'s everything.') + (autoN ? ' <button class="link" data-act="bkShowAuto">See what I sorted</button>' : ''));
    BK.stats.auto += autoN;
  }

  // ---------------- questions ----------------
  function next() {
    BK.cur = BK.q.shift() || null;
    if (!BK.cur && BK.started) finish();
    draw();
    setTimeout(() => { const c = document.querySelector('#bkChat'); if (c) c.scrollTop = c.scrollHeight; }, 30);
  }
  function finish() {
    BK.started = false;
    const left = L.live().filter(L.isUncat).length;
    say(`All done ✅${BK.stats.asked ? ' Thanks for the ' + plural(BK.stats.asked, 'answer') + '.' : ''}${left ? ` ${plural(left, 'transaction')} still ${left === 1 ? 'needs' : 'need'} a category${BK.stats.skipped ? ' (the ones you skipped)' : ''}.` : ' Everything is categorized.'}` +
      ` <button class="link" data-act="bkMonth">Check the month</button>${BK.auto.length ? ' · <button class="link" data-act="bkUndo">Undo what I sorted on my own</button>' : ''}`);
    BK.stats = { auto: 0, rules: 0, asked: 0, skipped: 0 };
  }
  const catSel = (cat, t, attrs) => `<select class="cat" data-bk-cat ${attrs || ''}><option value="">Choose a category…</option>${L.catOptions(cat || '', t.accountId, L.isBankDeposit(t))}</select>`;
  function card(x) {
    if (x.type === 'pdfstmt') {
      const r = x.r, inn = r.txns.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0), out = -r.txns.filter(t => t.amount < 0).reduce((a, t) => a + t.amount, 0);
      const opts = S().accounts.filter(a => !a.archived && (r.kind === 'credit' ? isCard(a) : isBank(a)));
      const name = (r.bankName || 'Statement') + (r.last4 ? ' •' + r.last4 : '');
      const check = r.ok ? `<span class="pos">✓ It adds up:</span> ${r.kind === 'credit' ? 'previous balance' : 'beginning balance'} ${money(r.begin)} ${r.kind === 'credit' ? '+ charges ' + money(out) + ' − payments/credits ' + money(inn) : '+ deposits ' + money(inn) + ' − withdrawals ' + money(out)} = ${r.kind === 'credit' ? 'new' : 'ending'} balance ${money(r.end)}, same as the statement.`
        : r.diff != null ? `<span class="neg">⚠️ It's off by ${money(Math.abs(r.diff))}</span> compared with the statement's balances, so I may have missed or misread a line. Click "Show them" and compare with the PDF before bringing them in.` : `<span class="neg">⚠️ I couldn't find the beginning and ending balance on this statement to double-check.</span> Look them over first.`;
      return `<b>${esc(x.f.name)}</b>: a ${r.kind === 'credit' ? 'credit card' : 'bank'} statement from <b>${esc(name)}</b>, ${usDate(r.from)} – ${usDate(r.to)}. I read <b>${plural(r.txns.length, 'transaction')}</b>.<div style="margin-top:6px">${check}</div>
        ${x.elsewhere ? `<div class="small" style="margin-top:6px">This account belongs to <b>${esc(x.elsewhere)}</b>. Switch to that company (top left) and drop the PDF there instead.</div>` : ''}
        <div class="bk-btns" style="margin-top:8px"><span class="small">Put them in</span><select id="bkStAcct">${opts.map(a => `<option value="${a.id}"${a.id === x.acct ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}<option value="new"${x.acct ? '' : ' selected'}>A new account: ${esc(name.replace('Statement', r.kind === 'credit' ? 'Credit Card' : 'Checking'))}</option></select>
        <button class="btn sm primary" data-act="bkStImport">Bring them in</button><button class="btn sm" data-act="bkStShow">Show them</button><button class="btn sm" data-act="bkSkip">Skip</button></div>
        <div class="small muted" style="margin-top:4px">Anything already in that account (from this PDF or the bank's QBO file) is skipped, so nothing is doubled.</div>`;
    }
    if (x.type === 'cardpay') {
      const a = acc(x.acct) || {}, card = isCard(a), span = usDate(x.dates[0]) + (x.dates.length > 1 ? ' – ' + usDate(x.dates[x.dates.length - 1]) : '');
      const others = S().accounts.filter(o => !o.archived && o.id !== a.id && (card ? isBank(o) : isCard(o)));
      const draw = S().accounts.find(o => o.type === 'equity' && /draw|distribution/i.test(o.name) && !o.archived);
      return card ? `<b>${plural(x.ids.length, 'payment')} to ${esc(a.name)}</b> · ${money(x.total)} total · ${span}<div style="margin-top:6px">These are payments to the credit card from a bank account, not income and not an owner's draw. <b>Which bank account did you pay ${esc(a.name)} from?</b> I'll remember it for next time.</div>
        <div class="bk-btns">${others.map(o => `<button class="btn sm primary" data-act="bkCardFrom" data-to="${o.id}">${esc(o.name)}</button>`).join('') || '<span class="small muted">No bank accounts in this company yet. Import the bank statement and I\'ll match them.</span>'}<button class="btn sm" data-act="bkSkip">Not sure yet</button></div>`
        : `<b>${plural(x.ids.length, 'payment')} from ${esc(a.name)} to a credit card</b> · ${money(x.total)} total · ${span}<div style="margin-top:6px">Which card was paid?</div>
        <div class="bk-btns">${others.map(o => `<button class="btn sm primary" data-act="bkCardFrom" data-to="${o.id}">${esc(o.name)}</button>`).join('')}${draw ? `<button class="btn sm" data-act="bkCardFrom" data-to="${draw.id}">A personal card (owner's draw)</button>` : ''}<button class="btn sm" data-act="bkSkip">Not sure yet</button></div>`;
    }
    if (x.type === 'route') {
      const r = x.r, cos = L.stmtCompanies();
      return `<b>${esc(r.newName)}</b> (${plural(r.n, 'transaction')}, ${usDate(r.from)} – ${usDate(r.to)}, file ${esc(r.fileName)}) is new to me. Which company is it for?
        <div class="bk-btns">${cos.map(c => `<button class="btn sm" data-act="bkRoute" data-co="${esc(c.file)}">${esc(c.name)}</button>`).join('')}<button class="btn sm" data-act="bkRouteSkip">Leave it out</button></div>`;
    }
    if (x.type === 'group') {
      const t = S().txns.find(y => y.id === x.ids[0]); if (!t) return '';
      const c = acc(x.cat), many = x.ids.length > 1, span = x.dates[0] === x.dates[x.dates.length - 1] ? usDate(x.dates[0]) : usDate(x.dates[0]) + ' – ' + usDate(x.dates[x.dates.length - 1]);
      const what = `<b>${esc(t.payee)}</b>${t.memo ? ' <span class="muted">(' + esc(t.memo.slice(0, 60)) + ')</span>' : ''} · ${many ? x.ids.length + ' ' + (x.sign === 'o' ? 'charges' : 'deposits') + ', ' + money(Math.abs(x.total)) + ' total' : money(x.total)} · ${span} · ${esc(x.accts.join(', '))}`;
      const q = x.said ? `Got it. That goes under <b>${c ? esc(c.name) : '?'}</b>. Right?` : c ? `My guess is <b>${esc(c.name)}</b>${x.reason ? ': ' + esc(x.reason) : ''}. Is that right?` : `What ${many ? 'are these' : 'is this'}?`;
      const big = x.sign === 'o' && Math.abs(x.total) / x.ids.length >= 2500 ? `<div class="small" style="margin-top:6px;background:var(--warn-soft);padding:6px 8px;border-radius:6px">💡 Tax tip: if this was one item over $2,500 (furniture, TVs, appliances, HVAC, a roof), it's usually a fixed asset, not a repair or supply. It can often still be written off this year with bonus depreciation. Tell me in your words ("new TVs for the rooms") and I'll put it in the right place, or flag it for your accountant.</div>` : '';
      return `${what}${big}<div style="margin-top:6px">${q}</div>
        <div class="bk-btns">${c ? `<button class="btn sm primary" data-act="bkYes">Yes</button>` : ''}${catSel(c ? '' : '', t)}<button class="btn sm" data-act="bkPick">Use this</button><button class="btn sm" data-act="bkSkip">Skip for now</button></div>
        <div class="bk-say"><input type="text" id="bkSay" placeholder="Or tell me in your words, e.g. &quot;towels for the rooms&quot;" maxlength="300"><button class="btn sm" data-act="bkSay">Send</button></div>
        ${/^(check|chk|deposit|withdrawal|atm|transfer|online transfer|mobile deposit|pos|debit|ach)\b/i.test(t.payee) ? '' : `<label class="small" style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="bkRule"${many ? ' checked' : ''}> Do this every time for ${esc(L.suggestMatch(t.payee))} (make a Bank Rule)</label>`}`;
    }
    if (x.type === 'check') {
      const c = x.x, t = S().txns.find(y => y.id === c.tid); if (!t) return '';
      return `<div class="bk-pic"><img src="${c.thumb}" alt="Check ${esc(c.n)}"></div>
        Check <b>#${esc(c.n || '?')}</b> for <b>${money(c.amount)}</b>${c.date ? ' (' + usDate(c.date) + ')' : ''} matches <b>${esc(t.payee)}</b> on ${esc((acc(t.accountId) || {}).name || '')}.${c.warn ? ` <span class="neg">⚠️ ${esc(c.warn)}</span>` : ''}
        <div style="margin-top:6px">${c.payee ? 'It looks like it was paid to:' : 'I couldn\'t read who it was paid to. Please type it:'}</div>
        <div class="bk-btns"><input type="text" id="bkPayee" value="${esc(c.payee)}" placeholder="Paid to" style="width:220px">${catSel(c.cat, t)}<button class="btn sm primary" data-act="bkCheck">Yes, save it</button><button class="btn sm" data-act="bkSkip">Skip</button></div>
        ${c.why ? `<div class="ai-reason">${esc(c.why)}</div>` : ''}`;
    }
    if (x.type === 'doc') {
      const d = x.d, ts = x.matches.map(id => S().txns.find(y => y.id === id)).filter(Boolean); if (!ts.length) return '';
      return `<div class="bk-pic"><img src="${x.img}" alt="${esc(x.name)}"></div>
        ${esc(x.name)}: a ${x.kind} from <b>${esc(d.vendor || '?')}</b> for <b>${d.total ? money(d.total) : '?'}</b>${d.date ? ' on ' + usDate(d.date) : ''}${d.tax ? ' (tax ' + money(d.tax) + ')' : ''}.
        <div style="margin-top:6px">${ts.length === 1 ? 'It matches this charge:' : 'Which charge is it?'}</div>
        <div class="bk-btns"><select id="bkMatch">${ts.map(t => `<option value="${t.id}">${usDate(t.date)} · ${esc(t.payee)} · ${money(t.amount)} · ${esc((acc(t.accountId) || {}).name || '')}</option>`).join('')}</select></div>
        <div class="bk-btns"><input type="text" id="bkPayee" value="${esc(d.vendor || '')}" placeholder="Vendor" style="width:200px">${catSel(x.cat, ts[0])}<button class="btn sm primary" data-act="bkDoc">Yes, save it</button><button class="btn sm" data-act="bkSkip">Skip</button></div>`;
    }
    return '';
  }

  const curSel = () => { const s = document.querySelector('#bkCard [data-bk-cat]'); return s ? s.value : ''; };
  function applyGroup(g, cat, how) {
    const h = H(); let n = 0;
    g.ids.forEach(id => { const t = S().txns.find(y => y.id === id); if (!t || !L.isUncat(t) || !L.allowedCat(t, cat)) return; t.categoryId = cat; t.why = how; if (g.ai) h.logResult(t, g.ai, cat); n++; });
    const rb = document.querySelector('#bkRule');
    if (rb && rb.checked && n) {
      const t = S().txns.find(y => y.id === g.ids[0]), match = L.suggestMatch(t.payee);
      if (!S().rules.some(r => r.match.toLowerCase() === match.toLowerCase() && r.categoryId === cat)) S().rules.push({ id: L.uid(), match, sign: g.sign === 'o' ? 'out' : 'in', categoryId: cat, rename: '' });
    }
    L.save(); L.updateBadge(); BK.stats.asked++;
    return n;
  }
  acts.bkYes = () => { const g = BK.cur; me('Yes, ' + acc(g.cat).name); const n = applyGroup(g, g.cat, g.said ? 'You told the AI Bookkeeper' : 'You confirmed the AI\'s guess'); say(`Done: ${plural(n, 'transaction')} under ${esc(acc(g.cat).name)}.`); next(); };
  acts.bkPick = () => {
    const g = BK.cur, cat = curSel(); if (!cat) { toast('Choose a category first'); return; }
    if (g.type !== 'group') return;
    me(acc(cat).name); const n = applyGroup(g, cat, 'You chose this in the AI Bookkeeper'); say(`Done: ${plural(n, 'transaction')} under ${esc(acc(cat).name)}. I'll remember that.`); next();
  };
  acts.bkStShow = () => {
    const r = BK.cur.r;
    L.modal(`<h2>What I read from ${esc(BK.cur.f.name)}</h2><div class="table-wrap" style="max-height:460px;overflow:auto"><table><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>
      ${r.txns.map(t => `<tr><td class="num small">${usDate(t.date)}</td><td>${esc(t.payee)}${t.memo ? '<div class="memo">' + esc(t.memo) + '</div>' : ''}</td><td class="num ${t.amount > 0 ? 'pos' : ''}">${money(t.amount)}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted">${r.kind === 'credit' ? 'Charges are negative, payments and credits positive.' : 'Money out is negative, deposits positive.'}</p><div class="actions"><button class="btn" id="bkSC">Close</button></div>`, c => { c.querySelector('#bkSC').onclick = L.closeModal; });
  };
  acts.bkStImport = async () => {
    const x = BK.cur, sel = document.querySelector('#bkStAcct'), id = sel ? sel.value : 'new';
    me('Bring them in' + (id !== 'new' && acc(id) ? ' to ' + acc(id).name : ''));
    busy('Bringing in the transactions…');
    try {
      const res = await importPdfStatement(x, id === 'new' ? '' : id);
      const t = res.target, bal = C.natural(t, C.debits(L.live())[t.id]);
      say(`<b>${esc(t.name)}</b>: ${plural(res.n, 'new transaction')}${x.r.txns.length - res.n ? ' (' + (x.r.txns.length - res.n) + ' were already there)' : ''}${res.auto ? ', ' + res.auto + ' sorted by your rules and past choices' : ''}${res.matched ? ', ' + plural(res.matched, 'transfer') + ' matched' : ''}. Balance now ${money(bal)}${t.type === 'liability' ? ' owed' : ''}.`);
      BK.cur = null;
      // the same PDF's check pictures: who each check was paid to
      if (x.r.txns.some(t => t.checkNum) && ready()) {
        busy('Reading the check pictures in ' + x.f.name + '…');
        const P = {}; await H2().readPdf(x.f, P);
        const inBooks = (P.items || []).filter(c => c.tid && !c.done);
        if (inBooks.length) { say(`I found ${plural(inBooks.length, 'check picture')} in the same PDF. I'll show you each one so you can confirm who it was paid to.`); inBooks.forEach(c => BK.q.unshift({ type: 'check', x: c, tid: c.tid })); }
      }
    } catch (e) { say('Something went wrong: ' + esc(e.message), 'err'); }
    busy(''); BK.started = true;
    await sortWaiting(true); busy(''); next();
  };
  acts.bkCardFrom = b => {
    const x = BK.cur, to = acc(b.dataset.to); if (!to) return;
    let n = 0; x.ids.forEach(id => { const t = S().txns.find(y => y.id === id); if (t && L.isUncat(t) && L.allowedCat(t, to.id)) { t.categoryId = to.id; t.why = 'Card payment' + (to.type === 'equity' ? ' (personal card)' : ''); if (to.type === 'equity') t.personalCard = true; n++; } });
    if (isCard(acc(x.acct)) && isBank(to)) (S().cardPayFrom = S().cardPayFrom || {})[x.acct] = to.id;
    const m = L.matchTransfers ? L.matchTransfers() : 0;
    L.save(); L.updateBadge(); BK.stats.asked++; me(to.name);
    say(`Done: ${plural(n, 'payment')} recorded as money moved ${isCard(acc(x.acct)) ? 'from ' + esc(to.name) : 'to ' + esc(to.name)}${m ? ', and ' + plural(m, 'one') + ' matched with the other side' : ''}.${isCard(acc(x.acct)) ? ' Next time I\'ll do this on my own.' : ''}`); next();
  };
  acts.bkSkip = () => { me('Skip'); BK.stats.skipped++; next(); };
  acts.bkSay = async () => {
    const g = BK.cur, inp = document.querySelector('#bkSay'), text = inp ? inp.value.trim() : ''; if (!text || BK.busy) return;
    me(text); busy('Thinking…');
    const h = H(), t = S().txns.find(y => y.id === g.ids[0]), a = acc(t.accountId) || {}, cats = h.categoryList();
    try {
      const r = await SV.post('/api/ai/categorize', { business: S().company, notes: (H().notesFor ? H().notesFor() : S().aiNotes || '').slice(0, 2600) + '\n\nTHE OWNER JUST SAID ABOUT "' + t.payee + '": ' + text + '\nFollow what the owner said.', categories: cats.map(c => ({ name: c.name, type: c.type })), rules: h.rulesForAI(), examples: h.examples(),
        txns: [{ id: t.id, date: t.date, payee: t.payee, memo: (t.memo || '') + ' | owner says: ' + text, amount: t.amount, account: a.name, accountKind: a.detail === 'credit' ? 'credit card' : 'bank', bankDeposit: L.isBankDeposit(t) }] });
      const x = r.results[0], c = x && cats.find(c => c.name === x.category);
      if (c && L.allowedCat(t, c.id)) { g.cat = c.id; g.said = true; g.reason = ''; }
      else say('I couldn\'t match that to a category. Pick one from the list.', 'err');
    } catch (e) { say('The AI stopped: ' + esc(e.message), 'err'); }
    busy('');
  };
  acts.bkCheck = () => {
    const x = BK.cur.x, pay = (document.querySelector('#bkPayee') || {}).value.trim(), cat = curSel();
    if (!pay) { toast('Type who the check was paid to'); return; }
    me(pay + (cat ? ', ' + acc(cat).name : ''));
    H2().applyCheck(x, null, pay, cat); L.save(); L.updateBadge(); BK.stats.asked++;
    say(`Saved check #${esc(x.n || '')}: ${esc(pay)}${cat ? ' under ' + esc(acc(cat).name) : ''}.`); next();
  };
  acts.bkDoc = () => {
    const x = BK.cur, d = x.d, t = S().txns.find(y => y.id === (document.querySelector('#bkMatch') || {}).value); if (!t) return;
    const pay = (document.querySelector('#bkPayee') || {}).value.trim(), cat = curSel();
    if (pay) { if (!t.origPayee) t.origPayee = t.payee; t.payee = pay; }
    const label = x.kind[0].toUpperCase() + x.kind.slice(1), note = label + (d.number ? ' #' + d.number : '') + (d.memo ? ' ' + d.memo : '');
    if ((t.memo || '').indexOf(note) < 0) t.memo = ((t.memo ? t.memo + ' · ' : '') + note).trim();
    t.doc = { kind: d.kind, vendor: d.vendor, date: d.date, total: d.total, tax: d.tax, number: d.number };
    if (cat && L.allowedCat(t, cat)) { t.categoryId = cat; t.why = 'From the ' + x.kind + ' you gave the AI Bookkeeper'; }
    L.save(); L.updateBadge(); BK.stats.asked++;
    me('Yes' + (cat ? ', ' + acc(cat).name : '')); say(`Saved: ${esc(t.payee)} ${money(t.amount)}${cat ? ' under ' + esc(acc(cat).name) : ''}, with the ${x.kind} noted.`); next();
  };
  acts.bkRoute = async b => {
    const x = BK.cur; x.r.company = b.dataset.co;
    me(b.textContent); pendingRoutes--;
    if (BK.q.some(y => y.type === 'route')) { next(); return; }
    BK.cur = null; BK.started = true;
    await afterRoutes();
  };
  acts.bkRouteSkip = async () => {
    const x = BK.cur; x.r.n = 0; me('Leave it out');
    if (BK.q.some(y => y.type === 'route')) { next(); return; }
    BK.cur = null; BK.started = true;
    await afterRoutes();
  };
  async function afterRoutes() {
    const goOn = await importNow().catch(e => { say('Something went wrong: ' + esc(e.message), 'err'); return false; });
    if (goOn) {
      const later = BK.later || { pdf: [], img: [] }; BK.later = null;
      try { for (const f of later.pdf) await pdfFile(f); for (const f of later.img) await picture(f, await H().shrink(f), f.name); } catch (e) { say('Something went wrong: ' + esc(e.message), 'err'); }
      busy(''); await sortWaiting(true);
    }
    busy(''); next();
  }
  acts.bkStart = async () => { if (BK.busy) return; BK.started = true; me('Sort what\'s waiting'); await sortWaiting(false); busy(''); next(); };
  acts.bkFiles = () => { const i = document.querySelector('#bkIn'); if (i) i.click(); };
  acts.bkMonth = () => { ST.tab = 'month'; L.render(); };
  acts.bkClear = () => { BK.msgs = []; BK.q = []; BK.cur = null; BK.started = false; L.render(); };
  acts.bkShowAuto = () => {
    const rows = BK.auto.map(a => S().txns.find(t => t.id === a.id)).filter(Boolean);
    L.modal(`<h2>What the AI sorted on its own</h2><p class="small muted" style="margin-top:0">It was sure about these. Change any of them on Transactions, and the AI learns from the fix.</p>
      <div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Date</th><th>Payee</th><th class="num">Amount</th><th>Category</th></tr></thead><tbody>
      ${rows.map(t => `<tr><td class="num small">${usDate(t.date)}</td><td>${esc(t.payee)}</td><td class="num">${money(t.amount)}</td><td>${esc((acc(t.categoryId) || {}).name || '')}</td></tr>`).join('')}</tbody></table></div>
      <div class="actions"><button class="btn" id="bkU">Undo all of these</button><button class="btn primary" id="bkC">Looks good</button></div>`, c => {
      c.querySelector('#bkC').onclick = L.closeModal; c.querySelector('#bkU').onclick = () => { L.closeModal(); acts.bkUndo(); };
    });
  };
  acts.bkUndo = () => {
    let n = 0; const ids = new Set();
    BK.auto.forEach(a => { const t = S().txns.find(y => y.id === a.id); if (t && t.aiCat && t.categoryId === t.aiCat) { t.categoryId = a.prev; delete t.aiCat; delete t.aiFixed; t.why = ''; ids.add(t.id); n++; } });
    if (S().aiLog) S().aiLog = S().aiLog.filter(e => !ids.has(e.id));
    BK.auto = []; L.save(); L.updateBadge(); say(`Undone: ${plural(n, 'transaction')} ${n === 1 ? 'is' : 'are'} back to uncategorized. Use "Sort what's waiting" when you want me to ask about them instead.`); draw();
  };

  // ---------------- the screen ----------------
  ST.tabViews = ST.tabViews || {};
  ST.tabViews.chat = () => {
    if (ST.bkAutoStart && !BK.busy) { ST.bkAutoStart = false; setTimeout(acts.bkStart, 50); }
    else if (!BK.cardChecked && !BK.busy) { BK.cardChecked = true; setTimeout(() => { if (fixCardPayments()) { BK.started = true; if (!BK.cur) next(); } draw(); }, 50); }
    const waiting = H().candidates ? H().candidates().length : 0;
    const intro = `Hi! Drop your files here and I'll do the bookkeeping for <b>${esc(S().company)}</b>. I only ask about what I can't figure out.<br>I can read:<br>• bank and card statements (.QBO, .QFX, .OFX), for any of your companies<br>• PDF bank statements with check pictures (I fill in who each check was paid to)<br>• receipts, bills and invoices (photos, screenshots or PDFs)`;
    const msgs = [{ who: 'a', html: intro }].concat(BK.msgs);
    return `<div class="panel" id="bkDrop"><div class="page-head" style="margin:0"><div><h2 style="margin:0">AI Bookkeeper</h2>
      <p class="sub small">Answers are saved right away. Anything I sort on my own can be undone, and I learn from your answers.</p></div>
      ${BK.msgs.length ? '<button class="link" data-act="bkClear">Clear chat</button>' : ''}</div>
      <div class="chat" id="bkChat" style="max-height:none">${msgs.map(m => `<div class="msg bk ${m.who === 'q' ? 'q' : m.who === 'err' ? 'a err' : 'a'}">${m.html}</div>`).join('')}
      ${BK.cur && !BK.busy ? `<div class="msg bk a bk-card" id="bkCard">${card(BK.cur)}${BK.q.length ? `<div class="small muted" style="margin-top:6px">${plural(BK.q.length, 'more question')} after this.</div>` : ''}</div>` : ''}
      ${BK.busy ? `<div class="msg bk a"><span class="spin"></span>${esc(BK.busy)}</div>` : ''}</div>
      <div class="bk-drop"><div><b>Drop files here</b> <span class="muted small">or</span> <button class="btn sm primary" data-act="bkFiles"${BK.busy ? ' disabled' : ''}>Add files…</button><input type="file" id="bkIn" multiple hidden accept=".qbo,.qfx,.ofx,.QBO,.QFX,.OFX,.pdf,image/*,.heic,.csv,.xlsx,.xls,.iif"></div>
      ${waiting && !BK.cur && !BK.busy ? `<button class="btn sm" data-act="bkStart">Sort the ${plural(waiting, 'transaction')} waiting</button>` : ''}</div></div>`;
  };
  const prevAfter = afterRender.ai;
  afterRender.ai = () => {
    if (prevAfter) prevAfter();
    if (ST.tab !== 'chat') return;
    const inp = document.querySelector('#bkIn'); if (inp) inp.addEventListener('change', () => { const f = Array.from(inp.files); inp.value = ''; handleFiles(f); });
    const dz = document.querySelector('#bkDrop');
    if (dz) {
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('bk-over'); });
      dz.addEventListener('dragleave', e => { if (!dz.contains(e.relatedTarget)) dz.classList.remove('bk-over'); });
      dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('bk-over'); handleFiles(e.dataTransfer.files); });
    }
    const say = document.querySelector('#bkSay'); if (say) say.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); acts.bkSay(); } });
    const c = document.querySelector('#bkChat'); if (c && BK.cur) { const card = document.querySelector('#bkCard'); if (card) card.scrollIntoView({ block: 'nearest' }); }
  };

  // Import .QBO page: after importing, go straight to the Bookkeeper
  const baseImport = acts.doImport;
  if (baseImport) acts.doImport = b => {
    baseImport(b);
    if (!L.viewState.import.pending && ready() && H().candidates && H().candidates().length) { ST.tab = 'chat'; ST.bkAutoStart = true; L.go('ai'); }
  };
  // Bank and card registers: upload statements straight into that account; then the Bookkeeper sorts them
  const baseReg = L.views.register;
  L.views.register = () => {
    const html = baseReg(), a = acc(L.viewState.register.acct);
    if (!a || !(isBank(a) || isCard(a))) return html;
    return html.replace('<button class="btn" data-act="exportRegister">', `<label class="btn primary" for="regUp" title="Add statement files (.QBO, .QFX, .OFX) to ${esc(a.name)}">Upload statements</label><input type="file" id="regUp" multiple hidden accept=".qbo,.qfx,.ofx,.QBO,.QFX,.OFX,.pdf,.PDF"><button class="btn" data-act="exportRegister">`);
  };
  document.addEventListener('change', async e => {
    if (e.target.id !== 'regUp' || !e.target.files.length) return;
    let files = Array.from(e.target.files); e.target.value = '';
    const a = acc(L.viewState.register.acct); if (!a) return;
    const pdfs = files.filter(f => /\.pdf$/i.test(f.name)); files = files.filter(f => !/\.pdf$/i.test(f.name));
    if (pdfs.length && !files.length) { BK.forceAcct = a.id; ST.tab = 'chat'; L.go('ai'); await handleFiles(pdfs); BK.forceAcct = null; return; }
    let added = 0, dup = 0, skipped = [];
    for (const f of files) {
      let stmts; try { stmts = C.parseOFX(await f.text()); } catch (err) { skipped.push(f.name + ' (not a statement file)'); continue; }
      for (const st of stmts) {
        const other = st.acctId && S().accounts.find(x => x.id !== a.id && x.ofxId && String(x.ofxId) === String(st.acctId));
        if (other) { skipped.push(f.name + ' is for ' + other.name); continue; }
        if ((st.kind === 'credit') !== isCard(a)) { skipped.push(f.name + ' is a ' + (st.kind === 'credit' ? 'credit card' : 'bank') + ' statement'); continue; }
        st.fileName = f.name; st.target = a.id;
        const before = st.txns.length, r = L.doImport(st); added += r.n; dup += before - r.n;
      }
    }
    if (L.smartCategorizeExisting) L.smartCategorizeExisting();
    L.save(); L.updateBadge();
    toast(`${plural(added, 'new transaction')} added to ${a.name}${dup ? ' · ' + dup + ' already there' : ''}${skipped.length ? ' · skipped: ' + skipped.join('; ') : ''}`);
    if (pdfs.length) { BK.forceAcct = a.id; ST.tab = 'chat'; L.go('ai'); await handleFiles(pdfs); BK.forceAcct = null; return; }
    if (added && ready() && H().candidates && H().candidates().length) { ST.tab = 'chat'; ST.bkAutoStart = true; L.go('ai'); } else L.render();
  });
  ST.bkFiles = handleFiles; // for tests
})();
