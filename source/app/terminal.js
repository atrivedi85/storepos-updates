'use strict';
/*
 * Card terminal drivers for Store POS (Windows app only).
 *
 * Every driver has the same methods and returns the same normalized result, so the screens
 * never care which terminal protocol is behind it:
 *
 *   test()  sale({mode,cents,cashbackCents,ref})  refund({mode,cents,ref})  void({tranNo,ref})
 *   settle()  ebtBalance({mode})  status({stan})  cancel({ref})
 *
 * mode = 'credit' | 'debit' | 'ebt_food' | 'ebt_cash'
 *
 * Result: { ok, partial, approvedCents, surchargeCents, totalCents, cashbackCents, authCode, last4, brand,
 *           entry, rrn, txnId, tranNo, batchNo, stan, aid, tvr, tsi, ebtBalanceCents, message, errorCode, raw,
 *           unknown?, unreachable?, busy?, cancelled? }
 *   unknown     = the terminal may or may not have charged the card. Never retry; look at the terminal.
 *   unreachable = nothing was sent (could not connect). Safe to try again.
 *
 * Drivers: valor (Valor semi-integration over TCP), demo (simulated, for training/testing),
 *          poslink (PAX BroadPOS/POSLink - not written yet).
 * Never keep more than the last 4 digits of a card number anywhere (raw has MASKED_PAN cut down to last 4).
 */
const net = require('net');

const STX = 0x02, ETX = 0x03;
const MODES = { credit: '1', debit: '2', ebt_food: '3', ebt_cash: '4' };

/* ---------- helpers ---------- */
const sleep = (ms, sig) => new Promise(res => { const t = setTimeout(res, ms); if (sig) sig.wake = () => { clearTimeout(t); res(); }; });
const str = v => (v === undefined || v === null) ? '' : String(v);
const toCents = v => { const s = str(v).trim(); if (!/^-?\d+$/.test(s)) return 0; return parseInt(s, 10); };
const last4Of = v => { const d = str(v).replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : ''; };

/** Copy of a response with every card-number-like field cut down to its last 4 digits. */
function safeRaw(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (/PAN|CARD_?NO|CARD_?NUM|TRACK|ACCOUNT_?NO/i.test(k) && typeof v === 'string' && v) { const l4 = last4Of(v); out[k] = l4 ? '**** ' + l4 : ''; }
    else out[k] = v;
  }
  return out;
}

function emptyResult() {
  return { ok: false, partial: false, approvedCents: 0, surchargeCents: 0, totalCents: 0, cashbackCents: 0, authCode: '', last4: '', brand: '', entry: '',
    rrn: '', txnId: '', tranNo: '', batchNo: '', stan: '', aid: '', tvr: '', tsi: '', ebtBalanceCents: null, message: '', errorCode: '', raw: null };
}
const failure = (message, extra) => Object.assign(emptyResult(), { message }, extra || {});

/** Turn a Valor response object into the normalized result. */
function normalizeValor(r) {
  const out = emptyResult();
  out.raw = safeRaw(r);
  const state = str(r.STATE);
  out.ok = state === '0';
  out.errorCode = str(r.ERROR_CODE);
  out.approvedCents = toCents(r.AMOUNT);
  out.surchargeCents = toCents(r.SURCHARGE_AMOUNT);
  out.cashbackCents = toCents(r.CASHBACK_AMOUNT);
  out.totalCents = r.TOTAL_AMOUNT !== undefined && str(r.TOTAL_AMOUNT) !== '' ? toCents(r.TOTAL_AMOUNT) : out.approvedCents + out.surchargeCents + out.cashbackCents;
  out.partial = str(r.PARTIAL) === '1';
  out.authCode = str(r.CODE);
  out.last4 = last4Of(r.MASKED_PAN);
  out.brand = str(r.ISSUER);
  out.entry = str(r.ENTRY_MODE);
  out.rrn = str(r.RRN);
  out.txnId = str(r.TXN_ID);
  out.tranNo = str(r.TRAN_NO);
  out.batchNo = str(r.BATCH_NO);
  out.stan = str(r.STAN_ID || r.STAN_NO);
  out.aid = str(r.AID);
  out.tvr = str(r.TVR);
  out.tsi = str(r.TSI);
  if (r.EBT_BAL_AMOUNT !== undefined && str(r.EBT_BAL_AMOUNT) !== '') out.ebtBalanceCents = toCents(r.EBT_BAL_AMOUNT);
  out.message = str(r.ERROR_MSG) || str(r.AUTH_RSP_TEXT) || str(r.MSG) || (out.ok ? 'Approved' : state === '-2' ? 'Transaction still in progress' : 'Not approved');
  if (state === '-2') out.inProgress = true;
  if (!out.ok && /cancel/i.test(out.message)) out.cancelled = true;
  return out;
}

/* ---------- JSON frame reader: accepts STX..ETX frames or bare JSON, in any mix ---------- */
class FrameReader {
  constructor() { this.buf = ''; }
  /** Add text, return the list of complete JSON objects found. */
  push(chunk) {
    this.buf += chunk;
    const found = [];
    for (;;) {
      // drop framing bytes and anything before the first '{'
      let i = 0;
      while (i < this.buf.length && this.buf[i] !== '{') i++;
      if (i > 0) this.buf = this.buf.slice(i);
      if (!this.buf) break;
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = 0; j < this.buf.length; j++) {
        const ch = this.buf[j];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end < 0) break; // incomplete, wait for more
      const text = this.buf.slice(0, end + 1);
      this.buf = this.buf.slice(end + 1);
      try { found.push(JSON.parse(text)); } catch (e) { /* garbage, skip */ }
    }
    return found;
  }
}
const isAck = o => !!o && /^ack$/i.test(str(o.MSG)) && o.TRAN_TYPE === undefined && o.TXN_ID === undefined && o.TRAN_METHOD === undefined && o.AMOUNT === undefined;
const frame = (obj, framing) => { const j = Buffer.from(JSON.stringify(obj), 'utf8'); return framing === 'raw' ? j : Buffer.concat([Buffer.from([STX]), j, Buffer.from([ETX])]); };

/* ---------- Valor driver ---------- */
function valorDriver(cfg, hooks) {
  const host = str(cfg.termIp).trim();
  const port = +cfg.termPort || 5000;
  const cport = +cfg.termCancelPort || 5001;
  const framing = cfg.termFraming === 'raw' ? 'raw' : 'stx';
  const timeoutMs = Math.max(5, +cfg.termTimeoutSec || 200) * 1000;
  const active = hooks.active; // { ref, cancelRequested, stan }

  /** One request, one connection. Resolves with the first real (non-ACK) result object.
   *  Rejects with Error having .kind = 'unreachable' | 'timeout' | 'dropped'. */
  function exchange(p, obj, ms, track) {
    return new Promise((resolve, reject) => {
      if (!host) { const e = new Error('No terminal IP address is set (Settings, Card terminal).'); e.kind = 'unreachable'; reject(e); return; }
      const sock = new net.Socket();
      const rd = new FrameReader();
      let done = false, connected = false, deadline;
      const finish = (err, val) => { if (done) return; done = true; clearTimeout(deadline); try { sock.destroy(); } catch (e) { /* ignore */ } err ? reject(err) : resolve(val); };
      const bad = (kind, msg) => { const e = new Error(msg); e.kind = kind; e.sent = connected; return e; };
      deadline = setTimeout(() => finish(bad(connected ? 'timeout' : 'unreachable', connected ? 'The terminal did not answer in time' : `Could not connect to the terminal at ${host}:${p}`)), ms);
      if (track) track.setDeadline = nms => { clearTimeout(deadline); deadline = setTimeout(() => finish(bad('timeout', 'The terminal did not answer in time')), nms); };
      sock.setNoDelay(true);
      sock.on('connect', () => { connected = true; sock.write(frame(obj, framing)); });
      sock.on('data', d => {
        for (const o of rd.push(d.toString('utf8'))) {
          if (track) { const s = str(o.STAN_ID || o.STAN_NO); if (s) track.stan = s; }
          if (isAck(o)) continue;
          finish(null, o); return;
        }
      });
      sock.on('error', e => finish(bad(connected ? 'dropped' : 'unreachable', connected ? 'Lost the connection to the terminal' : `Could not connect to the terminal at ${host}:${p} (${e.code || e.message})`)));
      sock.on('close', () => finish(bad(connected ? 'dropped' : 'unreachable', connected ? 'Lost the connection to the terminal' : `Could not connect to the terminal at ${host}:${p}`)));
      sock.connect(p, host);
    });
  }

  const simple = async (obj, ms) => {
    try { return normalizeValor(await exchange(port, obj, ms || 30000)); }
    catch (e) { return failure(e.message, { unreachable: e.kind === 'unreachable', unknown: e.kind !== 'unreachable' }); }
  };

  async function cancel({ ref } = {}) {
    try { const r = await exchange(cport, { TRAN_MODE: '99', REQ_TXN_ID: str(ref || active.ref) }, 6000); const n = normalizeValor(r); n.ok = true; n.message = 'Cancel sent to the terminal'; return n; }
    catch (e) { return failure('Could not send cancel to the terminal: ' + e.message); }
  }

  async function status({ stan } = {}) {
    return simple({ TRAN_MODE: '90', STAN_NO: str(stan) }, 15000);
  }

  /** Run a money request. On timeout / dropped link: cancel, ask status, never resend. */
  async function money(obj, label) {
    const track = { stan: '' };
    active.track = track;
    try {
      const r = await exchange(port, obj, timeoutMs, track);
      return normalizeValor(r);
    } catch (e) {
      if (e.kind === 'unreachable') return failure(e.message, { unreachable: true });
      // The request went out but no clear answer came back. Do not send it again.
      if (!active.cancelRequested) { try { await cancel({ ref: obj.REQ_TXN_ID || active.ref }); } catch (x) { /* ignore */ } }
      if (track.stan) {
        const s = await status({ stan: track.stan });
        if (s.raw && s.raw.STATE === '0' && (s.raw.TRAN_METHOD || s.raw.TRAN_TYPE)) { s.recovered = true; return s; } // it was approved after all
        if (s.raw && s.raw.STATE === '-1' && s.cancelled) return s;                                                  // clearly cancelled
      }
      return failure(`${label}: unknown result. Look at the terminal screen or its receipt to see if the card was charged. Do not run it again until you know.`, { unknown: true, stan: track.stan });
    }
  }

  const saleObj = ({ mode, cents, cashbackCents, ref }, code) => {
    const o = { TRAN_MODE: MODES[mode] || '1', TRAN_CODE: code, AMOUNT: String(Math.round(cents)), TIP_ENTRY: '0', SIGNATURE: '0', PAPER_RECEIPT: '3', MOBILE_ENTRY: '0',
      REQ_TXN_ID: str(ref), EARLY_RESPONSE: '1', CANCEL_CONFIRMATION: '0' };
    if (mode === 'debit' && cashbackCents > 0) o.CASHBACK_AMOUNT = String(Math.round(cashbackCents));
    return o;
  };

  return {
    name: 'valor',
    test: async () => {
      const r = await simple({ TRAN_MODE: '96' }, 15000);
      if (r.raw) {
        const bits = Object.entries(r.raw).filter(([k, v]) => /VER|IP|SERIAL|MODEL|APP|NAME|MERCHANT/i.test(k) && v !== '').map(([k, v]) => `${k}: ${v}`);
        if (r.raw.STATE === undefined || r.raw.STATE === '0') { r.ok = true; r.message = bits.length ? 'Terminal answered. ' + bits.join(', ') : 'Terminal answered.'; }
      }
      return r;
    },
    sale: o => money(saleObj(o, '1'), 'Card payment'),
    refund: o => money(saleObj(o, '5'), 'Card refund'),
    void: ({ tranNo, ref }) => money({ TRAN_MODE: '0', TRAN_CODE: '2', TRAN_NO: str(tranNo), VOID_CONFIRMATION: '0', PAPER_RECEIPT: '2', REQ_TXN_ID: str(ref) }, 'Void'),
    settle: () => money({ TRAN_MODE: '0', TRAN_CODE: '9', SETTLE_CONFIRMATION: '0' }, 'Close batch'),
    ebtBalance: ({ mode } = {}) => money({ TRAN_MODE: mode === 'ebt_cash' ? '4' : '3', TRAN_CODE: '8' }, 'EBT balance'),
    status, cancel,
    // timers the manager can shorten after the cashier presses Cancel
    shortenAfterCancel: ms => { const t = active.track; if (t && t.setDeadline) t.setDeadline(ms); }
  };
}

/* ---------- Demo driver (simulated terminal inside the app) ---------- */
const demoState = { tranNo: 20, batchNo: 78, stan: 19, sales: [], busyAbort: null };
function demoDriver(cfg, hooks) {
  const delay = cfg.termDemoDelayMs !== undefined ? +cfg.termDemoDelayMs : 2000;
  const surPct = +cfg.termDemoSurchargePct || 0;
  const active = hooks.active;
  const ok = (o) => Object.assign(emptyResult(), { ok: true, message: 'Approved' }, o);
  const wait = async () => { const sig = {}; active.abort = () => sig.wake && sig.wake(); active.aborted = false; await sleep(delay, sig); const a = active.aborted; active.abort = null; return a; };
  const cancelled = () => failure('Transaction Timeout/Cancelled', { cancelled: true, raw: { STATE: '-1', ERROR_MSG: 'Transaction Timeout/Cancelled' } });
  const stampSale = (mode, cents, extra) => {
    demoState.tranNo++; demoState.stan++;
    const sur = surPct > 0 && (mode === 'credit') ? Math.round(cents * surPct / 100) : 0;
    const r = ok({ approvedCents: cents, surchargeCents: sur, totalCents: cents + sur, authCode: 'DEMO' + String(demoState.tranNo).padStart(3, '0'), last4: '4242', brand: mode === 'debit' ? 'DEBIT' : 'VISA',
      entry: 'TAP', rrn: String(514712500000 + demoState.tranNo), txnId: String(900000 + demoState.tranNo), tranNo: String(demoState.tranNo), batchNo: String(demoState.batchNo),
      stan: String(demoState.stan), aid: 'A0000000031010', tvr: '0000000000', tsi: '0000' }, extra || {});
    r.raw = { STATE: '0', TRAN_TYPE: mode, AMOUNT: String(cents), MASKED_PAN: '**** 4242', DEMO: '1' };
    return r;
  };
  return {
    name: 'demo',
    test: async () => ok({ message: 'Demo terminal (simulated). No real card is used.', raw: { DEMO: '1' } }),
    async sale({ mode, cents, cashbackCents }) {
      if (await wait()) return cancelled();
      const c = Math.round(cents);
      if (c % 100 === 99) { await sleep(Math.min(delay, 500)); return failure('Demo: no answer from the terminal. Look at the terminal screen.', { unknown: true }); }
      if (c % 100 === 13) return failure('DECLINED (demo)', { errorCode: '05', raw: { STATE: '-1', ERROR_MSG: 'DECLINED (demo)' } });
      let res;
      if (c % 100 === 51) { const part = Math.floor(c / 2); res = stampSale(mode, part); res.partial = true; res.raw.PARTIAL = '1'; res.raw.AMOUNT_DUE = String(c - part); }
      else res = stampSale(mode, c);
      if (mode === 'debit' && cashbackCents > 0) { res.cashbackCents = Math.round(cashbackCents); res.totalCents += res.cashbackCents; }
      demoState.sales.push({ tranNo: res.tranNo, cents: res.totalCents });
      return res;
    },
    async refund({ mode, cents }) { if (await wait()) return cancelled(); const r = stampSale(mode, Math.round(cents)); r.surchargeCents = 0; r.totalCents = r.approvedCents; return r; },
    async void({ tranNo }) {
      if (await wait()) return cancelled();
      const i = demoState.sales.findIndex(s => s.tranNo === str(tranNo));
      if (i < 0) return failure('Demo: that sale is not in the open batch (already settled, or not a demo sale).', { errorCode: 'NF' });
      const s = demoState.sales.splice(i, 1)[0];
      return ok({ approvedCents: s.cents, totalCents: s.cents, tranNo: str(tranNo), batchNo: String(demoState.batchNo), message: 'Voided', raw: { STATE: '0', TRAN_METHOD: 'Void' } });
    },
    async settle() {
      if (await wait()) return cancelled();
      const n = demoState.sales.length, tot = demoState.sales.reduce((a, s) => a + s.cents, 0);
      const r = ok({ batchNo: String(demoState.batchNo), totalCents: tot, message: `Batch ${demoState.batchNo} closed: ${n} sale${n === 1 ? '' : 's'}`, raw: { STATE: '0', BATCH_NO: String(demoState.batchNo), SALE_COUNT: String(n), TOTAL_AMOUNT: String(tot) } });
      r.count = n; demoState.sales = []; demoState.batchNo++; return r;
    },
    async ebtBalance() { if (await wait()) return cancelled(); return ok({ ebtBalanceCents: 12345, message: 'EBT balance $123.45 (demo)' }); },
    async status() { return failure('Demo terminal has no history', {}); },
    async cancel() { active.aborted = true; if (active.abort) active.abort(); return ok({ message: 'Cancelled (demo)' }); },
    shortenAfterCancel: () => {}
  };
}

function poslinkDriver() {
  const no = () => { throw new Error('PAX POSLink is not available yet'); };
  return { name: 'poslink', test: no, sale: no, refund: no, void: no, settle: no, ebtBalance: no, status: no, cancel: no, shortenAfterCancel: () => {} };
}

/* ---------- manager: one request at a time, picks the driver from the PC settings ---------- */
function createManager(getCfg) {
  let busy = null;            // name of the running request
  const active = { ref: '', cancelRequested: false, abort: null, aborted: false, track: null };
  let driverCache = null, cacheKey = '';
  const driver = () => {
    const c = getCfg() || {};
    const key = JSON.stringify([c.termDriver, c.termIp, c.termPort, c.termCancelPort, c.termFraming, c.termTimeoutSec, c.termDemoDelayMs, c.termDemoSurchargePct]);
    if (!driverCache || key !== cacheKey) {
      const d = c.termDriver === 'demo' ? demoDriver : c.termDriver === 'poslink' ? poslinkDriver : valorDriver;
      driverCache = d(c, { active }); cacheKey = key;
    }
    return driverCache;
  };
  const guard = async (name, fn) => {
    const c = getCfg() || {};
    if (!c.termEnabled) return failure('The card terminal is turned off (Settings, Card terminal).', { disabled: true });
    if (busy) return failure('Terminal busy. Wait for the current card request to finish.', { busy: true });
    busy = name; active.cancelRequested = false; active.track = null; active.aborted = false;
    try { const r = await fn(driver()); return r; }
    catch (e) { return failure(e.message || String(e), { unreachable: true }); }
    finally { busy = null; active.ref = ''; active.track = null; }
  };
  const withRef = (name, fn) => o => { o = o || {}; return guard(name, d => { active.ref = str(o.ref); return fn(d, o); }); };
  return {
    isBusy: () => !!busy,
    test: withRef('test', (d) => d.test()),
    sale: withRef('sale', (d, o) => d.sale(o)),
    refund: withRef('refund', (d, o) => d.refund(o)),
    void: withRef('void', (d, o) => d.void(o)),
    settle: withRef('settle', (d) => d.settle()),
    ebtBalance: withRef('ebtBalance', (d, o) => d.ebtBalance(o)),
    status: async (o) => { const c = getCfg() || {}; if (!c.termEnabled) return failure('The card terminal is turned off.', { disabled: true }); try { return await driver().status(o || {}); } catch (e) { return failure(e.message); } },
    cancel: async (o) => {
      const c = getCfg() || {}; if (!c.termEnabled) return failure('The card terminal is turned off.', { disabled: true });
      try {
        active.cancelRequested = true;
        const d = driver();
        const r = await d.cancel({ ref: (o && o.ref) || active.ref });
        if (busy && d.shortenAfterCancel) d.shortenAfterCancel(20000); // do not wait the full timeout after the cashier cancelled
        return r;
      } catch (e) { return failure(e.message); }
    }
  };
}

module.exports = { createManager, valorDriver, demoDriver, poslinkDriver, normalizeValor, safeRaw, FrameReader, isAck, frame };
