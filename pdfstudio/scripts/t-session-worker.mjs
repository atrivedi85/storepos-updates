// Unit test for the PdfStudio sign-in session rules in worker/api.js (route "me"):
//   - the session slides (renewed to 30 days, at most once a day) so active people stay signed in
//   - only a DEFINITE answer from Ledger Desk (401 or "disabled") signs the person out; hiccups never do
//   - a saved Bearer token works with or without the browser cookie (Android app), and puts the cookie back
// Uses Node's built-in SQLite as a stand-in for D1 and a fake Ledger Desk.   Run:  node scripts/t-session-worker.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handleApi } from '../worker/api.js';
import { sealToken } from '../worker/ledger.js';

const sql = new DatabaseSync(':memory:');
sql.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8').replace(/ALTER TABLE[^;]*;/g, ''));
const stmt = (q, a = []) => ({
  bind: (...x) => stmt(q, x),
  run: async () => { sql.prepare(q).run(...a); return {}; },
  all: async () => ({ results: sql.prepare(q).all(...a) }),
  first: async () => sql.prepare(q).get(...a) ?? null,
});
let ledger = { status: 200, data: { username: 'milan', admin: false } };
const env = {
  DB: { prepare: (q) => stmt(q), batch: async (l) => { for (const s of l) await s.run(); } },
  SESSION_SECRET: 'test-secret',
  LEDGER_SVC: { fetch: async () => {
    if (ledger.throw) throw new Error('down');
    return new Response(JSON.stringify(ledger.data), { status: ledger.status, headers: { 'content-type': 'application/json' } });
  } },
};
let fails = 0; const check = (n, ok, i = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (i ? '  ' + i : '')); if (!ok) fails++; };
const DAY = 86400000;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
sql.prepare("INSERT INTO users (id, username, email, pass_hash, salt, role, created_at) VALUES ('u1','milan','milan@ledger.invalid','ledger-desk','ledger-desk','user',1)").run();

let n = 0;
async function makeSession(daysLeft, sealedWith = env) {
  const token = (++n).toString(16).padStart(64, 'a');
  const sealed = await sealToken(sealedWith, 'b'.repeat(64));
  sql.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ledger_token) VALUES (?,?,?,?,?)').run(await sha(token), 'u1', Date.now(), Date.now() + daysLeft * DAY, sealed);
  return token;
}
const expiry = async (t) => sql.prepare('SELECT expires_at e FROM sessions WHERE token_hash = ?').get(await sha(t))?.e;
const me = async (headers) => {
  const r = await handleApi(new Request('https://trivedipos.com/pdfstudio/api/me', { headers }), env, new URL('https://trivedipos.com/pdfstudio/api/me'));
  return { status: r.status, cookie: r.headers.get('set-cookie') || '', j: await r.json() };
};
const viaCookie = (t) => ({ cookie: `pdfs_session=${t}` });
const viaBearer = (t) => ({ authorization: `Bearer ${t}` });

// 1. sliding
let t = await makeSession(5);
let r = await me(viaCookie(t));
let e = await expiry(t);
check('me ok', r.status === 200 && r.j.user.username === 'milan');
check('session with 5 days left is renewed to ~30 days', Math.abs(e - (Date.now() + 30 * DAY)) < 60000, String((e - Date.now()) / DAY));
check('new cookie sent with 30 day life', /pdfs_session=.*Max-Age=2592000/.test(r.cookie));
check('reply carries the new expiry', r.j.expiresAt === e);
// 2. no write when fresh
t = await makeSession(29.5);
const before = await expiry(t);
r = await me(viaCookie(t));
check('fresh session is not rewritten (at most once a day)', (await expiry(t)) === before && r.status === 200);
// 3. transient Ledger problems keep the session
for (const [name, l] of [['unreachable', { throw: true, status: 0 }], ['502', { status: 502, data: {} }], ['503', { status: 503, data: {} }], ['429', { status: 429, data: {} }]]) {
  t = await makeSession(10); ledger = l;
  r = await me(viaCookie(t));
  check(`Ledger ${name}: stays signed in`, r.status === 200 && (await expiry(t)) !== undefined);
}
// 4. a saved token that cannot be decrypted is not a reason to sign out
t = await makeSession(10, { SESSION_SECRET: 'some-older-secret' }); ledger = { status: 200, data: { username: 'milan' } };
r = await me(viaCookie(t));
check('undecryptable Ledger token: stays signed in', r.status === 200 && (await expiry(t)) !== undefined);
// 5. definite answers sign out
t = await makeSession(10); ledger = { status: 401, data: { error: 'Please sign in again.' } };
r = await me(viaCookie(t));
check('Ledger 401: signed out and session removed', r.status === 401 && (await expiry(t)) === undefined && /Max-Age=0/.test(r.cookie));
t = await makeSession(10); ledger = { status: 200, data: { username: 'milan', disabled: true } };
r = await me(viaCookie(t));
check('Ledger says disabled: 403 and session removed', r.status === 403 && (await expiry(t)) === undefined);
ledger = { status: 200, data: { username: 'milan', admin: false } };
// 6. bearer
t = await makeSession(10);
r = await me(viaBearer(t));
check('Bearer token works without a cookie', r.status === 200);
check('Bearer without cookie: cookie is put back', /pdfs_session=/.test(r.cookie));
r = await me({ ...viaBearer('f'.repeat(64)), ...viaCookie(t) });
check('stale Bearer + good cookie still signs in', r.status === 200);
r = await me(viaBearer('e'.repeat(64)));
check('unknown Bearer: 401', r.status === 401);
r = await me({});
check('no credentials: 401', r.status === 401);
// 7. expired session is refused
t = await makeSession(-1);
check('expired session refused', (await me(viaCookie(t))).status === 401);
// 8. logout removes the session
t = await makeSession(10);
await handleApi(new Request('https://trivedipos.com/pdfstudio/api/logout', { method: 'POST', headers: { ...viaBearer(t), origin: 'https://trivedipos.com' } }), env, new URL('https://trivedipos.com/pdfstudio/api/logout'));
check('logout removes the session', (await expiry(t)) === undefined);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
