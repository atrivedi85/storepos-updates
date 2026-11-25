'use strict';
/* Trivedi account link for the Windows store PC (used by main.js; also run by the tests in cloud/test).
   Signs in to trivedipos.com with the owner's user name and password (and the two-step code if asked), registers this
   store under that account, and then keeps only a DEVICE TOKEN — never the password.
   The store key is locked here with the owner's public key (RSA-OAEP, the same key pair Ledger Desk uses to share
   companies) before it is sent, so the server never sees it in plain. */
const crypto = require('crypto');

const AUTH_ITER = 200000;
const pbk = (secret, salt, iter) => crypto.pbkdf2Sync(String(secret), salt, iter, 32, 'sha256');
const authFor = (username, password) => pbk(password, Buffer.from('ledgerdesk-auth|' + String(username).trim().toLowerCase()), AUTH_ITER).toString('base64');

function openWrap(w, secret) {   // the "vault": the person's master key, locked with their password
  const kek = pbk(secret, Buffer.from(w.salt, 'base64'), w.iter), ct = Buffer.from(w.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(w.iv, 'base64')); d.setAuthTag(ct.subarray(ct.length - 16));
  try { return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]); } catch (e) { throw new Error('That password does not unlock your account key.'); }
}
function sealWith(dek, bytes) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', dek, iv);
  return { iv: iv.toString('base64'), ct: Buffer.concat([c.update(bytes), c.final(), c.getAuthTag()]).toString('base64') };
}
function newPersonKeys(dek) {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 65537, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  return { pub: kp.publicKey.toString('base64'), priv: sealWith(dek, kp.privateKey) };
}
function wrapKeyFor(pubB64, storeKeyB64) {
  const key = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(storeKeyB64, 'base64')).toString('base64');
}
const relayAuth = keyB64 => crypto.createHmac('sha256', Buffer.from(keyB64, 'base64')).update('storepos-relay-auth').digest('hex');

async function api(base, path, { method = 'POST', body, cookie, device } = {}) {
  const h = { 'x-ld': '1' }; if (body !== undefined) h['content-type'] = 'application/json'; if (cookie) h.cookie = 'ld_s=' + cookie; if (device) h['x-pos-device'] = device;
  let r; try { r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new Error('Can’t reach trivedipos.com (check the internet)'); }
  let d = {}; try { d = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok) { const e = new Error(d.error || 'trivedipos.com said ' + r.status); e.status = r.status; throw e; }
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of sc) { const m = /ld_s=([a-f0-9]{64})/.exec(c); if (m) d.__cookie = m[1]; }
  return d;
}

/** Step 1. Returns { need2fa, ticket, method, to } when a code is needed, otherwise { session }. */
async function signIn(base, username, password) {
  username = String(username || '').trim().toLowerCase();
  if (username.includes('@')) { try { username = (await api(base, '/api/login/resolve', { body: { id: username } })).username || username; } catch (e) { /* the sign-in below says what is wrong */ } }   // an email is turned into the user name the sign-in value is made with
  const r = await api(base, '/api/login', { body: { username, auth: authFor(username, password) } });
  if (r.need2fa) return { need2fa: r.need2fa, ticket: r.ticket, to: r.to || '', canEmail: !!r.canEmail };
  return { session: { cookie: r.__cookie, vault: r.vault, needRecovery: !!r.needRecovery, username } };
}
async function signIn2fa(base, username, ticket, code) {
  const r = await api(base, '/api/login/2fa', { body: { ticket, code: String(code || '').replace(/\D/g, '') } });
  return { session: { cookie: r.__cookie, vault: r.vault, needRecovery: !!r.needRecovery, username: String(username).trim().toLowerCase() } };
}
async function emailCode(base, ticket) { return api(base, '/api/login/2fa/email', { body: { ticket } }); }

/** Step 2. Register this store under the account. Returns { deviceToken, user, name }. */
async function linkStore(base, session, password, store) {
  if (!session || !session.cookie) throw new Error('Sign-in did not finish. Try again.');
  if (session.needRecovery) throw new Error('This account was just reset. Sign in at trivedipos.com/books first to finish that.');
  try {
    const me = await api(base, '/api/me', { method: 'GET', cookie: session.cookie });
    let pub = me.pub;
    if (!pub) {   // first time this account is used for anything that needs a key pair: make it, exactly like Ledger Desk does in the browser
      const dek = openWrap(session.vault.pw, password), pk = newPersonKeys(dek);
      await api(base, '/api/me/keys', { cookie: session.cookie, body: pk }); pub = pk.pub;
    }
    const r = await api(base, '/api/pos/store/link', { cookie: session.cookie, body: { storeId: store.storeId, name: store.name, relayAuth: relayAuth(store.key), wrappedKey: wrapKeyFor(pub, store.key) } });
    return { deviceToken: r.deviceToken, user: me.username, name: me.name || me.username };
  } finally { try { await api(base, '/api/logout', { cookie: session.cookie, body: {} }); } catch (e) { /* the sign-in just times out */ } }
}

/** What the store PC does on its own, with the device token only. */
const devicePending = (base, tok) => api(base, '/api/pos/device/pending', { device: tok, body: {} });
const deviceWrap = (base, tok, username, storeKeyB64, pub) => api(base, '/api/pos/device/wrap', { device: tok, body: { username, wrappedKey: wrapKeyFor(pub, storeKeyB64) } });
const deviceHeartbeat = (base, tok, body) => api(base, '/api/pos/device/heartbeat', { device: tok, body });
const deviceUnlink = (base, tok) => api(base, '/api/pos/device/unlink', { device: tok, body: {} });
/** Wrap the store key for everyone who is waiting for it (called every few minutes while the PC is online). */
async function approvePending(base, tok, storeKeyB64) {
  const { pending } = await devicePending(base, tok); let n = 0;
  for (const p of pending || []) { try { await deviceWrap(base, tok, p.username, storeKeyB64, p.pub); n++; } catch (e) { /* next time */ } }
  return n;
}

/** A device token made for a Trivedi account only works while the relay vouches (on that very request) for the same person
    with a role that is still allowed. So a removed person who kept the token or the store key gets nothing from the store PC. */
const ROLES = ['owner', 'manager', 'cashier', 'reports'];
function deviceAllowed(tablet, acct) {
  if (!tablet || !tablet.acct) return true;                // an ordinary paired tablet or PC (made with a code)
  return !!acct && acct.u === tablet.acct.user && ROLES.includes(acct.r);
}
const canWrite = role => role === 'owner' || role === 'manager' || role === 'cashier';   // "Reports only" and anything unknown can look but not change

/* ---- What each account role may see and send (the store PC enforces this; the browser screens are only for looks) ----
   WHO is asking comes from the relay: the Hub checks the sign-in and the store membership, then stamps every message with
   { u: user, r: role } OUTSIDE the sealed part (the browser can't set it; index.js deletes any m.acct it sends). The store PC
   trusts the stamp only from its own authenticated Hub connection (cloudRequest in main.js builds req.acct from it).
   role === null/undefined means "no stamp": a device paired with a code (LAN tablet, Cloud code, linked PC). Those hold the
   store key by pairing and need the PINs to sign in offline, so they get everything, as before.
   Owner = everything. Every other account role never receives credentials. */
const SECRET_KEYS = new Set(['pin', 'pinhash', 'pinsalt', 'pins', 'password', 'passwd', 'pwd', 'passcode', 'secret', 'clientsecret', 'token', 'accesstoken', 'devicetoken',
  'apikey', 'licensekey', 'license', 'storekey', 'relayauth', 'privatekey', 'smtp', 'smtppass', 'smtppassword', 'smtpuser', 'mailpassword', 'authkey', 'accesskey', 'terminalkey', 'terminalsecret', 'merchantkey']);
const isSecretKey = k => SECRET_KEYS.has(String(k).toLowerCase());
const seesAll = role => role === undefined || role === null || role === 'owner';
function strip(v) {   // a copy without any credential-like field, at any depth
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) if (!isSecretKey(k)) o[k] = strip(v[k]); return o; }
  return v;
}
function stripUser(u) { if (!u || typeof u !== 'object') return u; const o = strip(u); o.hasPin = !!(u.pin || u.pinHash); return o; }   // keeps id, name, role, perms, pay; "hasPin" lets a screen show ••••
function filterFor(role, payload) {
  if (seesAll(role) || payload == null || typeof payload !== 'object') return payload;
  const one = it => (it && it.store === 'kv' && it.key === 'users' && Array.isArray(it.data)) ? { ...strip({ ...it, data: null }), data: it.data.map(stripUser) } : strip(it);
  if (Array.isArray(payload.items)) return { ...strip({ ...payload, items: null }), items: payload.items.map(one) };   // /sync (snapshot pages and changes)
  return strip(payload);                                                                                          // /api answers
}
/** Changes a non-owner account sends. Credentials can never be changed from here: a write to the users list is dropped, and a
    write to settings keeps whatever secret-like settings the PC already has (the sender never saw them, so can't send them back). */
function guardOps(role, ops, readKv) {
  if (seesAll(role)) return { ops, skipped: [] };
  const out = [], skipped = [];
  for (const op of ops || []) {
    if (op && op.store === 'kv' && String(op.key) === 'users') { skipped.push('users'); continue; }
    if (op && op.store === 'kv' && String(op.key) === 'settings' && op.data && typeof op.data === 'object') {
      const cur = readKv('settings') || {}, d = strip(op.data);
      for (const k of Object.keys(cur)) if (isSecretKey(k)) d[k] = cur[k];
      out.push({ ...op, data: d }); continue;
    }
    out.push(op);
  }
  return { ops: out, skipped };
}

module.exports = { deviceAllowed, canWrite, filterFor, guardOps, ROLES, authFor, openWrap, newPersonKeys, wrapKeyFor, relayAuth, signIn, signIn2fa, emailCode, linkStore, devicePending, deviceWrap, deviceHeartbeat, deviceUnlink, approvePending };
