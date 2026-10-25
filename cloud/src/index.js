// Store POS Cloud Sync relay.
// Every store has one "Hub" (a Durable Object). The store PC connects as the host; home PCs and tablets
// connect as clients. Everything they send each other is encrypted on the registers with a key this server
// never sees — the server only passes sealed messages along, and keeps them for the store PC while it is off.
import { DurableObject } from 'cloudflare:workers';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_INBOX = 20000;
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const p = new URL(req.url).pathname.split('/').filter(Boolean);
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
