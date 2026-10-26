/* Ledger Desk Server: connects the Ledger Desk page to the books on the server PC.
   Books are unlocked here in the browser and locked again before every save; the server only stores locked files.
   Gives the page the same "ledgerFile" bridge the desktop app has, then starts the app. */
(function () {
  'use strict';
  const V = window.LDVault, enc = encodeURIComponent;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function api(url, opts) {
    opts = opts || {};
    const r = await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts, { headers: Object.assign({ 'X-LD': '1' }, opts.headers || {}) }));
    if (r.status === 401) { V.forgetKeys(); location.href = '/login'; throw new Error('signed out'); }
    let data = {}; try { data = await r.json(); } catch (e) {}
    if (!r.ok) { const err = new Error(data.error || ('Server error ' + r.status)); err.status = r.status; throw err; }
    return data;
  }
  const post = (url, body, headers) => api(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body || {}), headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });

  function banner(msg, kind) {
    let el = document.getElementById('srvBanner');
    if (!msg) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'srvBanner'; el.className = 'srv-banner'; document.body.appendChild(el); }
    el.textContent = msg; el.dataset.kind = kind || 'warn';
  }
  const main = document.getElementById('main');
  const fail = msg => { main.innerHTML = '<div class="empty">' + msg + '</div>'; };

  // A new browser tab has no key yet: ask for the password to unlock.
  function askToUnlock(me) {
    return new Promise(resolve => {
      main.innerHTML = `<div class="panel" style="max-width:420px;margin:40px auto"><h2>🔒 Unlock your books</h2>
        <p class="muted small" style="margin-top:0">Your books are locked. Type your password to unlock them in this browser window.</p>
        <form id="ulF"><label class="field">Password<input type="password" id="ulPw" autocomplete="current-password" style="font-size:15px;padding:8px"></label>
        <p class="small" id="ulErr" style="color:var(--neg);min-height:18px"></p>
        <div class="toolbar"><button class="btn primary" id="ulGo" type="submit">Unlock</button><button class="link" type="button" id="ulOut">Sign out</button></div></form></div>`;
      document.getElementById('ulPw').focus();
      document.getElementById('ulOut').onclick = async () => { try { await post('/api/logout', {}); } catch (e) {} location.href = '/login'; };
      document.getElementById('ulF').onsubmit = async e => {
        e.preventDefault();
        const b = document.getElementById('ulGo'); b.disabled = true; b.textContent = 'Unlocking…';
        try { const dek = await V.unlockWithPassword(me.vault, document.getElementById('ulPw').value); await V.keepKey(me.username, dek); resolve(dek); }
        catch (x) { document.getElementById('ulErr').textContent = 'That password doesn\'t unlock these books.'; b.disabled = false; b.textContent = 'Unlock'; }
      };
    });
  }

  async function start() {
    if (!window.crypto || !crypto.subtle || !window.CompressionStream) { fail('This browser is too old for locked books. Use a current Microsoft Edge or Google Chrome, and the https:// address.'); return; }
    let me, co, cur, text = null, version = null, dek, isNew = false;
    try { me = await api('/api/me'); }
    catch (e) { if (e.message !== 'signed out') fail('Could not reach the Ledger Desk server. Check that the server PC is on and that Tailscale is connected, then reload this page.'); return; }
    if (me.needRecovery) { V.forgetKeys(); try { await post('/api/logout', {}); } catch (e) {} location.href = '/login'; return; }
    dek = await V.keptKey(me.username);
    if (!dek) dek = await askToUnlock(me);
    main.innerHTML = '<div class="empty"><span class="spin"></span>Unlocking your books…</div>';
    let priv, curRole = 'owner';
    const waitingIn = []; // companies someone is sharing with me that their browser hasn't handed over yet
    const cks = {}; // company file -> that company's own key (unlocked in this browser only)
    try {
      // Each person has a key pair, so others can share a company with them. Made once, the first time.
      if (!me.pub) { const pk = await V.newPersonKeys(dek); await post('/api/me/keys', pk); me.pub = pk.pub; me.priv = pk.priv; }
      priv = await V.openPrivate(dek, me.priv);
      let c = await api('/api/companies');
      // Companies still locked with the person's own key get their own company key (one time, after the update)
      const legacy = c.list.filter(x => !x.key && x.role === 'owner');
      for (let i = 0; i < legacy.length; i++) {
        main.innerHTML = '<div class="empty"><span class="spin"></span>Giving each company its own key (' + (i + 1) + ' of ' + legacy.length + '), one time only…</div>';
        const x = legacy[i], b = await api('/api/books?file=' + enc(x.file));
        const plain = await V.openBooks(dek, b.text), ck = await V.newCompanyKey();
        await post('/api/share/rekey', { file: x.file, if: b.version, env: await V.sealBooks(ck, plain), keys: { [me.username]: await V.lockCompanyKeyFor(me.pub, ck) } });
      }
      if (legacy.length) c = await api('/api/companies');
      const list = [];
      for (const x of c.list) {
        try {
          if (!x.key) { if (x.role !== 'owner') waitingIn.push(x.ownerName || x.owner); continue; }
          const ck = cks[x.file] = await V.unlockCompanyKey(priv, x.key), h = await V.openHeader(ck, x.hdr);
          list.push({ file: x.file, name: (h.name || 'Company') + (x.role === 'owner' ? '' : ' (from ' + x.ownerName + ')'), plainName: h.name || 'Company', ofxIds: h.ofxIds || [], role: x.role, owner: x.owner, ownerName: x.ownerName, shared: x.shared });
        } catch (e) {}
      }
      list.sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || a.name.localeCompare(b.name));
      co = { list };
      cur = c.current && list.some(x => x.file === c.current) ? c.current : (list[0] && list[0].file);
      if (cur) {
        const b = await api('/api/books?file=' + enc(cur));
        version = b.version; curRole = b.role || 'owner';
        text = b.text ? await V.openBooks(cks[cur], b.text) : null;
      } else { cur = V.newCompanyFile(); isNew = true; }
    } catch (e) { if (e.message !== 'signed out') fail('Could not open your books: ' + esc(e.message)); return; }
    const curEntry = () => co.list.find(x => x.file === cur) || { role: 'owner' };

    // ----- saving: lock, then send; newest copy wins, one request at a time, retried if the connection drops -----
    let pristine = null;
    let want = null, busy = false, extCb = null, conflictCb = null, waiters = [], retry = 0, viewWarned = 0;
    const creates = {};
    function flushed() { return (busy || want) ? new Promise(r => waiters.push(r)) : Promise.resolve(); }
    async function adopt(envText) { try { const t = await V.openBooks(cks[cur], envText); text = t; if (extCb) extCb(t); } catch (e) {} }
    async function createLocked(file, json) {
      const ck = cks[file] = await V.newCompanyKey();
      const r = await post('/api/companies/create?file=' + enc(file), await V.sealBooks(ck, json), { 'X-LD-Key': await V.lockCompanyKeyFor(me.pub, ck) });
      if (!co.list.some(x => x.file === file)) { let d = {}; try { d = JSON.parse(json); } catch (e) {} co.list.push({ file, name: d.company || 'Company', plainName: d.company || 'Company', ofxIds: [], role: 'owner', owner: me.username }); }
      return r;
    }
    async function pump() {
      if (busy) return; busy = true;
      while (want) {
        const w = want; want = null;
        try {
          if (creates[w.file]) await creates[w.file];
          let r;
          if (isNew && w.file === cur) { r = await createLocked(w.file, w.json); isNew = false; try { await post('/api/companies/current', { file: w.file }); } catch (e) {} }
          else r = await post('/api/books/save?file=' + enc(w.file) + '&if=' + enc(version || ''), await V.sealBooks(cks[w.file], w.json));
          retry = 0; banner(null);
          version = r.version;
          if (r.conflict) {
            want = null; // anything queued was based on the old copy
            if (r.text) await adopt(r.text);
            if (conflictCb) conflictCb();
          } else {
            text = w.json;
            const it = co.list.find(c => c.file === w.file);
            try { const d = JSON.parse(w.json); if (it && it.role === 'owner') it.name = it.plainName = d.company || it.name; } catch (e) {}
          }
        } catch (e) {
          if (e.message === 'signed out') break;
          if (e.status >= 400 && e.status < 500) { banner('Not saved: ' + e.message, 'err'); break; }
          if (!want) want = w;
          retry = Math.min(retry + 1, 6);
          banner('Not saved yet. Trying to reach the server again…', 'warn');
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retry - 1)));
        }
      }
      busy = false;
      const ws = waiters; waiters = []; ws.forEach(r => r());
    }
    window.addEventListener('beforeunload', e => { if (busy || want) { e.preventDefault(); e.returnValue = ''; } });

    // ----- notice changes made elsewhere (another window, PC, or a partner working on the same company) -----
    setInterval(async () => {
      if (busy || want || document.hidden || isNew) return;
      try {
        const v = await api('/api/books/version?file=' + enc(cur));
        if (v.version && v.version !== version && !busy && !want) {
          const b = await api('/api/books?file=' + enc(cur));
          if (busy || want) return;
          version = b.version;
          if (b.text) await adopt(b.text);
        }
      } catch (e) {
        if (e.status === 403 || e.status === 404) { banner('You no longer have access to this company. Pick another company.', 'err'); }
      }
    }, 5000);

    // ----- sharing (owner of a company only) -----
    async function lookup(username) { return api('/api/users/lookup?username=' + enc(username)); }
    const share = {
      list: file => api('/api/share/list?file=' + enc(file)),
      add: async (file, username, role) => {
        const u = await lookup(username);
        await post('/api/share/add', { file, username: u.username, role, key: await V.lockCompanyKeyFor(u.pub, cks[file]) });
        const it = co.list.find(x => x.file === file); if (it) it.shared = (it.shared || 0) + 1;
        return u;
      },
      role: (file, username, role) => post('/api/share/role', { file, username, role }),
      // Removing someone also gives the company a brand-new key, so the key they had no longer opens it.
      remove: async (file, username) => {
        await flushed();
        await post('/api/share/remove', { file, username });
        const rest = (await share.list(file)).members;
        const b = await api('/api/books?file=' + enc(file));
        const plain = await V.openBooks(cks[file], b.text), ck = await V.newCompanyKey();
        const keys = { [me.username]: await V.lockCompanyKeyFor(me.pub, ck) };
        for (const m of rest) { try { keys[m.username] = await V.lockCompanyKeyFor((await lookup(m.username)).pub, ck); } catch (e) {} }
        const r = await post('/api/share/rekey', { file, if: b.version, env: await V.sealBooks(ck, plain), keys });
        cks[file] = ck; if (file === cur) version = r.version;
        const it = co.list.find(x => x.file === file); if (it) it.shared = rest.length;
      },
      leave: async file => { await flushed(); await post('/api/share/leave', { file }); },
      // Finish shares for people I invited who have now signed up (my browser hands them the company key)
      finishPending: async () => {
        let n = 0;
        try {
          const { pending } = await api('/api/share/pending');
          for (const x of pending) { if (!cks[x.file]) continue; try { await share.add(x.file, x.username, x.role); n++; } catch (e) {} }
        } catch (e) {}
        return n;
      },
      waitingIn,
      lookup
    };

    let firstName = 'My Company'; try { firstName = sessionStorage.getItem('ld-newco') || firstName; sessionStorage.removeItem('ld-newco'); } catch (e) {}
    if (isNew) co.list.push({ file: cur, name: firstName, plainName: firstName, ofxIds: [], role: 'owner', owner: me.username });

    window.ledgerFile = {
      load: () => text,
      save: (file, json) => {
        if (file !== cur) return 'wrong-company';
        if (curRole === 'view') { if (Date.now() - viewWarned > 8000) { viewWarned = Date.now(); banner('View only: ' + curEntry().ownerName + ' shared this company with you to look at. Changes are not saved.', 'warn'); setTimeout(() => banner(null), 6000); } return 'ok'; }
        // A brand-new, untouched company isn't written until something is added to it (so no empty "My Company" appears)
        if (isNew && firstName === 'My Company' && (pristine === null || json === pristine)) { if (pristine === null) pristine = json; return 'ok'; }
        want = { file, json }; pump(); return 'ok';
      },
      path: () => 'the Ledger Desk server, locked with this company\'s own key',
      defaultName: () => firstName,
      reveal: () => {},
      onExternalChange: cb => { extCb = cb; },
      companies: {
        list: () => ({ list: co.list, current: cur }),
        create: (name, json) => {
          const file = V.newCompanyFile();
          let ofxIds = []; try { ofxIds = JSON.parse(json).accounts.filter(a => a.ofxId).map(a => String(a.ofxId)); } catch (e) {}
          co.list.push({ file, name, plainName: name, ofxIds, role: 'owner', owner: me.username });
          creates[file] = createLocked(file, json);
          creates[file].catch(e => banner('Could not create ' + name + ': ' + e.message, 'err'));
          return file;
        },
        switchTo: async file => {
          banner('Opening…', 'info');
          await flushed();
          try { if (creates[file]) await creates[file]; await post('/api/companies/current', { file }); }
          catch (e) { banner('Could not switch company: ' + e.message, 'err'); return; }
          location.reload();
        }
      }
    };
    // Read another company's books (unlocked here) without opening it, e.g. to see how up to date its accounts are
    async function readCompany(file) { if (!cks[file]) throw new Error('No key for that company'); const b = await api('/api/books?file=' + enc(file)); return b.text ? V.openBooks(cks[file], b.text) : null; }
    window.ledgerServer = { me, api, post, flushed, banner, onConflict: cb => { conflictCb = cb; }, dek, createLocked, readCompany, newFile: V.newCompanyFile, share, current: () => Object.assign({ file: cur }, curEntry(), { role: isNew ? 'owner' : curRole }), companies: () => co.list };

    if (co.list.some(x => x.role === 'owner')) {
      const run = async () => { const n = await share.finishPending(); if (n) { banner(n + ' waiting share' + (n === 1 ? '' : 's') + ' finished: the people you invited can now open those companies.', 'info'); setTimeout(() => banner(null), 7000); } };
      setTimeout(run, 1500); setInterval(run, 60000);
    }
    main.innerHTML = '';
    ['core.js', 'xlsx.js', 'merchants.js', 'qbimport.js', 'app.js', 'ai.js', 'server-ui.js', 'statements.js', 'checks.js', 'pdfstmt.js', 'aichat.js', 'tax.js'].forEach(src => {
      const s = document.createElement('script'); s.src = src; s.async = false; document.body.appendChild(s);
    });
  }
  start();
})();
