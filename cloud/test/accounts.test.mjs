// Run:  node --import ./cloud/test/hooks.mjs --test cloud/test/
// Runs the real Worker code (index.js, Hub, Ledger, pos.js) in Node and the real store-PC code (source/app/acct.js).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { start } from './harness.mjs';
import { seal, open } from './fakepc.mjs';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { WebSocket: WS } = createRequire('/opt/npm-tools/node_modules/')('ws');
const PC = require('../../source/app/acct.js');
globalThis.window = globalThis;
await import('../../ledger/app/vault.js');
const V = globalThis.LDVault;

let h, owner, bob, carol, dina;
const PW = 'correct horse battery';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Browser {   // a person's browser: cookies + the Ledger Desk key logic from vault.js
  constructor(base) { this.base = base; this.jar = {}; }
  async call(method, path, body, extra) {
    const cookie = Object.entries(this.jar).map(([k, v]) => k + '=' + v).join('; ');
    const r = await fetch(this.base + path, { method, headers: { 'x-ld': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(extra || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const m = /^([a-z_]+)=([^;]*)/.exec(c); if (m) { if (m[2] === '') delete this.jar[m[1]]; else this.jar[m[1]] = m[2]; } }
    let data = {}; try { data = await r.json(); } catch (e) { /* none */ }
    return { status: r.status, data };
  }
  get cookie() { return Object.entries(this.jar).map(([k, v]) => k + '=' + v).join('; '); }
  async signIn(username, pw = PW) {
    this.username = username;
    const r = await this.call('POST', '/api/login', { username, auth: await V.authFor(username, pw) });
    assert.equal(r.status, 200, JSON.stringify(r.data)); this.vault = r.data.vault;
    this.dek = await V.unlockWithPassword(r.data.vault, pw); return r.data;
  }
  async ensureKeys() {   // what the web back office does on first use (and Ledger Desk does on open)
    let me = (await this.call('GET', '/api/me')).data;
    if (!me.pub) { const pk = await V.newPersonKeys(this.dek); const r = await this.call('POST', '/api/me/keys', pk); assert.equal(r.status, 200); me = (await this.call('GET', '/api/me')).data; }
    this.me = me; this.priv = await V.openPrivate(this.dek, me.priv); return me;
  }
  async storeKey(storeId) {
    const { data } = await this.call('GET', '/api/pos/stores'); const s = data.stores.find(x => x.storeId === storeId);
    if (!s || !s.wrappedKey) return null;
    const k = await V.unlockCompanyKey(this.priv, s.wrappedKey);
    return Buffer.from(await crypto.subtle.exportKey('raw', k)).toString('base64');
  }
}
async function makeUser(L, username, name, admin) {   // the owner login can only be made with a private one-time code, so tests write it directly
  const nv = await V.newVault(PW), u = { username, name, admin: !!admin, created: new Date().toISOString(), vault: nv.vault };
  L.setPw(u, await V.authFor(username, PW)); L.setRec(u, await V.recAuthFor(username, nv.recovery)); L.saveUser(u); return nv.recovery;
}
function connect(base, storeId, role, key, { cid, cookie, mode } = {}) {
  const auth = PC.relayAuth(key);
  const url = base.replace('http', 'ws') + '/v1/store/' + storeId + '/ws?role=' + role + '&auth=' + auth + (cid ? '&cid=' + cid : '') + (mode ? '&mode=' + mode : '');
  return new Promise((resolve, reject) => {
    const ws = new WS(url, { headers: cookie ? { cookie } : {} }); ws.msgs = []; ws.closed = null;
    ws.on('message', d => ws.msgs.push(JSON.parse(d.toString())));
    ws.on('close', (code, reason) => { ws.closed = { code, reason: reason.toString() }; });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (rq, res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => reject(Object.assign(new Error('refused ' + res.statusCode + ' ' + b), { status: res.statusCode }))); });
    ws.on('error', () => { /* handled by unexpected-response */ });
  });
}
const waitFor = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(20); } throw new Error('timed out'); };

const store = { storeId: crypto.randomBytes(16).toString('base64url'), key: crypto.randomBytes(32).toString('base64'), name: 'Test Smoke Shop' };
let host, device;

before(async () => { h = await start(); await fetch(h.url + '/api/setup-needed'); });
after(() => h.close());

test('Ledger Desk sign-in and invite flow still work', async () => {
  const L = h.inst('ledger|main'); await makeUser(L, 'raj', 'Raj Owner', true);
  owner = new Browser(h.url); const r = await owner.signIn('raj'); assert.ok(r.ok && r.vault);
  assert.equal((await owner.call('GET', '/api/me')).data.username, 'raj');
  assert.equal((await owner.call('POST', '/api/login', { username: 'raj', auth: await V.authFor('raj', 'wrong password!') })).status, 401);
  // admin invite -> new account (the existing flow, no store involved)
  const inv = await owner.call('POST', '/api/admin/invite', { name: 'Carol' }); assert.equal(inv.status, 200);
  carol = new Browser(h.url); const nv = await V.newVault(PW);
  const acc = await carol.call('POST', '/api/invite/accept', { code: inv.data.code, name: 'Carol', username: 'carol', auth: await V.authFor('carol', PW), recAuth: await V.recAuthFor('carol', nv.recovery), vault: nv.vault });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  await carol.signIn('carol'); assert.equal((await carol.call('GET', '/api/me')).data.posOnly, false);   // normal invites are untouched
  await owner.ensureKeys();
});

test('store PC links the store to the owner account (device token, no password kept)', async () => {
  host = await connect(h.url, store.storeId, 'host', store.key); host.send('{"t":"hello"}');
  const s1 = await PC.signIn(h.url, 'raj', 'wrong password!').catch(e => e); assert.ok(s1 instanceof Error);
  const s = await PC.signIn(h.url, 'raj', PW); assert.ok(s.session.cookie);
  const r = await PC.linkStore(h.url, s.session, PW, store); assert.match(r.deviceToken, /^[a-f0-9]{64}$/); device = r.deviceToken;
  assert.equal(r.user, 'raj');
  assert.equal((await owner.call('GET', '/api/me')).data.pub != null, true);
  // the PC's temporary sign-in was ended
  assert.equal((await new Browser(h.url).call('GET', '/api/me')).status, 401);
  // someone else can't take over a store that is already linked
  const L = h.inst('ledger|main'); await carol.ensureKeys();
  const sc = await PC.signIn(h.url, 'carol', PW);
  await assert.rejects(PC.linkStore(h.url, sc.session, PW, store), /already linked/);
  // a store the relay has never seen can't be linked at all
  await assert.rejects(PC.linkStore(h.url, (await PC.signIn(h.url, 'carol', PW)).session, PW, { ...store, storeId: crypto.randomBytes(16).toString('base64url') }), /not connected/);
  void L;
});

test('owner sees the store and opens the key in the browser; the server holds no plain key', async () => {
  const { data } = await owner.call('GET', '/api/pos/stores'); assert.equal(data.stores.length, 1);
  assert.equal(data.stores[0].role, 'owner'); assert.equal(data.stores[0].name, store.name);
  assert.equal(await owner.storeKey(store.storeId), store.key);
  assert.equal((await carol.call('GET', '/api/pos/stores')).data.stores.length, 0);
  // nothing stored anywhere contains the key (plain, url-safe, hex) or the relay password
  const raw = Buffer.from(store.key, 'base64'), forms = [store.key, raw.toString('hex'), raw.toString('base64url'), PC.relayAuth(store.key)];
  let rows = 0;
  for (const [id, inst] of h.instances) {
    const db = inst.ctx.storage.sql.db;
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name)) for (const row of db.prepare('SELECT * FROM ' + t).all()) { rows++; const txt = JSON.stringify(row); for (const f of forms) assert.ok(!txt.includes(f), 'found the store key in ' + id + '.' + t); }
  }
  assert.ok(rows > 5);
});

test('invite a new person by email, they sign up, the store PC approves, they open the store', async () => {
  const r = await owner.call('POST', '/api/pos/members/invite', { storeId: store.storeId, who: 'bob@example.com', role: 'cashier' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.invited, true); assert.equal(r.data.emailed, false);
  const code = new URL(r.data.link).searchParams.get('code'); assert.equal(new URL(r.data.link).searchParams.get('next'), '/pos/');
  assert.equal((await owner.call('GET', '/api/pos/members?storeId=' + store.storeId)).data.invites.length, 1);
  bob = new Browser(h.url); const nv = await V.newVault(PW);
  const acc = await bob.call('POST', '/api/invite/accept', { code, name: 'Bob', username: 'bob', auth: await V.authFor('bob', PW), recAuth: await V.recAuthFor('bob', nv.recovery), vault: nv.vault });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  await bob.signIn('bob');
  let list = (await bob.call('GET', '/api/pos/stores')).data.stores; assert.equal(list.length, 1); assert.equal(list[0].role, 'cashier'); assert.equal(list[0].pending, true); assert.equal(list[0].wrappedKey, null);
  const me = (await bob.call('GET', '/api/me')).data; assert.equal(me.posOnly, true); assert.equal(me.email, 'bob@example.com');
  await bob.ensureKeys();
  // the store PC (device token only) hands over a locked copy
  assert.equal(await PC.approvePending(h.url, device, store.key), 1);
  assert.equal(await bob.storeKey(store.storeId), store.key);
  // not allowed to make Ledger Desk companies (made for the back office only)
  assert.equal((await bob.call('POST', '/api/companies/create?file=c-0123456789abcdef.json', {})).status, 403);
  // alternatively the owner's browser can approve (second route)
  const nv2 = await V.newVault(PW); const inv2 = await owner.call('POST', '/api/pos/members/invite', { storeId: store.storeId, who: 'dina@example.com', role: 'reports' });
  dina = new Browser(h.url);
  await dina.call('POST', '/api/invite/accept', { code: new URL(inv2.data.link).searchParams.get('code'), name: 'Dina', username: 'dina', auth: await V.authFor('dina', PW), recAuth: await V.recAuthFor('dina', nv2.recovery), vault: nv2.vault });
  await dina.signIn('dina'); await dina.ensureKeys();
  const pend = (await owner.call('GET', '/api/pos/pending')).data.pending; assert.equal(pend.length, 1); assert.equal(pend[0].username, 'dina');
  const ck = await V.unlockCompanyKey(owner.priv, (await owner.call('GET', '/api/pos/stores')).data.stores[0].wrappedKey);
  const wrapped = await V.lockCompanyKeyFor(pend[0].pub, ck);
  assert.equal((await owner.call('POST', '/api/pos/members/wrap', { storeId: store.storeId, username: 'dina', wrappedKey: wrapped })).status, 200);
  assert.equal(await dina.storeKey(store.storeId), store.key);
  // a non-owner can't manage members; a stranger can't read the members
  assert.equal((await bob.call('GET', '/api/pos/members?storeId=' + store.storeId)).status, 403);
  assert.equal((await carol.call('GET', '/api/pos/members?storeId=' + store.storeId)).status, 403);
  assert.equal((await bob.call('POST', '/api/pos/members/invite', { storeId: store.storeId, who: 'x@y.com', role: 'owner' })).status, 403);
  // inviting someone who already has an account just adds them
  const add = await owner.call('POST', '/api/pos/members/invite', { storeId: store.storeId, who: 'carol', role: 'manager' }); assert.equal(add.data.added, true);
});

test('relay: web browsers need a session AND membership; the store PC is told who is asking', async () => {
  const bws = await connect(h.url, store.storeId, 'client', store.key, { cid: 'web-bob-1', cookie: bob.cookie, mode: 'acct' });
  bws.send(JSON.stringify({ t: 'req', id: 'r1', enc: 'x', acct: { u: 'raj', r: 'owner' } }));   // a forged claim
  const got = await waitFor(() => host.msgs.find(m => m.t === 'req' && m.id === 'r1'));
  assert.deepEqual(got.acct, { u: 'bob', r: 'cashier' });
  // no cookie / wrong person / not a member of this store
  await assert.rejects(connect(h.url, store.storeId, 'client', store.key, { cid: 'web-x-1', mode: 'acct' }), e => e.status === 403);
  const stranger = new Browser(h.url); await makeUser(h.inst('ledger|main'), 'eve', 'Eve', false); await stranger.signIn('eve');
  await assert.rejects(connect(h.url, store.storeId, 'client', store.key, { cid: 'web-eve-1', cookie: stranger.cookie, mode: 'acct' }), e => e.status === 403);
  // an ordinary code-paired tablet (HMAC only) still connects, and carries no account claim
  const tab = await connect(h.url, store.storeId, 'client', store.key, { cid: 'tablet-1' });
  tab.send(JSON.stringify({ t: 'req', id: 'r2', enc: 'y', acct: { u: 'raj', r: 'owner' } }));
  const g2 = await waitFor(() => host.msgs.find(m => m.t === 'req' && m.id === 'r2')); assert.equal(g2.acct, undefined);
  // wrong HMAC is still refused
  await assert.rejects(connect(h.url, store.storeId, 'client', crypto.randomBytes(32).toString('base64'), { cid: 'tablet-2' }), e => e.status === 403);
  tab.close(); bws.close();
});

/* ---------- roles: who gets PINs, who can write (the store PC decides; this runs the real filter code from acct.js behind the real relay) ---------- */
test('store PC filters by the relay-stamped role: owner gets everything, others no PINs, reports cannot write, code-paired devices unchanged', async () => {
  // a small stand-in for lanHandle() in main.js: same calls (deviceAllowed, canWrite, guardOps, filterFor), same order
  const kv = { users: [{ id: 'u1', name: 'Owner', pin: '1111', role: 'admin', pay: { rate: 15 } }, { id: 'u2', name: 'Sam', pin: '2222', role: 'cashier', perms: { txn_view: true } }], settings: { storeName: 'Test', nextOrder: 5, smtpPass: 'hunter2' } };
  const tablets = [];
  const pc = (r, acct) => {
    const role = acct ? acct.r : null, body = r.body || {};
    if (r.path === '/pair') { if (!acct) return { status: 403, error: 'code needed' }; const t = { id: 'a:' + acct.u, token: crypto.randomBytes(8).toString('hex'), acct: { user: acct.u } }; tablets.push(t); return { token: t.token }; }
    const t = tablets.find(x => x.token === r.token); if (!t || !PC.deviceAllowed(t, acct)) return { status: 401, error: 'not allowed' };
    if (Array.isArray(body.ops) && body.ops.length) {
      if (acct && !PC.canWrite(acct.r)) return { status: 403, error: 'Your account can look at reports but not change anything.' };
      for (const op of PC.guardOps(role, body.ops, k => kv[k] || null).ops) kv[op.key] = op.data;
    }
    return PC.filterFor(role, { items: Object.entries(kv).map(([k, v]) => ({ store: 'kv', key: k, data: v })), seq: 1 });
  };
  const onMsg = d => { let m; try { m = JSON.parse(d.toString()); } catch (e) { return; } if (m.t !== 'req' || !m.enc || !m.enc.startsWith('p.')) return; let out; try { out = pc(open(store.key, m.enc), m.acct); } catch (e) { return; } host.send(JSON.stringify({ t: 'res', id: m.id, to: m.from, enc: seal(store.key, out && out.status ? { status: out.status, error: out.error } : out, false) })); };
  host.on('message', onMsg);
  const ask = async (ws, path, token, body) => { const id = 'q' + crypto.randomBytes(4).toString('hex'); ws.send(JSON.stringify({ t: 'req', id, enc: seal(store.key, { path, token, body }, false) })); const m = await waitFor(() => ws.msgs.find(x => x.t === 'res' && x.id === id)); return open(store.key, m.enc); };
  const web = async (b, cid) => { const ws = await connect(h.url, store.storeId, 'client', store.key, { cid, cookie: b.cookie, mode: 'acct' }); const { token } = await ask(ws, '/pair', '', { deviceId: cid }); return { ws, token }; };
  const usersOf = r => r.items.find(i => i.key === 'users').data, settingsOf = r => r.items.find(i => i.key === 'settings').data;
  const owner1 = await web(owner, 'web-raj-9'), mgr = await web(carol, 'web-carol-9'), rep = await web(dina, 'web-dina-9');
  // owner: everything, untouched
  let r = await ask(owner1.ws, '/sync', owner1.token, { snap: { stage: 'kv' } });
  assert.equal(usersOf(r)[1].pin, '2222'); assert.equal(settingsOf(r).smtpPass, 'hunter2');
  // manager and reports: no PINs or other secrets, but names, roles, permissions and pay stay
  for (const who of [mgr, rep]) {
    r = await ask(who.ws, '/sync', who.token, { snap: { stage: 'kv' } });
    for (const u of usersOf(r)) { assert.equal(u.pin, undefined); assert.equal(u.hasPin, true); }
    assert.deepEqual([usersOf(r)[1].id, usersOf(r)[1].name, usersOf(r)[1].role, usersOf(r)[1].perms], ['u2', 'Sam', 'cashier', { txn_view: true }]);
    assert.equal(settingsOf(r).smtpPass, undefined); assert.equal(settingsOf(r).storeName, 'Test');
    assert.ok(!JSON.stringify(r).includes('2222') && !JSON.stringify(r).includes('hunter2'));
  }
  // reports cannot write at all; the store PC says so
  const nope = await ask(rep.ws, '/sync', rep.token, { ops: [{ store: 'kv', key: 'settings', data: { storeName: 'Hacked' } }] });
  assert.equal(nope.status, 403); assert.equal(kv.settings.storeName, 'Test');
  // manager: normal writes work, but cannot touch users, and a settings write cannot wipe the PC's secrets
  await ask(mgr.ws, '/sync', mgr.token, { ops: [{ store: 'kv', key: 'users', data: [{ id: 'u1', name: 'Owner', role: 'admin' }] }, { store: 'kv', key: 'settings', data: { storeName: 'Test', nextOrder: 9 } }] });
  assert.equal(kv.users[1].pin, '2222'); assert.equal(kv.users.length, 2); assert.equal(kv.settings.nextOrder, 9); assert.equal(kv.settings.smtpPass, 'hunter2');
  // a code-paired device (no account stamp, as tablets and linked PCs) is unchanged: full copy including PINs, writes allowed
  const legacy = await connect(h.url, store.storeId, 'client', store.key, { cid: 'tablet-7' });
  tablets.push({ id: 'tablet-7', token: 'legacytok' }); r = await ask(legacy, '/sync', 'legacytok', { snap: { stage: 'kv' } });
  assert.equal(usersOf(r)[1].pin, '2222');
  // the filter itself: unknown roles are treated as the strictest; nothing is stripped when there is no stamp
  assert.equal(PC.canWrite('hacker'), false); assert.equal(PC.canWrite(undefined), false);
  assert.equal(PC.filterFor('hacker', { result: { pin: '1', ok: 2 } }).result.pin, undefined);
  assert.equal(PC.filterFor(null, { result: { pin: '1' } }).result.pin, '1');
  // main.js really uses it on all three answers and on writes
  const src = fs.readFileSync(new URL('../../source/app/main.js', import.meta.url), 'utf8');
  assert.equal((src.match(/ACCT\.filterFor\(role,/g) || []).length, 3); assert.match(src, /ACCT\.guardOps\(role, body\.ops/); assert.match(src, /req\.acct && !ACCT\.canWrite\(req\.acct\.r\)/);
  host.off('message', onMsg); for (const x of [owner1, mgr, rep]) x.ws.close(); legacy.close();
});

test('removed / changed / signed-out people are cut off at once', async () => {
  const mk = async (b, cid) => connect(h.url, store.storeId, 'client', store.key, { cid, cookie: b.cookie, mode: 'acct' });
  // role change closes the connection so it comes back with the new role
  let w = await mk(bob, 'web-bob-2');
  assert.equal((await owner.call('POST', '/api/pos/members/role', { storeId: store.storeId, username: 'bob', role: 'manager' })).status, 200);
  await waitFor(() => w.closed); assert.equal(w.closed.code, 4003);
  w = await mk(bob, 'web-bob-3'); w.send(JSON.stringify({ t: 'req', id: 'r3', enc: 'z' }));
  assert.equal((await waitFor(() => host.msgs.find(m => m.id === 'r3'))).acct.r, 'manager');
  // removal: connection closes, a new account connection is refused, and the store PC would refuse the old device token
  const tablet = { id: 'web-bob-3', acct: { user: 'bob' } };
  assert.equal(PC.deviceAllowed(tablet, { u: 'bob', r: 'manager' }), true);
  assert.equal((await owner.call('POST', '/api/pos/members/remove', { storeId: store.storeId, username: 'bob' })).status, 200);
  await waitFor(() => w.closed); assert.equal(w.closed.code, 4003);
  await assert.rejects(mk(bob, 'web-bob-4'), e => e.status === 403);
  assert.equal((await bob.call('GET', '/api/pos/stores')).data.stores.length, 0);
  // bob still has the store key; with it he can connect as a plain client, but the store PC gets no account claim and refuses his token
  const plain = await connect(h.url, store.storeId, 'client', store.key, { cid: 'web-bob-3' });   // same device id as before
  plain.send(JSON.stringify({ t: 'req', id: 'r4', enc: 'q' }));
  const g4 = await waitFor(() => host.msgs.find(m => m.id === 'r4')); assert.equal(g4.acct, undefined);
  assert.equal(PC.deviceAllowed(tablet, g4.acct), false);
  assert.equal(PC.deviceAllowed(tablet, { u: 'raj', r: 'owner' }), false);   // someone else's claim doesn't help either
  assert.equal(PC.deviceAllowed(tablet, { u: 'bob', r: 'hacker' }), false);
  assert.equal(PC.deviceAllowed({ id: 't' }, undefined), true);              // ordinary paired tablets keep working
  assert.equal(PC.canWrite('reports'), false); plain.close();
  // heartbeat tells the PC who is still a member (so it can forget removed people's tokens)
  const hb = await PC.deviceHeartbeat(h.url, device, { name: store.name, devices: [{ name: 'Front tablet', reg: 2, lastSeen: Date.now() }] });
  assert.ok(hb.members.includes('raj') && !hb.members.includes('bob'));
  // the owner sees the PC's devices
  assert.equal((await owner.call('GET', '/api/pos/members?storeId=' + store.storeId)).data.devices[0].name, 'Front tablet');
});

test('even if a kick is missed, the relay re-checks the account every minute; sign-out and device sign-out cut the connection', async () => {
  const mk = async (b, cid) => connect(h.url, store.storeId, 'client', store.key, { cid, cookie: b.cookie, mode: 'acct' });
  let w = await mk(dina, 'web-dina-1');
  // remove directly in the database (no kick) and make the relay's last check look old
  h.inst('ledger|main').ctx.storage.sql.exec("DELETE FROM store_members WHERE user='dina'");
  for (const s of h.inst('hub|store:' + store.storeId).ctx.getWebSockets('u:dina')) { const a = s.deserializeAttachment(); a.chk = 0; s.serializeAttachment(a); }
  w.send(JSON.stringify({ t: 'ping' })); await waitFor(() => w.closed); assert.equal(w.closed.code, 4003);
  // sign out
  const c2 = new Browser(h.url); await c2.signIn('carol'); w = await mk(c2, 'web-carol-1');
  await c2.call('POST', '/api/logout', {}); await waitFor(() => w.closed); assert.equal(w.closed.code, 4003);
  // sessions list and "sign out this device"
  const c3 = new Browser(h.url), c4 = new Browser(h.url); await c3.signIn('carol'); await c4.signIn('carol');
  const ss = (await c3.call('GET', '/api/sessions')).data.sessions; assert.ok(ss.length >= 2); assert.equal(ss.filter(x => x.current).length, 1);
  const other = ss.find(x => !x.current); w = await mk(c4, 'web-carol-2');
  const own4 = (await c4.call('GET', '/api/sessions')).data.sessions.find(x => x.current);
  assert.equal((await c3.call('POST', '/api/sessions/revoke', { id: own4.id })).status, 200);
  await waitFor(() => w.closed); assert.equal((await c4.call('GET', '/api/me')).status, 401);
  assert.equal((await c3.call('GET', '/api/me')).status, 200); void other;
});

test('the cloud-code pairing fallback still works', async () => {
  const code = crypto.randomBytes(8).toString('hex').slice(0, 16), id = code + code;
  const put = await fetch(h.url + '/v1/pair/' + id, { method: 'PUT', body: 'p.sealed-offer' }); assert.equal(put.status, 200);
  const got = await (await fetch(h.url + '/v1/pair/' + id)).json(); assert.equal(got.blob, 'p.sealed-offer');
  assert.equal((await fetch(h.url + '/v1/pair/' + 'a'.repeat(32))).status, 404);
  const t = await connect(h.url, store.storeId, 'client', store.key, { cid: 'tablet-9' }); t.close();
  // the relay's private paths can't be reached from outside
  assert.equal((await fetch(h.url + '/v1/store/' + store.storeId + '/internal/kick?user=raj')).status, 404);
  assert.equal((await fetch(h.url + '/api/pos/internal/check?store=' + store.storeId + '&user=raj&sid=x')).status, 404);
  // a store PC with a wrong or missing device token gets nothing
  assert.equal((await new Browser(h.url).call('POST', '/api/pos/device/pending', {}, { 'x-pos-device': 'f'.repeat(64) })).status, 401);
});

test('owner can unlink the store; members lose it; PC token stops working', async () => {
  assert.equal((await owner.call('POST', '/api/pos/store/unlink', { storeId: store.storeId })).status, 200);
  assert.equal((await owner.call('GET', '/api/pos/stores')).data.stores.length, 0);
  await assert.rejects(PC.devicePending(h.url, device), /not linked/);
  host.close();
});

/* ---------- sign in with email or user name; POS-only switch ---------- */
const b32 = x => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = []; for (const c of x) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totp = secret => { const st = Math.floor(Date.now() / 30000), m = Buffer.alloc(8); m.writeUInt32BE(Math.floor(st / 4294967296), 0); m.writeUInt32BE(st >>> 0, 4); const h = crypto.createHmac('sha1', b32(secret)).update(m).digest(), o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };
async function loginAs(id, pw = PW, extra) {   // exactly what the sign-in page does: resolve the email first, then derive the sign-in value from the user name
  const b = new Browser(h.url);
  const name = id.includes('@') ? (await b.call('POST', '/api/login/resolve', { id })).data.username : id.toLowerCase();
  const r = await b.call('POST', '/api/login', { username: name, auth: await V.authFor(name, pw) }); b.name = name; b.r = r; return b;
}
let erinRec;
test('sign in with email or user name', async () => {
  const L = h.inst('ledger|main');
  erinRec = await makeUser(L, 'erin', 'Erin Staff', false);
  const e = L.findUser('erin'); e.email = 'Erin@Example.com'; L.saveUser(e);
  for (const id of ['erin@example.com', 'ERIN@EXAMPLE.COM', 'erin', 'Erin']) { const b = await loginAs(id); assert.equal(b.r.status, 200, id); assert.equal((await b.call('GET', '/api/me')).data.username, 'erin'); }
  assert.equal((await loginAs('erin@example.com', 'wrong password!')).r.status, 401);
  assert.equal((await loginAs('nobody@example.com')).r.status, 401);                       // unknown email: same answer as a wrong password
  assert.equal((await new Browser(h.url).call('POST', '/api/login/resolve', { id: 'nobody@example.com' })).data.username, 'nobody@example.com');
  // an invited person's email works too (set when the invite was accepted)
  assert.equal((await loginAs('bob@example.com')).r.status, 200);
  assert.ok((await PC.signIn(h.url, ' Erin@Example.com ', PW)).session.cookie);               // the store-PC link screen takes an email too
  // two accounts with the same email (old data): the email is not used, user names still work
  const d = L.findUser('carol'); d.email = 'erin@example.com'; L.saveUser(d);
  assert.equal((await new Browser(h.url).call('POST', '/api/login/resolve', { id: 'erin@example.com' })).data.username, 'erin@example.com');
  assert.equal((await loginAs('carol')).r.status, 200); delete d.email; L.saveUser(d);
});
test('two-step sign-in and password reset still work with an email sign-in', async () => {
  const b = await loginAs('erin@example.com'); await b.signIn('erin');
  const st = (await b.call('POST', '/api/me/2fa', { action: 'app-start' })).data;
  assert.equal((await b.call('POST', '/api/me/2fa', { action: 'app-confirm', code: totp(st.secret) })).status, 200);
  const b2 = await loginAs('erin@example.com'); assert.ok(b2.r.data.need2fa === 'app' && b2.r.data.ticket);
  assert.equal((await b2.call('POST', '/api/login/2fa', { ticket: b2.r.data.ticket, code: '000000' })).status, 401);
  const ok = await b2.call('POST', '/api/login/2fa', { ticket: b2.r.data.ticket, code: totp(st.secret) }); assert.equal(ok.status, 200); assert.equal((await b2.call('GET', '/api/me')).status, 200);
  // forgot password: the form resolves the email, then uses the recovery code
  const name = (await b2.call('POST', '/api/login/resolve', { id: 'Erin@Example.com' })).data.username; assert.equal(name, 'erin');
  const recAuth = await V.recAuthFor(name, erinRec), anon = new Browser(h.url);
  const chk = await anon.call('POST', '/api/recover/check', { username: name, recAuth }); assert.equal(chk.status, 200);
  const dek = await V.unlockWithRecovery({ rec: chk.data.rec }, erinRec);
  assert.equal((await anon.call('POST', '/api/recover', { username: name, recAuth, auth: await V.authFor(name, 'a brand new password'), vaultPw: await V.passwordWrap(dek, 'a brand new password') })).status, 200);
  assert.equal((await loginAs('erin@example.com', 'a brand new password')).r.data.need2fa, 'app');
  // an email can belong to one account only
  const taken = await carol.call('POST', '/api/me/2fa', { action: 'email-send', email: 'ERIN@example.com' }); assert.equal(taken.status, 400); assert.match(taken.data.error, /another account/);
});
test('invited staff are store-back-office only; the owner can switch Ledger Desk on and off', async () => {
  const bobIn = await loginAs('bob'); assert.equal((await bobIn.call('GET', '/api/me')).data.posOnly, true);
  const mk = (b) => b.call('POST', '/api/companies/create?file=c-0123456789abcdef.json', {});
  assert.equal((await mk(bobIn)).status, 403);
  const list = (await owner.call('GET', '/api/admin/users')).data.users; const bu = list.find(u => u.username === 'bob'); assert.equal(bu.posOnly, true); assert.equal(bu.email, 'bob@example.com'); assert.equal(list.find(u => u.username === 'carol').posOnly, false);
  assert.equal((await bobIn.call('POST', '/api/admin/pos-only', { username: 'bob', value: false })).status, 403);     // only the site owner
  assert.equal((await owner.call('POST', '/api/admin/pos-only', { username: 'bob', value: false })).status, 200);
  assert.equal((await bobIn.call('GET', '/api/me')).data.posOnly, false); assert.notEqual((await mk(bobIn)).status, 403);
  assert.equal((await owner.call('POST', '/api/admin/pos-only', { username: 'bob', value: true })).status, 200);
  assert.equal((await mk(bobIn)).status, 403);
});
