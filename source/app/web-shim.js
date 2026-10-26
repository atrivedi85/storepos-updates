/* Store POS — web back office.
   When the POS screens are opened in a normal web browser (the Store POS website), this file gives them the same
   "posAPI" the Windows and Android apps have. The browser links to the store PC through Cloud Sync like a tablet:
   it keeps a copy of the store's items, settings and recent sales in the browser, sends changes to the store PC
   (they wait in Cloud Sync if the store PC is off), and asks the store PC for full-history reports.
   Everything is sealed with the store's own key; the Cloud Sync server can't read it.
   In the Windows and Android apps this file does nothing. */
(function () {
  'use strict';
  if (window.posAPI) return;
  if (!/^https?:$/.test(location.protocol) || location.hostname === 'app.storepos') return;

  var DAY = 86400000, LOCAL_KV = ['cart', 'held', 'license', 'trialStart'];
  var BASE = (new URLSearchParams(location.search).get('relay') || location.origin).replace(/\/+$/, '');
  var TE = new TextEncoder(), TD = new TextDecoder();
  var CANZ = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  /* ---------- browser storage (IndexedDB) ---------- */
  var IDB = null;
  function idbOpen() {
    return new Promise(function (res, rej) {
      var q = indexedDB.open('storepos-web', 1);
      q.onupgradeneeded = function () { var d = q.result; d.createObjectStore('rec'); d.createObjectStore('meta'); d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true }); };
      q.onsuccess = function () { IDB = q.result; res(); }; q.onerror = function () { rej(q.error); };
    });
  }
  function idbTx(stores, fn) { return new Promise(function (res, rej) { var t = IDB.transaction(stores, 'readwrite'); var r = fn(t); t.oncomplete = function () { res(r); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); }; }); }
  function idbAll(store) { return new Promise(function (res, rej) { var q = IDB.transaction(store).objectStore(store).getAll(); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }
  function idbGet(store, key) { return new Promise(function (res, rej) { var q = IDB.transaction(store).objectStore(store).get(key); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }
  function metaSet(k, v) { return idbTx(['meta'], function (t) { t.objectStore('meta').put(v, k); }); }

  /* ---------- the copy of the store's data ---------- */
  var MEM = { products: new Map(), orders: new Map(), kv: new Map() };
  var LINK = null, OUT = [], CFG = {};
  function keyOf(store, val, key) { return String(store === 'kv' ? key : store === 'orders' ? val.id : val.sku); }
  function memPut(t, store, k, v) { MEM[store].set(k, v); t.objectStore('rec').put({ store: store, key: k, data: v }, store + '|' + k); }
  function memDel(t, store, k) { MEM[store].delete(k); t.objectStore('rec').delete(store + '|' + k); }
  function pending(store, k) { return OUT.some(function (o) { return o.store === store && o.key === k; }); }

  /* ---------- sealing (same format as the store PC) ---------- */
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
  function rid() { return Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }

  /* ---------- connection to Cloud Sync ---------- */
  var st = { online: false, hostOn: true, lastOk: 0, lastErr: '', busy: false, progress: '' }, syncCbs = [], linkCbs = [];
  var CW = { ws: null, ready: null, pending: {}, parts: {}, ping: null };
  function emit(ch) { syncCbs.forEach(function (f) { try { f(ch); } catch (e) { } }); }
  function emitLink() { var s = linkState(); linkCbs.forEach(function (f) { try { f(s); } catch (e) { } }); }
  function cloudWs(L) {
    if (CW.ws && CW.ws.readyState === 1) return Promise.resolve(CW.ws);
    if (CW.ready) return CW.ready;
    CW.ready = relayAuth(L.key).then(function (auth) {
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/v1/store/' + L.storeId + '/ws?role=client&cid=' + L.cid + '&auth=' + auth);
        var to = setTimeout(function () { try { ws.close(); } catch (e) { } }, 15000);
        ws.onopen = function () { clearTimeout(to); CW.ws = ws; CW.ready = null; clearInterval(CW.ping); CW.ping = setInterval(function () { try { ws.send('{"t":"ping"}'); } catch (e) { } }, 45000); ws.send('{"t":"ping"}'); resolve(ws); };
        ws.onmessage = function (ev) {
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.t === 'pong') { st.hostOn = m.host !== false; return; }
          if (m.t === 'bump') { st.hostOn = true; kick(); return; }
          if (m.t !== 'res') return;
          var w = CW.pending[m.id]; if (!w) return;
          if (m.queued || m.offline) { delete CW.pending[m.id]; clearTimeout(w.to); st.hostOn = false; if (m.queued) w.resolve({ __queued: true }); else w.reject(new Error('The store PC is off or not online right now')); return; }
          var enc = m.enc; if (m.parts) { var e = CW.parts[m.id] || (CW.parts[m.id] = { p: [], n: 0 }); if (e.p[m.part] === undefined) { e.p[m.part] = m.enc; e.n++; } if (e.n < m.parts) return; enc = e.p.join(''); delete CW.parts[m.id]; }
          delete CW.pending[m.id]; clearTimeout(w.to); st.hostOn = true;
          unseal(L.key, enc).then(function (r) { if (r && r.status) { var er = new Error(r.error || 'Store PC error'); er.status = r.status; w.reject(er); } else w.resolve(r); }, function () { w.reject(new Error('Could not open the answer — connect this browser again.')); });
        };
        ws.onclose = function (ev) { clearTimeout(to); clearInterval(CW.ping); if (CW.ws === ws) CW.ws = null; if (CW.ready) { CW.ready = null; reject(new Error(ev.reason || 'Can’t reach Cloud Sync (check the internet)')); } Object.keys(CW.pending).forEach(function (id) { var w = CW.pending[id]; clearTimeout(w.to); w.reject(new Error('Connection to Cloud Sync dropped')); delete CW.pending[id]; }); };
      });
    });
    CW.ready.catch(function () { CW.ready = null; });
    return CW.ready;
  }
  async function req(path, body, timeout, queueable, L) {
    L = L || LINK; var ws = await cloudWs(L); var id = rid();
    var enc = await seal(L.key, { path: path, body: body, token: L.token || '' }, CANZ);
    return new Promise(function (resolve, reject) {
      var to = setTimeout(function () { delete CW.pending[id]; reject(new Error('The store PC did not answer in time')); }, timeout || 30000);
      CW.pending[id] = { resolve: resolve, reject: reject, to: to };
      var n = Math.max(1, Math.ceil(enc.length / 600000));
      for (var i = 0; i < n; i++) { var msg = { t: 'req', id: id, enc: enc.slice(i * 600000, (i + 1) * 600000) }; if (CANZ) msg.z = 1; if (queueable) msg.q = 1; if (n > 1) { msg.part = i; msg.parts = n; } ws.send(JSON.stringify(msg)); }
    });
  }

  /* ---------- keeping the copy up to date ---------- */
  function localNextOrder() { var s = MEM.kv.get('settings') || {}; return Math.max(Number(s.nextOrder) || 0, ((LINK && LINK.reg) || 9) * 1000000 + 1); }
  async function applyItems(items, skipPending) {
    var ch = { products: [], kv: {}, orders: false };
    await idbTx(['rec'], function (t) {
      (items || []).forEach(function (it) {
        var k = String(it.key);
        if (it.store === 'kv' && LOCAL_KV.indexOf(k) >= 0) return;
        if (skipPending && it.store !== 'orders' && pending(it.store, k)) return;
        if (it.store === 'products') { if (it.deleted || !it.data) { memDel(t, 'products', k); ch.products.push({ sku: k, deleted: true }); } else { memPut(t, 'products', k, it.data); ch.products.push(it.data); } }
        else if (it.store === 'orders') { if (it.deleted || !it.data) memDel(t, 'orders', k); else memPut(t, 'orders', k, it.data); ch.orders = true; }
        else if (it.store === 'kv') { var v = it.data; if (k === 'settings' && v) v = Object.assign({}, v, { nextOrder: localNextOrder() }); memPut(t, 'kv', k, v); ch.kv[k] = v; }
      });
    });
    return ch;
  }
  async function snapshot(L) {
    var snap = { stage: 'products', after: '' }, startSeq = null, first = true, n = 0;
    while (snap) {
      st.progress = 'Copying from the store PC… ' + n.toLocaleString() + ' records'; showProgress(st.progress); emitLink();
      var res = await req('/sync', { snap: Object.assign({}, snap, { startSeq: startSeq }) }, 120000, false, L);
      if (res.__queued) throw new Error('The store PC is off or not online right now. Turn it on, then try again.');
      if (first) {
        await idbTx(['rec'], function (t) { t.objectStore('rec').clear(); });
        MEM.products.clear(); MEM.orders.clear(); MEM.kv.clear();
        first = false; startSeq = res.startSeq; L.epoch = res.epoch;
      }
      await applyItems(res.items, false); n += (res.items || []).length; snap = res.next;
    }
    L.since = startSeq; L.ready = true; st.progress = ''; await metaSet('link', L);
  }
  var kickT = null; function kick() { if (!LINK) return; clearTimeout(kickT); kickT = setTimeout(syncOnce, 400); }
  async function syncOnce() {
    if (!LINK || !LINK.token || st.busy) return;
    st.busy = true; var again = false;
    try {
      if (!LINK.ready) { await snapshot(LINK); emit({ full: true }); }
      var rows = OUT.slice(0, 250);
      var ops = rows.map(function (r) { return { store: r.store, key: r.key, op: r.op, data: r.data, delta: r.delta }; });
      var res = await req('/sync', { since: LINK.since || 0, epoch: LINK.epoch, ops: ops }, 60000, ops.length > 0);
      if (res.__queued) { await dropOut(rows); again = OUT.length > 0; }
      else if (res.resync) { LINK.ready = false; await metaSet('link', LINK); again = true; }
      else {
        await dropOut(rows);
        var ch = await applyItems(res.items, true); LINK.since = res.seq; await metaSet('link', LINK);
        if (ch.products.length || ch.orders || Object.keys(ch.kv).length) emit(ch);
        again = !!res.more || OUT.length > 0;
      }
      st.online = true; st.lastOk = Date.now(); st.lastErr = res.__queued ? 'The store PC is off — your changes are saved in Cloud Sync and reach it when it is back on.' : '';
    } catch (e) { st.online = false; st.lastErr = e.message; st.progress = ''; if (e.status === 401) st.lastErr = 'The store PC removed this browser. Connect it again.'; }
    finally { st.busy = false; emitLink(); }
    if (again) setTimeout(syncOnce, 150);
  }
  async function dropOut(rows) { if (!rows.length) return; var ids = rows.map(function (r) { return r.id; }); OUT = OUT.filter(function (o) { return ids.indexOf(o.id) < 0; }); await idbTx(['outbox'], function (t) { ids.forEach(function (id) { t.objectStore('outbox').delete(id); }); }); }
  setInterval(function () { if (LINK && LINK.token && (!st.online || Date.now() - st.lastOk > 25000)) syncOnce(); }, 5000);
  window.addEventListener('online', kick);

  /* ---------- reports: from the store PC (all history), or from this browser's copy if the store PC is off ---------- */
  async function viaPc(method, args, local) {
    if (LINK && LINK.ready && st.online && st.hostOn !== false) { try { var r = await req('/api', { method: method, args: args }, 30000); if (!r.__queued) return r.result; } catch (e) { } }
    return local.apply(null, args);
  }
  function ordersIn(a, b) { var out = []; MEM.orders.forEach(function (o) { if (o.time >= a && o.time <= b) out.push(o); }); return out; }
  var LOCALQ = {
    ordersQuery: function (o) {
      var q = String(o.q || '').trim(), status = o.status, limit = Math.max(1, Math.min(5000, Number(o.limit) || 400)), list = [], item = null;
      MEM.orders.forEach(function (x) { list.push(x); });
      if (o.sku) {
        var skus = [String(o.sku), String(q)].filter(Boolean), has = function (x) { return (x.lines || []).some(function (l) { return skus.indexOf(String(l.sku)) >= 0; }); };
        list = list.filter(has); var qty = 0, q30 = 0, first = null, last = null;
        list.forEach(function (x) { (x.lines || []).forEach(function (l) { if (skus.indexOf(String(l.sku)) < 0) return; if (l.qty > 0) { qty += l.qty; first = first == null ? x.time : Math.min(first, x.time); last = last == null ? x.time : Math.max(last, x.time); } if (x.time >= Date.now() - 30 * DAY) q30 += l.qty; }); });
        item = { sku: o.sku, last: last, first: first, qty: qty, orders: list.length, qty30: q30 };
      } else if (/^\d{4}$/.test(q)) list = list.filter(function (x) { return x.num === Number(q) || JSON.stringify(x).indexOf('"last4":"' + q + '"') >= 0; });
      else if (/^\d{1,7}$/.test(q)) list = list.filter(function (x) { return x.num === Number(q); });
      else { list = list.filter(function (x) { return x.time >= o.a && x.time <= o.b; }); if (q) { var qq = q.toUpperCase(); list = list.filter(function (x) { return JSON.stringify(x).toUpperCase().indexOf(qq) >= 0; }); } }
      if (Array.isArray(status) && status.length) list = list.filter(function (x) { return status.indexOf(String(x.status || '')) >= 0; });
      list.sort(function (x, y) { return y.time - x.time; });
      return { count: list.length, total: list.reduce(function (s, x) { return s + (Number(x.total) || 0); }, 0), rows: list.slice(0, limit), item: item, local: true };
    },
    orderGet: function (id) { return MEM.orders.get(String(id)) || null; },
    report: function (a, b) {
      var R = { n: 0, refN: 0, refunds: 0, gross: 0, disc: 0, tax: 0, total: 0, tend: {}, cats: {}, items: {}, taxes: {}, cost: 0 };
      ordersIn(a, b).forEach(function (o) {
        if (o.status === 'void') return;
        if (o.status === 'refund') { R.refN++; R.refunds += o.total; } else R.n++;
        R.gross += o.subtotal || 0; R.disc += o.discount || 0; R.tax += o.tax || 0; R.total += o.total || 0;
        (o.payments || []).forEach(function (p) { R.tend[p.type] = (R.tend[p.type] || 0) + p.amount; });
        if (o.change) R.tend.Cash = (R.tend.Cash || 0) - o.change;
        (o.taxes || []).forEach(function (t) { R.taxes[t.name] = (R.taxes[t.name] || 0) + t.amount; });
        (o.lines || []).forEach(function (l) {
          var c = l.fee ? 'Fees' : (l.cat || 'Other'), cost = (l.cost || 0) * l.qty;
          var k = R.cats[c] = R.cats[c] || { qty: 0, sales: 0, cost: 0 }; k.qty += l.qty; k.sales += l.net; k.cost += cost; R.cost += cost;
          if (!l.fee) { var key = l.sku + '|' + l.name; var it = R.items[key] = R.items[key] || { sku: l.sku, name: l.name, cat: l.cat, qty: 0, sales: 0, cost: 0 }; it.qty += l.qty; it.sales += l.net; it.cost += cost; }
        });
      });
      R.net = R.gross - R.disc; return R;
    },
    reportDaily: function (a, b) {
      var days = {}, key = function (t) { var d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
      ordersIn(a, b).forEach(function (o) {
        if (o.status === 'void') return;
        var D = days[key(o.time)] = days[key(o.time)] || { n: 0, refN: 0, refunds: 0, gross: 0, disc: 0, tax: 0, total: 0, cost: 0, card: 0 };
        if (o.status === 'refund') { D.refN++; D.refunds += o.total || 0; } else D.n++;
        D.gross += o.subtotal || 0; D.disc += o.discount || 0; D.tax += o.tax || 0; D.total += o.total || 0;
        (o.payments || []).forEach(function (p) { if (p.type === 'Credit' || p.type === 'Debit') D.card += p.amount || 0; });
        (o.lines || []).forEach(function (l) { D.cost += (l.cost || 0) * (l.qty || 0); });
      });
      return days;
    },
    itemMonthly: function (sku) {
      var y = new Date().getFullYear(), cur = Array(12).fill(0), prev = Array(12).fill(0);
      MEM.orders.forEach(function (o) { if (o.status === 'void') return; var d = new Date(o.time), yy = d.getFullYear(); if (yy !== y && yy !== y - 1) return; (o.lines || []).forEach(function (l) { if (String(l.sku) === String(sku) && !l.fee) (yy === y ? cur : prev)[d.getMonth()] += Number(l.qty) || 0; }); });
      return { cur: cur.map(function (v) { return Math.round(v * 100) / 100; }), prev: prev.map(function (v) { return Math.round(v * 100) / 100; }) };
    },
    stats: function () { var first = null; MEM.orders.forEach(function (o) { first = first == null ? o.time : Math.min(first, o.time); }); return { orders: MEM.orders.size, firstOrder: first, products: MEM.products.size, history: { finished: true } }; }
  };

  /* ---------- printing from the browser (print window: printer or Save as PDF) ---------- */
  function printHtml(html, css, w) {
    return new Promise(function (res) {
      var f = document.createElement('iframe'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
      document.body.appendChild(f);
      var d = f.contentWindow.document; d.open(); d.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}' + (css || '') + '</style></head><body' + (w ? ' style="width:' + w + 'mm"' : '') + '>' + html + '</body></html>'); d.close();
      setTimeout(function () { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { } setTimeout(function () { f.remove(); res({ ok: true, printer: 'browser' }); }, 1000); }, 300);
    });
  }
  var noHw = function () { return Promise.resolve({ ok: false, error: 'Receipt printers and cash drawers work on the store PC — not in the web back office.' }); };

  /* ---------- "Connect to your store" screen ---------- */
  var gate = null;
  function showProgress(t) { var p = document.getElementById('wbProg'); if (p) p.textContent = t || ''; }
  function connectScreen(err) {
    return new Promise(function (done) {
      gate = document.createElement('div'); gate.id = 'webGate';
      gate.innerHTML = '<style>#webGate{position:fixed;inset:0;z-index:99999;background:#0f1b2d;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,Segoe UI,Arial,sans-serif;padding:16px}#webGate .bx{background:#fff;border-radius:16px;max-width:460px;width:100%;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.4)}#webGate h1{margin:0 0 4px;font-size:24px;color:#0f1b2d}#webGate p{color:#4b5568;font-size:14px;line-height:1.45;margin:8px 0}#webGate label{display:block;font-size:13px;font-weight:600;color:#334;margin:14px 0 4px}#webGate input{width:100%;box-sizing:border-box;font-size:20px;padding:12px;border:1px solid #c8d0dc;border-radius:10px}#webGate #wbCode{letter-spacing:4px;text-transform:uppercase;text-align:center;font-weight:700}#webGate button{margin-top:18px;width:100%;font-size:18px;font-weight:700;padding:14px;border:0;border-radius:10px;background:#1f9d55;color:#fff;cursor:pointer}#webGate button:disabled{opacity:.6}#webGate .err{color:#c62828;font-weight:600}#webGate .ok{color:#1f6fd1;font-weight:600}</style>' +
        '<div class="bx"><h1>Store POS — Back office</h1><p>Manage items, prices, stock, employees and reports from any browser. Changes go straight to your store.</p>' +
        '<p><b>On the store PC:</b> Settings → Tablets → turn on <b>Sync over the internet</b> → <b>Pair a tablet or PC</b>. Type the <b>Cloud code</b> it shows.</p>' +
        '<label>Cloud code</label><input id="wbCode" placeholder="ABCD-EFGH" autocomplete="off" maxlength="9">' +
        '<label>Name for this browser</label><input id="wbName" value="Owner – web" autocomplete="off">' +
        '<button id="wbGo">Connect to my store</button><p id="wbProg" class="ok"></p><p id="wbErr" class="err">' + (err || '') + '</p>' +
        '<p style="font-size:12px">Your store data is locked with your store’s own key before it leaves the store PC. Only use this on a computer or phone you trust — anyone using this browser can open the POS (they still need an employee PIN).</p></div>';
      document.body.appendChild(gate);
      var go = gate.querySelector('#wbGo');
      gate.querySelector('#wbCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
      go.onclick = async function () {
        go.disabled = true; gate.querySelector('#wbErr').textContent = ''; showProgress('Connecting…');
        try { await pair(gate.querySelector('#wbCode').value, gate.querySelector('#wbName').value); gate.remove(); gate = null; done(); }
        catch (e) { gate.querySelector('#wbErr').textContent = e.message; showProgress(''); go.disabled = false; }
      };
    });
  }
  async function pair(codeIn, name) {
    var code = normCode(codeIn); if (code.length !== 8) throw new Error('Type the 8-letter Cloud code shown on the store PC');
    var g; try { g = await fetch(BASE + '/v1/pair/' + (await pairId(code))); } catch (e) { throw new Error('Can’t reach Cloud Sync (check the internet)'); }
    var gj = await g.json(); if (!g.ok) throw new Error(gj.error || 'That code is wrong or expired');
    var offer; try { offer = await unseal(await pairKey(code), gj.blob); } catch (e) { throw new Error('That code is wrong or expired'); }
    var cid = (await idbGet('meta', 'cid')) || ('web-' + rid()); await metaSet('cid', cid);
    var L = { storeId: offer.storeId, key: offer.key, cid: cid, token: '', name: String(name || 'Web browser').slice(0, 40) };
    CW.ws = null; CW.ready = null;
    var r = await req('/pair', { code: offer.lanCode, deviceId: cid, name: L.name + ' (web)' }, 20000, false, L);
    if (r.__queued) throw new Error('The store PC is off or not online right now. Turn it on, then try again.');
    Object.assign(L, { token: r.token, reg: r.reg, store: r.store, epoch: r.epoch, since: 0, ready: false });
    OUT = []; await idbTx(['outbox'], function (t) { t.objectStore('outbox').clear(); });
    await snapshot(L); LINK = L; st.online = true; st.lastOk = Date.now(); st.lastErr = '';
  }

  /* ---------- start ---------- */
  var READY = (async function () {
    await idbOpen();
    LINK = (await idbGet('meta', 'link')) || null; CFG = (await idbGet('meta', 'cfg')) || {};
    if (LINK && LINK.ready && LINK.token) {
      (await idbAll('rec')).forEach(function (r) { if (MEM[r.store]) MEM[r.store].set(r.key, r.data); });
      OUT = await idbAll('outbox');
      setTimeout(syncOnce, 800);
    } else { LINK = null; await connectScreen(); }
  })();
  READY.catch(function (e) { document.body.innerHTML = '<p style="font:16px sans-serif;padding:20px">This browser can’t store data (' + e + '). Turn off private browsing and try again.</p>'; });
  function linkState() { return { linked: !!(LINK && LINK.token), ready: !!(LINK && LINK.ready), mode: 'cloud', host: 'over the internet', store: LINK && LINK.store, reg: LINK && LINK.reg, online: st.online, hostOn: st.hostOn, lastOk: st.lastOk, lastErr: st.lastErr, progress: st.progress, pending: OUT.length, deviceName: LINK && LINK.name, web: true }; }
  async function queue(t, store, op, k, data, delta) { var row = { store: store, key: k, op: op, data: data, delta: delta, ts: Date.now() }; if (store === 'kv') { OUT.filter(function (o) { return o.store === 'kv' && o.key === k; }).forEach(function (o) { t.objectStore('outbox').delete(o.id); }); OUT = OUT.filter(function (o) { return !(o.store === 'kv' && o.key === k); }); } var q = t.objectStore('outbox').add(row); q.onsuccess = function () { row.id = q.result; OUT.push(row); }; }
  function putVals(store, vals, key) {
    return idbTx(['rec', 'outbox'], function (t) {
      vals.forEach(function (v) {
        var k = keyOf(store, v, key); if (store === 'kv' && LOCAL_KV.indexOf(k) >= 0) { memPut(t, 'kv', k, v); return; }
        var delta = null; if (store === 'products') { var old = MEM.products.get(k); delta = Math.round(((Number(v.stock) || 0) - (old ? Number(old.stock) || 0 : 0)) * 100) / 100; }
        var data = JSON.parse(JSON.stringify(v === undefined ? null : v));
        memPut(t, store, k, data); queue(t, store, 'put', k, data, delta);
      });
    }).then(function () { kick(); return true; });
  }
  var ver = '';
  fetch('package.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { ver = j.version; }).catch(function () { });

  window.posAPI = {
    isDesktop: true, isAndroid: false, isWeb: true,
    db: async function (op, store, a, b) {
      await READY; if (!MEM[store]) throw new Error('Unknown store ' + store);
      switch (op) {
        case 'all': var arr = []; MEM[store].forEach(function (v) { arr.push(v); }); if (store === 'orders') arr.sort(function (x, y) { return x.time - y.time; }); return arr;
        case 'get': var v = MEM.kv.get(String(a)); return v === undefined ? undefined : v;
        case 'put': return putVals(store, [a], b);
        case 'putMany': return putVals(store, a || []);
        case 'del': await idbTx(['rec', 'outbox'], function (t) { memDel(t, store, String(a)); if (store !== 'kv') queue(t, store, 'del', String(a), null, null); }); kick(); return true;
        case 'clear': throw new Error('Not available in the web back office');
      }
      throw new Error('Unknown op ' + op);
    },
    firstRunData: async function () { return null; },
    ordersQuery: async function (o) { await READY; return viaPc('ordersQuery', [o], LOCALQ.ordersQuery); },
    orderGet: async function (id) { await READY; return viaPc('orderGet', [id], LOCALQ.orderGet); },
    report: async function (a, b) { await READY; return viaPc('report', [a, b], LOCALQ.report); },
    reportDaily: async function (a, b) { await READY; return viaPc('reportDaily', [a, b], LOCALQ.reportDaily); },
    itemMonthly: async function (sku) { await READY; return viaPc('itemMonthly', [sku], LOCALQ.itemMonthly); },
    stats: async function () { await READY; return viaPc('stats', [], LOCALQ.stats); },
    historyState: async function () { return { running: false, finished: true, done: 0, total: 0 }; }, onHistory: function () { },
    print: function (html, css) { return printHtml(html, css, 80); },
    printDoc: function (o) { return printHtml(o.html, o.css); },
    savePdf: async function (o) { await printHtml(o.html, o.css); return { ok: false, canceled: true }; },
    rawPrint: noHw, openDrawer: noHw, addPrinter: noHw,
    showFile: async function () { }, openFolder: async function () { }, openPath: async function () { return 'not available in the browser'; },
    saveInvoiceFile: async function () { return { ok: false }; },
    ocrImage: async function () { return { ok: false, error: 'Reading invoice photos works on the store PC — PDFs and Excel files work here.' }; },
    comPorts: async function () { return []; }, scannerState: async function () { return { status: 'off' }; }, restartScanner: async function () { return { status: 'off' }; },
    onScan: function () { }, onScannerState: function () { },
    printers: async function () { return [{ name: 'Browser printing (print window)', isDefault: true }]; },
    getConfig: async function () { await READY; return Object.assign({ rcptConn: 'driver', paper: 80, cols: 48, drawerMode: 'none' }, CFG, { appVersion: ver, version: ver, platform: 'web', dataDir: 'this browser' }); },
    setConfig: async function (patch) { Object.keys(patch || {}).forEach(function (k) { CFG[k] = patch[k]; }); await metaSet('cfg', CFG); return CFG; },
    backupNow: async function () { return { ok: false, error: 'Backups are made on the store PC' }; },
    checkUpdate: async function () { return { ok: true, available: null }; }, onUpdateAvailable: function () { },
    licenseState: async function () { await READY; return { status: 'licensed', locked: false, free: true, machine: 'WEB', customer: '', expires: '' }; },
    exitApp: async function () { },
    saveDownload: null,
    onSync: function (f) { syncCbs.push(f); },
    onLink: function (f) { linkCbs.push(f); },
    linkState: async function () { return linkState(); },
    linkSyncNow: async function () { await syncOnce(); return linkState(); },
    linkPair: async function () { return { ok: false, error: 'Use “Unlink” and connect again.' }; },
    unlink: async function () {
      LINK = null; try { if (CW.ws) CW.ws.close(); } catch (e) { }
      await idbTx(['rec', 'outbox', 'meta'], function (t) { t.objectStore('rec').clear(); t.objectStore('outbox').clear(); t.objectStore('meta').delete('link'); });
      setTimeout(function () { location.reload(); }, 300); return { ok: true };
    }
  };
  delete window.posAPI.saveDownload;
})();
