/* Ledger Desk AI Assistant. The AI runs on the Ledger Desk server PC (Ollama). Nothing is sent anywhere else.
   It only suggests: nothing in the books changes until you click Approve or Apply. */
(function () {
  'use strict';
  const L = window.ledgerDeskApp, SV = window.ledgerServer;
  if (!L || !SV) return;
  const { C, views, acts, afterRender, viewState, esc, money, usDate, toast, acc } = L;
  const $ = s => document.querySelector(s);
  const ST = viewState.ai = { status: null, sugg: [], busy: '', progress: '', chat: [], asking: false, check: null, checkBusy: false, checkImg: '' };

  // ----- sidebar button -----
  const nav = $('#nav'), after = nav.querySelector('[data-view="register"]');
  const nb = document.createElement('button');
  nb.dataset.view = 'ai'; nb.innerHTML = '<span><span class="ai-dot" id="aiDot"></span>AI Assistant</span>';
  after.insertAdjacentElement('afterend', nb);

  async function refreshStatus() {
    ST.statusAt = Date.now();
    try { ST.status = await SV.api('/api/ai/status'); } catch (e) { ST.status = { ok: false, reason: e.message }; }
    const d = $('#aiDot'); if (d) d.className = 'ai-dot ' + (ST.status.ok && ST.status.hasText ? 'on' : 'off');
    if (L.view === 'ai') L.render();
  }
  refreshStatus(); setInterval(refreshStatus, 60000);

  // A shortcut on the Transactions screen
  const baseReg = views.register;
  views.register = () => baseReg().replace('<button class="btn" data-act="autoAll"', '<button class="btn" data-act="goto" data-v="ai" title="Let the AI suggest categories for what is left">Ask AI to sort</button><button class="btn" data-act="autoAll"');

  // ---------------- 1. suggest categories ----------------
  const S = () => L.S;
  function candidates() {
    return L.live().filter(t => L.isUncat(t) && t.source !== 'income' && t.source !== 'opening' && !t.matchOf && !t.transferWith)
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  function categoryList() {
    return S().accounts.filter(a => !a.archived && a.sys !== 'uncatIn' && a.sys !== 'uncatOut' && a.sys !== 'obe' && a.sys !== 'deposits')
      .map(a => ({ id: a.id, name: a.name, type: a.type === 'liability' ? (a.detail === 'credit' ? 'credit card' : a.detail === 'loan' ? 'loan' : 'liability') : a.type === 'asset' ? (a.detail === 'bank' ? 'bank account' : 'asset') : a.type }));
  }
  // ----- learning from your fixes -----
  // Every approved AI suggestion is logged (right or changed). A later change in Transactions counts as a fix.
  // Fixes go to the AI first, as "the owner corrected this", and repeated fixes offer a Bank Rule.
  const log = () => S().aiLog || (S().aiLog = []);
  const sgn = t => t.amount < 0 ? 'o' : 'i';
  function logResult(t, ai, to) {
    const ok = ai && ai === to ? 1 : 0;
    t.aiCat = ai || ''; if (!ok) t.aiFixed = 1; else delete t.aiFixed;
    const L2 = log(), old = L2.findIndex(e => e.id === t.id); if (old > -1) L2.splice(old, 1);
    L2.push({ id: t.id, d: L.today(), ok, p: C.normPayee(t.payee), py: t.payee, s: sgn(t), ai: ai || '', to });
    if (L2.length > 3000) L2.splice(0, L2.length - 3000);
  }
  function scanFixes() {
    let n = 0;
    S().txns.forEach(t => {
      if (!t.aiCat || t.aiFixed || t.categoryId === t.aiCat || L.isUncat(t)) return;
      t.aiFixed = 1; n++;
      const e = log().find(e => e.id === t.id);
      if (e) { e.ok = 0; e.to = t.categoryId; e.late = 1; }
      else log().push({ id: t.id, d: L.today(), ok: 0, p: C.normPayee(t.payee), py: t.payee, s: sgn(t), ai: t.aiCat, to: t.categoryId, late: 1 });
    });
    return n;
  }
  function corrections() {
    const seen = new Set(), out = [];
    log().slice().reverse().forEach(e => {
      if (e.ok || e.forgot) return; const k = e.p + '|' + e.s; if (seen.has(k)) return; seen.add(k);
      const to = acc(e.to); if (!to || to.archived) return; const was = acc(e.ai);
      out.push({ k, payee: e.py + (e.s === 'o' ? ' (money out)' : ' (money in)') + ' [the owner corrected the AI' + (was ? ', which had picked ' + was.name : '') + '; use this category]', category: to.name, e });
    });
    return out.slice(0, 40);
  }
  function accuracy(from) {
    const xs = log().filter(e => !from || e.d >= from), ok = xs.filter(e => e.ok).length;
    return { n: xs.length, ok, pct: xs.length ? Math.round(ok * 100 / xs.length) : null };
  }
  function ruleOffers() {
    const g = {};
    log().forEach(e => { if (e.ok || !e.to || e.forgot) return; const k = e.p + '|' + e.s + '|' + e.to; (g[k] = g[k] || { k, n: 0 }).n++; g[k].e = e; });
    return Object.values(g).filter(x => {
      if (x.n < 2 || dism().includes('rule:' + x.k) || !acc(x.e.to)) return false;
      const r = C.matchRule(S().rules, { payee: x.e.py, memo: '', amount: x.e.s === 'o' ? -1 : 1 });
      return !(r && r.categoryId === x.e.to);
    }).sort((a, b) => b.n - a.n).slice(0, 5);
  }
  acts.aiMakeRule = b => {
    const x = ruleOffers().find(o => o.k === b.dataset.k); if (!x) return;
    const match = L.suggestMatch(x.e.py);
    S().rules.push({ id: L.uid(), match, sign: x.e.s === 'o' ? 'out' : 'in', categoryId: x.e.to, rename: '' });
    const n = L.applyRulesToUncat ? L.applyRulesToUncat() : 0;
    L.save(); L.updateBadge(); L.render();
    toast('Rule made: "' + match + '" → ' + acc(x.e.to).name + (n ? ' · ' + n + ' waiting transaction' + (n === 1 ? '' : 's') + ' sorted' : ''));
  };
  acts.aiNoRule = b => { dism().push('rule:' + b.dataset.k); L.save(); L.render(); };
  acts.aiForget = b => { const k = b.dataset.k; log().forEach(e => { if (e.p + '|' + e.s === k && !e.ok) e.forgot = 1; }); L.save(); L.render(); toast('Forgotten. The AI won\'t use that fix any more.'); };
  acts.aiLearned = () => { ST.showLearned = !ST.showLearned; L.render(); };

  function examples() {
    const seen = new Set(), out = [];
    corrections().forEach(c => { seen.add(c.k); out.push({ payee: c.payee, category: c.category }); });
    S().txns.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach(t => {
      if (out.length >= 120 || t.ignored || L.isUncat(t) || t.source === 'income' || t.source === 'opening') return;
      const c = acc(t.categoryId); if (!c || c.sys === 'deposits') return;
      const k = C.normPayee(t.payee) + '|' + sgn(t);
      if (seen.has(k)) return; seen.add(k);
      out.push({ payee: t.payee + (t.amount < 0 ? ' (money out)' : ' (money in)'), category: c.name });
    });
    return out;
  }
  async function suggest() {
    if (scanFixes()) L.save();
    const list = candidates().slice(0, 100);
    if (!list.length) { toast('Nothing is waiting for a category.'); return; }
    const cats = categoryList(), byName = {}; cats.forEach(c => { if (!byName[c.name]) byName[c.name] = c.id; });
    const rules = S().rules.map(r => ({ match: r.match, sign: r.sign, category: (acc(r.categoryId) || {}).name })).filter(r => r.category);
    const ex = examples();
    ST.sugg = ST.sugg.filter(x => x.state === 'new' && list.some(t => t.id === x.id));
    const todo = list.filter(t => !ST.sugg.some(x => x.id === t.id));
    ST.busy = 'sugg';
    for (let i = 0; i < todo.length; i += 20) {
      const batch = todo.slice(i, i + 20);
      ST.progress = 'Working on ' + (i + 1) + '–' + (i + batch.length) + ' of ' + todo.length + '…'; if (L.view === 'ai') L.render();
      try {
        const r = await SV.post('/api/ai/categorize', {
          business: S().company, notes: ST.h.notesFor(), categories: cats.map(c => ({ name: c.name, type: c.type })), rules, examples: ex,
          txns: batch.map(t => { const a = acc(t.accountId) || {}; return { id: t.id, date: t.date, payee: t.payee, memo: t.memo || '', amount: t.amount, account: a.name, accountKind: a.detail === 'credit' ? 'credit card' : a.detail === 'loan' ? 'loan' : 'bank', bankDeposit: L.isBankDeposit(t) }; })
        });
        r.results.forEach(x => {
          const t = S().txns.find(y => y.id === x.id), id = byName[x.category];
          if (!t || !id) return;
          let ok = L.allowedCat(t, id);
          if (ok && ST.isCardPay && ST.isCardPay(t) && ['income', 'expense', 'equity'].includes((acc(id) || {}).type)) { const from = (S().cardPayFrom || {})[t.accountId]; ST.sugg.push({ id: t.id, ai: '', catId: from && acc(from) ? from : '', conf: from ? 'high' : 'low', reason: 'This is a payment to the credit card from a bank account. Choose the bank account it came from (not income or a draw).', state: 'new', rule: false }); return; }
          ST.sugg.push({ id: t.id, ai: ok ? id : '', catId: ok ? id : '', conf: ok ? x.confidence : 'low', reason: ok ? x.reason : 'The AI picked ' + x.category + ', which isn\'t allowed here. Choose a category.', state: 'new', rule: false });
        });
      } catch (e) { ST.busy = ''; ST.progress = ''; L.render(); toast('AI: ' + e.message); return; }
    }
    ST.busy = ''; ST.progress = '';
    if (L.view === 'ai') L.render();
    toast('Suggestions ready. Nothing changes until you approve.');
  }
  function approve(x, catId) {
    const t = S().txns.find(y => y.id === x.id);
    if (!t || !catId || !L.allowedCat(t, catId)) return false;
    t.categoryId = catId;
    logResult(t, x.ai, catId);
    t.why = 'AI suggestion you approved' + (x.reason ? ': ' + x.reason : '');
    if (x.rule) {
      const match = L.suggestMatch(t.payee);
      if (!S().rules.some(r => r.match.toLowerCase() === match.toLowerCase() && r.categoryId === catId)) S().rules.push({ id: L.uid(), match, sign: t.amount < 0 ? 'out' : 'in', categoryId: catId, rename: '' });
    }
    x.state = 'done';
    return true;
  }
  // shared with the PDF check reader (checks.js)
  ST.h = { notesFor: () => { const n = S().aiNotes || '', t = ST.taxHint ? ST.taxHint() : ''; return t ? (n + '\n\n' + t).slice(0, 2990) : n; }, categoryList, examples, logResult, candidates, docMatches: d => docMatches(d), expenseNames: () => expenseNames(), shrink: f => shrink(f), rulesForAI: () => S().rules.map(r => ({ match: r.match, sign: r.sign, category: (acc(r.categoryId) || {}).name })).filter(r => r.category), aiReady: () => aiReady(), visionReady: () => visionReady() };
  acts.aiSuggest = () => { if (!ST.busy) suggest(); };
  acts.aiApprove = b => {
    const x = ST.sugg.find(y => y.id === b.closest('tr').dataset.id), sel = b.closest('tr').querySelector('select');
    if (!approve(x, sel.value)) { toast('Choose a category first'); return; }
    L.save(); L.updateBadge(); L.render();
  };
  acts.aiSkip = b => { const x = ST.sugg.find(y => y.id === b.closest('tr').dataset.id); x.state = 'skipped'; L.render(); };
  acts.aiApproveHigh = () => {
    let n = 0; ST.sugg.filter(x => x.state === 'new' && x.conf === 'high' && x.catId).forEach(x => { if (approve(x, x.catId)) n++; });
    L.save(); L.updateBadge(); L.render(); toast(n + ' approved');
  };
  acts.aiClear = () => { ST.sugg = []; L.render(); };
  acts.aiProv = async b => {
    const want = b.dataset.p, g = ST.status && ST.status.gemini; if (!g || (want === 'gemini') === !!g.on) return;
    const go = async () => { try { await SV.post('/api/me/ai', { provider: want }); toast(want === 'gemini' ? 'Using Google Gemini for your AI requests' : 'Using this PC\'s AI again'); } catch (e) { toast(e.message); } await refreshStatus(); L.render(); };
    if (want === 'local') return go();
    L.modal(`<h2>Use Google Gemini?</h2>
      <p>Gemini is Google's AI. It's smarter and faster than the AI on the server PC.</p>
      <ul class="small" style="padding-left:18px;line-height:1.6"><li><b>What goes to Google:</b> only what each AI request needs (the transactions you ask it to sort, your question and the figures for it, a receipt or check picture). Your whole books are not sent and stay locked on the server PC.</li>
      <li>It uses ${esc(SV.me.admin ? 'your' : 'the owner\'s')} paid Google account. Google says it doesn't use paid requests to train its AI, but keeps them for a short time for abuse checks.</li>
      <li>You can switch back to <b>This PC's AI</b> any time. If Google doesn't answer, Ledger Desk uses this PC's AI automatically.</li>
      <li>Everything you approve or fix still teaches Ledger Desk, whichever AI you use.</li></ul>
      <div class="actions"><button class="btn" id="gNo">Keep this PC's AI</button><button class="btn primary" id="gYes">Use Gemini</button></div>`, card => { card.querySelector('#gNo').onclick = L.closeModal; card.querySelector('#gYes').onclick = () => { L.closeModal(); go(); }; });
  };
  // Gemini writes better "Notes for the AI" from how this company was categorized; the PC's own AI reads them every time.
  function historySummary() {
    const g = {};
    L.live().forEach(t => { if (L.isUncat(t) || t.source === 'income' || t.source === 'opening') return; const c = acc(t.categoryId); if (!c || c.sys === 'deposits') return;
      const k = C.normPayee(t.payee) + '|' + (t.amount < 0 ? 'out' : 'in') + '|' + c.name; const x = g[k] || (g[k] = { p: t.payee, s: t.amount < 0 ? 'out' : 'in', c: c.name, n: 0 }); x.n++; });
    return Object.values(g).sort((a, b) => b.n - a.n).slice(0, 400).map(x => `${x.p} | ${x.s} | ${x.c} | ${x.n}`).join('\n');
  }
  async function teach(card) {
    const btn = card.querySelector('#nTeach'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Gemini is studying ' + esc(S().company) + '…';
    try {
      const r = await SV.post('/api/ai/teach', { company: S().company, business: S().company, notes: card.querySelector('#nTxt').value, categories: categoryList().map(c => c.name), history: historySummary() });
      card.querySelector('#nTxt').value = r.notes || ''; card.querySelector('#nHint').innerHTML = '<b>Gemini rewrote these notes from how this company\'s transactions were categorized.</b> Read them over, change anything, then click Save. The AI on this PC follows them from now on.';
    } catch (e) { toast('Gemini: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Teach this PC\'s AI with Gemini';
  }
  acts.aiNotes = () => {
    L.modal(`<h2>Notes for the AI (${esc(S().company)})</h2><p class="muted small" style="margin-top:0">Tell the AI how this company's books work. It reads these every time it suggests categories. For example: "We run hotels. Sam's Club, Walmart and Costco are Hotel Supplies. A RAJU payments are Payroll."</p>
      <textarea id="nTxt" style="width:100%;min-height:180px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px" maxlength="3000">${esc(S().aiNotes || '')}</textarea>
      <p class="small muted" id="nHint" style="margin:6px 0 0">${ST.status && ST.status.gemini && ST.status.gemini.on ? 'Tip: "Teach this PC\'s AI with Gemini" has Gemini study how this company was categorized and write these notes for you, so the AI on the server PC gets smarter too.' : ''}</p>
      <div class="actions">${ST.status && ST.status.gemini && ST.status.gemini.on ? '<button class="btn" id="nTeach" style="margin-right:auto">Teach this PC\'s AI with Gemini</button>' : ''}<button class="btn" id="nCancel">Cancel</button><button class="btn primary" id="nSave">Save notes</button></div>`, card => {
      card.querySelector('#nCancel').onclick = L.closeModal;
      const tb = card.querySelector('#nTeach'); if (tb) tb.onclick = () => teach(card);
      card.querySelector('#nSave').onclick = () => { S().aiNotes = card.querySelector('#nTxt').value.trim(); L.save(); L.closeModal(); L.render(); toast('Notes saved'); };
    });
  };

  // ---------------- 2. ask your books ----------------
  const STOP = new Set('what how much many did does the and for was were are our from with this that than have has spend spent paid pay total show list give tell about which when last year month months this week all any our out money expenses expense income'.split(' '));
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function bookContext(question) {
    const s = S(), live = L.live(), out = [];
    const r2 = n => (Math.round(n * 100) / 100).toFixed(2);
    const dates = live.map(t => t.date).sort();
    out.push('Company: ' + s.company + '. Transactions in the books: ' + live.length + (dates.length ? ', from ' + dates[0] + ' to ' + dates[dates.length - 1] : '') + '.');
    out.push('Bank deposits are never counted as income in these books; income is recorded separately with "Record income".');
    const all = C.debits(live);
    out.push('\nACCOUNT BALANCES TODAY (name | kind | balance; cards and loans = amount owed):');
    s.accounts.filter(a => (a.type === 'asset' || a.type === 'liability') && !a.archived).forEach(a => out.push(a.name + ' | ' + (a.detail || a.type) + ' | ' + r2(C.natural(a, all[a.id]))));
    // monthly totals per category, last 13 months
    const d = new Date(), keys = [];
    for (let i = 12; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); keys.push(x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0')); }
    const cats = s.accounts.filter(a => a.type === 'income' || a.type === 'expense' || a.type === 'equity');
    const m = {}; cats.forEach(a => m[a.id] = keys.map(() => 0));
    live.forEach(t => { const c = acc(t.categoryId); if (!c || !m[c.id]) return; const i = keys.indexOf(t.date.slice(0, 7)); if (i > -1) m[c.id][i] += C.categoryAmount(c, t); });
    out.push('\nMONTHLY TOTALS BY CATEGORY (expenses as positive spending; columns ' + keys.join(', ') + '):');
    cats.forEach(c => { if (m[c.id].some(v => Math.abs(v) >= 0.005)) out.push(c.name + ' (' + c.type + ') | ' + m[c.id].map(r2).join(' | ')); });
    const y = d.getFullYear();
    [y, y - 1].forEach(yr => {
      const tot = C.debits(live, { from: yr + '-01-01', to: yr + '-12-31' });
      const lines = cats.map(c => ({ c, v: C.natural(c, tot[c.id]) })).filter(x => Math.abs(x.v) >= 0.005);
      if (!lines.length) return;
      out.push('\nTOTALS FOR ' + yr + (yr === y ? ' (year to date)' : '') + ':');
      lines.forEach(x => out.push(x.c.name + ' (' + x.c.type + ') | ' + r2(x.v)));
      const inc = lines.filter(x => x.c.type === 'income').reduce((a, x) => a + x.v, 0), exp = lines.filter(x => x.c.type === 'expense').reduce((a, x) => a + x.v, 0);
      out.push('Total income ' + r2(inc) + ' | Total expenses ' + r2(exp) + ' | Net profit ' + r2(inc - exp));
    });
    const unc = live.filter(L.isUncat);
    out.push('\nUncategorized transactions: ' + unc.length + (unc.length ? ' (money out ' + r2(-unc.filter(t => t.amount < 0).reduce((a, t) => a + t.amount, 0)) + ', money in ' + r2(unc.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0)) + ')' : ''));
    // top payees by spending, last 12 months
    const since = keys[1] + '-01', pay = {};
    live.forEach(t => { if (t.date < since || t.amount >= 0) return; const c = acc(t.categoryId); if (!c || c.type !== 'expense') return; const k = C.normPayee(t.payee) || t.payee; const p = pay[k] = pay[k] || { name: t.payee, v: 0, n: 0, cat: {} }; p.v -= t.amount; p.n++; p.cat[c.name] = (p.cat[c.name] || 0) + 1; });
    const top = Object.values(pay).sort((a, b) => b.v - a.v).slice(0, 40);
    if (top.length) { out.push('\nTOP PAYEES BY SPENDING SINCE ' + since + ' (payee | total | count | category):'); top.forEach(p => out.push(p.name + ' | ' + r2(p.v) + ' | ' + p.n + ' | ' + Object.keys(p.cat).sort((a, b) => p.cat[b] - p.cat[a])[0])); }
    // transactions that match words in the question
    const ql = question.toLowerCase();
    const words = Array.from(new Set(ql.replace(/[^a-z0-9&' ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w) && MONTHS.indexOf(w) < 0 && !/^\d+$/.test(w))));
    const mi = MONTHS.findIndex(mn => ql.indexOf(mn) > -1 || ql.indexOf(' ' + mn.slice(0, 3) + ' ') > -1);
    const yrm = /\b(20\d\d)\b/.exec(ql);
    if (words.length || mi > -1) {
      const hits = live.filter(t => {
        if (mi > -1 && +t.date.slice(5, 7) !== mi + 1) return false;
        if (yrm && t.date.slice(0, 4) !== yrm[1]) return false;
        if (!words.length) return true;
        const hay = (t.payee + ' ' + (t.memo || '') + ' ' + ((acc(t.categoryId) || {}).name || '') + ' ' + ((acc(t.accountId) || {}).name || '')).toLowerCase();
        return words.some(w => hay.indexOf(w) > -1);
      }).sort((a, b) => b.date.localeCompare(a.date));
      if (hits.length) {
        const outSum = hits.filter(t => t.amount < 0).reduce((a, t) => a - t.amount, 0), inSum = hits.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0);
        out.push('\nTRANSACTIONS MATCHING THE QUESTION (' + hits.length + ' found' + (hits.length > 150 ? ', newest 150 listed' : '') + '; all ' + hits.length + ' together: money out ' + r2(outSum) + ', money in ' + r2(inSum) + '):');
        out.push('date | account | payee | category | amount (negative = money out of a bank, or a charge on a card)');
        hits.slice(0, 150).forEach(t => out.push(t.date + ' | ' + ((acc(t.accountId) || {}).name || '') + ' | ' + t.payee + (t.memo ? ' (' + t.memo.slice(0, 60) + ')' : '') + ' | ' + (L.isUncat(t) ? 'Uncategorized' : (acc(t.categoryId) || {}).name) + ' | ' + r2(t.amount)));
      } else out.push('\nNo transactions match the words in the question (' + words.join(', ') + ').');
    }
    (ST.ctxExtra || []).forEach(f => { try { out.push(f(question)); } catch (e) {} });
    return out.join('\n');
  }
  // "Run the P&L for last year", "show me the balance sheet", "P&L for September in Excel": open the report instead of asking the AI
  function reportCommand(q) {
    const t = q.toLowerCase();
    const pl = /\b(p\s*&\s*l|p\s*and\s*l|pnl|profit\s*(and|&)\s*loss|income statement)\b/.test(t), bs = /\bbalance sheet\b/.test(t);
    if (!pl && !bs) return null;
    if (!/\b(run|show|open|pull|give|make|get|see|print|download|export|need|want|create|generate)\b/.test(t) && t.split(/\s+/).length > 6) return null;
    const MON = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const now = new Date(), Y = now.getFullYear(), pad = n => String(n).padStart(2, '0'), last = (y, m) => new Date(y, m, 0).getDate();
    let range = 'ytd', from = '', to = '';
    const yr = /\b(20\d\d)\b/.exec(t), mi = MON.findIndex(m => new RegExp('\\b' + m.slice(0, 3) + '(' + m.slice(3) + ')?\\b').test(t));
    if (mi > -1) { const y = yr ? Number(yr[1]) : (mi <= now.getMonth() ? Y : Y - 1); range = 'custom'; from = `${y}-${pad(mi + 1)}-01`; to = `${y}-${pad(mi + 1)}-${last(y, mi + 1)}`; }
    else if (yr) { range = 'custom'; from = yr[1] + '-01-01'; to = Number(yr[1]) === Y ? L.today() : yr[1] + '-12-31'; }
    else if (/last year/.test(t)) range = 'lastYear'; else if (/last month/.test(t)) range = 'lastMonth'; else if (/this month/.test(t)) range = 'thisMonth';
    else if (/this quarter|quarter/.test(t)) range = 'thisQuarter'; else if (/last 12|twelve months/.test(t)) range = 'last12'; else if (/all (time|dates)|since the start/.test(t)) range = 'all';
    return { tab: pl ? 'pl' : 'bs', range, from, to, excel: /\bexcel|xlsx|spreadsheet|download\b/.test(t) };
  }
  async function ask(q) {
    q = (q || '').trim(); if (!q || ST.asking) return;
    const cmd = reportCommand(q);
    if (cmd) {
      ST.chat.push({ role: 'user', text: q }, { role: 'assistant', text: 'Opening the ' + (cmd.tab === 'pl' ? 'Profit & Loss' : 'Balance Sheet') + (cmd.excel ? ' and downloading it as an Excel file.' : '. Use "Download Excel" at the top to save it.') });
      Object.assign(L.viewState.reports, cmd.tab === 'bs' ? { tab: 'bs', range: 'custom', from: '', to: cmd.to || L.today() } : { tab: 'pl', range: cmd.range, from: cmd.from, to: cmd.to });
      L.go('reports'); if (cmd.excel) setTimeout(() => acts.exportXlsx && acts.exportXlsx(), 300);
      return;
    }
    const history = ST.chat.filter(m => !m.err).slice(-6).map(m => ({ role: m.role, content: m.text }));
    ST.chat.push({ role: 'user', text: q }); ST.asking = true; L.render();
    try {
      const r = await SV.post('/api/ai/ask', { question: q, context: bookContext(q), history });
      ST.chat.push({ role: 'assistant', text: r.answer });
    } catch (e) { ST.chat.push({ role: 'assistant', text: 'The AI could not answer: ' + e.message, err: true }); }
    ST.asking = false;
    if (L.view === 'ai') { L.render(); const c = $('#chat'); if (c) c.scrollTop = c.scrollHeight; }
  }
  acts.aiAsk = () => { const el = $('#askQ'); const q = el.value; el.value = ''; ask(q); };
  acts.aiEx = b => ask(b.textContent);
  acts.aiChatClear = () => { ST.chat = []; L.render(); };

  // ================= shared helpers for the skills =================
  const r2 = n => Math.round(n * 100) / 100;
  const pad = n => String(n).padStart(2, '0');
  const ym = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
  const monthEnd = k => { const d = new Date(+k.slice(0, 4), +k.slice(5, 7), 0); return k + '-' + pad(d.getDate()); };
  const shiftMonth = (k, n) => ym(new Date(+k.slice(0, 4), +k.slice(5, 7) - 1 + n, 1));
  const monthName = k => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const lastFull = () => shiftMonth(ym(new Date()), -1);
  const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
  const isTransferLike = t => { const c = acc(t.categoryId); return !!c && (c.type === 'asset' || c.type === 'liability' || c.type === 'equity'); };
  const realOut = t => t.amount < 0 && !t.ignored && !t.matchOf && t.source !== 'opening' && t.source !== 'income';
  const median = a => { const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const monthOptions = sel => { const out = [], now = ym(new Date()); for (let i = 0; i < 24; i++) { const k = shiftMonth(now, -i); out.push(`<option value="${k}"${k === sel ? ' selected' : ''}>${monthName(k)}</option>`); } return out.join(''); };
  const openRegister = (opts) => { Object.assign(viewState.register, { acct: 'all', uncat: false, q: '', range: 'custom', from: '', to: '' }, opts); L.go('register'); };
  const aiReady = () => ST.status && ST.status.ok && ST.status.hasText;
  const visionReady = () => ST.status && ST.status.ok && ST.status.hasVision;
  const dism = () => S().aiDismissed || (S().aiDismissed = []);
  Object.assign(ST, { tab: 'chat', month: lastFull(), sum: null, sumBusy: false, probs: null, aiFlags: null, flagBusy: false, doc: null, docBusy: false, docImg: '' });

  // ================= Month-end check (exact, no AI needed) =================
  function monthEndCheck(k) {
    const from = k + '-01', to = monthEnd(k), inM = t => t.date >= from && t.date <= to;
    const live = L.live(), out = [];
    const unc = live.filter(t => inM(t) && L.isUncat(t) && t.source !== 'income');
    out.push({ ok: !unc.length, title: unc.length ? unc.length + ' transaction' + (unc.length === 1 ? '' : 's') + ' still need a category' : 'Everything is categorized', detail: unc.length ? money(unc.filter(t => t.amount < 0).reduce((a, t) => a - t.amount, 0)) + ' money out, ' + money(unc.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0)) + ' money in' : '', act: unc.length ? ['Show them', 'meUncat'] : null, fix: unc.length ? ['Ask AI to sort', 'meSort'] : null });
    const dep = L.sysAcc('deposits'), deps = dep ? live.filter(t => inM(t) && t.categoryId === dep.id) : [];
    out.push({ ok: !deps.length, info: true, title: deps.length ? deps.length + ' bank deposit' + (deps.length === 1 ? '' : 's') + ' (' + money(deps.reduce((a, t) => a + t.amount, 0)) + ') not recorded as income yet' : 'No deposits waiting to be recorded as income', detail: deps.length ? 'Deposits are never counted as income automatically. Record the income yourself (Record income › "Already in a bank deposit").' : '', act: deps.length ? ['Show deposits', 'meDeps'] : null });
    const unm = live.filter(t => { const a = acc(t.accountId), c = acc(t.categoryId); return inM(t) && a && a.type === 'liability' && a.detail !== 'loan' && t.amount > 0 && !t.transferWith && !t.matchOf && !(c && c.type === 'asset'); });
    out.push({ ok: !unm.length, title: unm.length ? unm.length + ' card payment' + (unm.length === 1 ? '' : 's') + ' or refund' + (unm.length === 1 ? '' : 's') + ' not matched to a bank account' : 'All card payments are matched to the bank', detail: unm.length ? unm.slice(0, 4).map(t => usDate(t.date) + ' ' + (acc(t.accountId) || {}).name + ' ' + money(t.amount)).join(' · ') + (unm.length > 4 ? ' …' : '') + '. Import the bank statement, then click Auto-categorize on Transactions; or set the category to the bank account.' : '', act: unm.length ? ['Show them', 'meUnm'] : null });
    const dups = findDuplicates(live.filter(inM));
    out.push({ ok: !dups.length, title: dups.length ? dups.length + ' possible double charge' + (dups.length === 1 ? '' : 's') : 'No double charges found', detail: dups.length ? 'Same amount, same payee, same account within 3 days. See Problems.' : '', act: dups.length ? ['Review', 'meProbs'] : null });
    const stale = L.registers().filter(a => a.detail !== 'loan' && !a.sample).map(a => {
      const ts = live.filter(t => t.accountId === a.id || t.categoryId === a.id); if (!ts.length) return null;
      const last = ts.reduce((m, t) => t.date > m ? t.date : m, '');
      return last < to && days(last, to) > 6 ? { a, last } : null;
    }).filter(Boolean);
    out.push({ ok: !stale.length, title: stale.length ? stale.length + ' account' + (stale.length === 1 ? ' looks' : 's look') + ' out of date' : 'Statements look up to date', detail: stale.length ? stale.map(x => x.a.name + ' (last transaction ' + usDate(x.last) + ')').join(' · ') + '. Import statements through ' + usDate(to) + '.' : '' });
    // balances on the last day of the month, to compare with the bank and card statements
    const d = C.debits(live, { to });
    const bal = L.registers().filter(a => !a.sample).map(a => ({ a, v: C.natural(a, d[a.id]) })).filter(x => Math.abs(x.v) > 0.004);
    return { items: out, bal, from, to };
  }
  acts.meUncat = () => openRegister({ uncat: true, from: ST.month + '-01', to: monthEnd(ST.month) });
  acts.meDeps = () => openRegister({ acct: L.sysAcc('deposits').id, from: ST.month + '-01', to: monthEnd(ST.month) });
  acts.meUnm = () => openRegister({ q: '', from: ST.month + '-01', to: monthEnd(ST.month) });
  acts.meSort = () => { ST.tab = 'sort'; L.render(); };
  acts.meProbs = () => { ST.tab = 'problems'; ST.probs = null; L.render(); };

  // ================= Explain my numbers =================
  function monthFigures(k) {
    const live = L.live(), totals = mk => { const d = C.debits(live, { from: mk + '-01', to: monthEnd(mk) }), o = {}; S().accounts.filter(a => a.type === 'income' || a.type === 'expense').forEach(a => { const v = C.natural(a, d[a.id]); if (Math.abs(v) > 0.004) o[a.id] = v; }); return o; };
    const cur = totals(k), prev = totals(shiftMonth(k, -1)), ly = totals(shiftMonth(k, -12));
    const sum = (o, type) => Object.keys(o).filter(id => (acc(id) || {}).type === type).reduce((a, id) => a + o[id], 0);
    const rows = Array.from(new Set(Object.keys(cur).concat(Object.keys(prev)))).map(id => ({ a: acc(id), cur: cur[id] || 0, prev: prev[id] || 0, ly: ly[id] })).filter(x => x.a).sort((x, y) => (x.a.type === y.a.type ? 0 : x.a.type === 'income' ? -1 : 1) || y.cur - x.cur);
    const from = k + '-01', to = monthEnd(k), pay = {};
    live.filter(t => t.date >= from && t.date <= to && realOut(t) && (acc(t.categoryId) || {}).type === 'expense').forEach(t => { const n = C.normPayee(t.payee) || t.payee; const p = pay[n] = pay[n] || { name: t.payee, v: 0, n: 0, cat: (acc(t.categoryId) || {}).name }; p.v -= t.amount; p.n++; });
    const payees = Object.values(pay).sort((a, b) => b.v - a.v).slice(0, 8);
    const inc = sum(cur, 'income'), exp = sum(cur, 'expense'), pinc = sum(prev, 'income'), pexp = sum(prev, 'expense');
    const hasLy = Object.keys(ly).length > 0, lyExp = sum(ly, 'expense');
    const movers = rows.filter(x => x.a.type === 'expense').map(x => ({ x, d: x.cur - x.prev })).filter(m => Math.abs(m.d) >= 50).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5);
    const facts = [`Company: ${S().company}. Month: ${monthName(k)}. Previous month: ${monthName(shiftMonth(k, -1))}.`,
      `Income recorded: ${r2(inc).toFixed(2)} (previous month ${r2(pinc).toFixed(2)}). Expenses: ${r2(exp).toFixed(2)} (previous month ${r2(pexp).toFixed(2)}${hasLy ? '; same month last year ' + r2(lyExp).toFixed(2) : ''}). Net: ${r2(inc - exp).toFixed(2)}.`,
      'Expenses by category this month | previous month | change:', ...rows.filter(x => x.a.type === 'expense').map(x => `${x.a.name} | ${r2(x.cur).toFixed(2)} | ${r2(x.prev).toFixed(2)} | ${(x.cur - x.prev >= 0 ? '+' : '') + r2(x.cur - x.prev).toFixed(2)}`),
      'Biggest changes:', ...movers.map(m => `${m.x.a.name}: ${(m.d >= 0 ? 'up ' : 'down ') + r2(Math.abs(m.d)).toFixed(2)}`),
      'Top payees this month (payee | total | count | category):', ...payees.map(p => `${p.name} | ${r2(p.v).toFixed(2)} | ${p.n} | ${p.cat}`),
      `Transactions still uncategorized this month: ${L.live().filter(t => t.date >= from && t.date <= to && L.isUncat(t)).length}.`].join('\n');
    return { rows, payees, inc, exp, pinc, pexp, movers, facts, k };
  }
  async function explain() {
    const f = monthFigures(ST.month);
    ST.sumBusy = true; ST.sum = null; L.render();
    try { ST.sum = Object.assign({ k: ST.month }, await SV.post('/api/ai/explain', { company: S().company, business: (S().aiNotes || '').slice(0, 120), facts: f.facts })); }
    catch (e) { toast('AI: ' + e.message); }
    ST.sumBusy = false; L.render();
  }
  acts.aiExplain = () => { if (!ST.sumBusy) explain(); };

  // ================= Spot problems =================
  function findDuplicates(list) {
    const out = [], seen = new Set();
    const cand = list.filter(t => !t.ignored && !t.matchOf && !t.transferWith && t.source !== 'opening' && t.source !== 'income' && Math.abs(t.amount) >= 1 && !isTransferLike(t) && !/TRANSFER|XFER|PAYMENT|DEPOSIT/i.test(t.payee + ' ' + (t.memo || ''))).sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i], b = cand[j];
      if (days(a.date, b.date) > 3) break;
      if (a.accountId !== b.accountId || a.amount !== b.amount || C.normPayee(a.payee) !== C.normPayee(b.payee)) continue;
      const key = 'dup:' + a.id + ':' + b.id; if (seen.has(b.id) || dism().includes(key)) continue;
      seen.add(b.id); out.push({ key, kind: 'Possible double charge', sev: 'high', t: b, other: a, reason: 'Same amount, payee and account as ' + usDate(a.date) + '.' });
    }
    return out;
  }
  function findProblems() {
    const live = L.live(), since = (() => { const d = new Date(); d.setDate(d.getDate() - 90); return d.toISOString().slice(0, 10); })();
    const recent = live.filter(t => t.date >= since);
    const out = findDuplicates(recent);
    // price jumps from regular vendors
    const byPayee = {};
    live.filter(t => realOut(t) && !isTransferLike(t) && !/PAYMENT|EPAYMENT|PMT|TRANSFER|XFER/i.test(t.payee)).forEach(t => { const k = C.normPayee(t.payee); if (k) (byPayee[k] = byPayee[k] || []).push(t); });
    Object.values(byPayee).forEach(ts => {
      ts.sort((a, b) => a.date.localeCompare(b.date));
      ts.forEach((t, i) => {
        if (t.date < since || i < 3) return;
        // only vendors that usually charge about the same (utilities, subscriptions, fees), not stores where every basket differs
        const prior = ts.slice(0, i).map(x => -x.amount), m = median(prior), spread = median(prior.map(x => Math.abs(x - m))), v = -t.amount, key = 'jump:' + t.id;
        if (m > 0 && spread / m <= 0.2 && v > Math.max(m * 1.5, m + 50) && !dism().includes(key)) out.push({ key, kind: 'Higher than usual', sev: v > m * 2.5 ? 'high' : 'medium', t, reason: 'Usually about ' + money(m) + ' (' + i + ' earlier charges); this one is ' + money(v) + '.' });
      });
      // new repeating charges (subscriptions)
      const first = ts[0];
      const acctStart = L.live().filter(x => x.accountId === first.accountId).reduce((m, x) => x.date < m ? x.date : m, first.date);
      if (ts.length >= 2 && first.date >= since && days(acctStart, first.date) > 45) {
        const a = -ts[ts.length - 1].amount, b = -ts[ts.length - 2].amount, key = 'new:' + C.normPayee(first.payee);
        if (Math.abs(a - b) <= Math.max(1, b * 0.1) && days(ts[ts.length - 2].date, ts[ts.length - 1].date) >= 6 && !dism().includes(key))
          out.push({ key, kind: 'New repeating charge', sev: 'medium', t: ts[ts.length - 1], reason: 'Started ' + usDate(first.date) + ', ' + ts.length + ' charges of about ' + money(a) + '. A new subscription?' });
      }
    });
    const order = { high: 0, medium: 1 };
    return out.sort((a, b) => order[a.sev] - order[b.sev] || b.t.date.localeCompare(a.t.date));
  }
  async function aiReview() {
    const since = (() => { const d = new Date(); d.setDate(d.getDate() - 90); return d.toISOString().slice(0, 10); })();
    const list = L.live().filter(t => t.date >= since && realOut(t) && !isTransferLike(t) && !L.isUncat(t) && !dism().includes('ai:' + t.id)).sort((a, b) => a.amount - b.amount).slice(0, 80);
    ST.flagBusy = true; L.render();
    try {
      const r = await SV.post('/api/ai/review', { company: S().company, notes: S().aiNotes || '', txns: list.map(t => ({ id: t.id, date: t.date, payee: t.payee, amount: -t.amount, category: (acc(t.categoryId) || {}).name, account: (acc(t.accountId) || {}).name })) });
      ST.aiFlags = r.flags.map(f => ({ key: 'ai:' + f.id, kind: 'AI suggestion', sev: f.severity, t: S().txns.find(t => t.id === f.id), reason: f.reason })).filter(f => f.t);
    } catch (e) { toast('AI: ' + e.message); }
    ST.flagBusy = false; L.render();
  }
  acts.aiReview = () => { if (!ST.flagBusy) aiReview(); };
  const probByKey = k => (ST.probs || []).concat(ST.aiFlags || []).find(p => p.key === k);
  acts.prDismiss = b => { const k = b.closest('tr').dataset.key; dism().push(k); L.save(); ST.probs = (ST.probs || []).filter(p => p.key !== k); ST.aiFlags = (ST.aiFlags || []).filter(p => p.key !== k); L.render(); toast('Dismissed. It won\'t be flagged again.'); };
  acts.prOpen = b => { const p = probByKey(b.closest('tr').dataset.key); if (p && p.t) L.txnModal(p.t); };
  acts.prIgnore = b => {
    const k = b.closest('tr').dataset.key, p = probByKey(k); if (!p || !p.t) return;
    p.t.ignored = true; dism().push(k); L.save(); L.updateBadge();
    ST.probs = (ST.probs || []).filter(x => x.key !== k); L.render(); toast('Ignored the duplicate. It no longer counts in balances or reports (Transactions › Show ignored to restore).');
  };
  acts.prRefresh = () => { ST.probs = null; L.render(); };

  // ================= Receipts, bills, invoices, checks =================
  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.9);
  }
  const expenseNames = () => S().accounts.filter(a => !a.archived && a.type === 'expense' && !a.sys).map(a => a.name);
  async function readDoc(file) {
    if (!/^image\//.test(file.type)) { toast('Choose a picture (JPG or PNG): a phone photo, or a screenshot of a PDF bill or receipt.'); return; }
    ST.docBusy = true; ST.doc = null; L.render();
    try { ST.docImg = await shrink(file); L.render(); ST.doc = await SV.post('/api/ai/document', { image: ST.docImg, categories: expenseNames() }); }
    catch (e) { toast('AI: ' + e.message); }
    ST.docBusy = false; L.render();
  }
  function docMatches(d) {
    if (!d) return [];
    const total = d.total, when = d.date, num = d.kind === 'check' ? String(d.number || '').replace(/\D/g, '') : '';
    const vend = (d.vendor || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    return L.live().filter(t => t.amount < 0 && !t.matchOf && ['asset', 'liability'].includes((acc(t.accountId) || {}).type)).map(t => {
      let score = 0; const amt = -t.amount, hay = (t.payee + ' ' + (t.memo || '')).toLowerCase();
      if (num && (t.checkNum === num || new RegExp('(^|\\D)0*' + num + '(\\D|$)').test(hay))) score += 5;
      if (total && Math.abs(amt - total) < 0.005) score += 4; else if (total && amt > total && amt <= total * 1.25) score += 1; // tip added
      if (vend.some(w => hay.includes(w))) score += 2;
      if (when) { const dd = days(when, t.date); if (dd >= -3 && dd <= 45) score += dd <= 7 ? 2 : 1; else score -= 3; }
      return { t, score };
    }).filter(x => x.score >= 4).sort((a, b) => b.score - a.score).slice(0, 6).map(x => x.t);
  }
  acts.docApply = b => {
    const tr = b.closest('tr'), t = S().txns.find(y => y.id === tr.dataset.id), d = ST.doc;
    if (!t || !d) return;
    const pay = tr.querySelector('[data-f=payee]').value.trim(), cat = tr.querySelector('select').value;
    if (pay) { if (!t.origPayee) t.origPayee = t.payee; t.payee = pay; }
    const label = { receipt: 'Receipt', bill: 'Bill', invoice: 'Invoice', check: 'Check', other: 'Document' }[d.kind] || 'Document';
    const note = label + (d.number ? ' #' + d.number : '') + (d.memo ? ' ' + d.memo : '');
    if ((t.memo || '').indexOf(note) < 0) t.memo = ((t.memo ? t.memo + ' · ' : '') + note).trim();
    if (d.kind === 'check' && d.number) t.checkNum = String(d.number).replace(/\D/g, '');
    t.doc = { kind: d.kind, vendor: d.vendor, date: d.date, total: d.total, tax: d.tax, number: d.number };
    if (cat && L.allowedCat(t, cat)) { t.categoryId = cat; t.why = 'From the ' + label.toLowerCase() + ' picture'; }
    L.save(); L.updateBadge(); L.render(); toast('Updated: ' + t.payee);
  };
  acts.docClear = () => { ST.doc = null; ST.docImg = ''; L.render(); };

  // ================= the screen (tabs) =================
  const TABS = [['chat', 'Bookkeeper'], ['sort', 'Sort'], ['ask', 'Ask'], ['month', 'Month-end'], ['summary', 'Summary'], ['problems', 'Problems'], ['receipts', 'Receipts']];
  acts.aiTab = b => { ST.tab = b.dataset.tab; L.render(); };
  function learnPanel() {
    const m = accuracy(L.today().slice(0, 7) + '-01'), d = new Date(); d.setDate(d.getDate() - 90);
    const q = accuracy(d.toISOString().slice(0, 10)), all = accuracy(), fixes = corrections(), offers = ruleOffers();
    const pct = a => a.pct == null ? '<span class="muted">–</span>' : `<b class="${a.pct >= 90 ? 'pos' : a.pct < 70 ? 'neg' : ''}">${a.pct}%</b> <span class="muted small">(${a.ok} of ${a.n})</span>`;
    return `<div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0 0 12px">
      <div style="display:flex;flex-wrap:wrap;gap:6px 22px;align-items:center"><b>How often the AI is right</b>
        <span>This month ${pct(m)}</span><span>Last 90 days ${pct(q)}</span><span>All time ${pct(all)}</span>
        ${fixes.length ? `<button class="link" data-act="aiLearned" style="margin-left:auto">${ST.showLearned ? 'Hide' : 'What it learned from your fixes'} (${fixes.length})</button>` : ''}</div>
      <div class="small muted" style="margin-top:4px">${all.n ? 'Counted when you approve a suggestion. If you pick a different category, or change it later on Transactions, that counts as a fix and the AI uses it next time.' : 'Approve some suggestions and the score shows up here. Any category you change is remembered as a fix.'}</div>
      ${offers.map(o => `<div style="display:flex;gap:10px;align-items:center;background:var(--accent-soft);border-radius:6px;padding:8px 10px;margin-top:8px"><div style="flex:1">You changed <b>${esc(o.e.py)}</b> to <b>${esc(acc(o.e.to).name)}</b> ${o.n} times. Make a Bank Rule so it's always sorted that way?</div><button class="btn sm primary" data-act="aiMakeRule" data-k="${esc(o.k)}">Make rule</button><button class="btn sm" data-act="aiNoRule" data-k="${esc(o.k)}">No thanks</button></div>`).join('')}
      ${ST.showLearned && fixes.length ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Payee</th><th>AI had picked</th><th>You chose</th><th></th></tr></thead><tbody>${fixes.map(f => `<tr><td>${esc(f.e.py)}</td><td class="muted">${esc((acc(f.e.ai) || {}).name || 'nothing')}</td><td>${esc(f.category)}</td><td style="text-align:right"><button class="btn sm" data-act="aiForget" data-k="${esc(f.k)}" title="Stop using this fix">Forget</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>`;
  }
  views.ai = () => {
    if (!ST.statusAt || Date.now() - ST.statusAt > 3000) { ST.statusAt = Date.now(); setTimeout(refreshStatus, 0); }
    const st = ST.status, waiting = candidates().length;
    const statusLine = !st ? '<span class="spin"></span>Checking the AI…'
      : !st.ok ? '<span class="ai-dot off"></span><b>The AI is not available.</b> ' + esc(st.reason) + (SV.me.admin ? ' On the server PC, start Ollama (it runs in the system tray).' : ' Ask the owner to check the server PC.')
      : !st.hasText ? '<span class="ai-dot off"></span><b>The AI model is not downloaded yet.</b> ' + (SV.me.admin ? 'On the server PC, run "Set up the AI.cmd" in the Ledger Desk Server folder.' : 'Ask the owner to finish the AI setup.')
      : st.provider === 'gemini' ? '<span class="ai-dot on"></span>Ready · <b>Google Gemini</b> · only what each AI request needs is sent to Google (paid account, not used to train Google\'s AI)'
      : '<span class="ai-dot on"></span>Ready · runs on the server\'s graphics card · your books never leave that PC' + (st.busy ? ' · busy with ' + st.busy + ' request' + (st.busy === 1 ? '' : 's') : '');
    const g = st && st.gemini, prov = g && g.available ? `<div class="seg" style="display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-right:8px" title="Which AI does the work for you">
      <button class="btn sm${g.on ? '' : ' primary'}" style="border:0;border-radius:0" data-act="aiProv" data-p="local">This PC's AI</button><button class="btn sm${g.on ? ' primary' : ''}" style="border:0;border-radius:0" data-act="aiProv" data-p="gemini">Google Gemini</button></div>` : '';
    const head = `<div class="page-head"><div><h1>AI Assistant</h1><p class="sub">${statusLine}</p></div>
      <div class="toolbar" style="margin:0">${prov}<button class="btn" data-act="aiNotes">Notes for the AI${S().aiNotes ? ' ✓' : ''}</button></div></div>
      <div class="tabs">${TABS.map(([k, n]) => `<button data-act="aiTab" data-tab="${k}" class="${ST.tab === k ? 'on' : ''}">${n}${(k === 'sort' || k === 'chat') && waiting ? ' (' + waiting + ')' : ''}</button>`).join('')}</div>`;
    return head + (TAB_VIEW[ST.tab] || (ST.tabViews && ST.tabViews[ST.tab]) || TAB_VIEW.sort)();
  };
  const monthPicker = () => `<label class="field" style="flex-direction:row;align-items:center;gap:8px">Month <select data-ai-month>${monthOptions(ST.month)}</select></label>`;
  const TAB_VIEW = {
    sort: () => {
      if (scanFixes()) setTimeout(L.save, 0);
      const st = ST.status, waiting = candidates().length;
      const open = ST.sugg.filter(x => x.state === 'new' && S().txns.some(t => t.id === x.id && L.isUncat(t)));
      const done = ST.sugg.filter(x => x.state === 'done').length, nHigh = open.filter(x => x.conf === 'high' && x.catId).length;
      return `<div class="panel"><div class="page-head" style="margin:0 0 8px"><div><h2 style="margin:0">Sort what's uncategorized</h2>
      <p class="sub small">${waiting} transaction${waiting === 1 ? '' : 's'} waiting. The AI learns from how you categorized before, your Bank Rules and your notes. Nothing changes until you approve.</p></div>
      <div class="toolbar" style="margin:0">${open.length && nHigh ? `<button class="btn" data-act="aiApproveHigh">Approve all ${nHigh} high-confidence</button>` : ''}${open.length ? '<button class="link" data-act="aiClear">Clear</button>' : ''}
      <button class="btn primary" data-act="aiSuggest"${ST.busy || !waiting || !(st && st.ok && st.hasText) ? ' disabled' : ''}>${ST.busy ? '<span class="spin"></span>' + esc(ST.progress) : open.length ? 'Suggest more' : 'Get suggestions'}</button></div></div>
      ${learnPanel()}
      ${done ? `<p class="small pos" style="margin:0 0 8px">${done} approved so far. Next time, Ledger Desk remembers these payees on its own.</p>` : ''}
      ${open.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Payee</th><th class="num">Amount</th><th>Suggested category</th><th>Rule?</th><th></th></tr></thead><tbody>
      ${open.map(x => { const t = S().txns.find(y => y.id === x.id); return `<tr data-id="${t.id}">
        <td class="num small">${usDate(t.date)}</td>
        <td style="min-width:170px"><div class="payee">${esc(t.payee)}</div><div class="memo">${esc((acc(t.accountId) || {}).name || '')}${t.memo ? ' · ' + esc(t.memo) : ''}</div></td>
        <td class="num ${t.amount < 0 ? '' : 'pos'}">${money(t.amount)}</td>
        <td><select class="cat" aria-label="Category"><option value="">Choose…</option>${L.catOptions(x.catId, t.accountId, L.isBankDeposit(t))}</select> <span class="conf ${x.conf}">${x.conf}</span><div class="ai-reason">${esc(x.reason)}</div></td>
        <td><input type="checkbox" class="check" data-ai-rule title="Also make a Bank Rule so future imports do this automatically"${x.rule ? ' checked' : ''}></td>
        <td style="white-space:nowrap;text-align:right"><button class="btn sm primary" data-act="aiApprove">Approve</button> <button class="btn sm" data-act="aiSkip">Skip</button></td></tr>`; }).join('')}
      </tbody></table></div>` : ''}</div>`;
    },
    ask: () => `<div class="panel"><div class="page-head" style="margin:0"><div><h2 style="margin:0">Ask about ${esc(S().company)}</h2>
      <p class="sub small">Answers come from this company's books. For exact figures you'll file or send, check them in Reports.</p></div>${ST.chat.length ? '<button class="link" data-act="aiChatClear">Clear</button>' : ''}</div>
      ${ST.chat.length || ST.asking ? `<div class="chat" id="chat">${ST.chat.map(m => `<div class="msg ${m.role === 'user' ? 'q' : m.err ? 'a err' : 'a'}">${esc(m.text)}</div>`).join('')}${ST.asking ? '<div class="msg a"><span class="spin"></span>Thinking…</div>' : ''}</div>` : ''}
      <div class="ask-row" style="margin-top:12px"><textarea id="askQ" placeholder="e.g. How much did we spend on utilities this year?" maxlength="1000" aria-label="Your question"></textarea><button class="btn primary" data-act="aiAsk"${ST.asking ? ' disabled' : ''}>Ask</button></div>
      ${ST.chat.length ? '' : `<div class="examples">${['What were our biggest expenses last month?', 'How much did we pay Spectrum this year?', 'How much do we owe on all credit cards?', 'Compare this year\'s expenses to last year.'].map(q => `<button class="btn" data-act="aiEx">${esc(q)}</button>`).join('')}</div>`}</div>`,
    month: () => {
      const r = monthEndCheck(ST.month), left = r.items.filter(x => !x.ok && !x.info).length;
      return `<div class="panel"><div class="page-head" style="margin:0 0 8px"><div><h2 style="margin:0">Month-end check: ${esc(monthName(ST.month))}</h2>
        <p class="sub small">${left ? left + ' thing' + (left === 1 ? '' : 's') + ' to fix before this month is done.' : 'Everything checks out for this month.'} Exact checks on your books; no guessing.</p></div>${monthPicker()}</div>
        <div style="display:grid;gap:8px">${r.items.map(x => `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;${x.ok ? '' : x.info ? 'background:var(--panel-2)' : 'background:var(--warn-soft);border-color:transparent'}">
          <div style="font-size:18px;line-height:1">${x.ok ? '✅' : x.info ? 'ℹ️' : '⚠️'}</div>
          <div style="flex:1"><b>${esc(x.title)}</b>${x.detail ? '<div class="small muted" style="margin-top:2px">' + esc(x.detail) + '</div>' : ''}</div>
          <div class="toolbar" style="margin:0">${x.fix ? `<button class="btn sm" data-act="${x.fix[1]}">${x.fix[0]}</button>` : ''}${x.act ? `<button class="btn sm" data-act="${x.act[1]}">${x.act[0]}</button>` : ''}</div></div>`).join('')}</div>
        <h3 style="font-size:13px;margin:18px 0 6px">Balances on ${usDate(r.to)}: compare with your bank and card statements</h3>
        <div class="table-wrap"><table><thead><tr><th>Account</th><th class="num">Ledger Desk balance</th></tr></thead><tbody>
        ${r.bal.map(x => `<tr><td>${esc(x.a.name)}</td><td class="num">${money(x.v)}${x.a.type === 'liability' ? ' owed' : ''}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No bank or card balances yet.</td></tr>'}
        </tbody></table></div><p class="small muted" style="margin:8px 0 0">If a balance doesn't match the statement's ending balance, something is missing or duplicated in that account for this month.</p></div>`;
    },
    summary: () => {
      const f = monthFigures(ST.month), sm = ST.sum && ST.sum.k === ST.month ? ST.sum : null;
      const chg = (a, b) => { const d = a - b; return Math.abs(d) < 0.005 ? '<span class="muted">same</span>' : `<span class="${d > 0 ? 'neg' : 'pos'}">${d > 0 ? '▲ ' : '▼ '}${money(Math.abs(d))}</span>`; };
      return `<div class="panel"><div class="page-head" style="margin:0 0 8px"><div><h2 style="margin:0">${esc(monthName(ST.month))} in plain English</h2>
        <p class="sub small">The numbers are calculated exactly from your books; the AI only puts them into words.</p></div>
        <div class="toolbar" style="margin:0">${monthPicker()}<button class="btn primary" data-act="aiExplain"${ST.sumBusy || !aiReady() ? ' disabled' : ''}>${ST.sumBusy ? '<span class="spin"></span>Writing…' : sm ? 'Write again' : 'Write the summary'}</button></div></div>
        ${sm ? `<div style="background:var(--accent-soft);border-radius:8px;padding:12px 14px;margin-bottom:14px"><b>${esc(sm.headline)}</b><ul style="margin:8px 0 0;padding-left:18px">${sm.points.map(p => '<li>' + esc(p) + '</li>').join('')}</ul>${sm.watch.length ? '<div class="small" style="margin-top:8px"><b>Worth checking:</b> ' + sm.watch.map(esc).join(' · ') + '</div>' : ''}</div>` : ''}
        <div class="grid kpis"><div class="panel kpi"><div class="lbl">Income recorded</div><div class="val">${money(f.inc)}</div><div class="small">${chg(f.inc, f.pinc).replace('neg', 'x').replace('pos', 'neg').replace('x', 'pos')} vs last month</div></div>
          <div class="panel kpi"><div class="lbl">Expenses</div><div class="val">${money(f.exp)}</div><div class="small">${chg(f.exp, f.pexp)} vs last month</div></div>
          <div class="panel kpi"><div class="lbl">Net</div><div class="val ${f.inc - f.exp < 0 ? 'neg' : 'pos'}">${money(f.inc - f.exp)}</div>${f.inc === 0 ? '<div class="small muted">No income recorded yet</div>' : ''}</div></div>
        <div class="grid two"><div><h3 style="font-size:13px;margin:4px 0 6px">By category</h3><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">${esc(monthName(ST.month).split(' ')[0])}</th><th class="num">Last month</th><th class="num">Change</th></tr></thead><tbody>
          ${f.rows.map(x => `<tr><td>${esc(x.a.name)}${x.a.type === 'income' ? ' <span class="chip">income</span>' : ''}</td><td class="num">${money(x.cur)}</td><td class="num">${money(x.prev)}</td><td class="num">${x.a.type === 'income' ? '' : chg(x.cur, x.prev)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing recorded this month.</td></tr>'}
          </tbody></table></div></div>
          <div><h3 style="font-size:13px;margin:4px 0 6px">Top payees</h3><div class="table-wrap"><table><thead><tr><th>Payee</th><th class="num">Total</th></tr></thead><tbody>
          ${f.payees.map(p => `<tr><td>${esc(p.name)}<div class="memo">${esc(p.cat || '')} · ${p.n}×</div></td><td class="num">${money(p.v)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No spending this month.</td></tr>'}
          </tbody></table></div></div></div></div>`;
    },
    problems: () => {
      if (!ST.probs) ST.probs = findProblems();
      const exactIds = new Set(ST.probs.map(p => p.t.id));
      const all = ST.probs.concat((ST.aiFlags || []).filter(f => !f.t.ignored && !exactIds.has(f.t.id) && !dism().includes(f.key)));
      return `<div class="panel"><div class="page-head" style="margin:0 0 8px"><div><h2 style="margin:0">Spot problems (last 90 days)</h2>
        <p class="sub small">Exact checks for double charges, price jumps and new repeating charges, plus an optional AI review for charges that don't fit the business. Dismiss anything that's fine; it won't be flagged again.</p></div>
        <div class="toolbar" style="margin:0"><button class="link" data-act="prRefresh">Check again</button><button class="btn primary" data-act="aiReview"${ST.flagBusy || !aiReady() ? ' disabled' : ''}>${ST.flagBusy ? '<span class="spin"></span>AI is reviewing…' : ST.aiFlags ? 'AI review again' : 'Ask AI to review spending'}</button></div></div>
        ${ST.aiFlags && !ST.aiFlags.length ? '<p class="small pos" style="margin:0 0 8px">The AI didn\'t find anything that looks out of place.</p>' : ''}
        ${all.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>Date</th><th>Payee</th><th class="num">Amount</th><th>Why</th><th></th></tr></thead><tbody>
        ${all.map(p => `<tr data-key="${esc(p.key)}"><td><span class="conf ${p.sev === 'high' ? 'low' : 'medium'}">${esc(p.kind)}</span></td><td class="num small">${usDate(p.t.date)}</td>
          <td style="min-width:160px"><div class="payee">${esc(p.t.payee)}</div><div class="memo">${esc((acc(p.t.accountId) || {}).name || '')} · ${esc((acc(p.t.categoryId) || {}).name || '')}</div></td>
          <td class="num">${money(p.t.amount)}</td><td class="small" style="max-width:320px">${esc(p.reason)}</td>
          <td style="white-space:nowrap;text-align:right">${p.kind === 'Possible double charge' ? '<button class="btn sm" data-act="prIgnore" title="Keep it on file but leave it out of balances and reports">Ignore duplicate</button> ' : ''}<button class="btn sm" data-act="prOpen">Open</button> <button class="btn sm" data-act="prDismiss">It's fine</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="small pos" style="margin:0">✅ No double charges, price jumps or new repeating charges found.</p>'}</div>`;
    },
    receipts: () => {
      const d = ST.doc, matches = docMatches(d), ok = visionReady();
      const kindName = d ? ({ receipt: 'Receipt', bill: 'Bill', invoice: 'Invoice', check: 'Check', other: 'Document' }[d.kind] || 'Document') : '';
      return `<div class="panel"><div class="page-head" style="margin:0 0 8px"><div><h2 style="margin:0">Read a receipt, bill, invoice or check</h2>
        <p class="sub small">Pick a phone photo or a screenshot. The AI reads the vendor, date and total, suggests a category, and finds the matching bank or card charge. For a bank statement PDF with check pictures, use the section below.</p></div>
        <div class="toolbar" style="margin:0">${d || ST.docImg ? '<button class="link" data-act="docClear">Clear</button>' : ''}<label class="btn${ST.docBusy || !ok ? '" style="opacity:.55;pointer-events:none' : ' primary'}" for="docIn">${ST.docBusy ? '<span class="spin"></span>Reading…' : 'Choose a picture…'}</label><input type="file" id="docIn" accept="image/*" hidden></div></div>
        ${ST.status && ST.status.ok && !ST.status.hasVision ? '<p class="small muted">This needs the picture model (' + esc(ST.status.visionModel) + '). ' + (SV.me.admin ? 'Run "Set up the AI.cmd" on the server PC.' : 'Ask the owner to finish the AI setup.') + '</p>' : ''}
        ${ST.docImg ? `<div class="check-grid"><img src="${ST.docImg}" alt="Document picture">
          <div>${d ? `<dl class="facts"><dt>Type</dt><dd>${esc(kindName)}</dd><dt>${d.kind === 'check' ? 'Pay to' : 'Vendor'}</dt><dd>${esc(d.vendor || '?')}</dd><dt>Date</dt><dd>${d.date ? usDate(d.date) : '?'}</dd><dt>Total</dt><dd>${d.total ? money(d.total) : '?'}</dd>${d.tax ? `<dt>Tax</dt><dd>${money(d.tax)}</dd>` : ''}${d.number ? `<dt>${d.kind === 'check' ? 'Check #' : 'Number'}</dt><dd>${esc(d.number)}</dd>` : ''}${d.memo ? `<dt>Note</dt><dd>${esc(d.memo)}</dd>` : ''}${d.category ? `<dt>Suggested</dt><dd>${esc(d.category)}</dd>` : ''}</dl>
            ${d.items && d.items.length ? '<div class="small muted" style="margin-top:8px">' + d.items.map(i => esc(i.description) + ' ' + money(i.amount)).join(' · ') + '</div>' : ''}
            <p class="small muted">Check these against the picture. The AI can misread handwriting and faded receipts.</p>` : ST.docBusy ? '<p><span class="spin"></span>Reading…</p>' : ''}</div></div>` : ''}
        ${d ? (matches.length ? `<h3 style="font-size:13px;margin:16px 0 6px">Matching bank and card charges (best match first)</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Charge</th><th class="num">Amount</th><th>Payee</th><th>Category</th><th></th></tr></thead><tbody>
          ${matches.map(t => { const sug = S().accounts.find(a => a.name === d.category); return `<tr data-id="${t.id}"><td class="num small">${usDate(t.date)}</td><td><div class="payee">${esc(t.payee)}</div><div class="memo">${esc((acc(t.accountId) || {}).name || '')}</div></td><td class="num">${money(t.amount)}</td>
            <td><input type="text" data-f="payee" value="${esc(d.vendor)}" style="width:170px"></td><td><select class="cat" aria-label="Category">${L.catOptions(L.isUncat(t) && sug ? sug.id : t.categoryId, t.accountId, false)}</select></td><td><button class="btn sm primary" data-act="docApply">Apply</button></td></tr>`; }).join('')}
          </tbody></table></div>` : '<p class="small muted" style="margin-top:12px">No bank or card charge matches this yet. Import the statement that has it, then come back.</p>') : ''}</div>` + (ST.checksPanel ? ST.checksPanel() : '');
    }
  };
  afterRender.ai = () => {
    const q = $('#askQ'); if (q) q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); acts.aiAsk(); } });
    const f = $('#docIn'); if (f) f.addEventListener('change', () => { if (f.files[0]) readDoc(f.files[0]); });
    const m = document.querySelector('[data-ai-month]'); if (m) m.addEventListener('change', e => { e.stopPropagation(); ST.month = m.value; L.render(); });
    document.querySelectorAll('[data-ai-rule]').forEach(cb => cb.addEventListener('change', () => { const x = ST.sugg.find(y => y.id === cb.closest('tr').dataset.id); if (x) x.rule = cb.checked; }));
    document.querySelectorAll('#main tr[data-id] select.cat').forEach(sel => sel.addEventListener('change', e => {
      e.stopPropagation();
      const x = ST.sugg.find(y => y.id === sel.closest('tr').dataset.id);
      if (x && sel.closest('tr').querySelector('[data-ai-rule]')) { x.catId = sel.value; x.conf = 'high'; x.reason = 'You chose this.'; }
    }));
    const c = $('#chat'); if (c) c.scrollTop = c.scrollHeight;
  };
})();
