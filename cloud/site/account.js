/* /account — profile, password, two-step sign-in, signed-in devices and my stores. Uses the same server calls as Ledger Desk. */
(function () {
  'use strict';
  var V = window.LDVault, app = document.getElementById('app'), me = null, tfa = null, sessions = [], stores = [];
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ROLE = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', reports: 'Reports only' };
  function api(method, path, body) {
    return fetch(path, { method: method, credentials: 'same-origin', headers: body !== undefined ? { 'x-ld': '1', 'Content-Type': 'application/json' } : { 'x-ld': '1' }, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'The server said ' + r.status); e.status = r.status; throw e; } return d; }); });
  }
  var when = function (t) { return t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never'; };
  var note = {};   // messages shown under each box
  function msg(k, ok) { return note[k] ? '<p class="' + (ok || note[k + '_ok'] ? 'ok' : 'err') + '" role="status">' + esc(note[k]) + '</p>' : ''; }

  function view() {
    var tfaOn = tfa && tfa.method;
    app.innerHTML =
      '<div class="two"><div>' +
      '<div class="card"><h2>Profile</h2><dl class="kv"><dt>Name</dt><dd>' + esc(me.name) + '</dd><dt>User name</dt><dd>' + esc(me.username) + '</dd><dt>Email</dt><dd>' + (me.email ? esc(me.email) : '<span style="color:var(--muted);font-weight:500">Not set. Turning on two-step sign-in by email saves it.</span>') + '</dd><dt>Account type</dt><dd>' + (me.admin ? 'Site owner' : me.posOnly ? 'Store back office' : 'Standard') + '</dd></dl></div>' +
      '<div class="card"><h2>Change password</h2><p>The same password is used for the Store POS back office, Ledger Desk and PdfStudio. Your other devices are signed out when you change it.</p>' +
      '<label class="lbl" for="pOld">Current password</label><input class="f" id="pOld" type="password" autocomplete="current-password">' +
      '<label class="lbl" for="pNew">New password (at least 10 characters)</label><input class="f" id="pNew" type="password" autocomplete="new-password">' +
      '<label class="lbl" for="pNew2">New password again</label><input class="f" id="pNew2" type="password" autocomplete="new-password">' +
      msg('pw') + '<div class="row" style="margin-top:14px"><button class="btn pri sm" id="pSave">Save new password</button></div></div>' +
      '<div class="card"><h2>Two-step sign-in</h2>' + tfaBox(tfaOn) + '</div>' +
      '</div><div>' +
      '<div class="card"><h2>My stores</h2>' + storesBox() + '</div>' +
      '<div class="card"><h2>Signed-in devices</h2><p>Everywhere you are signed in right now. If you see one you don\'t know, sign it out and change your password.</p>' + devicesBox() + msg('dev') + '</div>' +
      '</div></div>';
    bind();
  }
  function tfaBox(on) {
    var s = '<p>' + (on ? '<span class="pill g">On</span> ' + (tfa.method === 'app' ? 'Codes come from your authenticator app.' : 'A code is emailed to ' + esc(tfa.email || 'you') + '.') : '<span class="pill w">Off</span> Add a 6-digit code to your sign-in for extra safety.') + '</p>';
    if (tfa && tfa.required) s += '<p>The site owner requires two-step sign-in for everyone.</p>';
    if (note.tfaStep === 'app') s += '<p>Add this key to your authenticator app (Google Authenticator, Microsoft Authenticator…), or open it from your phone: <a href="' + esc(note.tfaUri) + '">add to authenticator</a>.</p><p><code style="font-size:16px;font-weight:700;word-break:break-all">' + esc(note.tfaSecret) + '</code></p><label class="lbl" for="tCode">Then type the 6-digit code it shows</label><input class="f" id="tCode" inputmode="numeric" maxlength="7" autocomplete="one-time-code"><div class="row" style="margin-top:12px"><button class="btn pri sm" id="tAppOk">Turn on</button><button class="btn line sm" id="tCancel">Cancel</button></div>';
    else if (note.tfaStep === 'email') s += '<p>We emailed a code to ' + esc(note.tfaTo) + '. It works for 10 minutes.</p><label class="lbl" for="tCode">6-digit code</label><input class="f" id="tCode" inputmode="numeric" maxlength="7" autocomplete="one-time-code"><div class="row" style="margin-top:12px"><button class="btn pri sm" id="tEmailOk">Turn on</button><button class="btn line sm" id="tCancel">Cancel</button></div>';
    else s += '<div class="row">' + (on ? (tfa.required ? '' : '<button class="btn line sm" id="tOff">Turn off</button>') + (tfa.trusted ? '<button class="btn line sm" id="tForget">Forget trusted devices (' + tfa.trusted + ')</button>' : '') : '') + '<button class="btn ' + (on ? 'line' : 'pri') + ' sm" id="tAppStart">' + (on ? 'Switch to' : 'Use') + ' an authenticator app</button>' + (tfa && tfa.canEmail ? '<button class="btn line sm" id="tEmailStart">' + (on ? 'Switch to' : 'Use') + ' email codes</button>' : '') + '</div>' +
      (tfa && !tfa.canEmail ? '<p style="font-size:14px">Email codes are not set up on this site yet, so the authenticator app is the way to go.</p>' : '') +
      (note.tfaStep === 'emailAsk' ? '' : '');
    return s + msg('tfa');
  }
  function storesBox() {
    if (!stores.length) return '<p>You are not a member of a store yet. On the store PC, open Store POS → Settings → Tablets → <b>Link to my Trivedi account</b>, or ask the store owner to invite you.</p>';
    return '<table class="t"><tr><th>Store</th><th>My role</th><th></th></tr>' + stores.map(function (s) { return '<tr><td><b>' + esc(s.name) + '</b>' + (s.pending ? '<br><span class="pill w">Waiting for approval</span>' : '') + '</td><td>' + esc(ROLE[s.role] || s.role) + '</td><td style="text-align:right">' + (s.pending ? '' : '<a class="btn line sm" href="/pos/?store=' + encodeURIComponent(s.storeId) + '">Open</a>') + '</td></tr>'; }).join('') + '</table>';
  }
  function devicesBox() {
    return '<table class="t"><tr><th>Device</th><th>Signed in</th><th></th></tr>' + sessions.map(function (s) { return '<tr><td><b>' + esc(s.device || 'Unknown device') + '</b>' + (s.current ? ' <span class="pill g">This device</span>' : '') + '</td><td>' + when(s.created) + '</td><td style="text-align:right">' + (s.current ? '' : '<button class="btn line sm" data-rev="' + esc(s.id) + '">Sign out</button>') + '</td></tr>'; }).join('') + '</table>' +
      (sessions.length > 1 ? '<div class="row" style="margin-top:14px"><button class="btn danger sm" id="revOthers">Sign out all other devices</button></div>' : '');
  }
  function bind() {
    var $ = function (id) { return document.getElementById(id); }, on = function (id, f) { var e = $(id); if (e) e.onclick = f; };
    on('pSave', async function () {
      var o = $('pOld').value, n = $('pNew').value, n2 = $('pNew2').value; note.pw = ''; note.pw_ok = false;
      if (n !== n2) note.pw = 'The two new passwords are not the same.';
      else if (V.passwordProblem(n)) note.pw = V.passwordProblem(n);
      else {
        $('pSave').disabled = true; $('pSave').textContent = 'Saving…';
        try {
          var dek = await V.unlockWithPassword(me.vault, o).catch(function () { throw new Error('Your current password is not right.'); });
          await api('POST', '/api/password', { old: await V.authFor(me.username, o), auth: await V.authFor(me.username, n), vaultPw: await V.passwordWrap(dek, n) });
          await V.keepKey(me.username, dek); me = await api('GET', '/api/me'); note.pw = 'Password changed. Your other devices were signed out.'; note.pw_ok = true; await load(true);
        } catch (e) { note.pw = e.message; }
      }
      view();
    });
    function tfaCall(body, ok) { return api('POST', '/api/me/2fa', body).then(function (r) { note.tfa = ok || ''; note.tfa_ok = true; note.tfaStep = ''; return r; }, function (e) { note.tfa = e.message; note.tfa_ok = false; }).then(function (r) { return load(true).then(function () { return r; }); }); }
    on('tOff', function () { tfaCall({ action: 'off' }, 'Two-step sign-in is off.'); });
    on('tForget', function () { tfaCall({ action: 'forget' }, 'Trusted devices forgotten.'); });
    on('tCancel', function () { note.tfaStep = ''; note.tfa = ''; view(); });
    on('tAppStart', function () { api('POST', '/api/me/2fa', { action: 'app-start' }).then(function (r) { note.tfaStep = 'app'; note.tfaSecret = r.secret; note.tfaUri = r.uri; note.tfa = ''; view(); }, function (e) { note.tfa = e.message; note.tfa_ok = false; view(); }); });
    on('tAppOk', function () { tfaCall({ action: 'app-confirm', code: $('tCode').value }, 'Two-step sign-in is on (authenticator app).'); });
    on('tEmailStart', function () {
      var to = me.email || prompt('Type the email address that should get your codes:'); if (!to) return;
      api('POST', '/api/me/2fa', { action: 'email-send', email: to }).then(function () { note.tfaStep = 'email'; note.tfaTo = to; note.tfa = ''; view(); }, function (e) { note.tfa = e.message; note.tfa_ok = false; view(); });
    });
    on('tEmailOk', function () { tfaCall({ action: 'email-confirm', code: $('tCode').value }, 'Two-step sign-in is on (email codes).'); });
    app.querySelectorAll('[data-rev]').forEach(function (b) { b.onclick = function () { api('POST', '/api/sessions/revoke', { id: b.dataset.rev }).then(function () { note.dev = 'That device was signed out.'; note.dev_ok = true; return load(true); }, function (e) { note.dev = e.message; note.dev_ok = false; view(); }); }; });
    on('revOthers', function () { api('POST', '/api/sessions/revoke', { others: true }).then(function () { note.dev = 'All other devices were signed out.'; note.dev_ok = true; return load(true); }); });
  }
  function load(keep) {
    return Promise.all([api('GET', '/api/me/2fa'), api('GET', '/api/sessions'), api('GET', '/api/pos/stores')]).then(function (r) { tfa = r[0]; sessions = r[1].sessions; stores = r[2].stores; view(); });
  }
  api('GET', '/api/me').then(function (m) {
    if (m.needRecovery) throw Object.assign(new Error('x'), { status: 401 });
    me = m; return load();
  }).catch(function (e) {
    if (e.status === 401) { location.replace('/books/login?next=/account'); return; }
    app.innerHTML = '<div class="card"><p class="err">' + esc(e.message) + '</p></div>';
  });
})();
