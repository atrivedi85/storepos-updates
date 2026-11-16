// Hotel Desk (trivedipos.com/hotel): the hotel front-desk system's rules and storage.
// This file has no Cloudflare-specific code, so it can be tested on a plain computer (see hotel/README.md).
// `sql` is the Durable Object's SQLite: sql.exec(query, ...params).toArray().
// Card numbers are never stored: only the card type and the last 4 digits.
import * as nc from 'node:crypto';
import { Buffer } from 'node:buffer';

const SESSION_DAYS = 14;
const now = () => Date.now();
const sha = s => nc.createHash('sha256').update(s).digest('hex');
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const nightsBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const cents = v => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw err(400, 'That amount is not a number.'); return n; };
function err(code, msg) { const e = new Error(msg); e.code = code; return e; }
const ROLES = ['manager', 'desk', 'hk'];
const PAY_TYPES = ['CASH', 'CRED', 'AREC', 'GFTCRD'];
const ACTIVE = ['reserved', 'inhouse'];

/* The starter setup: rooms, room types, taxes and posting codes. Everything can be changed in Setup. */
function starterConfig() {
  const types = [['NK', 'King', 8000], ['NK1', 'King (1st floor)', 8000], ['NQ', 'Queen', 8000], ['NQQ', 'Two Queens', 8500], ['HNK', 'Accessible King', 8000], ['HNQ', 'Accessible Queen', 8000],
    ['SNK', 'King Suite', 10500], ['SNK1', 'King Suite (1st floor)', 10500], ['SNQQ', 'Two Queens Suite', 10500]].map(([code, name, rate]) => ({ code, name, rate }));
  const R = 'SNK1 101,NK 102,NQQ 103,SNQQ 104,NQQ 105,SNQQ 106,NK 107,HNK 109,NQQ 111,NK 128,NK1 129,HNK 130,NK 131,NQQ 132,NQQ 133,NK 134,HNQ 135,SNK 136,NQQ 137,SNK 138,SNK1 139,NK 140,' +
    'SNK1 201,NK 202,NK 203,SNK 204,NK 205,SNQQ 206,NQQ 207,NQQ 208,NQQ 209,NQ 210,NK 211,NQQ 212,NK 213,NK 214,NK 218,NQQ 219,NQQ 220,NQQ 221,NQQ 222,NK 223,NQQ 224,NK1 225,NQQ 226,NQQ 227,NK 228,NQQ 229,NK 230,NK 231,SNK 232,NK 233,SNK 234,SNK1 235,NK 236';
  const rooms = R.split(',').map(x => { const [type, no] = x.split(' '); return { no, type, floor: no[0] }; });
  const taxes = [{ code: 'T1', name: 'State Tax', pct: 6.24 }, { code: 'T2', name: 'City / County Tax', pct: 3 }, { code: 'T3', name: 'Occupancy Tax', pct: 1 }];
  const all = ['T1', 'T2', 'T3'];
  const C = (code, name, type, tax) => ({ code, name, type, tax: tax || [] });
  const codes = [C('RM', 'Room Charge', 'ROOM', all), C('NS', 'No Show Charge', 'ROOM', all), C('CXL', 'Cancellation / Early Check-out', 'ROOM', all), C('RL', 'Rollaway Charge', 'ROOM', all),
    C('PET', 'Pet Charge', 'MISC', all), C('DAMG', 'Damages / Missing items', 'MISC'), C('MS', 'Miscellaneous', 'MISC', ['T1']), C('MR', 'Meeting Room', 'MISC', ['T1']), C('LV', 'Valet / Laundry', 'MISC', ['T1']),
    C('LD', 'Phone Charge', 'MISC', ['T1']), C('FX', 'Fax Charge', 'MISC', ['T1']),
    C('CA', 'Cash', 'CASH'), C('CK', 'Check', 'CASH'), C('VI', 'Visa', 'CRED'), C('MC', 'Master Card', 'CRED'), C('AX', 'American Express', 'CRED'), C('DS', 'Discover', 'CRED'),
    C('DB', 'Direct Bill', 'AREC'), C('GC', 'Gift Card', 'GFTCRD'), C('GR', 'Guest Refund', 'CASH'), C('PO', 'Cash Paid Out', 'CASH'), C('WO', 'Write-off', 'ADMIN'), C('ADM', 'Admin.', 'ADMIN')];
  return { name: 'My Hotel', address: '', phone: '', bdate: '', types, rooms, taxes, codes, housekeepers: [], nextConf: 10001, checkoutTime: '11:00', checkinTime: '15:00', regText: 'I agree to pay all charges for this stay. The hotel is not responsible for valuables left in the room.' };
}

export class HotelCore {
  // opts.scrypt(password, saltHex) → hex: the website passes Ledger Desk's password hasher (same settings), tests use node's.
  constructor(sql, opts) {
    this.sql = sql; this.fails = {}; this.scrypt = opts && opts.scrypt;
    for (const q of ['CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)',
      'CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY, user TEXT NOT NULL, exp INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS res(id INTEGER PRIMARY KEY, status TEXT, arrive TEXT, depart TEXT, room TEXT, name TEXT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS lines(id INTEGER PRIMARY KEY AUTOINCREMENT, res INTEGER NOT NULL, bdate TEXT, at INTEGER, code TEXT, descr TEXT, comment TEXT, amount INTEGER NOT NULL, user TEXT)',
      'CREATE INDEX IF NOT EXISTS lines_res ON lines(res)', 'CREATE INDEX IF NOT EXISTS lines_bdate ON lines(bdate)',
      'CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, start TEXT, end TEXT, reason TEXT)',
      'CREATE TABLE IF NOT EXISTS audits(bdate TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, user TEXT, line TEXT)']) this.sql.exec(q);
  }
  rows(q, ...p) { return this.sql.exec(q, ...p).toArray(); }
  one(q, ...p) { const r = this.rows(q, ...p); return r.length ? r[0] : null; }
  kv(k, d) { const r = this.one('SELECT v FROM kv WHERE k=?', k); return r ? JSON.parse(r.v) : d; }
  setKv(k, v) { this.sql.exec('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)', k, JSON.stringify(v)); }
  cfg() { return this.kv('config', null) || starterConfig(); }
  log(user, line) { this.sql.exec('INSERT INTO log(at,user,line) VALUES(?,?,?)', now(), user || '', String(line).slice(0, 300)); this.sql.exec('DELETE FROM log WHERE id < (SELECT MAX(id) - 20000 FROM log)'); }

  /* ---------- logins ---------- */
  hashPw(pw, salt) { if (this.scrypt) return this.scrypt(String(pw), salt); return nc.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex'); }
  findUser(u) { const r = this.one('SELECT data FROM users WHERE username=?', String(u || '').trim().toLowerCase()); return r ? JSON.parse(r.data) : null; }
  saveUser(u) { this.sql.exec('INSERT OR REPLACE INTO users(username,data) VALUES(?,?)', u.username, JSON.stringify(u)); }
  setPw(u, pw) { if (String(pw || '').length < 8) throw err(400, 'The password needs at least 8 characters.'); u.salt = nc.randomBytes(16).toString('hex'); u.hash = this.hashPw(pw, u.salt); }
  pub(u) { return { username: u.username, name: u.name || u.username, role: u.role, disabled: !!u.disabled }; }
  sessionUser(cookie) {
    const m = /(?:^|;\s*)ht_s=([a-f0-9]{64})/.exec(cookie || ''); if (!m) return null;
    const k = sha(m[1]), s = this.one('SELECT user, exp FROM sessions WHERE h=?', k);
    if (!s || s.exp < now()) { if (s) this.sql.exec('DELETE FROM sessions WHERE h=?', k); return null; }
    const u = this.findUser(s.user); if (!u || u.disabled) return null;
    return { user: u, key: k };
  }
  cookie(token, age) { return 'ht_s=' + token + '; Path=/hotel; HttpOnly; Secure; SameSite=Strict; Max-Age=' + age; }
  login(b) {
    const name = String(b.username || '').trim().toLowerCase(), f = this.fails[name] || (this.fails[name] = { n: 0, until: 0 });
    if (f.until > now()) throw err(429, 'Too many wrong tries. Wait 10 minutes and try again.');
    const u = this.findUser(name);
    const ok = u && !u.disabled && nc.timingSafeEqual(Buffer.from(this.hashPw(b.password || '', u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!u) this.hashPw(b.password || '', '00'.repeat(16));
    if (!ok) { f.n++; if (f.n >= 8) { f.n = 0; f.until = now() + 6e5; } throw err(401, 'The user name or password is wrong.'); }
    delete this.fails[name];
    const token = nc.randomBytes(32).toString('hex');
    this.sql.exec('INSERT INTO sessions(h,user,exp) VALUES(?,?,?)', sha(token), u.username, now() + SESSION_DAYS * 864e5);
    this.sql.exec('DELETE FROM sessions WHERE exp<?', now());
    this.log(u.username, 'signed in');
    return { status: 200, json: { ok: true, me: this.pub(u) }, cookie: this.cookie(token, SESSION_DAYS * 86400) };
  }

  /* ---------- reservations ---------- */
  getRes(id) { const r = this.one('SELECT data FROM res WHERE id=?', Number(id) || 0); if (!r) throw err(404, 'That reservation was not found.'); return JSON.parse(r.data); }
  putRes(r) { this.sql.exec('INSERT OR REPLACE INTO res(id,status,arrive,depart,room,name,data) VALUES(?,?,?,?,?,?,?)', r.id, r.status, r.arrive, r.depart, r.room || '', (r.last + ', ' + r.first).toUpperCase(), JSON.stringify(r)); }
  activeRes() { return this.rows("SELECT data FROM res WHERE status IN ('reserved','inhouse')").map(x => JSON.parse(x.data)); }
  blocks() { return this.rows('SELECT * FROM blocks'); }
  // Rooms of a type left to sell for every night of a stay (the lowest night counts).
  availOfType(c, type, from, to, exceptId, act, blks) {
    act = act || this.activeRes(); blks = blks || this.blocks();
    const roomsOfType = c.rooms.filter(r => r.type === type).map(r => r.no); let min = roomsOfType.length;
    for (let d = from; d < to; d = addDays(d, 1)) {
      const sold = act.filter(r => r.id !== exceptId && r.type === type && r.arrive <= d && d < r.depart).length;
      const ooo = roomsOfType.filter(no => blks.some(b => b.room === no && b.start <= d && d <= b.end)).length;
      min = Math.min(min, roomsOfType.length - sold - ooo);
    }
    return min;
  }
  roomProblem(c, room, from, to, exceptId) {
    if (!c.rooms.some(r => r.no === room)) return 'Room ' + room + ' does not exist.';
    const clash = this.activeRes().find(r => r.id !== exceptId && r.room === room && r.arrive < to && from < r.depart);
    if (clash) return 'Room ' + room + ' is taken by ' + clash.last + ', ' + clash.first + ' (' + clash.arrive + ' to ' + clash.depart + ').';
    const b = this.blocks().find(b => b.room === room && b.start < to && from <= b.end);
    if (b) return 'Room ' + room + ' is out of order ' + b.start + ' to ' + b.end + (b.reason ? ' (' + b.reason + ')' : '') + '.';
    return '';
  }
  balance(id) { return this.one('SELECT COALESCE(SUM(amount),0) n FROM lines WHERE res=?', id).n; }
  resSave(a, me, c) {
    const isNew = !a.id; const r = isNew ? { id: 0, status: 'reserved', created: now(), createdBy: me.username, history: [] } : this.getRes(a.id);
    if (!isNew && !ACTIVE.includes(r.status)) throw err(400, 'This reservation is ' + r.status + ' and cannot be changed. Reinstate it first.');
    const before = JSON.stringify([r.arrive, r.depart, r.type, r.room, r.rate]);
    for (const [k, n] of [['first', 60], ['last', 60], ['addr1', 100], ['addr2', 100], ['city', 60], ['state', 30], ['zip', 15], ['country', 40], ['phone', 30], ['email', 100], ['guestId', 40], ['vehicle', 40],
      ['company', 80], ['notes', 1000], ['requests', 300], ['market', 30], ['source', 30], ['guarantee', 20], ['payType', 10], ['cardType', 10]]) if (k in a) r[k] = clip(a[k], n);
    if ('cardLast4' in a) r.cardLast4 = String(a.cardLast4 || '').replace(/\D/g, '').slice(-4);
    for (const k of ['vip', 'taxExempt', 'noPost']) if (k in a) r[k] = !!a[k];
    if (!r.last) throw err(400, 'Type the guest\'s last name.');
    if ('arrive' in a) r.arrive = a.arrive; if ('depart' in a) r.depart = a.depart;
    if (!isDate(r.arrive) || !isDate(r.depart) || r.depart <= r.arrive) throw err(400, 'Check the arrival and departure dates.');
    if (nightsBetween(r.arrive, r.depart) > 365) throw err(400, 'A stay can be at most 365 nights.');
    if (isNew && r.arrive < c.bdate) throw err(400, 'The arrival date is before today\'s business date (' + c.bdate + ').');
    if (r.status === 'inhouse' && 'arrive' in a && JSON.parse(before)[0] !== r.arrive) throw err(400, 'The guest is already checked in, so the arrival date cannot change.');
    if ('type' in a) r.type = a.type; const t = c.types.find(t => t.code === r.type); if (!t) throw err(400, 'Pick a room type.');
    if ('adults' in a) r.adults = Math.max(1, Math.min(20, Number(a.adults) || 1)); if ('children' in a) r.children = Math.max(0, Math.min(20, Number(a.children) || 0));
    r.adults = r.adults || 1; r.children = r.children || 0;
    if ('rate' in a && a.rate !== '' && a.rate != null) r.rate = cents(a.rate); if (r.rate == null) r.rate = t.rate; if (r.rate < 0) throw err(400, 'The rate cannot be negative.');
    if ('room' in a) r.room = clip(a.room, 10);
    if (r.room) {
      const rm = c.rooms.find(x => x.no === r.room); if (!rm) throw err(400, 'Room ' + r.room + ' does not exist.');
      const from = r.status === 'inhouse' ? (c.bdate > r.arrive ? c.bdate : r.arrive) : r.arrive;
      const p = from < r.depart ? this.roomProblem(c, r.room, from, r.depart, r.id) : ''; if (p) throw err(409, p);
      if (rm.type !== r.type) r.type = rm.type;   // the room decides the type
    } else if (!a.oversell && this.availOfType(c, r.type, r.arrive > c.bdate ? r.arrive : c.bdate, r.depart, r.id) < 1) throw err(409, 'No ' + r.type + ' rooms are left for those dates. Pick another room type or dates.');
    if (r.status === 'inhouse' && !r.room) throw err(400, 'A checked-in guest needs a room.');
    if (isNew) { r.id = (this.one('SELECT COALESCE(MAX(id),0) n FROM res').n) + 1; r.conf = String(c.nextConf++); this.setKv('config', c); }
    const after = JSON.stringify([r.arrive, r.depart, r.type, r.room, r.rate]);
    if (isNew) r.history.push({ at: now(), by: me.username, what: 'Created' }); else if (before !== after) r.history.push({ at: now(), by: me.username, what: 'Changed stay: ' + before + ' → ' + after });
    r.history = r.history.slice(-60);
    this.putRes(r); this.log(me.username, (isNew ? 'new reservation ' : 'changed reservation ') + r.conf);
    return r;
  }
  roomState() { return this.kv('roomstate', {}); }
  setCond(rooms, patch) { const s = this.roomState(); for (const no of rooms) s[no] = { cond: 'R', ...(s[no] || {}), ...patch }; this.setKv('roomstate', s); }
  checkIn(r, me, c, a) {
    if (r.status !== 'reserved') throw err(400, 'This reservation is ' + r.status + '.');
    if (r.arrive > c.bdate) throw err(400, 'This guest arrives ' + r.arrive + '. Today\'s business date is ' + c.bdate + '. Change the arrival date first.');
    if (r.depart <= c.bdate) throw err(400, 'The departure date has passed. Change the stay first.');
    if (!r.room) throw err(400, 'Pick a room first.');
    const other = this.activeRes().find(x => x.status === 'inhouse' && x.room === r.room && x.id !== r.id);
    if (other) throw err(409, 'Room ' + r.room + ' still has ' + other.last + ', ' + other.first + ' checked in.');
    const p = this.roomProblem(c, r.room, c.bdate, r.depart, r.id); if (p) throw err(409, p);
    const cond = (this.roomState()[r.room] || {}).cond || 'R';
    if (cond === 'D' && !a.dirtyOk) throw err(412, 'Room ' + r.room + ' is dirty. Check in anyway?');
    r.status = 'inhouse'; r.ciAt = now(); r.ciBy = me.username; r.history.push({ at: now(), by: me.username, what: 'Checked in to ' + r.room });
    this.putRes(r); this.log(me.username, 'check in ' + r.conf + ' room ' + r.room); return r;
  }

  /* ---------- folio ---------- */
  addLine(resId, c, code, amount, comment, user, descr) {
    const k = c.codes.find(x => x.code === code) || c.taxes.find(x => x.code === code);
    this.sql.exec('INSERT INTO lines(res,bdate,at,code,descr,comment,amount,user) VALUES(?,?,?,?,?,?,?,?)', resId, c.bdate, now(), code, descr || (k ? k.name : code), clip(comment, 200), amount, user);
  }
  postCharge(r, c, code, amount, comment, user) {   // a charge (or a negative adjustment) plus its taxes
    const k = c.codes.find(x => x.code === code); if (!k) throw err(400, 'Pick what to post.');
    this.addLine(r.id, c, code, amount, comment, user);
    if (!r.taxExempt) for (const tc of k.tax || []) { const t = c.taxes.find(x => x.code === tc); const amt = t ? Math.round(amount * t.pct / 100) : 0; if (amt) this.addLine(r.id, c, t.code, amt, '', user); }
  }
  post(a, me, c) {
    const r = this.getRes(a.res); const k = c.codes.find(x => x.code === a.code); if (!k) throw err(400, 'Pick what to post.');
    const amt = cents(a.amount); if (!(amt > 0)) throw err(400, 'Type an amount above zero.'); if (amt > 5000000) throw err(400, 'That amount is too large.');
    const pay = PAY_TYPES.includes(k.type) || k.type === 'ADMIN';
    if (r.status === 'cancelled' || r.status === 'noshow') { if (!pay && !['NS', 'CXL'].includes(k.code)) throw err(400, 'Only a no-show or cancellation charge, or a payment, can be posted here.'); }
    if (a.kind === 'payment') { if (!pay) throw err(400, 'That is not a payment type.'); const refund = !!a.refund || k.code === 'GR' || k.code === 'PO'; this.addLine(r.id, c, k.code, refund ? amt : -amt, (a.last4 ? '…' + String(a.last4).replace(/\D/g, '').slice(-4) + ' ' : '') + clip(a.comment, 150), me.username, refund && k.code !== 'GR' && k.code !== 'PO' ? k.name + ' refund' : ''); }
    else if (a.kind === 'adjust') { if (pay) throw err(400, 'Pick the charge to adjust.'); if (me.role !== 'manager' && amt > 20000) throw err(403, 'An adjustment above $200 needs a manager.'); if (!clip(a.comment, 150)) throw err(400, 'Type the reason for the adjustment.'); this.postCharge(r, c, k.code, -amt, 'ADJ: ' + clip(a.comment, 150), me.username); }
    else { if (pay) throw err(400, 'Use Post Payment for payments.'); this.postCharge(r, c, k.code, amt, a.comment, me.username); }
    this.log(me.username, 'post ' + a.kind + ' ' + k.code + ' ' + amt + ' on ' + r.conf);
    return { balance: this.balance(r.id) };
  }

  /* ---------- numbers for the home screen and reports ---------- */
  stats(c, act, blks) {
    act = act || this.activeRes(); blks = blks || this.blocks(); const d = c.bdate;
    const inh = act.filter(r => r.status === 'inhouse'), ooo = c.rooms.filter(rm => blks.some(b => b.room === rm.no && b.start <= d && d <= b.end)).length;
    const arrivals = act.filter(r => r.status === 'reserved' && r.arrive <= d), total = c.rooms.length;
    const rev = inh.reduce((s, r) => s + (r.rate || 0), 0), sold = inh.length, sellable = total - ooo;
    return { total, ooo, sold, vacant: total - sold - ooo, arrivalsLeft: arrivals.length, checkedIn: inh.filter(r => r.arrive === d).length, dueOut: inh.filter(r => r.depart <= d).length,
      stayovers: inh.filter(r => r.depart > d).length, adults: inh.reduce((s, r) => s + (r.adults || 0), 0), children: inh.reduce((s, r) => s + (r.children || 0), 0),
      occ: sellable ? Math.round(sold / sellable * 10000) / 100 : 0, occAll: total ? Math.round(sold / total * 10000) / 100 : 0, roomRev: rev, adr: sold ? Math.round(rev / sold) : 0, revpar: total ? Math.round(rev / total) : 0 };
  }
  state(me) {
    const c = this.cfg(), act = this.activeRes(), blks = this.blocks();
    const recent = this.rows("SELECT data FROM res WHERE status NOT IN ('reserved','inhouse') AND depart>=? ORDER BY id DESC LIMIT 400", addDays(c.bdate || '2000-01-01', -3)).map(x => JSON.parse(x.data));
    const bal = {}; for (const x of this.rows("SELECT res, SUM(amount) n FROM lines WHERE res IN (SELECT id FROM res WHERE status IN ('reserved','inhouse') OR depart>=?) GROUP BY res", addDays(c.bdate || '2000-01-01', -3))) bal[x.res] = x.n;
    const slim = r => { const { history, ...x } = r; return x; };
    return { me: this.pub(me), config: c, roomstate: this.roomState(), res: act.concat(recent).map(slim), blocks: blks, bal, stats: c.bdate ? this.stats(c, act, blks) : null, at: now() };
  }
  nightAudit(me, c) {
    const d = c.bdate, act = this.activeRes(), out = { date: d, posted: 0, noShows: [], extended: [], revenue: 0 };
    const snap = this.stats(c, act);
    for (const r of act.filter(r => r.status === 'inhouse')) {
      if (r.depart <= d) { r.depart = addDays(d, 1); r.history.push({ at: now(), by: 'night audit', what: 'Not checked out: stay extended to ' + r.depart }); out.extended.push(r.room + ' ' + r.last); this.putRes(r); }
      if (!r.noPost) { this.postCharge(r, c, 'RM', r.rate || 0, '#' + r.room + ' ' + (r.last + ', ' + r.first).toUpperCase(), 'night audit'); out.posted++; out.revenue += r.rate || 0; }
    }
    for (const r of act.filter(r => r.status === 'reserved' && r.arrive <= d)) { r.status = 'noshow'; r.history.push({ at: now(), by: 'night audit', what: 'No show' }); this.putRes(r); out.noShows.push(r.last + ', ' + r.first + ' (' + r.conf + ')'); }
    this.setCond(this.activeRes().filter(r => r.status === 'inhouse').map(r => r.room), { cond: 'D' });
    const tot = this.rows('SELECT code, SUM(amount) n FROM lines WHERE bdate=? GROUP BY code', d);
    this.sql.exec('INSERT OR REPLACE INTO audits(bdate,data) VALUES(?,?)', d, JSON.stringify({ ...snap, roomRev: out.revenue, adr: out.posted ? Math.round(out.revenue / out.posted) : 0, revpar: snap.total ? Math.round(out.revenue / snap.total) : 0, noShows: out.noShows.length, totals: tot, by: me.username, at: now() }));
    this.sql.exec('DELETE FROM blocks WHERE end<?', d);
    c.bdate = addDays(d, 1); this.setKv('config', c); this.log(me.username, 'night audit for ' + d); out.newDate = c.bdate; return out;
  }
  report(q, c) {
    const from = isDate(q.from) ? q.from : c.bdate, to = isDate(q.to) && q.to >= from ? q.to : from;
    if (q.name === 'closeout') return { from, to, rows: this.rows('SELECT code, MAX(descr) descr, COUNT(*) cnt, SUM(amount) total FROM lines WHERE bdate>=? AND bdate<=? GROUP BY code ORDER BY code', from, to) };
    if (q.name === 'shift') return { from, to, rows: this.rows('SELECT user, code, MAX(descr) descr, COUNT(*) cnt, SUM(amount) total FROM lines WHERE bdate>=? AND bdate<=? AND user<>? GROUP BY user, code ORDER BY user, code', from, to, 'night audit') };
    if (q.name === 'stats') { const rows = this.rows('SELECT bdate, data FROM audits WHERE bdate>=? AND bdate<=? ORDER BY bdate', from, to).map(x => ({ date: x.bdate, ...JSON.parse(x.data), totals: undefined })); if (to >= c.bdate && from <= c.bdate) rows.push({ date: c.bdate, live: true, ...this.stats(c) }); return { from, to, rows }; }
    if (q.name === 'journal') return { from, to, rows: this.rows('SELECT l.id, l.bdate, l.at, l.code, l.descr, l.comment, l.amount, l.user, r.name, r.room FROM lines l LEFT JOIN res r ON r.id=l.res WHERE l.bdate>=? AND l.bdate<=? ORDER BY l.id LIMIT 5000', from, to) };
    if (q.name === 'history') { const list = st => this.rows('SELECT data FROM res WHERE status=? AND arrive>=? AND arrive<=? ORDER BY arrive LIMIT 2000', st, from, to).map(x => { const r = JSON.parse(x.data); return { conf: r.conf, name: r.last + ', ' + r.first, arrive: r.arrive, depart: r.depart, type: r.type, room: r.room, rate: r.rate, bal: this.balance(r.id) }; }); return { from, to, noshow: list('noshow'), cancelled: list('cancelled'), out: list('out') }; }
    throw err(404, 'That report was not found.');
  }

  /* ---------- every request comes through here ---------- */
  // req: { method, path, query, body, cookie, ledgerAdmin }  →  { status, json, cookie? }
  handle(req) {
    try { return this.route(req); }
    catch (e) { if (e.code) return { status: e.code, json: { error: e.message } }; return { status: 500, json: { error: 'Something went wrong on the server. ' + String(e && e.message || e).slice(0, 200) } }; }
  }
  route(req) {
    const p = req.path, b = req.body || {}, POST = req.method === 'POST';
    const any = !!this.one('SELECT 1 x FROM users LIMIT 1');
    if (p === '/setup-needed') return { status: 200, json: { needed: !any, owner: !!req.ledgerAdmin } };
    if (p === '/setup' && POST) {
      if (any) throw err(400, 'The hotel is already set up. Sign in instead.');
      if (!req.ledgerAdmin) throw err(403, 'Only the website owner can set up the hotel. Sign in to Ledger Desk (trivedipos.com/books) as the owner first, then come back to this page.');
      const name = String(b.username || '').trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(name)) throw err(400, 'The user name needs 2 to 32 letters or numbers.');
      const u = { username: name, name: clip(b.name, 80) || name, role: 'manager' }; this.setPw(u, b.password); this.saveUser(u);
      const c = starterConfig(); c.name = clip(b.hotel, 80) || 'My Hotel'; c.bdate = isDate(b.today) ? b.today : new Date().toISOString().slice(0, 10); this.setKv('config', c);
      return this.login({ username: name, password: b.password });
    }
    if (p === '/login' && POST) return this.login(b);
    const s = this.sessionUser(req.cookie); if (!s) throw err(401, 'Please sign in.');
    const me = s.user, c = this.cfg(), mgr = () => { if (me.role !== 'manager') throw err(403, 'Only a manager can do that.'); };
    const desk = () => { if (me.role === 'hk') throw err(403, 'Housekeeping logins can only use the housekeeping screen.'); };
    if (p === '/logout' && POST) { this.sql.exec('DELETE FROM sessions WHERE h=?', s.key); return { status: 200, json: { ok: true }, cookie: this.cookie('', 0) }; }
    if (p === '/state') return { status: 200, json: this.state(me) };
    if (p === '/folio') { desk(); const r = this.getRes(req.query.id); return { status: 200, json: { res: r, lines: this.rows('SELECT * FROM lines WHERE res=? ORDER BY id', r.id), balance: this.balance(r.id) } }; }
    if (p === '/find') {
      desk(); const q = clip(req.query.q, 60).toUpperCase(); if (q.length < 2) return { status: 200, json: { list: [] } };
      const digits = q.replace(/\D/g, ''), words = '%' + q.replace(/[%_]/g, '') + '%';
      const rows = digits.length >= 3 ? this.rows('SELECT data FROM res WHERE name LIKE ? OR data LIKE ? OR data LIKE ? ORDER BY id DESC LIMIT 60', words, '%"conf":"' + digits + '%', '%' + digits + '%') : this.rows('SELECT data FROM res WHERE name LIKE ? ORDER BY id DESC LIMIT 60', words);
      const list = rows.map(x => { const { history, ...r } = JSON.parse(x.data); return r; }).filter(r => digits.length >= 3 && !/[A-Z]/.test(q) ? r.conf.startsWith(digits) || (r.phone || '').replace(/\D/g, '').includes(digits) : true);
      return { status: 200, json: { list } };
    }
    if (p === '/report') { desk(); return { status: 200, json: this.report(req.query, c) }; }
    if (p === '/users') { mgr(); return { status: 200, json: { users: this.rows('SELECT data FROM users').map(x => this.pub(JSON.parse(x.data))) } }; }
    if (p !== '/op' || !POST) throw err(404, 'Not found.');
    const a = b.a || {}, ok = x => ({ status: 200, json: { ok: true, ...(x || {}) } });
    switch (b.op) {
      case 'roomCond': { const rooms = (a.rooms || []).filter(no => c.rooms.some(r => r.no === no)); if (!['R', 'C', 'D'].includes(a.cond)) throw err(400, 'Pick Ready, Clean or Dirty.'); this.setCond(rooms, { cond: a.cond }); this.log(me.username, 'rooms ' + rooms.join(',') + ' → ' + a.cond); return ok(); }
      case 'hkSet': { if (!c.rooms.some(r => r.no === a.room)) throw err(400, 'Room not found.'); const patch = {}; if ('dnd' in a) patch.dnd = !!a.dnd; if ('hk' in a) patch.hk = clip(a.hk, 40); if ('note' in a) patch.note = clip(a.note, 200); this.setCond([a.room], patch); return ok(); }
      case 'password': { const u = this.findUser(me.username); if (!nc.timingSafeEqual(Buffer.from(this.hashPw(a.old || '', u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) throw err(400, 'The current password is wrong.'); this.setPw(u, a.new); this.saveUser(u); this.sql.exec('DELETE FROM sessions WHERE user=? AND h<>?', u.username, s.key); return ok(); }
    }
    desk();
    switch (b.op) {
      case 'resSave': { const r = this.resSave(a, me, c); return ok({ id: r.id, conf: r.conf }); }
      case 'walkIn': { a.id = 0; a.arrive = c.bdate; a.source = a.source || 'Walk-In'; if (!a.room) throw err(400, 'Pick a room for the walk-in.'); const cond = (this.roomState()[a.room] || {}).cond || 'R'; if (cond === 'D' && !a.dirtyOk) throw err(412, 'Room ' + a.room + ' is dirty. Check in anyway?'); const r = this.resSave(a, me, c); this.checkIn(r, me, c, { dirtyOk: true }); return ok({ id: r.id, conf: r.conf }); }
      case 'checkIn': { const r = this.getRes(a.id); if (a.room && a.room !== r.room) { this.resSave({ id: r.id, room: a.room }, me, c); Object.assign(r, this.getRes(r.id)); } this.checkIn(r, me, c, a); return ok(); }
      case 'undoCheckIn': { const r = this.getRes(a.id); if (r.status !== 'inhouse') throw err(400, 'This guest is not checked in.'); if (this.one('SELECT 1 x FROM lines WHERE res=? AND code=?', r.id, 'RM')) throw err(400, 'Room charges were already posted, so the check-in cannot be undone. Check the guest out instead.'); r.status = 'reserved'; r.history.push({ at: now(), by: me.username, what: 'Check-in undone' }); this.putRes(r); return ok(); }
      case 'checkOut': {
        const r = this.getRes(a.id); if (r.status !== 'inhouse') throw err(400, 'This guest is not checked in.'); const bal = this.balance(r.id);
        if (bal !== 0 && !(a.force && me.role === 'manager')) throw err(412, 'The folio balance is ' + (bal / 100).toFixed(2) + '. Post a payment (or a refund) to bring it to zero before checking out.' + (me.role === 'manager' ? ' A manager can check out anyway.' : ''));
        r.status = 'out'; r.coAt = now(); r.coBy = me.username; if (r.depart > c.bdate) { r.origDepart = r.depart; r.depart = c.bdate > r.arrive ? c.bdate : addDays(r.arrive, 1); }
        r.history.push({ at: now(), by: me.username, what: 'Checked out, balance ' + (bal / 100).toFixed(2) }); this.putRes(r); this.setCond([r.room], { cond: 'D', dnd: false }); this.log(me.username, 'check out ' + r.conf); return ok();
      }
      case 'undoCheckOut': { const r = this.getRes(a.id); if (r.status !== 'out') throw err(400, 'This guest is not checked out.'); if (r.depart < c.bdate) throw err(400, 'This stay ended before today, so it cannot be reopened.'); if (r.depart <= c.bdate) r.depart = addDays(c.bdate, 1); const pr = this.roomProblem(c, r.room, c.bdate, r.depart, r.id); if (pr) throw err(409, pr); r.status = 'inhouse'; r.history.push({ at: now(), by: me.username, what: 'Check-out undone' }); this.putRes(r); return ok(); }
      case 'cancel': { const r = this.getRes(a.id); if (r.status !== 'reserved') throw err(400, 'Only a reservation that is not checked in can be cancelled.'); r.status = 'cancelled'; r.cxlAt = now(); r.cxlNo = 'X' + r.conf; r.cxlReason = clip(a.reason, 200); r.history.push({ at: now(), by: me.username, what: 'Cancelled' + (r.cxlReason ? ': ' + r.cxlReason : '') }); this.putRes(r); this.log(me.username, 'cancel ' + r.conf); return ok({ cxlNo: r.cxlNo }); }
      case 'reinstate': { const r = this.getRes(a.id); if (!['cancelled', 'noshow'].includes(r.status)) throw err(400, 'This reservation is not cancelled.'); if (r.depart <= c.bdate) throw err(400, 'The stay dates have passed.'); if (r.arrive < c.bdate) r.arrive = c.bdate; r.status = 'reserved'; if (r.room && this.roomProblem(c, r.room, r.arrive, r.depart, r.id)) r.room = ''; if (!r.room && this.availOfType(c, r.type, r.arrive, r.depart, r.id) < 1) throw err(409, 'No ' + r.type + ' rooms are left for those dates.'); r.history.push({ at: now(), by: me.username, what: 'Reinstated' }); this.putRes(r); return ok(); }
      case 'noShow': { const r = this.getRes(a.id); if (r.status !== 'reserved' || r.arrive > c.bdate) throw err(400, 'Only today\'s arrivals can be marked as a no show.'); r.status = 'noshow'; r.history.push({ at: now(), by: me.username, what: 'No show' }); this.putRes(r); return ok(); }
      case 'post': return ok(this.post(a, me, c));
      case 'history': return ok({ history: this.getRes(a.id).history || [] });
      case 'blockAdd': { if (!c.rooms.some(r => r.no === a.room)) throw err(400, 'Room not found.'); if (!isDate(a.start) || !isDate(a.end) || a.end < a.start) throw err(400, 'Check the dates.'); const clash = this.activeRes().find(r => r.room === a.room && r.arrive <= a.end && a.start < r.depart); if (clash) throw err(409, 'Room ' + a.room + ' has ' + clash.last + ', ' + clash.first + ' in it for those dates. Move the guest first.'); this.sql.exec('INSERT INTO blocks(room,start,end,reason) VALUES(?,?,?,?)', a.room, a.start, a.end, clip(a.reason, 120)); this.log(me.username, 'out of order ' + a.room); return ok(); }
      case 'blockRemove': { this.sql.exec('DELETE FROM blocks WHERE id=?', Number(a.id) || 0); return ok(); }
      case 'nightAudit': { mgr(); if (a.date !== c.bdate) throw err(409, 'The business date changed. Reload and try again.'); return ok({ audit: this.nightAudit(me, c) }); }
      case 'configSave': {
        mgr(); const n = a.config || {};
        for (const [k, len] of [['name', 80], ['address', 200], ['phone', 40], ['checkoutTime', 10], ['checkinTime', 10], ['regText', 1500]]) if (k in n) c[k] = clip(n[k], len);
        if (Array.isArray(n.types)) { c.types = n.types.map(t => ({ code: clip(t.code, 8).toUpperCase(), name: clip(t.name, 60), rate: cents(t.rate) })).filter(t => t.code); if (!c.types.length) throw err(400, 'Keep at least one room type.'); }
        if (Array.isArray(n.rooms)) { const seen = new Set(); c.rooms = n.rooms.map(r => ({ no: clip(r.no, 8), type: clip(r.type, 8).toUpperCase(), floor: clip(r.floor, 4) })).filter(r => r.no && !seen.has(r.no) && seen.add(r.no)); for (const r of c.rooms) if (!c.types.some(t => t.code === r.type)) throw err(400, 'Room ' + r.no + ' has an unknown room type (' + r.type + ').'); for (const r of this.activeRes()) if (r.room && !seen.has(r.room)) throw err(409, 'Room ' + r.room + ' has a guest or reservation, so it cannot be removed.'); }
        if (Array.isArray(n.taxes)) c.taxes = n.taxes.map(t => ({ code: clip(t.code, 6).toUpperCase(), name: clip(t.name, 60), pct: Math.max(0, Math.min(50, Number(t.pct) || 0)) })).filter(t => t.code);
        if (Array.isArray(n.codes)) { c.codes = n.codes.map(k => ({ code: clip(k.code, 8).toUpperCase(), name: clip(k.name, 60), type: clip(k.type, 8).toUpperCase(), tax: (k.tax || []).filter(x => c.taxes.some(t => t.code === x)) })).filter(k => k.code); if (!c.codes.some(k => k.code === 'RM')) throw err(400, 'Keep the RM (Room Charge) code. The night audit needs it.'); }
        if (Array.isArray(n.housekeepers)) c.housekeepers = n.housekeepers.map(x => clip(x, 40)).filter(Boolean).slice(0, 40);
        this.setKv('config', c); this.log(me.username, 'changed setup'); return ok();
      }
      case 'userSave': {
        mgr(); const name = String(a.username || '').trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(name)) throw err(400, 'The user name needs 2 to 32 letters or numbers.');
        if (!ROLES.includes(a.role)) throw err(400, 'Pick a role.'); let u = this.findUser(name);
        if (!u) { u = { username: name }; if (!a.password) throw err(400, 'Type a password for the new login.'); }
        if (u.username === me.username && (a.role !== 'manager' || a.disabled)) throw err(400, 'You cannot remove your own manager access.');
        u.name = clip(a.name, 80) || name; u.role = a.role; u.disabled = !!a.disabled; if (a.password) { this.setPw(u, a.password); this.sql.exec('DELETE FROM sessions WHERE user=? AND h<>?', name, s.key); }
        if (u.disabled) this.sql.exec('DELETE FROM sessions WHERE user=?', name); this.saveUser(u); this.log(me.username, 'saved login ' + name); return ok();
      }
    }
    throw err(400, 'Unknown action.');
  }
}
