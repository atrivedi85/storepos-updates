// Trivedi accounts for Store POS: which stores a Trivedi account belongs to, and who may open them.
// This file runs inside the Ledger Desk Durable Object ("Ledger"), so it uses the very same accounts and sessions.
//
// The server NEVER holds a store key in plain. Each member's copy of the store key is locked (RSA-OAEP) with that
// member's own public key (the same per-person key pair Ledger Desk uses for sharing companies). Only the member's
// browser (unlocked with their password) can open it. The server stores the locked copy and hands it to that member.
//
// Cutting someone off does not rely on them forgetting a key: the relay (Hub) only lets a web browser in when it has a
// valid account session AND is a current member; removing a member closes their connections at once, and the store PC
// only answers an account-made device token when the relay vouches for that same person on the same request.
const ROLES = ['owner', 'manager', 'cashier', 'reports'];
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const validWrapped = k => typeof k === 'string' && /^[A-Za-z0-9+/=]{300,1200}$/.test(k);

export function posInit(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS stores(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, created INTEGER NOT NULL, dev_hash TEXT, devices TEXT, seen INTEGER);
    CREATE TABLE IF NOT EXISTS store_members(store_id TEXT NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL, wrapped TEXT, added_by TEXT, created INTEGER NOT NULL, PRIMARY KEY(store_id, user));`);
  try { sql.exec('ALTER TABLE sessions ADD COLUMN created INTEGER'); } catch (e) { /* already there */ }
  try { sql.exec('ALTER TABLE sessions ADD COLUMN ua TEXT'); } catch (e) { /* already there */ }
  try { sql.exec('ALTER TABLE sessions ADD COLUMN ip TEXT'); } catch (e) { /* already there */ }
}

const hubOf = (L, id) => L.env.HUB.get(L.env.HUB.idFromName('store:' + id));
async function hubCall(L, id, op, qs) {
  try { const r = await hubOf(L, id).fetch(new Request('https://hub/v1/store/' + id + '/internal/' + op + (qs ? '?' + qs : ''))); return await r.json(); } catch (e) { return {}; }
}
/** Close this person's open connections to a store (or all their stores) so a change takes effect at once. */
export async function posKick(L, user, storeId) {
  const ids = storeId ? [storeId] : L.rows('SELECT store_id FROM store_members WHERE user=?', user).map(r => r.store_id);
  for (const id of ids) await hubCall(L, id, 'kick', 'user=' + encodeURIComponent(user));
}

const member = (L, id, user) => L.one('SELECT * FROM store_members WHERE store_id=? AND user=?', id, user);
const owners = (L, id) => L.rows("SELECT user FROM store_members WHERE store_id=? AND role='owner'", id);
const label = u => (u && (u.name || u.username)) || '';

/* ---------- called by Ledger.handle before the normal session check ---------- */
export async function posPublic(L, req, url, H) {
  const p = url.pathname;
  // used by the relay (never reachable from the internet: index.js refuses /api/pos/internal/*)
  if (p === '/api/pos/internal/check') {
    const q = k => url.searchParams.get(k) || '';
    const sid = q('sid'), user = q('user'), store = q('store');
    const sess = L.one('SELECT user, exp FROM sessions WHERE h=?', sid), u = L.findUser(user), m = member(L, store, user);
    if (!sess || sess.user !== user || sess.exp < H.now() || !u || u.disabled || !m) return H.json(200, { ok: false });
    return H.json(200, { ok: true, role: m.role });
  }
  if (!p.startsWith('/api/pos/device/')) return null;
  // the store PC, with the device token it was given when it was linked (never a password)
  const tok = req.headers.get('x-pos-device') || '';
  const st = /^[a-f0-9]{64}$/.test(tok) ? L.one('SELECT * FROM stores WHERE dev_hash=?', H.sha(tok)) : null;
  if (!st) return H.json(401, { error: 'This store PC is not linked to an account any more.' });
  const b = req.method === 'POST' ? await H.jbody(60000) : {};
  if (p === '/api/pos/device/pending') {
    const out = [];
    for (const m of L.rows('SELECT user, role FROM store_members WHERE store_id=? AND wrapped IS NULL', st.id)) { const u = L.findUser(m.user); if (u && u.pub && !u.disabled) out.push({ username: m.user, role: m.role, pub: u.pub }); }
    return H.json(200, { pending: out });
  }
  if (p === '/api/pos/device/wrap') {
    const m = member(L, st.id, H.normUser(b.username)), u = m && L.findUser(m.user);
    if (!m || m.wrapped || !u || !u.pub || !validWrapped(b.wrappedKey)) return H.json(400, { error: 'Nothing to do' });
    L.sql.exec('UPDATE store_members SET wrapped=? WHERE store_id=? AND user=?', b.wrappedKey, st.id, m.user);
    return H.json(200, { ok: true });
  }
  if (p === '/api/pos/device/heartbeat') {
    const devices = (Array.isArray(b.devices) ? b.devices : []).slice(0, 40).map(d => ({ name: H.clip(d.name, 40), reg: Number(d.reg) || 0, lastSeen: Number(d.lastSeen) || 0, who: H.clip(d.who, 40) }));
    const name = H.clip(b.name, 80) || st.name;
    L.sql.exec('UPDATE stores SET devices=?, seen=?, name=? WHERE id=?', JSON.stringify(devices), H.now(), name, st.id);
    return H.json(200, { ok: true, members: L.rows('SELECT user FROM store_members WHERE store_id=?', st.id).map(r => r.user) });
  }
  if (p === '/api/pos/device/unlink') {
    const us = L.rows('SELECT user FROM store_members WHERE store_id=?', st.id).map(r => r.user);
    L.sql.exec('DELETE FROM store_members WHERE store_id=?', st.id); L.sql.exec('DELETE FROM stores WHERE id=?', st.id);
    for (const u of us) await posKick(L, u, st.id);
    return H.json(200, { ok: true });
  }
  return H.json(404, { error: 'Not found' });
}

/* ---------- signed-in people ---------- */
export async function posUser(L, req, url, me, s, H) {
  const p = url.pathname, j = H.json;
  if (p === '/api/sessions') {
    return j(200, { sessions: L.rows('SELECT h, created, ua, ip, exp FROM sessions WHERE user=? ORDER BY COALESCE(created,0) DESC', me.username).filter(r => r.exp > H.now()).map(r => ({ id: r.h.slice(0, 16), current: r.h === s.key, created: r.created || 0, device: r.ua || '', ip: r.ip || '', expires: r.exp })) });
  }
  if (p === '/api/sessions/revoke' && req.method === 'POST') {
    const b = await H.jbody(); const id = String(b.id || '');
    if (b.others) { L.sql.exec('DELETE FROM sessions WHERE user=? AND h<>?', me.username, s.key); await posKick(L, me.username); return j(200, { ok: true }); }
    if (!/^[a-f0-9]{16}$/.test(id)) return j(400, { error: 'Bad request' });
    const row = L.rows('SELECT h FROM sessions WHERE user=?', me.username).find(r => r.h.slice(0, 16) === id);
    if (!row) return j(404, { error: 'That device is already signed out.' });
    L.sql.exec('DELETE FROM sessions WHERE h=?', row.h); await posKick(L, me.username);
    return j(200, { ok: true, self: row.h === s.key });
  }
  if (!p.startsWith('/api/pos/')) return null;

  if (p === '/api/pos/stores') {
    const list = L.rows('SELECT s.id, s.name, s.owner, s.seen, m.role, m.wrapped FROM store_members m JOIN stores s ON s.id=m.store_id WHERE m.user=? ORDER BY s.name', me.username)
      .map(r => ({ storeId: r.id, name: r.name, role: r.role, owner: label(L.findUser(r.owner)) || r.owner, wrappedKey: r.wrapped || null, pending: !r.wrapped, pcSeen: r.seen || 0 }));
    return j(200, { stores: list });
  }
  if (p === '/api/pos/authz') {   // the relay asks this (with the browser's own cookie) before letting a web browser connect
    const id = url.searchParams.get('store') || '', m = ID.test(id) ? member(L, id, me.username) : null;
    if (!m) return j(403, { ok: false, error: 'This account is not a member of that store.' });
    return j(200, { ok: true, user: me.username, role: m.role, sid: s.key });
  }
  if (p === '/api/pos/pending') {   // people waiting for their locked copy of the key, for stores I own (my browser can make it)
    const out = [];
    for (const m of L.rows("SELECT m.store_id, m.user, m.role FROM store_members m WHERE m.wrapped IS NULL AND EXISTS(SELECT 1 FROM store_members o WHERE o.store_id=m.store_id AND o.user=? AND o.role='owner' AND o.wrapped IS NOT NULL)", me.username)) {
      const u = L.findUser(m.user); if (u && u.pub && !u.disabled) out.push({ storeId: m.store_id, username: m.user, role: m.role, pub: u.pub });
    }
    return j(200, { pending: out });
  }
  if (req.method !== 'POST' && p !== '/api/pos/members') return j(404, { error: 'Not found' });

  if (p === '/api/pos/store/link') {   // the store PC (signed in as the owner) registers its store and hands over the owner's locked key
    const b = await H.jbody(30000), id = String(b.storeId || '');
    if (!ID.test(id) || !validWrapped(b.wrappedKey) || !/^[a-f0-9]{64}$/.test(b.relayAuth || '')) return j(400, { error: 'Bad store data' });
    const v = await hubCall(L, id, 'verify', 'auth=' + b.relayAuth);
    if (!v.ok) return j(400, { error: 'The store PC is not connected to Cloud Sync yet. Wait a few seconds and try again.' });
    const have = L.one('SELECT * FROM stores WHERE id=?', id);
    if (have && !(member(L, id, me.username) || {}).role) return j(409, { error: 'This store is already linked to another account.' });
    if (have && member(L, id, me.username).role !== 'owner') return j(403, { error: 'Only an owner of the store can link it.' });
    if (!have && L.one('SELECT COUNT(*) n FROM stores WHERE owner=?', me.username).n >= 20) return j(400, { error: 'That is the most stores one account can have.' });
    const dev = H.rnd(32).toString('hex'), name = H.clip(b.name, 80) || 'My store';
    if (have) L.sql.exec('UPDATE stores SET name=?, dev_hash=?, seen=? WHERE id=?', name, H.sha(dev), H.now(), id);
    else L.sql.exec('INSERT INTO stores(id,name,owner,created,dev_hash,seen) VALUES(?,?,?,?,?,?)', id, name, me.username, H.now(), H.sha(dev), H.now());
    L.sql.exec("INSERT OR REPLACE INTO store_members(store_id,user,role,wrapped,added_by,created) VALUES(?,?,'owner',?,?,?)", id, me.username, b.wrappedKey, me.username, H.now());
    L.log(me.username, 'linked store', id);
    return j(200, { ok: true, deviceToken: dev });
  }

  let b = {};
  if (req.method === 'POST') { b = await H.jbody(30000); }
  const id = String(b.storeId || url.searchParams.get('storeId') || '');
  if (!ID.test(id)) return j(400, { error: 'Bad store' });
  const mine = member(L, id, me.username), st = L.one('SELECT * FROM stores WHERE id=?', id);
  if (!mine || !st) return j(403, { error: 'You are not a member of that store.' });

  if (p === '/api/pos/leave') {
    if (mine.role === 'owner' && owners(L, id).length < 2) return j(400, { error: 'You are the only owner. Make someone else an owner first, or unlink the store.' });
    L.sql.exec('DELETE FROM store_members WHERE store_id=? AND user=?', id, me.username); await posKick(L, me.username, id); return j(200, { ok: true });
  }
  if (mine.role !== 'owner') return j(403, { error: 'Only a store owner can do this.' });

  if (p === '/api/pos/members') {
    const members = L.rows('SELECT user, role, wrapped, added_by, created FROM store_members WHERE store_id=? ORDER BY created', id).map(m => {
      const u = L.findUser(m.user) || {};
      return { username: m.user, name: u.name || m.user, email: u.email || '', role: m.role, isCreator: m.user === st.owner, disabled: !!u.disabled, lastLogin: u.lastLogin || '', ready: !!m.wrapped, waiting: m.wrapped ? '' : (u.pub ? 'The store PC or an owner will approve it the next time it is online.' : 'Waiting for ' + (u.name || m.user) + ' to sign in once.'), added: m.created };
    });
    const invites = L.invites().filter(i => i.pos && i.pos.storeId === id && !i.usedBy && !i.revoked && i.expires > H.now()).map(i => ({ id: i.id, email: i.sentTo || '', role: i.pos.role, expires: i.expires }));
    let devices = []; try { devices = JSON.parse(st.devices || '[]'); } catch (e) { /* none */ }
    return j(200, { store: { id, name: st.name, pcSeen: st.seen || 0 }, members, invites, devices });
  }
  if (p === '/api/pos/store/unlink') {
    const us = L.rows('SELECT user FROM store_members WHERE store_id=?', id).map(r => r.user);
    L.sql.exec('DELETE FROM store_members WHERE store_id=?', id); L.sql.exec('DELETE FROM stores WHERE id=?', id);
    for (const u of us) await posKick(L, u, id);
    L.log(me.username, 'unlinked store', id); return j(200, { ok: true });
  }
  if (p === '/api/pos/members/invite') {
    const role = String(b.role || ''); if (!ROLES.includes(role)) return j(400, { error: 'Pick a role.' });
    const typed = String(b.who || b.email || '').trim();
    let target = null;
    if (H.validEmail(typed)) target = L.users().find(u => (u.email || '').toLowerCase() === typed.toLowerCase()) || null;
    else target = L.findUser(typed);
    if (target) {
      if (target.disabled) return j(400, { error: 'That login is turned off.' });
      if (target.username === me.username) return j(400, { error: 'That is you.' });
      const old = member(L, id, target.username);
      if (old) L.sql.exec('UPDATE store_members SET role=? WHERE store_id=? AND user=?', role, id, target.username);
      else L.sql.exec('INSERT INTO store_members(store_id,user,role,wrapped,added_by,created) VALUES(?,?,?,NULL,?,?)', id, target.username, role, me.username, H.now());
      await posKick(L, target.username, id);
      return j(200, { added: true, username: target.username, name: target.name || target.username, hasKeys: !!target.pub });
    }
    if (!H.validEmail(typed)) return j(404, { error: 'There is no login with that user name. To invite someone new, type their email address.' });
    if (L.invites().filter(i => i.by === me.username && !i.usedBy && !i.revoked && i.expires > H.now()).length >= 20) return j(400, { error: 'You already have 20 invites waiting. Cancel some first.' });
    const code = H.rnd(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const inv = { id: H.rnd(6).toString('hex'), hash: H.sha(code), name: H.clip(b.name, 80), note: 'Store POS: ' + st.name, by: me.username, created: new Date().toISOString(), expires: H.now() + 7 * 864e5, sentTo: typed, pos: { storeId: id, role } };
    L.saveInvite(inv);
    const link = url.origin + '/books/invite?code=' + code + '&next=' + encodeURIComponent('/pos/');
    let emailed = false, mailError = '';
    const C = L.cfg();
    if (C.mail && C.mail.user) {
      try {
        await H.sendMail(C.mail, { to: typed, fromName: (me.name || me.username) + ' (Trivedi POS)', subject: 'You are invited to ' + st.name + ' on Trivedi POS', text: (me.name || me.username) + ' invited you to the back office of "' + st.name + '" on Trivedi POS (' + ({ owner: 'Owner', manager: 'Manager', cashier: 'Cashier', reports: 'Reports only' }[role]) + ').\n\nOpen this link to create your account (it works once, for 7 days):\n' + link + '\n\nOne Trivedi account then works for the Store POS back office, Ledger Desk and PdfStudio.\n' });
        emailed = true; inv.sentAt = new Date().toISOString(); L.saveInvite(inv);
      } catch (e) { mailError = e.message; }
    }
    L.log(me.username, 'invited', typed, 'to store', id);
    return j(200, { invited: true, emailed, mailError, link, email: typed });
  }
  if (p === '/api/pos/members/cancel-invite') {
    const r = L.one('SELECT data FROM invites WHERE id=?', String(b.inviteId || '')), inv = r && JSON.parse(r.data);
    if (!inv || !inv.pos || inv.pos.storeId !== id) return j(404, { error: 'No such invite' });
    inv.revoked = true; L.saveInvite(inv); return j(200, { ok: true });
  }
  if (p === '/api/pos/members/role' || p === '/api/pos/members/remove') {
    const who = H.normUser(b.username), m = member(L, id, who);
    if (!m) return j(404, { error: 'That person is not a member.' });
    const lastOwner = m.role === 'owner' && owners(L, id).length < 2;
    if (p.endsWith('/role')) {
      if (!ROLES.includes(b.role)) return j(400, { error: 'Pick a role.' });
      if (lastOwner && b.role !== 'owner') return j(400, { error: 'A store needs at least one owner.' });
      L.sql.exec('UPDATE store_members SET role=? WHERE store_id=? AND user=?', b.role, id, who);
    } else {
      if (lastOwner || who === st.owner) return j(400, { error: 'The person who linked the store can\'t be removed. Unlink the store instead.' });
      L.sql.exec('DELETE FROM store_members WHERE store_id=? AND user=?', id, who);
    }
    await posKick(L, who, id);
    return j(200, { ok: true });
  }
  if (p === '/api/pos/members/wrap') {   // an owner's browser hands over the locked copy for a member who had no key pair yet
    const who = H.normUser(b.username), m = member(L, id, who), u = m && L.findUser(who);
    if (!m || m.wrapped || !u || !u.pub || !validWrapped(b.wrappedKey)) return j(400, { error: 'Nothing to do' });
    L.sql.exec('UPDATE store_members SET wrapped=? WHERE store_id=? AND user=?', b.wrappedKey, id, who);
    return j(200, { ok: true });
  }
  return j(404, { error: 'Not found' });
}

/** After a new account is made from an invite that was for a store: add them as a member (their key copy comes later). */
export function posAcceptInvite(L, inv, username, now) {
  if (!inv.pos || !ID.test(inv.pos.storeId || '') || !ROLES.includes(inv.pos.role)) return;
  if (!L.one('SELECT 1 x FROM stores WHERE id=?', inv.pos.storeId)) return;
  L.sql.exec('INSERT OR IGNORE INTO store_members(store_id,user,role,wrapped,added_by,created) VALUES(?,?,?,NULL,?,?)', inv.pos.storeId, username, inv.pos.role, inv.by, now);
}
