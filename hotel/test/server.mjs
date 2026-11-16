// Local test server: runs the real hotel rules (hotel-core.js) on node's SQLite and serves the screens.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
const repo = process.argv[2], port = +process.argv[3] || 8791;
const { HotelCore } = await import(path.join(repo, 'cloud/src/hotel-core.js'));
export function makeCore() { const db = new DatabaseSync(':memory:'); const sql = { exec(q, ...p) { const st = db.prepare(q); const rows = st.all(...p); return { toArray: () => rows, one: () => rows[0] }; } }; return new HotelCore(sql); }
const core = makeCore();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/hotel/api/')) {
    let t = ''; for await (const c of req) t += c;
    const r = core.handle({ method: req.method, path: u.pathname.replace('/hotel/api', ''), query: Object.fromEntries(u.searchParams), body: t ? JSON.parse(t) : null, cookie: req.headers.cookie || '', ledgerAdmin: process.env.OWNER === '1' });
    const h = { 'Content-Type': 'application/json' }; if (r.cookie) h['Set-Cookie'] = r.cookie; res.writeHead(r.status, h); return res.end(JSON.stringify(r.json));
  }
  let f = u.pathname.replace(/^\/hotel\/?/, '') || 'index.html'; f = path.join(repo, 'hotel/app', path.normalize(f));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' }); res.end(fs.readFileSync(f));
}).listen(port, () => console.log('ready', port));
