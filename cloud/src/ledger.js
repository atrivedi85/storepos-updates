// Ledger Desk on trivedipos.com (moved from "Ledger Desk Server" on the owner's PC).
// One Durable Object ("Ledger") keeps the logins, invites, sessions and the LOCKED company books in its own SQLite.
// Books are locked (AES-256-GCM) in each person's browser with a key made from their password; this server only ever
// stores locked files and can't open them. The AI runs on the owner's own AI PC ("Ledger Desk AI"), which connects out
// to this server; the server passes AI requests to it.
import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import * as nodeCrypto from 'node:crypto';
import { connect } from 'cloudflare:sockets';

const VERSION = '3.0.0-web';
// The very first login (the owner) needs this one-time code, so nobody else can claim the owner login on the public website.
const OWNER_SETUP_HASH = '27e4aa6461035bfb3696c37c2efaae91f0a33baa6c67304aa92ac4b231ad40f6';
const SESSION_DAYS = 30;
const CHUNK = 900000;
const ROLES = ['edit', 'view'];
const now = () => Date.now();
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const sha = s => nodeCrypto.createHash('sha256').update(s).digest('hex');
const rnd = n => Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
const randInt = (lo, hi) => { const r = new Uint32Array(1); crypto.getRandomValues(r); return lo + (r[0] % (hi - lo)); };
const normUser = u => String(u || '').trim().toLowerCase();
const validUser = u => /^[a-z0-9][a-z0-9._-]{1,31}$/.test(u);
const validEmail = s => /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}$/.test(String(s || '').trim());
function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }

/* ---------- scrypt (same settings as Ledger Desk Server, so existing passwords keep working) ---------- */
function salsa(B) {
  const x = new Uint32Array(B); const R = (a, b) => (a << b) | (a >>> (32 - b));
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) >>> 0;
}
function blockMix(B, Y, r) {
  const X = B.slice((2 * r - 1) * 16, 2 * r * 16);
  for (let i = 0; i < 2 * r; i++) { for (let j = 0; j < 16; j++) X[j] ^= B[i * 16 + j]; salsa(X); Y.set(X, i * 16); }
  for (let i = 0; i < r; i++) { B.set(Y.subarray(2 * i * 16, 2 * i * 16 + 16), i * 16); B.set(Y.subarray((2 * i + 1) * 16, (2 * i + 1) * 16 + 16), (r + i) * 16); }
}
function scryptJs(pw, salt, N, r, p, len) {
  const B = nodeCrypto.pbkdf2Sync(pw, salt, 1, p * 128 * r, 'sha256');
  const W = 32 * r, V = new Uint32Array(W * N), X = new Uint32Array(W), Y = new Uint32Array(W);
  for (let k = 0; k < p; k++) {
    for (let i = 0; i < W; i++) X[i] = B.readUInt32LE(k * 128 * r + i * 4);
    for (let i = 0; i < N; i++) { V.set(X, i * W); blockMix(X, Y, r); }
    for (let i = 0; i < N; i++) { const j = X[(2 * r - 1) * 16] & (N - 1); for (let q = 0; q < W; q++) X[q] ^= V[j * W + q]; blockMix(X, Y, r); }
    for (let i = 0; i < W; i++) B.writeUInt32LE(X[i], k * 128 * r + i * 4);
  }
  return nodeCrypto.pbkdf2Sync(pw, B, 1, len, 'sha256');
}
function scrypt64(pw, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  try { if (typeof nodeCrypto.scryptSync === 'function') return nodeCrypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex'); } catch (e) { /* use the JS version */ }
  return scryptJs(Buffer.from(String(pw), 'utf8'), salt, 16384, 8, 1, 64).toString('hex');
}
export const _test = { scryptJs, scrypt64 };
const eqHex = (a, b) => { const x = Buffer.from(a, 'hex'), y = Buffer.from(b || '', 'hex'); return x.length === y.length && nodeCrypto.timingSafeEqual(x, y); };

/* ---------- two-step codes ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = buf => { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; };
const b32dec = str => { let bits = 0, val = 0; const out = []; for (const c of str.replace(/[^A-Z2-7]/gi, '').toUpperCase()) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
function totp(secret, step) {
  const key = b32dec(secret), msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(step / 0x100000000), 0); msg.writeUInt32BE(step >>> 0, 4);
  const h = nodeCrypto.createHmac('sha1', key).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const totpOk = (secret, code) => { const st = Math.floor(Date.now() / 30000); const c = String(code).padStart(6, '0').slice(0, 6); return [-1, 0, 1].some(d => totp(secret, st + d) === c); };
const maskEmail = e => String(e || '').replace(/^(.)(.*)(.@.*)$/, (m, a, b, c) => a + '•'.repeat(Math.min(6, b.length)) + c);

/* ---------- email (SMTP over Cloudflare's TCP sockets: Gmail with an app password, port 465) ---------- */
async function sendMail(cfg, msg) {
  const host = cfg.host, port = Number(cfg.port) || 465;
  const sock = connect({ hostname: host, port }, { secureTransport: port === 465 ? 'on' : 'starttls', allowHalfOpen: false });
  let s = sock;
  let w = s.writable.getWriter(), rd = s.readable.getReader();
  const te = new TextEncoder(), td = new TextDecoder(); let buf = '';
  const read = async () => {
    const t0 = Date.now();
    for (;;) {
      const lines = buf.split('\r\n'); const last = lines[lines.length - 2] || '';
      if (lines[lines.length - 1] === '' && /^\d{3} /.test(last)) { const r = buf; buf = ''; return r; }
      if (Date.now() - t0 > 30000) throw new Error('The email server did not answer in time.');
      const { value, done } = await rd.read(); if (done) throw new Error('The email server closed the connection.');
      buf += td.decode(value);
    }
  };
  const cmd = async (line, ok, hide) => {
    await w.write(te.encode(line + '\r\n')); const r = await read(), code = +r.slice(0, 3);
    if (!ok.includes(code)) throw new Error(code === 535 || code === 534 ? 'The email account or app password was not accepted. For Gmail, use an app password (myaccount.google.com/apppasswords), not your normal password.' : 'The email server refused ' + (hide ? '(login)' : line.split(' ')[0]) + ': ' + r.trim().split('\r\n').pop());
    return r;
  };
  const b64 = x => Buffer.from(x, 'utf8').toString('base64');
  const encWord = x => /^[\x20-\x7e]*$/.test(x) ? x : '=?UTF-8?B?' + b64(x) + '?=';
  const clean = x => String(x || '').replace(/[\r\n]+/g, ' ').trim();
  try {
    let r = await read(); if (!/^220/.test(r)) throw new Error('Unexpected greeting from the email server.');
    r = await cmd('EHLO trivedipos.com', [250]);
    if (port !== 465 && /STARTTLS/i.test(r)) { await cmd('STARTTLS', [220]); w.releaseLock(); rd.releaseLock(); s = sock.startTls(); w = s.writable.getWriter(); rd = s.readable.getReader(); r = await cmd('EHLO trivedipos.com', [250]); }
    if (cfg.user) {
      if (/AUTH[ =][^\r\n]*PLAIN/i.test(r)) await cmd('AUTH PLAIN ' + Buffer.from('\0' + cfg.user + '\0' + cfg.pass, 'utf8').toString('base64'), [235], true);
      else { await cmd('AUTH LOGIN', [334]); await cmd(b64(cfg.user), [334], true); await cmd(b64(cfg.pass), [235], true); }
    }
    const from = clean(cfg.from || cfg.user);
    await cmd('MAIL FROM:<' + from + '>', [250]);
    await cmd('RCPT TO:<' + clean(msg.to) + '>', [250, 251]);
    await cmd('DATA', [354]);
    const body = b64(msg.text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
    const head = ['From: ' + (msg.fromName ? encWord(clean(msg.fromName)) + ' ' : '') + '<' + from + '>', 'To: <' + clean(msg.to) + '>', 'Subject: ' + encWord(clean(msg.subject)),
      'Date: ' + new Date().toUTCString().replace('GMT', '+0000'), 'Message-ID: <' + rnd(12).toString('hex') + '@trivedipos.com>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'].join('\r\n');
    await cmd(head + '\r\n\r\n' + body + '.', [250]);
    try { await w.write(te.encode('QUIT\r\n')); } catch (e) { /* closing anyway */ }
  } finally { try { await s.close(); } catch (e) { /* closed */ } }
  return true;
}

/* ---------- checks on what browsers send ---------- */
const pwProblem = a => (/^[A-Za-z0-9+/]{43}=$/.test(String(a || '')) ? '' : 'Bad sign-in data. Reload the page and try again.');
function validWrap(w) { return w && typeof w === 'object' && ['salt', 'iv', 'ct'].every(k => typeof w[k] === 'string' && /^[A-Za-z0-9+/=]{8,200}$/.test(w[k])) && Number.isInteger(w.iter) && w.iter >= 100000 && w.iter <= 5000000; }
const validVault = v => v && validWrap(v.pw) && validWrap(v.rec);
const cleanWrap = w => ({ salt: w.salt, iter: w.iter, iv: w.iv, ct: w.ct });
const validFile = f => typeof f === 'string' && /^c-[a-f0-9]{16}\.json$/.test(f);
function validEnvelope(text) {
  let e; try { e = JSON.parse(text); } catch (x) { return null; }
  const box = b => b && typeof b.iv === 'string' && typeof b.ct === 'string' && /^[A-Za-z0-9+/=]+$/.test(b.ct) && /^[A-Za-z0-9+/=]{16}$/.test(b.iv);
  return e && e.ld === 'enc1' && box(e.hdr) && box(e.body) ? e : null;
}
const validKey = k => typeof k === 'string' && /^[A-Za-z0-9+/=]{100,1200}$/.test(k);
const publicUser = u => ({ username: u.username, name: u.name || u.username, admin: !!u.admin, disabled: !!u.disabled, created: u.created || '', lastLogin: u.lastLogin || '', mustChange: !!u.mustChange });
const invStatus = i => i.usedBy ? 'used' : i.revoked ? 'cancelled' : i.expires < Date.now() ? 'expired' : 'waiting';

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' };
function json(code, body, headers) {
  const h = new Headers({ ...SEC, 'Content-Type': 'application/json; charset=utf-8' });
  for (const [k, v] of Object.entries(headers || {})) { if (Array.isArray(v)) v.forEach(x => h.append(k, x)); else h.set(k, v); }
  return new Response(JSON.stringify(body), { status: code, headers: h });
}
const cookie = (token, maxAgeSec) => 'ld_s=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAgeSec;
const trustedCookie = (token, maxAgeSec) => 'ld_t=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAgeSec;

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cfg(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY, user TEXT NOT NULL, exp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companies(file TEXT PRIMARY KEY, owner TEXT NOT NULL, keys TEXT NOT NULL, version TEXT, hdr TEXT, size INTEGER);
      CREATE TABLE IF NOT EXISTS blobs(name TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(name, n));
      CREATE TABLE IF NOT EXISTS usettings(username TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conflicts(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, file TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, line TEXT);`);
    this.tickets = {}; this.setup2fa = {}; this.fails = {}; this.globalFails = []; this.ipFails = {};
    this.ai = { pending: new Map() };
  }
  /* --- tiny storage helpers --- */
  rows(q, ...p) { return this.sql.exec(q, ...p).toArray(); }
  one(q, ...p) { const r = this.rows(q, ...p); return r.length ? r[0] : null; }
  cfg() { const r = this.one("SELECT v FROM cfg WHERE k='config'"); return r ? JSON.parse(r.v) : {}; }
  setCfg(c) { this.sql.exec("INSERT OR REPLACE INTO cfg(k,v) VALUES('config',?)", JSON.stringify(c)); }
  log(...a) { this.sql.exec('INSERT INTO log(at,line) VALUES(?,?)', now(), a.join(' ')); this.sql.exec('DELETE FROM log WHERE id < (SELECT MAX(id) - 5000 FROM log)'); }
  users() { return this.rows('SELECT data FROM users').map(r => JSON.parse(r.data)); }
  findUser(u) { const r = this.one('SELECT data FROM users WHERE username=?', normUser(u)); return r ? JSON.parse(r.data) : null; }
  saveUser(u) { this.sql.exec('INSERT OR REPLACE INTO users(username,data) VALUES(?,?)', u.username, JSON.stringify(u)); }
  usettings(u) { const r = this.one('SELECT data FROM usettings WHERE username=?', u.username || u); return r ? JSON.parse(r.data) : {}; }
  setUsettings(u, patch) { this.sql.exec('INSERT OR REPLACE INTO usettings(username,data) VALUES(?,?)', u.username, JSON.stringify({ ...this.usettings(u), ...patch })); }
  invites() { return this.rows('SELECT data FROM invites').map(r => JSON.parse(r.data)).sort((a, b) => String(a.created).localeCompare(String(b.created))); }
  saveInvite(i) { this.sql.exec('INSERT OR REPLACE INTO invites(id,hash,data) VALUES(?,?,?)', i.id, i.hash, JSON.stringify(i)); }
  findInvite(code) { if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(code)) return null; const r = this.one('SELECT data FROM invites WHERE hash=?', sha(code)); return r ? JSON.parse(r.data) : null; }
  putBlob(name, text) { this.sql.exec('DELETE FROM blobs WHERE name=?', name); for (let i = 0, n = 0; i < text.length || n === 0; i += CHUNK, n++) this.sql.exec('INSERT INTO blobs(name,n,data) VALUES(?,?,?)', name, n, text.slice(i, i + CHUNK)); }
  getBlob(name) { const r = this.rows('SELECT data FROM blobs WHERE name=? ORDER BY n', name); return r.length ? r.map(x => x.data).join('') : null; }
  /* --- passwords --- */
  setPw(u, pw) { u.salt = rnd(16).toString('hex'); u.hash = scrypt64(pw, u.salt); }
  setRec(u, rec) { u.recSalt = rnd(16).toString('hex'); u.recHash = scrypt64(rec, u.recSalt); }
  checkPw(u, pw) { if (!u || !u.hash) { scrypt64(pw, '00'.repeat(16)); return false; } return eqHex(scrypt64(pw, u.salt), u.hash); }
  checkRec(u, rec) { if (!u || !u.recHash) { scrypt64(rec, '00'.repeat(16)); return false; } return eqHex(scrypt64(rec, u.recSalt), u.recHash); }
  /* --- sessions --- */
  newSession(username) { const token = rnd(32).toString('hex'); this.sql.exec('INSERT INTO sessions(h,user,exp) VALUES(?,?,?)', sha(token), username, now() + SESSION_DAYS * 864e5); return token; }
  sessionUser(req) {
    const m = /(?:^|;\s*)ld_s=([a-f0-9]{64})/.exec(req.headers.get('cookie') || ''); if (!m) return null;
    const k = sha(m[1]), s = this.one('SELECT user, exp FROM sessions WHERE h=?', k);
    if (!s || s.exp < now()) { if (s) this.sql.exec('DELETE FROM sessions WHERE h=?', k); return null; }
    const u = this.findUser(s.user); if (!u || u.disabled) return null;
    return { user: u, key: k };
  }
  dropSessionsOf(username, exceptKey) { this.sql.exec('DELETE FROM sessions WHERE user=? AND h<>?', username, exceptKey || ''); }
  /* --- guessing limits --- */
  lockedFor(u) {
    const f = this.fails[u]; this.globalFails = this.globalFails.filter(t => t > now() - 15 * 60e3);
    if (this.globalFails.length >= 30) return 'Too many wrong passwords. Try again in a few minutes.';
    if (f && f.until > now()) return 'Too many wrong passwords for this name. Try again in ' + Math.ceil((f.until - now()) / 60e3) + ' minutes.';
    return '';
  }
  noteFail(u) { this.globalFails.push(now()); const f = this.fails[u] = this.fails[u] || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = now() + 15 * 60e3; f.n = 0; } }
  ipLocked(ip) { const f = this.ipFails[ip]; if (!f) return ''; f.t = f.t.filter(t => t > now() - 15 * 60e3); return f.t.length >= 20 ? 'Too many wrong tries from this device. Try again in 15 minutes.' : ''; }
  noteIpFail(ip) { (this.ipFails[ip] = this.ipFails[ip] || { t: [] }).t.push(now()); }
  /* --- two-step --- */
  tfaRequired(u) { return !!(u.tfa && u.tfa.method) || !!this.cfg().require2fa; }
  isTrusted(req, u) {
    const m = /(?:^|;\s*)ld_t=([a-f0-9]{64})/.exec(req.headers.get('cookie') || ''); if (!m || !u.tfa || !u.tfa.trusted) return false;
    const h = sha(m[1]); u.tfa.trusted = u.tfa.trusted.filter(t => t.exp > now()); return u.tfa.trusted.some(t => t.h === h);
  }
  async sendCode(t, u, to) {
    const C = this.cfg();
    if (!C.mail || !C.mail.user) throw httpErr(400, 'Ledger Desk can\'t send email yet. Ask the owner to set up "Email for invites" on the Logins screen, or use an authenticator app.');
    if (t.sentAt && t.sentAt > now() - 30e3) throw httpErr(429, 'A code was just sent. Wait 30 seconds to ask for another.');
    const code = String(randInt(0, 1e6)).padStart(6, '0');
    t.code = sha(code + '|' + t.id); t.sentAt = now(); t.codeExp = now() + 10 * 60e3; t.to = to;
    await sendMail(C.mail, { to, fromName: 'Ledger Desk', subject: 'Your Ledger Desk sign-in code: ' + code, text: 'Your Ledger Desk sign-in code is ' + code + '\n\nIt works for 10 minutes. If you didn\'t just try to sign in as ' + u.username + ', someone may know your password: change it in Ledger Desk.\n' });
  }
  /* --- companies --- */
  company(f) { const r = this.one('SELECT * FROM companies WHERE file=?', f); return r ? { ...r, keys: JSON.parse(r.keys) } : null; }
  writeKeys(f, keys) { this.sql.exec('UPDATE companies SET keys=? WHERE file=?', JSON.stringify(keys), f); }
  saveBooks(f, text) {
    const e = JSON.parse(text); const v = now() + '-' + text.length;
    this.putBlob('books:' + f, text);
    this.sql.exec('UPDATE companies SET version=?, hdr=?, size=? WHERE file=?', v, JSON.stringify(e.hdr), text.length, f);
    return v;
  }
  access(me, f, opts) {
    if (!validFile(f)) throw httpErr(400, 'Bad company file name');
    const c = this.company(f);
    if (!c) { if (opts && opts.allowNew) return { file: f, owner: me.username, role: 'owner', keys: { owner: me.username, members: {} }, isNew: true }; throw httpErr(404, 'That company was not found.'); }
    const keys = { owner: c.keys.owner || c.owner, members: c.keys.members || {} };
    if (c.owner === me.username) return { file: f, owner: c.owner, role: 'owner', keys, version: c.version };
    const m = keys.members[me.username];
    if (!m || m.role === 'owner') throw httpErr(403, 'You don\'t have access to this company (any more).');
    if (!m.key) { const ou = this.findUser(c.owner) || {}; throw httpErr(403, 'This company is still being shared with you. It opens after ' + (ou.name || c.owner) + ' next opens Ledger Desk.'); }
    return { file: f, owner: c.owner, role: m.role, keys, version: c.version };
  }
  entryFor(me, c) {
    const keys = c.keys, mine = (keys.members || {})[me.username], ou = this.findUser(c.owner) || { name: c.owner };
    return { file: c.file, hdr: c.hdr ? JSON.parse(c.hdr) : null, owner: c.owner, ownerName: ou.name || c.owner, role: c.owner === me.username ? 'owner' : mine.role, key: mine ? mine.key : null, shared: Object.keys(keys.members || {}).filter(n => n !== c.owner).length };
  }
  listCompanies(me) {
    const out = [];
    for (const r of this.rows('SELECT file, owner, keys, hdr FROM companies')) {
      const c = { ...r, keys: JSON.parse(r.keys) };
      if (!c.hdr) continue;
      if (c.owner === me.username) out.push(this.entryFor(me, c));
      else { const m = (c.keys.members || {})[me.username]; if (m && m.role !== 'owner') { const e = this.entryFor(me, c); if (!e.key) e.hdr = null; out.push(e); } }
    }
    return out;
  }
  currentFile(u, list) {
    list = list || this.listCompanies(u); const want = this.usettings(u).current;
    if (want && list.some(c => c.file === want)) return want;
    const mine = list.find(c => c.role === 'owner'); return mine ? mine.file : list.length ? list[0].file : null;
  }

  /* --- the AI PC (Ledger Desk AI connects here and answers AI requests) --- */
  aiSocket() { return this.ctx.getWebSockets('ai')[0] || null; }
  async aiCall(path, body) {
    const ws = this.aiSocket(); if (!ws) throw httpErr(503, 'The AI PC is not connected. Start Ledger Desk AI on your AI PC.');
    const id = rnd(8).toString('hex');
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.ai.pending.delete(id); reject(httpErr(504, 'The AI took too long to answer.')); }, 300e3);
      this.ai.pending.set(id, { resolve, reject, to });
      ws.send(JSON.stringify({ t: 'job', id, path, body }));
    });
  }
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch (e) { return; }
    if (m.t === 'status') { this.ai.status = m.status || null; this.ai.statusAt = now(); return; }
    if (m.t === 'ping') { ws.send('{"t":"pong"}'); return; }
    if (m.t === 'done') { const w = this.ai.pending.get(m.id); if (!w) return; this.ai.pending.delete(m.id); clearTimeout(w.to); if (m.error) w.reject(httpErr(502, m.error)); else w.resolve(m.result); }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* closed */ } }

  async fetch(req) {
    try { return await this.handle(req); }
    catch (e) { if (typeof e.code !== 'number') this.log('error:', e.stack || e.message); return json(typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'Something went wrong on the server.' }); }
  }
  async handle(req) {
    const url = new URL(req.url), p = url.pathname, q = k => url.searchParams.get(k);
    const ip = req.headers.get('cf-connecting-ip') || '?';
    const body = async (limit) => { const t = await req.text(); if (t.length > (limit || 2e6)) throw httpErr(413, 'Too big'); return t; };
    const jbody = async (limit) => { const t = await body(limit); try { return JSON.parse(t || '{}'); } catch (e) { throw httpErr(400, 'Bad request'); } };

    // The AI PC connects here (owner makes its key on the Logins screen)
    if (p === '/api/ai-pc') {
      if (req.headers.get('Upgrade') !== 'websocket') return json(426, { error: 'WebSocket expected' });
      const C = this.cfg(), k = url.searchParams.get('key') || '';
      if (!C.aiKeyHash || !/^[a-f0-9]{64}$/.test(k) || sha(k) !== C.aiKeyHash) return json(403, { error: 'Wrong AI PC key' });
      for (const w of this.ctx.getWebSockets('ai')) { try { w.close(4000, 'Another AI PC connected'); } catch (e) { /* gone */ } }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['ai']); this.log('AI PC connected');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method === 'POST' && req.headers.get('x-ld') !== '1') return json(403, { error: 'Blocked' });

    // ----- sign-in (no session needed) -----
    if (p === '/api/setup-needed') return json(200, { needed: !this.one('SELECT 1 x FROM users LIMIT 1') });
    if (p === '/api/invite/check' && req.method === 'POST') {
      const b = await jbody(); const locked = this.lockedFor('#invite'); if (locked) return json(429, { error: locked });
      const inv = this.findInvite(b.code);
      if (!inv) { this.noteFail('#invite'); return json(404, { error: 'This invite link is not valid. Ask the owner for a new one.' }); }
      const st = invStatus(inv);
      if (st !== 'waiting') return json(410, { error: st === 'used' ? 'This invite was already used. Sign in instead, or ask the owner for a new invite.' : st === 'expired' ? 'This invite has expired. Ask the owner for a new one.' : 'This invite was cancelled.' });
      return json(200, { ok: true, name: inv.name || '', expires: inv.expires });
    }
    if (p === '/api/invite/accept' && req.method === 'POST') {
      const b = await jbody(); const locked = this.lockedFor('#invite'); if (locked) return json(429, { error: locked });
      const inv = this.findInvite(b.code);
      if (!inv || invStatus(inv) !== 'waiting') { this.noteFail('#invite'); return json(410, { error: 'This invite link can\'t be used. Ask the owner for a new one.' }); }
      const username = normUser(b.username);
      if (!validUser(username)) return json(400, { error: 'Use 2–32 letters or numbers for the user name (dots, dashes and underscores are OK).' });
      if (this.findUser(username)) return json(400, { error: 'That user name is taken. Pick another one.' });
      const bad = pwProblem(b.auth); if (bad) return json(400, { error: bad });
      if (!validVault(b.vault) || pwProblem(b.recAuth)) return json(400, { error: 'Bad key data. Reload the page and try again.' });
      const u = { username, name: clip(b.name, 80) || inv.name || username, admin: false, created: new Date().toISOString(), lastLogin: new Date().toISOString(), invitedBy: inv.by, vault: { pw: cleanWrap(b.vault.pw), rec: cleanWrap(b.vault.rec) } };
      this.setPw(u, b.auth); this.setRec(u, b.recAuth); this.saveUser(u);
      inv.usedBy = username; inv.usedAt = new Date().toISOString(); this.saveInvite(inv);
      if (inv.share && Array.isArray(inv.share.files)) for (const f of inv.share.files) {
        const c = validFile(f) && this.company(f); if (!c || c.owner !== inv.by) continue;
        if (!c.keys.members[username]) { c.keys.members[username] = { key: null, role: inv.share.role === 'view' ? 'view' : 'edit', pending: true, added: new Date().toISOString(), by: inv.by }; this.writeKeys(f, c.keys); }
      }
      this.log('account created from invite:', username);
      return json(200, { ok: true }, { 'Set-Cookie': cookie(this.newSession(username), SESSION_DAYS * 86400) });
    }
    if (p === '/api/setup' && req.method === 'POST') {
      if (this.one('SELECT 1 x FROM users LIMIT 1')) return json(403, { error: 'Already set up' });
      const b = await jbody(); const username = normUser(b.username);
      const locked = this.lockedFor('#setup'); if (locked) return json(429, { error: locked });
      if (sha('ledgerdesk-owner|' + String(b.setupCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '')) !== OWNER_SETUP_HASH) { this.noteFail('#setup'); return json(403, { error: 'That owner setup code is not right.' }); }
      if (!validUser(username)) return json(400, { error: 'Use 2–32 letters or numbers for the user name (dots, dashes and underscores are OK).' });
      const bad = pwProblem(b.auth); if (bad) return json(400, { error: bad });
      if (!validVault(b.vault) || pwProblem(b.recAuth)) return json(400, { error: 'Bad key data. Reload the page and try again.' });
      const u = { username, name: clip(b.name, 80) || username, admin: true, created: new Date().toISOString(), lastLogin: new Date().toISOString(), vault: { pw: cleanWrap(b.vault.pw), rec: cleanWrap(b.vault.rec) } };
      this.setPw(u, b.auth); this.setRec(u, b.recAuth); this.saveUser(u); this.log('first admin created:', username);
      return json(200, { ok: true }, { 'Set-Cookie': cookie(this.newSession(username), SESSION_DAYS * 86400) });
    }
    if ((p === '/api/recover/check' || p === '/api/recover') && req.method === 'POST') {
      const b = await jbody(); const username = normUser(b.username);
      const locked = this.lockedFor(username); if (locked) return json(429, { error: locked });
      const u = this.findUser(username);
      if (!u || u.disabled || pwProblem(b.recAuth) || !this.checkRec(u, b.recAuth)) { this.noteFail(username); this.log('recovery failed:', username); return json(401, { error: u && u.disabled ? 'This login is turned off. Ask the owner.' : 'That user name and recovery code don\'t match.' }); }
      if (p === '/api/recover/check') return json(200, { rec: u.vault.rec });
      const bad = pwProblem(b.auth); if (bad) return json(400, { error: bad });
      if (!validWrap(b.vaultPw)) return json(400, { error: 'Bad key data.' });
      delete this.fails[username];
      this.setPw(u, b.auth); u.vault = { pw: cleanWrap(b.vaultPw), rec: u.vault.rec };
      delete u.mustChange; delete u.needRecovery; u.lastLogin = new Date().toISOString(); this.saveUser(u); this.dropSessionsOf(u.username);
      this.log(username, 'reset their password with the recovery code');
      return json(200, { ok: true }, { 'Set-Cookie': cookie(this.newSession(username), SESSION_DAYS * 86400) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = await jbody(); const username = normUser(b.username);
      const locked = this.lockedFor(username); if (locked) return json(429, { error: locked });
      const ipl = this.ipLocked(ip); if (ipl) return json(429, { error: ipl });
      const u = this.findUser(username);
      if (!this.checkPw(u, b.auth) || u.disabled) { this.noteFail(username); this.noteIpFail(ip); this.log('sign-in failed:', username, 'from', ip); return json(401, { error: u && u.disabled ? 'This login is turned off. Ask the owner.' : 'Wrong user name or password.' }); }
      delete this.fails[username];
      if (this.tfaRequired(u) && !this.isTrusted(req, u)) {
        const id = rnd(24).toString('hex'), t = this.tickets[id] = { id, user: u.username, exp: now() + 15 * 60e3, tries: 0 };
        const method = u.tfa && u.tfa.method === 'app' ? 'app' : u.email ? 'email' : 'setup';
        t.method = method;
        if (method === 'email') { try { await this.sendCode(t, u, u.email); } catch (e) { return json(e.code || 502, { error: e.message }); } }
        return json(200, { need2fa: method, ticket: id, to: method === 'email' ? maskEmail(u.email) : '', canEmail: !!u.email });
      }
      u.lastLogin = new Date().toISOString(); this.saveUser(u); this.log('signed in:', username);
      return json(200, { ok: true, vault: u.vault, needRecovery: !!u.needRecovery }, { 'Set-Cookie': cookie(this.newSession(username), SESSION_DAYS * 86400) });
    }
    if (p.startsWith('/api/login/2fa') && req.method === 'POST') {
      const b = await jbody(); const ipl = this.ipLocked(ip); if (ipl) return json(429, { error: ipl });
      for (const k of Object.keys(this.tickets)) if (this.tickets[k].exp < now()) delete this.tickets[k];
      const t = this.tickets[String(b.ticket || '')], u = t && this.findUser(t.user);
      if (!t || t.exp < now() || !u || u.disabled) return json(401, { error: 'That took too long. Sign in again.' });
      if (p === '/api/login/2fa/email') {
        const to = t.method === 'setup' ? String(b.email || '').trim() : u.email;
        if (!validEmail(to)) return json(400, { error: 'Type your full email address.' });
        try { await this.sendCode(t, u, to); } catch (e) { return json(e.code || 502, { error: e.message }); }
        if (t.method !== 'setup') t.method = 'email';
        return json(200, { ok: true, to: maskEmail(to) });
      }
      if (p === '/api/login/2fa') {
        const code = String(b.code || '').replace(/\D/g, '');
        let ok = false;
        if (t.method === 'app' && u.tfa && u.tfa.secret) ok = code.length === 6 && totpOk(u.tfa.secret, code);
        if (!ok && t.code && t.codeExp > now()) ok = code.length === 6 && sha(code + '|' + t.id) === t.code;
        if (!ok) { t.tries++; this.noteIpFail(ip); if (t.tries >= 5) delete this.tickets[t.id]; return json(401, { error: t.tries >= 5 ? 'Too many wrong codes. Sign in again.' : 'That code isn\'t right.' }); }
        delete this.tickets[t.id];
        if (t.method === 'setup') { u.email = t.to; u.tfa = { method: 'email', trusted: [] }; }
        u.tfa = u.tfa || { method: 'email', trusted: [] }; u.tfa.trusted = (u.tfa.trusted || []).filter(x => x.exp > now());
        const heads = [cookie(this.newSession(u.username), SESSION_DAYS * 86400)];
        if (b.trust) { const tok = rnd(32).toString('hex'); u.tfa.trusted.push({ h: sha(tok), exp: now() + 30 * 864e5, at: new Date().toISOString() }); u.tfa.trusted = u.tfa.trusted.slice(-10); heads.push(trustedCookie(tok, 30 * 86400)); }
        u.lastLogin = new Date().toISOString(); this.saveUser(u); this.log('signed in (two-step):', u.username);
        return json(200, { ok: true, vault: u.vault, needRecovery: !!u.needRecovery }, { 'Set-Cookie': heads });
      }
      return json(404, { error: 'Not found' });
    }

    const s = this.sessionUser(req);
    if (!s) return json(401, { error: 'Please sign in again.' });
    const me = s.user;

    if (p === '/api/logout' && req.method === 'POST') { this.sql.exec('DELETE FROM sessions WHERE h=?', s.key); return json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }
    if (p === '/api/me') return json(200, { ...publicUser(me), version: VERSION, vault: me.vault, needRecovery: !!me.needRecovery, pub: me.pub || null, priv: me.priv || null, web: true });
    if (p === '/api/password' && req.method === 'POST') {
      const b = await jbody();
      if (!this.checkPw(me, b.old)) return json(400, { error: 'Your current password is not right.' });
      const bad = pwProblem(b.auth); if (bad) return json(400, { error: bad });
      if (!validWrap(b.vaultPw)) return json(400, { error: 'Bad key data. Reload the page and try again.' });
      if (b.vaultRec && !validWrap(b.vaultRec)) return json(400, { error: 'Bad key data.' });
      this.setPw(me, b.auth); me.vault = { pw: cleanWrap(b.vaultPw), rec: b.vaultRec ? cleanWrap(b.vaultRec) : me.vault.rec };
      delete me.mustChange; delete me.needRecovery; this.saveUser(me); this.dropSessionsOf(me.username, s.key); this.log(me.username, 'changed password');
      return json(200, { ok: true });
    }
    if (p === '/api/recovery/new' && req.method === 'POST') {
      const b = await jbody();
      if (!this.checkPw(me, b.auth)) return json(400, { error: 'Your password is not right.' });
      if (pwProblem(b.recAuth) || !validWrap(b.vaultRec)) return json(400, { error: 'Bad key data. Reload the page and try again.' });
      this.setRec(me, b.recAuth); me.vault = { pw: me.vault.pw, rec: cleanWrap(b.vaultRec) }; this.saveUser(me); this.log(me.username, 'made a new recovery code');
      return json(200, { ok: true });
    }
    if (p === '/api/vault/restart' && req.method === 'POST') {
      const b = await jbody();
      if (!me.needRecovery) return json(400, { error: 'Not needed' });
      if (!this.checkPw(me, b.old)) return json(400, { error: 'Your current password is not right.' });
      const bad = pwProblem(b.auth); if (bad) return json(400, { error: bad });
      if (!validVault(b.vault) || pwProblem(b.recAuth)) return json(400, { error: 'Bad key data.' });
      // old books can't be opened any more: set them aside (renamed owner), not deleted
      this.sql.exec("UPDATE companies SET owner = '#locked:' || owner || ':' || ? WHERE owner=?", stamp(), me.username);
      this.setPw(me, b.auth); this.setRec(me, b.recAuth); me.vault = { pw: cleanWrap(b.vault.pw), rec: cleanWrap(b.vault.rec) };
      delete me.mustChange; delete me.needRecovery; this.saveUser(me); this.dropSessionsOf(me.username, s.key); this.log(me.username, 'started over with a new key (lost recovery code)');
      return json(200, { ok: true });
    }
    if (me.needRecovery && p !== '/api/ai/status') return json(403, { error: 'Unlock your books with your recovery code first.' });

    // ----- books (only locked files go in or out) -----
    if (p === '/api/companies') { const list = this.listCompanies(me); return json(200, { list, current: this.currentFile(me, list) }); }
    if (p === '/api/companies/current' && req.method === 'POST') { const b = await jbody(); this.access(me, b.file); this.setUsettings(me, { current: b.file }); return json(200, { ok: true }); }
    if (p === '/api/companies/create' && req.method === 'POST') {
      const text = await body(80e6), file = q('file'), key = req.headers.get('x-ld-key');
      if (!validFile(file)) throw httpErr(400, 'Bad company file name');
      if (!validEnvelope(text)) throw httpErr(400, 'Only locked company files can be stored.');
      if (!validKey(key)) throw httpErr(400, 'Missing the company key. Reload the page and try again.');
      if (this.company(file)) throw httpErr(409, 'That company already exists');
      this.sql.exec('INSERT INTO companies(file, owner, keys) VALUES(?,?,?)', file, me.username, JSON.stringify({ owner: me.username, members: { [me.username]: { key, role: 'owner', added: new Date().toISOString() } } }));
      const version = this.saveBooks(file, text); this.log(me.username, 'created company', file);
      return json(200, { file, version });
    }
    if (p === '/api/books') { const a = this.access(me, q('file')); return json(200, { text: this.getBlob('books:' + a.file), version: a.version || null, role: a.role }); }
    if (p === '/api/books/version') return json(200, { version: this.access(me, q('file')).version || null });
    if (p === '/api/books/save' && req.method === 'POST') {
      const a = this.access(me, q('file'));
      if (a.role === 'view') return json(403, { error: 'You can only view this company. Your change was not saved.' });
      const text = await body(80e6);
      if (!validEnvelope(text)) return json(400, { error: 'Only locked books can be saved.' });
      const have = a.version || null, want = q('if') || null;
      if (have !== want) {
        const cid = this.sql.exec('INSERT INTO conflicts(username,file,at) VALUES(?,?,?) RETURNING id', me.username, a.file, now()).one().id;
        this.putBlob('conflict:' + cid, text); this.log(me.username, 'save conflict on', a.file);
        return json(200, { conflict: true, text: this.getBlob('books:' + a.file), version: have });
      }
      return json(200, { ok: true, version: this.saveBooks(a.file, text) });
    }
    // ----- sharing -----
    if (p === '/api/me/keys' && req.method === 'POST') {
      const b = await jbody(20000);
      if (!/^[A-Za-z0-9+/=]{300,1200}$/.test(b.pub || '') || !b.priv || !/^[A-Za-z0-9+/=]{16}$/.test(b.priv.iv || '') || !/^[A-Za-z0-9+/=]{500,6000}$/.test(b.priv.ct || '')) return json(400, { error: 'Bad key data' });
      if (me.pub && !b.replace) return json(409, { error: 'Keys already set' });
      me.pub = b.pub; me.priv = { iv: b.priv.iv, ct: b.priv.ct }; this.saveUser(me);
      return json(200, { ok: true });
    }
    if (p === '/api/share/pending') {
      const out = [];
      for (const r of this.rows('SELECT file, keys FROM companies WHERE owner=?', me.username)) {
        const k = JSON.parse(r.keys);
        Object.entries(k.members || {}).forEach(([n, m]) => { const u = this.findUser(n); if (!m.key && n !== me.username && u && u.pub && !u.disabled) out.push({ file: r.file, username: n, role: m.role }); });
      }
      return json(200, { pending: out });
    }
    if (p === '/api/users/lookup') {
      const u = this.findUser(q('username'));
      if (!u || u.disabled || u.username === me.username) return json(404, { error: 'There is no other login with that user name.' });
      if (!u.pub) return json(409, { error: u.username + ' needs to sign in to Ledger Desk once before you can share with them.' });
      return json(200, { username: u.username, name: u.name || u.username, pub: u.pub });
    }
    if (p === '/api/share/list') {
      const a = this.access(me, q('file'));
      if (a.role !== 'owner') return json(403, { error: 'Only the owner can see who has access.' });
      const members = Object.entries(a.keys.members).filter(([n, m]) => n !== a.owner && m.role !== 'owner').map(([n, m]) => { const u = this.findUser(n) || {}; return { username: n, name: u.name || n, role: m.role, added: m.added || '', disabled: !!u.disabled, pending: !m.key }; });
      return json(200, { members });
    }
    if (p.startsWith('/api/share/') && req.method === 'POST') {
      const b = await jbody(90e6); const a = this.access(me, b.file);
      if (p === '/api/share/leave') {
        if (a.role === 'owner') return json(400, { error: 'You own this company.' });
        delete a.keys.members[me.username]; this.writeKeys(a.file, a.keys); return json(200, { ok: true });
      }
      if (a.role !== 'owner') return json(403, { error: 'Only the owner can change who has access.' });
      if (p === '/api/share/add') {
        const u = this.findUser(b.username);
        if (!u || u.username === me.username || u.disabled) return json(404, { error: 'There is no other login with that user name.' });
        if (!ROLES.includes(b.role) || !validKey(b.key)) return json(400, { error: 'Bad sharing data' });
        a.keys.members[u.username] = { key: b.key, role: b.role, added: new Date().toISOString(), by: me.username };
        this.writeKeys(a.file, a.keys); this.log(me.username, 'shared a company with', u.username, '(' + b.role + ')');
        return json(200, { ok: true });
      }
      if (p === '/api/share/role') {
        const m = a.keys.members[normUser(b.username)];
        if (!m || m.role === 'owner' || !ROLES.includes(b.role)) return json(400, { error: 'Bad sharing data' });
        m.role = b.role; this.writeKeys(a.file, a.keys); return json(200, { ok: true });
      }
      if (p === '/api/share/remove') {
        const n = normUser(b.username);
        if (!a.keys.members[n] || n === a.owner) return json(400, { error: 'That person doesn\'t have access.' });
        delete a.keys.members[n]; this.writeKeys(a.file, a.keys); return json(200, { ok: true });
      }
      if (p === '/api/share/rekey') {
        if (!validEnvelope(b.env)) return json(400, { error: 'Only locked books can be saved.' });
        if ((a.version || null) !== (b.if || null)) return json(409, { error: 'The books changed while re-locking. Try again.' });
        const keys = b.keys || {}, allowed = new Set([a.owner].concat(Object.keys(a.keys.members)));
        if (!validKey(keys[a.owner]) || Object.keys(keys).some(n => !allowed.has(n) || !validKey(keys[n]))) return json(400, { error: 'Bad key data' });
        const members = {};
        Object.keys(keys).forEach(n => { const old = a.keys.members[n] || {}; members[n] = { key: keys[n], role: n === a.owner ? 'owner' : (old.role || 'view'), added: old.added || new Date().toISOString(), by: old.by }; });
        this.writeKeys(a.file, { owner: a.owner, members }); const version = this.saveBooks(a.file, b.env);
        this.log(me.username, 'gave a company a new key');
        return json(200, { ok: true, version });
      }
    }
    // ----- company files waiting to come in: not used on the website -----
    if (p === '/api/import/list') return json(200, { files: [] });
    if (p.startsWith('/api/import/')) return json(404, { error: 'Not available on the website' });

    // ----- AI (answered by the owner's AI PC) -----
    if (p === '/api/ai/status') {
      if (!this.aiSocket()) return json(200, { ok: false, reason: 'The AI PC is not connected.', gemini: { available: false, on: false } });
      const st = this.ai.status || { ok: true, hasText: true, hasVision: true };
      return json(200, { ...st, busy: this.ai.pending.size, gemini: { available: false, on: false } });
    }
    if (p === '/api/me/2fa') {
      const C = this.cfg();
      if (req.method !== 'POST') return json(200, { method: me.tfa && me.tfa.method || '', email: me.email || '', required: !!C.require2fa, trusted: ((me.tfa && me.tfa.trusted) || []).filter(t => t.exp > now()).length, canEmail: !!(C.mail && C.mail.user) });
      const b = await jbody();
      if (b.action === 'off') { if (C.require2fa) return json(400, { error: 'The owner requires two-step sign-in for everyone.' }); delete me.tfa; this.saveUser(me); return json(200, { ok: true }); }
      if (b.action === 'forget') { if (me.tfa) me.tfa.trusted = []; this.saveUser(me); return json(200, { ok: true }); }
      if (b.action === 'email-send') {
        const to = String(b.email || '').trim(); if (!validEmail(to)) return json(400, { error: 'Type your full email address.' });
        const t = this.setup2fa[me.username + ':email'] = { id: rnd(8).toString('hex') };
        try { await this.sendCode(t, me, to); } catch (e) { return json(e.code || 502, { error: e.message }); }
        return json(200, { ok: true });
      }
      if (b.action === 'email-confirm') {
        const t = this.setup2fa[me.username + ':email']; if (!t || !t.code || t.codeExp < now() || sha(String(b.code || '').replace(/\D/g, '') + '|' + t.id) !== t.code) return json(400, { error: 'That code isn\'t right.' });
        me.email = t.to; me.tfa = { method: 'email', trusted: (me.tfa && me.tfa.trusted) || [] }; delete this.setup2fa[me.username + ':email']; this.saveUser(me);
        return json(200, { ok: true });
      }
      if (b.action === 'app-start') { const secret = b32enc(rnd(20)); this.setup2fa[me.username + ':app'] = secret; return json(200, { secret, uri: 'otpauth://totp/' + encodeURIComponent('Ledger Desk:' + me.username) + '?secret=' + secret + '&issuer=' + encodeURIComponent('Ledger Desk') }); }
      if (b.action === 'app-confirm') {
        const secret = this.setup2fa[me.username + ':app']; if (!secret || !totpOk(secret, String(b.code || '').replace(/\D/g, ''))) return json(400, { error: 'That code isn\'t right. Check the time on your phone is set automatically.' });
        me.tfa = { method: 'app', secret, trusted: (me.tfa && me.tfa.trusted) || [] }; delete this.setup2fa[me.username + ':app']; this.saveUser(me);
        return json(200, { ok: true });
      }
      return json(400, { error: 'Bad request' });
    }
    if (p === '/api/me/ai' && req.method === 'POST') return json(200, { ok: true, provider: 'local' });
    if (p.startsWith('/api/ai/') && req.method === 'POST') {
      const b = await jbody(p === '/api/ai/check' || p === '/api/ai/document' ? 15e6 : 3e6);
      if (!['/api/ai/categorize', '/api/ai/ask', '/api/ai/check', '/api/ai/explain', '/api/ai/review', '/api/ai/document'].includes(p)) return json(404, { error: 'Not found' });
      const out = await this.aiCall(p, b); out.by = 'local';
      return json(200, out);
    }

    // ----- owner only: manage logins -----
    if (p.startsWith('/api/admin/')) {
      if (!me.admin) return json(403, { error: 'Only the owner can do this.' });
      const C = this.cfg();
      if (p === '/api/admin/users') return json(200, { users: this.users().map(u => ({ ...publicUser(u), companies: this.one('SELECT COUNT(*) n FROM companies WHERE owner=?', u.username).n, tfa: u.tfa && u.tfa.method || '' })) });
      if (p === '/api/admin/invites') return json(200, { require2fa: !!C.require2fa, mailFrom: C.mail && C.mail.user ? C.mail.user : '', publicUrl: '', tailscaleInvite: '', aiPc: { connected: !!this.aiSocket(), hasKey: !!C.aiKeyHash, status: this.ai.status || null }, invites: this.invites().reverse().map(i => ({ id: i.id, name: i.name, note: i.note, sentTo: i.sentTo || '', shares: i.share ? i.share.files.length : 0, shareRole: i.share ? i.share.role : '', created: i.created, expires: i.expires, status: invStatus(i), usedBy: i.usedBy || '', usedAt: i.usedAt || '' })) });
      if (p === '/api/admin/invite' && req.method === 'POST') {
        const b = await jbody();
        const days = Math.min(30, Math.max(1, Math.round(Number(b.days) || 7)));
        const code = rnd(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const inv = { id: rnd(6).toString('hex'), hash: sha(code), name: clip(b.name, 80), note: clip(b.note, 120), by: me.username, created: new Date().toISOString(), expires: now() + days * 864e5 };
        if (b.share && Array.isArray(b.share.files) && b.share.files.length) {
          const files = b.share.files.filter(f => { const c = validFile(f) && this.company(f); return c && c.owner === me.username; }).slice(0, 200);
          if (files.length) inv.share = { files, role: b.share.role === 'view' ? 'view' : 'edit' };
        }
        this.saveInvite(inv); this.log(me.username, 'created an invite for', inv.name || '(no name)');
        return json(200, { id: inv.id, code, expires: inv.expires, publicUrl: '', tailscaleInvite: '', mailFrom: C.mail && C.mail.user ? C.mail.user : '' });
      }
      if (p === '/api/admin/mail' && req.method === 'POST') {
        const b = await jbody();
        if (b.off) { delete C.mail; this.setCfg(C); return json(200, { ok: true }); }
        const user = String(b.email || '').trim(), pass = String(b.password || '').replace(/\s+/g, '');
        if (!validEmail(user)) return json(400, { error: 'Type the full email address, like you@gmail.com.' });
        const gmail = /@(gmail|googlemail)\.com$/i.test(user);
        const host = String(b.host || (gmail ? 'smtp.gmail.com' : '')).trim(), port = Number(b.port || 465);
        if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) return json(400, { error: 'For an email address that isn\'t Gmail, also type its outgoing (SMTP) server, for example smtp.office365.com.' });
        const mail = { user, from: user, host, port, pass: pass || (C.mail && C.mail.user === user ? C.mail.pass : '') };
        if (!mail.pass) return json(400, { error: 'Type the app password.' });
        try { await sendMail(mail, { to: user, fromName: 'Ledger Desk', subject: 'Ledger Desk can send email now', text: 'This is a test from Ledger Desk on trivedipos.com. Invites you send from the Logins screen will come from this address.\n' }); }
        catch (e) { return json(400, { error: e.message }); }
        C.mail = mail; this.setCfg(C); this.log(me.username, 'set up invite email from', user);
        return json(200, { ok: true });
      }
      if (p === '/api/admin/invite/email' && req.method === 'POST') {
        const b = await jbody();
        if (!C.mail || !C.mail.user) return json(400, { error: 'Set up email sending first (Logins › Email for invites).' });
        const to = String(b.to || '').trim(); if (!validEmail(to)) return json(400, { error: 'That email address doesn\'t look right.' });
        const r = this.one('SELECT data FROM invites WHERE id=?', String(b.id || '')); const inv = r && JSON.parse(r.data);
        if (!inv || invStatus(inv) !== 'waiting') return json(400, { error: 'That invite can\'t be used any more.' });
        const text = String(b.text || '').slice(0, 5000); if (text.indexOf('/invite?code=') < 0) return json(400, { error: 'Bad invite message' });
        try { await sendMail(C.mail, { to, fromName: (me.name || me.username) + ' (Ledger Desk)', subject: clip(b.subject, 150) || 'Your Ledger Desk invite', text }); }
        catch (e) { return json(502, { error: 'The email was not sent: ' + e.message }); }
        inv.sentTo = to; inv.sentAt = new Date().toISOString(); this.saveInvite(inv);
        return json(200, { ok: true });
      }
      if (p === '/api/admin/invite/cancel' && req.method === 'POST') {
        const b = await jbody(); const r = this.one('SELECT data FROM invites WHERE id=?', String(b.id || '')); if (!r) return json(404, { error: 'No such invite' });
        const inv = JSON.parse(r.data); inv.revoked = true; this.saveInvite(inv); return json(200, { ok: true });
      }
      if (p === '/api/admin/settings' && req.method === 'POST') { const b = await jbody(); if (typeof b.require2fa === 'boolean') C.require2fa = b.require2fa; this.setCfg(C); return json(200, { ok: true }); }
      if (p === '/api/admin/ai-key' && req.method === 'POST') {   // a new key for the AI PC (shown once)
        const key = rnd(32).toString('hex'); C.aiKeyHash = sha(key); this.setCfg(C);
        for (const w of this.ctx.getWebSockets('ai')) { try { w.close(4001, 'New AI PC key made'); } catch (e) { /* gone */ } }
        this.log(me.username, 'made a new AI PC key'); return json(200, { key });
      }
      if (p === '/api/admin/log') return json(200, { lines: this.rows('SELECT at, line FROM log ORDER BY id DESC LIMIT 300') });
      const b = req.method === 'POST' ? await jbody() : {};
      const u = this.findUser(b.username); if (!u) return json(404, { error: 'No such login' });
      if (p === '/api/admin/2fa-reset' && req.method === 'POST') { delete u.tfa; this.saveUser(u); return json(200, { ok: true }); }
      if (p === '/api/admin/reset' && req.method === 'POST') {
        if (u.username === me.username) return json(400, { error: 'Change your own password with "Change password" instead.' });
        const bad = pwProblem(b.auth); if (bad) return json(400, { error: bad });
        this.setPw(u, b.auth); u.mustChange = true; u.needRecovery = true; this.saveUser(u); this.dropSessionsOf(u.username);
        return json(200, { ok: true });
      }
      if (p === '/api/admin/disable' && req.method === 'POST') {
        if (u.username === me.username) return json(400, { error: 'You can\'t turn off your own login.' });
        u.disabled = !!b.disabled; this.saveUser(u); if (u.disabled) this.dropSessionsOf(u.username);
        return json(200, { ok: true });
      }
    }
    return json(404, { error: 'Not found' });
  }
}
