// Ledger Desk Server: runs Ledger Desk on this PC so other people can sign in from their own PCs.
// Every login has its own companies. The AI runs on this PC through Ollama; books never leave this PC.
// Started by "Ledger Desk Server.exe" (the Electron runtime in plain Node mode) with: server.js --data "<folder>"
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
const { sendMail, validEmail } = require('./mail');

const VERSION = '2.0.0';
const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const DATA = path.resolve(arg('data') || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Documents', 'Ledger Desk Server'));
const APP = path.resolve(arg('app') || path.join(__dirname, '..', 'app'));
fs.mkdirSync(path.join(DATA, 'Users'), { recursive: true });

// ---------------- small helpers ----------------
function readJSON(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return dflt; } }
function writeAtomic(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, p); }
const now = () => Date.now();
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(path.join(DATA, 'server.log'), line + '\n'); } catch (e) {}
}

// ---------------- settings (Documents\Ledger Desk Server\config.json) ----------------
const CONFIG_PATH = path.join(DATA, 'config.json');
const DEFAULTS = {
  port: 8730,
  // 127.0.0.1 = only this PC. Friends reach it through "tailscale serve" (see READ ME). Never needs a router port.
  listen: '127.0.0.1',
  ollama: 'http://127.0.0.1:11434',
  textModel: 'qwen2.5:7b',
  visionModel: 'qwen2.5vl:7b',
  aiEnabled: true,
  backupDays: 30,
  extraBackupFolder: '',
  // Set by "3 Turn on remote access.cmd": the address friends use (put into invite links)
  publicUrl: '',
  // Optional reusable Tailscale share link, added to invite messages (set on the Logins screen)
  tailscaleInvite: '',
  // Email used to send invites (set on the Logins screen). For Gmail: an app password, not the normal password.
  mail: null,
  // Optional Google Gemini (paid API key) for people who choose it in AI Assistant: { key, model, forAll }
  gemini: null
};
let CFG = Object.assign({}, DEFAULTS, readJSON(CONFIG_PATH, {}));
if (!fs.existsSync(CONFIG_PATH)) writeAtomic(CONFIG_PATH, JSON.stringify(CFG, null, 2));

// ---------------- users and sessions ----------------
const USERS_PATH = path.join(DATA, 'users.json');
const INV_PATH = path.join(DATA, 'invites.json');
let INV = readJSON(INV_PATH, { invites: [] });
const saveInv = () => writeAtomic(INV_PATH, JSON.stringify(INV, null, 1));
// Invites: the owner makes a link; only someone with that link can create an account. One use each, and it expires.
const invStatus = i => i.usedBy ? 'used' : i.revoked ? 'cancelled' : i.expires < Date.now() ? 'expired' : 'waiting';
function findInvite(code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(code)) return null;
  const h = crypto.createHash('sha256').update(code).digest('hex');
  return INV.invites.find(i => i.hash === h) || null;
}
function reloadConfig() { CFG = Object.assign({}, DEFAULTS, readJSON(CONFIG_PATH, {})); }
const SESS_PATH = path.join(DATA, 'sessions.json');
let USERS = readJSON(USERS_PATH, { users: [] });
let SESS = readJSON(SESS_PATH, {});
const saveUsers = () => writeAtomic(USERS_PATH, JSON.stringify(USERS, null, 1));
let sessTimer = null;
const saveSess = () => { clearTimeout(sessTimer); sessTimer = setTimeout(() => writeAtomic(SESS_PATH, JSON.stringify(SESS)), 300); };
const SESSION_DAYS = 30;
const normUser = u => String(u || '').trim().toLowerCase();
const validUser = u => /^[a-z0-9][a-z0-9._-]{1,31}$/.test(u);
const findUser = u => USERS.users.find(x => x.username === normUser(u));
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex'); }
function setPw(user, pw) { user.salt = crypto.randomBytes(16).toString('hex'); user.hash = hashPw(pw, user.salt); }
function setRec(user, recAuth) { user.recSalt = crypto.randomBytes(16).toString('hex'); user.recHash = hashPw(recAuth, user.recSalt); }
function checkRec(user, recAuth) {
  if (!user || !user.recHash) { hashPw(recAuth, '00'.repeat(16)); return false; }
  const a = Buffer.from(hashPw(recAuth, user.recSalt), 'hex'), b = Buffer.from(user.recHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkPw(user, pw) {
  if (!user || !user.hash) { hashPw(pw, '00'.repeat(16)); return false; } // same time either way
  const a = Buffer.from(hashPw(pw, user.salt), 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// The browser never sends the password itself, only a value derived from it (see app/vault.js).
const pwProblem = a => (/^[A-Za-z0-9+/]{43}=$/.test(String(a || '')) ? '' : 'Bad sign-in data. Reload the page and try again.');
// A person's locked key: wrapped with their password (pw) and with their recovery code (rec). The server can't unwrap either.
function validWrap(w) { return w && typeof w === 'object' && ['salt', 'iv', 'ct'].every(k => typeof w[k] === 'string' && /^[A-Za-z0-9+/=]{8,200}$/.test(w[k])) && Number.isInteger(w.iter) && w.iter >= 100000 && w.iter <= 5000000; }
const validVault = v => v && validWrap(v.pw) && validWrap(v.rec);
const cleanWrap = w => ({ salt: w.salt, iter: w.iter, iv: w.iv, ct: w.ct });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function newSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  SESS[sha(token)] = { user: username, exp: now() + SESSION_DAYS * 864e5 };
  saveSess();
  return token;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)ld_s=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const k = sha(m[1]), s = SESS[k];
  if (!s || s.exp < now()) { if (s) { delete SESS[k]; saveSess(); } return null; }
  const u = findUser(s.user);
  if (!u || u.disabled) return null;
  return { user: u, key: k };
}
function dropSessionsOf(username, exceptKey) { Object.keys(SESS).forEach(k => { if (SESS[k].user === username && k !== exceptKey) delete SESS[k]; }); saveSess(); }
setInterval(() => { let n = 0; Object.keys(SESS).forEach(k => { if (SESS[k].exp < now()) { delete SESS[k]; n++; } }); if (n) saveSess(); }, 3600e3);

// Slow down password guessing: 5 wrong tries locks that name for 15 minutes; 30 wrong tries in 15 minutes locks all sign-ins briefly.
const fails = {}; let globalFails = [];
function lockedFor(u) {
  const f = fails[u]; globalFails = globalFails.filter(t => t > now() - 15 * 60e3);
  if (globalFails.length >= 30) return 'Too many wrong passwords. Try again in a few minutes.';
  if (f && f.until > now()) return 'Too many wrong passwords for this name. Try again in ' + Math.ceil((f.until - now()) / 60e3) + ' minutes.';
  return '';
}
function noteFail(u) {
  globalFails.push(now());
  const f = fails[u] = fails[u] || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) { f.until = now() + 15 * 60e3; f.n = 0; }
}
// Per device (IP address) too: 20 wrong passwords or codes in 15 minutes blocks that address for 15 minutes.
// Behind Cloudflare or Tailscale the real address comes in a header from the local connector.
const ipFails = {};
function clientIp(req) {
  const local = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
  return (local && (req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress || '?';
}
function ipLocked(ip) { const f = ipFails[ip]; if (!f) return ''; f.t = f.t.filter(t => t > now() - 15 * 60e3); return f.t.length >= 20 ? 'Too many wrong tries from this device. Try again in 15 minutes.' : ''; }
function noteIpFail(ip) { (ipFails[ip] = ipFails[ip] || { t: [] }).t.push(now()); }
setInterval(() => { Object.keys(ipFails).forEach(ip => { ipFails[ip].t = ipFails[ip].t.filter(t => t > now() - 15 * 60e3); if (!ipFails[ip].t.length) delete ipFails[ip]; }); }, 600e3);

// ---------------- two-step sign-in ----------------
// After the password: a 6-digit code from email or an authenticator app. A device can be trusted for 30 days.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = buf => { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; };
const b32dec = str => { let bits = 0, val = 0; const out = []; for (const c of str.replace(/[^A-Z2-7]/gi, '').toUpperCase()) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
function totp(secret, step) {
  const key = b32dec(secret), msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(step / 0x100000000), 0); msg.writeUInt32BE(step >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const totpOk = (secret, code) => { const st = Math.floor(Date.now() / 30000); return [-1, 0, 1].some(d => crypto.timingSafeEqual(Buffer.from(totp(secret, st + d)), Buffer.from(String(code).padStart(6, '0').slice(0, 6)))); };
const maskEmail = e => String(e || '').replace(/^(.)(.*)(.@.*)$/, (m, a, b, c) => a + '•'.repeat(Math.min(6, b.length)) + c);
const TICKETS = {}, SETUP = {}; // SETUP: codes and secrets while someone is turning two-step on (memory only)
setInterval(() => { Object.keys(TICKETS).forEach(k => { if (TICKETS[k].exp < now()) delete TICKETS[k]; }); }, 60e3);
const tfaRequired = u => !!(u.tfa && u.tfa.method) || !!CFG.require2fa;
const trustedCookie = (token, maxAgeSec) => 'ld_t=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSec;
function isTrusted(req, u) {
  const m = /(?:^|;\s*)ld_t=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!m || !u.tfa || !u.tfa.trusted) return false;
  const h = sha(m[1]); u.tfa.trusted = u.tfa.trusted.filter(t => t.exp > now()); return u.tfa.trusted.some(t => t.h === h);
}
async function sendCode(t, u, to) {
  if (!CFG.mail || !CFG.mail.user) throw httpErr(400, 'Ledger Desk can\'t send email yet. Ask the owner to set up "Email for invites" on the Logins screen, or use an authenticator app.');
  if (t.sentAt && t.sentAt > now() - 30e3) throw httpErr(429, 'A code was just sent. Wait 30 seconds to ask for another.');
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  t.code = sha(code + '|' + t.id); t.sentAt = now(); t.codeExp = now() + 10 * 60e3; t.to = to;
  await sendMail(CFG.mail, { to, fromName: 'Ledger Desk', subject: 'Your Ledger Desk sign-in code: ' + code, text: 'Your Ledger Desk sign-in code is ' + code + '\n\nIt works for 10 minutes. If you didn\'t just try to sign in as ' + u.username + ', someone may know your password: change it in Ledger Desk.\n' });
}

// ---------------- company books ----------------
// Each company file lives in its owner's folder: Users\<owner>\Companies\c-<16 hex>.json (locked).
// Next to it, c-<id>.keys.json says who may open it: { owner, members: { <user>: { key, role, added } } }.
// "key" is the company's own key, locked for that person (only their browser can unlock it). The server can't use it.
const userDir = u => path.join(DATA, 'Users', u.username || u);
const coDir = u => path.join(userDir(u), 'Companies');
// File names are random (c-<16 hex>.json) so they don't reveal company names.
function validFile(f) { return typeof f === 'string' && /^c-[a-f0-9]{16}\.json$/.test(f); }
function validEnvelope(text) {
  let e; try { e = JSON.parse(text); } catch (x) { return null; }
  const box = b => b && typeof b.iv === 'string' && typeof b.ct === 'string' && /^[A-Za-z0-9+/=]+$/.test(b.ct) && /^[A-Za-z0-9+/=]{16}$/.test(b.iv);
  return e && e.ld === 'enc1' && box(e.hdr) && box(e.body) ? e : null;
}
const validKey = k => typeof k === 'string' && /^[A-Za-z0-9+/=]{100,1200}$/.test(k);
const ROLES = ['edit', 'view'];
const keysPathOf = p => p.replace(/\.json$/, '.keys.json');
function readKeys(p, owner) { const k = readJSON(keysPathOf(p), null) || {}; return { owner: k.owner || owner, members: k.members || {} }; }
const writeKeys = (p, k) => writeAtomic(keysPathOf(p), JSON.stringify(k, null, 1));
function versionOf(p) { try { const s = fs.statSync(p); return Math.round(s.mtimeMs) + '-' + s.size; } catch (e) { return null; } }
// Which owner has this company file? (small servers: a quick scan, cached)
const ownerCache = {};
function ownerOf(f) {
  if (ownerCache[f] && fs.existsSync(path.join(coDir(ownerCache[f]), f))) return ownerCache[f];
  for (const u of USERS.users) if (fs.existsSync(path.join(coDir(u), f))) { ownerCache[f] = u.username; return u.username; }
  return null;
}
// Can this person open this company? Returns where it is and what they may do.
function access(me, f, opts) {
  if (!validFile(f)) throw httpErr(400, 'Bad company file name');
  const owner = ownerOf(f);
  if (!owner) {
    if (opts && opts.allowNew) return { path: path.join(coDir(me), f), owner: me.username, role: 'owner', keys: { owner: me.username, members: {} }, isNew: true };
    throw httpErr(404, 'That company was not found.');
  }
  const p = path.join(coDir(owner), f), keys = readKeys(p, owner);
  if (owner === me.username) return { path: p, owner, role: 'owner', keys };
  const m = keys.members[me.username];
  if (!m || m.role === 'owner') throw httpErr(403, 'You don\'t have access to this company (any more).');
  if (!m.key) throw httpErr(403, 'This company is still being shared with you. It opens after ' + ((findUser(owner) || {}).name || owner) + ' next opens Ledger Desk.');
  return { path: p, owner, role: m.role, keys };
}
const listCache = {};
function entryFor(me, owner, f) {
  const p = path.join(coDir(owner), f), v = versionOf(p), kv = versionOf(keysPathOf(p)), ck = p;
  let base;
  if (listCache[ck] && listCache[ck].v === v && listCache[ck].kv === kv) base = listCache[ck];
  else {
    const d = readJSON(p, null);
    if (!d || d.ld !== 'enc1' || !d.hdr) return null;
    base = listCache[ck] = { v, kv, hdr: d.hdr, keys: readKeys(p, owner) };
  }
  const mine = base.keys.members[me.username];
  const ou = findUser(owner) || { name: owner };
  return { file: f, hdr: base.hdr, owner, ownerName: ou.name || owner, role: owner === me.username ? 'owner' : mine.role, key: mine ? mine.key : null, shared: Object.keys(base.keys.members).filter(n => n !== owner).length };
}
// Companies I own, plus companies others shared with me
function listCompanies(me) {
  const out = [];
  const own = d => { try { return fs.readdirSync(d).filter(validFile); } catch (e) { return []; } };
  own(coDir(me)).forEach(f => { const e = entryFor(me, me.username, f); if (e) out.push(e); });
  for (const u of USERS.users) {
    if (u.username === me.username) continue;
    own(coDir(u)).forEach(f => {
      const k = readJSON(keysPathOf(path.join(coDir(u), f)), null);
      if (k && k.members && k.members[me.username] && k.members[me.username].role !== 'owner') { const e = entryFor(me, u.username, f); if (e) { if (!e.key) e.hdr = null; out.push(e); } }
    });
  }
  return out;
}
const ownCount = u => { try { return fs.readdirSync(coDir(u)).filter(validFile).length; } catch (e) { return 0; } };
const settingsPath = u => path.join(userDir(u), 'settings.json');
function currentFile(u, list) {
  list = list || listCompanies(u); const want = (readJSON(settingsPath(u), {}) || {}).current;
  if (want && list.some(c => c.file === want)) return want;
  const mine = list.find(c => c.role === 'owner');
  return mine ? mine.file : list.length ? list[0].file : null;
}
function createCompany(u, file, text, key) {
  if (!validFile(file)) throw httpErr(400, 'Bad company file name');
  if (!validEnvelope(text)) throw httpErr(400, 'Only locked company files can be stored.');
  if (!validKey(key)) throw httpErr(400, 'Missing the company key. Reload the page and try again.');
  if (ownerOf(file)) throw httpErr(409, 'That company already exists');
  fs.mkdirSync(coDir(u), { recursive: true });
  const p = path.join(coDir(u), file);
  writeAtomic(p, text);
  writeKeys(p, { owner: u.username, members: { [u.username]: { key, role: 'owner', added: new Date().toISOString() } } });
  ownerCache[file] = u.username;
  return file;
}

// ---------------- backups: a copy of everyone's books each day, kept for 30 days ----------------
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else if (e.isFile() && !/\.tmp$/i.test(e.name)) fs.copyFileSync(s, d);
  }
}
function dailyBackup() {
  if (!USERS.users.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const targets = [path.join(DATA, 'Backups')];
  if (CFG.extraBackupFolder) targets.push(CFG.extraBackupFolder);
  for (const root of targets) {
    try {
      const dst = path.join(root, day);
      if (fs.existsSync(path.join(dst, 'done.txt'))) continue;
      copyDir(path.join(DATA, 'Users'), path.join(dst, 'Users'));
      fs.copyFileSync(USERS_PATH, path.join(dst, 'users.json'));
      fs.writeFileSync(path.join(dst, 'done.txt'), new Date().toString());
      log('backup saved to', dst);
      const keep = new Date(now() - CFG.backupDays * 864e5).toISOString().slice(0, 10);
      for (const d of fs.readdirSync(root)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < keep) fs.rmSync(path.join(root, d), { recursive: true, force: true });
    } catch (e) { log('backup to', root, 'failed:', e.message); }
  }
}

// ---------------- AI through Ollama (only on this PC) ----------------
function ollama(pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, CFG.ollama);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { let msg = text; try { msg = JSON.parse(text).error || text; } catch (e) {} return reject(new Error('Ollama: ' + msg)); }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('Ollama sent an unreadable answer')); }
      });
    });
    req.setTimeout(timeoutMs || 300e3, () => req.destroy(new Error('The AI took too long to answer.')));
    req.on('error', e => reject(e.code === 'ECONNREFUSED' ? new Error('The AI program (Ollama) is not running on the server PC.') : e));
    if (data) req.write(data);
    req.end();
  });
}
// One AI job at a time: the graphics card works faster on one thing than on several.
let aiChain = Promise.resolve(), aiWaiting = 0;
function aiJob(fn) { aiWaiting++; const p = aiChain.then(fn, fn); aiChain = p.catch(() => {}); return p.finally(() => { aiWaiting--; }); }
// ---------------- Google Gemini (optional, for people who turn it on) ----------------
const GEM = process.env.LD_GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/';
async function gemFetch(pathname, body, key, timeoutMs) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs || 120e3);
  try {
    const r = await fetch(GEM + pathname, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'x-goog-api-key': key }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
    if (!r.ok) { const m = (j && j.error && j.error.message) || text.slice(0, 200); const e = new Error('Gemini: ' + m); e.status = r.status; throw e; }
    return j;
  } catch (e) { if (e.name === 'AbortError') throw new Error('Gemini took too long to answer.'); throw e; } finally { clearTimeout(t); }
}
// Ollama-style JSON schema → Gemini's schema format
function gemSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const o = { type: String(s.type || 'string').toUpperCase() };
  if (s.properties) { o.properties = {}; for (const k of Object.keys(s.properties)) o.properties[k] = gemSchema(s.properties[k]); }
  if (s.items) o.items = gemSchema(s.items);
  if (Array.isArray(s.enum)) { const en = s.enum.filter(x => x !== ''); if (en.length && en.length === s.enum.length) o.enum = en; }
  if (Array.isArray(s.required)) o.required = s.required;
  return o;
}
async function geminiJSON(messages, schema) {
  const g = CFG.gemini || {}; if (!g.key) throw new Error('Gemini is not set up.');
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }].concat((m.images || []).map(b64 => ({ inline_data: { mime_type: /^iVBOR/.test(b64) ? 'image/png' : 'image/jpeg', data: b64 } }))) }));
  const body = { contents, generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: gemSchema(schema) } };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  const r = await gemFetch('models/' + encodeURIComponent(g.model || 'gemini-flash-latest') + ':generateContent', body, g.key);
  const txt = ((((r.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('');
  if (!txt) throw new Error('Gemini sent an empty answer' + (r.promptFeedback && r.promptFeedback.blockReason ? ' (' + r.promptFeedback.blockReason + ')' : '') + '.');
  try { return JSON.parse(txt); } catch (e) { const m = /\{[\s\S]*\}/.exec(txt); if (m) return JSON.parse(m[0]); throw new Error('The AI answer was not in the expected format. Try again.'); }
}
async function gemModels(key) {
  const r = await gemFetch('models?pageSize=200', null, key, 20e3);
  return (r.models || []).filter(m => /^models\/gemini/.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent') && !/tts|image|live|embedding|aqa|audio|robotics|computer-use/i.test(m.name))
    .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }));
}
function pickModel(list) {
  const ver = id => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(id); return m ? Number(m[1]) : 0; };
  const score = m => (/flash/.test(m.id) ? 100 : 0) - (/lite/.test(m.id) ? 50 : 0) - (/preview|exp/.test(m.id) ? 5 : 0) + ver(m.id);
  return (list.slice().sort((a, b) => score(b) - score(a))[0] || {}).id || '';
}
const userAI = u => (readJSON(settingsPath(u), {}) || {}).ai || 'local';
const geminiAllowed = u => !!(CFG.gemini && CFG.gemini.key && CFG.gemini.model && (u.admin || CFG.gemini.forAll));
const useGemini = u => geminiAllowed(u) && userAI(u) === 'gemini';

async function chatJSON(model, messages, schema, numCtx, ctx) {
  if (ctx && ctx.gemini) {
    try { return await geminiJSON(messages, schema); }
    catch (e) { if (ctx.geminiOnly) throw e; log('Gemini failed, using this PC\'s AI instead:', e.message); ctx.fellBack = e.message; }
    // fall back to the PC's own AI, one job at a time
    return aiJob(() => chatJSON(model, messages, schema, numCtx));
  }
  const r = await ollama('/api/chat', { model, messages, stream: false, format: schema, options: { temperature: 0, num_ctx: numCtx || 8192 }, keep_alive: '10m' });
  const txt = (r.message && r.message.content) || '';
  try { return JSON.parse(txt); } catch (e) { const m = /\{[\s\S]*\}/.exec(txt); if (m) return JSON.parse(m[0]); throw new Error('The AI answer was not in the expected format. Try again.'); }
}
async function aiStatus() {
  if (!CFG.aiEnabled) return { ok: false, reason: 'AI is turned off in config.json.' };
  try {
    const t = await ollama('/api/tags', null, 4000);
    const have = (t.models || []).map(m => m.name);
    const has = n => have.some(h => h === n || h === n + ':latest');
    return { ok: true, textModel: CFG.textModel, visionModel: CFG.visionModel, hasText: has(CFG.textModel), hasVision: has(CFG.visionModel), busy: aiWaiting };
  } catch (e) { return { ok: false, reason: e.message }; }
}
// Same context size for every text request, so the model isn't reloaded between jobs (fits an 8 GB graphics card).
const TEXT_CTX = 24576;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

async function aiCategorize(body, ctx) {
  const cats = (body.categories || []).slice(0, 400).map(c => ({ name: clip(c.name, 80), type: clip(c.type, 12) })).filter(c => c.name);
  const txns = (body.txns || []).slice(0, 25).map(t => ({ id: clip(t.id, 40), date: clip(t.date, 10), payee: clip(t.payee, 120), memo: clip(t.memo, 160), amount: Number(t.amount) || 0, account: clip(t.account, 80), accountKind: clip(t.accountKind, 20), bankDeposit: !!t.bankDeposit }));
  if (!cats.length || !txns.length) throw httpErr(400, 'Nothing to categorize');
  const examples = (body.examples || []).slice(0, 120).map(e => clip(e.payee, 80) + ' → ' + clip(e.category, 80)).join('\n');
  const rules = (body.rules || []).slice(0, 150).map(r => '"' + clip(r.match, 60) + '"' + (r.sign === 'out' ? ' (money out)' : r.sign === 'in' ? ' (money in)' : '') + ' → ' + clip(r.category, 80)).join('\n');
  const notes = clip(body.notes, 3000);
  const names = cats.map(c => c.name);
  const sys = `You are a careful bookkeeper for a small US business${body.business ? ' (' + clip(body.business, 80) + ')' : ''}. For each bank or credit card transaction, pick the best category from the list. Use ONLY names from the list, spelled exactly.
How to read amounts: on a credit card, a negative amount is a charge and a positive amount is a payment or refund. On a bank account, negative is money out and positive is money in.
Rules you must follow:
- A deposit into a bank account (bankDeposit true) is NEVER income.
- Payments to a credit card or loan, and transfers between the owner's own accounts, go to that card, loan or bank account (or a transfers account), never to an expense.
- If the payee looks personal or you really cannot tell, use the closest category and set confidence "low".
- "high" only when the payee clearly matches the business's past choices, its rules, or an obvious merchant type. Otherwise "medium" or "low".
- reason: one short sentence a business owner understands (for example "Sam's Club is a warehouse store; your past Sam's Club charges are Hotel Supplies").`;
  const user = `CATEGORIES (name | type):\n${cats.map(c => c.name + ' | ' + c.type).join('\n')}\n\n` +
    (rules ? `THE OWNER'S BANK RULES (payee text → category):\n${rules}\n\n` : '') +
    (examples ? `HOW THIS BUSINESS CATEGORIZED PAST PAYEES:\n${examples}\n\n` : '') +
    (notes ? `OWNER'S NOTES:\n${notes}\n\n` : '') +
    `TRANSACTIONS TO CATEGORIZE (JSON):\n${JSON.stringify(txns)}\n\nAnswer with one result for every transaction id.`;
  const schema = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, category: { type: 'string', enum: names }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' } }, required: ['id', 'category', 'confidence', 'reason'] } } }, required: ['results'] };
  const out = await chatJSON(CFG.textModel, [{ role: 'system', content: sys }, { role: 'user', content: user }], schema, TEXT_CTX, ctx);
  const ids = new Set(txns.map(t => t.id));
  return { results: (out.results || []).filter(r => ids.has(r.id) && names.indexOf(r.category) > -1).map(r => ({ id: r.id, category: r.category, confidence: r.confidence, reason: clip(r.reason, 300) })) };
}
async function aiAsk(body, aiCtx) {
  const q = clip(body.question, 1000).trim();
  if (!q) throw httpErr(400, 'Type a question');
  const ctx = clip(body.context, 60000);
  const hist = (body.history || []).slice(-6).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: clip(h.content, 2000) }));
  const sys = `You answer questions about one company's books in Ledger Desk. Today is ${new Date().toISOString().slice(0, 10)}.
Use ONLY the figures in BOOKS DATA below. They were calculated by the app and are correct; copy them, do not recalculate unless you must add a few numbers.
If the answer is not in the data, say what is missing and which Ledger Desk screen would show it (Transactions, Reports, Chart of Accounts). Never guess numbers.
Money is US dollars. Credit card and loan balances are amounts owed. Keep answers short and plain: a direct answer first, then a few supporting lines. No tables wider than 4 columns.`;
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  const msgs = [{ role: 'system', content: sys + '\n\nBOOKS DATA:\n' + ctx }].concat(hist, [{ role: 'user', content: q }]);
  const out = await chatJSON(CFG.textModel, msgs, schema, TEXT_CTX, aiCtx);
  return { answer: clip(out.answer, 6000) };
}
async function aiCheck(body, ctx) {
  const img = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!img || img.length > 14e6 || !/^[A-Za-z0-9+/=\s]+$/.test(img.slice(0, 2000))) throw httpErr(400, 'Send a JPG or PNG picture of the check.');
  const schema = { type: 'object', properties: { payee: { type: 'string' }, amount: { type: 'number' }, date: { type: 'string' }, checkNumber: { type: 'string' }, memo: { type: 'string' }, payer: { type: 'string' } }, required: ['payee', 'amount', 'date', 'checkNumber', 'memo', 'payer'] };
  const prompt = 'This is a picture of a paper check (or a bank\'s check image). Read it. payee = the name after "Pay to the order of". amount = the dollar amount as a number. date = the date written on the check as YYYY-MM-DD. checkNumber = the check number (top right, or the number in the MICR line at the bottom). memo = the memo line. payer = the account holder printed at the top left. Use "" for anything you cannot read and 0 for an unreadable amount. Do not guess.';
  const out = await chatJSON(CFG.visionModel, [{ role: 'user', content: prompt, images: [img] }], schema, 8192, ctx);
  return { payee: clip(out.payee, 120), amount: Math.round((Number(out.amount) || 0) * 100) / 100, date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '', checkNumber: clip(String(out.checkNumber || '').replace(/[^0-9]/g, ''), 12), memo: clip(out.memo, 160), payer: clip(out.payer, 120) };
}

// "Teach my local AI": Gemini studies how a company was categorized and writes clear notes the PC's own AI reads every time.
async function aiTeach(body, ctx) {
  if (!ctx || !ctx.gemini) throw httpErr(400, 'Turn on Gemini in AI Assistant first.');
  ctx.geminiOnly = true;
  const hist = clip(body.history, 30000), notes = clip(body.notes, 3000), cats = (body.categories || []).slice(0, 300).map(c => clip(c, 80)).join(', ');
  const sys = `You are an expert US small-business bookkeeper. Write NOTES FOR A SMALLER AI that categorizes bank and credit card transactions for ${clip(body.company, 80) || 'this business'} (${clip(body.business, 120) || 'a small business'}).
Study how the owner actually categorized past payees. Write short, concrete rules the smaller AI can follow, for example: "SAMS CLUB, WALMART, COSTCO → Hotel Supplies". Group similar merchants. Include rules about card payments (transfers, never income or owner's draw), bank deposits (never income), loan payments, and anything that looks like a pattern. Use ONLY category names from the list. Keep everything the owner already wrote unless it conflicts with what the history shows. Plain text, one rule per line, at most 2500 characters.`;
  const out = await chatJSON(CFG.textModel, [{ role: 'system', content: sys }, { role: 'user', content: 'CATEGORIES: ' + cats + '\n\nOWNER\'S CURRENT NOTES:\n' + (notes || '(none)') + '\n\nHOW PAYEES WERE CATEGORIZED (payee | money in/out | category | times):\n' + hist }], { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] }, TEXT_CTX, ctx);
  return { notes: clip(out.notes, 2900) };
}
// "Explain my numbers": the app sends figures it already calculated; the AI only puts them into words.
async function aiExplain(body, ctx) {
  const facts = clip(body.facts, 40000);
  if (!facts) throw httpErr(400, 'Nothing to explain');
  const sys = `You write a short monthly money summary for the owner of ${clip(body.company, 80) || 'a small business'} (${clip(body.business, 120) || 'small business'}).
Use ONLY the figures in FACTS. They are correct; copy them exactly and never invent or recalculate numbers.
Bank deposits are not income in these books; the owner records income separately, so income may be missing or low. If income is zero, say income hasn't been recorded yet instead of calling it a loss.
Say WHAT changed (with the amounts and the payees in FACTS). Do NOT guess WHY (no 'likely due to', no 'possibly'); if a change is large, put it under watch as something to check. Write for a busy owner in plain English. headline: one sentence. points: 3 to 6 short sentences about what changed and why (name categories and payees). watch: 0 to 3 short things worth checking.`;
  const schema = { type: 'object', properties: { headline: { type: 'string' }, points: { type: 'array', items: { type: 'string' } }, watch: { type: 'array', items: { type: 'string' } } }, required: ['headline', 'points', 'watch'] };
  const out = await chatJSON(CFG.textModel, [{ role: 'system', content: sys }, { role: 'user', content: 'FACTS:\n' + facts }], schema, TEXT_CTX, ctx);
  // small models like to guess causes; keep only what the figures show
  const noGuess = x => clip(String(x || '').replace(/,?\s*(which )?(is |are |was |were )?(likely|possibly|probably|perhaps|could be|may be|might be|which could|which may|suggesting|indicating)\b[^.]*/gi, '').replace(/\s+\./g, '.').trim(), 400);
  return { headline: noGuess(out.headline), points: (out.points || []).slice(0, 6).map(noGuess).filter(Boolean), watch: (out.watch || []).slice(0, 3).map(x => clip(x, 300)) };
}
// "Spot problems": the AI looks for charges that don't fit the business. Exact checks (duplicates, price jumps) are done by the app.
async function aiReview(body, ctx) {
  const txns = (body.txns || []).slice(0, 80).map(t => ({ id: clip(t.id, 40), date: clip(t.date, 10), payee: clip(t.payee, 100), amount: Number(t.amount) || 0, category: clip(t.category, 60), account: clip(t.account, 60) }));
  if (!txns.length) return { flags: [] };
  const sys = `You review a small business's recent spending for anything worth a second look. Business: ${clip(body.company, 80)}. ${clip(body.notes, 2500)}
Flag ONLY transactions that look wrong: a personal-looking purchase in a business category, a category that doesn't fit the payee, an unusual one-off for this kind of business, or a fee/penalty/interest that may be avoidable. Do NOT flag normal supplies, utilities, payroll, taxes, loan payments or transfers.
Return at most 10 flags. reason: one short sentence. severity: "high" or "medium". If nothing looks wrong, return an empty list.`;
  const schema = { type: 'object', properties: { flags: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium'] } }, required: ['id', 'reason', 'severity'] } } }, required: ['flags'] };
  const out = await chatJSON(CFG.textModel, [{ role: 'system', content: sys }, { role: 'user', content: 'TRANSACTIONS (JSON):\n' + JSON.stringify(txns) }], schema, TEXT_CTX, ctx);
  const ids = new Set(txns.map(t => t.id));
  return { flags: (out.flags || []).filter(f => ids.has(f.id)).slice(0, 10).map(f => ({ id: f.id, reason: clip(f.reason, 300), severity: f.severity === 'high' ? 'high' : 'medium' })) };
}
// Receipts, bills, invoices and checks: read the picture.
async function aiDocument(body, ctx) {
  const img = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!img || img.length > 14e6 || !/^[A-Za-z0-9+/=\s]+$/.test(img.slice(0, 2000))) throw httpErr(400, 'Send a JPG or PNG picture.');
  const cats = (body.categories || []).slice(0, 200).map(c => clip(c, 80)).filter(Boolean);
  const schema = { type: 'object', properties: {
    kind: { type: 'string', enum: ['receipt', 'bill', 'invoice', 'check', 'other'] }, vendor: { type: 'string' }, date: { type: 'string' }, total: { type: 'number' }, tax: { type: 'number' },
    number: { type: 'string' }, memo: { type: 'string' }, payer: { type: 'string' },
    items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, amount: { type: 'number' } }, required: ['description', 'amount'] } },
    category: cats.length ? { type: 'string', enum: cats.concat(['']) } : { type: 'string' } }, required: ['kind', 'vendor', 'date', 'total', 'tax', 'number', 'memo', 'payer', 'items', 'category'] };
  const prompt = 'Read this business document (a store receipt, a utility or vendor bill, an invoice, or a paper check). kind: which one it is. vendor: the business that was paid (for a check: the name after "Pay to the order of"). date: the purchase/bill/check date as YYYY-MM-DD. total: the final amount paid or due, as a number. tax: sales tax as a number (0 if none). number: the invoice, account or check number. memo: anything short worth keeping (for a bill: the service period). payer: who paid (the account holder on a check, or "" ). items: up to 8 main lines with amounts. category: the best match from this list, or "" if unsure: ' + cats.join(', ') + '. Use "" or 0 for anything you cannot read. Do not guess.';
  const out = await chatJSON(CFG.visionModel, [{ role: 'user', content: prompt, images: [img] }], schema, 8192, ctx);
  return { kind: out.kind || 'other', vendor: clip(out.vendor, 120), date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '', total: Math.round((Number(out.total) || 0) * 100) / 100, tax: Math.round((Number(out.tax) || 0) * 100) / 100,
    number: clip(String(out.number || ''), 40), memo: clip(out.memo, 160), payer: clip(out.payer, 120), items: (out.items || []).slice(0, 8).map(i => ({ description: clip(i.description, 80), amount: Math.round((Number(i.amount) || 0) * 100) / 100 })),
    category: cats.includes(out.category) ? out.category : '' };
}

// ---------------- HTTP plumbing ----------------
function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store'
};
function send(res, code, body, headers) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({}, SEC_HEADERS, { 'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' }, headers || {}));
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpErr(413, 'Too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['x-body-encoding'] === 'gzip') { try { buf = zlib.gunzipSync(buf, { maxOutputLength: 150e6 }); } catch (e) { return reject(httpErr(400, 'Bad compressed data')); } }
      resolve(buf.toString('utf8'));
    });
    req.on('error', reject);
  });
}
async function readJSONBody(req, limit) { const t = await readBody(req, limit || 2e6); try { return JSON.parse(t || '{}'); } catch (e) { throw httpErr(400, 'Bad request'); } }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const PUBLIC = new Set(['login.html', 'login.js', 'vault.js', 'style.css', 'icon.png']);
function serveStatic(res, rel) {
  const p = path.join(APP, rel);
  if (!p.startsWith(APP + path.sep) || !TYPES[path.extname(p)]) return send(res, 404, 'Not found');
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, Object.assign({}, SEC_HEADERS, { 'Content-Type': TYPES[path.extname(p)] }));
    res.end(buf);
  });
}
const cookie = (token, maxAgeSec) => 'ld_s=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSec;
const publicUser = u => ({ username: u.username, name: u.name || u.username, admin: !!u.admin, disabled: !!u.disabled, created: u.created || '', lastLogin: u.lastLogin || '', mustChange: !!u.mustChange });

// ---------------- routes ----------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = k => url.searchParams.get(k);

  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const s = sessionUser(req);
    if (p === '/' || p === '/index.html') return s ? serveStatic(res, 'index.html') : send(res, 302, '', { Location: '/login' });
    if (p === '/login' || p === '/invite') return serveStatic(res, 'login.html');
    const rel = decodeURIComponent(p.slice(1));
    if (!s && !PUBLIC.has(rel)) return send(res, 401, 'Sign in first');
    return serveStatic(res, rel);
  }
  if (!p.startsWith('/api/')) return send(res, 404, 'Not found');
  // Every API POST must carry this header. Other websites can't add it, so they can't act for a signed-in user.
  if (req.method === 'POST' && req.headers['x-ld'] !== '1') return send(res, 403, { error: 'Blocked' });

  // ----- sign-in (no session needed) -----
  if (p === '/api/setup-needed') return send(res, 200, { needed: USERS.users.length === 0 });
  if (p === '/api/invite/check' && req.method === 'POST') {
    const b = await readJSONBody(req);
    const locked = lockedFor('#invite'); if (locked) return send(res, 429, { error: locked });
    const inv = findInvite(b.code);
    if (!inv) { noteFail('#invite'); return send(res, 404, { error: 'This invite link is not valid. Ask the owner for a new one.' }); }
    const st = invStatus(inv);
    if (st !== 'waiting') return send(res, 410, { error: st === 'used' ? 'This invite was already used. Sign in instead, or ask the owner for a new invite.' : st === 'expired' ? 'This invite has expired. Ask the owner for a new one.' : 'This invite was cancelled.' });
    return send(res, 200, { ok: true, name: inv.name || '', expires: inv.expires });
  }
  if (p === '/api/invite/accept' && req.method === 'POST') {
    const b = await readJSONBody(req);
    const locked = lockedFor('#invite'); if (locked) return send(res, 429, { error: locked });
    const inv = findInvite(b.code);
    if (!inv || invStatus(inv) !== 'waiting') { noteFail('#invite'); return send(res, 410, { error: 'This invite link can\'t be used. Ask the owner for a new one.' }); }
    const username = normUser(b.username);
    if (!validUser(username)) return send(res, 400, { error: 'Use 2–32 letters or numbers for the user name (dots, dashes and underscores are OK).' });
    if (findUser(username)) return send(res, 400, { error: 'That user name is taken. Pick another one.' });
    const bad = pwProblem(b.auth); if (bad) return send(res, 400, { error: bad });
    if (!validVault(b.vault) || pwProblem(b.recAuth)) return send(res, 400, { error: 'Bad key data. Reload the page and try again.' });
    const u = { username, name: clip(b.name, 80) || inv.name || username, admin: false, created: new Date().toISOString(), lastLogin: new Date().toISOString(), invitedBy: inv.by, vault: { pw: cleanWrap(b.vault.pw), rec: cleanWrap(b.vault.rec) } };
    setPw(u, b.auth); setRec(u, b.recAuth); USERS.users.push(u); saveUsers();
    inv.usedBy = username; inv.usedAt = new Date().toISOString(); saveInv();
    // Companies the inviter chose to share: marked as waiting. The inviter's browser hands over the keys the next time it's open.
    if (inv.share && Array.isArray(inv.share.files)) for (const f of inv.share.files) {
      if (!validFile(f) || ownerOf(f) !== inv.by) continue;
      const cp = path.join(coDir(inv.by), f), k = readKeys(cp, inv.by);
      if (!k.members[username]) { k.members[username] = { key: null, role: inv.share.role === 'view' ? 'view' : 'edit', pending: true, added: new Date().toISOString(), by: inv.by }; writeKeys(cp, k); }
    }
    fs.mkdirSync(coDir(u), { recursive: true });
    log('account created from invite:', username);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(newSession(username), SESSION_DAYS * 86400) });
  }
  if (p === '/api/setup' && req.method === 'POST') {
    if (USERS.users.length) return send(res, 403, { error: 'Already set up' });
    const b = await readJSONBody(req);
    const username = normUser(b.username);
    if (!validUser(username)) return send(res, 400, { error: 'Use 2–32 letters or numbers for the user name (dots, dashes and underscores are OK).' });
    const bad = pwProblem(b.auth); if (bad) return send(res, 400, { error: bad });
    if (!validVault(b.vault) || pwProblem(b.recAuth)) return send(res, 400, { error: 'Bad key data. Reload the page and try again.' });
    const u = { username, name: clip(b.name, 80) || username, admin: true, created: new Date().toISOString(), lastLogin: new Date().toISOString(), vault: { pw: cleanWrap(b.vault.pw), rec: cleanWrap(b.vault.rec) } };
    setPw(u, b.auth); setRec(u, b.recAuth); USERS.users.push(u); saveUsers();
    log('first admin created:', username);
    setTimeout(dailyBackup, 1000);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(newSession(username), SESSION_DAYS * 86400) });
  }
  // Forgot password: the person proves they have their recovery code, gets their key locked with it, unlocks it in the browser,
  // and locks it again with a new password. Works for everyone, the owner included. No one else is involved.
  if ((p === '/api/recover/check' || p === '/api/recover') && req.method === 'POST') {
    const b = await readJSONBody(req);
    const username = normUser(b.username);
    const locked = lockedFor(username); if (locked) return send(res, 429, { error: locked });
    const u = findUser(username);
    if (!u || u.disabled || pwProblem(b.recAuth) || !checkRec(u, b.recAuth)) { noteFail(username); log('recovery failed:', username); return send(res, 401, { error: u && u.disabled ? 'This login is turned off. Ask the owner.' : 'That user name and recovery code don\'t match.' }); }
    if (p === '/api/recover/check') return send(res, 200, { rec: u.vault.rec });
    const bad = pwProblem(b.auth); if (bad) return send(res, 400, { error: bad });
    if (!validWrap(b.vaultPw)) return send(res, 400, { error: 'Bad key data.' });
    delete fails[username];
    setPw(u, b.auth); u.vault = { pw: cleanWrap(b.vaultPw), rec: u.vault.rec };
    delete u.mustChange; delete u.needRecovery; u.lastLogin = new Date().toISOString(); saveUsers(); dropSessionsOf(u.username);
    log(username, 'reset their password with the recovery code');
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(newSession(username), SESSION_DAYS * 86400) });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const b = await readJSONBody(req);
    const username = normUser(b.username);
    const locked = lockedFor(username); if (locked) return send(res, 429, { error: locked });
    const u = findUser(username);
    const ip = clientIp(req), ipl = ipLocked(ip); if (ipl) return send(res, 429, { error: ipl });
    if (!checkPw(u, b.auth) || u.disabled) { noteFail(username); noteIpFail(ip); log('sign-in failed:', username, 'from', ip); return send(res, 401, { error: u && u.disabled ? 'This login is turned off. Ask the owner.' : 'Wrong user name or password.' }); }
    delete fails[username];
    if (tfaRequired(u) && !isTrusted(req, u)) {
      const id = crypto.randomBytes(24).toString('hex'), t = TICKETS[id] = { id, user: u.username, exp: now() + 15 * 60e3, tries: 0 };
      const method = u.tfa && u.tfa.method === 'app' ? 'app' : u.tfa && u.tfa.method === 'email' && u.email ? 'email' : u.email ? 'email' : 'setup';
      t.method = method;
      if (method === 'email') { try { await sendCode(t, u, u.email); } catch (e) { if (u.tfa && u.tfa.method === 'app') {} else return send(res, e.code || 502, { error: e.message }); } }
      log(username, 'password ok, waiting for the two-step code (' + method + ')');
      return send(res, 200, { need2fa: method, ticket: id, to: method === 'email' ? maskEmail(u.email) : '', canEmail: !!u.email });
    }
    u.lastLogin = new Date().toISOString(); saveUsers();
    log('signed in:', username);
    return send(res, 200, { ok: true, vault: u.vault, needRecovery: !!u.needRecovery }, { 'Set-Cookie': cookie(newSession(username), SESSION_DAYS * 86400) });
  }

  if (p.startsWith('/api/login/2fa') && req.method === 'POST') {
    const b = await readJSONBody(req), ip = clientIp(req), ipl = ipLocked(ip); if (ipl) return send(res, 429, { error: ipl });
    const t = TICKETS[String(b.ticket || '')], u = t && findUser(t.user);
    if (!t || t.exp < now() || !u || u.disabled) return send(res, 401, { error: 'That took too long. Sign in again.' });
    if (p === '/api/login/2fa/email') { // send (or resend) a code by email, also to a new address when setting it up
      const to = t.method === 'setup' ? String(b.email || '').trim() : u.email;
      if (!validEmail(to)) return send(res, 400, { error: 'Type your full email address.' });
      try { await sendCode(t, u, to); } catch (e) { return send(res, e.code || 502, { error: e.message }); }
      if (t.method !== 'setup') t.method = 'email';
      return send(res, 200, { ok: true, to: maskEmail(to) });
    }
    if (p === '/api/login/2fa') {
      const code = String(b.code || '').replace(/\D/g, '');
      let ok = false;
      if (t.method === 'app' && u.tfa && u.tfa.secret) ok = code.length === 6 && totpOk(u.tfa.secret, code);
      if (!ok && t.code && t.codeExp > now()) ok = code.length === 6 && sha(code + '|' + t.id) === t.code;
      if (!ok) { t.tries++; noteIpFail(ip); if (t.tries >= 5) delete TICKETS[t.id]; log('two-step code wrong:', u.username, 'from', ip); return send(res, 401, { error: t.tries >= 5 ? 'Too many wrong codes. Sign in again.' : 'That code isn\'t right.' }); }
      delete TICKETS[t.id];
      if (t.method === 'setup') { u.email = t.to; u.tfa = { method: 'email', trusted: [] }; }
      u.tfa = u.tfa || { method: 'email', trusted: [] }; u.tfa.trusted = (u.tfa.trusted || []).filter(x => x.exp > now());
      const heads = ['ld_s=' + newSession(u.username) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_DAYS * 86400];
      if (b.trust) { const tok = crypto.randomBytes(32).toString('hex'); u.tfa.trusted.push({ h: sha(tok), exp: now() + 30 * 864e5, at: new Date().toISOString() }); u.tfa.trusted = u.tfa.trusted.slice(-10); heads.push(trustedCookie(tok, 30 * 86400)); }
      u.lastLogin = new Date().toISOString(); saveUsers();
      log('signed in (two-step):', u.username);
      return send(res, 200, { ok: true, vault: u.vault, needRecovery: !!u.needRecovery }, { 'Set-Cookie': heads });
    }
    return send(res, 404, { error: 'Not found' });
  }

  const s = sessionUser(req);
  if (!s) return send(res, 401, { error: 'Please sign in again.' });
  const me = s.user;

  if (p === '/api/logout' && req.method === 'POST') { delete SESS[s.key]; saveSess(); return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }
  if (p === '/api/me') return send(res, 200, Object.assign(publicUser(me), { version: VERSION, vault: me.vault, needRecovery: !!me.needRecovery, pub: me.pub || null, priv: me.priv || null }));
  // Change password: the browser re-locks the same key with the new password, so the books stay readable.
  if (p === '/api/password' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (!checkPw(me, b.old)) return send(res, 400, { error: 'Your current password is not right.' });
    const bad = pwProblem(b.auth); if (bad) return send(res, 400, { error: bad });
    if (!validWrap(b.vaultPw)) return send(res, 400, { error: 'Bad key data. Reload the page and try again.' });
    if (b.vaultRec && !validWrap(b.vaultRec)) return send(res, 400, { error: 'Bad key data.' });
    setPw(me, b.auth);
    me.vault = { pw: cleanWrap(b.vaultPw), rec: b.vaultRec ? cleanWrap(b.vaultRec) : me.vault.rec };
    delete me.mustChange; delete me.needRecovery; saveUsers(); dropSessionsOf(me.username, s.key);
    log(me.username, 'changed password');
    return send(res, 200, { ok: true });
  }
  // Make a new recovery code (the old one stops working). Needs the current password; the browser re-locks the key with the new code.
  if (p === '/api/recovery/new' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (!checkPw(me, b.auth)) return send(res, 400, { error: 'Your password is not right.' });
    if (pwProblem(b.recAuth) || !validWrap(b.vaultRec)) return send(res, 400, { error: 'Bad key data. Reload the page and try again.' });
    setRec(me, b.recAuth); me.vault = { pw: me.vault.pw, rec: cleanWrap(b.vaultRec) }; saveUsers();
    log(me.username, 'made a new recovery code');
    return send(res, 200, { ok: true });
  }
  // Lost the recovery code after a password reset: start over with a new key. Old books can't be opened, so they're set aside, not deleted.
  if (p === '/api/vault/restart' && req.method === 'POST') {
    const b = await readJSONBody(req);
    if (!me.needRecovery) return send(res, 400, { error: 'Not needed' });
    if (!checkPw(me, b.old)) return send(res, 400, { error: 'Your current password is not right.' });
    const bad = pwProblem(b.auth); if (bad) return send(res, 400, { error: bad });
    if (!validVault(b.vault) || pwProblem(b.recAuth)) return send(res, 400, { error: 'Bad key data.' });
    if (fs.existsSync(coDir(me))) fs.renameSync(coDir(me), path.join(userDir(me), 'Locked companies ' + stamp()));
    setPw(me, b.auth); setRec(me, b.recAuth); me.vault = { pw: cleanWrap(b.vault.pw), rec: cleanWrap(b.vault.rec) };
    delete me.mustChange; delete me.needRecovery; saveUsers(); dropSessionsOf(me.username, s.key);
    log(me.username, 'started over with a new key (lost recovery code)');
    return send(res, 200, { ok: true });
  }
  if (me.needRecovery && p !== '/api/ai/status') return send(res, 403, { error: 'Unlock your books with your recovery code first.' });

  // ----- books (only locked files go in or out) -----
  if (p === '/api/companies') { const list = listCompanies(me); return send(res, 200, { list, current: currentFile(me, list) }); }
  if (p === '/api/companies/current' && req.method === 'POST') {
    const b = await readJSONBody(req); access(me, b.file);
    writeAtomic(settingsPath(me), JSON.stringify(Object.assign(readJSON(settingsPath(me), {}), { current: b.file }), null, 1));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/companies/create' && req.method === 'POST') {
    const text = await readBody(req, 60e6);
    const file = createCompany(me, q('file'), text, req.headers['x-ld-key']);
    log(me.username, 'created company', file);
    return send(res, 200, { file, version: versionOf(access(me, file).path) });
  }
  if (p === '/api/books') {
    const a = access(me, q('file'));
    let text = null; try { text = fs.readFileSync(a.path, 'utf8'); } catch (e) {}
    return send(res, 200, { text, version: versionOf(a.path), role: a.role });
  }
  if (p === '/api/books/version') return send(res, 200, { version: versionOf(access(me, q('file')).path) });
  if (p === '/api/books/save' && req.method === 'POST') {
    const a = access(me, q('file'));
    if (a.role === 'view') return send(res, 403, { error: 'You can only view this company. Your change was not saved.' });
    const f = a.path;
    const text = await readBody(req, 60e6);
    if (!validEnvelope(text)) return send(res, 400, { error: 'Only locked books can be saved.' });
    const have = versionOf(f), want = q('if') || null;
    if (have !== want) {
      // The file changed since this page read it (another window or PC). Keep the page's copy (still locked), send back the file.
      const cdir = path.join(userDir(me), 'Conflicts'); fs.mkdirSync(cdir, { recursive: true });
      fs.writeFileSync(path.join(cdir, path.basename(f, '.json') + ' - not saved ' + stamp() + '.json'), text, 'utf8');
      let disk = null; try { disk = fs.readFileSync(f, 'utf8'); } catch (e) {}
      log(me.username, 'save conflict on', path.basename(f));
      return send(res, 200, { conflict: true, text: disk, version: have });
    }
    writeAtomic(f, text);
    return send(res, 200, { ok: true, version: versionOf(f) });
  }

  // ----- sharing a company with other people on this server -----
  // Public keys let one person's browser lock a company key for another person. Private keys stay locked with each person's own key.
  if (p === '/api/me/keys' && req.method === 'POST') {
    const b = await readJSONBody(req, 20000);
    if (!/^[A-Za-z0-9+/=]{300,1200}$/.test(b.pub || '') || !b.priv || !/^[A-Za-z0-9+/=]{16}$/.test(b.priv.iv || '') || !/^[A-Za-z0-9+/=]{500,6000}$/.test(b.priv.ct || '')) return send(res, 400, { error: 'Bad key data' });
    if (me.pub && !b.replace) return send(res, 409, { error: 'Keys already set' });
    me.pub = b.pub; me.priv = { iv: b.priv.iv, ct: b.priv.ct }; saveUsers();
    return send(res, 200, { ok: true });
  }
  // Shares waiting for my browser to hand over the company key (someone I invited has now signed up)
  if (p === '/api/share/pending') {
    const out = [];
    let files = []; try { files = fs.readdirSync(coDir(me)).filter(validFile); } catch (e) {}
    for (const f of files) {
      const k = readKeys(path.join(coDir(me), f), me.username);
      Object.entries(k.members).forEach(([n, m]) => { const u = findUser(n); if (!m.key && n !== me.username && u && u.pub && !u.disabled) out.push({ file: f, username: n, role: m.role }); });
    }
    return send(res, 200, { pending: out });
  }
  if (p === '/api/users/lookup') {
    const u = findUser(q('username'));
    if (!u || u.disabled || u === me) return send(res, 404, { error: 'There is no other login with that user name on this server.' });
    if (!u.pub) return send(res, 409, { error: u.username + ' needs to sign in to Ledger Desk once (after this update) before you can share with them.' });
    return send(res, 200, { username: u.username, name: u.name || u.username, pub: u.pub });
  }
  if (p === '/api/share/list') {
    const a = access(me, q('file'));
    if (a.role !== 'owner') return send(res, 403, { error: 'Only the owner can see who has access.' });
    const members = Object.entries(a.keys.members).filter(([n, m]) => n !== a.owner && m.role !== 'owner').map(([n, m]) => { const u = findUser(n) || {}; return { username: n, name: u.name || n, role: m.role, added: m.added || '', disabled: !!u.disabled, pending: !m.key }; });
    return send(res, 200, { members });
  }
  if (p.startsWith('/api/share/') && req.method === 'POST') {
    const b = await readJSONBody(req, 70e6);
    const a = access(me, b.file);
    if (p === '/api/share/leave') {
      if (a.role === 'owner') return send(res, 400, { error: 'You own this company.' });
      delete a.keys.members[me.username]; writeKeys(a.path, a.keys);
      log(me.username, 'left a shared company of', a.owner);
      return send(res, 200, { ok: true });
    }
    if (a.role !== 'owner') return send(res, 403, { error: 'Only the owner can change who has access.' });
    if (p === '/api/share/add') {
      const u = findUser(b.username);
      if (!u || u === me || u.disabled) return send(res, 404, { error: 'There is no other login with that user name.' });
      if (!ROLES.includes(b.role) || !validKey(b.key)) return send(res, 400, { error: 'Bad sharing data' });
      a.keys.members[u.username] = { key: b.key, role: b.role, added: new Date().toISOString(), by: me.username };
      writeKeys(a.path, a.keys);
      log(me.username, 'shared a company with', u.username, '(' + b.role + ')');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/share/role') {
      const m = a.keys.members[normUser(b.username)];
      if (!m || m.role === 'owner' || !ROLES.includes(b.role)) return send(res, 400, { error: 'Bad sharing data' });
      m.role = b.role; writeKeys(a.path, a.keys);
      log(me.username, 'changed access for', b.username, 'to', b.role);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/share/remove') {
      const n = normUser(b.username);
      if (!a.keys.members[n] || n === a.owner) return send(res, 400, { error: 'That person doesn\'t have access.' });
      delete a.keys.members[n]; writeKeys(a.path, a.keys);
      log(me.username, 'removed', n, 'from a company');
      return send(res, 200, { ok: true });
    }
    // New company key: the owner's browser re-locks the books and gives the new key to everyone still allowed in.
    // Also used once to move a company from the person's own key to its own company key.
    if (p === '/api/share/rekey') {
      if (!validEnvelope(b.env)) return send(res, 400, { error: 'Only locked books can be saved.' });
      const have = versionOf(a.path);
      if (have !== (b.if || null)) return send(res, 409, { error: 'The books changed while re-locking. Try again.' });
      const keys = b.keys || {};
      const allowed = new Set([a.owner].concat(Object.keys(a.keys.members)));
      if (!validKey(keys[a.owner]) || Object.keys(keys).some(n => !allowed.has(n) || !validKey(keys[n]))) return send(res, 400, { error: 'Bad key data' });
      const members = {};
      Object.keys(keys).forEach(n => { const old = a.keys.members[n] || {}; members[n] = { key: keys[n], role: n === a.owner ? 'owner' : (old.role || 'view'), added: old.added || new Date().toISOString(), by: old.by }; });
      writeAtomic(a.path, b.env); writeKeys(a.path, { owner: a.owner, members });
      log(me.username, 'gave a company a new key');
      return send(res, 200, { ok: true, version: versionOf(a.path) });
    }
  }

  // ----- company files waiting to come in (plain copies put in Documents\Ledger Desk Server\Import\<user name>) -----
  // The person's browser reads each one, locks it with their key, saves it as a company, then the plain copy is removed.
  if (p.startsWith('/api/import/')) {
    const idir = path.join(DATA, 'Import', me.username);
    const okName = n => typeof n === 'string' && n === path.basename(n) && /\.json$/i.test(n) && !/^\./.test(n);
    if (p === '/api/import/list') {
      let files = []; try { files = fs.readdirSync(idir).filter(okName).map(n => ({ name: n, size: fs.statSync(path.join(idir, n)).size })); } catch (e) {}
      return send(res, 200, { files });
    }
    if (p === '/api/import/file') {
      const n = q('name'); if (!okName(n)) return send(res, 400, { error: 'Bad file name' });
      let text; try { text = fs.readFileSync(path.join(idir, n), 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return send(res, 404, { error: 'Not found' }); }
      return send(res, 200, { text });
    }
    if (p === '/api/import/done' && req.method === 'POST') {
      const b = await readJSONBody(req); if (!okName(b.name)) return send(res, 400, { error: 'Bad file name' });
      try { fs.unlinkSync(path.join(idir, b.name)); } catch (e) {}
      log(me.username, 'brought in a waiting company file (plain copy removed)');
      return send(res, 200, { ok: true });
    }
  }

  // ----- AI -----
  if (p === '/api/ai/status') {
    const st = await aiStatus(), g = { available: geminiAllowed(me), on: useGemini(me), model: CFG.gemini && CFG.gemini.model || '' };
    if (g.on) Object.assign(st, { ok: true, hasText: true, hasVision: true, provider: 'gemini' });
    return send(res, 200, Object.assign(st, { gemini: g }));
  }
  // Two-step sign-in settings for me
  if (p === '/api/me/2fa') {
    if (req.method !== 'POST') return send(res, 200, { method: me.tfa && me.tfa.method || '', email: me.email || '', required: !!CFG.require2fa, trusted: ((me.tfa && me.tfa.trusted) || []).filter(t => t.exp > now()).length, canEmail: !!(CFG.mail && CFG.mail.user) });
    const b = await readJSONBody(req);
    if (b.action === 'off') { if (CFG.require2fa) return send(res, 400, { error: 'The owner requires two-step sign-in for everyone.' }); delete me.tfa; saveUsers(); log(me.username, 'turned off two-step sign-in'); return send(res, 200, { ok: true }); }
    if (b.action === 'forget') { if (me.tfa) me.tfa.trusted = []; saveUsers(); return send(res, 200, { ok: true }); }
    if (b.action === 'email-send') { // send a test code to the address being set up
      const to = String(b.email || '').trim(); if (!validEmail(to)) return send(res, 400, { error: 'Type your full email address.' });
      const t = SETUP[me.username + ':email'] = { id: crypto.randomBytes(8).toString('hex') };
      try { await sendCode(t, me, to); } catch (e) { return send(res, e.code || 502, { error: e.message }); }
      return send(res, 200, { ok: true });
    }
    if (b.action === 'email-confirm') {
      const t = SETUP[me.username + ':email']; if (!t || !t.code || t.codeExp < now() || sha(String(b.code || '').replace(/\D/g, '') + '|' + t.id) !== t.code) return send(res, 400, { error: 'That code isn\'t right.' });
      me.email = t.to; me.tfa = { method: 'email', trusted: (me.tfa && me.tfa.trusted) || [] }; delete SETUP[me.username + ':email']; saveUsers(); log(me.username, 'turned on two-step sign-in by email');
      return send(res, 200, { ok: true });
    }
    if (b.action === 'app-start') { const secret = b32enc(crypto.randomBytes(20)); SETUP[me.username + ':app'] = secret; return send(res, 200, { secret, uri: 'otpauth://totp/' + encodeURIComponent('Ledger Desk:' + me.username) + '?secret=' + secret + '&issuer=' + encodeURIComponent('Ledger Desk') }); }
    if (b.action === 'app-confirm') {
      const secret = SETUP[me.username + ':app']; if (!secret || !totpOk(secret, String(b.code || '').replace(/\D/g, ''))) return send(res, 400, { error: 'That code isn\'t right. Check the time on your phone is set automatically.' });
      me.tfa = { method: 'app', secret, trusted: (me.tfa && me.tfa.trusted) || [] }; delete SETUP[me.username + ':app']; saveUsers(); log(me.username, 'turned on two-step sign-in with an authenticator app');
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'Bad request' });
  }
  if (p === '/api/me/ai' && req.method === 'POST') {
    const b = await readJSONBody(req), want = b.provider === 'gemini' ? 'gemini' : 'local';
    if (want === 'gemini' && !geminiAllowed(me)) return send(res, 400, { error: 'Gemini isn\'t available for your login.' });
    writeAtomic(settingsPath(me), JSON.stringify(Object.assign(readJSON(settingsPath(me), {}), { ai: want }), null, 1));
    log(me.username, 'chose AI:', want);
    return send(res, 200, { ok: true, provider: want });
  }
  if (p.startsWith('/api/ai/') && req.method === 'POST') {
    if (!CFG.aiEnabled) return send(res, 503, { error: 'AI is turned off on the server.' });
    const b = await readJSONBody(req, p === '/api/ai/check' || p === '/api/ai/document' ? 15e6 : 3e6);
    const job = { '/api/ai/categorize': aiCategorize, '/api/ai/ask': aiAsk, '/api/ai/check': aiCheck, '/api/ai/explain': aiExplain, '/api/ai/review': aiReview, '/api/ai/document': aiDocument, '/api/ai/teach': aiTeach }[p];
    if (!job) return send(res, 404, { error: 'Not found' });
    const ctx = { gemini: useGemini(me) };
    try { const out = ctx.gemini ? await job(b, ctx) : await aiJob(() => job(b, ctx)); if (ctx.fellBack) out.note = 'Gemini didn\'t answer (' + ctx.fellBack + '), so this PC\'s AI did it.'; out.by = ctx.gemini && !ctx.fellBack ? 'gemini' : 'local'; return send(res, 200, out); }
    catch (e) { if (e.code) throw e; log('AI error for', me.username + ':', e.message); return send(res, 502, { error: e.message }); }
  }

  // ----- owner only: manage logins -----
  if (p.startsWith('/api/admin/')) {
    if (!me.admin) return send(res, 403, { error: 'Only the owner can do this.' });
    if (p === '/api/admin/users') return send(res, 200, { users: USERS.users.map(u => Object.assign(publicUser(u), { companies: ownCount(u), tfa: u.tfa && u.tfa.method || '' })) });
    if (p === '/api/admin/invites') {
      reloadConfig();
      return send(res, 200, { require2fa: !!CFG.require2fa, mailFrom: CFG.mail && CFG.mail.user ? CFG.mail.user : '', publicUrl: CFG.publicUrl || '', tailscaleInvite: CFG.tailscaleInvite || '', invites: INV.invites.slice().reverse().map(i => ({ id: i.id, name: i.name, note: i.note, sentTo: i.sentTo || '', shares: i.share ? i.share.files.length : 0, shareRole: i.share ? i.share.role : '', created: i.created, expires: i.expires, status: invStatus(i), usedBy: i.usedBy || '', usedAt: i.usedAt || '' })) });
    }
    if (p === '/api/admin/invite' && req.method === 'POST') {
      const b = await readJSONBody(req);
      const days = Math.min(30, Math.max(1, Math.round(Number(b.days) || 7)));
      const code = crypto.randomBytes(24).toString('base64url');
      const inv = { id: crypto.randomBytes(6).toString('hex'), hash: crypto.createHash('sha256').update(code).digest('hex'), name: clip(b.name, 80), note: clip(b.note, 120), by: me.username, created: new Date().toISOString(), expires: now() + days * 864e5 };
      if (b.share && Array.isArray(b.share.files) && b.share.files.length) {
        const files = b.share.files.filter(f => validFile(f) && ownerOf(f) === me.username).slice(0, 200);
        if (files.length) inv.share = { files, role: b.share.role === 'view' ? 'view' : 'edit' };
      }
      INV.invites.push(inv); saveInv();
      log(me.username, 'created an invite for', inv.name || '(no name)');
      reloadConfig();
      return send(res, 200, { id: inv.id, code, expires: inv.expires, publicUrl: CFG.publicUrl || '', tailscaleInvite: CFG.tailscaleInvite || '', mailFrom: CFG.mail && CFG.mail.user ? CFG.mail.user : '' });
    }
    // ----- sending invite emails from Ledger Desk -----
    if (p === '/api/admin/mail' && req.method === 'POST') {
      const b = await readJSONBody(req);
      const cfg = readJSON(CONFIG_PATH, {});
      if (b.off) { cfg.mail = null; writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2)); reloadConfig(); return send(res, 200, { ok: true }); }
      const user = String(b.email || '').trim(), pass = String(b.password || '').replace(/\s+/g, '');
      if (!validEmail(user)) return send(res, 400, { error: 'Type the full email address, like you@gmail.com.' });
      const gmail = /@(gmail|googlemail)\.com$/i.test(user);
      const host = String(b.host || (gmail ? 'smtp.gmail.com' : '')).trim(), port = Number(b.port || 465);
      if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) return send(res, 400, { error: 'For an email address that isn\'t Gmail, also type its outgoing (SMTP) server, for example smtp.office365.com.' });
      const mail = { user, from: user, host, port, pass: pass || (CFG.mail && CFG.mail.user === user ? CFG.mail.pass : '') };
      if (!mail.pass) return send(res, 400, { error: 'Type the app password.' });
      try { await sendMail(mail, { to: user, fromName: 'Ledger Desk', subject: 'Ledger Desk can send email now', text: 'This is a test from your Ledger Desk Server. Invites you send from the Logins screen will come from this address.\n' }); }
      catch (e) { return send(res, 400, { error: e.message }); }
      cfg.mail = mail; writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2)); reloadConfig();
      log(me.username, 'set up invite email from', user);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/invite/email' && req.method === 'POST') {
      const b = await readJSONBody(req);
      reloadConfig();
      if (!CFG.mail || !CFG.mail.user) return send(res, 400, { error: 'Set up email sending first (Logins › Email for invites).' });
      const to = String(b.to || '').trim();
      if (!validEmail(to)) return send(res, 400, { error: 'That email address doesn\'t look right.' });
      const inv = INV.invites.find(i => i.id === b.id);
      if (!inv || invStatus(inv) !== 'waiting') return send(res, 400, { error: 'That invite can\'t be used any more.' });
      const text = String(b.text || '').slice(0, 5000);
      if (text.indexOf('/invite?code=') < 0) return send(res, 400, { error: 'Bad invite message' });
      try { await sendMail(CFG.mail, { to, fromName: (me.name || me.username) + ' (Ledger Desk)', subject: clip(b.subject, 150) || 'Your Ledger Desk invite', text }); }
      catch (e) { return send(res, 502, { error: 'The email was not sent: ' + e.message }); }
      inv.sentTo = to; inv.sentAt = new Date().toISOString(); saveInv();
      log(me.username, 'emailed an invite to', to);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/invite/cancel' && req.method === 'POST') {
      const b = await readJSONBody(req);
      const inv = INV.invites.find(i => i.id === b.id);
      if (!inv) return send(res, 404, { error: 'No such invite' });
      inv.revoked = true; saveInv();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/gemini') {
      reloadConfig();
      const g = CFG.gemini || null;
      if (req.method !== 'POST') { let models = []; if (g && g.key) { try { models = await gemModels(g.key); } catch (e) {} } return send(res, 200, { configured: !!(g && g.key), last4: g && g.key ? g.key.slice(-4) : '', model: g ? g.model : '', forAll: !!(g && g.forAll), models }); }
      const b = await readJSONBody(req), cfg = readJSON(CONFIG_PATH, {});
      if (b.off) { cfg.gemini = null; writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2)); reloadConfig(); log(me.username, 'turned Gemini off'); return send(res, 200, { ok: true }); }
      const key = String(b.key || '').trim() || (g && g.key) || '';
      if (!/^[A-Za-z0-9_\-]{20,100}$/.test(key)) return send(res, 400, { error: 'Paste the API key from Google AI Studio (it usually starts with AIza).' });
      let models;
      try { models = await gemModels(key); } catch (e) { return send(res, 400, { error: e.status === 400 || e.status === 403 ? 'Google didn\'t accept that key: ' + e.message.replace(/^Gemini: /, '') : e.message }); }
      if (!models.length) return send(res, 400, { error: 'That key works, but it has no Gemini models it can use.' });
      const model = models.some(m => m.id === b.model) ? b.model : (g && models.some(m => m.id === g.model) ? g.model : pickModel(models));
      CFG.gemini = { key, model }; // try it before saving
      try { await geminiJSON([{ role: 'user', content: 'Reply with {"ok": true}' }], { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }); }
      catch (e) { reloadConfig(); return send(res, 400, { error: 'The key works but the test question failed: ' + e.message.replace(/^Gemini: /, '') + (/quota|billing|429/i.test(e.message) ? ' Check that billing is turned on for this key in Google AI Studio.' : '') }); }
      cfg.gemini = { key, model, forAll: typeof b.forAll === 'boolean' ? b.forAll : !!(g && g.forAll) };
      writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2)); reloadConfig();
      log(me.username, 'set up Gemini, model', model);
      return send(res, 200, { ok: true, model, models });
    }
    if (p === '/api/admin/settings' && req.method === 'POST') {
      const b = await readJSONBody(req);
      reloadConfig();
      const cfg = readJSON(CONFIG_PATH, {});
      if (typeof b.tailscaleInvite === 'string') {
        const t = b.tailscaleInvite.trim();
        if (t && !/^https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_?=&.-]+$/.test(t)) return send(res, 400, { error: 'That doesn\'t look like a Tailscale share link (it starts with https://login.tailscale.com/).' });
        cfg.tailscaleInvite = t;
      }
      if (typeof b.require2fa === 'boolean') { cfg.require2fa = b.require2fa; log(me.username, b.require2fa ? 'now requires two-step sign-in for everyone' : 'no longer requires two-step sign-in'); }
      if (typeof b.publicUrl === 'string') {
        const u = b.publicUrl.trim().replace(/\/+$/, '');
        if (u && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(u)) return send(res, 400, { error: 'Type the address like https://lawmangolfsim.something.ts.net' });
        cfg.publicUrl = u;
      }
      writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2)); reloadConfig();
      return send(res, 200, { ok: true });
    }
    const b = req.method === 'POST' ? await readJSONBody(req) : {};
    // Accounts are only made from invites, so each person makes their own key and nobody else ever knows it.
    const u = findUser(b.username);
    if (!u) return send(res, 404, { error: 'No such login' });
    if (p === '/api/admin/2fa-reset' && req.method === 'POST') { delete u.tfa; saveUsers(); log(me.username, 'reset two-step sign-in for', u.username); return send(res, 200, { ok: true }); }
    if (p === '/api/admin/reset' && req.method === 'POST') {
      // A reset lets them sign in again, but their books stay locked until they type their recovery code.
      if (u === me) return send(res, 400, { error: 'Change your own password with "Change password" instead.' });
      const bad = pwProblem(b.auth); if (bad) return send(res, 400, { error: bad });
      setPw(u, b.auth); u.mustChange = true; u.needRecovery = true; saveUsers(); dropSessionsOf(u.username);
      log(me.username, 'reset password for', u.username);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/disable' && req.method === 'POST') {
      if (u === me) return send(res, 400, { error: 'You can\'t turn off your own login.' });
      u.disabled = !!b.disabled; saveUsers(); if (u.disabled) dropSessionsOf(u.username);
      log(me.username, (u.disabled ? 'turned off' : 'turned on'), u.username);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!e.code || typeof e.code !== 'number') log('error:', e.stack || e.message);
    if (!res.headersSent) send(res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'Something went wrong on the server.' });
  });
});
server.requestTimeout = 0; // AI answers can take a while
server.on('error', e => { log(e.code === 'EADDRINUSE' ? 'Ledger Desk Server is already running (port ' + CFG.port + ' is in use).' : 'server error: ' + e.message); process.exit(1); });
server.listen(CFG.port, CFG.listen, () => {
  log('Ledger Desk Server ' + VERSION + ' running at http://localhost:' + CFG.port + ' · data in ' + DATA);
  dailyBackup(); setInterval(dailyBackup, 3600e3);
});
