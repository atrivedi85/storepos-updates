// Minimal stand-ins for Cloudflare Durable Objects (SQLite storage, hibernating WebSockets) on node:sqlite.
import { DatabaseSync } from 'node:sqlite';

export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }

class Sql {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  exec(q, ...params) {
    let rows = [];
    if (!params.length && /;\s*\S/.test(q.trim().replace(/;\s*$/, ''))) this.db.exec(q);
    else { const st = this.db.prepare(q); if (st.columns().length) rows = st.all(...params); else st.run(...params); }
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('one() needs exactly one row, got ' + rows.length); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  }
}
export function makeCtx() {
  const sockets = new Set();
  const ctx = {
    storage: { sql: new Sql(), setAlarm() {}, deleteAll() {} },
    sockets, instance: null,
    waitUntil(p) { Promise.resolve(p).catch(() => {}); },
    blockConcurrencyWhile: f => f(),
    getWebSockets(tag) { return [...sockets].filter(w => !w._closed && (!tag || w._tags.includes(tag))); },
    getTags(ws) { return ws._tags; },
    acceptWebSocket(ws, tags) { ws._tags = tags || []; ws._ctx = ctx; sockets.add(ws); },
  };
  return ctx;
}
export function installGlobals() {
  const R = globalThis.Response;
  if (!R.__patched) {
    globalThis.Response = class extends R {
      constructor(body, init) { if (init && init.status === 101) { super(null, { ...init, status: 200 }); this.webSocket = init.webSocket; this.is101 = true; } else super(body, init); }
    };
    globalThis.Response.__patched = true;
  }
  globalThis.WebSocketPair = function () {
    const mk = () => ({ _att: null, _closed: false, serializeAttachment(v) { this._att = JSON.parse(JSON.stringify(v)); }, deserializeAttachment() { return this._att ? JSON.parse(JSON.stringify(this._att)) : null; } });
    const client = mk(), server = mk();
    server.send = d => { if (!server._closed && server._out) server._out.send(d); };
    server.close = (code, reason) => { if (server._closed) return; server._closed = true; if (server._out) server._out.close(code || 1000, String(reason || '').slice(0, 100)); };
    client._server = server; this[0] = client; this[1] = server;
  };
}
