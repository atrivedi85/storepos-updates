// A tiny stand-in for the Windows store PC's Cloud Sync host, speaking the real protocol (sealed messages over the relay).
// It uses the real device-gate code from source/app/acct.js, so tests of the web back office exercise the same rules.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket: WS } = createRequire('/opt/npm-tools/node_modules/')('ws');
const ACCT = require('../../source/app/acct.js');

const seal = (keyB64, obj, gz) => { const iv = crypto.randomBytes(12); let p = Buffer.from(JSON.stringify(obj)); if (gz) p = zlib.gzipSync(p); const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv); const ct = Buffer.concat([c.update(p), c.final(), c.getAuthTag()]); return (gz ? 'z.' : 'p.') + Buffer.concat([iv, ct]).toString('base64'); };
const open = (keyB64, s) => { const gz = s.startsWith('z.'), raw = Buffer.from(s.slice(2), 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), raw.subarray(0, 12)); d.setAuthTag(raw.subarray(raw.length - 16)); let p = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]); if (gz) p = zlib.gunzipSync(p); return JSON.parse(p.toString()); };

export { seal, open };
export function startFakePc(base, store) {
  const tablets = [], parts = new Map(), seen = [];
  const products = ['Cola 20oz:1.99:Drinks', 'Energy Drink:3.49:Drinks', 'Tortilla Chips:2.49:Snacks', 'Mint Gum:1.29:Candy', 'Root Beer:1.99:Drinks'].map((s, i) => { const [name, price, cat] = s.split(':'); return { sku: String(100 + i), name, label: name, price: +price, cost: +price / 2, stock: 20 + i, cat, tax: [], ebt: false }; });
  const kv = { settings: { storeName: store.name, nextOrder: 1, categories: [{ name: 'Drinks', color: '#2a9d8f' }, { name: 'Snacks', color: '#e76f51' }, { name: 'Candy', color: '#8e5bd1' }], taxes: [] }, users: [{ id: 'u1', name: 'Owner', pin: '1111', role: 'admin' }] };
  const ws = new WS(base.replace('http', 'ws') + '/v1/store/' + store.storeId + '/ws?role=host&auth=' + ACCT.relayAuth(store.key));
  const handle = (r, acct) => {
    const url = r.path, body = r.body || {};
    const t = tablets.find(x => x.token && x.token === r.token);
    seen.push({ url, acct });
    if (url === '/pair') {
      if (!acct || !ACCT.ROLES.includes(acct.r)) return { status: 403, error: 'That pairing code is wrong or expired.' };
      const nt = { id: 'a:' + acct.u + ':' + body.deviceId, token: crypto.randomBytes(12).toString('hex'), reg: tablets.length + 2, acct: { user: acct.u, role: acct.r } };
      tablets.push(nt); return { token: nt.token, reg: nt.reg, store: store.name, epoch: 0, role: acct.r };
    }
    if (!t || !ACCT.deviceAllowed(t, acct)) return { status: 401, error: 'not allowed' };
    if (url === '/sync') {
      if (body.ops && body.ops.length && !ACCT.canWrite(acct.r)) return { status: 403, error: 'read only' };
      if (body.snap) {
        const s = body.snap;
        if (s.stage === 'products') return { epoch: 0, startSeq: 1, items: products.map(p => ({ store: 'products', key: p.sku, data: p })), next: { stage: 'kv' } };
        if (s.stage === 'kv') return { epoch: 0, startSeq: 1, items: Object.entries(kv).map(([k, v]) => ({ store: 'kv', key: k, data: v })), next: { stage: 'orders', after: '' } };
        return { epoch: 0, startSeq: 1, items: [], next: null };
      }
      return { epoch: 0, seq: body.since || 1, more: false, items: [], now: Date.now() };
    }
    if (url === '/api') return { result: { orders: 0 } };
    return { status: 404, error: 'Not found' };
  };
  ws.on('open', () => ws.send('{"t":"hello"}'));
  ws.on('message', d => {
    const m = JSON.parse(d.toString()); if (m.t !== 'req') return;
    let enc = m.enc;
    if (m.parts) { const e = parts.get(m.id) || { p: [], n: 0 }; parts.set(m.id, e); if (e.p[m.part] === undefined) { e.p[m.part] = m.enc; e.n++; } if (e.n < m.parts) return; enc = e.p.join(''); parts.delete(m.id); }
    let out; try { out = handle(open(store.key, enc), m.acct); } catch (e) { out = { status: 500, error: e.message }; }
    const body = out && out.status ? { status: out.status, error: out.error } : out;
    ws.send(JSON.stringify({ t: 'res', id: m.id, to: m.from, enc: seal(store.key, body, !!m.z) }));
  });
  return { ws, tablets, seen, ready: new Promise(r => ws.on('open', r)), close: () => ws.close() };
}
