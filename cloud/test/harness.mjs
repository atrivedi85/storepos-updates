// Runs the real Worker (index.js + Hub + Ledger) in Node with a real HTTP + WebSocket front door, for tests and browser checks.
import './setup.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx } from './stubs.mjs';
import { createRequire } from 'node:module';
const require = createRequire('/opt/npm-tools/node_modules/');
const { WebSocketServer } = require('ws');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

export async function start({ port = 0, publicDir = path.join(root, 'cloud/public') } = {}) {
  const mod = await import('../src/index.js');
  const worker = mod.default;
  const env = { ASSETS: { fetch: req => assets(req) } };
  const instances = new Map();
  const ns = (Cls, key) => ({
    idFromName: n => key + '|' + n,
    get: id => ({ fetch: req => { let i = instances.get(id); if (!i) { const ctx = makeCtx(); i = new Cls(ctx, env); ctx.instance = i; instances.set(id, i); } return i.fetch(req); } }),
  });
  env.HUB = ns(mod.Hub, 'hub'); env.LEDGER = ns(mod.Ledger, 'ledger'); env.HOTEL = ns(mod.Hotel, 'hotel');
  const inst = id => instances.get(id);
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
  async function assets(req) {
    const u = new URL(req.url); let p = decodeURIComponent(u.pathname);
    const tries = [p, p + '.html', path.join(p, 'index.html')];
    for (const t of tries) {
      const f = path.join(publicDir, t);
      if (!f.startsWith(publicDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) continue;
      return new Response(fs.readFileSync(f), { status: 200, headers: { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' } });
    }
    return new Response('Not found', { status: 404 });
  }
  async function handle(req) {
    const u = new URL(req.url);
    // Like Cloudflare: static files first, then the Worker. PdfStudio is a separate Worker (only a stand-in here).
    if (u.pathname === '/pdfstudio/apps.js') return new Response(fs.readFileSync(path.join(root, 'pdfstudio/worker/apps-switcher.txt')), { headers: { 'Content-Type': 'text/javascript' } });
    if (u.pathname === '/pdfstudio/api/logout') return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    if (u.pathname.startsWith('/pdfstudio')) return new Response('<!doctype html><title>PdfStudio</title><body>PdfStudio stand-in</body>', { headers: { 'Content-Type': 'text/html' } });
    if ((req.method === 'GET' || req.method === 'HEAD') && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/v1/') && !u.pathname.startsWith('/dl/') && u.pathname !== '/download' && !/^\/(books\/(login|invite)(\/|$)|hotel\/api)/.test(u.pathname)) {
      const r = await assets(req); if (r.status !== 404) return r;
    }
    return worker.fetch(req, env);
  }
  const toRequest = (inc, upgrade) => new Promise(res => {
    const chunks = []; inc.on('data', c => chunks.push(c)); inc.on('end', () => {
      const h = new Headers(); for (const [k, v] of Object.entries(inc.headers)) if (v != null && !['connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'].includes(k)) h.set(k, Array.isArray(v) ? v.join(', ') : v);
      if (upgrade) h.set('upgrade', 'websocket');
      const body = Buffer.concat(chunks); const m = inc.method;
      res(new Request('http://' + inc.headers.host + inc.url, { method: m, headers: h, body: m === 'GET' || m === 'HEAD' || !body.length ? undefined : body }));
    });
  });
  const server = http.createServer(async (inc, out) => {
    try {
      const r = await handle(await toRequest(inc));
      const h = {}; for (const [k, v] of r.headers) if (k !== 'set-cookie') h[k] = v;
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (sc.length) h['set-cookie'] = sc;
      out.writeHead(r.status, h); out.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { console.error('harness error', e); out.writeHead(500); out.end(String(e && e.stack || e)); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (inc, socket, head) => {
    try {
      const r = await handle(await toRequest(inc, true));
      if (!r.is101) { socket.write('HTTP/1.1 ' + r.status + ' X\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' + await r.text()); return socket.destroy(); }
      const srv = r.webSocket._server, inst = srv._ctx.instance;
      wss.handleUpgrade(inc, socket, head, ws => {
        srv._out = ws;
        ws.on('message', d => { Promise.resolve(inst.webSocketMessage(srv, d.toString())).catch(e => console.error('ws message error', e)); });
        ws.on('close', (c, rsn) => { srv._closed = true; try { inst.webSocketClose(srv, c, String(rsn || ''), true); } catch (e) { /* closed */ } });
      });
    } catch (e) { try { socket.destroy(); } catch (x) { /* gone */ } }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: 'http://localhost:' + server.address().port, port: server.address().port, env, instances, inst, close: () => { wss.clients.forEach(c => c.terminate()); server.close(); } };
}
