// A small stand-in for the website (cloud/src/index.js + hotel.js) that runs the real rules on node's SQLite:
// one directory (logins, hotels, master account) and one database per hotel.
import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
export async function makeSite(repo) {
  const { HotelCore, addDays } = await import(path.join(repo, 'cloud/src/hotel-core.js')); const { DirectoryCore } = await import(path.join(repo, 'cloud/src/hotel-dir.js'));
  const sqlOf = db => ({ exec(q, ...p) { const rows = db.prepare(q).all(...p); return { toArray: () => rows }; } });
  const mails = [], dirDb = new DatabaseSync(':memory:'), hotels = new Map();
  const dir = new DirectoryCore(sqlOf(dirDb), { sendMail: async (cfg, m) => { if (/bounce/.test(m.to)) throw new Error('The email server refused RCPT'); mails.push(m); return true; } });
  async function handle({ method, path: p, query, body, cookie, owner }) {
    const origin = 'http://localhost:8791';
    if (/^\/(auth|master|account)\//.test(p)) return dir.handle({ method, path: p, query: query || {}, body, cookie: cookie || '', origin, ledgerAdmin: !!owner });
    const w = await dir.handle({ method: 'GET', path: '/auth/whoami', query: {}, cookie: cookie || '', origin }); if (w.status !== 200) return w;
    if (!w.json.hotel) return { status: 400, json: { error: 'Open a hotel first.' } };
    const id = w.json.hotel.id; if (!hotels.has(id)) { const db = new DatabaseSync(':memory:'); hotels.set(id, { db, core: new HotelCore(sqlOf(db)) }); }
    return hotels.get(id).core.handle({ method, path: p, query: query || {}, body, me: w.json.user, hotel: w.json.hotel });
  }
  return { handle, mails, dirDb, hotels, addDays };
}
