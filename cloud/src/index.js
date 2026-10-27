// Store POS Cloud Sync relay.
// Every store has one "Hub" (a Durable Object). The store PC connects as the host; home PCs and tablets
// connect as clients. Everything they send each other is encrypted on the registers with a key this server
// never sees — the server only passes sealed messages along, and keeps them for the store PC while it is off.
import { DurableObject } from 'cloudflare:workers';
export { Ledger } from './ledger.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_INBOX = 20000;
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }


/* ---------- Store POS for Windows download: only for people who have a Store POS license key (the "owner code") ---------- */
const LIC_PUB_DER = 'MCowBQYDK2VwAyEAChLk2xj5iczD4MkE2RBkAppOTPz5qaThemEoawP+iro=';
const LB32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const POS_EXE = 'https://github.com/atrivedi85/storepos-updates/releases/download/pos-windows-latest/StorePOS-Setup.exe';
const POS_INFO = 'https://github.com/atrivedi85/storepos-updates/releases/download/pos-windows-latest/pos-windows.json';
function licBytes(str) {
  const clean = String(str || '').toUpperCase().replace(/^\s*SPOS/, '').replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) { const i = LB32.indexOf(ch); if (i < 0) throw new Error('bad'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
export async function checkLicense(key) {
  try {
    const raw = licBytes(key); if (raw.length < 70) return { ok: false, error: 'That code is too short. Check it was copied completely.' };
    const n = (raw[0] << 8) | raw[1], payload = raw.slice(2, 2 + n), sig = raw.slice(2 + n, 2 + n + 64);
    if (sig.length !== 64) return { ok: false, error: 'That code is not valid.' };
    const der = Uint8Array.from(atob(LIC_PUB_DER), c => c.charCodeAt(0));
    const pk = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    if (!(await crypto.subtle.verify({ name: 'Ed25519' }, pk, sig, payload))) return { ok: false, error: 'That code is not valid.' };
    const data = JSON.parse(new TextDecoder().decode(payload));
    if (data.e && String(data.e) < new Date().toISOString().slice(0, 10)) return { ok: false, error: 'That code has expired. Ask for a new one.' };
    return { ok: true, data };
  } catch (e) { return { ok: false, error: 'That code is not valid.' }; }
}
async function posDownload(req) {
  let code = '';
  try { const f = await req.formData(); code = String(f.get('code') || ''); } catch (e) { /* no form */ }
  const lic = await checkLicense(code);
  if (!lic.ok) return Response.redirect(new URL('/download?err=' + encodeURIComponent(lic.error), req.url).toString(), 303);
  const r = await fetch(POS_EXE, { redirect: 'follow' });
  if (!r.ok) return Response.redirect(new URL('/download?err=' + encodeURIComponent('The download is being updated. Try again in a few minutes.'), req.url).toString(), 303);
  const h = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="StorePOS-Setup.exe"', 'Cache-Control': 'no-store' });
  if (r.headers.get('content-length')) h.set('Content-Length', r.headers.get('content-length'));
  return new Response(r.body, { status: 200, headers: h });
}
async function posInfo() {
  try { const r = await fetch(POS_INFO, { redirect: 'follow' }); if (r.ok) { const j = await r.json(); return J({ version: j.version, bytes: j.bytes }); } } catch (e) { /* not built yet */ }
  return J({ version: null });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const p = new URL(req.url).pathname.split('/').filter(Boolean);
    const path = new URL(req.url).pathname;
    if (path === '/dl/windows' && req.method === 'POST') return posDownload(req);
    if (path === '/dl/info') return posInfo();
    if (path === '/download') return env.ASSETS.fetch(new Request(new URL('/download.html', req.url), { method: 'GET' })).then(r => r.status >= 300 && r.status < 400 ? env.ASSETS.fetch(new Request(new URL(r.headers.get('Location') || '/download.html', req.url), { method: 'GET' })) : r).then(r => new Response(r.body, { status: 200, headers: r.headers }));
    // Ledger Desk (trivedipos.com/books): its sign-in pages and its server
    if (path === '/books/login' || path === '/books/invite') {
      // Serve the sign-in page at the address the person opened (an invite keeps its ?code=…). Cloudflare's assets
      // redirect "login.html" to "login", so ask for "/books/login" and never pass a redirect on to the browser.
      const r = await env.ASSETS.fetch(new Request(new URL('/books/login', req.url), { method: 'GET' }));
      if (r.status >= 300 && r.status < 400) { const r2 = await env.ASSETS.fetch(new Request(new URL(r.headers.get('Location') || '/books/login.html', req.url), { method: 'GET' })); return new Response(r2.body, { status: 200, headers: r2.headers }); }
      return r;
    }
    if (path.startsWith('/api/')) return env.LEDGER.get(env.LEDGER.idFromName('main')).fetch(req);
    if (p[0] !== 'v1') return J({ app: 'storepos-sync', v: 1 });
    if ((p[1] === 'store' || p[1] === 'pair') && ID.test(p[2] || '')) return env.HUB.get(env.HUB.idFromName(p[1] + ':' + p[2])).fetch(req);
    return J({ error: 'Not found' }, 404);
  }
};

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL, ts INTEGER)');
  }
  meta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray(); return r.length ? r[0].v : null; }
  setMeta(k, v) { this.sql.exec('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)', k, String(v)); }
  hostOn() { return this.ctx.getWebSockets('host').length > 0; }

  async fetch(req) {
    const u = new URL(req.url); const p = u.pathname.split('/').filter(Boolean);
    if (p[1] === 'pair') {   // short-lived sealed pairing offer (locked with the pairing code, which never reaches us)
      if (req.method === 'PUT') {
        const t = await req.text(); if (t.length > 6000) return J({ error: 'Too big' }, 413);
        const until = Date.now() + 15 * 60000; this.setMeta('blob', t); this.setMeta('until', until); this.setMeta('tries', 0);
        await this.ctx.storage.setAlarm(until); return J({ ok: true });
      }
      if (req.method === 'GET') {
        const b = this.meta('blob'), until = Number(this.meta('until') || 0), tries = Number(this.meta('tries') || 0);
        if (!b || Date.now() > until || tries >= 20) return J({ error: 'That code is wrong or expired. Make a new one at the store PC.' }, 404);
        this.setMeta('tries', tries + 1); return J({ blob: b });
      }
      if (req.method === 'DELETE') { this.sql.exec('DELETE FROM meta'); return J({ ok: true }); }
      return J({ error: 'Not allowed' }, 405);
    }
    if (p[1] === 'store' && p[3] === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return J({ error: 'WebSocket expected' }, 426);
      const role = u.searchParams.get('role'), auth = u.searchParams.get('auth') || '', cid = u.searchParams.get('cid') || '';
      if (!/^[a-f0-9]{64}$/.test(auth)) return J({ error: 'Not allowed' }, 401);
      const h = await sha(auth), known = this.meta('auth');
      if (!known) { if (role !== 'host') return J({ error: 'This store has not turned on Cloud Sync at the store PC yet.' }, 404); this.setMeta('auth', h); }
      else if (known !== h) return J({ error: 'Not allowed' }, 403);
      const [client, server] = Object.values(new WebSocketPair());
      if (role === 'host') {
        for (const w of this.ctx.getWebSockets('host')) { try { w.close(4000, 'Another store PC connected'); } catch (e) { /* gone */ } }
        this.ctx.acceptWebSocket(server, ['host']);
      } else {
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(cid)) return J({ error: 'Bad device id' }, 400);
        for (const w of this.ctx.getWebSockets('c:' + cid)) { try { w.close(4000, 'Replaced'); } catch (e) { /* gone */ } }
        this.ctx.acceptWebSocket(server, ['client', 'c:' + cid]);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return J({ error: 'Not found' }, 404);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const tags = this.ctx.getTags(ws);
    if (tags.includes('host')) {
      if (m.t === 'hello') {   // store PC came online: hand over everything that waited for it
        ws.send(JSON.stringify({ t: 'welcome', waiting: this.sql.exec('SELECT COUNT(*) n FROM inbox').one().n }));
        for (const r of this.sql.exec('SELECT id, msg FROM inbox ORDER BY id').toArray()) { const q = JSON.parse(r.msg); q.qid = r.id; ws.send(JSON.stringify(q)); }
        const s = JSON.stringify({ t: 'bump', host: true }); for (const w of this.ctx.getWebSockets('client')) { try { w.send(s); } catch (e) { /* gone */ } }
      } else if (m.t === 'res') { for (const w of this.ctx.getWebSockets('c:' + m.to)) { try { w.send(raw); } catch (e) { /* gone */ } } }
      else if (m.t === 'ack') { this.sql.exec('DELETE FROM inbox WHERE id=?', Number(m.qid) || 0); }
      else if (m.t === 'bump') { const s = JSON.stringify({ t: 'bump', host: true }); for (const w of this.ctx.getWebSockets('client')) { try { w.send(s); } catch (e) { /* gone */ } } }
      else if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    const cid = (tags.find(t => t.startsWith('c:')) || '').slice(2);
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', host: this.hostOn() })); return; }
    if (m.t !== 'req') return;
    m.from = cid; delete m.qid;
    const last = !m.parts || m.part === m.parts - 1;
    const host = this.ctx.getWebSockets('host')[0];
    if (host) { try { host.send(JSON.stringify(m)); return; } catch (e) { /* fall through */ } }
    if (m.q && this.sql.exec('SELECT COUNT(*) n FROM inbox').one().n < MAX_INBOX) {   // keep changes until the store PC is back
      this.sql.exec('INSERT INTO inbox(msg, ts) VALUES(?,?)', JSON.stringify(m), Date.now());
      if (last) ws.send(JSON.stringify({ t: 'res', id: m.id, queued: true }));
      return;
    }
    if (last) ws.send(JSON.stringify({ t: 'res', id: m.id, offline: true }));
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* closed */ } }
  async alarm() { if (Number(this.meta('until') || 0) <= Date.now()) this.sql.exec('DELETE FROM meta'); }
}
