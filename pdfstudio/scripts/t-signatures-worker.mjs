// Unit test for the saved-signatures API of the worker (worker/esign.js handleSignatures), using Node's built-in SQLite as a stand-in for D1.
// Run:  node scripts/t-signatures-worker.mjs
import { DatabaseSync } from 'node:sqlite';
import { handleSignatures } from '../worker/esign.js';
const sql = new DatabaseSync(':memory:');
sql.exec('CREATE TABLE esign_signatures (owner_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, png TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, id))');
const stmt = (q, a = []) => ({
  bind: (...x) => stmt(q, x),
  run: async () => { sql.prepare(q).run(...a); return {}; },
  all: async () => ({ results: sql.prepare(q).all(...a) }),
  first: async () => sql.prepare(q).get(...a) ?? null,
});
const env = { DB: { prepare: (q) => stmt(q), batch: async (l) => { for (const s of l) await s.run(); } } };
let fails = 0; const check = (n, ok, i = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (i ? '  ' + i : '')); if (!ok) fails++; };
const raw = async (me, method, body) => handleSignatures(new Request('https://x/pdfstudio/api/esign/signatures', { method, body: body === undefined ? undefined : JSON.stringify(body) }), env, me);
const call = async (me, method, body) => (await raw(me, method, body)).json();
const png = (s) => 'data:image/png;base64,' + Buffer.from(s).toString('base64');
const A = { id: 'a' }, B = { id: 'b' };
let r = await call(A, 'GET'); check('empty', r.signatures.length === 0);
r = await call(A, 'POST', { kind: 'signature', signatures: [png('one'), png('two')] });
check('saves two, first sent is newest', r.signatures.length === 2 && r.signatures[0].png === png('one'));
r = await call(A, 'POST', { kind: 'signature', signatures: [png('one')] });
check('same picture not duplicated', r.signatures.length === 2);
r = await call(A, 'POST', { kind: 'initials', signatures: [png('ab')] });
check('initials kept separately', r.signatures.filter((s) => s.kind === 'initials').length === 1 && r.signatures.length === 3);
check('other user sees nothing', (await call(B, 'GET')).signatures.length === 0);
check('other user cannot delete mine', (await call(B, 'DELETE', { png: png('one') })).signatures.length === 0 && (await call(A, 'GET')).signatures.length === 3);
r = await call(A, 'POST', { kind: 'signature', signatures: ['data:image/jpeg;base64,AAAA', 'data:image/png;base64,<script>', 'hello', png('x'.repeat(300 * 1024))] });
check('bad / oversize refused', r.skipped === 4 && r.signatures.length === 3, 'skipped=' + r.skipped);
check('bad kind rejected', (await raw(A, 'POST', { kind: 'date', signatures: [png('z')] })).status === 400);
check('bad body rejected', (await handleSignatures(new Request('https://x/', { method: 'POST', body: 'zzz' }), env, A)).status === 400);
for (let i = 0; i < 35; i++) await call(A, 'POST', { kind: 'signature', signatures: [png('s' + i)] });
r = await call(A, 'GET');
const sigs = r.signatures.filter((s) => s.kind === 'signature');
check('max 30 per kind, newest kept', sigs.length === 30 && sigs.some((s) => s.png === png('s34')) && !sigs.some((s) => s.png === png('s0')));
check('initials untouched by signature limit', r.signatures.filter((s) => s.kind === 'initials').length === 1);
r = await call(A, 'DELETE', { png: png('s34') });
check('delete by picture', !r.signatures.some((s) => s.png === png('s34')));
const id = r.signatures[0].id;
r = await call(A, 'DELETE', { id });
check('delete by id', !r.signatures.some((s) => s.id === id));
check('delete needs a target', (await raw(A, 'DELETE', {})).status === 400);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
