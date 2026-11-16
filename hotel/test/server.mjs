// Local test server: the real Hotel Desk rules on node's SQLite, plus the screens. E-mails are not sent: GET /_mails lists them.
//   OWNER=1 node --no-warnings hotel/test/server.mjs "$PWD" 8791
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { makeSite } from './site.mjs';
const repo = process.argv[2], port = +process.argv[3] || 8791, site = await makeSite(repo);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/_mails') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(site.mails)); }
  if (u.pathname.startsWith('/hotel/api/')) {
    let t = ''; for await (const c of req) t += c;
    const r = await site.handle({ method: req.method, path: u.pathname.replace('/hotel/api', ''), query: Object.fromEntries(u.searchParams), body: t ? JSON.parse(t) : null, cookie: req.headers.cookie || '', owner: process.env.OWNER === '1' });
    const h = { 'Content-Type': 'application/json' }; if (r.cookie) h['Set-Cookie'] = r.cookie; res.writeHead(r.status, h); return res.end(JSON.stringify(r.json));
  }
  let f = u.pathname.replace(/^\/hotel\/?/, '') || 'index.html'; f = path.join(repo, 'hotel/app', path.normalize(f));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' }); res.end(fs.readFileSync(f));
}).listen(port, () => console.log('ready', port));
