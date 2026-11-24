/* Trivedi account button — the same piece on every page of trivedipos.com, always top-right.
   Add one line before </body>:   <script src="/account-bar.js" defer></script>
   Signed out: a "Sign in" button (shared sign-in, then back to this page).
   Signed in: initials + name, with a menu: My account, My stores, the apps, Sign out (signs out everywhere on the site).
   On pages that have <div id="acctSlot"></div> in their header the button sits there; on other pages it floats top-right. */
(function () {
  'use strict';
  if (window.__tpAcct || !/^https?:$/.test(location.protocol) || location.hostname === 'app.storepos') return;
  var here = location.pathname;
  if (/^\/books\/(login|invite)/.test(here)) return;     // the sign-in page itself
  window.__tpAcct = true;
  var APP_PAGE = /^\/(pos|books|account)(\/|$)/.test(here);   // pages that need a reload when the sign-in changes
  var me = undefined, openMenu = false, stores = null;

  var slot = document.getElementById('acctSlot'), host = slot || document.createElement('div');
  host.setAttribute('data-account-bar', '');
  if (!slot) { host.style.cssText = 'all:initial;position:fixed;top:10px;right:16px;z-index:2147483000;'; }
  var root = host.attachShadow({ mode: 'open' });
  var css = document.createElement('style');
  css.textContent =
    ':host{all:initial;display:block}*{box-sizing:border-box;font-family:Inter,"Segoe UI",system-ui,Arial,sans-serif}' +
    '.wrap{position:relative;display:flex;justify-content:flex-end}' +
    '.btn{display:inline-flex;align-items:center;gap:9px;height:38px;padding:0 14px;border-radius:999px;border:1px solid rgba(255,255,255,.28);background:#16263f;color:#fff;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;line-height:1;white-space:nowrap}' +
    '.btn:hover,.btn:focus-visible{background:#1d3250;border-color:rgba(255,255,255,.5);outline:none}.btn:focus-visible{box-shadow:0 0 0 3px rgba(91,160,255,.6)}' +
    '.btn.pri{background:#1f6fd1;border-color:#1f6fd1}.btn.pri:hover{background:#1a5fb8;border-color:#1a5fb8}' +
    '.av{width:28px;height:28px;margin-left:-8px;border-radius:50%;background:#1f6fd1;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;letter-spacing:.02em}' +
    '.nm{max-width:130px;overflow:hidden;text-overflow:ellipsis}.car{opacity:.7;font-size:10px}' +
    '.m{position:absolute;top:46px;right:0;width:272px;max-width:calc(100vw - 24px);background:#fff;color:#0f1b2d;border-radius:14px;box-shadow:0 18px 50px rgba(8,16,32,.35),0 0 0 1px rgba(15,27,45,.08);padding:6px;display:none}' +
    '.m.o{display:block}.hd{padding:10px 12px 10px;border-bottom:1px solid #e6ebf2;margin-bottom:4px}.hd b{display:block;font-size:15px}.hd span{font-size:12.5px;color:#51607a;word-break:break-all}' +
    '.m a,.m button.i{display:flex;width:100%;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-radius:9px;color:#0f1b2d;text-decoration:none;font-size:14px;background:none;border:0;text-align:left;cursor:pointer}' +
    '.m a:hover,.m a:focus-visible,.m button.i:hover,.m button.i:focus-visible{background:#eef3fb;outline:none}.m a small{color:#51607a;font-size:12px}' +
    '.t{padding:10px 12px 4px;color:#51607a;font-size:11px;letter-spacing:.07em;text-transform:uppercase;font-weight:700}.hr{height:1px;background:#e6ebf2;margin:6px 4px}.so{color:#b3261e!important}' +
    '@media(max-width:560px){.nm{display:none}.btn{padding:0 10px}.av{margin-left:0}}';
  root.appendChild(css);
  var wrap = document.createElement('div'); wrap.className = 'wrap'; root.appendChild(wrap);

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var initials = function (m) { var n = String(m.name || m.username || '?').trim().split(/\s+/); return ((n[0] || '?')[0] + (n.length > 1 ? n[n.length - 1][0] : (n[0][1] || ''))).toUpperCase(); };
  var ROLE = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', reports: 'Reports only' };
  var api = function (method, path, body) {
    return fetch(path, { method: method, credentials: 'same-origin', headers: body ? { 'x-ld': '1', 'Content-Type': 'application/json' } : { 'x-ld': '1' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  };
  function render() {
    if (me === undefined) { wrap.innerHTML = ''; return; }
    if (!me) {
      wrap.innerHTML = '<a class="btn pri" id="si" href="/books/login?next=' + encodeURIComponent(here + location.search) + '">Sign in</a>';
      return;
    }
    var apps = [['Store POS back office', '/pos/', 'pos'], ['Ledger Desk', '/books/', 'books'], ['PdfStudio', '/pdfstudio/', 'pdfstudio'], ['Hotel Desk', '/hotel/', 'hotel']];
    var storeRows = stores === null ? '<div class="t" style="text-transform:none;letter-spacing:0;font-weight:500">Loading…</div>' : stores.length ? stores.map(function (s) { return '<a href="/pos/?store=' + encodeURIComponent(s.storeId) + '">' + esc(s.name) + '<small>' + esc(ROLE[s.role] || s.role) + (s.pending ? ' · waiting' : '') + '</small></a>'; }).join('') : '<div class="t" style="text-transform:none;letter-spacing:0;font-weight:500">No stores yet</div>';
    wrap.innerHTML = '<button class="btn" id="b" aria-haspopup="true" aria-expanded="' + openMenu + '" aria-label="Account menu"><span class="av">' + esc(initials(me)) + '</span><span class="nm">' + esc(me.name || me.username) + '</span><span class="car" aria-hidden="true">▾</span></button>' +
      '<div class="m' + (openMenu ? ' o' : '') + '" role="menu"><div class="hd"><b>' + esc(me.name || me.username) + '</b><span>' + esc(me.email || me.username) + '</span></div>' +
      '<a href="/account" role="menuitem">My account</a><div class="t">My stores</div>' + storeRows +
      '<div class="hr"></div><div class="t">Apps</div>' + apps.map(function (a) { return '<a href="' + a[1] + '" role="menuitem">' + a[0] + '</a>'; }).join('') +
      '<div class="hr"></div><button class="i so" id="so" role="menuitem">Sign out</button></div>';
    wrap.querySelector('#b').onclick = function (e) { e.stopPropagation(); openMenu = !openMenu; render(); if (openMenu) { loadStores(); var f = wrap.querySelector('.m a'); if (f) f.focus(); } };
    wrap.querySelector('#so').onclick = signOut;
  }
  function loadStores() { api('GET', '/api/pos/stores').then(function (r) { stores = r.status === 200 ? r.data.stores : []; if (openMenu) render(); }); }
  function signOut() {
    var done = function () { try { Object.keys(sessionStorage).filter(function (k) { return k.indexOf('ld-key:') === 0; }).forEach(function (k) { sessionStorage.removeItem(k); }); localStorage.setItem('tp-auth', String(Date.now())); } catch (e) { } location.href = '/'; };
    api('POST', '/api/logout', {}).then(function () { return fetch('/pdfstudio/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(function () { }); }).then(done, done);   // Ledger Desk's session is the shared one; PdfStudio's own is ended too
  }
  function check(first) {
    return api('GET', '/api/me').then(function (r) {
      var now = r.status === 200 && !r.data.needRecovery ? r.data : null;
      var was = me; me = now; if (!now) stores = null;
      render();
      try { document.dispatchEvent(new CustomEvent('tp-account', { detail: me })); } catch (e) { }
      if (!first && !!was !== !!now && APP_PAGE) location.reload();   // signed in or out in another tab: this page must follow
    }, function () { if (me === undefined) { me = null; render(); } });
  }
  document.addEventListener('click', function () { if (openMenu) { openMenu = false; render(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openMenu) { openMenu = false; render(); var b = wrap.querySelector('#b'); if (b) b.focus(); } });
  window.addEventListener('storage', function (e) { if (e.key === 'tp-auth') check(false); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(false); });
  setInterval(function () { check(false); }, 60000);
  function mount() { if (!slot) document.body.appendChild(host); check(true); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  window.TPAccount = { signOut: signOut, refresh: function () { return check(false); }, get me() { return me; } };
})();
