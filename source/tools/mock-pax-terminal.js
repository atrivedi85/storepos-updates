#!/usr/bin/env node
'use strict';
/*
 * Pretend PAX terminal (BroadPOS / POSLink protocol), for testing Store POS without a real terminal.
 *   node source/tools/mock-pax-terminal.js [--port 10009] [--delay 1500] [--surcharge 3] [--split 40] [--inclusive]
 * Then in Store POS: Settings > Card terminal > PAX (BroadPOS / POSLink), IP 127.0.0.1, port 10009 (TCP or HTTP, it answers both).
 *
 * It checks every request like a real terminal: STX / ETX / LRC (bad LRC gets a NAK), then ACK, then the response frame, then
 * waits for the register's ACK and sends EOT. Over HTTP (GET /?base64) a bad LRC is answered with 400.
 * It never uses a real card number: every card is VISA ending 5103 (it sends the whole fake number on purpose, so the
 * register can prove it keeps only the last 4).
 *
 * The cents of the amount choose the scenario:
 *   .13 declined (host 05)          .51 half approved (partial)          .66 customer cancels on the terminal (ABORTED)
 *   .45 customer takes too long (TIMEOUT)   .55 host receive error (100009, outcome unknown)
 *   .77 approved and stored, then the connection drops before the answer
 *   .78 connection drops, nothing stored    .88 never answers (nothing stored)   .89 never answers but WAS approved and stored
 *   .97 first answer has a bad LRC (register must NAK, the answer is sent again)
 *   .98 first copy of the request is NAKed as if damaged on the wire (register must send it again)
 *   anything else approves. --surcharge N adds N % on credit sales. --inclusive makes "approved amount" include the surcharge.
 *   --split N cuts every answer into packets of N characters (status 1 ... 0, spec 3.4.10).
 * A14 (cancel) releases a request that is still waiting for the customer with 100002 ABORTED, like the real terminal does before it
 * talks to the host. Ports: it listens on one port only (spec 2.1.3).
 */
const net = require('net');
const http = require('http');

const STX = 2, ETX = 3, ACK = 6, NAK = 0x15, EOT = 4, FS = '\x1c', US = '\x1f';
const lrc = buf => { let r = 0; for (const b of buf) r ^= b; return r; };                   // own copy on purpose: the tests must not trust the driver's
const frame = (fields, bad) => { const body = Buffer.from(fields.join(FS) + '\x03', 'latin1'); return Buffer.concat([Buffer.from([STX]), body, Buffer.from([bad ? (lrc(body) ^ 0x55) : lrc(body)])]); };

function startMock(opts = {}) {
  const o = Object.assign({ port: 10009, host: '127.0.0.1', delayMs: 50, surchargePct: 0, split: 0, inclusive: false, ack: true, version: '1.28' }, opts);
  const st = { tranNo: 0, batchNo: 78, stan: 100, db: [], log: [], pending: [], conns: 0, badFrames: 0, naksSent: 0, seenRefs: new Set(), corruptedOnce: new Set() };
  const cents = v => parseInt(v, 10) || 0;
  const pad = n => String(n).padStart(2, '0');
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
  const EDC = { T00: '01', T02: '02', T04: '03' };
  const RESP = { T00: 'T01', T02: 'T03', T04: 'T05' };

  /* ----- how an answer leaves the terminal ----- */
  function packets(fields) {                       // [status, cmd, ver, code, msg, ...]  ->  list of frames (spec 3.4.10)
    const text = fields.slice(1).join(FS);
    if (!o.split || text.length <= o.split) return [frame(['0', text])];
    const out = []; for (let i = 0; i < text.length; i += o.split) out.push(frame([i + o.split >= text.length ? '0' : '1', text.slice(i, i + o.split)]));
    return out;
  }
  function reply(conn, groups, opt = {}) {         // groups = one or more responses (several = several records)
    const list = [];
    for (const g of groups) for (const p of packets(['0'].concat(g))) list.push(p);
    if (conn.kind === 'http') { if (!conn.res.writableEnded) { conn.res.writeHead(200, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.concat(list).length }); conn.res.end(Buffer.concat(list)); } return; }
    conn.firstGood = list[0];
    conn.queue = list.slice();
    if (opt.badFirst) { const bad = Buffer.from(list[0]); bad[bad.length - 1] ^= 0x55; conn.queue[0] = bad; conn.badFirst = true; }
    sendNext(conn);
  }
  function sendNext(conn) {
    if (conn.sock.destroyed) return;
    if (!conn.queue.length) { conn.sock.write(Buffer.from([EOT])); return; }
    conn.sentFrame = conn.queue[0];
    conn.sock.write(conn.sentFrame);
    clearTimeout(conn.ackTimer);
    conn.ackTimer = setTimeout(() => { if (conn.sentFrame && !conn.sock.destroyed && (conn.resends = (conn.resends || 0) + 1) < 5) conn.sock.write(conn.sentFrame); }, 3000);
  }
  const respFields = (cmdReq, code, msg, rest) => [RESP[cmdReq] || cmdReq, o.version, code, msg].concat(rest || []);

  /* ----- records the terminal keeps ----- */
  function amountGroup(a) {
    return [a.approved, a.due || '', '', a.cashback || '', a.surcharge || '', '', a.bal1 === undefined ? '' : a.bal1, a.bal2 === undefined ? '' : a.bal2, '', '', '', a.cashback || '', a.surcharge || ''].join(US);
  }
  function recordFields(r, withHeader) {           // groups of one transaction in response order
    const host = [r.hostCode, r.hostMsg, r.auth, r.hostRef, String(r.stan), String(r.batch), '', '', '', '', r.rrn].join(US);
    const acct = ['4160123412345103', '2', '', r.edc === '03' ? r.ebt : '', '', '', r.edc === '01' ? '01' : '', '', '', '', '', '', '', '', ''].join(US);
    const trace = [String(r.tranNo), r.ecrRef, stamp(), r.invoice].join(US);
    const add = ['HRef=' + r.hostRef, 'AID=A0000000031010', 'TVR=0000000000', 'TSI=0000', 'APPLAB=' + (r.edc === '02' ? 'VISA DEBIT' : r.edc === '03' ? 'EBT' : 'VISA CREDIT'), 'EDCTYPE=' + (r.edc === '01' ? 'CREDIT' : r.edc === '02' ? 'DEBIT' : 'EBT')].join(US);
    return { host, type: r.type, amount: amountGroup(r), acct, trace, add };
  }
  function approveRecord(cmdReq, f, type, base, extra) {
    const edc = EDC[cmdReq];
    const ref = refFrom(cmdReq, f);
    const sur = edc === '01' && o.surchargePct > 0 ? Math.round(base * o.surchargePct / 100) : 0;
    const r = Object.assign({ tranNo: ++st.tranNo, ecrRef: ref.ref, invoice: ref.invoice, edc, type, cmd: cmdReq, base, surcharge: sur, cashback: 0, approvedBase: base,
      hostCode: '00', hostMsg: 'APPROVAL', auth: 'TAS' + String(100 + st.tranNo), hostRef: 'H' + String(900000 + st.tranNo), stan: ++st.stan, batch: st.batchNo, rrn: String(514712500000 + st.tranNo), status: 'approved', ebt: ebtTypeFrom(cmdReq, f) }, extra || {});
    r.approved = String(r.approvedBase + (o.inclusive ? r.surcharge : 0));
    r.surcharge = r.surcharge ? String(r.surcharge) : '';
    r.cashback = r.cashback ? String(r.cashback) : '';
    st.db.push(r);
    return r;
  }
  function declineRecord(cmdReq, f, type, base) {
    const ref = refFrom(cmdReq, f);
    const r = { tranNo: ++st.tranNo, ecrRef: ref.ref, invoice: ref.invoice, edc: EDC[cmdReq], type, base, approved: '0', hostCode: '05', hostMsg: 'DO NOT HONOR', auth: '', hostRef: '', stan: ++st.stan, batch: st.batchNo, rrn: '', status: 'declined', ebt: ebtTypeFrom(cmdReq, f) };
    st.db.push(r);
    return r;
  }
  const traceOf = (cmdReq, f) => (cmdReq === 'T00' ? f[5] : f[5]) || '';                   // T00: type, amount, account, trace ...; T02/T04 the same up to the trace
  function refFrom(cmdReq, f) { const t = traceOf(cmdReq, f).split(US); return { ref: t[0] || '', invoice: t[1] || '' }; }
  function ebtTypeFrom(cmdReq, f) { return cmdReq === 'T04' ? (f[4] || '').split(US)[3] || '' : ''; }

  function txnGroup(r, cmdReq, code, msg) {
    const g = recordFields(r);
    const rest = cmdReq === 'T00' ? [g.host, r.type, g.amount, g.acct, g.trace, '', '', '', g.add] : [g.host, r.type, g.amount, g.acct, g.trace, g.add];
    return respFields(cmdReq, code, msg, rest);
  }
  const errGroup = (cmdReq, code, msg) => respFields(cmdReq, code, msg, []);

  /* ----- request handling ----- */
  function handle(conn, f) {
    const cmd = f[0];
    st.log.push({ cmd, ver: f[1], f: f.slice(), conn: conn.id, kind: conn.kind });
    if (cmd === 'A14') return abort(conn);
    if (cmd === 'A00') return reply(conn, [['A01', o.version, '000000', 'OK', 'MOCKPAX0001', 'A35', 'PayDroid 10', '00176F61187A', '9', '18', 'APPNAME=BroadPOS' + US + 'APPVERSION=MOCK-1.2.3', 'Y', '', 'Y', '12312030']]);
    if (cmd === 'B00') return batchClose(conn);
    if (cmd === 'R02') return report(conn, f);
    if (EDC[cmd]) return transaction(conn, cmd, f);
    reply(conn, [[('X' + cmd), o.version, '100027', 'UNSUPPORT COMMAND']]);
  }
  function abort(conn) {
    // spec 5.1.8: no answer to A14 itself; the running request is answered with 100002 ABORTED (only before the host is called)
    for (const p of st.pending.slice()) if (p.cancellable) { clearTimeout(p.timer); st.pending.splice(st.pending.indexOf(p), 1); p.done(errGroup(p.cmd, '100002', 'ABORTED')); }
    st.aborts = (st.aborts || 0) + 1;
  }
  function transaction(conn, cmd, f) {
    const type = f[2];
    const amt = (f[3] || '').split(US);
    const ref = refFrom(cmd, f);
    if (!ref.ref) return reply(conn, [errGroup(cmd, '100003', 'REF NO MISSING')]);
    if (type === '01' || type === '02') {
      // spec 5.2.1.1: credit SALE may only carry Transaction / Tip / Tax amounts, RETURN Transaction / Tax
      if (cmd === 'T00' && amt.slice(2).some((x, i) => i !== 1 && x !== '')) return reply(conn, [errGroup(cmd, '100003', 'MERCHANT FEE NOT ALLOWED')]);
      if (!/^\d+$/.test(amt[0] || '')) return reply(conn, [errGroup(cmd, '100003', 'AMOUNT INVALID')]);
      return money(conn, cmd, f, type, cents(amt[0]), cents(amt[2]));
    }
    if (type === '16') return voidTx(conn, cmd, f);
    if (type === '23') {
      const r = { tranNo: ++st.tranNo, ecrRef: ref.ref, invoice: ref.invoice, edc: EDC[cmd], type: '23', approved: '', hostCode: '00', hostMsg: 'BALANCE', auth: '', hostRef: '', stan: ++st.stan, batch: st.batchNo, rrn: '', status: 'inquiry', ebt: '', bal1: 2500, bal2: 12345 };
      const g = recordFields(r);
      g.amount = amountGroup({ approved: '', bal1: r.bal1, bal2: r.bal2 });
      return afterDelay(conn, cmd, () => reply(conn, [respFields(cmd, '000000', 'OK', [g.host, '23', g.amount, ['', '2', '', ''].join(US), g.trace, g.add])]));
    }
    reply(conn, [errGroup(cmd, '100003', 'TRANS TYPE NULL')]);
  }
  function afterDelay(conn, cmd, fn, cancellable = true) {   // the customer is busy on the terminal for delayMs
    const p = { cmd, conn, cancellable, timer: null, done: g => { if (g) reply(conn, [g]); } };
    p.timer = setTimeout(() => { const i = st.pending.indexOf(p); if (i >= 0) st.pending.splice(i, 1); fn(); }, o.delayMs);
    st.pending.push(p);
    if (conn.sock) conn.sock.on('close', () => { clearTimeout(p.timer); const i = st.pending.indexOf(p); if (i >= 0) st.pending.splice(i, 1); });
  }
  function money(conn, cmd, f, type, base, cashback) {
    const frac = base % 100;
    const ref = refFrom(cmd, f).ref;
    const resend = st.seenRefs.has(cmd + ref + type);
    st.seenRefs.add(cmd + ref + type);
    afterDelay(conn, cmd, () => {
      const finish = (r, code, msg, opt) => reply(conn, [txnGroup(r, cmd, code, msg)], opt);
      if (frac === 13) { const r = declineRecord(cmd, f, type, base); return finish(r, '000100', 'DECLINE'); }
      if (frac === 45) return reply(conn, [errGroup(cmd, '100001', 'TIMEOUT')]);
      if (frac === 55) return reply(conn, [errGroup(cmd, '100009', 'RECEIVE ERROR')]);
      if (frac === 66) return reply(conn, [errGroup(cmd, '100002', 'ABORTED')]);
      if (frac === 77) { approveRecord(cmd, f, type, base); return conn.sock && conn.sock.destroy(); }
      if (frac === 78) return conn.sock && conn.sock.destroy();
      if (frac === 88) return;                                 // never answers, nothing stored
      if (frac === 89) { approveRecord(cmd, f, type, base); return; }  // never answers, but it was approved
      const half = frac === 51;
      const r = approveRecord(cmd, f, type, half ? Math.floor(base / 2) : base, { cashback: cmd !== 'T00' ? cashback : 0, due: half ? base - Math.floor(base / 2) : 0 });
      if (half) r.due = base - r.approvedBase;
      const grp = txnGroup(r, cmd, half ? '000002' : '000000', half ? 'PARTIALLY APPROVED' : 'OK');
      if (frac === 97 && !conn.badSent) { conn.badSent = true; return reply(conn, [grp], { badFirst: true }); }
      reply(conn, [grp]);
    }, frac !== 88 && frac !== 89 && frac !== 77 && frac !== 78 ? true : false);
    void resend;
  }
  function voidTx(conn, cmd, f) {
    const tr = traceOf(cmd, f).split(US);
    const n = cents(tr[3]);
    const r = st.db.find(x => x.tranNo === n && x.edc === EDC[cmd] && x.batch === st.batchNo && x.status !== 'inquiry');
    afterDelay(conn, cmd, () => {
      if (!r) return reply(conn, [errGroup(cmd, '100023', 'NOT FOUND')]);
      if (r.status === 'voided') return reply(conn, [errGroup(cmd, '100021', 'ALREADY VOIDED')]);
      r.status = 'voided';
      const vr = Object.assign({}, r, { type: '16' });
      reply(conn, [txnGroup(vr, cmd, '000000', 'OK')]);
    }, false);
  }
  function batchClose(conn) {
    const open = st.db.filter(x => x.batch === st.batchNo && x.status === 'approved' && x.type !== '02');
    const by = e => open.filter(x => x.edc === e);
    const sum = e => by(e).reduce((a, x) => a + cents(x.approved), 0);
    const counts = [by('01').length, by('02').length, by('03').length, 0, 0, 0, 0, 0].join('=');
    const totals = [sum('01'), sum('02'), sum('03'), 0, 0, 0, 0, 0].join('=');
    const batch = st.batchNo; st.batchNo++;
    afterDelay(conn, 'B00', () => reply(conn, [['B01', o.version, '000000', 'OK', ['0', '', '', '', '', String(batch)].join(US), counts, totals, stamp(), 'MOCKTID1', 'MOCKMID1', '']]), false);
  }
  function report(conn, f) {
    const edc = f[2] || '00', tranNo = f[6] || '', ref = f[8] || '', all = f[10] === '2';
    const hits = st.db.filter(r => (edc === '00' || r.edc === edc) && (!tranNo || String(r.tranNo) === tranNo) && (!ref || r.ecrRef === ref) && r.status !== 'inquiry' && (all || r.status !== 'declined'));
    if (!hits.length) return reply(conn, [['R03', o.version, '100023', 'NOT FOUND']]);
    const groups = hits.map((r, i) => {
      const g = recordFields(Object.assign({}, r, { type: r.type }));
      if (r.status === 'voided') g.host = g.host; // a voided sale still reports (spec 5.4.2 note 3)
      return ['R03', o.version, '000000', 'OK', String(hits.length), String(i), g.host, r.edc, r.type, '', g.amount, g.acct, g.trace, '', '', '', g.add];
    });
    reply(conn, groups);
  }

  /* ----- sockets ----- */
  function attachTcp(sock, first) {
    const conn = { id: ++st.conns, kind: 'tcp', sock, queue: [], reader: Buffer.alloc(0) };
    sock.on('error', () => {});
    sock.on('close', () => clearTimeout(conn.ackTimer));
    const onData = chunk => {
      conn.reader = Buffer.concat([conn.reader, chunk]);
      for (;;) {
        const b = conn.reader[0];
        if (b === undefined) return;
        if (b === ACK) { conn.reader = conn.reader.subarray(1); clearTimeout(conn.ackTimer); conn.sentFrame = null; if (conn.badFirst) { conn.badFirst = false; } conn.queue.shift(); sendNext(conn); continue; }
        if (b === NAK) {                                      // register could not read our answer: send the same packet again (the good copy)
          conn.reader = conn.reader.subarray(1); st.naksSent += 0; st.registerNaks = (st.registerNaks || 0) + 1;
          if (conn.badFirst) { conn.badFirst = false; conn.queue[0] = conn.firstGood; }
          if (conn.queue.length) { conn.sentFrame = conn.queue[0]; sock.write(conn.sentFrame); } continue;
        }
        if (b === EOT) { conn.reader = conn.reader.subarray(1); continue; }
        if (b !== STX) { conn.reader = conn.reader.subarray(1); continue; }
        const e = conn.reader.indexOf(ETX, 1);
        if (e < 0 || conn.reader.length < e + 2) return;
        const body = conn.reader.subarray(1, e + 1), check = conn.reader[e + 1];
        const text = conn.reader.subarray(1, e).toString('latin1');
        conn.reader = conn.reader.subarray(e + 2);
        if (lrc(body) !== check) { st.badFrames++; st.naksSent++; sock.write(Buffer.from([NAK])); continue; }
        const f = text.split(FS);
        // .98: pretend the first copy was damaged on the wire
        const amtCents = cents((f[3] || '').split(US)[0]);
        if (EDC[f[0]] && (f[2] === '01' || f[2] === '02') && amtCents % 100 === 98 && !st.corruptedOnce.has(f[5])) { st.corruptedOnce.add(f[5]); st.naksSent++; st.log.push({ cmd: f[0], f: f.slice(), conn: conn.id, naked: true }); sock.write(Buffer.from([NAK])); continue; }
        if (o.ack) sock.write(Buffer.from([ACK]));
        handle(conn, f);
      }
    };
    sock.on('data', onData);
    if (first) onData(first);
  }
  function attachHttp(sock, first) {
    const srv = httpHandler;
    sock.unshift(first);
    httpServer.emit('connection', sock);
  }
  const httpHandler = (req, res) => {
    const conn = { id: ++st.conns, kind: 'http', res, sock: req.socket };
    const m = /^\/\?(.*)$/.exec(req.url || '');
    const raw = m ? Buffer.from(decodeURIComponent(m[1]), 'base64') : Buffer.alloc(0);
    const e = raw.indexOf(ETX, 1);
    if (raw[0] !== STX || e < 0 || raw.length < e + 2 || lrc(raw.subarray(1, e + 1)) !== raw[e + 1]) { st.badFrames++; res.writeHead(400, { 'Content-Length': 0, Connection: 'close' }); return res.end(); }
    const f = raw.subarray(1, e).toString('latin1').split(FS);
    if (f[0] === 'A14') { handle(conn, f); if (!res.writableEnded) { res.writeHead(200, { 'Content-Length': 0 }); res.end(); } return; }
    req.socket.on('close', () => { for (const p of st.pending.slice()) if (p.conn === conn) { clearTimeout(p.timer); st.pending.splice(st.pending.indexOf(p), 1); } });
    handle(conn, f);
  };
  const httpServer = http.createServer(httpHandler);
  const server = net.createServer(sock => {
    sock.once('data', first => { if (first[0] === 0x47) { sock.pause(); sock.unshift(first); httpServer.emit('connection', sock); sock.resume(); } else attachTcp(sock, first); });
    sock.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(o.port, o.host, () => resolve({
      port: server.address().port, host: o.host, options: o, state: st,
      close: () => new Promise(res => { for (const p of st.pending) clearTimeout(p.timer); server.close(() => res()); setTimeout(res, 300); server.closeAllConnections && 0; })
    }));
  });
}

module.exports = { startMock, lrc, frame };

if (require.main === module) {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  startMock({ port: +arg('port', 10009), delayMs: +arg('delay', 1500), surchargePct: +arg('surcharge', 0), split: +arg('split', 0), inclusive: a.includes('--inclusive'), host: arg('host', '0.0.0.0') })
    .then(m => console.log(`Pretend PAX terminal listening on ${m.host}:${m.port} (TCP and HTTP). Amounts: .13 decline  .51 partial  .66 customer cancels  .77/.78 drop  .88/.89 no answer  .97 bad LRC answer  .98 damaged request`));
}
