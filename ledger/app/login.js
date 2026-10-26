(function () {
  'use strict';
  const $ = id => document.getElementById(id), V = window.LDVault;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let mode = 'login';
  const code = location.pathname === '/invite' ? new URLSearchParams(location.search).get('code') || '' : '';
  const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LD': '1' }, body: JSON.stringify(body) })
    .then(async r => { let d = {}; try { d = await r.json(); } catch (e) {} if (!r.ok) throw new Error(d.error || 'Could not reach the server'); return d; });
  function newPassword(btn, sub) {
    $('pw2Row').hidden = false; $('tip').hidden = true; $('lockNote').hidden = false; $('go').textContent = btn; $('pw').autocomplete = 'new-password'; $('sub').textContent = sub;
    $('pw').parentElement.firstChild.textContent = 'Password (at least 10 characters)';
    $('user').placeholder = 'letters or numbers, e.g. raj';
  }
  if (!window.crypto || !crypto.subtle || !window.CompressionStream) {
    $('f').innerHTML = '<p class="err">This browser is too old for Ledger Desk\'s locked books. Use a current Microsoft Edge or Google Chrome, and open the https:// address (not http://).</p>';
    return;
  }
  async function start() {
    if (code) {
      try {
        const d = await post('/api/invite/check', { code });
        mode = 'invite'; $('invite').hidden = false; newPassword('Create my account', 'Invitation');
        if (d.name) { $('iName').value = d.name; $('invMsg').textContent = 'Hi ' + d.name + '! You were invited to use Ledger Desk. Your books are private: only you can see your companies.'; }
        $('invMsg').textContent += ' This invite works once and expires ' + new Date(d.expires).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + '.';
        ($('iName').value ? $('iCo') : $('iName')).focus();
      } catch (e) { $('err').textContent = e.message; $('user').focus(); }
      return;
    }
    try {
      const d = await fetch('/api/setup-needed', { credentials: 'same-origin' }).then(r => r.json());
      if (d.needed) { mode = 'setup'; $('setup').hidden = false; newPassword('Create my login', 'First-time setup'); $('name').focus(); }
      else $('user').focus();
    } catch (e) { $('err').textContent = 'Could not reach the Ledger Desk server.'; }
  }
  start();

  // ----- show the recovery code once -----
  function showRecovery(rec, username, note) {
    $('f').onsubmit = e => e.preventDefault();
    $('f').innerHTML = `<div class="brand"><div class="mark" aria-hidden="true"><span></span><span></span><span></span></div><div><div class="brand-name">Ledger Desk</div><div class="brand-co" style="color:var(--muted)">${esc(username)}</div></div></div>
      <h1 style="font-size:19px">Save your recovery code</h1>
      <p class="muted small" style="margin:6px 0 0">${note || 'Your books are locked with your password.'} If you ever forget your password, <b>only this code can unlock your books</b> (use "Forgot your password?" on the sign-in page). Nobody else has it, not even the owner of the server, and it won't be shown again.</p>
      <div class="code" id="rc">${esc(rec)}</div>
      <div class="row2"><button class="btn" type="button" id="rcCopy">Copy</button><button class="btn" type="button" id="rcSave">Save as a file</button></div>
      <p class="small" style="margin:12px 0 4px"><b>Email it to yourself</b> (it opens your own email with the code filled in; the server never sees it):</p>
      <div class="row2"><a class="btn" id="rcGmail" target="_blank" rel="noopener" style="text-align:center;text-decoration:none;color:inherit">Gmail</a><a class="btn" id="rcOutlook" target="_blank" rel="noopener" style="text-align:center;text-decoration:none;color:inherit">Outlook</a><a class="btn" id="rcMail" style="text-align:center;text-decoration:none;color:inherit">Mail app</a></div>
      <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" class="check" id="rcOk"> I saved it (written down, emailed to myself, or in a file that's not on this server).</label>
      <button class="btn primary" type="button" id="rcGo" disabled>Open Ledger Desk</button>`;
    $('rcCopy').onclick = () => navigator.clipboard.writeText(rec).then(() => { $('rcCopy').textContent = 'Copied'; });
    $('rcSave').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['Ledger Desk recovery code for ' + username + '\r\n\r\n' + rec + '\r\n\r\nKeep this somewhere safe. It is the only way to unlock your books if you forget your password.\r\n'], { type: 'text/plain' }));
      a.download = 'Ledger Desk recovery code - ' + username + '.txt'; document.body.appendChild(a); a.click(); a.remove();
    };
    { const m = V.recoveryMail(username, rec); $('rcGmail').href = m.gmail; $('rcOutlook').href = m.outlook; $('rcMail').href = m.mailto; }
    $('rcOk').onchange = () => { $('rcGo').disabled = !$('rcOk').checked; };
    $('rcGo').onclick = () => { location.href = '/'; };
  }

  // ----- after a password reset: unlock with the recovery code -----
  function showRecover(username, tempAuth, vault) {
    mode = 'recover';
    $('f').innerHTML = `<div class="brand"><div class="mark" aria-hidden="true"><span></span><span></span><span></span></div><div><div class="brand-name">Ledger Desk</div><div class="brand-co" style="color:var(--muted)">${esc(username)}</div></div></div>
      <h1 style="font-size:19px">Unlock your books</h1>
      <p class="muted small" style="margin:6px 0 0">Your password was reset. Type the recovery code you saved when you made your account, then choose a new password.</p>
      <label class="field">Recovery code<input type="text" id="rCode" autocomplete="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" style="font-family:var(--f-num)"></label>
      <label class="field">New password (at least 10 characters)<input type="password" id="rPw" autocomplete="new-password"></label>
      <label class="field">New password again<input type="password" id="rPw2" autocomplete="new-password"></label>
      <p class="err" id="err" role="alert"></p>
      <button class="btn primary" id="go" type="submit">Unlock and save new password</button>
      <p class="tip"><button class="link" type="button" id="lost">I lost my recovery code</button></p>`;
    const err = m => { $('err').textContent = m; $('go').disabled = false; $('go').textContent = 'Unlock and save new password'; };
    const pwOk = () => { const p = $('rPw').value; if (p !== $('rPw2').value) { err('The two passwords are not the same.'); return null; } const bad = V.passwordProblem(p); if (bad) { err(bad); return null; } return p; };
    $('f').onsubmit = async e => {
      e.preventDefault(); $('err').textContent = '';
      const pw = pwOk(); if (!pw) return;
      $('go').disabled = true; $('go').textContent = 'Unlocking…';
      let dek; try { dek = await V.unlockWithRecovery(vault, $('rCode').value); } catch (x) { return err('That recovery code isn\'t right. Check it and try again.'); }
      try {
        await post('/api/password', { old: tempAuth, auth: await V.authFor(username, pw), vaultPw: await V.passwordWrap(dek, pw) });
        await V.keepKey(username, dek); location.href = '/';
      } catch (x) { err(x.message); }
    };
    $('lost').onclick = async () => {
      $('err').textContent = '';
      const pw = pwOk(); if (!pw) { if (!$('rPw').value) err('First type a new password above, then click "I lost my recovery code" again.'); return; }
      if (!confirm('Without the recovery code, your old books can\'t be unlocked by anyone. They will be set aside (not deleted) and you\'ll start with empty books. Continue?')) return;
      try {
        const nv = await V.newVault(pw);
        await post('/api/vault/restart', { old: tempAuth, auth: await V.authFor(username, pw), recAuth: await V.recAuthFor(username, nv.recovery), vault: nv.vault });
        await V.keepKey(username, nv.dek);
        showRecovery(nv.recovery, username, 'You have a new key.');
      } catch (x) { err(x.message); }
    };
    $('rCode').focus();
  }

  function showForgot() {
    mode = 'recover';
    const typed = $('user').value;
    $('f').innerHTML = `<div class="brand"><div class="mark" aria-hidden="true"><span></span><span></span><span></span></div><div><div class="brand-name">Ledger Desk</div><div class="brand-co" style="color:var(--muted)">Forgot your password</div></div></div>
      <h1 style="font-size:19px">Reset with your recovery code</h1>
      <p class="muted small" style="margin:6px 0 0">Type the recovery code you saved when you made your account, then choose a new password. Your books stay exactly as they are.</p>
      <label class="field">User name<input type="text" id="fUser" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(typed)}"></label>
      <label class="field">Recovery code<input type="text" id="rCode" autocomplete="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" style="font-family:var(--f-num)"></label>
      <label class="field">New password (at least 10 characters)<input type="password" id="rPw" autocomplete="new-password"></label>
      <label class="field">New password again<input type="password" id="rPw2" autocomplete="new-password"></label>
      <p class="err" id="err" role="alert"></p>
      <button class="btn primary" id="go" type="submit">Save new password</button>
      <p class="tip">Lost the recovery code too? Ask the owner to reset your password. Without the code your old books can't be unlocked, and you'll start with empty books.<br><a href="/login">Back to sign in</a></p>`;
    const err = m => { $('err').textContent = m; $('go').disabled = false; $('go').textContent = 'Save new password'; };
    $('f').onsubmit = async e => {
      e.preventDefault(); $('err').textContent = '';
      const username = $('fUser').value.trim().toLowerCase(), pw = $('rPw').value;
      if (pw !== $('rPw2').value) return err('The two passwords are not the same.');
      const bad = V.passwordProblem(pw); if (bad) return err(bad);
      $('go').disabled = true; $('go').textContent = 'Checking…';
      try {
        const recAuth = await V.recAuthFor(username, $('rCode').value);
        const r = await post('/api/recover/check', { username, recAuth });
        const dek = await V.unlockWithRecovery({ rec: r.rec }, $('rCode').value);
        await post('/api/recover', { username, recAuth, auth: await V.authFor(username, pw), vaultPw: await V.passwordWrap(dek, pw) });
        await V.keepKey(username, dek); location.href = '/';
      } catch (x) { err(x.message === 'wrong' ? 'That recovery code isn\'t right.' : x.message); }
    };
    ($('fUser').value ? $('rCode') : $('fUser')).focus();
  }
  $('forgot').onclick = showForgot;

  // Two-step sign-in: after the password, a 6-digit code (email or authenticator app)
  async function finishSignIn(r, username, pw, auth) {
    if (!r.vault) throw new Error('This login has no key yet. Ask the owner for a new invite.');
    if (r.needRecovery) { showRecover(username, auth, r.vault); return; }
    let dek; try { dek = await V.unlockWithPassword(r.vault, pw); } catch (x) { throw new Error('Your books could not be unlocked with this password.'); }
    await V.keepKey(username, dek);
    location.href = '/';
  }
  function show2fa(r, username, pw, auth) {
    mode = '2fa';
    let method = r.need2fa, ticket = r.ticket;
    const head = `<div class="brand"><div class="mark" aria-hidden="true"><span></span><span></span><span></span></div><div><div class="brand-name">Ledger Desk</div><div class="brand-co" style="color:var(--muted)">${esc(username)}</div></div></div><h1 style="font-size:19px">Two-step sign-in</h1>`;
    const codeForm = (msg) => {
      $('f').innerHTML = head + `<p class="muted small" style="margin:6px 0 0">${msg}</p>
        <label class="field">6-digit code<input type="text" id="tCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" style="font-family:var(--f-num);font-size:20px;letter-spacing:4px"></label>
        <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" class="check" id="tTrust"> Trust this device for 30 days (don't use on a shared computer)</label>
        <p class="err" id="err" role="alert"></p>
        <button class="btn primary" id="go" type="submit">Verify and sign in</button>
        <p class="tip">${method === 'email' ? '<button class="link" type="button" id="tResend">Send a new code</button>' : r.canEmail ? '<button class="link" type="button" id="tResend">Email me a code instead</button>' : 'Lost your phone? Use "Forgot your password?" with your recovery code, or ask the owner to reset two-step sign-in.'}</p>`;
      $('tCode').focus();
      const rs = $('tResend'); if (rs) rs.onclick = async () => { $('err').textContent = ''; try { const x = await post('/api/login/2fa/email', { ticket }); method = 'email'; codeForm('We emailed a new 6-digit code to <b>' + esc(x.to) + '</b>. It works for 10 minutes.'); } catch (x) { $('err').textContent = x.message; } };
    };
    const emailForm = () => {
      $('f').innerHTML = head + `<p class="muted small" style="margin:6px 0 0">This Ledger Desk asks for a code from your email each time you sign in on a new device. Type your email address and we'll send you a code.</p>
        <label class="field">Your email<input type="email" id="tEmail" autocomplete="email" placeholder="you@gmail.com"></label>
        <p class="err" id="err" role="alert"></p><button class="btn primary" id="go" type="submit">Send me a code</button>`;
      $('tEmail').focus();
    };
    if (method === 'setup') emailForm();
    else codeForm(method === 'email' ? 'We emailed a 6-digit code to <b>' + esc(r.to) + '</b>. It works for 10 minutes. Check spam if you don\'t see it.' : 'Open your authenticator app (Google Authenticator, Microsoft Authenticator…) and type the 6-digit code for <b>Ledger Desk</b>.');
    $('f').onsubmit = async e => {
      e.preventDefault(); $('err').textContent = ''; const go = $('go'), label = go.textContent; go.disabled = true;
      try {
        if ($('tEmail')) { const x = await post('/api/login/2fa/email', { ticket, email: $('tEmail').value }); codeForm('We emailed a 6-digit code to <b>' + esc(x.to) + '</b>. It works for 10 minutes. Check spam if you don\'t see it.'); return; }
        go.textContent = 'Checking…';
        const r2 = await post('/api/login/2fa', { ticket, code: $('tCode').value, trust: $('tTrust').checked });
        go.textContent = 'Unlocking your books…';
        await finishSignIn(r2, username, pw, auth);
      } catch (x) { if ($('err')) $('err').textContent = x.message; if (/Sign in again/.test(x.message)) setTimeout(() => location.reload(), 2500); go.disabled = false; go.textContent = label; }
    };
  }

  $('f').addEventListener('submit', async e => {
    if (mode === 'recover' || mode === '2fa') return;
    e.preventDefault();
    $('err').textContent = ''; $('go').disabled = true;
    const label = $('go').textContent;
    try {
      const username = $('user').value.trim().toLowerCase(), pw = $('pw').value;
      if (mode !== 'login') {
        if (pw !== $('pw2').value) throw new Error('The two passwords are not the same.');
        const bad = V.passwordProblem(pw); if (bad) throw new Error(bad);
        $('go').textContent = 'Making your key…';
        const nv = await V.newVault(pw), auth = await V.authFor(username, pw), recAuth = await V.recAuthFor(username, nv.recovery);
        if (mode === 'setup') await post('/api/setup', { name: $('name').value, username, auth, recAuth, vault: nv.vault });
        else await post('/api/invite/accept', { code, name: $('iName').value, username, auth, recAuth, vault: nv.vault });
        await V.keepKey(username, nv.dek);
        if (mode === 'invite' && $('iCo').value.trim()) try { sessionStorage.setItem('ld-newco', $('iCo').value.trim()); } catch (x) {}
        showRecovery(nv.recovery, username, mode === 'setup' ? 'Your books are locked with your password.' : '');
        return;
      }
      $('go').textContent = 'Signing in…';
      const auth = await V.authFor(username, pw);
      const r = await post('/api/login', { username, auth });
      if (r.need2fa) { show2fa(r, username, pw, auth); return; }
      $('go').textContent = 'Unlocking your books…';
      await finishSignIn(r, username, pw, auth);
    } catch (err) { $('err').textContent = err.message; $('go').disabled = false; $('go').textContent = label; }
  });
})();
