/* Ledger Desk Server: who is signed in, passwords, the owner's Logins screen, and moving books in from the desktop app. */
(function () {
  'use strict';
  const L = window.ledgerDeskApp, SV = window.ledgerServer;
  if (!L || !SV) return;
  const { esc, toast, modal, closeModal, views, acts, afterRender } = L;
  const me = SV.me;
  const $ = s => document.querySelector(s);

  SV.onConflict(() => setTimeout(() => toast('These books were changed somewhere else (another window or PC), so your last change was not saved. The newest copy is shown now. Please make your change again.'), 80));

  // ----- sidebar: who is signed in -----
  const foot = $('.side-foot');
  foot.innerHTML = '';
  const who = document.createElement('div');
  who.className = 'who';
  who.innerHTML = `<div>Signed in as <b>${esc(me.name)}</b>${me.admin ? ' (owner)' : ''}</div>
    <div class="who-links"><button class="link" id="wPw">Change password</button><button class="link" id="wRec">New recovery code</button><button class="link" id="w2fa">Two-step sign-in</button><button class="link" id="wOut">Sign out</button></div>`;
  foot.appendChild(who);
  $('#wOut').onclick = async () => { await SV.flushed(); window.LDVault.forgetKeys(); try { await SV.post('/api/logout', {}); } catch (e) {} location.href = '/books/login'; };
  $('#wPw').onclick = () => pwModal(false);
  // ----- two-step sign-in (code from email or an authenticator app after the password) -----
  $('#w2fa').onclick = () => tfaModal();
  async function tfaModal() {
    let st; try { st = await SV.api('/api/me/2fa'); } catch (e) { toast(e.message); return; }
    const status = st.method === 'app' ? '✓ On: code from an <b>authenticator app</b>.' : st.method === 'email' ? '✓ On: code emailed to <b>' + esc(st.email) + '</b>.' : st.required ? 'The owner requires it. You\'ll set it up by email at your next sign-in, or set it up now.' : 'Off. Signing in only needs your password.';
    modal(`<h2>Two-step sign-in</h2>
      <p class="muted small" style="margin-top:0">After your password, Ledger Desk asks for a 6-digit code, so a stolen password alone can't get in. On a device you trust you can skip the code for 30 days.</p>
      <p>${status}${st.trusted ? ' <span class="small muted">(' + st.trusted + ' trusted device' + (st.trusted === 1 ? '' : 's') + ')</span>' : ''}</p>
      <div id="tfaBody"><div class="toolbar" style="margin:0;flex-wrap:wrap">
        <button class="btn${st.method === 'email' ? '' : ' primary'}" id="tEmailBtn"${st.canEmail ? '' : ' disabled title="The owner hasn\'t set up email sending (Logins › Email for invites)"'}>Use email codes</button>
        <button class="btn${st.method === 'app' ? '' : ' primary'}" id="tAppBtn">Use an authenticator app</button>
        ${st.trusted ? '<button class="btn" id="tForget">Forget trusted devices</button>' : ''}
        ${st.method && !st.required ? '<button class="btn danger" id="tOff">Turn off</button>' : ''}</div></div>
      <p class="small" id="tErr" style="color:var(--neg)"></p>
      <div class="actions"><button class="btn" id="tClose">Close</button></div>`, card => {
      const err = m => { card.querySelector('#tErr').textContent = m || ''; };
      card.querySelector('#tClose').onclick = closeModal;
      const off = card.querySelector('#tOff'); if (off) off.onclick = async () => { try { await SV.post('/api/me/2fa', { action: 'off' }); closeModal(); toast('Two-step sign-in is off'); } catch (e) { err(e.message); } };
      const fg = card.querySelector('#tForget'); if (fg) fg.onclick = async () => { try { await SV.post('/api/me/2fa', { action: 'forget' }); closeModal(); toast('Every device will ask for a code next time'); } catch (e) { err(e.message); } };
      const confirmStep = (html, action, done) => {
        card.querySelector('#tfaBody').innerHTML = html + `<label class="field" style="margin-top:8px">6-digit code<input type="text" id="tC" inputmode="numeric" maxlength="7" style="font-family:var(--f-num);font-size:18px;letter-spacing:3px;width:160px"></label><button class="btn primary" id="tOk" style="margin-top:8px">Turn on</button>`;
        card.querySelector('#tC').focus();
        card.querySelector('#tOk').onclick = async () => { err(); try { await SV.post('/api/me/2fa', { action, code: card.querySelector('#tC').value }); closeModal(); toast(done); } catch (e) { err(e.message); } };
      };
      card.querySelector('#tEmailBtn').onclick = () => {
        card.querySelector('#tfaBody').innerHTML = `<label class="field">Your email<input type="email" id="tE" value="${esc(st.email || '')}" placeholder="you@gmail.com"></label><button class="btn primary" id="tSend" style="margin-top:8px">Send me a code</button>`;
        card.querySelector('#tSend').onclick = async () => { err(); const email = card.querySelector('#tE').value; try { await SV.post('/api/me/2fa', { action: 'email-send', email }); confirmStep('<p class="small">We emailed a code to <b>' + esc(email) + '</b>. Type it here to turn on email codes.</p>', 'email-confirm', 'Two-step sign-in is on: codes go to ' + email); } catch (e) { err(e.message); } };
      };
      card.querySelector('#tAppBtn').onclick = async () => {
        err(); let r; try { r = await SV.post('/api/me/2fa', { action: 'app-start' }); } catch (e) { err(e.message); return; }
        const key = r.secret.replace(/(.{4})/g, '$1 ').trim();
        confirmStep(`<ol class="small" style="padding-left:18px;line-height:1.6;margin:0"><li>On your phone, install <b>Google Authenticator</b> or <b>Microsoft Authenticator</b>.</li>
          <li>Tap <b>+</b> › <b>Enter a setup key</b>. Account: <b>Ledger Desk</b>. Key:<div style="font-family:var(--f-num);font-size:15px;background:var(--panel-2);padding:6px 8px;border-radius:6px;margin:4px 0;user-select:all">${esc(key)}</div>Type: time based. (On this phone? <a href="${esc(r.uri)}">tap here to add it</a>.)</li>
          <li>Type the 6-digit code the app shows.</li></ol>`, 'app-confirm', 'Two-step sign-in is on with your authenticator app');
      };
    });
  }
  $('#wRec').onclick = () => {
    modal(`<h2>Make a new recovery code</h2>
      <p class="muted small" style="margin-top:0">Lost your recovery code? As long as you know your password, you can make a new one. Your old code stops working.</p>
      <label class="field">Your password<input type="password" id="nrPw" autocomplete="current-password"></label><p class="small" id="nrErr" style="color:var(--neg)"></p>
      <div class="actions"><button class="btn" id="nrCancel">Cancel</button><button class="btn primary" id="nrGo">Make new code</button></div>`, card => {
      card.querySelector('#nrCancel').onclick = closeModal;
      card.querySelector('#nrGo').onclick = async () => {
        const V = window.LDVault, b = card.querySelector('#nrGo'); b.disabled = true; b.textContent = 'Making…';
        try {
          const auth = await V.authFor(me.username, card.querySelector('#nrPw').value);
          const nr = await V.newRecovery(SV.dek);
          await SV.post('/api/recovery/new', { auth, recAuth: await V.recAuthFor(me.username, nr.recovery), vaultRec: nr.rec });
          const m = V.recoveryMail(me.username, nr.recovery);
          modal(`<h2>Your new recovery code</h2><p class="muted small" style="margin-top:0">Save it now. It won't be shown again, and your old code no longer works.</p>
            <div style="font:600 19px/1.4 var(--f-num);letter-spacing:.04em;background:var(--panel-2);border:1px dashed var(--muted);border-radius:8px;padding:12px;text-align:center;margin:10px 0;user-select:all">${esc(nr.recovery)}</div>
            <p class="small" style="margin:10px 0 6px"><b>Email it to yourself</b> (opens your own email; the server never sees it):</p>
            <div class="toolbar"><a class="btn" target="_blank" rel="noopener" href="${esc(m.gmail)}" style="text-decoration:none;color:inherit">Gmail</a><a class="btn" target="_blank" rel="noopener" href="${esc(m.outlook)}" style="text-decoration:none;color:inherit">Outlook</a><a class="btn" href="${esc(m.mailto)}" style="text-decoration:none;color:inherit">Mail app</a><button class="btn" id="nrCopy">Copy</button></div>
            <div class="actions"><button class="btn primary" id="nrDone">I saved it</button></div>`, c => {
            c.querySelector('#nrCopy').onclick = () => navigator.clipboard.writeText(nr.recovery).then(() => toast('Copied'));
            c.querySelector('#nrDone').onclick = closeModal;
          });
        } catch (e) { card.querySelector('#nrErr').textContent = e.message; b.disabled = false; b.textContent = 'Make new code'; }
      };
    });
  };

  if (me.admin) {
    const nav = $('#nav');
    const b = document.createElement('button'); b.dataset.view = 'users'; b.textContent = 'Logins'; nav.appendChild(b);
  }

  function pwModal(forced) {
    modal(`<h2>${forced ? 'Choose your own password' : 'Change password'}</h2>
      ${forced ? '<p class="muted small" style="margin-top:0">You signed in with a temporary password from the owner. Pick one only you know.</p>' : ''}
      <div class="grid" style="gap:12px">
        <label class="field">Current password<input type="password" id="pOld" autocomplete="current-password"></label>
        <label class="field">New password (at least 10 characters)<input type="password" id="pNew" autocomplete="new-password"></label>
        <label class="field">New password again<input type="password" id="pNew2" autocomplete="new-password"></label>
      </div><p class="small" id="pErr" style="color:var(--neg)"></p>
      <div class="actions"><button class="btn" id="pCancel">${forced ? 'Later' : 'Cancel'}</button><button class="btn primary" id="pSave">Save password</button></div>`, card => {
      card.querySelector('#pCancel').onclick = closeModal;
      card.querySelector('#pSave').onclick = async () => {
        const V = window.LDVault, o = card.querySelector('#pOld').value, n = card.querySelector('#pNew').value, er = card.querySelector('#pErr');
        if (n !== card.querySelector('#pNew2').value) { er.textContent = 'The two new passwords are not the same.'; return; }
        const bad = V.passwordProblem(n); if (bad) { er.textContent = bad; return; }
        const b = card.querySelector('#pSave'); b.disabled = true; b.textContent = 'Saving…';
        try {
          await SV.post('/api/password', { old: await V.authFor(me.username, o), auth: await V.authFor(me.username, n), vaultPw: await V.passwordWrap(SV.dek, n) });
          closeModal(); toast('Password changed. Your books are now locked with the new password. Other signed-in windows were signed out.');
        } catch (e) { er.textContent = e.message; b.disabled = false; b.textContent = 'Save password'; }
      };
    });
  }
  if (me.mustChange) setTimeout(() => pwModal(true), 300);

  // ----- owner: Logins screen -----
  const US = { list: null, err: '', inv: null };
  async function loadUsers() {
    try { US.list = (await SV.api('/api/admin/users')).users; US.inv = await SV.api('/api/admin/invites'); US.err = ''; } catch (e) { US.err = e.message; }
    US.at = Date.now();
    if (L.view === 'users' && !document.querySelector('#main input:focus')) L.render();
  }
  const fmtWhen = s => s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  const fmtDay = s => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const isLocal = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const baseUrl = () => location.origin + '/books';
  const INV_LABEL = { waiting: 'Waiting', used: 'Used', expired: 'Expired', cancelled: 'Cancelled' };
  views.users = () => {
    if (!US.busy && Date.now() - (US.at || 0) > 4000) { US.busy = true; US.at = Date.now(); loadUsers().finally(() => { US.busy = false; }); }
    const inv = US.inv || { invites: [] }, base = baseUrl();
    return `<div class="page-head"><div><h1>Logins</h1><p class="sub">Only people you invite can create an account. Each person sees only their own companies; yours stay private.</p></div>
      <button class="btn primary" data-act="uInvite">Invite someone</button></div>
      <div class="notice" style="background:var(--accent-soft)">🔒 Everyone's books are locked with their own key, made from their password in their own browser. The server only stores locked files, so you can't open your friends' books, and they can't open yours.</div>
      ${US.err ? '<div class="notice">' + esc(US.err) + '</div>' : ''}
      <div class="panel" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Name</th><th>User name</th><th class="num">Companies</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${(US.list || []).map(u => `<tr data-user="${esc(u.username)}"><td>${esc(u.name)}${u.admin ? ' <span class="chip cc">owner</span>' : ''}${u.disabled ? ' <span class="chip">turned off</span>' : ''}${u.mustChange ? ' <span class="chip">password was reset</span>' : ''}</td>
        <td class="num" style="text-align:left">${esc(u.username)}</td><td class="num">${u.companies}</td><td class="small">${esc(fmtWhen(u.lastLogin))}</td>
        <td style="text-align:right;white-space:nowrap">${u.tfa ? '<button class="btn sm" data-act="u2faReset" title="For someone who lost their phone or email access">Reset two-step</button> ' : ''}<button class="btn sm" data-act="uReset">Reset password</button>${u.admin ? '' : ` <button class="btn sm${u.disabled ? '' : ' danger'}" data-act="uToggle">${u.disabled ? 'Turn on' : 'Turn off'}</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Loading…</td></tr>'}
      </tbody></table></div></div>

      <div class="panel" style="margin-top:16px;padding:0"><div style="padding:16px 16px 4px"><h2 style="margin:0">Invites</h2><p class="small muted" style="margin:4px 0 0">Each invite link works once, for one person, and stops working when it expires or you cancel it.</p></div>
      ${inv.invites.length ? `<div class="table-wrap"><table><thead><tr><th>For</th><th>Made</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>
      ${inv.invites.map(i => `<tr data-inv="${esc(i.id)}"><td>${esc(i.name || '(no name)')}${i.sentTo ? '<div class="memo">emailed to ' + esc(i.sentTo) + '</div>' : ''}</td><td class="small">${esc(fmtDay(i.created))}</td><td class="small">${esc(fmtDay(i.expires))}</td>
        <td>${i.status === 'used' ? '<span class="chip cc">Used by ' + esc(i.usedBy) + '</span>' : '<span class="chip">' + INV_LABEL[i.status] + '</span>'}</td>
        <td style="text-align:right">${i.status === 'waiting' ? '<button class="btn sm danger" data-act="uInvCancel">Cancel</button>' : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted small" style="padding:0 16px 16px">No invites yet. Click <b>Invite someone</b>.</p>'}</div>

      <div class="panel" style="margin-top:16px"><h2>Email for invites</h2>
        ${inv.mailFrom ? `<p style="margin:0 0 10px">✓ Invites are emailed from <b>${esc(inv.mailFrom)}</b>.</p><div class="toolbar" style="margin:0"><button class="btn" data-act="mailSetup">Change</button><button class="btn danger" data-act="mailOff">Turn off</button></div>`
          : `<p class="muted small" style="margin-top:0">Let Ledger Desk send invite emails for you. Use your Gmail with a Google <b>app password</b>: a separate 16-letter password just for Ledger Desk, which you can cancel any time. Your normal Gmail password won't work and isn't needed.</p><button class="btn primary" data-act="mailSetup">Set up email</button>`}
      </div>
      <div class="panel" style="margin-top:16px"><h2>Invite settings</h2>
        <div class="grid" style="gap:12px;max-width:640px">
          <label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="s2fa"${inv.require2fa ? ' checked' : ''}> Require two-step sign-in for everyone (a 6-digit code by email or an authenticator app after the password). Recommended.</label>
          <div><button class="btn" data-act="uSaveSet">Save settings</button></div></div>
        <p class="small muted" style="margin:12px 0 0">"Turn off" stops a login from signing in but keeps their books. Books are stored locked on the Trivedi POS server; nobody can read them without the person's own password.</p></div>`;
  };
  acts.mailOff = async () => {
    if (!(await L.confirmBox('Stop sending invite emails?', 'Ledger Desk forgets the email account and app password. You can still make invite links and send them yourself.', 'Turn off', true))) return;
    try { await SV.post('/api/admin/mail', { off: true }); toast('Email sending turned off'); US.at = 0; loadUsers(); } catch (e) { toast(e.message); }
  };
  acts.mailSetup = () => {
    modal(`<h2>Email for invites</h2>
      <ol class="steps" style="margin-top:0">
        <li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a> and sign in to your Google account. (It needs 2-Step Verification turned on. Google shows how if it isn't.)</li>
        <li>Type a name like <b>Ledger Desk</b> and click <b>Create</b>. Google shows a 16-letter password.</li>
        <li>Paste it below. Ledger Desk sends you a test email to check it works.</li></ol>
      <div class="grid" style="gap:12px;margin-top:10px">
        <label class="field">Your Gmail address<input type="email" id="mUser" value="${esc((US.inv && US.inv.mailFrom) || '')}" placeholder="you@gmail.com" autocomplete="off"></label>
        <label class="field">App password (16 letters)<input type="password" id="mPass" autocomplete="new-password" placeholder="abcd efgh ijkl mnop"></label>
        <details><summary class="small">Not Gmail?</summary><div class="form-row" style="margin-top:8px"><label class="field">Outgoing (SMTP) server<input type="text" id="mHost" placeholder="smtp.example.com"></label><label class="field">Port<input type="number" id="mPort" value="465" style="width:90px"></label></div><p class="small muted">Port 465 (SSL) or 587 (STARTTLS). Use the app password your email service gives for "other apps".</p></details>
      </div>
      <p class="small muted">The app password is kept on the server PC (Documents\\Ledger Desk Server\\config.json) and is used only to send invites. You can cancel it any time in your Google account.</p>
      <p class="small" id="mErr" style="color:var(--neg)"></p>
      <div class="actions"><button class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mSave">Save and send a test email</button></div>`, card => {
      card.querySelector('#mCancel').onclick = closeModal;
      card.querySelector('#mSave').onclick = async () => {
        const b = card.querySelector('#mSave'); b.disabled = true; b.textContent = 'Sending test…'; card.querySelector('#mErr').textContent = '';
        try {
          await SV.post('/api/admin/mail', { email: card.querySelector('#mUser').value, password: card.querySelector('#mPass').value, host: card.querySelector('#mHost').value.trim() || undefined, port: card.querySelector('#mHost').value.trim() ? card.querySelector('#mPort').value : undefined });
          closeModal(); toast('Email works. A test email is on its way to you.'); US.at = 0; loadUsers();
        } catch (e) { card.querySelector('#mErr').textContent = e.message; b.disabled = false; b.textContent = 'Save and send a test email'; }
      };
    });
  };
  acts.u2faReset = async b => {
    const name = b.closest('tr').dataset.user;
    if (!(await L.confirmBox('Reset two-step sign-in for ' + name + '?', 'They can sign in with just their password once, then set up two-step again (by email if you require it).', 'Reset', true))) return;
    try { await SV.post('/api/admin/2fa-reset', { username: name }); toast('Two-step sign-in reset for ' + name); loadUsers(); } catch (e) { toast(e.message); }
  };
  acts.uSaveSet = async () => {
    try { await SV.post('/api/admin/settings', { require2fa: $('#s2fa').checked }); toast('Settings saved'); loadUsers(); } catch (e) { toast(e.message); }
  };
  acts.uInvCancel = async b => {
    if (!(await L.confirmBox('Cancel this invite?', 'The link will stop working. Accounts already made are not affected.', 'Cancel invite', true))) return;
    try { await SV.post('/api/admin/invite/cancel', { id: b.closest('tr').dataset.inv }); toast('Invite cancelled'); loadUsers(); } catch (e) { toast(e.message); }
  };
  // Invite someone. Optionally share some of my companies with them: they get access as soon as they've made their account.
  const mailFrom = () => (US.inv && US.inv.mailFrom) || '';
  function inviteModal(opts) {
    opts = opts || {};
    const mine = SV.companies().filter(x => x.role === 'owner');
    const pick = opts.withShare ? `<div class="field">Share these companies with them<div style="display:grid;gap:4px;margin-top:4px;max-height:180px;overflow:auto;color:var(--ink);font-size:14px">${mine.map(x => `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="check" data-inv-co="${esc(x.file)}"${x.file === opts.file ? ' checked' : ''}> ${esc(x.plainName || x.name)}</label>`).join('')}</div></div>
        <label class="field">Their access<select id="iRole"><option value="edit">Can edit (partner, accountant)</option><option value="view">View only</option></select></label>` : '';
    modal(`<h2>${opts.withShare ? 'Invite someone new and share' : 'Invite someone'}</h2><p class="muted small" style="margin-top:0">You'll get a link to send them. Only the person with the link can create an account, and only once.${opts.withShare ? ' The companies you tick open for them right after they sign up.' : ''}</p>
      <div class="grid" style="gap:12px">
        <label class="field">Their name (optional, for you and their sign-up page)<input type="text" id="iName" maxlength="80" placeholder="e.g. Raj Patel"></label>
        <label class="field">Their email${mailFrom() ? ' (Ledger Desk emails the invite from ' + esc(mailFrom()) + ')' : ' (optional)'}<input type="email" id="iEmail" maxlength="120" placeholder="name@example.com" autocomplete="off"></label>
        ${mailFrom() ? '' : '<p class="small muted" style="margin:-4px 0 0">To have Ledger Desk send the email for you, set up <b>Email for invites</b> on the Logins screen. Until then you get a message to copy or email yourself.</p>'}
        ${pick}
        <label class="field">The link expires in<select id="iDays"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
      </div><p class="small" id="iErr" style="color:var(--neg)"></p>
      <div class="actions"><button class="btn" id="iCancel">Cancel</button><button class="btn primary" id="iMake">${mailFrom() ? 'Send invite' : 'Make invite link'}</button></div>`, card => {
      card.querySelector('#iCancel').onclick = closeModal;
      const emailIn = card.querySelector('#iEmail'), makeBtn = card.querySelector('#iMake');
      emailIn.addEventListener('input', () => { makeBtn.textContent = mailFrom() && emailIn.value.trim() ? 'Send invite' : 'Make invite link'; });
      makeBtn.textContent = 'Make invite link';
      card.querySelector('#iMake').onclick = async () => {
        const name = card.querySelector('#iName').value.trim(), email = emailIn.value.trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) { card.querySelector('#iErr').textContent = 'That email address doesn\'t look right.'; return; }
        makeBtn.disabled = true; makeBtn.textContent = email && mailFrom() ? 'Sending…' : 'Making…';
        const files = Array.from(card.querySelectorAll('[data-inv-co]:checked')).map(x => x.dataset.invCo);
        const role = card.querySelector('#iRole') ? card.querySelector('#iRole').value : 'edit';
        if (opts.withShare && !files.length) { card.querySelector('#iErr').textContent = 'Tick at least one company to share.'; return; }
        try {
          const r = await SV.post('/api/admin/invite', { name, days: card.querySelector('#iDays').value, share: files.length ? { files, role } : null });
          const base = baseUrl();
          const link = base + '/invite?code=' + r.code;
          const until = new Date(r.expires).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
          const coNames = mine.filter(x => files.includes(x.file)).map(x => x.plainName || x.name);
          const msg = (name ? 'Hi ' + name.split(' ')[0] + ',\n\n' : 'Hi,\n\n') +
            (coNames.length ? 'I\'m sharing my books in Ledger Desk with you (' + (role === 'view' ? 'view only' : 'you can work on them') + '): ' + coNames.join(', ') + '.\n\n' : 'I\'m inviting you to use Ledger Desk for your bookkeeping. Your books are private: only you can see your companies.\n\n') +
            'Create your Ledger Desk account here (the link works once, until ' + until + '):\n' + link + '\n\n' +
            (coNames.length ? 'The companies show up in the company list at the top left once you\'re signed in. ' : '') +
            'After that, sign in any time at ' + base + ' (bookmark it).\n';
          let sent = '', sendErr = '';
          if (email && mailFrom()) {
            try { await SV.post('/api/admin/invite/email', { id: r.id, to: email, subject: coNames.length ? 'Ledger Desk: ' + coNames.join(', ') + ' shared with you' : 'Your Ledger Desk invite', text: msg }); sent = email; }
            catch (e) { sendErr = e.message; }
          }
          modal(`<h2>${sent ? 'Invite sent ✓' : 'Invite ready'}</h2>
            ${sent ? '<div class="notice" style="background:var(--accent-soft)">Emailed to <b>' + esc(sent) + '</b> from ' + esc(mailFrom()) + '. Ask them to check their spam folder if it doesn\'t arrive in a few minutes. The message below is a copy.</div>' : ''}
            ${sendErr ? '<div class="notice">' + esc(sendErr) + ' Copy the message below and send it yourself instead.</div>' : ''}
            <p class="small muted" style="margin-top:0">Send this to ${esc(name || 'them')}. The link is shown only now. If it gets lost, cancel it and make a new one.${coNames.length ? ' Keep Ledger Desk open now and then: your browser hands them the company keys after they sign up.' : ''}</p>
            <textarea id="iMsg" readonly style="width:100%;min-height:230px;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:10px;font-size:13px">${esc(msg)}</textarea>
            <div class="actions"><button class="btn" id="iCopyLink">Copy link only</button><a class="btn" id="iMail" href="mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Your Ledger Desk invite')}&body=${encodeURIComponent(msg)}">Email it…</a><button class="btn primary" id="iCopy">Copy message</button></div>`, c => {
            const copy = (t, what) => navigator.clipboard.writeText(t).then(() => toast(what + ' copied'), () => { c.querySelector('#iMsg').select(); toast('Press Ctrl+C to copy'); });
            c.querySelector('#iCopy').onclick = () => copy(msg, 'Message');
            c.querySelector('#iCopyLink').onclick = () => copy(link, 'Link');
            c.querySelector('#iMail').style.textDecoration = 'none';
            c.querySelector('#iMail').style.color = 'inherit';
          });
          loadUsers();
        } catch (e) { card.querySelector('#iErr').textContent = e.message; makeBtn.disabled = false; makeBtn.textContent = mailFrom() && emailIn.value.trim() ? 'Send invite' : 'Make invite link'; }
      };
    });
  }
  acts.uInvite = () => inviteModal({});
  const genPw = () => { const c = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; const a = new Uint32Array(12); crypto.getRandomValues(a); a.forEach(v => s += c[v % c.length]); return s.slice(0, 6) + '-' + s.slice(6); };
  acts.uReset = b => {
    const username = b.closest('tr').dataset.user, tmp = genPw();
    if (username === me.username) { pwModal(false); return; }
    modal(`<h2>Reset password for ${esc(username)}</h2>
      <p class="muted small" style="margin-top:0">This lets them sign in again with a temporary password. <b>Their books stay locked</b> until they type the recovery code they saved when they made their account. You can't unlock them, and neither can anyone else. Without the code, they start over with empty books.</p>
      <label class="field">Temporary password<input type="text" id="rPw" value="${tmp}" spellcheck="false"></label><p class="small" id="rErr" style="color:var(--neg)"></p>
      <div class="actions"><button class="btn" id="rCancel">Cancel</button><button class="btn primary" id="rSave">Reset password</button></div>`, card => {
      card.querySelector('#rCancel').onclick = closeModal;
      card.querySelector('#rSave').onclick = async () => {
        const pw = card.querySelector('#rPw').value;
        if (pw.length < 10) { card.querySelector('#rErr').textContent = 'Use at least 10 characters.'; return; }
        try { await SV.post('/api/admin/reset', { username, auth: await window.LDVault.authFor(username, pw) }); closeModal(); toast('Password reset for ' + username + '. Tell them the temporary password; they\'ll need their recovery code.'); loadUsers(); }
        catch (e) { card.querySelector('#rErr').textContent = e.message; }
      };
    });
  };
  acts.uToggle = async b => {
    const username = b.closest('tr').dataset.user, u = US.list.find(x => x.username === username);
    if (!u.disabled && !(await L.confirmBox('Turn off ' + u.name + '\'s login?', 'They won\'t be able to sign in. Their books are kept, and you can turn the login back on any time.', 'Turn off', true))) return;
    try { await SV.post('/api/admin/disable', { username, disabled: !u.disabled }); toast(u.disabled ? 'Login turned on' : 'Login turned off'); loadUsers(); } catch (e) { toast(e.message); }
  };

  // ----- Company & Backup: bring companies over from the desktop app -----
  const baseSettings = views.settings;
  views.settings = () => baseSettings() + `<div class="panel" style="margin-top:16px"><h2>Bring companies from the desktop app</h2>
    <p class="muted small" style="margin-top:0">On the PC that has the desktop Ledger Desk, open <b>Documents\\Ledger Desk\\Companies</b>. Pick one or more company files (.json) here and each becomes a company in your login, locked with your key. The originals aren't changed (delete them afterwards if others can see that PC). A backup file saved with "Save backup file…" works too.</p>
    <label class="btn" for="upCo">Choose company files…</label><input type="file" id="upCo" accept=".json" multiple hidden><span class="small muted" id="upMsg" style="margin-left:10px"></span></div>`;
  const baseAfter = afterRender.settings;
  afterRender.settings = () => {
    if (baseAfter) baseAfter();
    $('#upCo').addEventListener('change', async e => {
      const files = Array.from(e.target.files), done = [], bad = [];
      $('#upMsg').innerHTML = '<span class="spin"></span>Uploading…';
      await SV.flushed();
      for (const f of files) {
        try {
          const text = await f.text(), d = JSON.parse(text);
          if (!d || !Array.isArray(d.accounts) || !Array.isArray(d.txns)) throw new Error('not a Ledger Desk company file');
          const name = d.company || f.name.replace(/\.json$/i, '').replace(/^LedgerDesk-backup-/, '');
          d.company = name;
          await SV.createLocked(SV.newFile(), JSON.stringify(d, null, 1));
          done.push(name);
        } catch (err) { bad.push(f.name + ': ' + err.message); }
      }
      e.target.value = '';
      $('#upMsg').textContent = '';
      modal(`<h2>${done.length ? 'Companies added' : 'Nothing added'}</h2>${done.length ? '<p>' + done.map(esc).join('<br>') + '</p>' : ''}${bad.length ? '<p class="small" style="color:var(--neg)">' + bad.map(esc).join('<br>') + '</p>' : ''}
        <p class="small muted">Pick a company at the top left to open it.</p><div class="actions"><button class="btn primary" id="upOk">OK</button></div>`, c => {
        c.querySelector('#upOk').onclick = () => { closeModal(); if (done.length) location.reload(); };
      });
    });
  };
  // ----- company files waiting on the server (put there by the owner or Claude) -----
  const IMP = { files: [] };
  async function checkImports() { try { IMP.files = (await SV.api('/api/import/list')).files; } catch (e) { IMP.files = []; } if (IMP.files.length) { if (L.view === 'settings') L.render(); toast(IMP.files.length + ' company file' + (IMP.files.length === 1 ? ' is' : 's are') + ' waiting to come in.', 'Bring them in', () => acts.impBring()); } }
  checkImports();
  const baseSettings2 = views.settings;
  views.settings = () => (IMP.files.length ? `<div class="notice" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span><b>${IMP.files.length} company file${IMP.files.length === 1 ? ' is' : 's are'} waiting to come in</b> (${IMP.files.map(f => esc(f.name.replace(/\.json$/i, ''))).join(', ')}). They'll be locked with your key, and the plain copies on the server are removed.</span><button class="btn primary" data-act="impBring">Bring them in</button></div>` : '') + baseSettings2();
  acts.impBring = async () => {
    const have = new Set(window.ledgerFile.companies.list().list.map(c => String(c.name).toLowerCase()));
    const done = [], skipped = [], bad = [];
    await SV.flushed();
    SV.banner('Bringing in companies…', 'info');
    for (const f of IMP.files) {
      try {
        const { text } = await SV.api('/api/import/file?name=' + encodeURIComponent(f.name));
        const d = JSON.parse(text);
        if (!d || !Array.isArray(d.accounts) || !Array.isArray(d.txns)) throw new Error('not a Ledger Desk company file');
        const name = d.company || f.name.replace(/\.json$/i, '');
        if (have.has(name.toLowerCase())) { skipped.push(name); continue; }
        d.company = name;
        await SV.createLocked(SV.newFile(), JSON.stringify(d, null, 1));
        await SV.post('/api/import/done', { name: f.name });
        have.add(name.toLowerCase());
        done.push(name + ' (' + d.txns.length + ' transactions)');
      } catch (e) { bad.push(f.name + ': ' + e.message); }
    }
    SV.banner(null);
    modal(`<h2>${done.length ? 'Companies brought in' : 'Nothing brought in'}</h2>${done.length ? '<p>' + done.map(esc).join('<br>') + '</p>' : ''}
      ${skipped.length ? '<p class="small">Already here, so skipped (the waiting copy was left on the server): ' + skipped.map(esc).join(', ') + '</p>' : ''}
      ${bad.length ? '<p class="small" style="color:var(--neg)">' + bad.map(esc).join('<br>') + '</p>' : ''}
      <p class="small muted">Pick a company at the top left to open it.</p><div class="actions"><button class="btn primary" id="impOk">OK</button></div>`, c => {
      c.querySelector('#impOk').onclick = () => { closeModal(); location.reload(); };
    });
  };
  // ----- Sharing screen: share companies with partners and accountants -----
  const SH = { file: null, members: null, err: '', all: null };
  const ROLE_LABEL = { edit: 'Can edit', view: 'View only' };
  const nav = $('#nav'), setBtn = nav.querySelector('[data-view="settings"]');
  const shBtn = document.createElement('button'); shBtn.dataset.view = 'share'; shBtn.textContent = 'Sharing';
  setBtn.insertAdjacentElement('beforebegin', shBtn);
  async function loadShare(file) {
    SH.file = file; SH.members = null; SH.err = '';
    try { SH.members = (await SV.share.list(file)).members; } catch (e) { SH.err = /not found/i.test(e.message) ? 'Add something to this company first (for example import a statement), then you can share it.' : e.message; SH.members = []; }
    if (L.view === 'share') L.render();
  }
  async function loadAll() {
    const mine = SV.companies().filter(x => x.role === 'owner'), all = {};
    for (const x of mine) { try { all[x.file] = (await SV.share.list(x.file)).members; } catch (e) { all[x.file] = []; } }
    SH.all = all; if (L.view === 'share') L.render();
  }
  const people = ms => ms && ms.length ? ms.map(m => esc(m.name) + ' <span class="muted small">(' + (m.pending ? 'waiting for sign-up' : ROLE_LABEL[m.role].toLowerCase()) + ')</span>').join(', ') : '<span class="muted small">only you</span>';
  views.share = () => {
    const c = SV.current(), mine = SV.companies().filter(x => x.role === 'owner'), fromOthers = SV.companies().filter(x => x.role !== 'owner');
    if (c.role === 'owner' && SH.file !== c.file) loadShare(c.file);
    if (!SH.all) { SH.all = {}; loadAll(); }
    const users = (US.list || []).filter(u => !u.disabled && u.username !== me.username);
    const waiting = SV.share.waitingIn;
    let top;
    if (c.role !== 'owner') {
      top = `<div class="panel" style="border-color:var(--accent)"><h2>🤝 ${esc(c.plainName || L.S.company)} is shared with you</h2>
        <p style="margin:0 0 10px"><b>${esc(c.ownerName || c.owner)}</b> owns this company. Your access: <b>${ROLE_LABEL[c.role] || c.role}</b>${c.role === 'view' ? ': you can look, run reports and ask the AI, but changes aren\'t saved.' : ': you can work on these books, and your changes are saved for everyone with access.'}</p>
        <button class="btn danger" data-act="shLeave">Leave this company</button></div>`;
    } else {
      top = `<div class="panel"><h2>Who can open ${esc(L.S.company)}</h2>
      <p class="muted small" style="margin-top:0">Share with a partner or accountant. They work in the same books from their own login and see only the companies you share. The company stays locked: your browser hands them its key, and nobody else can open it.</p>
      ${SH.err ? '<div class="notice">' + esc(SH.err) + '</div>' : ''}
      ${SH.members && SH.members.length ? `<div class="table-wrap"><table><thead><tr><th>Person</th><th>Access</th><th>Since</th><th></th></tr></thead><tbody>
        ${SH.members.map(m => `<tr data-user="${esc(m.username)}"><td>${esc(m.name)} <span class="muted small">(${esc(m.username)})</span>${m.pending ? ' <span class="chip">waiting for them to sign up</span>' : ''}${m.disabled ? ' <span class="chip">login turned off</span>' : ''}</td>
          <td><select data-sh-role aria-label="Access"><option value="edit"${m.role === 'edit' ? ' selected' : ''}>Can edit</option><option value="view"${m.role === 'view' ? ' selected' : ''}>View only</option></select></td>
          <td class="small">${m.added ? esc(new Date(m.added).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : ''}</td>
          <td style="text-align:right"><button class="btn sm danger" data-act="shRemove">Remove access</button></td></tr>`).join('')}
        </tbody></table></div>` : SH.members ? (SH.err ? '' : '<p class="small muted">Only you can open this company right now.</p>') : '<p class="small muted"><span class="spin"></span>Loading…</p>'}
      <h3 style="font-size:13px;margin:16px 0 6px">Share with someone who already has a login</h3>
      <div class="form-row">
        <label class="field">Their user name<input type="text" id="shUser" list="shUsers" autocapitalize="off" spellcheck="false" placeholder="user name" style="min-width:200px"></label>
        <datalist id="shUsers">${users.map(u => `<option value="${esc(u.username)}">${esc(u.name)}</option>`).join('')}</datalist>
        <label class="field">Access<select id="shRole"><option value="edit">Can edit (partner, accountant)</option><option value="view">View only</option></select></label>
        <button class="btn primary" data-act="shAdd">Share ${esc(L.S.company)}</button>
        ${mine.length > 1 ? `<button class="btn" data-act="shAddAll">Share all ${mine.length} of my companies</button>` : ''}
      </div>
      ${me.admin ? `<h3 style="font-size:13px;margin:16px 0 6px">Share with someone new</h3><p class="small muted" style="margin:0 0 8px">Makes an invite link. You choose the companies; they open for the person as soon as they create their account.</p><button class="btn" data-act="shInvite">Invite someone new and share…</button>` : '<p class="small muted" style="margin-top:12px">To share with someone who has no login yet, ask the owner of this server to invite them.</p>'}
      <p class="small muted" style="margin:14px 0 0"><b>Remove access</b> works right away and gives the company a new key, so their old key stops working. Anything they already saw or exported, they keep.</p></div>`;
    }
    return `<div class="page-head"><div><h1>Sharing</h1><p class="sub">Work on the same books with partners and accountants. Pick a company at the top left to change who can open it.</p></div></div>
      ${waiting.length ? '<div class="notice">' + esc(Array.from(new Set(waiting)).join(', ')) + ' is sharing ' + (waiting.length === 1 ? 'a company' : waiting.length + ' companies') + ' with you. ' + (waiting.length === 1 ? 'It appears' : 'They appear') + ' here after they next open Ledger Desk.</div>' : ''}
      ${top}
      ${mine.length ? `<div class="panel" style="margin-top:16px;padding:0"><div style="padding:16px 16px 4px"><h2 style="margin:0">Your companies</h2></div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Shared with</th><th></th></tr></thead><tbody>
        ${mine.map(x => `<tr data-file="${esc(x.file)}"><td>${esc(x.plainName || x.name)}${x.file === c.file ? ' <span class="chip cc">open</span>' : ''}</td><td>${SH.all && SH.all[x.file] ? people(SH.all[x.file]) : '<span class="spin"></span>'}</td><td style="text-align:right">${x.file === c.file ? '' : '<button class="btn sm" data-act="shOpen">Open to share</button>'}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
      ${fromOthers.length ? `<div class="panel" style="margin-top:16px;padding:0"><div style="padding:16px 16px 4px"><h2 style="margin:0">Shared with you</h2></div><div class="table-wrap"><table><thead><tr><th>Company</th><th>Owner</th><th>Your access</th><th></th></tr></thead><tbody>
        ${fromOthers.map(x => `<tr data-file="${esc(x.file)}"><td>${esc(x.plainName || x.name)}${x.file === c.file ? ' <span class="chip cc">open</span>' : ''}</td><td>${esc(x.ownerName || x.owner)}</td><td>${ROLE_LABEL[x.role] || x.role}</td><td style="text-align:right">${x.file === c.file ? '' : '<button class="btn sm" data-act="shOpen">Open</button>'}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
  };
  afterRender.share = () => {
    document.querySelectorAll('[data-sh-role]').forEach(sel => sel.addEventListener('change', async e => {
      e.stopPropagation();
      const username = sel.closest('tr').dataset.user;
      try { await SV.share.role(SV.current().file, username, sel.value); toast(username + ' now has ' + ROLE_LABEL[sel.value].toLowerCase() + ' access'); loadShare(SV.current().file); loadAll(); } catch (x) { toast(x.message); }
    }));
  };
  // Company & Backup: hide "Erase all data" for companies you don't own, and point to Sharing
  const baseSettings3 = views.settings;
  views.settings = () => {
    let h = baseSettings3();
    const c = SV.current();
    if (c.role !== 'owner') h = h.replace('<button class="btn danger" data-act="wipe">Erase all data…</button>', '<p class="small muted">Only the owner can erase this company.</p>');
    return (c.role !== 'owner' ? `<div class="notice" style="background:var(--accent-soft)">🤝 ${esc(c.ownerName || c.owner)} shared this company with you (${(ROLE_LABEL[c.role] || '').toLowerCase()}). <button class="link" data-act="goto" data-v="share">Sharing</button></div>` : '') + h;
  };
  if (me.admin && !US.list) loadUsers();
  acts.shOpen = b => window.ledgerFile.companies.switchTo(b.closest('tr').dataset.file);
  acts.shInvite = () => inviteModal({ withShare: true, file: SV.current().file });
  acts.shAdd = async () => {
    const username = $('#shUser').value.trim(), role = $('#shRole').value;
    if (!username) { toast('Type their user name'); return; }
    try { const u = await SV.share.add(SV.current().file, username, role); toast('Shared ' + L.S.company + ' with ' + u.name + ' (' + ROLE_LABEL[role].toLowerCase() + ')'); loadShare(SV.current().file); loadAll(); }
    catch (e) { toast(e.message); }
  };
  acts.shAddAll = async () => {
    const username = $('#shUser').value.trim(), role = $('#shRole').value;
    if (!username) { toast('Type their user name first'); return; }
    const mine = SV.companies().filter(x => x.role === 'owner');
    if (!(await L.confirmBox('Share all ' + mine.length + ' companies?', username + ' will get ' + ROLE_LABEL[role].toLowerCase() + ' access to: ' + mine.map(x => x.plainName || x.name).join(', ') + '. You can remove access to any of them later.', 'Share all'))) return;
    SV.banner('Sharing…', 'info');
    const done = [], bad = [];
    for (const x of mine) { try { await SV.share.add(x.file, username, role); done.push(x.plainName || x.name); } catch (e) { bad.push((x.plainName || x.name) + ': ' + e.message); if (/no other login|needs to sign in/.test(e.message)) break; } }
    SV.banner(null);
    modal(`<h2>${done.length ? 'Shared' : 'Not shared'}</h2>${done.length ? '<p>' + esc(username) + ' can now open (' + ROLE_LABEL[role].toLowerCase() + '):<br>' + done.map(esc).join('<br>') + '</p>' : ''}${bad.length ? '<p class="small" style="color:var(--neg)">' + bad.map(esc).join('<br>') + '</p>' : ''}<div class="actions"><button class="btn primary" id="shOk">OK</button></div>`, c => { c.querySelector('#shOk').onclick = closeModal; });
    loadShare(SV.current().file); loadAll();
  };
  acts.shRemove = async b => {
    const username = b.closest('tr').dataset.user;
    if (!(await L.confirmBox('Remove ' + username + '\'s access to ' + L.S.company + '?', 'They won\'t be able to open it any more. The company gets a new key right away. Anything they already saw or exported, they keep.', 'Remove access', true))) return;
    SV.banner('Removing access and re-locking ' + L.S.company + '…', 'info');
    try { await SV.share.remove(SV.current().file, username); SV.banner(null); toast(username + ' can no longer open ' + L.S.company); }
    catch (e) { SV.banner(null); toast(e.message); }
    loadShare(SV.current().file); loadAll();
  };
  acts.shLeave = async () => {
    const c = SV.current();
    if (!(await L.confirmBox('Leave ' + (c.plainName || L.S.company) + '?', 'You won\'t be able to open it any more unless ' + (c.ownerName || c.owner) + ' shares it with you again. Their books are not changed.', 'Leave', true))) return;
    try { await SV.share.leave(c.file); const other = SV.companies().find(x => x.file !== c.file); if (other) window.ledgerFile.companies.switchTo(other.file); else location.reload(); } catch (e) { toast(e.message); }
  };
  if (L.view === 'settings') L.render();
})();
