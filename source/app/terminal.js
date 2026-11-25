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
 *          poslink (PAX BroadPOS/POSLink "Interface Between ECR and Terminal", TCP or HTTP; see the PAX section below).
 * Never keep more than the last 4 digits of a card number anywhere (raw has MASKED_PAN cut down to last 4).
 */
const net = require('net');
const http = require('http');

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
  const timeoutMs = Math.max(1, +cfg.termTimeoutSec || 200) * 1000;
  const active = hooks.active; // { ref, cancelRequested, stan }

  /** One request, one connection. Resolves with the first real (non-ACK) result object.
   *  Rejects with Error having .kind = 'unreachable' | 'timeout' | 'dropped'. */
  function exchange(p, obj, ms, track, lenient) {
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
          if (isAck(o) && !lenient) continue;
          finish(null, o); return;
        }
      });
      sock.on('error', e => finish(bad(connected ? 'dropped' : 'unreachable', connected ? 'Lost the connection to the terminal' : `Could not connect to the terminal at ${host}:${p} (${e.code || e.message})`)));
      sock.on('close', () => lenient && connected ? finish(null, { STATE: '0', MSG: 'closed' }) : finish(bad(connected ? 'dropped' : 'unreachable', connected ? 'Lost the connection to the terminal' : `Could not connect to the terminal at ${host}:${p}`)));
      sock.connect(p, host);
    });
  }

  const simple = async (obj, ms) => {
    try { return normalizeValor(await exchange(port, obj, ms || 30000)); }
    catch (e) { return failure(e.message, { unreachable: e.kind === 'unreachable', unknown: e.kind !== 'unreachable' }); }
  };

  async function cancel({ ref } = {}) {
    try { const r = await exchange(cport, { TRAN_MODE: '99', REQ_TXN_ID: str(ref || active.ref) }, 6000, null, true); const n = normalizeValor(r); n.ok = true; n.message = 'Cancel sent to the terminal'; return n; }
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

/* ---------- PAX POSLink / BroadPOS driver ----------
 * Protocol: PAX "Interface Between ECR and Terminal" V1.65 (the spec is PAX's licensed document and is NOT kept in this repo).
 * Section names below point to where each rule comes from. Terminal = server (default port 10009), the register = client.
 *   TCP  (default): <STX><fields separated by FS><ETX><LRC>, then ACK / response / ACK / EOT   (spec 3.1, 3.2, 3.4)
 *   HTTP (option) : GET /?<base64 of the same frame>, the body of the 200 answer is the response frame (spec 3.3)
 */
const FS = '\x1c', US = '\x1f';            // spec 3.2 Control Characters: FS separates fields, US separates sub-fields
const ACK = 0x06, NAK = 0x15, EOT = 0x04;

/** LRC = XOR of every byte after STX up to and including ETX (spec 3.2). */
const paxLrc = buf => { let r = 0; for (const b of buf) r ^= b; return r; };
/** Build a request frame from a list of fields: STX + fields joined by FS + ETX + LRC. */
const paxFrame = fields => { const body = Buffer.from(fields.join(FS) + '\x03', 'latin1'); return Buffer.concat([Buffer.from([STX]), body, Buffer.from([paxLrc(body)])]); };
/** Reference sent as ECR reference number / invoice number: letters, digits, . _ - only, at most 16 (spec 6.1 "REFERENCE INVALID: length more than 16"). */
const paxRef = r => str(r).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16);
const brandOf = { '01': 'VISA', '02': 'MASTERCARD', '03': 'AMEX', '04': 'DISCOVER', '05': 'DINERS', '07': 'JCB', '17': 'INTERAC', '18': 'UNIONPAY', '19': 'MAESTRO', '32': 'DNA' }; // spec 4.5 Card Type Definition
const entryOf = { '0': 'MANUAL', '1': 'SWIPE', '2': 'TAP', '3': 'SCAN', '4': 'CHIP', '5': 'SWIPE' };                                                        // spec 5.9.2 Entry Mode

/** Splits a byte stream into ACK / NAK / EOT bytes and checked frames. Anything else between frames is dropped. */
class PaxReader {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const ev = [];
    for (;;) {
      if (!this.buf.length) break;
      const b = this.buf[0];
      if (b === ACK || b === NAK || b === EOT) { ev.push({ t: b === ACK ? 'ack' : b === NAK ? 'nak' : 'eot' }); this.buf = this.buf.subarray(1); continue; }
      if (b !== STX) { this.buf = this.buf.subarray(1); continue; }
      const e = this.buf.indexOf(ETX, 1);
      if (e < 0 || this.buf.length < e + 2) break;                       // wait for the rest (ETX and the LRC byte)
      ev.push({ t: 'frame', ok: paxLrc(this.buf.subarray(1, e + 1)) === this.buf[e + 1], data: this.buf.subarray(1, e).toString('latin1') });
      this.buf = this.buf.subarray(e + 2);
    }
    return ev;
  }
}
/** "cmd FS version FS code FS message FS rest..." -> object (the leading status field is handled by the exchange). */
function paxParseText(text) { const f = text.split(FS); return { cmd: f[0] || '', ver: f[1] || '', code: f[2] || '', msg: f[3] || '', rest: f.slice(4) }; }
/** Additional-information group: NAME=value separated by US (spec 5.9.11). */
function paxAdditional(s) { const o = {}; for (const part of str(s).split(US)) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i)] = part.slice(i + 1); } return o; }

/* Where each group sits in the response, counted after the Response Message field (spec 5.1.1.2 A01, 5.2.1.2 T01, 5.2.2.2 T03, 5.2.3.2 T05, 5.3.1.2 B01, 5.4.2.2 R03) */
const PAX_LAYOUT = {
  T01: { host: 0, type: 1, amount: 2, acct: 3, trace: 4, add: 8 },
  T03: { host: 0, type: 1, amount: 2, acct: 3, trace: 4, add: 5 },
  T05: { host: 0, type: 1, amount: 2, acct: 3, trace: 4, add: 5 },
  R03: { host: 2, edc: 3, type: 4, amount: 6, acct: 7, trace: 8, add: 12 }
};
/** What a response code (spec 6.1 Response Code) means for the register. */
function paxCodeInfo(code) {
  const c = str(code);
  if (c === '000000' || c === '000001' || c === '000003') return { ok: true };       // OK / approved offline / approved but surcharge not applied
  if (c === '000002') return { ok: true, partial: true };                           // partially approved
  if (c === '000100') return { declined: true };                                    // DECLINE (host error)
  if (c === '100001') return { timedOut: true };                                    // customer did not finish at the terminal
  if (c === '100002') return { cancelled: true };                                   // ABORTED (customer or cancel from ECR)
  if (['100007', '100009', '100101'].includes(c)) return { unknown: true };         // bad host answer / no host answer / host error: terminal sends a reversal, outcome not certain
  if (['100503', '100511', '100516', '100519', '100520', '100521'].includes(c)) return { busy: true }; // PED/service busy, downloading, reversal or advice running: nothing was done
  return {};
}
const PAX_FRIENDLY = { '100001': 'The customer did not finish on the terminal in time.', '100002': 'Cancelled on the terminal.', '100025': 'The terminal says to close the batch first (Settings, Card terminal, Close batch now).', '100011': 'The terminal says this looks like a duplicate of a card payment it already has.', '100021': 'That payment is already voided.', '100023': 'The terminal could not find that payment (already settled or voided?).', '100500': 'The customer did not accept the card surcharge.' };

/** Build the normalized result from the parsed groups of one response or one report record. */
function paxBuild(m, parts, info, ctx) {
  const out = emptyResult();
  const host = parts.host, amt = parts.amt, acct = parts.acct, tr = parts.trace, add = parts.add;
  const hostCode = str(host[0]), hostMsg = str(host[1]);
  out.ok = !!info.ok; out.partial = !!info.partial;
  out.errorCode = hostCode || str(m.code);
  out.authCode = str(host[2]);
  out.txnId = str(add.HRef || host[3]);                // host reference: kept for refunds / lookups
  out.stan = str(host[4]);
  out.batchNo = str(host[5]);
  out.rrn = str(host[10]);
  out.tranNo = str(tr[0]);                             // transaction number in the terminal: needed to void
  out.last4 = last4Of(acct[0]) || last4Of(acct[13]);   // the terminal may return the whole number: only the last 4 is kept
  out.entry = entryOf[str(acct[1])] || '';
  const baseBrand = brandOf[str(acct[6])] || str(add.APPLAB || '').replace(/\s*(CREDIT|DEBIT)\s*$/i, '').trim();
  out.brand = ctx.edc === 'ebt' ? 'EBT' : ctx.edc === 'debit' ? (baseBrand ? baseBrand + ' DEBIT' : 'DEBIT') : baseBrand;
  out.aid = str(add.AID); out.tvr = str(add.TVR); out.tsi = str(add.TSI);
  let approved = toCents(amt[0]);
  const sur = toCents(amt[12]) || toCents(amt[4]);     // surcharge / merchant fee approved by the host (else the requested one)
  const cb = toCents(amt[11]) || toCents(amt[3]);
  out.surchargeCents = sur; out.cashbackCents = cb;
  const req = ctx.requestedCents || 0;
  // If the terminal's "approved amount" already contains the surcharge or cash back, take them out so the sale amount stays what the POS asked for.
  if (req && sur && approved === req + sur) approved -= sur;
  if (req && cb && approved === req + cb) approved -= cb;
  if (out.ok && !approved && req && ctx.kind !== 'void' && ctx.kind !== 'balance') approved = req; // "OK" with no amount shown: it took what we asked
  out.approvedCents = out.ok ? approved : 0;
  out.totalCents = out.ok ? approved + sur + cb : 0;
  if (out.ok && req && approved < req) out.partial = true;
  if (ctx.kind === 'balance' || (amt[6] !== undefined && amt[6] !== '') || (amt[7] !== undefined && amt[7] !== '')) {
    const b = ctx.mode === 'ebt_cash' ? amt[6] : amt[7];  // Balance1 = EBT cash benefits, Balance2 = food stamps (spec 5.9.1)
    if (b !== undefined && b !== '') out.ebtBalanceCents = toCents(b);
  }
  // raw: no card numbers, no track data, no signature; only fields that are useful for support
  const keep = ['AID', 'TVR', 'TSI', 'ATC', 'APPLAB', 'APPPN', 'TC', 'ARC', 'CVM', 'PINSTATUSNUM', 'EDCTYPE', 'SN', 'GLOBALUID', 'SETTLEMENTDATE', 'HRef', 'PROGRAMTYPE', 'CARDBIN', 'FAILEDCOUNT', 'FAILEDTRANSNO', 'SAFFAILEDCOUNT', 'APPNAME', 'APPVERSION'];
  out.raw = { CMD: m.cmd, CODE: str(m.code), MESSAGE: str(m.msg), HOST_CODE: hostCode, HOST_MESSAGE: hostMsg };
  for (const k of keep) if (add[k] !== undefined) out.raw[k] = add[k];
  if (acct[0]) out.raw.MASKED_PAN = '**** ' + out.last4;
  if (amt[1]) out.raw.AMOUNT_DUE = str(amt[1]);
  if (info.partial || out.partial) out.raw.PARTIAL = '1';
  out.raw = safeRaw(out.raw);
  const friendly = PAX_FRIENDLY[str(m.code)];
  if (out.ok) out.message = str(m.code) === '000003' ? 'Approved (the terminal did not add the surcharge)' : out.partial ? 'Partially approved' : 'Approved';
  else if (info.declined) out.message = hostMsg || str(m.msg) || 'Declined';
  else out.message = friendly || str(m.msg) || hostMsg || ('Terminal answered ' + str(m.code));
  if (info.cancelled) out.cancelled = true;
  if (info.busy) { out.busy = true; out.message = `The terminal is busy (${str(m.msg) || m.code}). Wait a moment and try again.`; }
  if (info.unknown) { out.unknown = true; out.message = `The terminal reported "${str(m.msg) || m.code}". The card may or may not have been charged. Look at the terminal screen or its receipt before trying again.`; }
  return out;
}
/** A transaction response (T01/T03/T05) -> result. */
function paxToResult(m, ctx) {
  const lay = PAX_LAYOUT[m.cmd] || PAX_LAYOUT.T01;
  const g = i => (i === undefined ? '' : str(m.rest[i]));
  const sp = i => g(i).split(US);
  return paxBuild(m, { host: sp(lay.host), amt: sp(lay.amount), acct: sp(lay.acct), trace: sp(lay.trace), add: paxAdditional(g(lay.add)) }, paxCodeInfo(m.code), ctx || {});
}
/** A Local Detail Report record (R03) -> result. The record's own host response code says if it was approved. */
function paxRecordToResult(m, ctx) {
  const lay = PAX_LAYOUT.R03;
  const g = i => str(m.rest[i]);
  const parts = { host: g(lay.host).split(US), amt: g(lay.amount).split(US), acct: g(lay.acct).split(US), trace: g(lay.trace).split(US), add: paxAdditional(g(lay.add)) };
  const hc = str(parts.host[0]);
  const approved = /^0{1,6}$|^10$/.test(hc) && toCents(parts.amt[0]) > 0;
  return paxBuild(m, parts, approved ? { ok: true } : { declined: true }, ctx || {});
}

/* One request on one TCP connection (spec 3.4). Resolves with the list of response messages, rejects with Error{kind, sent}:
 *   unreachable = could not connect, or the terminal refused the message (NAK) -> nothing was started, safe to try again
 *   noack / timeout / dropped / badlrc = the request went out but there was no clean answer -> outcome unknown
 * o: {timeoutMs, safeResend (non-money commands may be sent again when there is no ACK), abortFields, track} */
function paxTcp(host, port, fields, o) {
  return new Promise((resolve, reject) => {
    const reqFrame = paxFrame(fields);
    const sock = new net.Socket();
    const rd = new PaxReader();
    let state = 'connect', done = false, sent = false, attempts = 0, badIn = 0, respMs = o.timeoutMs;
    let cur = null; const msgs = [];
    let tConn, tAck, tResp, tColl;
    const timers = () => { clearTimeout(tConn); clearTimeout(tAck); clearTimeout(tResp); clearTimeout(tColl); };
    const finish = (err, val) => {
      if (done) return; done = true; timers();
      if (err) { try { sock.destroy(); } catch (e) { /* ignore */ } reject(err); return; }
      try { sock.end(); } catch (e) { /* ignore */ }
      setTimeout(() => { try { sock.destroy(); } catch (e) { /* ignore */ } }, 500).unref();
      resolve(val);
    };
    const fail = (kind, msg) => { const e = new Error(msg); e.kind = kind; e.sent = sent; finish(e); };
    const collected = () => { if (cur) { msgs.push(Object.assign(paxParseText(cur.text), { status: cur.status })); cur = null; } return msgs; };
    const done_ = () => { const r = collected(); if (r.length) finish(null, r); else fail('dropped', 'Lost the connection to the terminal'); };
    const send = () => { attempts++; state = 'ack'; sock.write(reqFrame); clearTimeout(tAck); tAck = setTimeout(() => {
      // spec 3.4.7: no ACK within 3 seconds. A card payment is never sent twice: only harmless commands are repeated.
      if (o.safeResend && attempts < 3) send(); else fail('noack', 'The terminal did not acknowledge the request');
    }, o.ackMs || 3000); };
    const gotAck = () => { clearTimeout(tAck); if (state === 'ack') { state = 'resp'; clearTimeout(tResp); tResp = setTimeout(() => fail('timeout', 'The terminal did not answer in time'), respMs); } };
    if (o.track) {
      o.track.alive = true;
      o.track.abort = () => { if (done || !sent) return false; try { sock.write(paxFrame(o.abortFields)); return true; } catch (e) { return false; } };  // spec 5.1.8 Cancel (A14), no response
      o.track.setDeadline = ms => { respMs = ms; if (state === 'resp') { clearTimeout(tResp); tResp = setTimeout(() => fail('timeout', 'The terminal did not answer in time'), ms); } };
    }
    tConn = setTimeout(() => fail('unreachable', `Could not connect to the terminal at ${host}:${port}`), 8000);
    sock.setNoDelay(true);
    sock.on('connect', () => { clearTimeout(tConn); sent = true; send(); });
    sock.on('data', d => {
      for (const ev of rd.push(d)) {
        if (done) return;
        if (ev.t === 'nak') {                                       // spec 3.4.2: terminal got a damaged request, send it again (it has not started anything)
          if (state !== 'ack') continue;
          if (attempts < 3) send(); else fail('unreachable', 'The terminal did not accept the message (checksum errors)');
        } else if (ev.t === 'ack') {
          gotAck();
        } else if (ev.t === 'eot') {
          if (state === 'collect') { done_(); return; }
        } else if (ev.t === 'frame') {
          if (state === 'ack') gotAck();                            // an answer is proof that the request arrived
          if (!ev.ok) {                                             // spec 3.4.3 / 3.4.6: bad LRC -> NAK, the terminal sends it again
            if (++badIn >= 3) { fail('badlrc', 'The terminal answer was damaged three times'); return; }
            sock.write(Buffer.from([NAK])); continue;
          }
          sock.write(Buffer.from([ACK]));
          clearTimeout(tResp);
          const i = ev.data.indexOf(FS), status = ev.data.slice(0, i), body = ev.data.slice(i + 1);
          // status 1 = the answer is cut into several packets, join them (spec 3.4.10); a new "cmd FS" start means the next record (spec 3.4.8)
          if (cur && cur.status === '1' && !body.startsWith(paxParseText(cur.text).cmd + FS)) { cur.text += body; cur.status = status; }
          else { collected(); cur = { status, text: body }; }
          state = 'collect'; clearTimeout(tColl); tColl = setTimeout(done_, cur.status === '1' ? 3000 : 1500);
        }
      }
    });
    sock.on('error', e => { if (state === 'connect') fail('unreachable', `Could not connect to the terminal at ${host}:${port} (${e.code || e.message})`); else if (state === 'collect') done_(); else fail('dropped', 'Lost the connection to the terminal'); });
    sock.on('close', () => { if (done) return; if (state === 'connect') fail('unreachable', `Could not connect to the terminal at ${host}:${port}`); else if (state === 'collect') done_(); else fail('dropped', 'Lost the connection to the terminal'); });
    sock.connect(port, host);
  });
}

/* Same request over HTTP: GET /?<base64 frame>. The answer body is the response frame; 400 = bad LRC (spec 3.3). */
function paxHttp(host, port, fields, o) {
  return new Promise((resolve, reject) => {
    let done = false, sent = false, tm;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(tm); try { req.destroy(); } catch (e) { /* ignore */ } err ? reject(err) : resolve(val); };
    const fail = (kind, msg) => { const e = new Error(msg); e.kind = kind; e.sent = sent; finish(e); };
    const req = http.request({ host, port, method: 'GET', path: '/?' + paxFrame(fields).toString('base64'), headers: { Host: host, Connection: 'close' }, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', () => fail('dropped', 'Lost the connection to the terminal'));
      res.on('end', () => {
        if (res.statusCode === 400) return fail('unreachable', 'The terminal refused the message (bad checksum)');
        if (res.statusCode !== 200) return fail('dropped', 'The terminal answered HTTP ' + res.statusCode);
        const msgs = []; let cur = null;
        for (const ev of new PaxReader().push(Buffer.concat(chunks))) {
          if (ev.t !== 'frame') continue;
          if (!ev.ok) return fail('badlrc', 'The terminal answer was damaged');
          const i = ev.data.indexOf(FS), status = ev.data.slice(0, i), body = ev.data.slice(i + 1);
          if (cur && cur.status === '1' && !body.startsWith(paxParseText(cur.text).cmd + FS)) { cur.text += body; cur.status = status; }
          else { if (cur) msgs.push(Object.assign(paxParseText(cur.text), { status: cur.status })); cur = { status, text: body }; }
        }
        if (cur) msgs.push(Object.assign(paxParseText(cur.text), { status: cur.status }));
        if (!msgs.length) return fail('dropped', 'The terminal sent no answer');
        finish(null, msgs);
      });
    });
    let respMs = o.timeoutMs;
    const arm = ms => { clearTimeout(tm); tm = setTimeout(() => fail(sent ? 'timeout' : 'unreachable', sent ? 'The terminal did not answer in time' : `Could not connect to the terminal at ${host}:${port}`), ms); };
    arm(sent ? respMs : 8000);
    req.on('finish', () => { sent = true; arm(respMs); });
    req.on('error', e => fail(sent ? 'dropped' : 'unreachable', sent ? 'Lost the connection to the terminal' : `Could not connect to the terminal at ${host}:${port} (${e.code || e.message})`));
    if (o.track) {
      o.track.alive = true;
      o.track.abort = () => { if (done) return false; paxHttp(host, port, o.abortFields, { timeoutMs: 3000 }).catch(() => {}); return true; };   // Cancel goes on its own request
      o.track.setDeadline = ms => { respMs = ms; if (sent) arm(ms); };
    }
    req.end();
  });
}

function poslinkDriver(cfg, hooks) {
  const host = str(cfg.termIp).trim();
  const port = +cfg.termPort || 10009;                                  // spec 2.1.3: default port 10009
  const viaHttp = cfg.termProtocol === 'http';
  const ver = str(cfg.termPaxVersion).trim() || '1.28';                 // protocol version sent in every command (the spec's own worked examples use 1.28)
  const timeoutMs = Math.max(1, +cfg.termTimeoutSec || 300) * 1000;    // spec 3.4.1: the register waits up to 300 seconds
  const lookupDelay = cfg.termPaxLookupDelayMs !== undefined ? +cfg.termPaxLookupDelayMs : 3000;
  const receipt = str(cfg.termPaxReceipt).trim();                       // '' = leave it to the terminal; 0..3 = RECEIPTPRINT (spec 5.8.11)
  const active = hooks.active;
  const add = () => receipt === '' ? '' : 'RECEIPTPRINT=' + receipt;
  const request = (fields, o) => {
    if (!host) { const e = new Error('No terminal IP address is set (Settings, Card terminal).'); e.kind = 'unreachable'; return Promise.reject(e); }
    return (viaHttp ? paxHttp : paxTcp)(host, port, fields, Object.assign({ abortFields: ['A14', ver] }, o));
  };
  /* Cancel on a fresh connection, for when the first one is gone (spec 5.1.8: A14 has no answer) */
  async function abortFresh() {
    if (!host) return false;
    if (viaHttp) { try { await paxHttp(host, port, ['A14', ver], { timeoutMs: 3000 }); } catch (e) { /* no answer is normal */ } return true; }
    return new Promise(res => {
      const s = new net.Socket(); let ok = false;
      const end = () => { try { s.destroy(); } catch (e) { /* ignore */ } res(ok); };
      const t = setTimeout(end, 1500);
      s.on('connect', () => { ok = true; s.write(paxFrame(['A14', ver])); });
      s.on('data', () => { clearTimeout(t); end(); });
      s.on('error', () => { clearTimeout(t); end(); });
      s.on('close', () => { clearTimeout(t); end(); });
      s.connect(port, host);
    });
  }
  /* Ask the terminal for what it did with an ECR reference or transaction number: Local Detail Report R02, all results (spec 5.4.2) */
  async function lookup({ ref, tranNo }, tries, ctx) {
    for (let i = 0; i < tries; i++) {
      if (i > 0) await sleep(lookupDelay);
      let msgs;
      try { msgs = await request(['R02', ver, '00', '', '', '', str(tranNo), '', paxRef(ref), '', '2'], { timeoutMs: 15000, safeResend: true }); } catch (e) { continue; }
      const recs = msgs.filter(m => m.cmd === 'R03' && m.code === '000000' && (!ref || str(str(m.rest[PAX_LAYOUT.R03.trace]).split(US)[1]) === paxRef(ref)));
      if (recs.length) { const r = paxRecordToResult(recs[recs.length - 1], ctx || {}); return { found: true, result: r }; }
    }
    return { found: false };
  }
  /** Run a command that moves money. Timeout / lost link: cancel, look it up, otherwise "unknown". It is NEVER sent again. */
  async function money(fields, label, ctx) {
    const track = {}; active.track = track;
    const ref = ctx.ref;
    try {
      const msgs = await request(fields, { timeoutMs, safeResend: false, track });
      const m = msgs[0];
      if (!/^(T01|T03|T05)$/.test(m.cmd)) return failure(`${label}: the terminal answered ${m.cmd} ${m.code} ${m.msg}`.trim(), { errorCode: m.code });
      return paxToResult(m, ctx);
    } catch (e) {
      if (e.kind === 'unreachable') return failure(e.message, { unreachable: true });
      if (!active.cancelRequested) { try { await abortFresh(); } catch (x) { /* ignore */ } }
      if (ctx.kind === 'sale' || ctx.kind === 'refund' || ctx.kind === 'void') {
        const l = await lookup({ ref }, 3, ctx);
        if (l.found && (l.result.ok || l.result.errorCode)) { l.result.recovered = true; if (!l.result.ok && l.result.message) l.result.message += ' (checked on the terminal)'; return l.result; }
      }
      return failure(`${label}: unknown result. Look at the terminal screen or its receipt to see if the card was charged. Do not run it again until you know.`, { unknown: true });
    }
  }
  const amount = (c, extra) => String(Math.round(c)) + (extra || '');
  const need = cents => (Math.round(cents) > 0 ? null : failure('The amount must be more than zero.'));
  const cmdOf = mode => (mode === 'debit' ? 'T02' : /^ebt/.test(mode) ? 'T04' : 'T00');
  const edcOf = mode => (mode === 'debit' ? 'debit' : /^ebt/.test(mode) ? 'ebt' : 'credit');
  const ebtType = mode => (mode === 'ebt_cash' ? 'C' : 'F');                  // spec 5.8.2 EBT type: C cash benefits, F food stamp
  /** Request fields. Order per spec 5.2.1.1 (T00), 5.2.2.1 (T02), 5.2.3.1 (T04). */
  function txnFields(mode, type, amountInfo, ref) {
    const cmd = cmdOf(mode), trace = ref + US + ref;                        // ECR reference number + invoice number
    const acct = /^ebt/.test(mode) && type !== '23' && type !== '16' ? US + US + US + ebtType(mode) : '';
    if (cmd === 'T00') return ['T00', ver, type, amountInfo, acct, trace, '', '', '', '', add()];          // type, amount, account, trace, AVS, cashier, commercial, MOTO, additional
    return [cmd, ver, type, amountInfo, acct, trace, '', add()];                                         // type, amount, account, trace, cashier, additional
  }
  const refOf = o => paxRef(o && o.ref) || ('R' + String(Date.now()).slice(-9));
  function saleOrReturn(type, kind) {
    return o => {
      const bad = need(o.cents); if (bad) return Promise.resolve(bad);
      const mode = o.mode || 'credit', ref = refOf(o);
      let amt = amount(o.cents);
      // Debit and EBT cash can ask for cash back on the terminal. Say "0" so it does not prompt (spec 5.8.1 Cash Back Amount). Surcharge is left empty: the terminal uses its own setting.
      if (kind === 'sale' && (mode === 'debit' || mode === 'ebt_cash')) amt = amount(o.cents, US + US + Math.max(0, Math.round(o.cashbackCents || 0)));
      return money(txnFields(mode, type, amt, ref), kind === 'sale' ? 'Card payment' : 'Card refund', { kind, mode, edc: edcOf(mode), requestedCents: Math.round(o.cents), ref });
    };
  }
  /* The card type (credit / debit / EBT) of an earlier payment, from the terminal's own record of its transaction number (R03 "EDC Type", spec 4.2) */
  async function modeByTran(tranNo) {
    try {
      const msgs = await request(['R02', ver, '00', '', '', '', str(tranNo), '', '', '', '2'], { timeoutMs: 15000, safeResend: true });
      const rec = msgs.find(m => m.cmd === 'R03' && m.code === '000000');
      const edc = rec ? str(rec.rest[PAX_LAYOUT.R03.edc]) : '';
      return edc === '02' ? 'debit' : edc === '03' ? 'ebt_food' : 'credit';
    } catch (e) { return 'credit'; }
  }

  return {
    name: 'poslink',
    /** Initialize A00 (spec 5.1.1): shows model, serial number and software of the terminal. */
    test: async () => {
      let msgs;
      try { msgs = await request(['A00', ver], { timeoutMs: 15000, safeResend: true }); }
      catch (e) { return failure(e.message, { unreachable: e.kind === 'unreachable' }); }
      const m = msgs[0];
      if (m.cmd !== 'A01') return failure(`The terminal answered ${m.cmd || 'something unexpected'} (is this a PAX terminal on port ${port}?)`);
      const r = emptyResult(), a = paxAdditional(m.rest[6]);
      r.ok = m.code === '000000'; r.errorCode = m.code;
      r.serial = str(m.rest[0]); r.model = str(m.rest[1]); r.firmware = str(m.rest[2]); r.appName = str(a.APPNAME); r.appVersion = str(a.APPVERSION);
      const activated = str(m.rest[9]);
      r.raw = { CMD: m.cmd, CODE: m.code, SN: r.serial, MODEL: r.model, OS_VERSION: r.firmware, APPNAME: r.appName, APPVERSION: r.appVersion, ACTIVATED: activated, LICENSE_EXPIRY: str(m.rest[10]) };
      const bits = [r.model && 'PAX ' + r.model.replace(/^PAX\s*/i, ''), r.serial && 'serial ' + r.serial, r.firmware && 'firmware ' + r.firmware, (r.appName || r.appVersion) && `app ${r.appName} ${r.appVersion}`.trim()].filter(Boolean);
      if (r.ok && activated === 'N') { r.ok = false; r.message = 'The terminal answered but its payment app is not activated. ' + bits.join(', '); }
      else r.message = r.ok ? 'Terminal answered. ' + bits.join(', ') : (m.msg || 'The terminal did not accept Initialize') + ' (' + m.code + ')';
      return r;
    },
    sale: saleOrReturn('01', 'sale'),                               // Transaction Type 01 SALE (spec 4.4)
    refund: saleOrReturn('02', 'refund'),                           // 02 RETURN
    /** Void by terminal transaction number: Transaction Type 16 VOID, no amount, transaction number in the Trace group (spec 5.2.1.1 note). */
    void: async ({ tranNo, ref, mode } = {}) => {
      if (!str(tranNo)) return failure('There is no terminal transaction number for this payment, so it cannot be voided here.');
      const r = refOf({ ref }), md = mode || await modeByTran(tranNo);
      const trace = r + US + r + US + US + str(tranNo);
      const cmd = cmdOf(md), f = cmd === 'T00' ? ['T00', ver, '16', '', '', trace, '', '', '', '', add()] : [cmd, ver, '16', '', '', trace, '', add()];
      return money(f, 'Void', { kind: 'void', mode: md, edc: edcOf(md), requestedCents: 0, ref: r });
    },
    /** BatchClose B00 (spec 5.3.1). */
    settle: async () => {
      const track = {}; active.track = track;
      let msgs;
      try { msgs = await request(['B00', ver, ''], { timeoutMs, safeResend: false, track }); }
      catch (e) {
        if (e.kind === 'unreachable') return failure(e.message, { unreachable: true });
        return failure('Close batch: unknown result. Look at the terminal screen or its batch report to see if it closed. Do not run it again until you know.', { unknown: true });
      }
      const m = msgs[0], out = emptyResult();
      if (m.cmd !== 'B01') return failure(`Close batch: the terminal answered ${m.cmd} ${m.code} ${m.msg}`.trim());
      const sum = s => str(s).split('=').reduce((a, x) => a + toCents(x), 0);
      const host = str(m.rest[0]).split(US), a = paxAdditional(m.rest[6]);
      const count = sum(m.rest[1]), total = sum(m.rest[2]);
      out.ok = ['000000', '000029', '000300'].includes(m.code);   // 000029 some records failed, 000300 closed but out of balance: closed, with a warning
      out.errorCode = m.code; out.batchNo = str(host[5]); out.totalCents = total; out.count = count;
      out.raw = safeRaw({ CMD: m.cmd, CODE: m.code, MESSAGE: m.msg, SALE_COUNT: String(count), TOTAL_AMOUNT: String(total), TOTAL_COUNT: str(m.rest[1]), TOTAL_BY_TYPE: str(m.rest[2]), TID: str(m.rest[4]), MID: str(m.rest[5]) });
      if (out.ok) out.message = m.code === '000029' ? `Batch closed, but ${a.FAILEDCOUNT || 'some'} records failed to upload. Ask Kurv about the failed records.` : m.code === '000300' ? 'Batch closed, but it is OUT OF BALANCE. Call Kurv to reconcile it.' : 'Batch closed';
      else out.message = PAX_FRIENDLY[m.code] || m.msg || `The terminal could not close the batch (${m.code})`;
      return out;
    },
    /** EBT balance: Do EBT T04 with Transaction Type 23 INQUIRY (spec 4.4 / 5.2.3.1); cash benefits = Balance1, food stamps = Balance2 (spec 5.9.1). */
    ebtBalance: async ({ mode, ref } = {}) => {
      const r = refOf({ ref }), md = mode === 'ebt_cash' ? 'ebt_cash' : 'ebt_food';
      return money(txnFields(md, '23', '', r), 'EBT balance', { kind: 'balance', mode: md, edc: 'ebt', requestedCents: 0, ref: r });
    },
    /** Status of an earlier card request: Local Detail Report R02 by ECR reference (or terminal transaction number). */
    status: async ({ ref, tranNo, mode } = {}) => {
      if (!paxRef(ref) && !str(tranNo)) return failure('Give the ECR reference or the transaction number to look up.');
      const l = await lookup({ ref, tranNo }, 1, { kind: 'sale', mode, edc: edcOf(mode || 'credit') });
      if (!l.found) return failure('The terminal has no record of that request.', { errorCode: 'NF' });
      return l.result;
    },
    /** Cancel A14 (spec 5.1.8): sent on the open connection (HTTP: as its own request). The terminal answers the original request with 100002 ABORTED. */
    cancel: async () => {
      const t = active.track;
      if (t && t.abort && t.abort()) return Object.assign(emptyResult(), { ok: true, message: 'Cancel sent to the terminal' });
      const sentOk = await abortFresh();
      return sentOk ? Object.assign(emptyResult(), { ok: true, message: 'Cancel sent to the terminal' }) : failure('Could not send cancel to the terminal.');
    },
    shortenAfterCancel: ms => { const t = active.track; if (t && t.setDeadline) t.setDeadline(ms); }
  };
}

/* ---------- manager: one request at a time, picks the driver from the PC settings ---------- */
function createManager(getCfg) {
  let busy = null;            // name of the running request
  const active = { ref: '', cancelRequested: false, abort: null, aborted: false, track: null };
  let driverCache = null, cacheKey = '';
  const driver = () => {
    const c = getCfg() || {};
    const key = JSON.stringify([c.termDriver, c.termIp, c.termPort, c.termCancelPort, c.termFraming, c.termTimeoutSec, c.termDemoDelayMs, c.termDemoSurchargePct, c.termProtocol, c.termPaxVersion, c.termPaxReceipt, c.termPaxLookupDelayMs]);
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

module.exports = { createManager, valorDriver, demoDriver, poslinkDriver, normalizeValor, safeRaw, FrameReader, isAck, frame,
  paxLrc, paxFrame, paxRef, PaxReader, paxParseText, paxAdditional, paxToResult, paxRecordToResult, paxCodeInfo };
