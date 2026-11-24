// PdfStudio accounts API (invite-only). Mounted by index.js under /pdfstudio/api/*
import { handleEsign } from './esign.js';
const enc = new TextEncoder();
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const PBKDF2_ITER = 100000; // Workers cap PBKDF2 at 100k iterations
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/.{2}/g).map((h) => parseInt(h, 16)));
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: PBKDF2_ITER }, key, 256);
  return hex(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status, error) => json({ error }, status);

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 10) return 'Password must be at least 10 characters.';
  if (p.length > 200) return 'Password is too long.';
  return null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function cookieToken(request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)pdfs_session=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
function bearerToken(request) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  return m ? m[1] : null;
}
function sessionCookie(token, maxAgeSec) {
  return `pdfs_session=${token}; Path=/pdfstudio; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

// Accounts live in Ledger Desk. The first time someone from Ledger Desk uses PdfStudio we create a matching
// local row (it only holds their cloud files). Ledger Desk's "admin" flag makes them an admin here too, and an
// existing admin is never demoted automatically. Returns the local user, or null if the account is turned off.
async function upsertLedgerUser(env, me) {
  const username = String((me && me.username) || '').trim().toLowerCase();
  if (!username || me.disabled) return null;
  const wantAdmin = me.admin === true;
  let u = await env.DB.prepare('SELECT id, username, email, role, disabled FROM users WHERE username = ?').bind(username).first();
  if (!u) {
    const id = rand(8);
    const email = `${username}@ledger.invalid`;
    await env.DB.prepare('INSERT INTO users (id, username, email, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, username, email, 'ledger-desk', 'ledger-desk', wantAdmin ? 'admin' : 'user', Date.now()).run();
    return { id, username, email, role: wantAdmin ? 'admin' : 'user' };
  }
  if (wantAdmin && u.role !== 'admin') {
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(u.id).run();
    u = { ...u, role: 'admin' };
  }
  return { id: u.id, username: u.username, email: u.email, role: u.role };
}

// Browsers that are already signed in to Ledger Desk (cookie ld_s on trivedipos.com) are recognised without a second login.
const ssoCache = new Map(); // sha256(ld_s) -> { user, exp }
async function ledgerBrowserUser(env, ldToken) {
  const key = await sha256(ldToken);
  const hit = ssoCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.user;
  const r = await ledgerCall(env, '/api/me', { method: 'GET', token: ldToken });
  const user = r.status === 200 ? await upsertLedgerUser(env, r.data) : null;
  if (ssoCache.size > 500) ssoCache.clear();
  ssoCache.set(key, { user, exp: Date.now() + (user ? 60000 : 15000) });
  return user;
}

// Returns { user, via, sessionHash?, sealed? } or null. Cookie-authenticated writes must come from our own origin (CSRF guard).
export async function authenticate(request, env, url) {
  const bearer = bearerToken(request);
  const cookie = bearer ? null : cookieToken(request);
  const token = bearer || cookie;
  const unsafe = request.method !== 'GET' && request.method !== 'HEAD';
  const sameOrigin = request.headers.get('origin') === url.origin;
  if (token && !(cookie && unsafe && !sameOrigin)) {
    const th = await sha256(token);
    const row = await env.DB.prepare(
      `SELECT u.id, u.username, u.email, u.role, u.disabled, s.expires_at, s.ledger_token
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
    ).bind(th).first();
    if (row && row.expires_at >= Date.now()) {
      return { user: { id: row.id, username: row.username, email: row.email, role: row.role }, via: bearer ? 'bearer' : 'cookie', sessionHash: th, sealed: row.ledger_token };
    }
  }
  const ld = bearer ? null : ledgerTokenFromRequest(request);
  if (ld && !(unsafe && !sameOrigin)) {
    const user = await ledgerBrowserUser(env, ld);
    if (user) return { user, via: 'ledger' };
  }
  return null;
}

async function createSession(env, userId, ledgerToken) {
  const token = rand(32);
  const now = Date.now();
  const expires = now + SESSION_DAYS * 86400000;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ledger_token) VALUES (?,?,?,?,?)')
    .bind(await sha256(token), userId, now, expires, ledgerToken ? await sealToken(env, ledgerToken) : null).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  return { token, expires };
}

async function tooManyFails(env, key) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND at > ?').bind(key, Date.now() - FAIL_WINDOW_MS).first();
  return r.n >= MAX_FAILS;
}
async function recordFail(env, key) {
  await env.DB.prepare('INSERT INTO attempts (key, at) VALUES (?,?)').bind(key, Date.now()).run();
  await env.DB.prepare('DELETE FROM attempts WHERE at < ?').bind(Date.now() - FAIL_WINDOW_MS).run();
}

import { handleFiles, purgeUserFiles } from './files.js';
import { ledgerCall, ledgerTokenFrom, ledgerTokenFromRequest, sealToken, openToken } from './ledger.js';

const AUTH_RE = /^[A-Za-z0-9+/=]{20,120}$/;
const MOVED = 'Accounts are managed in Ledger Desk now. Sign in with your Ledger Desk username and password.';

// Turns a Ledger Desk sign-in answer into a PdfStudio session.
async function finishLedgerLogin(env, r, keys) {
  if (r.status === 0) return fail(502, 'Could not reach Ledger Desk to check your sign-in. Try again in a moment.');
  if (r.status === 429) return fail(429, r.data.error || 'Too many failed attempts. Try again later.');
  if (r.status === 401 || r.status === 400 || r.status === 404) {
    for (const k of keys) await recordFail(env, k);
    return fail(401, r.data.error || 'Wrong username or password.');
  }
  if (r.status !== 200) return fail(r.status >= 400 && r.status < 600 ? r.status : 502, r.data.error ? 'Ledger Desk: ' + r.data.error : 'Ledger Desk could not sign you in right now (code ' + r.status + '). Try again in a moment.');
  if (r.data.need2fa) return json({ need2fa: r.data.need2fa, ticket: r.data.ticket, to: r.data.to || '', canEmail: !!r.data.canEmail });
  const ld = ledgerTokenFrom(r.cookies);
  if (!r.data.ok || !ld) return fail(502, 'Ledger Desk did not complete the sign-in. Try again.');
  if (r.data.needRecovery) {
    await ledgerCall(env, '/api/logout', { token: ld });
    return fail(403, 'Your Ledger Desk password was just reset. Sign in to Ledger Desk first to finish the reset, then come back here.');
  }
  const me = await ledgerCall(env, '/api/me', { method: 'GET', token: ld });
  const user = me.status === 200 ? await upsertLedgerUser(env, me.data) : null;
  if (!user) {
    await ledgerCall(env, '/api/logout', { token: ld });
    return fail(403, 'This account has been turned off. Contact the administrator.');
  }
  const s = await createSession(env, user.id, ld);
  await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(Date.now(), user.id).run();
  return json(
    { token: s.token, expiresAt: s.expires, user: { username: user.username, email: user.email, role: user.role } },
    200, { 'set-cookie': sessionCookie(s.token, SESSION_DAYS * 86400) }
  );
}

export async function handleApi(request, env, url) {
  const route = url.pathname.replace(/^\/pdfstudio\/api\//, '').replace(/\/$/, '');
  const method = request.method;

  // "Send for signature": signer links are public, the rest needs a signed-in owner
  if (route.startsWith('esign/')) return handleEsign(request, env, url, route, () => authenticate(request, env, url));

  // ---- public ----
  // "Email or user name": turns an email into the Ledger Desk user name the sign-in value is made with
  if (route === 'login/resolve' && method === 'POST') {
    const b = await readJson(request);
    const r = await ledgerCall(env, '/api/login/resolve', { body: { id: String(b.id || '').slice(0, 120) } });
    return r.status === 200 ? json({ username: String(r.data.username || '') }) : fail(r.status || 502, r.data.error || 'Could not reach Ledger Desk.');
  }
  if (route === 'login' && method === 'POST') {
    // The browser/app sends { username, auth }: the same derived value Ledger Desk uses, never the password itself.
    const b = await readJson(request);
    const username = String(b.username || '').trim().toLowerCase();
    const authValue = String(b.auth || '');
    if (!username || !AUTH_RE.test(authValue)) return fail(400, 'Enter your username and password.');
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const keys = [`u:${username}`, `ip:${ip}`];
    for (const k of keys) if (await tooManyFails(env, k)) return fail(429, 'Too many failed attempts. Try again in 15 minutes.');
    return finishLedgerLogin(env, await ledgerCall(env, '/api/login', { body: { username, auth: authValue } }), keys);
  }

  // Two-step sign-in (only for people who turned it on in Ledger Desk)
  if (route === 'login/2fa' && method === 'POST') {
    const b = await readJson(request);
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const keys = [`ip2:${ip}`];
    for (const k of keys) if (await tooManyFails(env, k)) return fail(429, 'Too many failed attempts. Try again in 15 minutes.');
    return finishLedgerLogin(env, await ledgerCall(env, '/api/login/2fa', { body: { ticket: String(b.ticket || ''), code: String(b.code || '') } }), keys);
  }
  if (route === 'login/2fa/email' && method === 'POST') {
    const b = await readJson(request);
    const r = await ledgerCall(env, '/api/login/2fa/email', { body: { ticket: String(b.ticket || ''), email: b.email ? String(b.email) : undefined } });
    if (r.status === 0) return fail(502, 'Could not reach Ledger Desk. Try again in a moment.');
    return json(r.data, r.status);
  }

  if ((route === 'invite-info' && method === 'GET') || (route === 'accept-invite' && method === 'POST')) return fail(410, MOVED);
  if (route === 'change-password' && method === 'POST') return fail(410, 'Change your password in Ledger Desk. It is the same password for PdfStudio.');

  // ---- signed-in ----
  const auth = await authenticate(request, env, url);

  if (route === 'me' && method === 'GET') {
    if (!auth) return fail(401, 'Not signed in.');
    // Re-check the account with Ledger Desk now and then (the desktop app calls this about once an hour),
    // so turning someone off in Ledger Desk turns off their PdfStudio sessions too.
    if (auth.sealed) {
      const ld = await openToken(env, auth.sealed);
      const r = ld ? await ledgerCall(env, '/api/me', { method: 'GET', token: ld }) : { status: 401, data: {} };
      if (r.status === 401 || (r.status === 200 && r.data.disabled)) {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(auth.sessionHash).run();
        return json({ error: 'Signed out. Sign in again.' }, r.status === 401 ? 401 : 403, { 'set-cookie': sessionCookie('', 0) });
      }
      if (r.status === 200) {
        const fresh = await upsertLedgerUser(env, r.data);
        if (fresh) auth.user = fresh;
      }
      // status 0 / 5xx: Ledger Desk is unreachable; keep the session rather than sign everyone out.
    }
    return json({ user: auth.user });
  }
  if (route === 'logout' && method === 'POST') {
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    headers.append('set-cookie', sessionCookie('', 0));
    const token = bearerToken(request) || cookieToken(request);
    if (token) {
      const th = await sha256(token);
      const row = await env.DB.prepare('SELECT ledger_token FROM sessions WHERE token_hash = ?').bind(th).first();
      if (row && row.ledger_token) { const ld = await openToken(env, row.ledger_token); if (ld) await ledgerCall(env, '/api/logout', { token: ld }); }
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(th).run();
    }
    // Signed in through the browser's Ledger Desk session: signing out here ends that one as well.
    const ldCookie = bearerToken(request) ? null : ledgerTokenFromRequest(request);
    if (ldCookie && request.headers.get('origin') === url.origin) {
      const r = await ledgerCall(env, '/api/logout', { token: ldCookie });
      for (const c of r.cookies) if (/^ld_s=/.test(c)) headers.append('set-cookie', c);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  if (route === 'files' || route.startsWith('files/')) {
    if (!auth) return fail(401, 'Not signed in.');
    return handleFiles(request, env, url, auth.user, route);
  }

  // ---- admin ----
  if (route.startsWith('admin/')) {
    if (!auth) return fail(401, 'Not signed in.');
    if (auth.user.role !== 'admin') return fail(403, 'Administrators only.');
    const sub = route.slice('admin/'.length);

    if (sub === 'users' && method === 'GET') {
      const r = await env.DB.prepare('SELECT id, username, email, role, disabled, created_at, last_login FROM users ORDER BY created_at').all();
      return json({ users: r.results });
    }
    if (sub === 'invites' && method === 'GET') {
      const r = await env.DB.prepare('SELECT id, email, role, user_id, expires_at, created_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').bind(Date.now()).all();
      return json({ invites: r.results });
    }
    if (sub === 'invites' && method === 'POST') {
      return fail(410, 'Invite people in Ledger Desk. Everyone with a Ledger Desk login can use PdfStudio.');
      // eslint-disable-next-line no-unreachable
      const b = await readJson(request);
      const email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return fail(400, 'Enter a valid email address.');
      if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first()) return fail(409, 'That email already has an account.');
      const role = b.role === 'admin' ? 'admin' : 'user';
      return inviteResponse(await makeInvite(env, url, { email, role, createdBy: auth.user.id, send: b.send === true, inviter: auth.user.username }));
    }
    let m;
    if ((m = sub.match(/^invites\/([a-f0-9]+)$/)) && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM invites WHERE id = ?').bind(m[1]).run();
      return json({ ok: true });
    }
    if ((m = sub.match(/^users\/([a-f0-9]+)\/(disable|enable|reset)$/)) && method === 'POST') {
      const [, id, action] = m;
      const target = await env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?').bind(id).first();
      if (!target) return fail(404, 'No such user.');
      if (action === 'reset') {
        return fail(410, 'Reset passwords in Ledger Desk. It is the same password for PdfStudio.');
        // eslint-disable-next-line no-unreachable
        const b = await readJson(request);
        return inviteResponse(await makeInvite(env, url, { email: target.email, role: target.role, userId: id, createdBy: auth.user.id, send: b.send === true, inviter: auth.user.username }));
      }
      // There is no PdfStudio-only on/off switch. Turn people on or off in Ledger Desk; PdfStudio follows.
      return fail(410, 'Turn people on or off in Ledger Desk. PdfStudio follows it.');
    }
    if ((m = sub.match(/^users\/([a-f0-9]+)$/)) && method === 'DELETE') {
      if (m[1] === auth.user.id) return fail(400, 'You cannot delete your own account.');
      await purgeUserFiles(env, m[1]);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(m[1]),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(m[1]),
      ]);
      return json({ ok: true });
    }
  }

  return fail(404, 'Not found.');
}

const MAX_INVITES_PER_HOUR = 30;
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Sends the invite / reset email through Resend. Never throws; returns { emailed, emailError? }.
async function sendInviteEmail(env, { to, link, reset, inviter }) {
  if (!env.RESEND_API_KEY) return { emailed: false, emailError: 'Email sending is not set up yet. Copy the link instead.' };
  const title = reset ? 'Reset your PdfStudio password' : 'You’re invited to PdfStudio';
  const lead = reset
    ? `${escHtml(inviter)} started a password reset for your PdfStudio account.`
    : `${escHtml(inviter)} invited you to PdfStudio, a PDF editor you can use in your browser or install on your PC.`;
  const button = reset ? 'Choose a new password' : 'Create your account';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2430">
<h2 style="margin:0 0 12px">${title}</h2><p style="line-height:1.5">${lead}</p>
<p style="margin:24px 0"><a href="${escHtml(link)}" style="background:#5b3df0;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${button}</a></p>
${reset ? '' : '<p style="font-size:13px;color:#667;line-height:1.5">If you already use Ledger Desk, pick the same username there. You can use the same password for both, or a different one. Either works, and your Ledger Desk books stay untouched.</p>'}
<p style="font-size:13px;color:#667;line-height:1.5">This link works once and expires in ${INVITE_DAYS} days. If the button doesn’t work, paste this into your browser:<br>${escHtml(link)}</p>
<p style="font-size:12px;color:#99a">If you weren’t expecting this, you can ignore the email.</p></div>`;
  const text = `${title}\n\n${lead.replace(/&[a-z#0-9]+;/g, '')}\n\n${button}: ${link}\n\nThis link works once and expires in ${INVITE_DAYS} days. If you weren't expecting this, ignore this email.`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'PdfStudio <invites@trivedipos.com>', to: [to], subject: title, html, text }),
    });
    if (r.ok) return { emailed: true };
    let why = '';
    try { why = String((await r.json()).message || '').slice(0, 200); } catch { /* no body */ }
    return { emailed: false, emailError: `The email service refused it (${r.status}${why ? ': ' + why : ''}). Copy the link instead.` };
  } catch {
    return { emailed: false, emailError: 'Could not reach the email service. Copy the link instead.' };
  }
}

async function makeInvite(env, url, { email, role, userId = null, createdBy, send = false, inviter = 'The PdfStudio owner' }) {
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND created_at > ?').bind(createdBy, now - 3600000).first();
  if ((recent?.n || 0) >= MAX_INVITES_PER_HOUR) return { error: 'Too many invites in the last hour. Try again later.', status: 429 };
  const token = rand(24);
  await env.DB.prepare('INSERT INTO invites (id, token_hash, email, role, user_id, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(rand(8), await sha256(token), email, role, userId, now + INVITE_DAYS * 86400000, createdBy, now).run();
  const link = `${url.origin}/pdfstudio/join?token=${token}`;
  const out = { link, email, expiresInDays: INVITE_DAYS };
  if (send) Object.assign(out, await sendInviteEmail(env, { to: email, link, reset: !!userId, inviter }));
  return out;
}
const inviteResponse = (r) => r.error ? fail(r.status, r.error) : json(r);
