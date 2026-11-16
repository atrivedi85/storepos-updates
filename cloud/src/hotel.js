// Hotel Desk on trivedipos.com/hotel: one Durable Object ("Hotel") keeps the hotel's rooms, reservations, folios and logins
// in its own SQLite. The rules live in hotel-core.js; this file only connects them to the website.
import { DurableObject } from 'cloudflare:workers';
import { HotelCore } from './hotel-core.js';
import { _test as ledgerCrypto } from './ledger.js';

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };

export class Hotel extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new HotelCore(ctx.storage.sql, { scrypt: ledgerCrypto.scrypt64 }); }
  async fetch(req) {
    const u = new URL(req.url); let body = null;
    if (req.method === 'POST') {
      // Browsers send an Origin on POST: only this website may post here.
      const o = req.headers.get('Origin'); if (o && new URL(o).host !== u.host) return new Response(JSON.stringify({ error: 'Not allowed.' }), { status: 403, headers: SEC });
      const t = await req.text(); if (t.length > 2e6) return new Response(JSON.stringify({ error: 'Too big.' }), { status: 413, headers: SEC });
      try { body = t ? JSON.parse(t) : {}; } catch (e) { return new Response(JSON.stringify({ error: 'Bad request.' }), { status: 400, headers: SEC }); }
    } else if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Not allowed.' }), { status: 405, headers: SEC });
    const r = this.core.handle({ method: req.method, path: u.pathname.replace(/^\/hotel\/api/, ''), query: Object.fromEntries(u.searchParams), body, cookie: req.headers.get('cookie') || '', ledgerAdmin: req.headers.get('x-hotel-owner') === '1' });
    const h = new Headers(SEC); if (r.cookie) h.set('Set-Cookie', r.cookie);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: h });
  }
}
