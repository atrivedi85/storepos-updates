// Hotel Desk directory: every hotel we sell to, every login, and the master account (the seller).
// One of these runs for the whole website. Each hotel's own data lives in its own Hotel object (hotel-core.js).
//   master  = the seller: adds hotels, turns a hotel off (kill switch) and on again, can open any hotel
//   owner   = the hotel's owner: everything in the hotel, makes manager / front desk / housekeeping logins
//   manager = general manager: everything in the hotel, makes front desk / housekeeping logins
//   desk, hk = front desk, housekeeping only
// People sign in with their e-mail address and can reset a forgotten password by e-mail.
import * as nc from 'node:crypto';
import { Buffer } from 'node:buffer';

const SESSION_DAYS = 14, RESET_MIN = 60, INVITE_DAYS = 7;
const now = () => Date.now();
const sha = s => nc.createHash('sha256').update(s).digest('hex');
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = s => s.length <= 120 && /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/.test(s);
function err(code, msg) { const e = new Error(msg); e.code = code; return e; }
const HOTEL_ROLES = ['owner', 'manager', 'desk', 'hk'];
const ROLE_NAME = { master: 'Master', owner: 'Owner', manager: 'Manager', desk: 'Front desk', hk: 'Housekeeping' };

export class DirectoryCore {
  // opts.scrypt(password, saltHex) → hex ; opts.sendMail(cfg, {to, subject, text, fromName}) → Promise
  constructor(sql, opts) {
    this.sql = sql; this.opts = opts || {}; this.fails = {}; this.forgot = {};
    for (const q of ['CREATE TABLE IF NOT EXISTS d_kv(k TEXT PRIMARY KEY, v TEXT)',
      'CREATE TABLE IF NOT EXISTS d_hotels(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS d_users(email TEXT PRIMARY KEY, hotel TEXT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS d_sessions(h TEXT PRIMARY KEY, email TEXT NOT NULL, exp INTEGER NOT NULL, as_hotel TEXT)',
      'CREATE TABLE IF NOT EXISTS d_tokens(h TEXT PRIMARY KEY, email TEXT NOT NULL, kind TEXT, exp INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS d_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, who TEXT, line TEXT)']) this.sql.exec(q);
  }
  rows(q, ...p) { return this.sql.exec(q, ...p).toArray(); }
  one(q, ...p) { const r = this.rows(q, ...p); return r.length ? r[0] : null; }
  kv(k, d) { const r = this.one('SELECT v FROM d_kv WHERE k=?', k); return r ? JSON.parse(r.v) : d; }
  setKv(k, v) { this.sql.exec('INSERT OR REPLACE INTO d_kv(k,v) VALUES(?,?)', k, JSON.stringify(v)); }
  log(who, line) { this.sql.exec('INSERT INTO d_log(at,who,line) VALUES(?,?,?)', now(), who || '', String(line).slice(0, 300)); this.sql.exec('DELETE FROM d_log WHERE id < (SELECT MAX(id) - 20000 FROM d_log)'); }

  hashPw(pw, salt) { if (this.opts.scrypt) return this.opts.scrypt(String(pw), salt); return nc.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex'); }
  setPw(u, pw) { if (String(pw || '').length < 8) throw err(400, 'The password needs at least 8 characters.'); if (String(pw).length > 200) throw err(400, 'That password is too long.'); u.salt = nc.randomBytes(16).toString('hex'); u.hash = this.hashPw(pw, u.salt); }
  pwOk(u, pw) { if (!u || !u.hash) { this.hashPw(pw || '', '00'.repeat(16)); return false; } return nc.timingSafeEqual(Buffer.from(this.hashPw(pw || '', u.salt), 'hex'), Buffer.from(u.hash, 'hex')); }
  user(email) { const r = this.one('SELECT data FROM d_users WHERE email=?', normEmail(email)); return r ? JSON.parse(r.data) : null; }
  saveUser(u) { this.sql.exec('INSERT OR REPLACE INTO d_users(email,hotel,data) VALUES(?,?,?)', u.email, u.hotel || '', JSON.stringify(u)); }
  hotel(id) { const r = this.one('SELECT data FROM d_hotels WHERE id=?', String(id || '')); return r ? JSON.parse(r.data) : null; }
  saveHotel(h) { this.sql.exec('INSERT OR REPLACE INTO d_hotels(id,data) VALUES(?,?)', h.id, JSON.stringify(h)); }
  pubUser(u) { return { email: u.email, name: u.name || u.email, role: u.role, disabled: !!u.disabled, hasPassword: !!u.hash, lastLogin: u.lastLogin || 0 }; }
  cookie(token, age) { return 'hd_s=' + token + '; Path=/hotel; HttpOnly; Secure; SameSite=Strict; Max-Age=' + age; }
  session(cookie) {
    const m = /(?:^|;\s*)hd_s=([a-f0-9]{64})/.exec(cookie || ''); if (!m) return null;
    const k = sha(m[1]), s = this.one('SELECT email, exp, as_hotel FROM d_sessions WHERE h=?', k);
    if (!s || s.exp < now()) { if (s) this.sql.exec('DELETE FROM d_sessions WHERE h=?', k); return null; }
    const u = this.user(s.email); if (!u || u.disabled) return null;
    return { user: u, key: k, as: s.as_hotel || '' };
  }
  startSession(u) {
    const token = nc.randomBytes(32).toString('hex');
    this.sql.exec('INSERT INTO d_sessions(h,email,exp,as_hotel) VALUES(?,?,?,?)', sha(token), u.email, now() + SESSION_DAYS * 864e5, '');
    this.sql.exec('DELETE FROM d_sessions WHERE exp<?', now()); this.sql.exec('DELETE FROM d_tokens WHERE exp<?', now());
    u.lastLogin = now(); this.saveUser(u);
    return this.cookie(token, SESSION_DAYS * 86400);
  }
  offMessage(h) { return 'The Hotel Desk account for ' + (h ? h.name : 'this hotel') + ' is turned off. Please contact your Hotel Desk provider.'; }
  // Who is this browser, and which hotel are they working in?
  whoami(s) {
    const u = s.user;
    if (u.role === 'master') {
      if (!s.as) return { user: { email: u.email, name: u.name, role: 'master', master: true }, hotel: null };
      const h = this.hotel(s.as); if (!h) { this.sql.exec("UPDATE d_sessions SET as_hotel='' WHERE h=?", s.key); return { user: { email: u.email, name: u.name, role: 'master', master: true }, hotel: null }; }
      return { user: { email: u.email, name: u.name, role: 'owner', master: true }, hotel: { id: h.id, name: h.name, status: h.status, template: h.template, tz: h.tz } };
    }
    const h = this.hotel(u.hotel); if (!h) throw err(403, 'This login is not attached to a hotel any more.');
    if (h.status !== 'active') throw err(403, this.offMessage(h));
    return { user: { email: u.email, name: u.name, role: u.role, master: false }, hotel: { id: h.id, name: h.name, status: h.status, template: h.template, tz: h.tz } };
  }
  newToken(email, kind) {
    const token = nc.randomBytes(32).toString('hex');
    this.sql.exec('DELETE FROM d_tokens WHERE email=? AND kind=?', email, kind);
    this.sql.exec('INSERT INTO d_tokens(h,email,kind,exp) VALUES(?,?,?,?)', sha(token), email, kind, now() + (kind === 'invite' ? INVITE_DAYS * 864e5 : RESET_MIN * 6e4));
    return token;
  }
  async mail(to, subject, text, fromName) {
    const cfg = this.kv('mail', null); if (!cfg || !cfg.user || !cfg.pass || !this.opts.sendMail) return false;
    try { await this.opts.sendMail(cfg, { to, subject, text, fromName: fromName || cfg.fromName || 'Hotel Desk' }); return true; }
    catch (e) { this.log('mail', 'could not send to ' + to + ': ' + String(e && e.message || e)); this.lastMailError = String(e && e.message || e); return false; }
  }
  // Makes the "set your password" link for a new login and e-mails it. The link is also handed back so it can be copied.
  async invite(u, origin, by) {
    const link = origin + '/hotel/?t=' + this.newToken(u.email, 'invite'), h = this.hotel(u.hotel);
    const sent = await this.mail(u.email, 'Your Hotel Desk login' + (h ? ' for ' + h.name : ''), 'Hello ' + (u.name || '') + ',\n\n' + (by || 'Your manager') + ' made you a Hotel Desk login' + (h ? ' for ' + h.name : '') + '.\n\nYour user name is this e-mail address: ' + u.email + '\nOpen this link to choose your password (it works for ' + INVITE_DAYS + ' days):\n\n' + link + '\n\nAfter that, sign in any time at ' + origin + '/hotel\n');
    return { link, sent };
  }

  async handle(req) {
    try { return await this.route(req); }
    catch (e) { if (e.code) return { status: e.code, json: { error: e.message } }; return { status: 500, json: { error: 'Something went wrong on the server. ' + String(e && e.message || e).slice(0, 200) } }; }
  }
  async route(req) {
    const p = req.path, b = req.body || {}, POST = req.method === 'POST', ok = x => ({ status: 200, json: { ok: true, ...(x || {}) } });
    if (p === '/internal/mail') {   // only our own hotel objects can reach this (see hotel.js); at most 300 guest e-mails a day per hotel
      if (!req.internal || !POST) throw err(404, 'Not found.');
      const day = new Date().toISOString().slice(0, 10), k = b.hotel + ':' + day; this.sent = this.sent || {}; if ((this.sent[k] || 0) >= 300) throw err(429, 'This hotel has sent too many e-mails today. Try again tomorrow.');
      const cfg = this.kv('mail', null); if (!cfg || !cfg.user || !cfg.pass) throw err(400, 'E-mail sending is not set up yet. Ask your Hotel Desk provider to turn it on.');
      this.lastMailError = ''; const sent = await this.mail(clip(b.to, 120), clip(b.subject, 200), String(b.text || '').slice(0, 20000), clip(b.fromName, 60)); if (!sent) throw err(502, 'The e-mail could not be sent: ' + (this.lastMailError || 'unknown reason'));
      this.sent[k] = (this.sent[k] || 0) + 1; return ok();
    }
    const hasMaster = !!this.one("SELECT 1 x FROM d_users WHERE hotel=''");
    if (p === '/auth/setup-needed') return { status: 200, json: { needed: !hasMaster, owner: !!req.ledgerAdmin } };
    if (p === '/master/setup' && POST) {
      if (hasMaster) throw err(400, 'The master account already exists. Sign in instead.');
      if (!req.ledgerAdmin) throw err(403, 'Only the website owner can make the master account. Sign in to Ledger Desk (trivedipos.com/books) as the owner first, then come back to this page.');
      const email = normEmail(b.email); if (!validEmail(email)) throw err(400, 'Type your e-mail address.');
      const u = { email, name: clip(b.name, 80) || email, role: 'master', hotel: '', created: now() }; this.setPw(u, b.password); this.saveUser(u); this.log(email, 'master account made');
      return { status: 200, json: { ok: true }, cookie: this.startSession(u) };
    }
    if (p === '/auth/login' && POST) {
      const email = normEmail(b.email), f = this.fails[email] || (this.fails[email] = { n: 0, until: 0 });
      if (f.until > now()) throw err(429, 'Too many wrong tries. Wait 10 minutes, or use "Forgot password".');
      const u = this.user(email);
      if (!this.pwOk(u, b.password) || u.disabled) { f.n++; if (f.n >= 8) { f.n = 0; f.until = now() + 6e5; } throw err(401, 'The e-mail address or password is wrong.'); }
      delete this.fails[email];
      if (u.role !== 'master') { const h = this.hotel(u.hotel); if (!h || h.status !== 'active') throw err(403, this.offMessage(h)); }
      this.log(email, 'signed in'); return { status: 200, json: { ok: true }, cookie: this.startSession(u) };
    }
    if (p === '/auth/forgot' && POST) {   // always the same answer, so nobody can test which e-mail addresses have a login
      const email = normEmail(b.email), f = this.forgot[email] || (this.forgot[email] = []); const hour = now() - 36e5;
      while (f.length && f[0] < hour) f.shift();
      const u = validEmail(email) ? this.user(email) : null;
      if (u && !u.disabled && f.length < 3) {
        f.push(now()); const link = req.origin + '/hotel/?t=' + this.newToken(email, 'reset');
        await this.mail(email, 'Reset your Hotel Desk password', 'Hello ' + (u.name || '') + ',\n\nSomeone asked to reset the Hotel Desk password for ' + email + '.\nOpen this link to choose a new password (it works for ' + RESET_MIN + ' minutes, one time):\n\n' + link + '\n\nIf you did not ask for this, ignore this e-mail. Your password stays the same.\n');
        this.log(email, 'asked for a password reset');
      }
      return ok({ mailOn: !!(this.kv('mail', null) || {}).user });
    }
    if ((p === '/auth/token-check' || p === '/auth/reset') && POST) {
      const t = typeof b.token === 'string' && /^[a-f0-9]{64}$/.test(b.token) ? this.one('SELECT email, kind, exp FROM d_tokens WHERE h=?', sha(b.token)) : null;
      const u = t && t.exp > now() ? this.user(t.email) : null;
      if (!u || u.disabled) throw err(410, 'This link has expired or was already used. Ask for a new one with "Forgot password".');
      if (p === '/auth/token-check') return ok({ email: u.email, name: u.name, kind: t.kind });
      if (u.role !== 'master') { const h = this.hotel(u.hotel); if (!h || h.status !== 'active') throw err(403, this.offMessage(h)); }
      this.setPw(u, b.password); this.saveUser(u);
      this.sql.exec('DELETE FROM d_tokens WHERE email=?', u.email); this.sql.exec('DELETE FROM d_sessions WHERE email=?', u.email); delete this.fails[u.email];
      this.log(u.email, 'set a new password by link'); return { status: 200, json: { ok: true }, cookie: this.startSession(u) };
    }
    const s = this.session(req.cookie); if (!s) throw err(401, 'Please sign in.');
    const me = s.user;
    if (p === '/auth/logout' && POST) { this.sql.exec('DELETE FROM d_sessions WHERE h=?', s.key); return { status: 200, json: { ok: true }, cookie: this.cookie('', 0) }; }
    if (p === '/auth/whoami') return { status: 200, json: this.whoami(s) };
    if (p === '/account/password' && POST) { if (!this.pwOk(me, b.old)) throw err(400, 'The current password is wrong.'); this.setPw(me, b.new); this.saveUser(me); this.sql.exec('DELETE FROM d_sessions WHERE email=? AND h<>?', me.email, s.key); return ok(); }

    /* ----- the hotel's own logins (owner and managers) ----- */
    if (p.startsWith('/account/')) {
      const w = this.whoami(s); if (!w.hotel) throw err(400, 'Open a hotel first.');
      const role = w.user.role; if (!['owner', 'manager'].includes(role)) throw err(403, 'Only the owner or a manager can change logins.');
      const may = role === 'owner' ? (me.role === 'master' ? HOTEL_ROLES : ['manager', 'desk', 'hk']) : ['desk', 'hk'];
      const list = () => this.rows('SELECT data FROM d_users WHERE hotel=?', w.hotel.id).map(x => this.pubUser(JSON.parse(x.data))).sort((a, b) => HOTEL_ROLES.indexOf(a.role) - HOTEL_ROLES.indexOf(b.role) || a.name.localeCompare(b.name));
      if (p === '/account/users') return { status: 200, json: { users: list(), may, mailOn: !!(this.kv('mail', null) || {}).user } };
      if (p === '/account/userSave' && POST) {
        const email = normEmail(b.email); if (!validEmail(email)) throw err(400, 'Type the person\'s e-mail address.');
        if (!may.includes(b.role)) throw err(403, 'You cannot make a ' + (ROLE_NAME[b.role] || 'login of that kind') + ' login.');
        let u = this.user(email), isNew = !u;
        if (u && u.hotel !== w.hotel.id) throw err(409, 'That e-mail address already has a Hotel Desk login somewhere else. Use a different e-mail address.');
        if (u && !may.includes(u.role)) throw err(403, 'You cannot change the ' + ROLE_NAME[u.role] + ' login.');
        if (u && u.email === me.email) throw err(400, 'You cannot change your own role or turn yourself off.');
        if (isNew) { if (this.one('SELECT COUNT(*) n FROM d_users WHERE hotel=?', w.hotel.id).n >= 200) throw err(400, 'This hotel has too many logins.'); u = { email, hotel: w.hotel.id, created: now(), createdBy: me.email }; }
        u.name = clip(b.name, 80) || email; u.role = b.role; u.disabled = !!b.disabled; this.saveUser(u);
        if (u.disabled) this.sql.exec('DELETE FROM d_sessions WHERE email=?', email);
        this.log(me.email, 'saved login ' + email + ' (' + u.role + ') at ' + w.hotel.id);
        return ok(isNew ? await this.invite(u, req.origin, me.name) : {});
      }
      if (p === '/account/userInvite' && POST) {   // send the "choose your password" link again (also resets a forgotten password)
        const u = this.user(b.email); if (!u || u.hotel !== w.hotel.id) throw err(404, 'That login was not found.');
        if (!may.includes(u.role)) throw err(403, 'You cannot change the ' + ROLE_NAME[u.role] + ' login.');
        return ok(await this.invite(u, req.origin, me.name));
      }
      throw err(404, 'Not found.');
    }

    /* ----- master account: the hotels we sell to ----- */
    if (!p.startsWith('/master/')) throw err(404, 'Not found.');
    if (me.role !== 'master') throw err(403, 'Only the master account can do that.');
    if (p === '/master/hotels') {
      const cnt = {}; for (const r of this.rows("SELECT hotel, COUNT(*) n FROM d_users WHERE hotel<>'' GROUP BY hotel")) cnt[r.hotel] = r.n;
      const hotels = this.rows('SELECT data FROM d_hotels').map(x => JSON.parse(x.data)).sort((a, b) => a.name.localeCompare(b.name)).map(h => { const o = this.user(h.ownerEmail); return { ...h, users: cnt[h.id] || 0, ownerName: o ? o.name : '', ownerSignedIn: !!(o && o.lastLogin) }; });
      const m = this.kv('mail', null) || {};
      return { status: 200, json: { hotels, mail: { host: m.host || 'smtp.gmail.com', port: m.port || 465, user: m.user || '', fromName: m.fromName || 'Hotel Desk', hasPass: !!m.pass } } };
    }
    if (p === '/master/hotelSave' && POST) {
      let h = b.id ? this.hotel(b.id) : null; const isNew = !h; if (b.id && !h) throw err(404, 'That hotel was not found.');
      const name = clip(b.name, 80); if (!name) throw err(400, 'Type the hotel\'s name.');
      if (b.paidThrough && !/^\d{4}-\d{2}-\d{2}$/.test(b.paidThrough)) throw err(400, 'Check the paid-through date.');
      let owner = null, out = {};
      if (isNew) {
        const email = normEmail(b.ownerEmail); if (!validEmail(email)) throw err(400, 'Type the owner\'s e-mail address.');
        if (this.user(email)) throw err(409, 'That e-mail address already has a Hotel Desk login. Use a different e-mail address for this owner.');
        h = { id: nc.randomBytes(9).toString('hex'), status: 'active', created: now(), template: b.template === 'ky55' ? 'ky55' : 'blank', tz: clip(b.tz, 40) || 'America/New_York', ownerEmail: email };
        owner = { email, hotel: h.id, name: clip(b.ownerName, 80) || email, role: 'owner', created: now(), createdBy: me.email };
      }
      h.name = name; h.paidThrough = b.paidThrough || ''; h.note = clip(b.note, 500); this.saveHotel(h);
      if (owner) { this.saveUser(owner); out = await this.invite(owner, req.origin, me.name); }
      this.log(me.email, (isNew ? 'added hotel ' : 'changed hotel ') + h.name); return ok({ id: h.id, ...out });
    }
    if (p === '/master/status' && POST) {   // the kill switch
      const h = this.hotel(b.id); if (!h) throw err(404, 'That hotel was not found.'); if (!['active', 'off'].includes(b.status)) throw err(400, 'Pick on or off.');
      h.status = b.status; h.statusAt = now(); this.saveHotel(h);
      if (b.status === 'off') this.sql.exec('DELETE FROM d_sessions WHERE email IN (SELECT email FROM d_users WHERE hotel=?)', h.id);   // everyone at that hotel is signed out at once
      this.log(me.email, 'turned ' + h.name + ' ' + b.status); return ok();
    }
    if (p === '/master/ownerInvite' && POST) { const h = this.hotel(b.id), u = h && this.user(h.ownerEmail); if (!u) throw err(404, 'That hotel\'s owner login was not found.'); return ok(await this.invite(u, req.origin, me.name)); }
    if (p === '/master/open' && POST) { if (!this.hotel(b.id)) throw err(404, 'That hotel was not found.'); this.sql.exec('UPDATE d_sessions SET as_hotel=? WHERE h=?', b.id, s.key); return ok(); }
    if (p === '/master/close' && POST) { this.sql.exec("UPDATE d_sessions SET as_hotel='' WHERE h=?", s.key); return ok(); }
    if (p === '/master/mail' && POST) {
      const m = this.kv('mail', null) || {}; const user = clip(b.user, 120);
      if (user && !validEmail(user.toLowerCase())) throw err(400, 'Type the e-mail address that sends the messages.');
      const n = { host: clip(b.host, 100) || 'smtp.gmail.com', port: Number(b.port) || 465, user, from: user, fromName: clip(b.fromName, 60) || 'Hotel Desk', pass: b.pass ? String(b.pass).replace(/\s+/g, '').slice(0, 200) : (user === m.user ? m.pass : '') };
      this.setKv('mail', n); this.log(me.email, 'changed e-mail settings'); return ok();
    }
    if (p === '/master/mailTest' && POST) { this.lastMailError = ''; const sent = await this.mail(me.email, 'Hotel Desk test e-mail', 'This is a test from Hotel Desk. E-mail is working.\n'); if (!sent) throw err(400, this.lastMailError || 'Fill in the e-mail settings first.'); return ok({ to: me.email }); }
    throw err(404, 'Not found.');
  }
}
