'use strict';
// Store POS — Windows desktop shell.
// Data: SQLite file (pos.db) in %APPDATA%\Store POS\data
// Backups: daily compressed copies of the database in %APPDATA%\Store POS\backups (+ optional extra folder)
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

/* ---------- small-file updates: run a newer copy of the app from %APPDATA%\Store POS\app-update\current ---------- */
const UPDATE_DIR = path.join(app.getPath('userData'), 'app-update');
const ATTEMPTS = path.join(UPDATE_DIR, 'attempts.json');
const verNum = v => String(v || '0').split('.').map(n => parseInt(n, 10) || 0);
const verGt = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
if (!global.__storeposBoot) {
  global.__storeposBoot = { bundledDir: __dirname, bundledVersion: require('./package.json').version, updateDir: null, rolledBack: '' };
  let att = {}; try { att = JSON.parse(fs.readFileSync(ATTEMPTS, 'utf8')); } catch (e) { /* none */ }
  if (!att || typeof att !== 'object' || att.version) att = {}; // old single-version format
  for (const dir of ['current', 'previous']) {
    const cand = path.join(UPDATE_DIR, dir);
    let v; try { v = JSON.parse(fs.readFileSync(path.join(cand, 'package.json'), 'utf8')).version; } catch (e) { continue; }
    if (!verGt(v, global.__storeposBoot.bundledVersion)) continue;
    if ((att[v] || 0) >= 2) { global.__storeposBoot.rolledBack = global.__storeposBoot.rolledBack || v; continue; } // failed to start twice
    att[v] = (att[v] || 0) + 1; try { fs.writeFileSync(ATTEMPTS, JSON.stringify(att)); } catch (e) { /* ignore */ }
    global.__storeposBoot.updateDir = cand;
    try { require(path.join(cand, 'main.js')); }
    catch (err) { // broken update: remember it and restart (falls back to the previous working version)
      att[v] = 99; try { fs.writeFileSync(ATTEMPTS, JSON.stringify(att)); } catch (e) { /* ignore */ }
      app.relaunch(); app.exit(0);
    }
    return; // the updated copy runs the app
  }
}
const BOOT = global.__storeposBoot;
const ASSET = name => { const a = path.join(__dirname, name); return fs.existsSync(a) ? a : path.join(BOOT.bundledDir, name); };

process.removeAllListeners('warning'); // hide the "SQLite is experimental" notice
const { DatabaseSync } = require('node:sqlite');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const USER = app.getPath('userData');
const DATA_DIR = path.join(USER, 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
const BACKUP_DIR = path.join(USER, 'backups');
const CFG_FILE = path.join(USER, 'config.json');
const FIRST_RUN = ASSET('first-run-data.json');
const HISTORY_FILE = ASSET('first-run-history.jsonl.gz');
const KEEP_BACKUPS = 14;
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ---------- machine config ---------- */
const CFG_DEFAULT = { updateUrl: 'https://raw.githubusercontent.com/atrivedi85/storepos-updates/main/latest.json', labelPrinter: '', rcptConn: 'driver', cmdSet: 'escpos', cols: 48, cut: true, feed: 4, drawerPin: 2, netHost: '', netPort: 9100, comPort: '', comBaud: 9600, comFlow: 'none', scanCom: '', scanBaud: 9600, reportPrinter: '', printer: '', paper: 80, drawerOnCash: true, drawerMode: 'raw', kiosk: true, autoStart: true, backupDir: '', lastBackup: 0, lastBackupFile: '', lastBackupError: '' };
let cfg = { ...CFG_DEFAULT };
try { cfg = { ...CFG_DEFAULT, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch (e) { /* first run */ }
function saveCfg() {
  const tmp = CFG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CFG_FILE);
}

/* ---------- database ---------- */
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS products(sku TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, time INTEGER, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS order_lines(order_id TEXT NOT NULL, time INTEGER, sku TEXT, qty REAL, net REAL, cost REAL, cat TEXT);
  CREATE INDEX IF NOT EXISTS orders_time ON orders(time);
  CREATE INDEX IF NOT EXISTS lines_order ON order_lines(order_id);
  CREATE INDEX IF NOT EXISTS lines_sku_time ON order_lines(sku, time);`);
// v1.1 columns (added to databases created by v1.0)
const ocols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
if (!ocols.includes('num')) db.exec('ALTER TABLE orders ADD COLUMN num INTEGER');
if (!ocols.includes('status')) db.exec('ALTER TABLE orders ADD COLUMN status TEXT');
if (!ocols.includes('total')) db.exec('ALTER TABLE orders ADD COLUMN total REAL');
db.exec('CREATE INDEX IF NOT EXISTS orders_num ON orders(num)');

const Q = {
  products: {
    all: db.prepare('SELECT data FROM products'),
    put: db.prepare('INSERT OR REPLACE INTO products(sku,data) VALUES(?,?)'),
    del: db.prepare('DELETE FROM products WHERE sku=?'),
    clear: db.prepare('DELETE FROM products')
  },
  orders: {
    all: db.prepare('SELECT data FROM orders ORDER BY time'),
    put: db.prepare('INSERT OR REPLACE INTO orders(id,time,num,status,total,data) VALUES(?,?,?,?,?,?)'),
    del: db.prepare('DELETE FROM orders WHERE id=?'),
    clear: db.prepare('DELETE FROM orders')
  },
  kv: {
    all: db.prepare('SELECT data FROM kv'),
    get: db.prepare('SELECT data FROM kv WHERE key=?'),
    put: db.prepare('INSERT OR REPLACE INTO kv(key,data) VALUES(?,?)'),
    del: db.prepare('DELETE FROM kv WHERE key=?'),
    clear: db.prepare('DELETE FROM kv')
  }
};
const L = {
  del: db.prepare('DELETE FROM order_lines WHERE order_id=?'),
  ins: db.prepare('INSERT INTO order_lines(order_id,time,sku,qty,net,cost,cat) VALUES(?,?,?,?,?,?,?)'),
  clear: db.prepare('DELETE FROM order_lines')
};
function putOrder(o) {
  const id = String(o.id), time = Number(o.time) || 0;
  Q.orders.put.run(id, time, Number(o.num) || null, String(o.status || ''), Number(o.total) || 0, JSON.stringify(o));
  L.del.run(id);
  if (o.status !== 'void') for (const l of o.lines || []) {
    if (l.fee) continue;
    L.ins.run(id, time, String(l.sku ?? ''), Number(l.qty) || 0, Number(l.net) || 0, (Number(l.cost) || 0) * (Number(l.qty) || 0), String(l.cat || ''));
  }
}
function putOne(store, val, key) {
  if (store === 'kv') return Q.kv.put.run(String(key), JSON.stringify(val === undefined ? null : val));
  if (store === 'orders') return putOrder(val);
  return Q.products.put.run(String(val.sku), JSON.stringify(val));
}
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const parseRows = rows => rows.map(r => JSON.parse(r.data));
ipcMain.handle('db', (e, op, store, a, b) => {
  if (!Q[store]) throw new Error('Unknown store ' + store);
  switch (op) {
    case 'all': return parseRows(Q[store].all.all());
    case 'get': { const r = Q.kv.get.get(String(a)); return r ? JSON.parse(r.data) : undefined; }
    case 'put': putOne(store, a, b); return true;
    case 'putMany': tx(() => (a || []).forEach(v => putOne(store, v))); return true;
    case 'del': Q[store].del.run(String(a)); if (store === 'orders') L.del.run(String(a)); return true;
    case 'clear': Q[store].clear.run(); if (store === 'orders') L.clear.run(); return true;
    default: throw new Error('Unknown op ' + op);
  }
});
// one-time: fill order_lines for orders saved by v1.0
if (db.prepare('SELECT COUNT(*) n FROM order_lines').get().n === 0 && db.prepare('SELECT COUNT(*) n FROM orders').get().n > 0) {
  tx(() => { for (const r of Q.orders.all.all()) putOrder(JSON.parse(r.data)); });
}
ipcMain.handle('firstRunData', () => {
  try { return JSON.parse(fs.readFileSync(FIRST_RUN, 'utf8')); } catch (e) { return null; }
});

/* ---------- order history queries (all done here so 190k+ orders never load into the screen) ---------- */
function rowsIn(sql, params) { const st = db.prepare(sql); return typeof st.iterate === 'function' ? st.iterate(...params) : st.all(...params); }
ipcMain.handle('ordersQuery', (e, { a, b, q, sku, status, limit = 400 }) => {
  q = String(q || '').trim();
  let where = 'time BETWEEN ? AND ?', params = [a, b], item = null;
  if (sku) {
    // every transaction that sold this item, all time, newest first
    const skus = [...new Set([String(sku), String(q)].filter(Boolean))];
    const ph = skus.map(() => '?').join(',');
    where = `id IN (SELECT order_id FROM order_lines WHERE sku IN (${ph}))`; params = skus;
    const st = db.prepare(`SELECT MAX(time) last, MIN(time) first, COALESCE(SUM(qty),0) qty, COUNT(DISTINCT order_id) n FROM order_lines WHERE sku IN (${ph}) AND qty > 0`).get(...skus);
    const d30 = db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM order_lines WHERE sku IN (${ph}) AND time >= ?`).get(...skus, Date.now() - 30 * 86400000);
    item = { sku, last: st.last, first: st.first, qty: st.qty, orders: st.n, qty30: d30.q };
  } else if (/^\d{4}$/.test(q)) { where = '(num = ? OR data LIKE ?)'; params = [Number(q), `%"last4":"${q}"%`]; }   // order # or card last 4
  else if (/^\d{1,7}$/.test(q)) { where = 'num = ?'; params = [Number(q)]; }
  else if (q) { where += ' AND data LIKE ?'; params.push('%' + q.replace(/[%_"]/g, '') + '%'); }
  if (Array.isArray(status) && status.length) { where = `(${where}) AND status IN (${status.map(() => '?').join(',')})`; params.push(...status.map(String)); }
  const agg = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM orders WHERE ${where}`).get(...params);
  const rows = db.prepare(`SELECT data FROM orders WHERE ${where} ORDER BY time DESC LIMIT ?`).all(...params, limit);
  return { count: agg.n, total: agg.s, rows: parseRows(rows), item };
});
ipcMain.handle('orderGet', (e, id) => { const r = db.prepare('SELECT data FROM orders WHERE id=?').get(String(id)); return r ? JSON.parse(r.data) : null; });
ipcMain.handle('report', (e, a, b) => {
  const R = { n: 0, refN: 0, refunds: 0, gross: 0, disc: 0, tax: 0, total: 0, tend: {}, cats: {}, items: {}, taxes: {}, cost: 0 };
  for (const row of rowsIn('SELECT data FROM orders WHERE time BETWEEN ? AND ?', [a, b])) {
    const o = JSON.parse(row.data);
    if (o.status === 'void') continue;
    if (o.status === 'refund') { R.refN++; R.refunds += o.total; } else R.n++;
    R.gross += o.subtotal || 0; R.disc += o.discount || 0; R.tax += o.tax || 0; R.total += o.total || 0;
    for (const p of o.payments || []) R.tend[p.type] = (R.tend[p.type] || 0) + p.amount;
    if (o.change) R.tend.Cash = (R.tend.Cash || 0) - o.change;
    for (const t of o.taxes || []) R.taxes[t.name] = (R.taxes[t.name] || 0) + t.amount;
    for (const l of o.lines || []) {
      const c = l.fee ? 'Fees' : (l.cat || 'Other'), cost = (l.cost || 0) * l.qty;
      const k = R.cats[c] = R.cats[c] || { qty: 0, sales: 0, cost: 0 };
      k.qty += l.qty; k.sales += l.net; k.cost += cost; R.cost += cost;
      if (!l.fee) {
        const key = l.sku + '|' + l.name;
        const it = R.items[key] = R.items[key] || { sku: l.sku, name: l.name, cat: l.cat, qty: 0, sales: 0, cost: 0 };
        it.qty += l.qty; it.sales += l.net; it.cost += cost;
      }
    }
  }
  R.net = R.gross - R.disc;
  return R;
});
ipcMain.handle('itemMonthly', (e, sku) => {
  const y = new Date().getFullYear();
  const start = new Date(y - 1, 0, 1).getTime();
  const rows = db.prepare(`SELECT CAST(strftime('%Y', time/1000, 'unixepoch', 'localtime') AS INTEGER) y, CAST(strftime('%m', time/1000, 'unixepoch', 'localtime') AS INTEGER) m, SUM(qty) q
    FROM order_lines WHERE sku=? AND time>=? GROUP BY y, m`).all(String(sku), start);
  const cur = Array(12).fill(0), prev = Array(12).fill(0);
  for (const r of rows) (r.y === y ? cur : prev)[r.m - 1] = Math.round(r.q * 100) / 100;
  return { cur, prev };
});
ipcMain.handle('stats', () => {
  const o = db.prepare('SELECT COUNT(*) n, MIN(time) first FROM orders').get();
  return { orders: o.n, firstOrder: o.first, products: db.prepare('SELECT COUNT(*) n FROM products').get().n, history: historyState };
});

/* ---------- one-time import of the old POS sales history (bundled file) ---------- */
let historyState = { running: false, done: 0, total: 0, finished: false, error: '' };
function send(ch, msg) { if (win && !win.isDestroyed()) win.webContents.send(ch, msg); }
const HISTORY_VERSION = 2;
function mergeLast4(o) {
  const r = db.prepare('SELECT data FROM orders WHERE id=?').get(String(o.id));
  if (!r) { putOrder(o); return; }
  const cur = JSON.parse(r.data); let changed = false;
  (o.payments || []).forEach((p, i) => { const c = (cur.payments || [])[i]; if (p.last4 && c && c.type === p.type && !c.last4) { c.last4 = p.last4; changed = true; } });
  if (changed) putOrder(cur);
}
async function importHistory(file, upgrade = false) {
  if (historyState.running) return historyState;
  historyState = { running: true, done: 0, total: 0, finished: false, error: '' };
  try {
    const meta = file + '.count';
    try { historyState.total = Number(fs.readFileSync(meta, 'utf8')) || 0; } catch (e) { /* unknown */ }
    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let batch = [];
    const flush = () => { const b = batch; batch = []; tx(() => b.forEach(upgrade ? mergeLast4 : putOrder)); historyState.done += b.length; send('history', historyState); };
    for await (const line of rl) {
      if (!line.trim()) continue;
      batch.push(JSON.parse(line));
      if (batch.length >= 2000) { flush(); await new Promise(r => setImmediate(r)); }
    }
    if (batch.length) flush();
    Q.kv.put.run('historyImported', JSON.stringify({ time: Date.now(), count: historyState.done, file: path.basename(file), version: HISTORY_VERSION }));
    historyState.finished = true;
  } catch (e) {
    historyState.error = e.message;
  }
  historyState.running = false;
  send('history', historyState);
  return historyState;
}
function maybeImportHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return;
  const done = Q.kv.get.get('historyImported');
  if (done) { const v = (JSON.parse(done.data) || {}).version || 1; if (v < HISTORY_VERSION) importHistory(HISTORY_FILE, true); return; }
  if (!db.prepare('SELECT COUNT(*) n FROM products').get().n) { setTimeout(maybeImportHistory, 5000); return; } // wait for first-run items
  importHistory(HISTORY_FILE);
}
ipcMain.handle('historyState', () => historyState);

/* ---------- backups (compressed copy of the whole database) ---------- */
function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => /^pos-backup-.*\.(json|db\.gz)$/.test(f)).sort();
    files.slice(0, Math.max(0, files.length - KEEP_BACKUPS)).forEach(f => fs.unlinkSync(path.join(dir, f)));
  } catch (e) { /* ignore */ }
}
let backupRunning = false;
async function backupNow() {
  if (backupRunning) return { ok: false, errors: ['A backup is already running'] };
  if (historyState.running) return { ok: false, errors: ['Wait until the sales history import finishes'] };
  backupRunning = true;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const name = `pos-backup-${stamp}.db.gz`;
  const snap = path.join(DATA_DIR, 'snapshot.tmp.db');
  const errors = [];
  try {
    try { fs.unlinkSync(snap); } catch (e) { /* none */ }
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    const dirs = [BACKUP_DIR];
    if (cfg.backupDir) dirs.push(cfg.backupDir);
    for (const d of dirs) {
      try {
        fs.mkdirSync(d, { recursive: true });
        const tmp = path.join(d, name + '.tmp');
        await pipeline(fs.createReadStream(snap), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp));
        fs.renameSync(tmp, path.join(d, name));
        prune(d);
      } catch (e) { errors.push(`${d}: ${e.message}`); }
    }
  } catch (e) { errors.push(e.message); }
  try { fs.unlinkSync(snap); } catch (e) { /* none */ }
  backupRunning = false;
  cfg.lastBackup = Date.now(); cfg.lastBackupFile = name; cfg.lastBackupError = errors.join('; ');
  saveCfg();
  return { ok: !errors.length, file: name, errors, time: cfg.lastBackup };
}
function maybeBackup() {
  if (!Q.kv.get.get('settings')) return; // store not set up yet — nothing to back up
  if (Date.now() - (cfg.lastBackup || 0) > 20 * 3600 * 1000) backupNow().catch(() => {});
}
ipcMain.handle('backupNow', () => backupNow());
ipcMain.handle('chooseBackupDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose an extra backup folder (USB stick, OneDrive, etc.)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return cfg.backupDir;
  cfg.backupDir = r.filePaths[0]; saveCfg();
  return cfg.backupDir;
});
ipcMain.handle('addPrinter', () => { if (process.platform !== 'win32') return false; win.setKiosk(false); win.minimize(); shell.openExternal('ms-settings:printers'); return true; });
const INVOICE_DIR = path.join(DATA_DIR, 'invoices');
ipcMain.handle('saveInvoiceFile', (e, { name, bytes }) => {
  fs.mkdirSync(INVOICE_DIR, { recursive: true });
  const safe = String(name || 'invoice').replace(/[^\w.\- ]+/g, '_').slice(-80);
  const f = path.join(INVOICE_DIR, Date.now() + '-' + safe);
  fs.writeFileSync(f, Buffer.from(bytes)); return { path: f };
});
ipcMain.handle('openPath', (e, f) => { f = path.resolve(String(f || '')); if (!f.startsWith(INVOICE_DIR + path.sep)) return 'not allowed'; win.setKiosk(false); return shell.openPath(f); });
ipcMain.handle('showFile', (e, f) => { win.setKiosk(false); win.minimize(); shell.showItemInFolder(f); });
ipcMain.handle('openFolder', (e, which) => shell.openPath(which === 'backups' ? BACKUP_DIR : which === 'extra' && cfg.backupDir ? cfg.backupDir : DATA_DIR));
ipcMain.handle('restoreDb', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a Store POS backup', defaultPath: BACKUP_DIR, filters: [{ name: 'Store POS backup', extensions: ['gz'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const tmp = path.join(DATA_DIR, 'restore.tmp.db');
  try {
    await pipeline(fs.createReadStream(r.filePaths[0]), zlib.createGunzip(), fs.createWriteStream(tmp));
    const t = new DatabaseSync(tmp);
    const n = t.prepare('SELECT COUNT(*) n FROM products').get().n; t.close();
    if (!n) throw new Error('That backup has no items in it');
  } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* none */ } return { ok: false, error: e.message }; }
  const ok = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Restore and restart'], defaultId: 0, cancelId: 0, message: 'Replace ALL current data with this backup?', detail: path.basename(r.filePaths[0]) });
  if (ok.response !== 1) { fs.unlinkSync(tmp); return { ok: false, canceled: true }; }
  db.close();
  const keep = DB_FILE + '.before-restore';
  try { fs.copyFileSync(DB_FILE, keep); } catch (e) { /* none */ }
  for (const f of [DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  fs.renameSync(tmp, DB_FILE);
  quitting = true; app.relaunch(); app.exit(0);
  return { ok: true };
});

/* ---------- license keys (Ed25519-signed; only the License Maker's private key can create them) ---------- */
const LIC_PUB = crypto.createPublicKey({ key: Buffer.from('MCowBQYDK2VwAyEAChLk2xj5iczD4MkE2RBkAppOTPz5qaThemEoawP+iro=', 'base64'), format: 'der', type: 'spki' });
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function b32decode(str) {
  const clean = String(str || '').toUpperCase().replace(/^SPOS/, '').replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad character'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function verifyKey(key) {
  try {
    const raw = b32decode(key);
    if (raw.length < 70) return { ok: false, error: 'That license key is too short — check it was copied completely' };
    const n = raw.readUInt16BE(0), payload = raw.subarray(2, 2 + n), sig = raw.subarray(2 + n, 2 + n + 64);
    if (sig.length !== 64 || !crypto.verify(null, payload, LIC_PUB, sig)) return { ok: false, error: 'That license key is not valid' };
    return { ok: true, data: JSON.parse(payload.toString('utf8')) };
  } catch (e) { return { ok: false, error: 'That license key is not valid' }; }
}
let MACHINE_ID = '';
function machineId() {
  if (MACHINE_ID) return MACHINE_ID;
  let base = os.hostname();
  if (process.platform === 'win32') {
    try { const r = require('child_process').execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true, encoding: 'utf8' }); const m = r.match(/MachineGuid\s+REG_SZ\s+(\S+)/i); if (m) base = m[1]; } catch (e) { /* fall back to computer name */ }
  }
  const h = crypto.createHash('sha256').update('storepos:' + base).digest();
  let s2 = ''; for (let i = 0; i < 10; i++) s2 += B32[h[i] & 31];
  return (MACHINE_ID = s2.slice(0, 5) + '-' + s2.slice(5));
}
const TRIAL_DAYS = 14, GRACE_DAYS = 7, DAY = 86400000;
function licenseState() {
  const now = Date.now();
  const kvGet = k => { const r = Q.kv.get.get(k); return r ? JSON.parse(r.data) : null; };
  if (!kvGet('settings')) return { status: 'setup', locked: false, machine: machineId() };
  let trial = Math.min(Number(kvGet('trialStart')) || now, Number(cfg.trialStart) || now);
  if (!kvGet('trialStart')) Q.kv.put.run('trialStart', JSON.stringify(trial));
  if (!cfg.trialStart) { cfg.trialStart = trial; saveCfg(); }
  const key = kvGet('license');
  const base = { machine: machineId() };
  if (key) {
    const v = verifyKey(key);
    if (v.ok) {
      const d = v.data;
      if (d.m && d.m.toUpperCase() !== base.machine) return { ...base, status: 'wrongpc', locked: true, customer: d.c, id: d.id, error: `This license is for computer ${d.m}. This computer is ${base.machine}.` };
      if (d.e) {
        const end = new Date(d.e + 'T23:59:59').getTime();
        if (now > end + GRACE_DAYS * DAY) return { ...base, status: 'expired', locked: true, customer: d.c, id: d.id, expires: d.e };
        if (now > end) return { ...base, status: 'grace', locked: false, customer: d.c, id: d.id, expires: d.e, daysLeft: Math.ceil((end + GRACE_DAYS * DAY - now) / DAY) };
        return { ...base, status: 'licensed', locked: false, customer: d.c, id: d.id, expires: d.e, daysLeft: Math.ceil((end - now) / DAY) };
      }
      return { ...base, status: 'licensed', locked: false, customer: d.c, id: d.id, expires: '' };
    }
  }
  const left = Math.ceil((trial + TRIAL_DAYS * DAY - now) / DAY);
  return left > 0 ? { ...base, status: 'trial', locked: false, daysLeft: left } : { ...base, status: 'trialover', locked: true, daysLeft: 0 };
}
ipcMain.handle('licenseState', () => licenseState());
ipcMain.handle('setLicense', (e, key) => {
  const v = verifyKey(key);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.data.m && v.data.m.toUpperCase() !== machineId()) return { ok: false, error: `This license is locked to computer ${v.data.m}, but this computer is ${machineId()}.` };
  Q.kv.put.run('license', JSON.stringify(String(key).trim()));
  return { ok: true, state: licenseState() };
});
ipcMain.handle('loadLicenseFile', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick the license file', defaultPath: app.getPath('downloads'), filters: [{ name: 'Store POS license', extensions: ['poslicense', 'txt'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const text = fs.readFileSync(r.filePaths[0], 'utf8'); const m = text.match(/SPOS[-0-9A-Z\s]+/i);
  return m ? { ok: true, key: m[0].replace(/\s+/g, '') } : { ok: false, error: 'No license key found in that file' };
});

/* ---------- config / app ---------- */
ipcMain.handle('getConfig', () => ({ ...cfg, appVersion: require('./package.json').version, bundledVersion: BOOT.bundledVersion, runningUpdate: !!BOOT.updateDir, rolledBack: BOOT.rolledBack, hasPrevious: fs.existsSync(path.join(UPDATE_DIR, 'previous')) || !!BOOT.updateDir, dataDir: DATA_DIR, backupRoot: BACKUP_DIR, version: app.getVersion(), platform: process.platform }));
ipcMain.handle('setConfig', (e, patch) => {
  const allowed = ['printer', 'paper', 'drawerOnCash', 'drawerMode', 'kiosk', 'autoStart', 'reportPrinter', 'rcptConn', 'cmdSet', 'cols', 'cut', 'feed', 'drawerPin', 'netHost', 'netPort', 'comPort', 'comBaud', 'comFlow', 'scanCom', 'scanBaud', 'labelPrinter', 'updateUrl'];
  for (const k of Object.keys(patch || {})) if (allowed.includes(k)) cfg[k] = patch[k];
  saveCfg();
  if ('kiosk' in patch && win) { win.setKiosk(!!cfg.kiosk); if (!cfg.kiosk) win.setFullScreen(true); }
  if ('autoStart' in patch) applyAutoStart();
  if ('scanCom' in patch || 'scanBaud' in patch) startScanner();
  return cfg;
});
/* ---------- install / undo a small update file (.posupdate) ---------- */
const vm = require('vm');
ipcMain.handle('installUpdate', async () => {
  const guess = [cfg.lastUpdateDir, 'Y:\\Vape & Smoke Studio POS\\Updates', app.getPath('downloads')].find(d => { try { return d && fs.statSync(d).isDirectory(); } catch (e) { return false; } }) || app.getPath('downloads');
  const r = await dialog.showOpenDialog(win, { title: 'Pick a Store POS update file', defaultPath: guess, filters: [{ name: 'Store POS update', extensions: ['posupdate'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try { cfg.lastUpdateDir = path.dirname(r.filePaths[0]); saveCfg(); } catch (e) { /* ignore */ }
  return installUpdateFile(fs.readFileSync(r.filePaths[0]));
});
async function installUpdateFile(raw) {
  let u;
  try { u = JSON.parse(zlib.gunzipSync(raw).toString('utf8')); } catch (e) { return { ok: false, error: 'That is not a Store POS update file' }; }
  if (u.format !== 'storepos-update' || !u.version || !u.files) return { ok: false, error: 'That is not a Store POS update file' };
  const running = require('./package.json').version;
  if (!verGt(u.version, running) && !u.allowSame) return { ok: false, error: `This POS already runs version ${running} (the file is ${u.version})` };
  for (const need of ['main.js', 'preload.js', 'index.html', 'package.json']) if (!u.files[need]) return { ok: false, error: 'The update file is incomplete (' + need + ')' };
  const bufs = {};
  for (const [name, f] of Object.entries(u.files)) {
    if (name.includes('..') || path.isAbsolute(name)) return { ok: false, error: 'Bad file name in update' };
    const b = Buffer.from(f.b64, 'base64');
    if (crypto.createHash('sha256').update(b).digest('hex') !== f.sha256) return { ok: false, error: 'The update file is damaged (' + name + '). Download it again.' };
    bufs[name] = b;
  }
  try { new vm.Script('(function(){' + bufs['main.js'].toString('utf8') + '\n})', { filename: 'main.js' }); new vm.Script(bufs['preload.js'].toString('utf8'), { filename: 'preload.js' }); }
  catch (e) { return { ok: false, error: 'The update has an error and was not installed: ' + e.message }; }
  const next = path.join(UPDATE_DIR, 'next'), cur = path.join(UPDATE_DIR, 'current'), prev = path.join(UPDATE_DIR, 'previous');
  fs.rmSync(next, { recursive: true, force: true });
  for (const [name, b] of Object.entries(bufs)) { const t = path.join(next, name); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, b); }
  const ok = await dialog.showMessageBox(win, { type: 'question', buttons: ['Later', 'Restart now'], defaultId: 1, cancelId: 0, message: `Update to version ${u.version}?`, detail: (u.notes ? u.notes + '\n\n' : '') + 'Your items, sales and settings are kept. Store POS will restart.' });
  if (ok.response !== 1) { fs.rmSync(next, { recursive: true, force: true }); return { ok: false, canceled: true }; }
  try { await backupNow(); } catch (e) { /* best effort */ }
  fs.rmSync(prev, { recursive: true, force: true });
  if (fs.existsSync(cur)) fs.renameSync(cur, prev);
  fs.renameSync(next, cur);
  try { fs.unlinkSync(ATTEMPTS); } catch (e) { /* none */ }
  quitting = true; app.relaunch({ args: process.argv.slice(1).filter(a => !/\.posupdate$/i.test(a)) }); app.exit(0);
  return { ok: true };
}
// double-clicked .posupdate file (Windows passes it on the command line)
const updArg = argv => (argv || []).find(a => /\.posupdate$/i.test(a) && fs.existsSync(a));
async function openUpdateArg(argv) {
  const f = updArg(argv); if (!f || !win) return;
  const r = await installUpdateFile(fs.readFileSync(f));
  if (r && r.error) dialog.showMessageBox(win, { type: 'error', message: 'Update not installed', detail: r.error });
}
/* optional online updates: Settings → Software update → update address (a latest.json manifest) */
let onlineUpdate = null;
const BUILTIN_UPDATE_URL = 'https://raw.githubusercontent.com/atrivedi85/storepos-updates/main/latest.json';
async function checkOnline(manual) {
  // the built-in address is always tried; a custom address (if someone set one) is tried too
  const urls = [...new Set([BUILTIN_UPDATE_URL, String(cfg.updateUrl || '').trim()].filter(u => /^https:\/\//i.test(u)))];
  const { net } = require('electron');
  let best = null, lastErr = '';
  for (const u of urls) {
    try {
      const res = await net.fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const m = await res.json();
      if (!m.version || !m.url) throw new Error('not a Store POS update list');
      m.base = u;
      if (!best || verGt(m.version, best.version)) best = m;
    } catch (e) { lastErr = e.message; }
  }
  if (!best) return { ok: false, error: 'Could not reach the update server (' + lastErr + '). Check the internet connection.' };
  onlineUpdate = verGt(best.version, require('./package.json').version) ? best : null;
  if (onlineUpdate) send('updateAvailable', onlineUpdate);
  return { ok: true, available: onlineUpdate };
}
ipcMain.handle('checkUpdate', () => checkOnline(true));
ipcMain.handle('downloadUpdate', async () => {
  if (!onlineUpdate) return { ok: false, error: 'No update available' };
  try {
    const { net } = require('electron');
    const res = await net.fetch(new URL(onlineUpdate.url, onlineUpdate.base || BUILTIN_UPDATE_URL).toString() + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = Buffer.from(await res.arrayBuffer());
    if (onlineUpdate.sha256 && crypto.createHash('sha256').update(raw).digest('hex') !== onlineUpdate.sha256) throw new Error('Download was damaged — try again');
    return installUpdateFile(raw);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('undoUpdate', async () => {
  const cur = path.join(UPDATE_DIR, 'current'), prev = path.join(UPDATE_DIR, 'previous');
  const ok = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Go back and restart'], defaultId: 0, cancelId: 0, message: 'Go back to the previous version?', detail: 'Your items, sales and settings are kept.' });
  if (ok.response !== 1) return { ok: false, canceled: true };
  const old = path.join(UPDATE_DIR, 'removed');
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(cur)) fs.renameSync(cur, old);
  if (fs.existsSync(prev)) fs.renameSync(prev, cur);
  try { fs.unlinkSync(ATTEMPTS); } catch (e) { /* none */ }
  quitting = true; app.relaunch(); app.exit(0);
  return { ok: true };
});
ipcMain.handle('exitApp', () => { quitting = true; app.quit(); });
ipcMain.handle('printers', async () => {
  try { return (await win.webContents.getPrintersAsync()).map(p => ({ name: p.name, isDefault: !!p.isDefault })); } catch (e) { return []; }
});
function applyAutoStart() {
  if (process.platform !== 'win32') return;
  try { app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart, path: process.execPath }); } catch (e) { /* ignore */ }
}

/* ---------- printing ---------- */
async function defaultPrinter() {
  if (cfg.printer) return cfg.printer;
  try { const p = (await win.webContents.getPrintersAsync()).find(x => x.isDefault); return p ? p.name : ''; } catch (e) { return ''; }
}
ipcMain.handle('print', async (e, { html, css }) => {
  const printer = await defaultPrinter();
  if (process.platform === 'win32' && !printer) return { ok: false, error: 'No printer is set up in Windows' };
  const widthMm = Number(cfg.paper) === 58 ? 58 : 80;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}${css}</style></head><body>${html}</body></html>`;
  const pw = new BrowserWindow({ show: false, width: Math.round(widthMm * 3.78), height: 600, webPreferences: { sandbox: true, javascript: true } });
  try {
    await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(doc));
    const hPx = await pw.webContents.executeJavaScript('document.body.scrollHeight');
    const heightMicrons = Math.max(50000, Math.ceil((hPx / 96) * 25400) + 8000);
    const result = await new Promise(res => pw.webContents.print({
      silent: true, printBackground: false, deviceName: printer,
      margins: { marginType: 'none' },
      pageSize: { width: widthMm * 1000, height: heightMicrons }
    }, (ok, err) => res({ ok, error: ok ? '' : String(err || 'Print failed') })));
    return { ...result, printer };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    setTimeout(() => { if (!pw.isDestroyed()) pw.destroy(); }, 1500);
  }
});

/* ---------- full-page documents (reports) on any printer, or saved as PDF ---------- */
async function loadDoc(html, css) {
  const file = path.join(os.tmpdir(), `storepos-doc-${Date.now()}.html`);
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`);
  const w = new BrowserWindow({ show: false, width: 900, height: 1100, webPreferences: { sandbox: true } });
  await w.loadFile(file);
  return { w, done: () => { setTimeout(() => { if (!w.isDestroyed()) w.destroy(); try { fs.unlinkSync(file); } catch (e) { /* gone */ } }, 1500); } };
}
ipcMain.handle('printDoc', async (e, { html, css, printer, landscape, copies, pageSize }) => {
  let d;
  try {
    d = await loadDoc(html, css);
    const opts = { silent: true, printBackground: true, landscape: !!landscape, copies: Math.max(1, Math.min(500, Number(copies) || 1)), pageSize: pageSize || 'Letter', margins: { marginType: pageSize ? 'none' : 'default' } };
    if (printer) opts.deviceName = printer;
    return await new Promise(res => d.w.webContents.print(opts, (ok, err) => res({ ok, error: ok ? '' : String(err || 'Print failed'), printer })));
  } catch (err) { return { ok: false, error: err.message }; }
  finally { if (d) d.done(); }
});
ipcMain.handle('savePdf', async (e, { html, css, name, landscape }) => {
  let d;
  try {
    d = await loadDoc(html, css);
    const pdf = await d.w.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, landscape: !!landscape, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    const r = await dialog.showSaveDialog(win, { title: 'Save report as PDF', defaultPath: path.join(app.getPath('downloads'), (name || 'report') + '.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, pdf);
    if (!cfg.kiosk) shell.openPath(r.filePath); // in lock mode the viewer would open hidden behind the POS
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
  finally { if (d) d.done(); }
});

/* ---------- raw receipt printing: ESC/POS (Epson & compatible) or Star, over Windows spooler, network or COM port ---------- */
const net = require('net');
const RAW_PS = `
$ErrorActionPreference='Stop'
$bytes = [IO.File]::ReadAllBytes($env:POS_FILE)
if ($env:POS_MODE -eq 'com') {
  $p = New-Object System.IO.Ports.SerialPort($env:POS_COM, [int]$env:POS_BAUD, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  if ($env:POS_FLOW -eq 'rtscts') { $p.Handshake = [System.IO.Ports.Handshake]::RequestToSend }
  elseif ($env:POS_FLOW -eq 'xonxoff') { $p.Handshake = [System.IO.Ports.Handshake]::XOnXOff }
  else { $p.Handshake = [System.IO.Ports.Handshake]::None }
  $p.DtrEnable = $true; $p.WriteTimeout = 8000
  $p.Open(); $p.Write($bytes, 0, $bytes.Length); Start-Sleep -Milliseconds 300; $p.Close(); exit 0
}
$src = @"
using System; using System.Runtime.InteropServices;
public class PosRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static bool Send(string p, byte[] b) {
    IntPtr h; if (!OpenPrinter(p, out h, IntPtr.Zero)) return false;
    var di = new DOCINFO(); di.pDocName = "Store POS"; di.pDataType = "RAW"; bool ok = false;
    if (StartDocPrinter(h, 1, di) != 0) { if (StartPagePrinter(h)) { int w; ok = WritePrinter(h, b, b.Length, out w); EndPagePrinter(h); } EndDocPrinter(h); }
    ClosePrinter(h); return ok;
  }
}
"@
Add-Type -TypeDefinition $src
if ([PosRaw]::Send($env:POS_PRINTER, $bytes)) { exit 0 } else { exit 1 }
`;
const RAW_PS_B64 = Buffer.from(RAW_PS, 'utf16le').toString('base64');
function runPs(env, timeoutMs = 20000) {
  return new Promise(res => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', RAW_PS_B64], { windowsHide: true, env: { ...process.env, ...env } });
    let err = '', done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { ps.kill(); } catch (e) { /* gone */ } res({ ok: false, error: 'Printer did not respond (timed out)' }); } }, timeoutMs);
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', e => { if (!done) { done = true; clearTimeout(t); res({ ok: false, error: e.message }); } });
    ps.on('close', code => { if (done) return; done = true; clearTimeout(t); res(code === 0 ? { ok: true } : { ok: false, error: (err.trim().split('\n').filter(Boolean).pop() || 'Printer refused the data').replace(/^.*?:\s*/, '') }); });
  });
}
/* reading invoice photos with the OCR built into Windows 10/11 (no internet needed) */
const OCR_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:POS_OCR_FILE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($eng -eq $null) { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }
if ($eng -eq $null) { throw 'Windows text recognition (OCR) is not installed for your language' }
$res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
$out = New-Object System.Collections.ArrayList
foreach ($ln in $res.Lines) { foreach ($w in $ln.Words) { $r = $w.BoundingRect; $null = $out.Add([pscustomobject]@{ t = $w.Text; x = [math]::Round($r.X); y = [math]::Round($r.Y); w = [math]::Round($r.Width); h = [math]::Round($r.Height) }) } }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -InputObject @($out) -Compress
`;
ipcMain.handle('ocrImage', async (e, bytes) => {
  if (process.platform !== 'win32') return { ok: false, error: 'Reading photos needs Windows 10 or 11' };
  const f = path.join(app.getPath('temp'), 'storepos-ocr-' + Date.now() + '.png');
  fs.writeFileSync(f, Buffer.from(bytes));
  try {
    return await new Promise(res => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(OCR_PS, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, POS_OCR_FILE: f } });
      let out = '', err = '', done = false;
      const t = setTimeout(() => { if (!done) { done = true; try { ps.kill(); } catch (x) { /* gone */ } res({ ok: false, error: 'Reading the photo took too long' }); } }, 90000);
      ps.stdout.on('data', d => { out += d; }); ps.stderr.on('data', d => { err += d; });
      ps.on('error', x => { if (!done) { done = true; clearTimeout(t); res({ ok: false, error: x.message }); } });
      ps.on('close', code => { if (done) return; done = true; clearTimeout(t);
        try { const words = JSON.parse(out.trim() || '[]'); res({ ok: true, words: Array.isArray(words) ? words : [words] }); }
        catch (x) { res({ ok: false, error: (err.trim().split('\n').filter(Boolean).pop() || 'Could not read the photo').replace(/^.*?:\s*/, '') }); } });
    });
  } finally { try { fs.unlinkSync(f); } catch (x) { /* ignore */ } }
});
function sendTcp(host, port, buf) {
  return new Promise(res => {
    let done = false; const fin = r => { if (!done) { done = true; res(r); } };
    const sock = net.createConnection({ host, port: Number(port) || 9100 }, () => sock.end(buf));
    sock.setTimeout(8000, () => { sock.destroy(); fin({ ok: false, error: `No answer from ${host}:${port || 9100}` }); });
    sock.on('error', e => fin({ ok: false, error: `${host}:${port || 9100} — ${e.code || e.message}` }));
    sock.on('close', hadErr => { if (!hadErr) fin({ ok: true }); });
  });
}
async function sendRaw(bytes) {
  const buf = Buffer.from(bytes);
  const conn = cfg.rcptConn || 'driver';
  if (conn === 'network') {
    if (!cfg.netHost) return { ok: false, error: 'Enter the printer IP address in Settings' };
    const r = await sendTcp(cfg.netHost, cfg.netPort || 9100, buf);
    return { ...r, printer: `${cfg.netHost}:${cfg.netPort || 9100}` };
  }
  if (process.platform !== 'win32') return { ok: false, error: 'This printer connection only works on Windows' };
  const file = path.join(os.tmpdir(), `storepos-raw-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(file, buf);
  try {
    if (conn === 'serial') {
      if (!cfg.comPort) return { ok: false, error: 'Pick the printer COM port in Settings' };
      const r = await runPs({ POS_MODE: 'com', POS_FILE: file, POS_COM: cfg.comPort, POS_BAUD: String(cfg.comBaud || 9600), POS_FLOW: cfg.comFlow || 'none' });
      return { ...r, printer: cfg.comPort };
    }
    const printer = await defaultPrinter();
    if (!printer) return { ok: false, error: 'No receipt printer set' };
    const r = await runPs({ POS_MODE: 'win', POS_FILE: file, POS_PRINTER: printer });
    return { ...r, printer };
  } finally { setTimeout(() => { try { fs.unlinkSync(file); } catch (e) { /* gone */ } }, 2000); }
}
ipcMain.handle('rawPrint', (e, bytes) => sendRaw(bytes));
function drawerBytes() {
  if (cfg.cmdSet === 'star') return [7];                       // Star line mode: BEL opens drawer 1
  return [27, 112, Number(cfg.drawerPin) === 5 ? 1 : 0, 25, 250]; // ESC p m t1 t2 (Epson & compatibles)
}
ipcMain.handle('openDrawer', () => sendRaw(drawerBytes()));
ipcMain.handle('comPorts', () => new Promise(res => {
  if (process.platform !== 'win32') return res([]);
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique'], { windowsHide: true });
  let out = ''; ps.stdout.on('data', d => { out += d; });
  ps.on('error', () => res([])); ps.on('close', () => res(out.split(/\r?\n/).map(x => x.trim()).filter(Boolean)));
}));

/* ---------- COM / serial barcode scanners (USB scanners set to "USB COM" / "virtual serial" mode) ---------- */
const SCAN_PS = `
$p = New-Object System.IO.Ports.SerialPort($env:SC_COM, [int]$env:SC_BAUD, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$p.DtrEnable = $true; $p.RtsEnable = $true; $p.ReadTimeout = 500
$p.Open()
[Console]::Out.WriteLine('#READY')
while ($true) { $s = $p.ReadExisting(); if ($s) { [Console]::Out.Write($s); [Console]::Out.Flush() }; Start-Sleep -Milliseconds 15 }
`;
let scanProc = null, scanState = { port: '', status: 'off', error: '' }, scanRestart = null;
function stopScanner() { clearTimeout(scanRestart); if (scanProc) { const p = scanProc; scanProc = null; try { p.kill(); } catch (e) { /* gone */ } } }
function startScanner() {
  stopScanner();
  scanState = { port: cfg.scanCom || '', status: 'off', error: '' };
  if (!cfg.scanCom || process.platform !== 'win32') { send('scannerState', scanState); return; }
  scanState.status = 'connecting'; send('scannerState', scanState);
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCAN_PS, 'utf16le').toString('base64')],
    { windowsHide: true, env: { ...process.env, SC_COM: cfg.scanCom, SC_BAUD: String(cfg.scanBaud || 9600) } });
  scanProc = ps;
  let buf = '', idle = null, err = '';
  const flush = () => { const code = buf.replace(/[\x00-\x1f\x7f]/g, '').trim(); buf = ''; if (code) send('scan', code); };
  ps.stdout.setEncoding('latin1');
  ps.stdout.on('data', d => {
    if (d.includes('#READY')) { scanState.status = 'connected'; send('scannerState', scanState); d = d.replace(/#READY\r?\n?/, ''); }
    buf += d;
    let m; while ((m = buf.match(/[\r\n\t]/))) { const part = buf.slice(0, m.index); buf = buf.slice(m.index + 1); const code = part.replace(/[\x00-\x1f\x7f]/g, '').trim(); if (code) send('scan', code); }
    clearTimeout(idle); if (buf) idle = setTimeout(flush, 150); // scanners with no end character
  });
  ps.stderr.on('data', d => { err += d; });
  ps.on('close', () => {
    if (scanProc !== ps) return;
    scanProc = null;
    scanState = { port: cfg.scanCom, status: 'error', error: (err.trim().split('\n').filter(Boolean).pop() || 'Scanner disconnected').replace(/^.*?:\s*/, '') };
    send('scannerState', scanState);
    scanRestart = setTimeout(startScanner, 5000); // keep trying (scanner unplugged / replugged)
  });
}
ipcMain.handle('scannerState', () => scanState);
ipcMain.handle('restartScanner', () => { startScanner(); return scanState; });

/* ---------- window ---------- */
let win = null, quitting = false;
function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 768, backgroundColor: '#0f1b2d', title: 'Store POS', icon: ASSET('icon.png'),
    fullscreen: true, kiosk: !!cfg.kiosk, autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => { if (cfg.kiosk && !win.isKiosk()) win.setKiosk(true); }); // back from printer setup / file browser
  win.loadFile(path.join(__dirname, 'index.html'));
  // Keep cashiers inside the POS: block closing (Alt+F4) while in lock mode; Exit is in Settings (admin only).
  win.on('close', e => { if (cfg.kiosk && !quitting) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    const k = (input.key || '').toLowerCase();
    if (input.control && ['+', '-', '=', '0'].includes(k)) e.preventDefault();
    if (input.control && input.shift && k === 'i') e.preventDefault();
  });
  win.webContents.on('render-process-gone', () => { if (!quitting) setTimeout(() => win && !win.isDestroyed() && win.reload(), 1000); });
  win.webContents.once('did-finish-load', () => { setTimeout(maybeImportHistory, 4000); startScanner(); setTimeout(() => openUpdateArg(process.argv), 2500); setTimeout(() => checkOnline(false), 60000); setInterval(() => checkOnline(false), 6 * 3600 * 1000); if (BOOT.updateDir) { try { let at = {}; try { at = JSON.parse(fs.readFileSync(ATTEMPTS, 'utf8')); } catch (e) { /* none */ } if (at.version) at = {}; at[require('./package.json').version] = 0; fs.writeFileSync(ATTEMPTS, JSON.stringify(at)); } catch (e) { /* ignore */ } } });
}

app.on('second-instance', (e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); openUpdateArg(argv); } });
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  applyAutoStart();
  powerSaveBlocker.start('prevent-display-sleep');
  createWindow();
  setTimeout(maybeBackup, 120000);
  setInterval(maybeBackup, 3600 * 1000);
});
app.on('before-quit', () => { quitting = true; stopScanner(); });
app.on('window-all-closed', () => { try { db.close(); } catch (e) { /* ignore */ } app.quit(); });
