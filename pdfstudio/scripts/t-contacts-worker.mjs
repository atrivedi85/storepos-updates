// Unit test for the saved-contacts API of the worker (worker/esign.js handleContacts), using Node's built-in SQLite as a stand-in for D1.
// Run:  node scripts/t-contacts-worker.mjs
import { DatabaseSync } from 'node:sqlite';
import { handleContacts } from '../worker/esign.js';
const sql = new DatabaseSync(':memory:');
sql.exec(`CREATE TABLE esign_contacts (owner_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, last_used INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner_id, email))`);
const stmt = (q, a = []) => ({
  bind: (...x) => stmt(q, x),
  run: async () => { sql.prepare(q).run(...a); return {}; },
  all: async () => ({ results: sql.prepare(q).all(...a) }),
  first: async () => sql.prepare(q).get(...a) ?? null,
});
const env = { DB: { prepare: (q) => stmt(q), batch: async (l) => { for (const s of l) await s.run(); } } };
let fails = 0; const check = (n, ok, i = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (i ? '  ' + i : '')); if (!ok) fails++; };
const call = async (me, method, body) => (await handleContacts(new Request('https://x/pdfstudio/api/esign/contacts', { method, body: body === undefined ? undefined : JSON.stringify(body) }), env, me)).json();
const A = { id: 'a' }, B = { id: 'b' };
let r = await call(A, 'GET'); check('empty list', r.contacts.length === 0);
r = await call(A, 'POST', { contacts: [{ name: 'Ann Lee', email: 'ANN@x.com' }, { name: 'Bob', email: 'bob@x.com', uses: 3 }, { name: '', email: 'no@x.com' }, { name: 'Bad', email: 'nope' }] });
check('saves valid, skips blank/bad', r.contacts.length === 2, JSON.stringify(r.contacts.map((c) => c.email)));
check('most used first', r.contacts[0].email === 'bob@x.com' && r.contacts[0].count === 3);
r = await call(A, 'POST', { contacts: [{ name: 'Ann Smith', email: 'ann@x.com' }] });
const ann = r.contacts.find((c) => c.email === 'ann@x.com');
check('same email: name updated, count added', ann.name === 'Ann Smith' && ann.count === 2, JSON.stringify(ann));
check('other user sees nothing', (await call(B, 'GET')).contacts.length === 0);
r = await call(A, 'DELETE', { email: 'Bob@x.com' });
check('delete one', r.contacts.length === 1 && r.contacts[0].email === 'ann@x.com');
check('bad body rejected', (await handleContacts(new Request('https://x/', { method: 'POST', body: 'zzz' }), env, A)).status === 400);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
