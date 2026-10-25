/* Store POS — Android bridge.
   On the Android tablet app, this file gives the POS screens the same "posAPI" the Windows app has,
   backed by the tablet's own SQLite database and native printing. On Windows it does nothing. */
(function () {
  'use strict';
  var N = window.AndroidPOS;
  if (!N || window.posAPI) return;

  /* ---------- talking to the Android side ---------- */
  var cbs = {}, seq = 0, listeners = { upd: [] };
  window.__posCb = function (id, json) { var c = cbs[id]; if (!c) return; delete cbs[id]; var r; try { r = JSON.parse(json); } catch (e) { r = { ok: false, error: 'Bad reply from tablet' }; } c(r); };
  window.__posUpd = function (json) { var u; try { u = JSON.parse(json); } catch (e) { return; } listeners.upd.forEach(function (f) { try { f(u); } catch (e) { } }); };
  function call(m, args) { return new Promise(function (res) { var id = ++seq; cbs[id] = res; N.call(id, m, JSON.stringify(args || {})); }); }
  function sql(q, p) { var r = JSON.parse(N.sql(q, JSON.stringify(p || []))); if (r.error) throw new Error(r.error); return r.rows; }
  function run(q, p) { var r = JSON.parse(N.exec(q, JSON.stringify(p || []))); if (r.error) throw new Error(r.error); return r; }
  function batch(list) { if (!list.length) return; var r = JSON.parse(N.execBatch(JSON.stringify(list))); if (r.error) throw new Error(r.error); }
  function b64(bytes) { var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); var s = ''; for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  function utf8b64(text) { return b64(new TextEncoder().encode(String(text))); }

  /* ---------- database: same tables as the Windows app ---------- */
  ['CREATE TABLE IF NOT EXISTS products(sku TEXT PRIMARY KEY, data TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, time INTEGER, num INTEGER, status TEXT, total REAL, data TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, data TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS order_lines(order_id TEXT NOT NULL, time INTEGER, sku TEXT, qty REAL, net REAL, cost REAL, cat TEXT)',
    'CREATE INDEX IF NOT EXISTS orders_time ON orders(time)',
    'CREATE INDEX IF NOT EXISTS orders_num ON orders(num)',
    'CREATE INDEX IF NOT EXISTS lines_order ON order_lines(order_id)',
    'CREATE INDEX IF NOT EXISTS lines_sku_time ON order_lines(sku, time)'].forEach(function (q) { run(q); });

  function orderStmts(o) {
    var id = String(o.id), time = Number(o.time) || 0, out = [];
    out.push(['INSERT OR REPLACE INTO orders(id,time,num,status,total,data) VALUES(?,?,?,?,?,?)', [id, time, Number(o.num) || null, String(o.status || ''), Number(o.total) || 0, JSON.stringify(o)]]);
    out.push(['DELETE FROM order_lines WHERE order_id=?', [id]]);
    if (o.status !== 'void') (o.lines || []).forEach(function (l) {
      if (l.fee) return;
      out.push(['INSERT INTO order_lines(order_id,time,sku,qty,net,cost,cat) VALUES(?,?,?,?,?,?,?)', [id, time, String(l.sku == null ? '' : l.sku), Number(l.qty) || 0, Number(l.net) || 0, (Number(l.cost) || 0) * (Number(l.qty) || 0), String(l.cat || '')]]);
    });
    return out;
  }
  function putStmts(store, val, key) {
    if (store === 'kv') return [['INSERT OR REPLACE INTO kv(key,data) VALUES(?,?)', [String(key), JSON.stringify(val === undefined ? null : val)]]];
    if (store === 'orders') return orderStmts(val);
    return [['INSERT OR REPLACE INTO products(sku,data) VALUES(?,?)', [String(val.sku), JSON.stringify(val)]]];
  }
  var TABLE = { products: 'products', orders: 'orders', kv: 'kv' }, KEYCOL = { products: 'sku', orders: 'id', kv: 'key' };
  var parse = function (rows) { return rows.map(function (r) { return JSON.parse(r.data); }); };
  function kvGet(k) { var r = sql('SELECT data FROM kv WHERE key=?', [String(k)]); return r.length ? JSON.parse(r[0].data) : null; }
  function kvPut(k, v) { run('INSERT OR REPLACE INTO kv(key,data) VALUES(?,?)', [String(k), JSON.stringify(v)]); }

  /* ---------- settings kept on the tablet ---------- */
  var CFG_DEFAULT = { rcptConn: 'driver', cmdSet: 'escpos', cols: 48, cut: true, feed: 4, drawerPin: 2, netHost: '', netPort: 9100, btAddr: '', btName: '', paper: 80, drawerOnCash: true, drawerMode: 'raw', kiosk: true, lastBackup: 0, lastBackupFile: '', lastBackupError: '' };
  function cfgGet() { var c = {}; try { c = JSON.parse(N.getPref('cfg') || '{}'); } catch (e) { } return Object.assign({}, CFG_DEFAULT, c); }
  function cfgSet(c) { N.setPref('cfg', JSON.stringify(c)); }

  /* ---------- license (same keys as Windows; Computer ID comes from this tablet) ---------- */
  var B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ', DAY = 86400000, TRIAL_DAYS = 14, GRACE_DAYS = 7;
  var LIC_PUB = 'MCowBQYDK2VwAyEAChLk2xj5iczD4MkE2RBkAppOTPz5qaThemEoawP+iro=';
  var MACHINE = '';
  function b32decode(str) {
    var clean = String(str || '').toUpperCase().replace(/^SPOS/, '').replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    var bits = 0, val = 0, out = [];
    for (var i = 0; i < clean.length; i++) { var k = B32.indexOf(clean[i]); if (k < 0) throw new Error('bad'); val = ((val << 5) | k) & 0xffffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
    return new Uint8Array(out);
  }
  async function machineId() {
    if (MACHINE) return MACHINE;
    var h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('storepos:' + N.deviceId())));
    var s = ''; for (var i = 0; i < 10; i++) s += B32[h[i] & 31];
    return (MACHINE = s.slice(0, 5) + '-' + s.slice(5));
  }
  async function verifyKey(key) {
    try {
      var raw = b32decode(key);
      if (raw.length < 70) return { ok: false, error: 'That license key is too short — check it was copied completely' };
      var n = (raw[0] << 8) | raw[1], payload = raw.subarray(2, 2 + n), sig = raw.subarray(2 + n, 2 + n + 64);
      if (sig.length !== 64) return { ok: false, error: 'That license key is not valid' };
      var der = Uint8Array.from(atob(LIC_PUB), function (c) { return c.charCodeAt(0); });
      var pk = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
      if (!(await crypto.subtle.verify({ name: 'Ed25519' }, pk, sig, payload))) return { ok: false, error: 'That license key is not valid' };
      return { ok: true, data: JSON.parse(new TextDecoder().decode(payload)) };
    } catch (e) { return { ok: false, error: /Ed25519|Unrecognized|not supported/i.test(String(e && e.message)) ? 'Update Android System WebView (Play Store), then try the key again' : 'That license key is not valid' }; }
  }
  var FREE_ON_ANDROID = true;   // Play Store version is free (store earns from card processing) - no trial, no license key
  async function licenseState() {
    var now = Date.now(), base = { machine: await machineId() };
    if (FREE_ON_ANDROID) return Object.assign(base, { status: kvGet('settings') ? 'licensed' : 'setup', locked: false, customer: '', expires: '', free: true });
    if (!kvGet('settings')) return Object.assign(base, { status: 'setup', locked: false });
    var pref = Number(N.getPref('trialStart')) || now, trial = Math.min(Number(kvGet('trialStart')) || now, pref);
    if (!kvGet('trialStart')) kvPut('trialStart', trial);
    if (!Number(N.getPref('trialStart'))) N.setPref('trialStart', String(trial));
    var key = kvGet('license');
    if (key) {
      var v = await verifyKey(key);
      if (v.ok) {
        var d = v.data;
        if (d.m && d.m.toUpperCase() !== base.machine) return Object.assign(base, { status: 'wrongpc', locked: true, customer: d.c, id: d.id, error: 'This license is for device ' + d.m + '. This tablet is ' + base.machine + '.' });
        if (d.e) {
          var end = new Date(d.e + 'T23:59:59').getTime();
          if (now > end + GRACE_DAYS * DAY) return Object.assign(base, { status: 'expired', locked: true, customer: d.c, id: d.id, expires: d.e });
          if (now > end) return Object.assign(base, { status: 'grace', locked: false, customer: d.c, id: d.id, expires: d.e, daysLeft: Math.ceil((end + GRACE_DAYS * DAY - now) / DAY) });
          return Object.assign(base, { status: 'licensed', locked: false, customer: d.c, id: d.id, expires: d.e, daysLeft: Math.ceil((end - now) / DAY) });
        }
        return Object.assign(base, { status: 'licensed', locked: false, customer: d.c, id: d.id, expires: '' });
      }
    }
    var left = Math.ceil((trial + TRIAL_DAYS * DAY - now) / DAY);
    return left > 0 ? Object.assign(base, { status: 'trial', locked: false, daysLeft: left }) : Object.assign(base, { status: 'trialover', locked: true, daysLeft: 0 });
  }

  /* ---------- link to the store PC (shared data, works offline, syncs when it can) ---------- */
  run('CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT, key TEXT, op TEXT, data TEXT, delta REAL, ts INTEGER)');
  var LOCAL_KV = ['cart', 'held', 'license', 'trialStart'];
  var LINK = null; try { LINK = JSON.parse(N.getPref('link') || 'null'); } catch (e) { LINK = null; }
  var linkSt = { online: false, lastOk: 0, lastErr: '', busy: false, progress: '' }, syncCbs = [];
  function saveLink() { N.setPref('link', JSON.stringify(LINK)); }
  function linked() { return !!(LINK && LINK.token); }
  function emit(ch) { syncCbs.forEach(function (f) { try { f(ch); } catch (e) { } }); }
  function queueStmts(store, val, key) {
    if (!linked()) return [];
    var k = String(store === 'kv' ? key : store === 'orders' ? val.id : val.sku);
    if (store === 'kv' && LOCAL_KV.indexOf(k) >= 0) return [];
    var delta = null;
    if (store === 'products') { var old = sql('SELECT data FROM products WHERE sku=?', [k]); var os = old.length ? Number(JSON.parse(old[0].data).stock) || 0 : 0; delta = Math.round(((Number(val.stock) || 0) - os) * 100) / 100; }
    var out = [];
    if (store === 'kv') out.push(['DELETE FROM outbox WHERE store=? AND key=?', ['kv', k]]);   // only the newest value of a setting matters
    out.push(['INSERT INTO outbox(store,key,op,data,delta,ts) VALUES(?,?,?,?,?,?)', [store, k, 'put', JSON.stringify(val === undefined ? null : val), delta, Date.now()]]);
    return out;
  }
  function queueDel(store, key) { return linked() && store !== 'kv' ? [['INSERT INTO outbox(store,key,op,data,delta,ts) VALUES(?,?,?,?,?,?)', [store, String(key), 'del', null, null, Date.now()]]] : []; }
  var kickT = null; function kick() { if (!linked()) return; clearTimeout(kickT); kickT = setTimeout(syncOnce, 400); }
  /* ---------- Cloud Sync (link over the internet; everything sealed with the store's key) ---------- */
  var CLOUD_URL = 'https://storepos-sync.REPLACE_ME.workers.dev';
  function cloudBase() { var c = cfgGet(); return String(c.cloudUrl || c.cloudUrlAuto || CLOUD_URL).replace(/\/+$/, ''); }
  async function findCloud() {   // the Cloud Sync address is published with the updates
    if (cloudBase().indexOf('REPLACE_ME') < 0) return;
    try { var r = await call('http', { url: 'https://raw.githubusercontent.com/atrivedi85/storepos-updates/main/latest.json?t=' + Date.now(), method: 'GET', timeout: 15000 }); var j = JSON.parse(r.body || '{}'); if (/^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(j.cloudUrl || '')) { var c = cfgGet(); c.cloudUrlAuto = j.cloudUrl; cfgSet(c); } } catch (e) { }
  }
  var TE = new TextEncoder(), TD = new TextDecoder();
  var CANZ = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  function b64e(u8) { var s = ''; for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function b64d(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  async function streamBytes(u8, Ctor) { var cs = new Ctor('gzip'); var w = cs.writable.getWriter(); w.write(u8); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); }
  async function aesKey(k) { return crypto.subtle.importKey('raw', b64d(k), 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async function seal(k, obj, gz) { var p = TE.encode(JSON.stringify(obj)); if (gz) p = await streamBytes(p, CompressionStream); var iv = crypto.getRandomValues(new Uint8Array(12)); var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, await aesKey(k), p)); var out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return (gz ? 'z.' : 'p.') + b64e(out); }
  async function unseal(k, s) { var gz = s.slice(0, 2) === 'z.'; var raw = b64d(s.slice(2)); var p = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, await aesKey(k), raw.subarray(12))); if (gz) p = await streamBytes(p, DecompressionStream); return JSON.parse(TD.decode(p)); }
  async function relayAuth(k) { var key = await crypto.subtle.importKey('raw', b64d(k), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); var sg = new Uint8Array(await crypto.subtle.sign('HMAC', key, TE.encode('storepos-relay-auth'))); return Array.prototype.map.call(sg, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  async function pairId(code) { var d = new Uint8Array(await crypto.subtle.digest('SHA-256', TE.encode('storepos-pair:' + normCode(code)))); return b64e(d).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32); }
  async function pairKey(code) { var base = await crypto.subtle.importKey('raw', TE.encode(normCode(code)), 'PBKDF2', false, ['deriveBits']); return b64e(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: TE.encode('storepos-pair-v1'), iterations: 150000, hash: 'SHA-256' }, base, 256))); }
  function cid() { var d = String(N.deviceId() || '').replace(/[^A-Za-z0-9_-]/g, ''); return (d + 'tablet-device').slice(0, 40); }
  var CW = { ws: null, ready: null, pending: {}, parts: {}, ping: null };
  function rid() { return Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function cloudWs(L) {
    if (CW.ws && CW.ws.readyState === 1) return Promise.resolve(CW.ws);
    if (CW.ready) return CW.ready;
    CW.ready = relayAuth(L.key).then(function (auth) {
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket((L.url || cloudBase()).replace(/^http/, 'ws') + '/v1/store/' + L.storeId + '/ws?role=client&cid=' + cid() + '&auth=' + auth);
        var to = setTimeout(function () { try { ws.close(); } catch (e) { } }, 15000);
        ws.onopen = function () { clearTimeout(to); CW.ws = ws; CW.ready = null; clearInterval(CW.ping); CW.ping = setInterval(function () { try { ws.send('{"t":"ping"}'); } catch (e) { } }, 45000); ws.send('{"t":"ping"}'); resolve(ws); };
        ws.onmessage = function (ev) {
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.t === 'pong') { linkSt.hostOn = m.host !== false; return; }
          if (m.t === 'bump') { linkSt.hostOn = true; kick(); return; }
          if (m.t !== 'res') return;
          var w = CW.pending[m.id]; if (!w) return;
          if (m.queued || m.offline) { delete CW.pending[m.id]; clearTimeout(w.to); linkSt.hostOn = false; if (m.queued) w.resolve({ __queued: true }); else w.reject(new Error('The store PC is off or not online right now')); return; }
          var enc = m.enc; if (m.parts) { var e = CW.parts[m.id] || (CW.parts[m.id] = { p: [], n: 0 }); if (e.p[m.part] === undefined) { e.p[m.part] = m.enc; e.n++; } if (e.n < m.parts) return; enc = e.p.join(''); delete CW.parts[m.id]; }
          delete CW.pending[m.id]; clearTimeout(w.to); linkSt.hostOn = true;
          unseal(L.key, enc).then(function (r) { if (r && r.status) { var er = new Error(r.error || 'Store PC error'); er.status = r.status; w.reject(er); } else w.resolve(r); }, function () { w.reject(new Error('Could not open the answer — link again.')); });
        };
        ws.onclose = function (ev) { clearTimeout(to); clearInterval(CW.ping); if (CW.ws === ws) CW.ws = null; if (CW.ready) { CW.ready = null; reject(new Error(ev.reason || 'Can’t reach the Cloud Sync server (check the internet)')); } Object.keys(CW.pending).forEach(function (id) { var w = CW.pending[id]; clearTimeout(w.to); w.reject(new Error('Connection to Cloud Sync dropped')); delete CW.pending[id]; }); };
      });
    });
    CW.ready.catch(function () { CW.ready = null; });
    return CW.ready;
  }
  async function cloudReq(L, path, body, token, timeout, queueable) {
    var ws = await cloudWs(L); var id = rid();
    var enc = await seal(L.key, { path: path, body: body, token: token }, CANZ);
    return new Promise(function (resolve, reject) {
      var to = setTimeout(function () { delete CW.pending[id]; reject(new Error('The store PC did not answer in time')); }, timeout || 30000);
      CW.pending[id] = { resolve: resolve, reject: reject, to: to };
      var n = Math.max(1, Math.ceil(enc.length / 600000));
      for (var i = 0; i < n; i++) { var msg = { t: 'req', id: id, enc: enc.slice(i * 600000, (i + 1) * 600000) }; if (CANZ) msg.z = 1; if (queueable) msg.q = 1; if (n > 1) { msg.part = i; msg.parts = n; } ws.send(JSON.stringify(msg)); }
    });
  }
  async function lanReq(path, body, timeout, queueable) {
    if (LINK && LINK.mode === 'cloud') return cloudReq(LINK, path, body, LINK.token || '', timeout, queueable);
    var r = await call('http', { url: 'http://' + LINK.host + ':' + (LINK.port || 8765) + path, method: 'POST', body: JSON.stringify(body || {}), headers: { 'Content-Type': 'application/json', 'X-Token': LINK.token || '' }, timeout: timeout || 20000 });
    if (!r.ok) throw new Error('Can’t reach the store PC (' + (r.error || 'no answer') + ')');
    var j; try { j = JSON.parse(r.body || '{}'); } catch (e) { throw new Error('The store PC sent a bad answer'); }
    if (r.status >= 400) { var er = new Error(j.error || ('Store PC error ' + r.status)); er.status = r.status; throw er; }
    return j;
  }
  function pending(store, key) { return sql('SELECT 1 x FROM outbox WHERE store=? AND key=? LIMIT 1', [store, String(key)]).length > 0; }
  function localNextOrder() { var s = kvGet('settings') || {}; var base = (LINK && LINK.reg ? LINK.reg : 2) * 1000000 + 1; return Math.max(Number(s.nextOrder) || 0, base); }
  function applyItems(items, skipPending) {
    var stmts = [], ch = { products: [], kv: {}, orders: false };
    (items || []).forEach(function (it) {
      if (it.store === 'kv' && LOCAL_KV.indexOf(String(it.key)) >= 0) return;
      if (skipPending && it.store !== 'orders' && pending(it.store, it.key)) return;   // our newer change goes up first
      if (it.store === 'products') {
        if (it.deleted || !it.data) { stmts.push(['DELETE FROM products WHERE sku=?', [String(it.key)]]); ch.products.push({ sku: String(it.key), deleted: true }); }
        else { stmts = stmts.concat(putStmts('products', it.data)); ch.products.push(it.data); }
      } else if (it.store === 'orders') {
        if (it.deleted || !it.data) stmts.push(['DELETE FROM orders WHERE id=?', [String(it.key)]], ['DELETE FROM order_lines WHERE order_id=?', [String(it.key)]]);
        else stmts = stmts.concat(orderStmts(it.data));
        ch.orders = true;
      } else if (it.store === 'kv') {
        var v = it.data;
        if (it.key === 'settings' && v) { v = Object.assign({}, v, { nextOrder: localNextOrder() }); }
        stmts.push(['INSERT OR REPLACE INTO kv(key,data) VALUES(?,?)', [String(it.key), JSON.stringify(v)]]); ch.kv[it.key] = v;
      }
    });
    batch(stmts);
    return ch;
  }
  async function snapshot() {
    var snap = { stage: 'products', after: '' }, startSeq = null, first = true, n = 0;
    while (snap) {
      linkSt.progress = 'Copying from the store PC… ' + n + ' records';
      var res = await lanReq('/sync', { snap: Object.assign({}, snap, { startSeq: startSeq }) }, 90000);
      if (res.__queued) throw new Error('The store PC is off or not online right now');
      if (first) {
        var wipe = [['DELETE FROM products', []], ['DELETE FROM orders', []], ['DELETE FROM order_lines', []]];
        sql('SELECT key FROM kv').forEach(function (r) { if (LOCAL_KV.indexOf(r.key) < 0 && r.key !== 'settings') wipe.push(['DELETE FROM kv WHERE key=?', [r.key]]); });
        batch(wipe); first = false; startSeq = res.startSeq; LINK.epoch = res.epoch;
      }
      applyItems(res.items, false); n += (res.items || []).length; snap = res.next;
    }
    LINK.since = startSeq; LINK.ready = true; linkSt.progress = ''; saveLink();
    emit({ full: true });
  }
  async function syncOnce() {
    if (!linked() || linkSt.busy) return;
    linkSt.busy = true; var again = false;
    try {
      if (!LINK.ready) await snapshot();
      var rows = sql('SELECT * FROM outbox ORDER BY id LIMIT 250');
      var ops = rows.map(function (r) { return { store: r.store, key: r.key, op: r.op, data: r.data ? JSON.parse(r.data) : null, delta: r.delta }; });
      var res = await lanReq('/sync', { since: LINK.since || 0, epoch: LINK.epoch, ops: ops }, 60000, ops.length > 0);
      if (res.__queued) { if (rows.length) run('DELETE FROM outbox WHERE id<=?', [rows[rows.length - 1].id]); again = sql('SELECT COUNT(*) n FROM outbox')[0].n > 0; }
      else if (res.resync) { LINK.ready = false; saveLink(); again = true; }
      else {
        if (rows.length) run('DELETE FROM outbox WHERE id<=?', [rows[rows.length - 1].id]);
        var ch = applyItems(res.items, true);
        LINK.since = res.seq; saveLink();
        if (ch.products.length || ch.orders || Object.keys(ch.kv).length) emit(ch);
        again = !!res.more || sql('SELECT COUNT(*) n FROM outbox')[0].n > 0;
      }
      linkSt.online = true; linkSt.lastOk = Date.now(); linkSt.lastErr = res.__queued ? 'The store PC is off — your changes are saved in Cloud Sync and reach it when it is back on.' : '';
    } catch (e) {
      linkSt.online = false; linkSt.lastErr = e.message; linkSt.progress = '';
      if (e.status === 401) { linkSt.lastErr = e.message; }
    } finally { linkSt.busy = false; }
    if (again) setTimeout(syncOnce, 150);
  }
  setInterval(function () { if (linked() && (LINK.mode !== 'cloud' || !linkSt.online || Date.now() - linkSt.lastOk > 25000)) syncOnce(); }, 5000);
  if (linked()) setTimeout(syncOnce, 1500);
  async function viaPc(method, args, local) {
    if (linked() && LINK.ready && linkSt.online && linkSt.hostOn !== false) { try { var r = await lanReq('/api', { method: method, args: args }, 30000); if (!r.__queued) return r.result; } catch (e) { } }
    return local.apply(null, args);
  }

  /* ---------- printing ---------- */
  function drawerBytes(c) { return c.cmdSet === 'star' ? [7] : [27, 112, Number(c.drawerPin) === 5 ? 1 : 0, 25, 250]; }
  async function sendRaw(bytes) {
    var c = cfgGet(), data = b64(bytes);
    if (c.rcptConn === 'network') {
      if (!c.netHost) return { ok: false, error: 'Enter the printer IP address in Settings → Printers' };
      var r = await call('tcp', { host: c.netHost, port: Number(c.netPort) || 9100, b64: data });
      return Object.assign(r, { printer: c.netHost + ':' + (c.netPort || 9100) });
    }
    if (c.rcptConn === 'bluetooth') {
      if (!c.btAddr) return { ok: false, error: 'Pick the Bluetooth printer in Settings → Printers' };
      var r2 = await call('bt', { addr: c.btAddr, b64: data });
      return Object.assign(r2, { printer: c.btName || c.btAddr });
    }
    return { ok: false, error: 'Choose a network or Bluetooth receipt printer in Settings → Printers' };
  }
  function pageDoc(html, css, w) { return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>html,body{margin:0;padding:0;background:#fff}' + (css || '') + '</style></head><body' + (w ? ' style="width:' + w + 'mm"' : '') + '>' + html + '</body></html>'; }

  /* ---------- the API the POS screens use (same names as Windows) ---------- */
  window.posAPI = {
    isDesktop: true, isAndroid: true,
    db: async function (op, store, a, b) {
      var T = TABLE[store]; if (!T) throw new Error('Unknown store ' + store);
      switch (op) {
        case 'all': return parse(sql(store === 'orders' ? 'SELECT data FROM orders ORDER BY time' : 'SELECT data FROM ' + T));
        case 'get': { var v = kvGet(a); return v === null ? undefined : v; }
        case 'put': batch(queueStmts(store, a, b).concat(putStmts(store, a, b))); kick(); return true;
        case 'putMany': { var l = []; (a || []).forEach(function (v) { l = l.concat(queueStmts(store, v)).concat(putStmts(store, v)); }); batch(l); kick(); return true; }
        case 'del': batch(queueDel(store, a).concat([['DELETE FROM ' + T + ' WHERE ' + KEYCOL[store] + '=?', [String(a)]]]).concat(store === 'orders' ? [['DELETE FROM order_lines WHERE order_id=?', [String(a)]]] : [])); kick(); return true;
        case 'clear': batch([['DELETE FROM ' + T, []]].concat(store === 'orders' ? [['DELETE FROM order_lines', []]] : [])); return true;
      }
      throw new Error('Unknown op ' + op);
    },
    firstRunData: async function () { return null; },
    ordersQuery: function () { return viaPc('ordersQuery', Array.prototype.slice.call(arguments), LOCALQ.ordersQuery); },
    _ordersQuery: async function (o) {
      var a = o.a, b = o.b, q = String(o.q || '').trim(), sku = o.sku, status = o.status, limit = Math.max(1, Math.min(5000, Number(o.limit) || 400));
      var where = 'time BETWEEN ? AND ?', params = [a, b], item = null;
      if (sku) {
        var skus = Array.from(new Set([String(sku), String(q)].filter(Boolean))), ph = skus.map(function () { return '?'; }).join(',');
        where = 'id IN (SELECT order_id FROM order_lines WHERE sku IN (' + ph + '))'; params = skus.slice();
        var st = sql('SELECT MAX(time) last, MIN(time) first, COALESCE(SUM(qty),0) qty, COUNT(DISTINCT order_id) n FROM order_lines WHERE sku IN (' + ph + ') AND qty > 0', skus)[0];
        var d30 = sql('SELECT COALESCE(SUM(qty),0) q FROM order_lines WHERE sku IN (' + ph + ') AND time >= ?', skus.concat([Date.now() - 30 * DAY]))[0];
        item = { sku: sku, last: st.last, first: st.first, qty: st.qty, orders: st.n, qty30: d30.q };
      } else if (/^\d{4}$/.test(q)) { where = '(num = ? OR data LIKE ?)'; params = [Number(q), '%"last4":"' + q + '"%']; }
      else if (/^\d{1,7}$/.test(q)) { where = 'num = ?'; params = [Number(q)]; }
      else if (q) { where += ' AND data LIKE ?'; params.push('%' + q.replace(/[%_"]/g, '') + '%'); }
      if (Array.isArray(status) && status.length) { where = '(' + where + ') AND status IN (' + status.map(function () { return '?'; }).join(',') + ')'; params = params.concat(status.map(String)); }
      var agg = sql('SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM orders WHERE ' + where, params)[0];
      var rows = sql('SELECT data FROM orders WHERE ' + where + ' ORDER BY time DESC LIMIT ' + limit, params);
      return { count: agg.n, total: agg.s, rows: parse(rows), item: item };
    },
    orderGet: function () { return viaPc('orderGet', Array.prototype.slice.call(arguments), LOCALQ.orderGet); },
    _orderGet: async function (id) { var r = sql('SELECT data FROM orders WHERE id=?', [String(id)]); return r.length ? JSON.parse(r[0].data) : null; },
    report: function () { return viaPc('report', Array.prototype.slice.call(arguments), LOCALQ.report); },
    _report: async function (a, b) {
      var R = { n: 0, refN: 0, refunds: 0, gross: 0, disc: 0, tax: 0, total: 0, tend: {}, cats: {}, items: {}, taxes: {}, cost: 0 };
      sql('SELECT data FROM orders WHERE time BETWEEN ? AND ?', [a, b]).forEach(function (row) {
        var o = JSON.parse(row.data); if (o.status === 'void') return;
        if (o.status === 'refund') { R.refN++; R.refunds += o.total; } else R.n++;
        R.gross += o.subtotal || 0; R.disc += o.discount || 0; R.tax += o.tax || 0; R.total += o.total || 0;
        (o.payments || []).forEach(function (p) { R.tend[p.type] = (R.tend[p.type] || 0) + p.amount; });
        if (o.change) R.tend.Cash = (R.tend.Cash || 0) - o.change;
        (o.taxes || []).forEach(function (t) { R.taxes[t.name] = (R.taxes[t.name] || 0) + t.amount; });
        (o.lines || []).forEach(function (l) {
          var c = l.fee ? 'Fees' : (l.cat || 'Other'), cost = (l.cost || 0) * l.qty;
          var k = R.cats[c] = R.cats[c] || { qty: 0, sales: 0, cost: 0 };
          k.qty += l.qty; k.sales += l.net; k.cost += cost; R.cost += cost;
          if (!l.fee) { var key = l.sku + '|' + l.name; var it = R.items[key] = R.items[key] || { sku: l.sku, name: l.name, cat: l.cat, qty: 0, sales: 0, cost: 0 }; it.qty += l.qty; it.sales += l.net; it.cost += cost; }
        });
      });
      R.net = R.gross - R.disc; return R;
    },
    reportDaily: function () { return viaPc('reportDaily', Array.prototype.slice.call(arguments), LOCALQ.reportDaily); },
    _reportDaily: async function (a, b) {
      var days = {}, key = function (t) { var d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
      sql('SELECT data FROM orders WHERE time BETWEEN ? AND ?', [a, b]).forEach(function (row) {
        var o = JSON.parse(row.data); if (o.status === 'void') return;
        var D = days[key(o.time)] = days[key(o.time)] || { n: 0, refN: 0, refunds: 0, gross: 0, disc: 0, tax: 0, total: 0, cost: 0, card: 0 };
        if (o.status === 'refund') { D.refN++; D.refunds += o.total || 0; } else D.n++;
        D.gross += o.subtotal || 0; D.disc += o.discount || 0; D.tax += o.tax || 0; D.total += o.total || 0;
        (o.payments || []).forEach(function (p) { if (p.type === 'Credit' || p.type === 'Debit') D.card += p.amount || 0; });
        (o.lines || []).forEach(function (l) { D.cost += (l.cost || 0) * (l.qty || 0); });
      });
      return days;
    },
    itemMonthly: function () { return viaPc('itemMonthly', Array.prototype.slice.call(arguments), LOCALQ.itemMonthly); },
    _itemMonthly: async function (sku) {
      var y = new Date().getFullYear(), start = new Date(y - 1, 0, 1).getTime(), cur = Array(12).fill(0), prev = Array(12).fill(0);
      sql("SELECT CAST(strftime('%Y', time/1000, 'unixepoch', 'localtime') AS INTEGER) y, CAST(strftime('%m', time/1000, 'unixepoch', 'localtime') AS INTEGER) m, SUM(qty) q FROM order_lines WHERE sku=? AND time>=? GROUP BY y, m", [String(sku), start])
        .forEach(function (r) { (r.y === y ? cur : prev)[r.m - 1] = Math.round(r.q * 100) / 100; });
      return { cur: cur, prev: prev };
    },
    stats: function () { return viaPc('stats', Array.prototype.slice.call(arguments), LOCALQ.stats); },
    _stats: async function () { var o = sql('SELECT COUNT(*) n, MIN(time) first FROM orders')[0]; return { orders: o.n, firstOrder: o.first, products: sql('SELECT COUNT(*) n FROM products')[0].n, history: { finished: true } }; },
    historyState: async function () { return { running: false, finished: true, done: 0, total: 0 }; },
    onHistory: function () { },
    print: async function (html, css) { var w = cfgGet().paper == 58 ? 58 : 80; return call('printHtml', { html: pageDoc(html, css, w), title: 'Receipt' }); },
    printDoc: async function (o) { return call('printHtml', { html: pageDoc(o.html, o.css), title: 'Store POS' }); },
    savePdf: async function (o) { await call('printHtml', { html: pageDoc(o.html, o.css), title: o.name || 'Store POS' }); return { ok: false, canceled: true }; },
    addPrinter: async function () { return call('openBtSettings', {}); },
    showFile: async function () { }, openFolder: async function () { },
    rawPrint: sendRaw,
    openDrawer: function () { return sendRaw(drawerBytes(cfgGet())); },
    comPorts: async function () { return []; },
    scannerState: async function () { return { status: 'off' }; }, restartScanner: async function () { return { status: 'off' }; },
    onScan: function () { }, onScannerState: function () { },
    printers: async function () { return [{ name: 'Android printing (Wi-Fi printers & Save as PDF)', isDefault: true }]; },
    btDevices: function () { return call('btDevices', {}); },
    getConfig: async function () { var c = cfgGet(); return Object.assign(c, { appVersion: N.webVersion(), version: N.shellVersion(), bundledVersion: N.bundledVersion(), platform: 'android', dataDir: 'this tablet', backupRoot: 'Download/StorePOS', hasPrevious: N.hasPrevious(), runningUpdate: N.webVersion() !== N.bundledVersion() }); },
    setConfig: async function (patch) { var c = cfgGet(); Object.keys(patch || {}).forEach(function (k) { c[k] = patch[k]; }); cfgSet(c); return c; },
    backupNow: async function () { var r = await call('backup', {}); var c = cfgGet(); c.lastBackup = Date.now(); c.lastBackupFile = r.path || ''; c.lastBackupError = r.ok ? '' : (r.error || ''); cfgSet(c); return r; },
    restoreDb: function () { return call('restore', {}); },
    chooseBackupDir: async function () { return { ok: false, canceled: true }; },
    installUpdate: async function () { return { ok: false, error: 'On the tablet, use Check online to update.' }; },
    checkUpdate: function () { return call('checkUpdate', {}); },
    downloadUpdate: function () { return call('downloadUpdate', {}); },
    onUpdateAvailable: function (f) { listeners.upd.push(f); },
    undoUpdate: function () { return call('undoUpdate', {}); },
    licenseState: licenseState,
    setLicense: async function (key) {
      var v = await verifyKey(key); if (!v.ok) return { ok: false, error: v.error };
      var m = await machineId(); if (v.data.m && v.data.m.toUpperCase() !== m) return { ok: false, error: 'This license is locked to device ' + v.data.m + ', but this tablet is ' + m + '.' };
      kvPut('license', String(key).trim()); return { ok: true, state: await licenseState() };
    },
    loadLicenseFile: async function () { return { ok: false, error: 'On the tablet, paste the license key into the box instead.' }; },
    exitApp: async function () { N.exit(); },
    saveInvoiceFile: function (o) { return call('saveInternal', { dir: 'invoices', name: o.name, b64: b64(o.bytes) }); },
    openPath: async function () { return 'not available on tablet'; },
    ocrImage: async function () { return { ok: false, error: 'Reading invoice photos works on the Windows POS for now — PDFs and Excel files work here.' }; },
    saveDownload: function (name, text, mime) { return call('saveFile', { name: name, b64: utf8b64(text), mime: mime || 'text/plain' }); },
    onSync: function (f) { syncCbs.push(f); },
    linkState: async function () { return { linked: linked(), mode: LINK && LINK.mode, hostOn: linkSt.hostOn, ready: !!(LINK && LINK.ready), host: LINK && (LINK.mode === 'cloud' ? 'over the internet' : LINK.host), store: LINK && LINK.store, reg: LINK && LINK.reg, online: linkSt.online, lastOk: linkSt.lastOk, lastErr: linkSt.lastErr, progress: linkSt.progress, pending: sql('SELECT COUNT(*) n FROM outbox')[0].n, deviceName: LINK && LINK.name }; },
    linkPair: async function (o) {
      if (o.mode === 'cloud') {
        var prevC = LINK;
        try {
          var code = normCode(o.cloudCode); if (code.length !== 8) throw new Error('Type the 8-letter Cloud code shown on the store PC');
          await findCloud(); if (cloudBase().indexOf('REPLACE_ME') >= 0) throw new Error('Cloud Sync is not switched on yet — check for updates and try again');
          var g; try { g = await fetch(cloudBase() + '/v1/pair/' + (await pairId(code))); } catch (e) { throw new Error('Can’t reach the Cloud Sync server (check the internet)'); }
          var gj = await g.json(); if (!g.ok) throw new Error(gj.error || 'That code is wrong or expired');
          var offer; try { offer = await unseal(await pairKey(code), gj.blob); } catch (e) { throw new Error('That code is wrong or expired'); }
          var base = { mode: 'cloud', url: cloudBase(), storeId: offer.storeId, key: offer.key, token: '' };
          LINK = base; CW.ws = null; CW.ready = null;
          var rc = await cloudReq(base, '/pair', { code: offer.lanCode, deviceId: N.deviceId(), name: o.name || 'Tablet' }, '', 20000);
          if (rc.__queued) throw new Error('The store PC is off or not online right now');
          LINK = Object.assign(base, { token: rc.token, reg: rc.reg, store: rc.store, epoch: rc.epoch, since: 0, ready: false, name: o.name || 'Tablet' });
          saveLink(); run('DELETE FROM outbox');
          await snapshot(); linkSt.online = true; linkSt.lastOk = Date.now(); linkSt.lastErr = '';
          return { ok: true, store: rc.store, reg: rc.reg };
        } catch (e) { LINK = prevC; saveLink(); return { ok: false, error: e.message }; }
      }
      var host = String(o.host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), port = 8765;
      if (host.indexOf(':') > 0) { port = Number(host.split(':')[1]) || 8765; host = host.split(':')[0]; }
      if (!host) return { ok: false, error: 'Type the store PC address (shown on the PC under Settings → Tablets)' };
      var prev = LINK; LINK = { host: host, port: port, token: '' };
      try {
        var hi = await lanReq('/hello', {}, 8000);
        if (hi.app !== 'storepos') throw new Error('That address is not a Store POS PC');
        var r = await lanReq('/pair', { code: String(o.code || '').trim(), deviceId: N.deviceId(), name: o.name || 'Tablet' }, 10000);
        LINK = { host: host, port: port, token: r.token, reg: r.reg, store: r.store, epoch: r.epoch, since: 0, ready: false, name: o.name || 'Tablet' };
        saveLink(); run('DELETE FROM outbox');
        await snapshot(); linkSt.online = true; linkSt.lastOk = Date.now(); linkSt.lastErr = '';
        return { ok: true, store: r.store, reg: r.reg };
      } catch (e) { LINK = prev; saveLink(); return { ok: false, error: e.message }; }
    },
    linkSyncNow: async function () { await syncOnce(); return this.linkState(); },
    unlink: async function () { LINK = null; saveLink(); run('DELETE FROM outbox'); if (CW.ws) { try { CW.ws.close(); } catch (e) { } } return { ok: true }; }
  };
  var LOCALQ = {}; ['ordersQuery', 'orderGet', 'report', 'reportDaily', 'itemMonthly', 'stats'].forEach(function (m) { LOCALQ[m] = window.posAPI['_' + m]; });
})();
