/* Ledger Desk — small-business bookkeeping that runs on your PC. */
(function () {
  'use strict';
  const C = window.LedgerCore;
  const M = window.LedgerMerchants;
  const KEY = 'ledgerdesk-books-v1';
  const $ = s => document.querySelector(s);
  const main = $('#main');

  // ---------------- helpers ----------------
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = n => fmtUSD.format(Math.round((n || 0) * 100) / 100 || 0).replace('-', '−');
  const r2 = n => Math.round(n * 100) / 100;
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => iso(new Date());
  const usDate = s => s ? s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4) : '';
  const monthKey = s => s.slice(0, 7);
  const monthLabel = k => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });

  function ranges() {
    const d = new Date(), y = d.getFullYear(), m = d.getMonth();
    return {
      thisMonth: ['This month', iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))],
      lastMonth: ['Last month', iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
      thisQuarter: ['This quarter', iso(new Date(y, Math.floor(m / 3) * 3, 1)), iso(new Date(y, Math.floor(m / 3) * 3 + 3, 0))],
      ytd: ['This year to date', y + '-01-01', iso(d)],
      thisYear: ['This year', y + '-01-01', y + '-12-31'],
      lastYear: ['Last year', (y - 1) + '-01-01', (y - 1) + '-12-31'],
      last12: ['Last 12 months', iso(new Date(y, m - 11, 1)), iso(new Date(y, m + 1, 0))],
      all: ['All dates', '', '']
    };
  }

  // ---------------- data ----------------
  const DEFAULT_ACCOUNTS = [
    ['Business Checking', 'asset', 'bank'],
    ['Opening Balance Equity', 'equity', 'other', 'obe'],
    ['Bank Deposits (not income)', 'liability', 'other', 'deposits'],
    ["Owner's Equity", 'equity', 'other'],
    ["Owner's Draw", 'equity', 'other'],
    ['Sales', 'income', 'other'],
    ['Interest Income', 'income', 'other'],
    ['Refunds & Credits', 'income', 'other'],
    ['Other Income', 'income', 'other'],
    ['Uncategorized Money In', 'equity', 'other', 'uncatIn'],
    ['Advertising & Marketing', 'expense', 'other'],
    ['Auto & Fuel', 'expense', 'other'],
    ['Bank & Card Fees', 'expense', 'other'],
    ['Contractors', 'expense', 'other'],
    ['Dining & Meals', 'expense', 'other'],
    ['Groceries', 'expense', 'other'],
    ['Insurance', 'expense', 'other'],
    ['Interest Paid', 'expense', 'other'],
    ['Office Supplies', 'expense', 'other'],
    ['Phone & Internet', 'expense', 'other'],
    ['Rent & Lease', 'expense', 'other'],
    ['Repairs & Maintenance', 'expense', 'other'],
    ['Shipping & Postage', 'expense', 'other'],
    ['Software & Subscriptions', 'expense', 'other'],
    ['Shopping', 'expense', 'other'],
    ['Travel', 'expense', 'other'],
    ['Utilities', 'expense', 'other'],
    ['Uncategorized Expense', 'expense', 'other', 'uncatOut']
  ];
  function freshBooks() {
    return {
      ver: 1, company: 'My Company', theme: 'system',
      accounts: DEFAULT_ACCOUNTS.map(([name, type, detail, sys]) => ({ id: uid(), name, type, detail, sys: sys || '' })),
      txns: [], rules: [], deleted: [], migr1: true, migr2: true, migr3: true
    };
  }
  // Desktop app: one file per company in Documents\Ledger Desk\Companies. Browser: localStorage.
  const FILE = window.ledgerFile || null;
  const SERVER = !!window.ledgerServer;
  const WHERE = SERVER ? 'on the Ledger Desk server' : 'on this PC';
  const CO = FILE && FILE.companies ? FILE.companies : null;
  let S = null, CUR = null, BASE = null; // BASE = the file text this page last read or wrote
  if (FILE) {
    try { BASE = FILE.load(); S = JSON.parse(BASE || 'null'); } catch (e) { S = null; }
    if (CO) CUR = CO.list().current;
  } else { try { S = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { S = null; } }
  if (!S || !Array.isArray(S.accounts)) { S = freshBooks(); if (FILE && FILE.defaultName) S.company = FILE.defaultName(); else if (CUR) S.company = CUR.replace(/\.json$/i, ''); }
  let saveFailed = false;
  function save() {
    try {
      const text = JSON.stringify(S, null, 1);
      if (FILE) {
        const r = FILE.save(CUR, text, BASE);
        if (r && r.conflict) { BASE = null; adoptExternal(r.text); setTimeout(() => toast('The books were updated outside the app, so your last change was not saved. Please make it again. (A copy is in ' + (SERVER ? 'the Conflicts folder on the server' : 'Documents\\Ledger Desk\\Conflicts') + '.)'), 50); return; }
        if (r === 'error') throw new Error('save failed');
        BASE = text;
      } else localStorage.setItem(KEY, text);
      saveFailed = false;
    }
    catch (e) { if (!saveFailed) toast('Could not save ' + WHERE + '. Use Company & Backup → Save backup file.'); saveFailed = true; }
    updateBadge();
  }
  const acc = id => S.accounts.find(a => a.id === id);
  const sysAcc = k => S.accounts.find(a => a.sys === k);
  const isUncat = t => { const a = acc(t.categoryId); return !a || a.sys === 'uncatIn' || a.sys === 'uncatOut'; };
  const uncatFor = amt => (amt < 0 ? sysAcc('uncatOut') : sysAcc('uncatIn')).id;
  const registers = withClearing => S.accounts.filter(a => (a.type === 'asset' || a.type === 'liability') && !a.archived && (withClearing || a.sys !== 'deposits'));
  const live = () => S.txns.filter(t => !t.ignored);
  const depAcc = () => sysAcc('deposits');
  // A deposit into a bank/asset account. These never count as income; income is recorded separately.
  const isBankDeposit = t => { const a = acc(t.accountId); return !!a && a.type === 'asset' && t.amount > 0; };
  // Income is only what the owner records with "Record income". Money coming into a bank or card account (deposits, refunds,
  // payments) is never income. QuickBooks history keeps whatever QuickBooks had.
  const noIncome = t => { const a = acc(t.accountId); return !!a && t.amount > 0 && t.source !== 'income' && t.source !== 'qb' && t.source !== 'opening' && (a.type === 'asset' || a.type === 'liability'); };
  const allowedCat = (t, catId) => { const c = acc(catId); return !!c && catId !== t.accountId && !((isBankDeposit(t) || noIncome(t)) && c.type === 'income'); };
  const defaultCat = t => isBankDeposit(t) ? depAcc().id : uncatFor(t.amount);
  // Deposits restored from QuickBooks may already be income (QuickBooks recorded them that way)
  const qbIncomeDeposit = t => t.source === 'qb' && isBankDeposit(t) && (acc(t.categoryId) || {}).type === 'income';
  const tkey = t => t.accountId + '|' + (t.fitid ? 'f:' + t.fitid : 'k:' + t.date + '|' + t.amount + '|' + (t.origPayee || t.payee));
  function migrate() {
    if (!sysAcc('deposits')) S.accounts.push({ id: uid(), name: 'Bank Deposits (not income)', type: 'liability', detail: 'other', sys: 'deposits' });
    S.deleted = S.deleted || []; S.rules = S.rules || [];
    // Money in that hasn't been categorized is never income
    const ui = sysAcc('uncatIn'); if (ui && ui.type === 'income') { ui.type = 'equity'; if (ui.name === 'Uncategorized Income') ui.name = 'Uncategorized Money In'; }
    if (!S.migr1) {
      S.txns.forEach(t => { const c = acc(t.categoryId); if (isBankDeposit(t) && c && c.type === 'income' && t.source !== 'income') t.categoryId = depAcc().id; });
      S.migr1 = true;
    }
    if (!S.migr2) { S.migr2 = true; S.pendingSmart = true; }
    // Deposits, refunds and card payments that ended up in an income category go back out (income is recorded by hand)
    if (!S.migr3) {
      S.migr3 = true; let n = 0;
      S.txns.forEach(t => { const c = acc(t.categoryId); if (c && c.type === 'income' && noIncome(t) && !t.ignored) { t.categoryId = defaultCat(t); t.why = 'Moved out of ' + c.name + ': money coming in is not income'; n++; } });
      if (n) setTimeout(() => toast(n + ' deposit' + (n === 1 ? ' was' : 's were') + ' under an income category and ' + (n === 1 ? 'was' : 'were') + ' moved out. Income only counts what you record with "Record income".'), 1500);
    }
  }
  const sortAccs = list => list.slice().sort((a, b) => a.name.localeCompare(b.name));
  const TYPE_LABEL = { asset: 'Bank & assets', liability: 'Credit cards & loans', equity: 'Equity', income: 'Income', expense: 'Expenses' };
  const DETAIL_LABEL = { bank: 'Bank', credit: 'Credit card', loan: 'Loan', other: '' };

  function applyTheme() {
    const r = document.documentElement;
    if (S.theme === 'light' || S.theme === 'dark') r.setAttribute('data-theme', S.theme); else r.removeAttribute('data-theme');
    $('#brandCo').textContent = S.company || 'My Company';
    document.title = 'Ledger Desk · ' + (S.company || 'My Company');
  }

  // ---------------- companies (desktop app) ----------------
  // Each company has its own books file. Switching saves this one, then the window reloads with the other.
  function otherCompanyFor(ofxId) {
    if (!CO || !ofxId) return null;
    const hit = CO.list().list.find(c => c.file !== CUR && c.ofxIds.indexOf(String(ofxId)) >= 0);
    return hit ? hit.name : null;
  }
  function fillCompanies() {
    if (!CO) return;
    const { list } = CO.list();
    const opts = list.map(c => `<option value="${esc(c.file)}"${c.file === CUR ? ' selected' : ''}>${esc(c.file === CUR && (!c.role || c.role === 'owner') ? S.company : c.name)}</option>`);
    if (!list.some(c => c.file === CUR)) opts.unshift(`<option value="${esc(CUR)}" selected>${esc(S.company)}</option>`);
    $('#coSel').innerHTML = opts.join('') + '<option value="__new">+ Add a company…</option>';
    $('#coPick').hidden = false;
    $('#brandCo').hidden = true;
  }
  function addCompanyModal() {
    modal(`<h2>Add a company</h2><p class="muted small" style="margin-top:0">Each company gets its own separate books: accounts, transactions, rules and reports.</p>
      <label class="field">Company name<input type="text" id="mCoName" maxlength="80"></label>
      <p class="small" style="margin:10px 0 0"><button class="link" id="mQB">Restore a company from QuickBooks instead</button></p>
      <div class="actions"><button class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Add company</button></div>`, card => {
      card.querySelector('#mQB').onclick = () => { closeModal(); fillCompanies(); go('qb'); };
      card.querySelector('#mCancel').onclick = () => { closeModal(); fillCompanies(); };
      const go2 = () => {
        const name = card.querySelector('#mCoName').value.trim();
        if (!name) { toast('Type the company name'); return; }
        if (CO.list().list.some(c => c.name.toLowerCase() === name.toLowerCase())) { toast(name + ' already exists'); return; }
        const fb = freshBooks(); fb.company = name; fb.theme = S.theme;
        const file = CO.create(name, JSON.stringify(fb, null, 1));
        if (!file) { toast('Could not create the company file'); return; }
        save(); closeModal(); CO.switchTo(file);
      };
      card.querySelector('#mSave').onclick = go2;
      card.querySelector('#mCoName').addEventListener('keydown', e => { if (e.key === 'Enter') go2(); });
    });
  }
  function onCompanyPick(e) {
    const v = e.target.value;
    if (v === '__new') { addCompanyModal(); return; }
    if (v === CUR) return;
    save(); CO.switchTo(v);
  }

  // ---------------- toast & modal ----------------
  let toastTimer;
  function toast(msg, actionLabel, fn) {
    const el = $('#toast');
    el.innerHTML = esc(msg) + (actionLabel ? ' <button class="link" id="toastAct" style="color:inherit;margin-left:10px;font-weight:600">' + esc(actionLabel) + '</button>' : '');
    el.hidden = false;
    if (actionLabel) $('#toastAct').addEventListener('click', () => { el.hidden = true; fn(); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 9000 : 3500);
  }
  function modal(html, onReady) {
    $('#modalCard').innerHTML = html;
    $('#modal').hidden = false;
    const first = $('#modalCard').querySelector('input,select,button');
    if (first) first.focus();
    if (onReady) onReady($('#modalCard'));
  }
  function closeModal() { $('#modal').hidden = true; $('#modalCard').innerHTML = ''; }
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  function confirmBox(title, text, okLabel, danger) {
    return new Promise(res => {
      modal('<h2>' + esc(title) + '</h2><p class="muted">' + esc(text) + '</p><div class="actions"><button class="btn" id="cNo">Cancel</button><button class="btn primary" id="cYes"' + (danger ? ' style="background:var(--neg);border-color:var(--neg)"' : '') + '>' + esc(okLabel) + '</button></div>', card => {
        card.querySelector('#cNo').onclick = () => { closeModal(); res(false); };
        card.querySelector('#cYes').onclick = () => { closeModal(); res(true); };
      });
    });
  }

  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const csvCell = v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const toCSV = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');

  // ---------------- category <select> ----------------
  function catOptions(selected, excludeId, deposit, hideIncome) {
    const order = ['expense', 'income', 'liability', 'asset', 'equity'];
    return order.map(type => {
      if ((deposit || hideIncome) && type === 'income') return '';
      const list = sortAccs(S.accounts.filter(a => a.type === type && a.id !== excludeId && !a.archived && (a.sys !== 'deposits' || deposit || a.id === selected)));
      if (!list.length) return '';
      return '<optgroup label="' + TYPE_LABEL[type] + '">' + list.map(a =>
        '<option value="' + a.id + '"' + (a.id === selected ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</optgroup>';
    }).join('');
  }
  function registerOptions(selected, withAll) {
    return (withAll ? '<option value="all">All accounts</option>' : '') +
      sortAccs(registers(withAll)).map(a => '<option value="' + a.id + '"' + (a.id === selected ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('');
  }

  // ---------------- categorization (rules → memorized payees → uncategorized) ----------------
  function memorized() {
    const map = {};
    S.txns.forEach(t => { if (!isUncat(t) && !t.ignored) map[C.normPayee(t.payee)] = t.categoryId; });
    return map;
  }
  // Order: your rules → payees you've categorized before → built-in merchant directory → bank's business type / codes
  const catByName = n => S.accounts.find(a => !a.archived && a.name.toLowerCase() === String(n).toLowerCase() && (a.type === 'expense' || a.type === 'income'));
  function autoCategorize(t, memo) {
    delete t.why;
    const r = C.matchRule(S.rules, t);
    if (r && allowedCat(t, r.categoryId)) { if (r.rename) t.payee = r.rename; t.categoryId = r.categoryId; t.why = 'Your rule: “' + r.match + '”'; return 'rule'; }
    const m = memo[C.normPayee(t.payee)];
    if (m && allowedCat(t, m)) { t.categoryId = m; t.why = 'Same as before for this payee'; return 'memo'; }
    const moneyIn = t.amount > 0;
    if (S.smartCats !== false && !isBankDeposit(t) && !(moneyIn && M.looksLikeTransfer(t.payee, t.memo))) {
      const hit = M.lookup(t.payee, t.memo, t.sic);
      const c = hit && catByName(hit.category);
      if (c && allowedCat(t, c.id)) { t.categoryId = c.id; t.why = hit.why; return 'smart'; }
    }
    t.categoryId = defaultCat(t);
    return '';
  }
  function smartCategorizeExisting() {
    const memo = memorized(); let n = 0;
    S.txns.forEach(t => {
      if (t.ignored || t.source === 'income' || t.source === 'opening' || !isUncat(t)) return;
      if (autoCategorize(t, memo)) n++;
    });
    return n;
  }

  // ---------------- navigation ----------------
  let view = 'dashboard';
  const views = {};
  function go(v, opts) {
    view = v;
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    if (opts) Object.assign(viewState[v] || {}, opts);
    render();
    main.scrollTop = 0;
  }
  function render() { applyTheme(); main.innerHTML = views[view](); if (afterRender[view]) afterRender[view](); }
  const afterRender = {};
  $('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.view); });
  function updateBadge() {
    const n = live().filter(isUncat).length;
    const b = $('#uncatBadge'); b.hidden = !n; b.textContent = n;
  }

  const viewState = {
    register: { acct: 'all', q: '', range: 'all', from: '', to: '', uncat: false, limit: 300, sel: new Set() },
    reports: { tab: 'pl', range: 'ytd', from: '', to: '', detailAcct: '' },
    import: { pending: null }
  };

  function sampleBanner() {
    if (!S.accounts.some(a => a.sample)) return '';
    return '<div class="notice">You are looking at <b>sample data</b>. <button class="link" data-act="clearSample">Remove sample data</button> before importing your own statements.</div>';
  }

  // ======================= DASHBOARD =======================
  views.dashboard = () => {
    if (!S.txns.length) return onboarding();
    const R = ranges(), [, mFrom, mTo] = R.thisMonth;
    const all = C.debits(live()), month = C.debits(live(), { from: mFrom, to: mTo });
    let cards = 0, bank = 0, inc = 0, exp = 0;
    S.accounts.forEach(a => {
      if (a.type === 'liability' && a.sys !== 'deposits') cards += C.natural(a, all[a.id]);
      if (a.type === 'asset') bank += C.natural(a, all[a.id]);
      if (a.type === 'income') inc += C.natural(a, month[a.id]);
      if (a.type === 'expense') exp += C.natural(a, month[a.id]);
    });
    const uncat = live().filter(isUncat).length;
    // top spending this month
    const spend = S.accounts.filter(a => a.type === 'expense').map(a => ({ a, v: C.natural(a, month[a.id]) })).filter(x => x.v > 0).sort((x, y) => y.v - x.v).slice(0, 6);
    const maxS = spend.length ? spend[0].v : 1;
    const recent = live().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    return sampleBanner() + `
    <div class="page-head"><div><h1>Dashboard</h1><p class="sub">${esc(S.company)} · ${new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })}</p></div>
      <div class="toolbar" style="margin:0"><button class="btn" data-act="goto" data-v="import">Import .QBO</button><button class="btn" data-act="newIncome">Record income</button><button class="btn primary" data-act="newTxn">Add transaction</button></div></div>
    <div class="grid kpis">
      <div class="panel kpi"><div class="lbl">Owed on cards & loans</div><div class="val">${money(cards)}</div></div>
      <div class="panel kpi"><div class="lbl">Bank & assets</div><div class="val">${money(bank)}</div></div>
      <div class="panel kpi" data-act="openClearing" style="cursor:pointer"><div class="lbl">Deposits not recorded as income</div><div class="val">${money(C.natural(depAcc(), all[depAcc().id]))}</div></div>
      <div class="panel kpi"><div class="lbl">Income this month</div><div class="val pos">${money(inc)}</div></div>
      <div class="panel kpi"><div class="lbl">Expenses this month</div><div class="val">${money(exp)}</div></div>
      ${uncat ? `<div class="panel kpi attn" data-act="reviewUncat"><div class="lbl">Needs a category</div><div class="val">${uncat}</div><div class="small">Review now →</div></div>` : `<div class="panel kpi"><div class="lbl">Needs a category</div><div class="val pos">0</div></div>`}
    </div>
    <div class="grid two">
      <div class="panel chart"><div class="page-head" style="margin:0 0 8px"><h2 style="margin:0">Income vs. expenses, last 6 months</h2>
        <div class="legend"><span><i style="background:var(--bar-a)"></i>Income</span><span><i style="background:var(--bar-b)"></i>Expenses</span></div></div>
        ${monthlyChart(6)}</div>
      <div class="panel"><h2>Top spending this month</h2>
        ${spend.length ? spend.map(x => `<div class="hbar"><span>${esc(x.a.name)}</span><span class="num">${money(x.v)}</span><div class="track"><div class="fill" style="width:${(x.v / maxS * 100).toFixed(1)}%"></div></div></div>`).join('') : '<p class="muted">No expenses recorded this month yet.</p>'}
      </div>
    </div>
    <div class="panel" style="margin-top:16px"><div class="page-head" style="margin:0 0 6px"><h2 style="margin:0">Recent transactions</h2><button class="link" data-act="goto" data-v="register">View all</button></div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Payee</th><th>Account</th><th>Category</th><th class="num">Amount</th></tr></thead><tbody>
      ${recent.map(t => `<tr><td class="num small">${usDate(t.date)}</td><td class="payee">${esc(t.payee)}</td><td><span class="chip">${esc((acc(t.accountId) || {}).name)}</span></td><td>${isUncat(t) ? '<span class="chip" style="background:var(--warn-soft);color:var(--warn)">Uncategorized</span>' : esc((acc(t.categoryId) || {}).name)}</td><td class="num ${t.amount < 0 ? '' : 'pos'}">${money(t.amount)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  };
  function onboarding() {
    return `<div class="page-head"><div><h1>Welcome to Ledger Desk</h1><p class="sub">Bookkeeping for ${esc(S.company)}, stored ${WHERE}.</p></div></div>
    <div class="grid two">
      <div class="panel"><h2>Start with your credit card statement</h2>
        <ol class="steps">
          <li>Sign in to your credit card website.</li>
          <li>Find <b>Download transactions</b> and choose <b>QuickBooks Web Connect (.QBO)</b>.</li>
          <li>Bring the file here. Ledger Desk skips anything already imported.</li>
          <li>Bank deposits are never counted as income. Add your income yourself with <b>Record income</b>.</li>
        </ol>
        <div class="toolbar" style="margin-top:16px"><button class="btn primary" data-act="goto" data-v="import">Import a .QBO file</button><button class="btn" data-act="newTxn">Enter a transaction</button></div>
      </div>
      <div class="panel"><h2>Coming from QuickBooks?</h2><p class="muted">Bring over your chart of accounts and every transaction from QuickBooks Desktop or QuickBooks Online.</p>
        <button class="btn primary" data-act="goto" data-v="qb">Restore from QuickBooks</button></div>
      <div class="panel"><h2>Just looking?</h2><p class="muted">Load three months of example credit card activity to see categories, rules and reports in action. You can remove it with one click.</p>
        <button class="btn" data-act="loadSample">Load sample data</button></div>
    </div>`;
  }

  function monthlyChart(n, from, to) {
    let keys = [];
    if (from && to) {
      let d = new Date(+from.slice(0, 4), +from.slice(5, 7) - 1, 1);
      const end = to.slice(0, 7);
      while (monthKey(iso(d)) <= end && keys.length < 36) { keys.push(monthKey(iso(d))); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
    } else {
      const d = new Date();
      for (let i = n - 1; i >= 0; i--) keys.push(monthKey(iso(new Date(d.getFullYear(), d.getMonth() - i, 1))));
    }
    const data = keys.map(k => ({ k, inc: 0, exp: 0 }));
    const idx = {}; keys.forEach((k, i) => idx[k] = i);
    live().forEach(t => {
      const i = idx[monthKey(t.date)]; if (i == null) return;
      const c = acc(t.categoryId); if (!c) return;
      const v = C.categoryAmount(c, t);
      if (c.type === 'income') data[i].inc += v; else if (c.type === 'expense') data[i].exp += v;
    });
    const W = 640, H = 230, L = 64, B = 26, T = 10, Rr = 8;
    const max = Math.max(1, ...data.map(d => Math.max(d.inc, d.exp)));
    const step = niceStep(max / 4), top = Math.ceil(max / step) * step;
    const y = v => T + (H - T - B) * (1 - Math.max(0, v) / top);
    const slot = (W - L - Rr) / data.length, bw = Math.min(26, slot / 3);
    let g = '';
    for (let v = 0; v <= top + 1e-9; v += step) g += `<line x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" /><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${shortMoney(v)}</text>`;
    data.forEach((d, i) => {
      const cx = L + slot * i + slot / 2;
      g += `<rect x="${cx - bw - 1}" y="${y(d.inc)}" width="${bw}" height="${y(0) - y(d.inc)}" fill="var(--bar-a)" rx="2"><title>${monthLabel(d.k)} income ${money(d.inc)}</title></rect>`;
      g += `<rect x="${cx + 1}" y="${y(d.exp)}" width="${bw}" height="${y(0) - y(d.exp)}" fill="var(--bar-b)" rx="2"><title>${monthLabel(d.k)} expenses ${money(d.exp)}</title></rect>`;
      if (data.length <= 12 || i % Math.ceil(data.length / 12) === 0) g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${monthLabel(d.k)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly income and expenses">${g}</svg>`;
  }
  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  function shortMoney(v) { return v >= 1000 ? '$' + (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : '$' + Math.round(v); }

  // ======================= REGISTER =======================
  function registerRows() {
    const st = viewState.register;
    if (st.acct !== 'all' && !acc(st.acct)) st.acct = 'all';
    let list = S.txns.filter(t => {
      if (st.acct !== 'all' && t.accountId !== st.acct && t.categoryId !== st.acct) return false;
      if (st.from && t.date < st.from) return false;
      if (st.to && t.date > st.to) return false;
      if (st.uncat && (!isUncat(t) || t.ignored)) return false;
      if (!st.showIgn && t.ignored) return false;
      if (st.q) {
        const q = st.q.toLowerCase();
        const hay = (t.payee + ' ' + (t.memo || '') + ' ' + ((acc(t.categoryId) || {}).name || '') + ' ' + Math.abs(t.amount).toFixed(2)).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    list.sort((a, b) => a.date.localeCompare(b.date) || (a.seq || 0) - (b.seq || 0));
    return list;
  }
  views.register = () => {
    const st = viewState.register;
    const single = st.acct !== 'all' ? acc(st.acct) : null;
    const isCat = !!single && single.type !== 'asset' && single.type !== 'liability'; // a category's transactions (from Chart of Accounts)
    const list = registerRows();
    // running balance (only meaningful for a single account with no other filters)
    const showBal = single && !isCat && !st.q && !st.uncat && !st.from;
    let bal = 0; const balById = {};
    if (showBal) list.forEach(t => { if (t.ignored) return; const amt = t.accountId === single.id ? t.amount : -t.amount; bal += single.type === 'asset' ? amt : -amt; balById[t.id] = r2(bal); });
    const rows = list.slice().reverse();
    const shown = rows.slice(0, st.limit);
    const credit = single && single.type === 'liability';
    const clearing = single && single.sys === 'deposits';
    const outL = clearing ? 'Bank deposit' : credit ? 'Charge' : single && !isCat ? 'Payment' : 'Money out', inL = clearing ? 'Income recorded' : credit ? 'Payment' : single && !isCat ? 'Deposit' : 'Money in';
    const R = ranges();
    let totalOut = 0, totalIn = 0;
    list.forEach(t => { if (t.ignored) return; const amt = single && !isCat && t.categoryId === single.id ? -t.amount : t.amount; if (amt < 0) totalOut -= amt; else totalIn += amt; });
    const catTotal = isCat ? list.filter(t => !t.ignored).reduce((s, t) => s + C.categoryAmount(single, t), 0) : 0;
    const sel = st.sel;
    const nUncat = live().filter(isUncat).length;
    const nIgn = S.txns.filter(t => t.ignored).length;
    return sampleBanner() + `
    <div class="page-head"><div><h1>${single ? esc(single.name) : 'Transactions'}</h1>
      <p class="sub">${isCat ? '<button class="link" data-act="goto" data-v="accounts">← Chart of Accounts</button> · ' : ''}${list.length} transaction${list.length === 1 ? '' : 's'} · ${isCat ? 'total ' + money(catTotal) + ' (for the dates picked)' : 'out ' + money(totalOut) + ' · in ' + money(totalIn)}${single && !isCat ? ' · balance ' + money(C.natural(single, C.debits(live())[single.id])) + (credit ? ' owed' : '') : ''}</p></div>
      <div class="toolbar" style="margin:0"><button class="btn" data-act="exportRegister">Export CSV</button><button class="btn" data-act="autoAll" title="Categorize uncategorized transactions and match transfers">Auto-categorize</button><button class="btn" data-act="newIncome">Record income</button><button class="btn primary" data-act="newTxn">Add transaction</button></div></div>
    ${clearing ? `<div class="notice">Bank deposits land here instead of in income. Record your income with <b>Record income</b> and choose "Already in a bank deposit". This balance is deposits you haven't recorded as income or sorted yet.</div>` : ''}
    <div class="toolbar">
      <select id="fAcct" data-change="fAcct" aria-label="Account">${isCat ? `<option value="${single.id}" selected>Category: ${esc(single.name)}</option>` : ''}${registerOptions(st.acct, true)}</select>
      <select id="fRange" data-change="fRange" aria-label="Date range">${Object.entries(R).map(([k, v]) => `<option value="${k}"${st.range === k ? ' selected' : ''}>${v[0]}</option>`).join('')}<option value="custom"${st.range === 'custom' ? ' selected' : ''}>Custom…</option></select>
      ${st.range === 'custom' ? `<input type="date" id="fFrom" data-change="fFrom" value="${st.from}" aria-label="From"><input type="date" id="fTo" data-change="fTo" value="${st.to}" aria-label="To">` : ''}
      <input type="search" class="grow" id="fQ" data-input="fQ" placeholder="Search payee, memo, category or amount" value="${esc(st.q)}">
      <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="check" id="fUncat" data-change="fUncat"${st.uncat ? ' checked' : ''}> Uncategorized only (${nUncat})</label>
      ${nIgn ? `<label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="check" id="fIgn" data-change="fIgn"${st.showIgn ? ' checked' : ''}> Show ignored (${nIgn})</label>` : ''}
    </div>
    ${sel.size ? `<div class="sel-bar"><b>${sel.size} selected</b><span>Categorize as</span><select id="bulkCat" aria-label="Category">${catOptions('')}</select><button class="btn sm primary" data-act="bulkCat">Apply</button><button class="btn sm" data-act="bulkIgnore">Ignore</button>${st.showIgn ? '<button class="btn sm" data-act="bulkRestore">Restore</button>' : ''}<button class="btn sm danger" data-act="bulkDel">Delete</button><button class="link" data-act="clearSel">Clear selection</button></div>` : ''}
    <div class="panel" style="padding:0"><div class="table-wrap">
    ${list.length ? `<table><thead><tr><th style="width:28px"><input type="checkbox" class="check" data-act="selAll" aria-label="Select all"${shown.length && shown.every(t => sel.has(t.id)) ? ' checked' : ''}></th><th>Date</th><th>Payee</th>${single && !isCat ? '' : '<th>Account</th>'}<th>Category</th><th class="num">${outL}</th><th class="num">${inL}</th>${showBal ? '<th class="num">Balance</th>' : ''}<th></th></tr></thead><tbody>
    ${shown.map(t => {
      const viaCat = single && !isCat && t.categoryId === single.id;
      const amt = viaCat ? -t.amount : t.amount;
      const other = viaCat ? t.accountId : t.categoryId;
      const unc = isUncat(t);
      return `<tr data-id="${t.id}"${t.ignored ? ' class="ignored"' : ''}>
        <td><input type="checkbox" class="check" data-act="sel"${sel.has(t.id) ? ' checked' : ''} aria-label="Select"></td>
        <td class="num small">${usDate(t.date)}</td>
        <td style="min-width:180px"><button class="link payee" style="color:inherit;text-decoration:none" data-act="edit">${esc(t.payee)}</button>${t.memo ? `<div class="memo">${esc(t.memo)}</div>` : ''}</td>
        ${single && !isCat ? '' : `<td><span class="chip ${(acc(t.accountId) || {}).detail === 'credit' ? 'cc' : ''}">${esc((acc(t.accountId) || {}).name || '?')}</span></td>`}
        <td>${t.matchOf ? '<span class="chip">Matched transfer · duplicate hidden</span>' : t.ignored ? '<span class="chip">Ignored · not counted</span>' : viaCat ? `<span class="small">${esc((acc(other) || {}).name)}</span>${t.transferWith ? '<div class="why">↔ Transfer, matched · <button class="link" data-act="unmatchOne">Unmatch</button></div>' : ''}` : (t.source === 'income' || qbIncomeDeposit(t)) ? `<span class="small">${esc((acc(t.categoryId) || {}).name)}</span>` : `<select class="cat${unc ? ' uncat' : ''}" data-change="cat" aria-label="Category">${catOptions(t.categoryId, t.accountId, isBankDeposit(t) && !t.transferWith, noIncome(t))}</select>`}${!t.ignored && t.transferWith ? '<div class="why">↔ Transfer, matched · <button class="link" data-act="unmatchOne">Unmatch</button></div>' : !t.ignored && t.why && !unc ? '<div class="why" title="' + esc(t.why) + '">Auto · ' + esc(t.why) + '</div>' : ''}</td>
        <td class="num">${amt < 0 ? money(-amt) : ''}</td>
        <td class="num pos">${amt >= 0 ? money(amt) : ''}</td>
        ${showBal ? `<td class="num">${t.ignored ? '' : money(balById[t.id])}</td>` : ''}
        <td style="white-space:nowrap;text-align:right">${t.matchOf ? '<button class="btn sm" data-act="unmatchOne">Unmatch</button>' : t.ignored ? '<button class="btn sm" data-act="restoreOne">Restore</button>' : (viaCat || t.source === 'income' ? '' : '<button class="btn sm" data-act="mkRule" title="Create a rule from this payee">Rule</button> ') + '<button class="btn sm" data-act="ignoreOne" title="Keep it, but leave it out of balances and reports">Ignore</button>'} <button class="btn sm danger" data-act="delOne" title="Delete this transaction">Delete</button></td>
      </tr>`;
    }).join('')}
    </tbody></table>${rows.length > shown.length ? `<div style="padding:12px;text-align:center"><button class="btn" data-act="more">Show ${Math.min(500, rows.length - shown.length)} more of ${rows.length - shown.length}</button></div>` : ''}`
      : `<div class="empty">${S.txns.length ? 'No transactions match these filters.' : 'No transactions yet.'}<div class="toolbar" style="justify-content:center;margin-top:12px"><button class="btn primary" data-act="goto" data-v="import">Import a .QBO file</button></div></div>`}
    </div></div>`;
  };

  function txnModal(t) {
    const isNew = !t;
    const regs = registers();
    if (!regs.length) { toast('Add a bank or credit card account first (Chart of Accounts).'); return; }
    if (t && t.source === 'income') { incomeModal(t); return; }
    t = t || { id: '', date: today(), payee: '', memo: '', amount: 0, accountId: viewState.register.acct !== 'all' ? viewState.register.acct : (regs.find(a => a.detail === 'credit') || regs[0]).id, categoryId: '' };
    const out = t.amount < 0 ? (-t.amount).toFixed(2) : '', inn = t.amount > 0 ? t.amount.toFixed(2) : '';
    const qbInc = !isNew && qbIncomeDeposit(t);
    modal(`<h2>${isNew ? 'Add transaction' : 'Edit transaction'}</h2>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
        <label class="field">Date<input type="date" id="mDate" value="${t.date}"></label>
        <label class="field">Account<select id="mAcct">${registerOptions(t.accountId)}</select></label>
        <label class="field" style="grid-column:1/-1">Payee<input type="text" id="mPayee" value="${esc(t.payee)}" placeholder="Who was paid, or who paid you"></label>
        <label class="field" style="grid-column:1/-1">Category<select id="mCat">${catOptions(t.categoryId || sysAcc('uncatOut').id, t.accountId, isBankDeposit(t) && !qbInc)}</select><span class="small muted">Money coming into a bank account is never income here. To record income, use Record income.</span></label>
        <label class="field">Money out (charge / payment)<input type="number" step="0.01" min="0" id="mOut" value="${out}" placeholder="0.00"></label>
        <label class="field">Money in (deposit / card payment)<input type="number" step="0.01" min="0" id="mIn" value="${inn}" placeholder="0.00"></label>
        <label class="field" style="grid-column:1/-1">Memo<input type="text" id="mMemo" value="${esc(t.memo)}"></label>
      </div>
      <p class="small muted" id="mErr"></p>
      <div class="actions">${isNew ? '' : '<button class="btn danger" id="mDel">Delete</button><button class="btn" id="mIgn" style="margin-right:auto">' + (t.ignored ? 'Restore' : 'Ignore') + '</button>'}<button class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Save</button></div>`, card => {
      card.querySelector('#mCancel').onclick = closeModal;
      if (!isNew) {
        card.querySelector('#mDel').onclick = () => { closeModal(); deleteTxns([t.id]); };
        card.querySelector('#mIgn').onclick = () => { closeModal(); ignoreTxns([t.id], !t.ignored); };
      }
      // Keep the category list right when the amount or account changes (deposits can't be income)
      const refreshCats = () => {
        const o = parseFloat(card.querySelector('#mOut').value) || 0, i = parseFloat(card.querySelector('#mIn').value) || 0;
        const probe = { accountId: card.querySelector('#mAcct').value, amount: i - o };
        const sel = card.querySelector('#mCat'), cur = sel.value;
        sel.innerHTML = catOptions(allowedCat(probe, cur) || acc(cur).sys ? cur : defaultCat(probe), probe.accountId, isBankDeposit(probe));
        if (!acc(sel.value) || !allowedCat(probe, sel.value)) sel.value = defaultCat(probe);
      };
      if (!qbInc) ['#mOut', '#mIn', '#mAcct'].forEach(q => card.querySelector(q).addEventListener('change', refreshCats));
      card.querySelector('#mSave').onclick = () => {
        const o = parseFloat(card.querySelector('#mOut').value) || 0, i = parseFloat(card.querySelector('#mIn').value) || 0;
        const amt = r2(i - o);
        const accountId = card.querySelector('#mAcct').value, categoryId = card.querySelector('#mCat').value;
        const err = card.querySelector('#mErr');
        if (!card.querySelector('#mDate').value) { err.textContent = 'Enter a date.'; return; }
        if (!amt) { err.textContent = 'Enter an amount in Money out or Money in.'; return; }
        if (accountId === categoryId) { err.textContent = 'The category must be different from the account.'; return; }
        if (!allowedCat({ accountId, amount: amt }, categoryId) && !(qbInc && categoryId === t.categoryId)) { err.textContent = 'A deposit into a bank account can\'t be income. Pick another category, or use Record income.'; return; }
        const x = isNew ? { id: uid(), seq: Date.now(), source: 'manual' } : S.txns.find(z => z.id === t.id);
        delete x.why;
        Object.assign(x, { date: card.querySelector('#mDate').value, payee: card.querySelector('#mPayee').value.trim() || '(no payee)', memo: card.querySelector('#mMemo').value.trim(), amount: amt, accountId, categoryId });
        const c = acc(categoryId); if (c && (c.sys === 'uncatIn' || c.sys === 'uncatOut')) x.categoryId = defaultCat(x);
        if (isNew) S.txns.push(x);
        save(); closeModal(); render(); toast(isNew ? 'Transaction added' : 'Transaction saved');
      };
    });
  }

  function ruleModal(prefill) {
    prefill = prefill || {};
    modal(`<h2>${prefill.id ? 'Edit rule' : 'New bank rule'}</h2>
      <p class="muted small" style="margin-top:0">When an imported transaction's payee or memo contains the text below, Ledger Desk assigns the category automatically.</p>
      <div class="grid" style="gap:12px">
        <label class="field">Payee contains<input type="text" id="rMatch" value="${esc(prefill.match || '')}" placeholder="e.g. AMAZON"></label>
        <label class="field">Applies to<select id="rSign"><option value="any">Money in or out</option><option value="out"${prefill.sign === 'out' ? ' selected' : ''}>Money out only (charges)</option><option value="in"${prefill.sign === 'in' ? ' selected' : ''}>Money in only (payments, refunds)</option></select></label>
        <label class="field">Set category to<select id="rCat">${catOptions(prefill.categoryId || '')}</select><span class="small muted">Rules never turn a bank deposit into income.</span></label>
        <label class="field">Rename payee to (optional)<input type="text" id="rRename" value="${esc(prefill.rename || '')}" placeholder="e.g. Amazon"></label>
        <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="check" id="rApply" checked> Also apply to existing uncategorized transactions</label>
      </div><p class="small muted" id="rErr"></p>
      <div class="actions"><button class="btn" id="rCancel">Cancel</button><button class="btn primary" id="rSave">Save rule</button></div>`, card => {
      card.querySelector('#rCancel').onclick = closeModal;
      card.querySelector('#rSave').onclick = () => {
        const match = card.querySelector('#rMatch').value.trim();
        if (!match) { card.querySelector('#rErr').textContent = 'Enter the text to look for.'; return; }
        const r = prefill.id ? S.rules.find(x => x.id === prefill.id) : { id: uid() };
        Object.assign(r, { match, sign: card.querySelector('#rSign').value, categoryId: card.querySelector('#rCat').value, rename: card.querySelector('#rRename').value.trim() });
        if (!prefill.id) S.rules.push(r);
        let n = 0;
        if (card.querySelector('#rApply').checked) n = applyRulesToUncat();
        save(); closeModal(); render(); toast('Rule saved' + (n ? ' · ' + n + ' transaction' + (n === 1 ? '' : 's') + ' categorized' : ''));
      };
    });
  }
  function applyRulesToUncat() {
    let n = 0;
    S.txns.forEach(t => {
      if (t.ignored || !(isUncat(t) || t.categoryId === depAcc().id)) return;
      const r = C.matchRule(S.rules, t);
      if (r && allowedCat(t, r.categoryId) && r.categoryId !== t.categoryId) { t.categoryId = r.categoryId; if (r.rename) t.payee = r.rename; n++; }
    });
    return n;
  }
  function suggestMatch(payee) {
    const words = payee.replace(/[#*]/g, ' ').split(/\s+/).filter(w => w && !/\d{3,}/.test(w));
    return words.slice(0, 2).join(' ') || payee;
  }

  // ======================= IMPORT =======================
  views.import = () => {
    const p = viewState.import.pending;
    return sampleBanner() + `<div class="page-head"><div><h1>Import .QBO</h1><p class="sub">${CO ? 'Importing into <b>' + esc(S.company) + '</b>. ' : ''}QuickBooks Web Connect (.qbo), Quicken (.qfx) and Money (.ofx) statement files.</p></div></div>
    ${p ? importReview(p) : `
    <div class="drop" id="drop"><strong>Drop your .QBO file here</strong><span class="muted">or</span>
      <div style="margin-top:10px"><label class="btn primary" for="fileIn" style="display:inline-block">Choose file…</label><input type="file" id="fileIn" accept=".qbo,.qfx,.ofx,.QBO,.QFX,.OFX" multiple hidden></div>
      <p class="small muted" style="margin-top:12px">Duplicates are skipped automatically, so it is safe to import overlapping date ranges.</p></div>
    <div class="panel" style="margin-top:16px"><h2>Where to get the file</h2>
      <ol class="steps"><li>Log in to your credit card or bank website.</li><li>Open the account, then look for <b>Download</b>, <b>Export</b> or the download icon above the transaction list.</li><li>Pick a date range and the format <b>QuickBooks Web Connect</b> or <b>QuickBooks (.QBO)</b>. Quicken (.QFX) works too.</li></ol></div>`}`;
  };
  afterRender.import = () => {
    const drop = $('#drop'), inp = $('#fileIn');
    if (inp) inp.addEventListener('change', () => readFiles(inp.files));
    if (drop) {
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => readFiles(e.dataTransfer.files));
    }
  };
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { if (!e.target.closest('#drop')) { e.preventDefault(); if (e.dataTransfer.files.length) { go('import'); readFiles(e.dataTransfer.files); } } });

  async function readFiles(files) {
    const stmts = [], errors = [];
    for (const f of Array.from(files)) {
      try {
        const text = await f.text();
        C.parseOFX(text).forEach(s => { s.fileName = f.name; stmts.push(s); });
      } catch (e) { errors.push(f.name + ': ' + e.message); }
    }
    if (errors.length) toast(errors.join(' · '));
    if (!stmts.length) return;
    stmts.forEach((s, i) => {
      s.key = 'st' + i;
      const last4 = (s.acctId || '').replace(/\D/g, '').slice(-4);
      const existing = S.accounts.find(a => a.ofxId && a.ofxId === s.acctId);
      s.target = existing ? existing.id : 'new';
      s.newName = (s.kind === 'credit' ? 'Credit Card' : (s.acctType === 'SAVINGS' ? 'Savings' : 'Checking')) + (last4 ? ' •' + last4 : '');
      if (s.org && s.org.length > 2) s.newName = s.org.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 24) + ' ' + s.newName;
      s.setOpening = !existing && s.ledgerBalance != null;
      s.otherCo = existing ? null : otherCompanyFor(s.acctId);
    });
    viewState.import.pending = stmts;
    render();
  }

  function dupCheck(s, targetId) {
    const existing = new Set(S.txns.filter(t => t.accountId === targetId).map(tkey).concat(S.deleted.filter(k => k.indexOf(targetId + '|') === 0)));
    let dup = 0;
    // the same transaction may already be here from the other kind of file (a PDF statement vs. the bank's QBO file)
    const other = S.txns.filter(t => t.accountId === targetId && (s.source === 'pdf' ? t.source !== 'pdf' : t.source === 'pdf'));
    const used = new Set();
    const sameAs = t => other.find(o => !used.has(o.id) && Math.abs(o.amount - t.amount) < 0.005 && Math.abs(dayNum(o.date) - dayNum(t.date)) <= 3);
    s.txns.forEach(t => { const k = tkey(Object.assign({}, t, { accountId: targetId })); t._dup = existing.has(k); if (!t._dup) { const o = sameAs(t); if (o) { used.add(o.id); t._dup = true; } } if (t._dup) dup++; existing.add(k); });
    return dup;
  }
  function importReview(stmts) {
    return stmts.map(s => {
      const dup = s.target === 'new' ? dupCheck(s, '__none__') : dupCheck(s, s.target);
      const fresh = s.txns.length - dup;
      const charges = s.txns.filter(t => t.amount < 0).reduce((a, t) => a - t.amount, 0), credits = s.txns.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0);
      const dates = s.txns.map(t => t.date).sort();
      const owed = s.ledgerBalance == null ? '' : (s.kind === 'credit' ? Math.abs(s.ledgerBalance) : s.ledgerBalance).toFixed(2);
      return `<div class="stmt" data-key="${s.key}">
        <div class="stmt-head"><div><h2 style="margin:0">${s.kind === 'credit' ? 'Credit card' : 'Bank'} statement${s.org ? ' · ' + esc(s.org) : ''}</h2>
          <div class="muted small">${esc(s.fileName)} · account ending ${esc((s.acctId || '').slice(-4) || '—')} · ${dates.length ? usDate(dates[0]) + ' – ' + usDate(dates[dates.length - 1]) : 'no transactions'}</div></div>
          <div class="num"><div>${s.txns.length} transactions</div><div class="small muted">${money(charges)} out · ${money(credits)} in</div></div></div>
        <div class="form-row" style="margin-top:12px">
          <label class="field">Import into<select data-change="impTarget"><option value="new"${s.target === 'new' ? ' selected' : ''}>New account…</option>${sortAccs(registers()).map(a => `<option value="${a.id}"${s.target === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
          ${s.target === 'new' ? `<label class="field" style="flex:1;min-width:200px">New account name<input type="text" data-input="impName" value="${esc(s.newName)}"></label>` : ''}
        </div>
        ${s.target === 'new' && s.ledgerBalance != null ? `<div class="form-row" style="margin-top:10px">
          <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="check" data-change="impOpen"${s.setOpening ? ' checked' : ''}> Match the statement balance of</label>
          <input type="number" step="0.01" data-input="impBal" value="${owed}" style="width:130px" aria-label="Statement balance"><span class="small muted">${s.kind === 'credit' ? 'owed' : ''} on ${usDate(s.ledgerDate)} (adds an opening balance entry)</span></div>` : ''}
        ${s.otherCo ? `<div class="notice" style="border-color:var(--neg,#b42318);color:var(--neg,#b42318)"><b>This account belongs to ${esc(s.otherCo)}.</b> It can't be imported into ${esc(S.company)}. Switch to ${esc(s.otherCo)} (top left) and import the file there.</div>` : ''}
        ${dup ? `<div class="notice">${dup} transaction${dup === 1 ? ' was' : 's were'} imported or deleted before and will be skipped.</div>` : ''}
        <div class="table-wrap" style="max-height:260px;overflow:auto;margin-top:10px;border:1px solid var(--line);border-radius:6px"><table><thead><tr><th>Date</th><th>Payee</th><th class="num">Amount</th><th></th></tr></thead><tbody>
          ${s.txns.slice(0, 200).map(t => `<tr${t._dup ? ' style="opacity:.45"' : ''}><td class="num small">${usDate(t.date)}</td><td>${esc(t.payee)}${t.memo ? `<div class="memo">${esc(t.memo)}</div>` : ''}</td><td class="num ${t.amount >= 0 ? 'pos' : ''}">${money(t.amount)}</td><td class="small muted">${t._dup ? 'already imported or deleted' : ''}</td></tr>`).join('')}
        </tbody></table></div>
        ${s.txns.length > 200 ? `<p class="small muted">Showing first 200 of ${s.txns.length}.</p>` : ''}
        <div class="toolbar" style="margin-top:12px;margin-bottom:0"><button class="btn primary" data-act="doImport"${fresh && !s.otherCo ? '' : ' disabled'}>${s.otherCo ? 'Belongs to ' + esc(s.otherCo) : fresh ? 'Import ' + fresh + ' transaction' + (fresh === 1 ? '' : 's') : 'Nothing new to import'}</button><button class="btn" data-act="cancelImport">Cancel</button></div>
      </div>`;
    }).join('');
  }
  function doImport(s) {
    let target;
    if (s.target === 'new') {
      target = { id: uid(), name: (s.newName || 'Imported account').trim(), type: s.kind === 'credit' ? 'liability' : 'asset', detail: s.kind === 'credit' ? 'credit' : 'bank', ofxId: s.acctId, sys: '' };
      S.accounts.push(target);
    } else { target = acc(s.target); if (!target.ofxId) target.ofxId = s.acctId; }
    dupCheck(s, target.id);
    const memo = memorized();
    let n = 0, auto = 0, seq = Date.now();
    const added = [];
    s.txns.forEach(t => {
      if (t._dup) return;
      const x = { id: uid(), seq: seq++, date: t.date, payee: t.payee, memo: t.memo, amount: t.amount, accountId: target.id, categoryId: '', fitid: t.fitid, origPayee: t.payee, sic: t.sic || '', checkNum: t.checkNum || '', source: s.source || 'qbo' };
      if (autoCategorize(x, memo)) auto++;
      S.txns.push(x); added.push(x); n++;
    });
    if (s.target === 'new' && s.setOpening && s.balInput != null && !isNaN(s.balInput) && added.length) {
      const wantDebit = s.kind === 'credit' ? -Math.abs(s.balInput) : s.balInput;
      const upTo = s.ledgerDate || '9999';
      const have = added.filter(t => t.date <= upTo).reduce((a, t) => a + t.amount, 0);
      const diff = r2(wantDebit - have);
      if (diff) {
        const first = added.map(t => t.date).sort()[0];
        const d = new Date(+first.slice(0, 4), +first.slice(5, 7) - 1, +first.slice(8, 10) - 1);
        S.txns.push({ id: uid(), seq: 0, date: iso(d), payee: 'Opening balance', memo: 'Balance before first imported transaction', amount: diff, accountId: target.id, categoryId: sysAcc('obe').id, source: 'opening' });
      }
    }
    const matched = matchTransfers();
    save();
    return { n, auto, target, matched };
  }

  // ======================= ACCOUNTS =======================
  views.accounts = () => {
    const d = C.debits(live());
    const used = new Set(); S.txns.forEach(t => { used.add(t.accountId); used.add(t.categoryId); });
    const groups = ['asset', 'liability', 'equity', 'income', 'expense'];
    return sampleBanner() + `<div class="page-head"><div><h1>Chart of Accounts</h1><p class="sub">Balance sheet accounts show today's balance. Income and expense accounts show all-time totals.</p></div>
      <button class="btn primary" data-act="newAcct">New account</button></div>
      <div class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th class="num">Balance</th><th></th></tr></thead><tbody>
      ${groups.map(g => {
        const list = sortAccs(S.accounts.filter(a => a.type === g));
        return `<tr><td colspan="4" style="background:var(--panel-2);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em">${TYPE_LABEL[g]}</td></tr>` +
          list.map(a => `<tr data-acct="${a.id}" class="acct-row" title="Double-click to see its transactions"><td><button class="link" data-act="openAcct" style="color:inherit;text-decoration:none;font:inherit;text-align:left">${esc(a.name)}</button>${a.sys ? ' <span class="chip">system</span>' : ''}${a.sample ? ' <span class="chip">sample</span>' : ''}</td>
            <td class="muted small">${TYPE_LABEL[a.type]}${DETAIL_LABEL[a.detail] ? ' · ' + DETAIL_LABEL[a.detail] : ''}</td>
            <td class="num">${money(C.natural(a, d[a.id]))}</td>
            <td style="white-space:nowrap;text-align:right">${(a.type === 'asset' || a.type === 'liability') ? '<button class="btn sm" data-act="openReg">Transactions</button> ' : '<button class="btn sm" data-act="openAcct">Transactions</button> <button class="btn sm" data-act="openDetail">Report</button> '}<button class="btn sm" data-act="renameAcct">Rename</button>${!a.sys ? ` <button class="btn sm danger" data-act="delAcct" ${used.has(a.id) ? 'title="Has transactions"' : ''}>Delete</button>` : ''}</td></tr>`).join('');
      }).join('')}
      </tbody></table></div></div>`;
  };
  function acctModal(a) {
    const isNew = !a;
    a = a || { name: '', type: 'expense', detail: 'other' };
    modal(`<h2>${isNew ? 'New account' : 'Edit account'}</h2><div class="grid" style="gap:12px">
      <label class="field">Name<input type="text" id="aName" value="${esc(a.name)}"></label>
      ${isNew ? `<label class="field">Type<select id="aType">
        <option value="expense">Expense category</option><option value="income">Income category</option>
        <option value="liability:credit">Credit card</option><option value="asset:bank">Bank account (checking / savings)</option>
        <option value="liability:loan">Loan or line of credit</option><option value="asset:other">Other asset</option><option value="equity">Equity</option></select></label>` : ''}
      ${!isNew && (a.type === 'income' || a.type === 'expense') ? `<label class="field">Show on the Profit &amp; Loss under<select id="aPl">${(a.type === 'income' ? [['', 'Income'], ['otherinc', 'Other Income']] : [['', 'Expense'], ['cogs', 'Cost of Goods Sold'], ['otherexp', 'Other Expense']]).map(([v, l]) => `<option value="${v}"${plSection(a) === (v || (a.type === 'income' ? 'inc' : 'exp')) ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      <p class="small muted" style="margin:0">Tip: to make a sub-account, put the main account first with a colon, like <b>HOTEL SUPPLY:LAUNDRY SUPPLY</b>. The Profit &amp; Loss groups them with a total, like QuickBooks.</p>
      </div><p class="small muted" id="aErr"></p><div class="actions"><button class="btn" id="aCancel">Cancel</button><button class="btn primary" id="aSave">Save</button></div>`, card => {
      card.querySelector('#aCancel').onclick = closeModal;
      card.querySelector('#aSave').onclick = () => {
        const name = card.querySelector('#aName').value.trim();
        if (!name) { card.querySelector('#aErr').textContent = 'Enter a name.'; return; }
        if (S.accounts.some(x => x.name.toLowerCase() === name.toLowerCase() && x.id !== a.id)) { card.querySelector('#aErr').textContent = 'An account with that name already exists.'; return; }
        if (isNew) { const [type, detail] = card.querySelector('#aType').value.split(':'); S.accounts.push({ id: uid(), name, type, detail: detail || 'other', sys: '' }); }
        else { acc(a.id).name = name; const pl = card.querySelector('#aPl'); if (pl) acc(a.id).pl = pl.value; }
        save(); closeModal(); render(); toast(isNew ? 'Account created' : 'Account saved');
      };
    });
  }

  // ---------------- transfer matching ----------------
  // A card payment shows up twice: +amount on the card and −amount at the bank. We keep one side,
  // point its category at the other account, and hide the other side so it isn't counted twice.
  const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
  const isOpenSide = t => isUncat(t) || t.categoryId === depAcc().id;
  function matchTransfers() {
    const regs = new Set(registers().map(a => a.id));
    const pool = S.txns.filter(t => !t.ignored && !t.matchOf && !t.transferWith && regs.has(t.accountId) && t.source !== 'income' && t.source !== 'opening' && t.source !== 'qb');
    const byAmt = {};
    pool.forEach(t => { const k = Math.abs(t.amount).toFixed(2); (byAmt[k] = byAmt[k] || []).push(t); });
    const used = new Set(); let n = 0;
    pool.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach(a => {
      if (used.has(a.id)) return;
      let best = null, bestGap = 99;
      (byAmt[Math.abs(a.amount).toFixed(2)] || []).forEach(b => {
        if (b === a || used.has(b.id) || b.accountId === a.accountId || r2(a.amount + b.amount) !== 0) return;
        const gap = Math.abs(dayNum(a.date) - dayNum(b.date)); if (gap > 7) return;
        const linked = a.categoryId === b.accountId || b.categoryId === a.accountId;
        if (!linked) {
          if (!isOpenSide(a) || !isOpenSide(b)) return;
          if (!M.looksLikeTransfer(a.payee, a.memo) && !M.looksLikeTransfer(b.payee, b.memo)) return;
        }
        if (gap < bestGap) { best = b; bestGap = gap; }
      });
      if (!best) return;
      // Keep the side you already pointed at the other account; otherwise keep the money-out side (from the bank)
      let keep = a, hide = best;
      if (best.categoryId === a.accountId && a.categoryId !== best.accountId) { keep = best; hide = a; }
      else if (a.categoryId !== best.accountId && best.amount < 0) { keep = best; hide = a; }
      keep.categoryId = hide.accountId; keep.transferWith = hide.id; keep.why = 'Matched with ' + ((acc(hide.accountId) || {}).name || 'the other account');
      hide.ignored = true; hide.matchOf = keep.id;
      used.add(a.id); used.add(best.id); n++;
    });
    return n;
  }
  function unmatch(id) {
    const t = S.txns.find(x => x.id === id); if (!t) return;
    const keep = t.matchOf ? S.txns.find(x => x.id === t.matchOf) : t;
    const hide = t.transferWith ? S.txns.find(x => x.id === t.transferWith) : t.matchOf ? t : null;
    if (keep) { delete keep.transferWith; if (hide && keep.categoryId === hide.accountId) keep.categoryId = defaultCat(keep); delete keep.why; }
    if (hide) { delete hide.matchOf; hide.ignored = false; }
    save(); render(); toast('Unmatched. Both transactions are back to review.');
  }

  // ---------------- ignore & delete ----------------
  function ignoreTxns(ids, flag) {
    if (!flag && ids.length === 1) { const t = S.txns.find(x => x.id === ids[0]); if (t && t.matchOf) { unmatch(t.id); return; } }
    const set = new Set(ids); let n = 0;
    S.txns.forEach(t => { if (set.has(t.id) && !!t.ignored !== flag) { t.ignored = flag; n++; } });
    save(); render();
    if (flag) toast(n + ' transaction' + (n === 1 ? '' : 's') + ' ignored. They stay on file but are left out of balances and reports.', 'Undo', () => ignoreTxns(ids, false));
    else toast(n + ' transaction' + (n === 1 ? '' : 's') + ' restored');
  }
  function deleteTxns(ids) {
    const set = new Set(ids);
    const gone = S.txns.filter(t => set.has(t.id));
    if (!gone.length) return;
    const keys = gone.filter(t => t.source === 'qbo').map(tkey);
    gone.forEach(g => {
      const partner = S.txns.find(x => !set.has(x.id) && (x.id === g.transferWith || x.id === g.matchOf));
      if (partner && g.transferWith) { delete partner.matchOf; partner.ignored = false; }
      if (partner && g.matchOf) delete partner.transferWith;
    });
    S.txns = S.txns.filter(t => !set.has(t.id));
    S.deleted = S.deleted.concat(keys);
    ids.forEach(id => viewState.register.sel.delete(id));
    save(); render();
    toast((gone.length === 1 ? '“' + gone[0].payee + '” deleted' : gone.length + ' transactions deleted') + (keys.length ? '. Re-importing won\'t bring ' + (gone.length === 1 ? 'it' : 'them') + ' back.' : ''), 'Undo', () => {
      S.txns = S.txns.concat(gone);
      const ks = new Set(keys); S.deleted = S.deleted.filter(k => !ks.has(k));
      save(); render(); toast('Restored');
    });
  }

  // ---------------- record income (separate from bank deposits) ----------------
  function incomeModal(t) {
    const isNew = !t;
    const incs = S.accounts.filter(a => a.type === 'income' && !a.sys);
    t = t || { date: today(), payee: '', memo: '', amount: 0, accountId: depAcc().id, categoryId: (incs.find(a => a.name === 'Sales') || incs[0] || {}).id };
    const banks = sortAccs(S.accounts.filter(a => a.type === 'asset' && !a.archived));
    modal(`<h2>${isNew ? 'Record income' : 'Edit income'}</h2>
      <p class="small muted" style="margin-top:0">Only income you record here shows on your Profit &amp; Loss. Imported bank deposits are never counted as income.</p>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
        <label class="field">Date<input type="date" id="iDate" value="${t.date}"></label>
        <label class="field">Amount<input type="number" step="0.01" min="0" id="iAmt" value="${t.amount ? t.amount.toFixed(2) : ''}" placeholder="0.00"></label>
        <label class="field" style="grid-column:1/-1">Received from<input type="text" id="iPayee" value="${esc(t.payee)}" placeholder="Customer or source"></label>
        <label class="field" style="grid-column:1/-1">Income category<select id="iCat">${sortAccs(S.accounts.filter(a => a.type === 'income' && !a.archived)).map(a => `<option value="${a.id}"${a.id === t.categoryId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
        <label class="field" style="grid-column:1/-1">Where is the money?<select id="iWhere">
          <option value="${depAcc().id}"${t.accountId === depAcc().id ? ' selected' : ''}>Already in a bank deposit (bank balance stays the same)</option>
          ${banks.map(a => `<option value="${a.id}"${t.accountId === a.id ? ' selected' : ''}>Add to ${esc(a.name)} (cash or a deposit not imported)</option>`).join('')}</select></label>
        <label class="field" style="grid-column:1/-1">Memo<input type="text" id="iMemo" value="${esc(t.memo)}" placeholder="Invoice number, notes"></label>
      </div><p class="small muted" id="iErr"></p>
      <div class="actions">${isNew ? '' : '<button class="btn danger" id="iDel" style="margin-right:auto">Delete</button>'}<button class="btn" id="iCancel">Cancel</button><button class="btn primary" id="iSave">Save income</button></div>`, card => {
      card.querySelector('#iCancel').onclick = closeModal;
      if (!isNew) card.querySelector('#iDel').onclick = () => { closeModal(); deleteTxns([t.id]); };
      card.querySelector('#iSave').onclick = () => {
        const amt = r2(parseFloat(card.querySelector('#iAmt').value) || 0), err = card.querySelector('#iErr');
        if (!card.querySelector('#iDate').value) { err.textContent = 'Enter a date.'; return; }
        if (amt <= 0) { err.textContent = 'Enter the amount received.'; return; }
        if (!card.querySelector('#iCat').value) { err.textContent = 'Create an income category first (Chart of Accounts).'; return; }
        const x = isNew ? { id: uid(), seq: Date.now(), source: 'income' } : S.txns.find(z => z.id === t.id);
        Object.assign(x, { date: card.querySelector('#iDate').value, payee: card.querySelector('#iPayee').value.trim() || 'Income', memo: card.querySelector('#iMemo').value.trim(), amount: amt, accountId: card.querySelector('#iWhere').value, categoryId: card.querySelector('#iCat').value });
        if (isNew) S.txns.push(x);
        save(); closeModal(); render(); toast(isNew ? 'Income recorded' : 'Income saved');
      };
    });
  }

  // ======================= RULES =======================
  views.rules = () => sampleBanner() + `<div class="page-head"><div><h1>Bank Rules</h1><p class="sub">Rules run on every import, top to bottom. The first match wins. Payees you've categorized before are also remembered automatically.</p></div>
    <div class="toolbar" style="margin:0"><button class="btn" data-act="runRules">Apply to uncategorized</button><button class="btn primary" data-act="newRule">New rule</button></div></div>
    <div class="panel" style="padding:0">${S.rules.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Payee contains</th><th>Applies to</th><th>Category</th><th>Rename to</th><th></th></tr></thead><tbody>
    ${S.rules.map((r, i) => `<tr data-rule="${r.id}"><td class="num small muted">${i + 1}</td><td><b>${esc(r.match)}</b></td><td class="small">${r.sign === 'out' ? 'Money out' : r.sign === 'in' ? 'Money in' : 'Both'}</td><td>${esc((acc(r.categoryId) || { name: '(deleted account)' }).name)}</td><td class="small">${esc(r.rename || '')}</td>
      <td style="white-space:nowrap;text-align:right"><button class="btn sm" data-act="ruleUp" ${i ? '' : 'disabled'} aria-label="Move up">↑</button> <button class="btn sm" data-act="editRule">Edit</button> <button class="btn sm danger" data-act="delRule">Delete</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No rules yet. Click <b>Rule</b> next to any transaction to create one from its payee.</div>'}</div>`;

  // ======================= REPORTS =======================
  function reportRange() {
    const st = viewState.reports;
    if (st.range === 'custom') return [st.from, st.to];
    const r = ranges()[st.range]; return [r[1], r[2]];
  }
  views.reports = () => {
    const st = viewState.reports, R = ranges();
    const [from, to] = reportRange();
    const label = st.range === 'custom' ? (usDate(from) || 'Start') + ' – ' + (usDate(to) || 'today') : R[st.range][0] + (from ? ' (' + usDate(from) + ' – ' + usDate(to) + ')' : '');
    const tabs = [['pl', 'Profit & Loss'], ['bs', 'Balance Sheet'], ['spend', 'Spending by Category'], ['trend', 'Monthly Trend'], ['detail', 'Account Detail']];
    let body = '';
    if (st.tab === 'pl') body = plReport(from, to, label);
    if (st.tab === 'bs') body = bsReport(to || '9999-12-31');
    if (st.tab === 'spend') body = spendReport(from, to, label);
    if (st.tab === 'trend') body = `<div class="panel chart"><div class="page-head" style="margin:0 0 8px"><h2 style="margin:0">Income vs. expenses · ${esc(label)}</h2><div class="legend"><span><i style="background:var(--bar-a)"></i>Income</span><span><i style="background:var(--bar-b)"></i>Expenses</span></div></div>${monthlyChart(12, from || firstDate(), to || today())}</div>`;
    if (st.tab === 'detail') body = detailReport(from, to, label);
    return sampleBanner() + `<div class="page-head"><div><h1>Reports</h1><p class="sub">${esc(S.company)}</p></div>
      <div class="toolbar" style="margin:0">
        ${st.tab === 'bs' ? `<label class="small muted" style="display:flex;gap:6px;align-items:center">As of <input type="date" id="rTo" data-change="rAsOf" value="${to || today()}"></label>` :
        `<select id="rRange" data-change="rRange" aria-label="Report period">${Object.entries(R).map(([k, v]) => `<option value="${k}"${st.range === k ? ' selected' : ''}>${v[0]}</option>`).join('')}<option value="custom"${st.range === 'custom' ? ' selected' : ''}>Custom…</option></select>
        ${st.range === 'custom' ? `<input type="date" id="rFrom" data-change="rFrom" value="${st.from}" aria-label="From"><input type="date" id="rTo2" data-change="rTo" value="${st.to}" aria-label="To">` : ''}`}
        ${st.tab !== 'trend' ? '<button class="btn primary" data-act="exportXlsx">Download Excel</button><button class="btn" data-act="exportReport">CSV</button>' : ''}</div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button data-act="rTab" data-tab="${k}" class="${st.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>${body}`;
  };
  function firstDate() { return S.txns.reduce((m, t) => t.date < m ? t.date : m, today()); }
  let lastReportCSV = [];
  function plData(from, to) {
    const d = C.debits(live(), { from, to });
    const line = type => sortAccs(S.accounts.filter(a => a.type === type)).map(a => ({ a, v: C.natural(a, d[a.id]) })).filter(x => Math.abs(x.v) >= 0.005);
    const inc = line('income'), exp = line('expense');
    const ti = inc.reduce((s, x) => s + x.v, 0), te = exp.reduce((s, x) => s + x.v, 0);
    return { inc, exp, ti, te, net: r2(ti - te) };
  }
  // Which part of the Profit & Loss an account goes in (QuickBooks layout)
  function plSection(a) {
    if (a.pl) return a.pl;
    const q = String(a.qbType || '');
    if (a.type === 'income') return /other income/i.test(q) ? 'otherinc' : 'inc';
    if (/cost of goods/i.test(q) || /^(cost of goods sold|cogs)$/i.test(a.name)) return 'cogs';
    if (/other expense/i.test(q)) return 'otherexp';
    return 'exp';
  }
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function qbDates(from, to) {
    from = from || firstDate(); to = to || today();
    const [fy, fm, fd] = from.split('-').map(Number), [ty, tm, td] = to.split('-').map(Number);
    const long = fy === ty ? `${MONTHS_LONG[fm - 1]} ${fd} through ${MONTHS_LONG[tm - 1]} ${td}, ${ty}` : `${MONTHS_LONG[fm - 1]} ${fd}, ${fy} through ${MONTHS_LONG[tm - 1]} ${td}, ${ty}`;
    const short = `${MONTHS_SHORT[fm - 1]} ${fd}${fy === ty ? '' : ', ' + String(fy).slice(2)} - ${MONTHS_SHORT[tm - 1]} ${td}, ${String(ty).slice(2)}`;
    return { long, short };
  }
  // Rows of a QuickBooks-style Profit & Loss: sections, sub-accounts (Parent:Child) with "Parent - Other" and "Total Parent"
  function plRows(from, to) {
    const d = C.debits(live(), { from, to });
    const sec = { inc: [], cogs: [], exp: [], otherinc: [], otherexp: [] };
    S.accounts.filter(a => a.type === 'income' || a.type === 'expense').forEach(a => { const v = C.natural(a, d[a.id]); if (Math.abs(v) >= 0.005) sec[plSection(a)].push({ a, v }); });
    const tree = list => {
      const root = { kids: {}, own: 0, id: null };
      list.forEach(({ a, v }) => {
        const path = a.name.split(':').map(x => x.trim()).filter(Boolean); let n = root;
        path.forEach((p, i) => { n = n.kids[p.toLowerCase()] || (n.kids[p.toLowerCase()] = { name: p, kids: {}, own: 0, id: null }); if (i === path.length - 1) { n.own += v; n.id = a.id; } });
      });
      return root;
    };
    const sum = n => n.own + Object.values(n.kids).reduce((s, k) => s + sum(k), 0);
    const sorted = n => Object.values(n.kids).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const rows = [];
    const emit = (n, lvl) => {
      const kids = sorted(n).filter(k => Math.abs(sum(k)) >= 0.005);
      if (!kids.length) { rows.push({ kind: 'acct', label: n.name, v: n.own, lvl, id: n.id }); return; }
      rows.push({ kind: 'head', label: n.name, lvl, id: n.id });
      kids.forEach(k => emit(k, lvl + 1));
      if (Math.abs(n.own) >= 0.005) rows.push({ kind: 'acct', label: n.name + ' - Other', v: n.own, lvl: lvl + 1, id: n.id });
      rows.push({ kind: 'total', label: 'Total ' + n.name, v: sum(n), lvl });
    };
    const block = (title, list, totalLabel, lvl) => { const t = tree(list); rows.push({ kind: 'head', label: title, lvl }); sorted(t).filter(k => Math.abs(sum(k)) >= 0.005).forEach(k => emit(k, lvl + 1)); const v = list.reduce((s, x) => s + x.v, 0); rows.push({ kind: 'total', label: totalLabel, v, lvl }); return v; };
    rows.push({ kind: 'head', label: 'Ordinary Income/Expense', lvl: 0 });
    const ti = block('Income', sec.inc, 'Total Income', 1);
    const tc = sec.cogs.length ? block('Cost of Goods Sold', sec.cogs, 'Total COGS', 1) : 0;
    rows.push({ kind: 'total', label: 'Gross Profit', v: ti - tc, lvl: 1, plain: true });
    const te = block('Expense', sec.exp, 'Total Expense', 1);
    const noi = ti - tc - te;
    rows.push({ kind: 'total', label: 'Net Ordinary Income', v: noi, lvl: 0 });
    let noth = 0;
    if (sec.otherinc.length || sec.otherexp.length) {
      rows.push({ kind: 'head', label: 'Other Income/Expense', lvl: 0 });
      const toi = sec.otherinc.length ? block('Other Income', sec.otherinc, 'Total Other Income', 1) : 0;
      const toe = sec.otherexp.length ? block('Other Expense', sec.otherexp, 'Total Other Expense', 1) : 0;
      noth = toi - toe; rows.push({ kind: 'total', label: 'Net Other Income', v: noth, lvl: 0 });
    }
    rows.push({ kind: 'grand', label: 'Net Income', v: noi + noth, lvl: 0 });
    return { rows, ti, tc, te, net: r2(noi + noth) };
  }
  let lastReportXLSX = null;
  function plReport(from, to, label) {
    const p = plRows(from, to), dt = qbDates(from, to);
    lastReportCSV = [[S.company], ['Profit & Loss'], [dt.long], ['', dt.short]].concat(p.rows.map(r => ['    '.repeat(r.lvl) + r.label, r.v == null ? '' : r.v.toFixed(2)]));
    lastReportXLSX = { name: S.company + ' Profit & Loss ' + dt.short.replace(/,/g, ''), sheet: 'Profit & Loss', cols: [52, 18], grid: false, merges: ['A1:B1', 'A2:B2', 'A3:B3'],
      rows: [[{ v: S.company, s: 'title' }], [{ v: 'Profit & Loss', s: 'title' }], [{ v: dt.long, s: 'subtitle' }], [], [null, { v: dt.short, s: 'colHead' }]].concat(p.rows.map(r => {
        const bold = r.kind !== 'acct';
        const ls = r.lvl === 0 ? (bold ? 'bold' : '') : (bold ? 'bold' + Math.min(3, r.lvl) : 'indent' + Math.min(4, r.lvl));
        return [{ v: r.label, s: ls }, r.v == null ? null : { v: r2(r.v), s: r.kind === 'grand' ? 'moneyGrand' : r.kind === 'total' && !r.plain ? 'moneyTotal' : bold ? 'moneyBold' : 'money' }];
      })) };
    const row = r => `<tr class="pl-${r.kind}${r.plain ? ' pl-plain' : ''}"><td style="padding-left:${10 + r.lvl * 18}px">${r.kind === 'acct' && r.id ? `<button class="link" style="color:inherit;text-decoration:none;text-align:left;font:inherit" data-act="drill" data-acct="${r.id}">${esc(r.label)}</button>` : esc(r.label)}</td><td class="num">${r.v == null ? '' : `<span>${money(r.v).replace('$', '')}</span>`}</td></tr>`;
    return `<div class="panel report qb-report"><div style="text-align:center"><div style="font-size:18px;font-weight:700">${esc(S.company)}</div><div style="font-size:17px;font-weight:700">Profit &amp; Loss</div><div style="font-weight:600">${esc(dt.long)}</div></div>
      <table class="qb-table"><thead><tr><th></th><th class="num">${esc(dt.short)}</th></tr></thead><tbody>${p.rows.map(row).join('')}</tbody></table>
      <p class="small muted" style="margin:10px 0 0">Click an account to see its transactions. Sub-accounts come from names like HOTEL SUPPLY:LAUNDRY SUPPLY. To move an account to Cost of Goods Sold or Other Income/Expense, use Chart of Accounts › Rename.</p></div>`;
  }
  function bsReport(asOf) {
    const d = C.debits(live(), { to: asOf });
    const line = type => sortAccs(S.accounts.filter(a => a.type === type)).map(a => ({ a, v: C.natural(a, d[a.id]) })).filter(x => Math.abs(x.v) >= 0.005);
    const as = line('asset'), li = line('liability'), eq = line('equity');
    let ni = 0; S.accounts.forEach(a => { if (a.type === 'income') ni += C.natural(a, d[a.id]); if (a.type === 'expense') ni -= C.natural(a, d[a.id]); });
    const ta = as.reduce((s, x) => s + x.v, 0), tl = li.reduce((s, x) => s + x.v, 0), te = eq.reduce((s, x) => s + x.v, 0) + ni;
    lastReportCSV = [['Balance Sheet', 'As of ' + usDate(asOf)], [], ['Assets']].concat(as.map(x => [x.a.name, x.v.toFixed(2)]), [['Total Assets', ta.toFixed(2)], [], ['Liabilities']], li.map(x => [x.a.name, x.v.toFixed(2)]), [['Total Liabilities', tl.toFixed(2)], [], ['Equity']], eq.map(x => [x.a.name, x.v.toFixed(2)]), [['Net Income (retained)', ni.toFixed(2)], ['Total Equity', te.toFixed(2)], ['Total Liabilities and Equity', (tl + te).toFixed(2)]]);
    const ln = x => `<div class="line"><span class="name">${esc(x.a.name)}</span><span class="num">${money(x.v)}</span></div>`;
    return `<div class="panel report"><h2 style="text-align:center;margin-bottom:0">${esc(S.company)}</h2><div style="text-align:center" class="muted small">Balance Sheet · as of ${usDate(asOf > '9000' ? today() : asOf)}</div>
      <h3>Assets</h3>${as.map(ln).join('') || '<div class="line muted">None</div>'}<div class="line grand"><span>Total Assets</span><span class="num">${money(ta)}</span></div>
      <h3>Liabilities</h3>${li.map(ln).join('') || '<div class="line muted">None</div>'}<div class="line total"><span>Total Liabilities</span><span class="num">${money(tl)}</span></div>
      <h3>Equity</h3>${eq.map(ln).join('')}<div class="line"><span class="name">Net Income (retained earnings)</span><span class="num">${money(ni)}</span></div><div class="line total"><span>Total Equity</span><span class="num">${money(te)}</span></div>
      <div class="line grand"><span>Total Liabilities and Equity</span><span class="num">${money(tl + te)}</span></div>
      ${Math.abs(ta - tl - te) > 0.009 ? '<div class="notice">Out of balance by ' + money(ta - tl - te) + '.</div>' : ''}</div>`;
  }
  function spendReport(from, to, label) {
    const p = plData(from, to);
    const list = p.exp.filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    const max = list.length ? list[0].v : 1, tot = list.reduce((s, x) => s + x.v, 0);
    lastReportCSV = [['Spending by Category', label], ['Category', 'Amount', 'Share']].concat(list.map(x => [x.a.name, x.v.toFixed(2), (x.v / tot * 100).toFixed(1) + '%']));
    return `<div class="panel" style="max-width:760px"><h2>Spending by category · ${esc(label)}</h2><p class="muted small" style="margin-top:-6px">Total ${money(tot)}</p>
      ${list.map(x => `<div class="hbar"><button class="link" style="color:inherit;text-decoration:none;text-align:left" data-act="drill" data-acct="${x.a.id}">${esc(x.a.name)}</button><span class="num">${money(x.v)} <span class="muted small">${(x.v / tot * 100).toFixed(0)}%</span></span><div class="track"><div class="fill" style="width:${(x.v / max * 100).toFixed(1)}%"></div></div></div>`).join('') || '<p class="muted">No spending in this period.</p>'}</div>`;
  }
  function detailReport(from, to, label) {
    const st = viewState.reports;
    if (!acc(st.detailAcct)) st.detailAcct = (S.accounts.find(a => a.type === 'expense') || S.accounts[0]).id;
    const a = acc(st.detailAcct);
    const rows = live().filter(t => (t.accountId === a.id || t.categoryId === a.id) && (!from || t.date >= from) && (!to || t.date <= to)).sort((x, y) => x.date.localeCompare(y.date));
    let run = 0;
    const lines = rows.map(t => { const deb = t.accountId === a.id ? t.amount : -t.amount; const v = C.natural(a, deb); run += v; return { t, v, run: r2(run), other: acc(t.accountId === a.id ? t.categoryId : t.accountId) }; });
    lastReportCSV = [['Account Detail', a.name, label], ['Date', 'Payee', 'Memo', 'Split', 'Amount', 'Running total']].concat(lines.map(l => [l.t.date, l.t.payee, l.t.memo || '', (l.other || {}).name || '', l.v.toFixed(2), l.run.toFixed(2)]));
    return `<div class="toolbar"><label class="small muted" style="display:flex;gap:6px;align-items:center">Account <select id="rAcct" data-change="rAcct">${['expense', 'income', 'liability', 'asset', 'equity'].map(ty => `<optgroup label="${TYPE_LABEL[ty]}">${sortAccs(S.accounts.filter(x => x.type === ty)).map(x => `<option value="${x.id}"${x.id === a.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}</select></label></div>
      <div class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Date</th><th>Payee</th><th>Split</th><th class="num">Amount</th><th class="num">Running total</th></tr></thead><tbody>
      ${lines.map(l => `<tr><td class="num small">${usDate(l.t.date)}</td><td>${esc(l.t.payee)}${l.t.memo ? `<div class="memo">${esc(l.t.memo)}</div>` : ''}</td><td class="small">${esc((l.other || {}).name || '')}</td><td class="num ${l.v < 0 ? 'neg' : ''}">${money(l.v)}</td><td class="num">${money(l.run)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No activity in this period.</td></tr>'}
      </tbody>${lines.length ? `<tfoot><tr><td colspan="3"><b>Total ${esc(a.name)}</b></td><td class="num"><b>${money(run)}</b></td><td></td></tr></tfoot>` : ''}</table></div></div>`;
  }

  // ======================= SETTINGS =======================
  views.settings = () => `<div class="page-head"><div><h1>Company &amp; Backup</h1><p class="sub">${CO ? 'Each company has its own books ' + WHERE + '. Pick or add a company at the top left. ' : 'Your books live on this PC only. '}Save a backup file regularly and keep a copy somewhere safe, like OneDrive or a USB drive.</p></div></div>
    <div class="grid two">
      <div class="panel"><h2>Company</h2><div class="grid" style="gap:12px">
        <label class="field">Company name<input type="text" id="sCo" value="${esc(S.company)}"></label>
        <label class="field">Appearance<select id="sTheme" data-change="sTheme"><option value="system"${S.theme === 'system' ? ' selected' : ''}>Match Windows</option><option value="light"${S.theme === 'light' ? ' selected' : ''}>Light</option><option value="dark"${S.theme === 'dark' ? ' selected' : ''}>Dark</option></select></label>
        <label class="small" style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" class="check" id="sSmart" data-change="sSmart"${S.smartCats !== false ? ' checked' : ''}> Categorize known merchants automatically (${M.size} businesses built in)</label>
        <div><button class="btn primary" data-act="saveCo">Save</button></div></div></div>
      <div class="panel"><h2>Backup &amp; restore</h2>
        <p class="muted small" style="margin-top:0">${S.txns.length} transactions · ${S.accounts.length} accounts · ${S.rules.length} rules</p>
        ${FILE ? `<p class="small" style="margin-top:0">Saved automatically to <code style="font-family:var(--f-num);font-size:12px;word-break:break-all">${esc(FILE.path())}</code>${SERVER ? '' : ' <button class="link" data-act="revealBooks">Open folder</button>'}</p>` : ''}
        <div class="toolbar"><button class="btn primary" data-act="backup">Save backup file…</button>
          <label class="btn" for="restoreIn">Restore from backup…</label><input type="file" id="restoreIn" accept=".json,.ldbackup" hidden></div>
        <div class="toolbar"><button class="btn" data-act="exportAll">Export all transactions (CSV)</button></div>
        <div class="toolbar"><button class="btn" data-act="goto" data-v="qb">Restore from QuickBooks…</button></div>
        <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
        <h2>Start over</h2><p class="muted small" style="margin-top:0">Erases every account, transaction and rule${CO ? ' in ' + esc(S.company) + '. Other companies are not touched.' : ' on this PC.'}</p>
        <button class="btn danger" data-act="wipe">Erase all data…</button></div>
    </div>`;
  afterRender.settings = () => {
    $('#restoreIn').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.txns)) throw new Error('bad');
        if (!(await confirmBox('Replace your books with this backup?', (data.company && data.company !== S.company ? 'Careful: this backup is for ' + data.company + ', but you are in ' + S.company + '. ' : '') + 'Everything in ' + S.company + ' will be replaced by ' + f.name + ' (' + data.txns.length + ' transactions).', 'Restore'))) return;
        const keepName = S.company; S = data; S.company = keepName; migrate(); save(); render(); toast('Backup restored');
      } catch (err) { toast('That file is not a Ledger Desk backup.'); }
    });
  };

  // ---------------- sample data ----------------
  function loadSample() {
    const card = { id: uid(), name: 'Sample Visa •4821', type: 'liability', detail: 'credit', sys: '', sample: true };
    S.accounts.push(card);
    const byName = n => S.accounts.find(a => a.name === n).id;
    const sampleRules = [['ADOBE', 'Software & Subscriptions', 'Adobe'], ['GOOGLE', 'Software & Subscriptions', 'Google Workspace'], ['SHELL', 'Auto & Fuel', 'Shell'], ['UBER', 'Travel', 'Uber'], ['USPS', 'Shipping & Postage', 'USPS'], ['VERIZON', 'Phone & Internet', 'Verizon']];
    sampleRules.forEach(([m, c, r]) => S.rules.push({ id: uid(), match: m, sign: 'out', categoryId: byName(c), rename: r, sample: true }));
    const pool = [['ADOBE *CREATIVE CLD', 59.99, 3], ['GOOGLE *GSUITE', 14.40, 1], ['SHELL OIL 57442', 48.2, 6], ['SHELL OIL 57442', 52.75, 19], ['UBER *TRIP', 23.18, 11], ['USPS PO 1734520', 18.6, 8], ['VERIZON WRLS', 87.3, 15], ['STAPLES 00123', 64.12, 9], ['PANERA BREAD #601', 21.44, 12], ['AMAZON MKTPL*2K4', 112.9, 17], ['FACEBK *ADS', 150, 22], ['DELTA AIR 0062', 342.5, 24], ['STARBUCKS #2210', 9.85, 5], ['ANNUAL MEMBERSHIP FEE', 95, 2]];
    const d = new Date(), seq = Date.now();
    let k = 0; const memo = memorized();
    for (let mo = 2; mo >= 0; mo--) {
      pool.forEach(([payee, amt, day], i) => {
        if (payee === 'ANNUAL MEMBERSHIP FEE' && mo !== 2) return;
        if (payee.startsWith('DELTA') && mo === 1) return;
        const dt = new Date(d.getFullYear(), d.getMonth() - mo, day);
        if (dt > d) return;
        const t = { id: uid(), seq: seq + k++, date: iso(dt), payee, memo: '', amount: -r2(amt * (1 + ((i + mo) % 3) * 0.07)), accountId: card.id, categoryId: '', source: 'sample', sample: true };
        autoCategorize(t, memo);
        if (/STAPLES/.test(payee)) t.categoryId = byName('Office Supplies');
        if (/PANERA|STARBUCKS/.test(payee) && mo === 2) t.categoryId = byName('Dining & Meals');
        if (/FACEBK/.test(payee) && mo > 0) t.categoryId = byName('Advertising & Marketing');
        if (/MEMBERSHIP/.test(payee)) t.categoryId = byName('Bank & Card Fees');
        S.txns.push(t);
      });
      const pd = new Date(d.getFullYear(), d.getMonth() - mo, 26);
      if (pd <= d) S.txns.push({ id: uid(), seq: seq + k++, date: iso(pd), payee: 'PAYMENT THANK YOU', memo: '', amount: 900, accountId: card.id, categoryId: byName('Business Checking'), source: 'sample', sample: true });
      const sd = new Date(d.getFullYear(), d.getMonth() - mo, 4);
      if (sd <= d) {
        S.txns.push({ id: uid(), seq: seq + k++, date: iso(sd), payee: 'MOBILE DEPOSIT', memo: '', amount: 2400, accountId: byName('Business Checking'), categoryId: depAcc().id, source: 'sample', sample: true });
        S.txns.push({ id: uid(), seq: seq + k++, date: iso(sd), payee: 'Rivera Design', memo: 'Invoice payment', amount: 2400, accountId: depAcc().id, categoryId: byName('Sales'), source: 'income', sample: true });
      }
    }
    const ob = new Date(d.getFullYear(), d.getMonth() - 2, 1);
    S.txns.push({ id: uid(), seq: 0, date: iso(ob), payee: 'Opening balance', memo: '', amount: 3500, accountId: byName('Business Checking'), categoryId: sysAcc('obe').id, source: 'sample', sample: true });
    save(); render(); toast('Sample data loaded');
  }
  function clearSample() {
    const ids = new Set(S.accounts.filter(a => a.sample).map(a => a.id));
    S.txns = S.txns.filter(t => !t.sample && !ids.has(t.accountId));
    S.rules = S.rules.filter(r => !r.sample);
    S.accounts = S.accounts.filter(a => !a.sample);
    save(); render(); toast('Sample data removed');
  }

  // ======================= event wiring =======================
  const acts = {
    goto: b => go(b.dataset.v),
    newTxn: () => txnModal(null),
    loadSample, clearSample,
    reviewUncat: () => { Object.assign(viewState.register, { uncat: true, acct: 'all', q: '', range: 'all', from: '', to: '' }); go('register'); },
    edit: b => txnModal(S.txns.find(t => t.id === b.closest('tr').dataset.id)),
    mkRule: b => { const t = S.txns.find(x => x.id === b.closest('tr').dataset.id); ruleModal({ match: suggestMatch(t.payee), categoryId: isUncat(t) ? '' : t.categoryId, sign: t.amount < 0 ? 'out' : 'in' }); },
    sel: b => { const id = b.closest('tr').dataset.id, s = viewState.register.sel; b.checked ? s.add(id) : s.delete(id); render(); },
    selAll: b => { const s = viewState.register.sel; const rows = registerRows().reverse().slice(0, viewState.register.limit); if (b.checked) rows.forEach(t => s.add(t.id)); else s.clear(); render(); },
    clearSel: () => { viewState.register.sel.clear(); render(); },
    bulkCat: () => {
      const c = $('#bulkCat').value; let n = 0;
      let skipped = 0;
      S.txns.forEach(t => { if (!viewState.register.sel.has(t.id) || t.source === 'income') return; if (allowedCat(t, c)) { t.categoryId = c; delete t.why; n++; } else skipped++; });
      viewState.register.sel.clear(); save(); render(); toast(n + ' transaction' + (n === 1 ? '' : 's') + ' categorized' + (skipped ? ' · ' + skipped + ' bank deposit' + (skipped === 1 ? '' : 's') + ' skipped (deposits can\'t be income)' : ''));
    },
    bulkDel: () => { const ids = Array.from(viewState.register.sel); deleteTxns(ids); },
    bulkIgnore: () => { const ids = Array.from(viewState.register.sel); viewState.register.sel.clear(); ignoreTxns(ids, true); },
    bulkRestore: () => { const ids = Array.from(viewState.register.sel); viewState.register.sel.clear(); ignoreTxns(ids, false); },
    delOne: b => deleteTxns([b.closest('tr').dataset.id]),
    ignoreOne: b => ignoreTxns([b.closest('tr').dataset.id], true),
    restoreOne: b => ignoreTxns([b.closest('tr').dataset.id], false),
    newIncome: () => incomeModal(null),
    revealBooks: () => FILE && FILE.reveal(),
    unmatchOne: b => unmatch(b.closest('tr').dataset.id),
    autoAll: () => {
      const m = matchTransfers(), n = smartCategorizeExisting();
      save(); render();
      const left = live().filter(isUncat).length;
      toast((n || m) ? [n ? n + ' categorized' : '', m ? m + ' transfer' + (m === 1 ? '' : 's') + ' matched' : ''].filter(Boolean).join(' · ') + (left ? ' · ' + left + ' still need you' : '') : 'Nothing new to categorize. ' + left + ' still need a category.');
    },
    openClearing: () => { Object.assign(viewState.register, { acct: depAcc().id, uncat: false, q: '', range: 'all', from: '', to: '' }); go('register'); },
    more: () => { viewState.register.limit += 500; render(); },
    exportRegister: () => {
      const rows = registerRows();
      downloadFile('transactions-' + today() + '.csv', toCSV([['Date', 'Account', 'Payee', 'Memo', 'Category', 'Amount']].concat(rows.map(t => [t.date, (acc(t.accountId) || {}).name, t.payee, t.memo || '', (acc(t.categoryId) || {}).name, t.amount.toFixed(2)]))), 'text/csv');
    },
    doImport: b => {
      const s = viewState.import.pending.find(x => x.key === b.closest('.stmt').dataset.key);
      if (s.otherCo) return;
      const box = b.closest('.stmt'), bal = box.querySelector('[data-input=impBal]');
      if (bal) s.balInput = parseFloat(bal.value);
      const { n, auto, target, matched } = doImport(s);
      viewState.import.pending = viewState.import.pending.filter(x => x !== s);
      if (!viewState.import.pending.length) viewState.import.pending = null;
      toast('Imported ' + n + ' into ' + target.name + (auto ? ' · ' + auto + ' categorized automatically' : '') + (matched ? ' · ' + matched + ' transfer' + (matched === 1 ? '' : 's') + ' matched' : ''));
      if (!viewState.import.pending) { Object.assign(viewState.register, { acct: target.id, uncat: false, q: '', range: 'all', from: '', to: '' }); go('register'); }
      else render();
    },
    cancelImport: () => { viewState.import.pending = null; render(); },
    newAcct: () => acctModal(null),
    renameAcct: b => acctModal(acc(b.closest('tr').dataset.acct)),
    openAcct: b => { Object.assign(viewState.register, { acct: b.closest('tr').dataset.acct, uncat: false, q: '', range: 'all', from: '', to: '', limit: 300 }); viewState.register.sel = new Set(); go('register'); },
    openReg: b => { Object.assign(viewState.register, { acct: b.closest('tr').dataset.acct, uncat: false, q: '' }); go('register'); },
    openDetail: b => { Object.assign(viewState.reports, { tab: 'detail', detailAcct: b.closest('tr').dataset.acct }); go('reports'); },
    delAcct: async b => {
      const a = acc(b.closest('tr').dataset.acct);
      const n = S.txns.filter(t => t.accountId === a.id || t.categoryId === a.id).length;
      if (n && a.type !== 'income' && a.type !== 'expense') { toast(a.name + ' has ' + n + ' transactions. Delete them from its register first.'); return; }
      const msg = n ? n + ' transaction' + (n === 1 ? '' : 's') + ' in this category will move to Uncategorized.' : 'This account has no transactions.';
      if (!(await confirmBox('Delete ' + a.name + '?', msg, 'Delete', true))) return;
      S.txns.forEach(t => { if (t.categoryId === a.id) t.categoryId = defaultCat(t); });
      S.rules = S.rules.filter(r => r.categoryId !== a.id);
      S.accounts = S.accounts.filter(x => x.id !== a.id); save(); render(); toast('Account deleted');
    },
    newRule: () => ruleModal({}),
    editRule: b => ruleModal(Object.assign({}, S.rules.find(r => r.id === b.closest('tr').dataset.rule))),
    delRule: b => { S.rules = S.rules.filter(r => r.id !== b.closest('tr').dataset.rule); save(); render(); toast('Rule deleted'); },
    ruleUp: b => { const i = S.rules.findIndex(r => r.id === b.closest('tr').dataset.rule); if (i > 0) { [S.rules[i - 1], S.rules[i]] = [S.rules[i], S.rules[i - 1]]; save(); render(); } },
    runRules: () => { const n = applyRulesToUncat(); save(); render(); toast(n ? n + ' transaction' + (n === 1 ? '' : 's') + ' categorized' : 'No uncategorized transactions matched a rule'); },
    rTab: b => { viewState.reports.tab = b.dataset.tab; render(); },
    drill: b => { Object.assign(viewState.reports, { tab: 'detail', detailAcct: b.dataset.acct }); render(); },
    exportXlsx: () => {
      if (!window.LedgerXLSX) { toast('Excel download is not available'); return; }
      const st = viewState.reports;
      if (st.tab === 'pl' && lastReportXLSX) { window.LedgerXLSX.download(lastReportXLSX.name, lastReportXLSX); return; }
      const rows = lastReportCSV.map((r, i) => r.map(c => { const n = typeof c === 'string' && /^-?\d+(\.\d+)?$/.test(c) ? Number(c) : c; return typeof n === 'number' ? { v: n, s: 'money' } : { v: c, s: i < 1 ? 'bold' : /^total|^net /i.test(String(r[0])) ? 'bold' : '' }; }));
      window.LedgerXLSX.download(S.company + ' ' + ({ bs: 'Balance Sheet', spend: 'Spending by Category', detail: 'Account Detail' }[st.tab] || 'Report') + ' ' + today(), { sheet: 'Report', cols: [40, 18, 18, 18, 16, 16], rows });
    },
    exportReport: () => downloadFile('report-' + viewState.reports.tab + '-' + today() + '.csv', toCSV(lastReportCSV), 'text/csv'),
    saveCo: () => { S.company = $('#sCo').value.trim() || 'My Company'; save(); render(); fillCompanies(); toast('Saved'); },
    backup: () => downloadFile('LedgerDesk-backup-' + String(S.company || 'books').replace(/[\\/:*?"<>|]/g, '').trim() + '-' + today() + '.json', JSON.stringify(S, null, 1), 'application/json'),
    wipe: async () => { if (await confirmBox('Erase all data for ' + S.company + '?', 'This removes every account, transaction and rule in ' + S.company + '. Save a backup first if you might need it.', 'Erase everything', true)) { const keepName = S.company; S = freshBooks(); S.company = keepName; migrate(); save(); go('dashboard'); toast('All data erased'); } }
  };
  // ======================= RESTORE FROM QUICKBOOKS =======================
  // QuickBooks backup files (.QBB/.QBW) only open in QuickBooks, so the restore reads what QuickBooks exports:
  // the Chart of Accounts list and the Journal report (Excel, CSV or IIF).
  const QB = window.LedgerQB;
  viewState.qb = { parts: [], names: [], company: '', skipOpening: false, busy: false };
  function qbBuild() {
    const st = viewState.qb;
    return QB.build(st.parts, { uid, today: today(), company: st.company, theme: S.theme, skipOpening: st.skipOpening });
  }
  views.qb = () => {
    const st = viewState.qb;
    const hasAcc = st.parts.some(p => p.kind === 'accounts'), hasJ = st.parts.some(p => p.kind === 'journal');
    let preview = '';
    if (st.parts.length) {
      const { books, report } = qbBuild();
      const counts = {}; books.accounts.forEach(a => { counts[a.type] = (counts[a.type] || 0) + 1; });
      const cmp = report.compare.filter(c => c.account.type === 'asset' || c.account.type === 'liability');
      preview = `<div class="panel" style="margin-top:16px"><h2>Check before restoring</h2>
        <label class="field" style="max-width:420px">Company name<input type="text" id="qbCo" data-input="qbCo" value="${esc(books.company)}" maxlength="80"></label>
        <div class="grid kpis" style="margin-top:14px">
          <div class="panel kpi"><div class="lbl">Accounts</div><div class="val">${books.accounts.length}</div><div class="small muted">${['asset', 'liability', 'equity', 'income', 'expense'].map(k => counts[k] ? counts[k] + ' ' + TYPE_LABEL[k].toLowerCase() : '').filter(Boolean).join(' · ')}</div></div>
          <div class="panel kpi"><div class="lbl">Transactions</div><div class="val">${report.txns - report.adjustments.length}</div><div class="small muted">${report.from ? usDate(report.from) + ' – ' + usDate(report.to) : 'no Journal yet'}</div></div>
          <div class="panel kpi${report.unbalanced.length ? ' attn' : ''}"><div class="lbl">Skipped (didn't balance)</div><div class="val">${report.unbalanced.length}</div></div>
        </div>
        ${!hasJ ? '<div class="notice">No Journal report yet. Without it, only the accounts and their current balances are restored, with no transaction history.</div>' : ''}
        ${!hasAcc ? '<div class="notice">No Chart of Accounts list yet. Account types will be guessed from their names, and balances can\'t be checked against QuickBooks.</div>' : ''}
        ${report.guessed.length ? `<div class="notice">${report.guessed.length} account${report.guessed.length === 1 ? ' is' : 's are'} in the Journal but not in the Chart of Accounts, so the type was guessed: ${report.guessed.slice(0, 12).map(a => '<b>' + esc(a.name) + '</b> (' + TYPE_LABEL[a.type] + ')').join(', ')}${report.guessed.length > 12 ? '…' : ''}. You can fix them later in Chart of Accounts.</div>` : ''}
        ${report.unbalanced.length ? `<div class="notice">These QuickBooks entries didn't add up (debits ≠ credits) and will be skipped: ${report.unbalanced.slice(0, 8).map(g => esc((g.date ? usDate(g.date) + ' ' : '') + (g.type || '') + (g.num ? ' #' + g.num : '') + ' ' + money(g.off))).join(' · ')}${report.unbalanced.length > 8 ? '…' : ''}</div>` : ''}
        ${cmp.length ? `<h3 style="margin-top:16px">Bank, card and loan balances</h3>
        <div class="table-wrap"><table><thead><tr><th>Account</th><th class="num">QuickBooks</th><th class="num">From the Journal</th><th class="num">Starting balance added</th></tr></thead><tbody>
        ${cmp.map(c => `<tr><td>${esc(c.account.name)}</td><td class="num">${money(c.qb)}</td><td class="num">${money(c.restored)}</td><td class="num">${Math.abs(c.diff) < 0.005 ? '<span class="pos">matches</span>' : st.skipOpening ? '<span class="neg">' + money(c.diff) + ' off</span>' : money(c.diff)}</td></tr>`).join('')}
        </tbody></table></div>
        ${report.adjustments.length || (st.skipOpening && cmp.some(c => Math.abs(c.diff) >= 0.005)) ? `<label class="small" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" class="check" data-change="qbOpen"${st.skipOpening ? '' : ' checked'}> Add starting balances so every balance matches QuickBooks (dated ${usDate(report.adjustments[0] ? report.adjustments[0].date : report.from)}). Needed when the Journal doesn't cover all dates.</label>` : ''}` : ''}
        <div class="toolbar" style="margin-top:16px;margin-bottom:0"><button class="btn primary" data-act="qbRestore">${CO ? 'Create this company' : 'Replace my books with this'}</button><button class="btn" data-act="qbClear">Start over</button></div>
      </div>`;
    }
    return `<div class="page-head"><div><h1>Restore from QuickBooks</h1><p class="sub">Bring a company over from QuickBooks Desktop or QuickBooks Online.${CO ? ' It becomes a new company here; your other companies are not touched.' : ''}</p></div></div>
    <div class="notice">QuickBooks backup files (<b>.QBB</b>, <b>.QBW</b>) can only be opened by QuickBooks. Export these two reports from QuickBooks instead. Together they hold every account and every transaction.</div>
    <div class="grid two">
      <div class="panel"><h2>QuickBooks Desktop</h2><ol class="steps">
        <li><b>Chart of Accounts:</b> Reports › List › <b>Account Listing</b>. Click <b>Excel › Create New Worksheet</b>, choose <b>Create new workbook</b> (or a .csv file) and save.</li>
        <li><b>Journal:</b> Reports › Accountant &amp; Taxes › <b>Journal</b>. Set Dates to <b>All</b>. Click <b>Excel › Create New Worksheet</b> and save.</li></ol></div>
      <div class="panel"><h2>QuickBooks Online</h2><ol class="steps">
        <li><b>Chart of Accounts:</b> Reports › search <b>Account List</b> › open it › Export icon › <b>Export to Excel</b>.</li>
        <li><b>Journal:</b> Reports › search <b>Journal</b> › Report period <b>All Dates</b> › Run report › Export icon › <b>Export to Excel</b>.</li></ol></div>
    </div>
    <div class="drop" id="qbDrop" style="margin-top:16px"><strong>Drop both files here</strong><span class="muted">Excel (.xlsx), CSV or IIF</span>
      <div style="margin-top:10px"><label class="btn primary" for="qbIn" style="display:inline-block">Choose files…</label><input type="file" id="qbIn" accept=".xlsx,.csv,.iif,.txt,.xls,.qbb,.qbw" multiple hidden></div>
      ${st.names.length ? `<p class="small" style="margin-top:12px">Loaded: ${st.names.map(n => '<b>' + esc(n.file) + '</b> (' + esc(n.what) + ')').join(' · ')}</p>` : '<p class="small muted" style="margin-top:12px">Nothing is changed until you click the restore button.</p>'}</div>
    ${preview}`;
  };
  afterRender.qb = () => {
    const drop = $('#qbDrop'), inp = $('#qbIn');
    if (inp) inp.addEventListener('change', () => qbRead(inp.files));
    if (drop) {
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => { e.stopPropagation(); qbRead(e.dataTransfer.files); });
    }
  };
  async function qbRead(files) {
    const st = viewState.qb, errors = [];
    for (const f of Array.from(files)) {
      try {
        const parts = await QB.readExport(f.name, await f.arrayBuffer());
        parts.forEach(p => {
          // a newer file of the same kind replaces the older one
          st.parts = st.parts.filter(x => x.kind !== p.kind); st.names = st.names.filter(x => x.kind !== p.kind);
          st.parts.push(p);
          st.names.push({ kind: p.kind, file: f.name, what: p.kind === 'accounts' ? 'Chart of Accounts, ' + p.accounts.length + ' accounts' : 'Journal, ' + p.groups.length + ' transactions' });
        });
      } catch (e) { errors.push(f.name + ': ' + e.message); }
    }
    if (errors.length) toast(errors.join(' · '));
    render();
  }
  acts.qbClear = () => { Object.assign(viewState.qb, { parts: [], names: [], company: '', skipOpening: false }); render(); };
  acts.qbRestore = async () => {
    const st = viewState.qb;
    const co = $('#qbCo'); if (co) st.company = co.value.trim();
    const { books, report } = qbBuild();
    if (!books.company.trim()) { toast('Type the company name'); return; }
    if (CO) {
      if (CO.list().list.some(c => c.name.toLowerCase() === books.company.toLowerCase())) { toast(books.company + ' already exists here. Change the company name above.'); return; }
      const file = CO.create(books.company, JSON.stringify(books, null, 1));
      if (!file) { toast('Could not create the company file'); return; }
      save(); CO.switchTo(file);
      return;
    }
    if (!(await confirmBox('Replace your books?', 'Everything in ' + S.company + ' will be replaced by ' + books.company + ' from QuickBooks (' + report.accounts + ' accounts, ' + report.txns + ' entries). Save a backup first if you need it.', 'Restore'))) return;
    S = books; migrate(); save(); acts.qbClear(); go('dashboard'); toast('Restored ' + books.company + ' from QuickBooks');
  };

  acts.exportAll = () => downloadFile('all-transactions-' + today() + '.csv', toCSV([['Date', 'Account', 'Payee', 'Memo', 'Category', 'Amount']].concat(live().sort((a, b) => a.date.localeCompare(b.date)).map(t => [t.date, (acc(t.accountId) || {}).name, t.payee, t.memo || '', (acc(t.categoryId) || {}).name, t.amount.toFixed(2)]))), 'text/csv');

  main.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    if (b.tagName === 'INPUT' && b.type === 'checkbox') return; // handled on change
    const f = acts[b.dataset.act]; if (f) f(b, e);
  });
  // Chart of Accounts: double-click a row to see its transactions
  main.addEventListener('dblclick', e => {
    const tr = e.target.closest('tr.acct-row'); if (!tr || e.target.closest('button,select,input')) return;
    acts.openAcct(tr.querySelector('[data-act=openAcct]') || tr.firstElementChild);
  });
  main.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.act && el.type === 'checkbox') { acts[el.dataset.act](el); return; }
    const k = el.dataset.change; if (!k) return;
    const st = viewState.register, rp = viewState.reports;
    switch (k) {
      case 'fAcct': st.acct = el.value; st.sel.clear(); st.limit = 300; break;
      case 'fRange': st.range = el.value; if (el.value !== 'custom') { const r = ranges()[el.value]; st.from = r[1]; st.to = r[2]; } break;
      case 'fFrom': st.from = el.value; break;
      case 'fTo': st.to = el.value; break;
      case 'fUncat': st.uncat = el.checked; break;
      case 'fIgn': st.showIgn = el.checked; st.sel.clear(); break;
      case 'cat': {
        const t = S.txns.find(x => x.id === el.closest('tr').dataset.id);
        if (t.transferWith && el.value !== t.categoryId) { const h = S.txns.find(x => x.id === t.transferWith); if (h) { delete h.matchOf; h.ignored = false; } delete t.transferWith; }
        if (!allowedCat(t, el.value)) { toast('Money coming into a bank or card account isn\'t income. Record income with "Record income".'); render(); break; }
        delete t.why;
        t.categoryId = el.value; const c = acc(el.value);
        if (c.sys === 'uncatIn' || c.sys === 'uncatOut') t.categoryId = defaultCat(t);
        save();
        const np = C.normPayee(t.payee);
        const similar = c.sys ? [] : S.txns.filter(x => x !== t && !x.ignored && isUncat(x) && C.normPayee(x.payee) === np && allowedCat(x, c.id));
        if (similar.length) toast('Categorized as ' + c.name + '.', 'Also do ' + similar.length + ' more from ' + t.payee, () => { similar.forEach(x => { x.categoryId = c.id; delete x.why; }); save(); render(); toast(similar.length + ' more categorized'); });
        if (st.uncat) setTimeout(render, 250); else { el.classList.toggle('uncat', isUncat(t)); updateBadge(); }
        return;
      }
      case 'impTarget': { const s = viewState.import.pending.find(x => x.key === el.closest('.stmt').dataset.key); s.target = el.value; break; }
      case 'impOpen': { const s = viewState.import.pending.find(x => x.key === el.closest('.stmt').dataset.key); s.setOpening = el.checked; return; }
      case 'rRange': rp.range = el.value; if (el.value === 'custom' && !rp.from) { rp.from = firstDate(); rp.to = today(); } break;
      case 'rFrom': rp.from = el.value; break;
      case 'rTo': rp.to = el.value; break;
      case 'rAsOf': rp.range = 'custom'; rp.to = el.value; rp.from = rp.from || ''; break;
      case 'rAcct': rp.detailAcct = el.value; break;
      case 'qbOpen': viewState.qb.skipOpening = !el.checked; break;
      case 'sTheme': S.theme = el.value; save(); applyTheme(); return;
      case 'sSmart': S.smartCats = el.checked; save(); toast(el.checked ? 'Known merchants will be categorized automatically' : 'Automatic merchant categories turned off'); return;
      default: return;
    }
    render();
  });
  let qTimer;
  main.addEventListener('input', e => {
    const el = e.target, k = el.dataset.input; if (!k) return;
    if (k === 'fQ') { clearTimeout(qTimer); qTimer = setTimeout(() => { viewState.register.q = el.value; render(); const q = $('#fQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 200); }
    if (k === 'qbCo') viewState.qb.company = el.value;
    if (k === 'impName') viewState.import.pending.find(x => x.key === el.closest('.stmt').dataset.key).newName = el.value;
    if (k === 'impBal') viewState.import.pending.find(x => x.key === el.closest('.stmt').dataset.key).balInput = parseFloat(el.value);
  });

  // Keyboard: Ctrl+N new transaction, Ctrl+I import
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey || !$('#modal').hidden) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); txnModal(null); }
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); go('import'); }
  });

  // Electron menu hooks (no-ops in a browser)
  window.ledgerDesk = { go, newTxn: () => txnModal(null), newIncome: () => incomeModal(null), backup: acts.backup };

  // Reload when the books file is changed outside the app (a restored copy, a synced copy, or Claude updating it)
  let pendingExternal = null;
  function adoptExternal(text) {
    try {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.txns)) return false;
      BASE = text; S = data; migrate(); viewState.register.sel.clear(); pendingExternal = null;
      if (!$('#modal').hidden) closeModal();
      updateBadge(); render(); fillCompanies();
      return true;
    } catch (e) { return false; }
  }
  function applyExternal(text) {
    if (!$('#modal').hidden) { pendingExternal = text; return; }
    try {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.txns)) return;
      const before = S.txns.length;
      BASE = text; S = data; migrate(); viewState.register.sel.clear();
      updateBadge(); render();
      const diff = S.txns.length - before;
      toast('Books updated from file' + (diff > 0 ? ' · ' + diff + ' new transactions' : ''));
    } catch (e) {}
  }
  // For add-on screens (AI Assistant, server logins). They use these instead of reaching into the app.
  window.ledgerDeskApp = {
    get S() { return S; }, C, M, views, acts, afterRender, viewState, go, render, save, toast, modal, closeModal, confirmBox,
    acc, sysAcc, isUncat, live, allowedCat, defaultCat, isBankDeposit, catOptions, sortAccs, registers, memorized, suggestMatch,
    esc, money, usDate, uid, today, ranges, TYPE_LABEL, updateBadge, txnModal, doImport, matchTransfers, smartCategorizeExisting, applyRulesToUncat, get view() { return view; }
  };
  if (FILE) FILE.onExternalChange(applyExternal);
  setInterval(() => { if (pendingExternal && $('#modal').hidden) { const t = pendingExternal; pendingExternal = null; applyExternal(t); } }, 1000);

  migrate();
  if (S.pendingSmart) {
    delete S.pendingSmart;
    const m = matchTransfers(), n = smartCategorizeExisting();
    if (n || m) setTimeout(() => toast('Updated your books: ' + [n ? n + ' transactions categorized' : '', m ? m + ' card payment' + (m === 1 ? '' : 's') + ' matched to your bank' : ''].filter(Boolean).join(' · ') + '. Look for “Auto” under each category.'), 400);
  }
  save();
  render();
  if (CO) { fillCompanies(); $('#coSel').addEventListener('change', onCompanyPick); }
})();
