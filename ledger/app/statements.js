/* Ledger Desk: "Get statements". Open each bank, download the QuickBooks (.QBO) files, drop them all here.
   Ledger Desk works out which company each file belongs to (by account number), imports everything,
   matches card payments, applies the rules, and shows what still needs you. Free, no bank feed, no stored passwords. */
(function () {
  'use strict';
  const L = window.ledgerDeskApp, SV = window.ledgerServer;
  if (!L || !SV) return;
  const { C, views, acts, afterRender, esc, money, usDate, toast, modal, closeModal } = L;
  const $ = s => document.querySelector(s);
  const QKEY = 'ld-stmt-queue:' + SV.me.username;
  const ST = { accounts: null, loading: false, routed: null, note: '' };

  // ----- banks: where to sign in and how to download a .QBO -----
  const BANKS = [
    { id: 'citi', name: 'Citi', re: /\bciti\b|citibank|costco visa/i, url: 'https://online.citi.com', steps: 'Open the card › Time Period: "Year to date" (or since the date shown) › click the download icon › choose QuickBooks (.QBO) › Export.' },
    { id: 'chase', name: 'Chase', re: /chase|\bink\b/i, url: 'https://secure.chase.com', steps: 'Open the account › click the download icon (Download account activity) › Activity: pick the dates › File type: QuickBooks Web Connect (.QBO) › Download.' },
    { id: 'amex', name: 'American Express', re: /amex|american express/i, url: 'https://www.americanexpress.com/en-us/account/login', steps: 'Statements & Activity › pick the card in the selector at the top left › choose the dates (e.g. "Year To Date") › Download › QuickBooks (.QBO).' },
    { id: 'fieldmain', name: 'Field & Main Bank', re: /field\s*&?\s*(and)?\s*main/i, url: '', steps: 'Open the account › Download / Export › QuickBooks Web Connect (.QBO) › pick the dates › Download. Also save the PDF statement if you want check pictures read.' },
    { id: 'firstbank', name: 'First Bank', re: /first\s*bank/i, url: '', steps: 'Open the account › Download / Export › QuickBooks Web Connect (.QBO) › pick the dates › Download.' },
    { id: 'peoples', name: 'Peoples Bank', re: /people'?s/i, url: '', steps: 'Open the account › Download / Export › QuickBooks Web Connect (.QBO) › pick the dates › Download.' },
    { id: 'capone', name: 'Capital One', re: /capital\s*one/i, url: 'https://verified.capitalone.com/auth/signin', steps: 'Open the account › View transactions › Download transactions › QuickBooks (.QBO).' },
    { id: 'discover', name: 'Discover', re: /discover/i, url: 'https://portal.discover.com/customersvcs/universalLogin/ac_main', steps: 'Activity & Statements › Download › QuickBooks (.QBO).' },
    { id: 'wells', name: 'Wells Fargo', re: /wells\s*fargo/i, url: 'https://connect.secure.wellsfargo.com/auth/login/present', steps: 'Account Activity › Download Account Activity › QuickBooks (.QBO).' },
    { id: 'bofa', name: 'Bank of America', re: /bank of america|\bbofa\b/i, url: 'https://secure.bankofamerica.com/login/sign-in/signOnV2Screen.go', steps: 'Open the account › Download › QuickBooks Web Connect (.QBO).' }
  ];
  const OTHER = { id: 'other', name: 'Other banks and cards', url: '', steps: 'Sign in › open the account › look for Download or Export transactions › choose QuickBooks Web Connect (.QBO) or Quicken (.QFX) › pick the dates since the last date shown here.' };
  const bankFor = name => BANKS.find(b => b.re.test(name)) || OTHER;
  function links() { try { return JSON.parse(localStorage.getItem('ld-banklinks') || '{}'); } catch (e) { return {}; } }
  function setLink(id, url) { const l = links(); if (url) l[id] = url; else delete l[id]; try { localStorage.setItem('ld-banklinks', JSON.stringify(l)); } catch (e) {} }
  const siteFor = b => links()[b.id] || b.url || 'https://www.google.com/search?q=' + encodeURIComponent(b.name + ' online banking login');

  // ----- every bank/card account in every company I can work on, with its last date -----
  async function loadAccounts() {
    if (ST.loading) return; ST.loading = true;
    const out = [];
    for (const co of SV.companies().filter(c => c.role === 'owner' || c.role === 'edit')) {
      let d;
      try { d = co.file === SV.current().file ? L.S : JSON.parse(await SV.readCompany(co.file) || 'null'); } catch (e) { d = null; }
      if (!d || !Array.isArray(d.accounts)) continue;
      d.accounts.filter(a => (a.type === 'asset' || a.type === 'liability') && a.detail !== 'loan' && a.sys !== 'deposits' && !a.archived && !a.sample).forEach(a => {
        const ts = d.txns.filter(t => t.accountId === a.id && t.source !== 'opening');
        if (!ts.length && !a.ofxId) return;
        out.push({ company: d.company || co.plainName, file: co.file, name: a.name, ofxId: a.ofxId || '', last: ts.reduce((m, t) => t.date > m ? t.date : m, ''), bank: bankFor(a.name + ' ' + (a.ofxId || '')) });
      });
    }
    ST.accounts = out; ST.loading = false;
    if (L.view === 'statements') L.render();
  }

  // ----- queue across companies (kept in this browser tab only, compressed) -----
  async function gz(text) { const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')); const b = new Uint8Array(await new Response(s).arrayBuffer()); let x = ''; for (let i = 0; i < b.length; i += 0x8000) x += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(x); }
  async function ungz(b64) { const s = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip')); return new Response(s).text(); }
  const getQ = () => { try { return JSON.parse(sessionStorage.getItem(QKEY) || 'null'); } catch (e) { return null; } };
  const setQ = q => { try { if (q) sessionStorage.setItem(QKEY, JSON.stringify(q)); else sessionStorage.removeItem(QKEY); return true; } catch (e) { return false; } };

  async function readDropped(files) {
    const companies = SV.companies().filter(c => c.role === 'owner' || c.role === 'edit');
    const routed = [];
    for (const f of Array.from(files)) {
      let text, stmts;
      try { text = await f.text(); stmts = C.parseOFX(text); } catch (e) { routed.push({ fileName: f.name, error: e.message }); continue; }
      stmts.forEach((s, idx) => {
        const owner = companies.find(c => (c.ofxIds || []).includes(String(s.acctId))) || (ST.accounts || []).map(a => a.ofxId === String(s.acctId) ? companies.find(c => c.file === a.file) : null).find(Boolean);
        const dates = s.txns.map(t => t.date).sort();
        const last4 = (s.acctId || '').replace(/\D/g, '').slice(-4);
        routed.push({ fileName: f.name, text, idx, acctId: s.acctId, org: s.org, kind: s.kind, n: s.txns.length, from: dates[0] || '', to: dates[dates.length - 1] || '', company: owner ? owner.file : '', known: !!owner,
          newName: (s.org && s.org.length > 2 ? s.org.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 24) + ' ' : '') + (s.kind === 'credit' ? 'Credit Card' : 'Checking') + (last4 ? ' •' + last4 : '') });
      });
    }
    ST.routed = routed; L.render();
  }
  // For the AI Bookkeeper: bring in statement files. Imports straight away when every file's company is known.
  L.stmtFiles = async files => { if (!ST.accounts) await loadAccounts(); await readDropped(files); return ST.routed || []; };
  L.stmtCompanies = () => SV.companies().filter(c => c.role === 'owner' || c.role === 'edit');
  // Imports what L.stmtFiles found (after the chat filled in any missing companies). Resolves with the results when
  // everything was for this company; resolves with null when it had to move to another company (the page reloads).
  L.stmtImport = async () => {
    const ok = (ST.routed || []).filter(x => !x.error && x.n && x.company);
    if (!ok.length) return [];
    const other = ok.some(x => x.company !== SV.current().file);
    const done = new Promise(res => { ST.onDone = res; });
    await startImport();
    return other ? null : await done;
  };
  async function startImport() {
    const items = (ST.routed || []).filter(r => !r.error && r.company && r.n);
    if (!items.length) { toast('Pick a company for each statement first.'); return; }
    const q = { items: [], results: [], started: new Date().toISOString() };
    for (const r of items) q.items.push({ company: r.company, gz: await gz(r.text), idx: r.idx, acctId: r.acctId, newName: r.known ? '' : r.newName, fileName: r.fileName, done: false });
    if (!setQ(q)) { toast('Those files are too big to import in one go. Drop fewer at a time.'); return; }
    ST.routed = null;
    await processQueue();
  }
  // Imports this company's statements, then moves on to the next company (the page reloads when switching)
  async function processQueue() {
    const q = getQ(); if (!q) return;
    const cur = SV.current().file, mine = q.items.filter(i => !i.done && i.company === cur);
    if (mine.length) {
      SV.banner('Importing statements into ' + L.S.company + '…', 'info');
      for (const it of mine) {
        try {
          const s = C.parseOFX(await ungz(it.gz))[it.idx];
          if (!s || String(s.acctId) !== String(it.acctId)) throw new Error('statement not found in file');
          const existing = L.S.accounts.find(a => a.ofxId && a.ofxId === s.acctId);
          s.fileName = it.fileName; s.key = 'q' + Math.random();
          s.target = existing ? existing.id : 'new';
          s.newName = it.newName || s.fileName;
          s.setOpening = !existing && s.ledgerBalance != null; s.balInput = s.ledgerBalance == null ? null : (s.kind === 'credit' ? Math.abs(s.ledgerBalance) : s.ledgerBalance);
          const r = L.doImport(s);
          const d = C.debits(L.live(), {}), bal = C.natural(r.target, d[r.target.id]);
          const stmtBal = s.ledgerBalance == null ? null : (s.kind === 'credit' ? Math.abs(s.ledgerBalance) : s.ledgerBalance);
          q.results.push({ company: L.S.company, account: r.target.name, n: r.n, auto: r.auto, matched: r.matched, newAccount: !existing, balance: bal, stmtBalance: stmtBal, stmtDate: s.ledgerDate || '' });
        } catch (e) { q.results.push({ company: L.S.company, account: it.fileName, error: e.message }); }
        it.done = true; setQ(q);
      }
      L.matchTransfers(); L.smartCategorizeExisting(); L.save(); L.updateBadge();
      q.results.filter(r => r.company === L.S.company).forEach(r => { r.uncat = L.live().filter(L.isUncat).length; });
      setQ(q);
      await SV.flushed();
    }
    const next = q.items.find(i => !i.done);
    if (next) { SV.banner('Next company…', 'info'); window.ledgerFile.companies.switchTo(next.company); return; }
    SV.banner(null);
    setQ(null);
    ST.accounts = null;
    if (ST.onDone) { const f = ST.onDone; ST.onDone = null; f(q.results); return; }
    showReport(q.results);
  }
  function showReport(res) {
    const byCo = {}; res.forEach(r => (byCo[r.company] = byCo[r.company] || []).push(r));
    modal(`<h2>Statements imported</h2>
      ${Object.entries(byCo).map(([co, rs]) => `<h3 style="font-size:14px;margin:14px 0 4px">${esc(co)}</h3>
        ${rs.map(r => r.error ? `<p class="small" style="color:var(--neg);margin:2px 0">${esc(r.account)}: ${esc(r.error)}</p>` : `<p class="small" style="margin:2px 0"><b>${esc(r.account)}</b>${r.newAccount ? ' (new account)' : ''}: ${r.n} new · ${r.auto} sorted automatically${r.matched ? ' · ' + r.matched + ' card payment' + (r.matched === 1 ? '' : 's') + ' matched' : ''}${r.stmtBalance != null ? ` · balance ${money(r.balance)} ${Math.abs(r.balance - r.stmtBalance) < 0.01 ? '<span class="pos">✓ matches the bank</span>' : '<span class="neg">≠ bank ' + money(r.stmtBalance) + ' on ' + usDate(r.stmtDate) + '</span>'}` : ''}</p>`).join('')}
        ${rs[0] && rs[0].uncat ? `<p class="small muted" style="margin:2px 0">${rs[0].uncat} transaction${rs[0].uncat === 1 ? '' : 's'} in ${esc(co)} still need a category.</p>` : ''}`).join('')}
      <p class="small muted" style="margin-top:12px">Next: open each company › AI Assistant › Bookkeeper. The AI sorts what it's sure about and asks you about the rest. You can delete the downloaded files from your PC now; they're not locked.</p>
      <div class="actions"><button class="btn" id="srClose">Close</button><button class="btn primary" id="srSort">Let the AI sort it (this company)</button></div>`, c => {
      c.querySelector('#srClose').onclick = closeModal;
      c.querySelector('#srSort').onclick = () => { closeModal(); if (L.viewState.ai) { L.viewState.ai.tab = 'chat'; L.viewState.ai.bkAutoStart = true; } L.go('ai'); };
    });
  }

  // ----- screen -----
  const nav = $('#nav'), imp = nav.querySelector('[data-view="import"]');
  const b = document.createElement('button'); b.dataset.view = 'statements'; b.textContent = 'Get statements';
  imp.insertAdjacentElement('afterend', b);
  const today = new Date().toISOString().slice(0, 10);
  const ago = d => { if (!d) return ''; const n = Math.round((new Date(today) - new Date(d)) / 864e5); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago'; };
  views.statements = () => {
    if (!ST.accounts) loadAccounts();
    const groups = {};
    (ST.accounts || []).forEach(a => { (groups[a.bank.id] = groups[a.bank.id] || { bank: a.bank, accts: [] }).accts.push(a); });
    const routed = ST.routed, companies = SV.companies().filter(c => c.role === 'owner' || c.role === 'edit');
    return `<div class="page-head"><div><h1>Get statements</h1><p class="sub">1. Open each bank and download a QuickBooks (.QBO) file. 2. Drop all the files below. Ledger Desk puts each one into the right company and sorts it. Your bank passwords are never stored.</p></div></div>
      <div class="drop" id="stDrop"><strong>Drop all downloaded statement files here</strong><span class="muted">.QBO, .QFX or .OFX, from any of your banks and cards, for any company</span>
        <div style="margin-top:10px"><label class="btn primary" for="stIn" style="display:inline-block">Choose files…</label><input type="file" id="stIn" accept=".qbo,.qfx,.ofx,.QBO,.QFX,.OFX" multiple hidden></div></div>
      ${routed ? `<div class="panel" style="margin-top:16px"><h2>Check where each statement goes</h2><div class="table-wrap"><table><thead><tr><th>File</th><th>Account</th><th>Dates</th><th class="num">Transactions</th><th>Company</th></tr></thead><tbody>
        ${routed.map((r, i) => r.error ? `<tr><td>${esc(r.fileName)}</td><td colspan="4" class="neg small">${esc(r.error)}</td></tr>` : `<tr data-i="${i}"><td class="small">${esc(r.fileName)}</td><td>${esc(r.org || '')} ${r.kind === 'credit' ? 'card' : 'account'} ending <b>${esc(String(r.acctId).slice(-4))}</b>${r.known ? '' : `<div class="small" style="color:var(--warn)">New account. Name it: <input type="text" data-st-name value="${esc(r.newName)}" style="width:190px"></div>`}</td>
          <td class="small">${r.from ? usDate(r.from) + ' – ' + usDate(r.to) : '—'}</td><td class="num">${r.n}</td>
          <td><select data-st-co aria-label="Company"><option value="">Choose a company…</option>${companies.map(c => `<option value="${esc(c.file)}"${c.file === r.company ? ' selected' : ''}>${esc(c.plainName || c.name)}</option>`).join('')}</select>${r.known ? '' : '<div class="small muted">Not in any company yet: pick the right one.</div>'}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="toolbar" style="margin:12px 0 0"><button class="btn primary" data-act="stGo">Import all into their companies</button><button class="btn" data-act="stCancel">Cancel</button></div>
        <p class="small muted" style="margin:8px 0 0">Transactions already in the books are skipped, so downloading "year to date" every time is fine.</p></div>` : ''}
      <h2 style="margin:22px 0 10px">Your banks and cards</h2>
      ${!ST.accounts ? '<p class="muted"><span class="spin"></span>Checking how up to date each account is…</p>' : Object.values(groups).sort((x, y) => x.bank.name.localeCompare(y.bank.name)).map(g => `<div class="panel" style="margin-bottom:12px">
        <div class="page-head" style="margin:0 0 6px"><div><h2 style="margin:0">${esc(g.bank.name)}</h2><p class="sub small" style="max-width:720px">${esc(g.bank.steps)}</p></div>
          <div class="toolbar" style="margin:0"><button class="link" data-act="stLink" data-bank="${g.bank.id}" data-name="${esc(g.bank.name)}">${links()[g.bank.id] ? 'Change link' : g.bank.url ? 'Change link' : 'Set sign-in link'}</button><a class="btn primary" href="${esc(siteFor(g.bank))}" target="_blank" rel="noopener" style="text-decoration:none;color:var(--accent-ink)">Open ${esc(g.bank.name)} ↗</a></div></div>
        <div class="table-wrap"><table><thead><tr><th>Account</th><th>Company</th><th>Up to date through</th></tr></thead><tbody>
        ${g.accts.sort((x, y) => (x.last || '').localeCompare(y.last || '')).map(a => `<tr><td>${esc(a.name)}</td><td class="small">${esc(a.company)}</td><td>${a.last ? usDate(a.last) + ' <span class="small muted">(' + ago(a.last) + ')</span>' : '<span class="muted">nothing yet</span>'}</td></tr>`).join('')}
        </tbody></table></div></div>`).join('') || '<p class="muted">No bank or card accounts yet. Drop a statement file above to start.</p>'}`;
  };
  afterRender.statements = () => {
    const drop = $('#stDrop'), inp = $('#stIn');
    if (inp) inp.addEventListener('change', () => readDropped(inp.files));
    if (drop) {
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => { e.stopPropagation(); readDropped(e.dataTransfer.files); });
    }
    document.querySelectorAll('[data-st-co]').forEach(sel => sel.addEventListener('change', e => { e.stopPropagation(); ST.routed[+sel.closest('tr').dataset.i].company = sel.value; }));
    document.querySelectorAll('[data-st-name]').forEach(inp2 => inp2.addEventListener('input', e => { e.stopPropagation(); ST.routed[+inp2.closest('tr').dataset.i].newName = inp2.value; }));
  };
  acts.stGo = () => startImport();
  acts.stCancel = () => { ST.routed = null; L.render(); };
  acts.stLink = btn => {
    const id = btn.dataset.bank, name = btn.dataset.name;
    modal(`<h2>Sign-in link for ${esc(name)}</h2><p class="muted small" style="margin-top:0">Paste the address of the page where you sign in. It's saved in this browser.</p>
      <label class="field">Address<input type="text" id="lkUrl" value="${esc(links()[id] || '')}" placeholder="https://"></label>
      <div class="actions"><button class="btn" id="lkCancel">Cancel</button><button class="btn primary" id="lkSave">Save</button></div>`, c => {
      c.querySelector('#lkCancel').onclick = closeModal;
      c.querySelector('#lkSave').onclick = () => { const u = c.querySelector('#lkUrl').value.trim(); if (u && !/^https:\/\//i.test(u)) { toast('Use an https:// address'); return; } setLink(id, u); closeModal(); L.render(); };
    });
  };
  // keep going after a company switch
  if (getQ()) setTimeout(processQueue, 300);
  if (L.view === 'statements') L.render();
})();
