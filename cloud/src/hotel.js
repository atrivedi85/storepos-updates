// Hotel Desk on trivedipos.com/hotel. One Durable Object class, used two ways:
//   the object named "directory" keeps the hotels we sell to, every login and the master account (hotel-dir.js)
//   the object named "h:<hotel id>" keeps one hotel's rooms, reservations and folios (hotel-core.js)
// index.js decides which one a request goes to and says so in the x-hd-kind header (browsers cannot set x-hd-* headers:
// index.js removes them from every incoming request).
import { DurableObject } from 'cloudflare:workers';
import { HotelCore } from './hotel-core.js';
import { DirectoryCore } from './hotel-dir.js';
import { _test as ledgerCrypto, sendMail } from './ledger.js';

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const out = (status, json, cookie) => { const h = new Headers(SEC); if (cookie) h.set('Set-Cookie', cookie); return new Response(JSON.stringify(json), { status, headers: h }); };

export class Hotel extends DurableObject {
  async fetch(req) {
    const u = new URL(req.url); let body = null;
    if (req.method === 'POST') {
      // Browsers send an Origin on POST: only this website may post here.
      const o = req.headers.get('Origin'); if (o && new URL(o).host !== u.host) return out(403, { error: 'Not allowed.' });
      const t = await req.text(); if (t.length > 2e6) return out(413, { error: 'Too big.' });
      try { body = t ? JSON.parse(t) : {}; } catch (e) { return out(400, { error: 'Bad request.' }); }
    } else if (req.method !== 'GET') return out(405, { error: 'Not allowed.' });
    const base = { method: req.method, path: u.pathname.replace(/^\/hotel\/api/, ''), query: Object.fromEntries(u.searchParams), body };
    if (req.headers.get('x-hd-kind') === 'dir') {
      this.dir = this.dir || new DirectoryCore(this.ctx.storage.sql, { scrypt: ledgerCrypto.scrypt64, sendMail });
      const r = await this.dir.handle({ ...base, cookie: req.headers.get('cookie') || '', origin: u.origin, ledgerAdmin: req.headers.get('x-hd-owner') === '1' });
      return out(r.status, r.json, r.cookie);
    }
    let who = null; try { who = JSON.parse(decodeURIComponent(req.headers.get('x-hd-who') || '')); } catch (e) { /* not signed in */ }
    if (!who || !who.user || !who.hotel) return out(401, { error: 'Please sign in.' });
    this.core = this.core || new HotelCore(this.ctx.storage.sql);
    const r = this.core.handle({ ...base, me: who.user, hotel: who.hotel });
    return out(r.status, r.json);
  }
}
