#!/usr/bin/env node
'use strict';
/*
 * Pretend Valor card terminal, for testing Store POS without a real PAX A35.
 *   node source/tools/mock-valor-terminal.js [--port 5000] [--cancel-port 5001] [--framing stx|raw] [--delay 1500] [--surcharge 3]
 * Then in Store POS: Settings > Card terminal > Valor, IP 127.0.0.1 (or this PC's IP), port 5000.
 *
 * Amount rules (the cents part):  .13 declines   .51 approves half (partial)   .77 drops the connection
 *                                 .88 never answers (to test the timeout)     anything else approves.
 * It sends an ACK frame first, then the result. Handles TRAN_MODE 96 (query), 90 (status), 99 (cancel on the cancel port),
 * and mode 0 codes 2 (void), 9 (settle); sale/refund for modes 1-4; EBT balance (mode 3, code 8).
 * Never uses a real card number: every card is VISA ending 5103.
 */
const net = require('net');

function startMock(opts = {}) {
  const o = Object.assign({ port: 5000, cancelPort: 5001, framing: 'stx', delayMs: 1500, surchargePct: 0, ack: true, host: '127.0.0.1' }, opts);
  const st = { tranNo: 20, batchNo: 78, stan: 19, open: [], byStan: {}, pending: new Map(), log: [] };
  const wrap = j => { const b = Buffer.from(JSON.stringify(j)); return o.framing === 'raw' ? b : Buffer.concat([Buffer.from([2]), b, Buffer.from([3])]); };
  const parse = text => { const i = text.indexOf('{'), k = text.lastIndexOf('}'); if (i < 0 || k < i) return null; try { return JSON.parse(text.slice(i, k + 1)); } catch (e) { return null; } };
  const cents = v => parseInt(v, 10) || 0;
  const result = (req, extra) => Object.assign({ STATE: '0', TRAN_TYPE: ({ 1: 'Credit', 2: 'Debit', 3: 'EBT Food', 4: 'EBT Cash' })[req.TRAN_MODE] || 'Credit', TRAN_METHOD: req.TRAN_CODE === '5' ? 'Refund' : 'Sale', PARTIAL: '0', MASKED_PAN: '4160 **** **** 5103', ISSUER: 'VISA', ENTRY_MODE: 'TAP', AID: 'A0000000031010', TVR: '0000000000', TSI: '0000', MER_TXN_ID: req.REQ_TXN_ID || '' }, extra);

  const mainSrv = net.createServer(sock => {
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', d => {
      buf += d.toString('utf8');
      const req = parse(buf); if (!req) return; buf = '';
      st.log.push(req);
      handle(sock, req);
    });
    sock.on('close', () => { for (const [k, v] of st.pending) if (v.sock === sock) { clearTimeout(v.timer); st.pending.delete(k); } });
  });
  function send(sock, j) { if (!sock.destroyed) { sock.write(wrap(j)); } }
  function handle(sock, req) {
    if (o.ack) send(sock, { STATE: '0', MSG: 'ACK' });
    const mode = String(req.TRAN_MODE), code = String(req.TRAN_CODE || '');
    if (mode === '96') return send(sock, { STATE: '0', APP_VERSION: 'MOCK 1.0.0', IP: o.host, SERIAL_NO: 'MOCK0001' }), sock.end();
    if (mode === '90') { const r = st.byStan[req.STAN_NO]; send(sock, r || { STATE: '-1', ERROR_MSG: 'Transaction not found' }); return sock.end(); }
    if (mode === '0' && code === '9') {
      const n = st.open.length, tot = st.open.reduce((a, s) => a + s.cents, 0);
      const r = { STATE: '0', TRAN_TYPE: 'Settlement', TRAN_METHOD: 'Settle', BATCH_NO: String(st.batchNo), SALE_COUNT: String(n), TOTAL_AMOUNT: String(tot), AUTH_RSP_TEXT: 'BATCH CLOSED' };
      st.open = []; st.batchNo++; send(sock, r); return sock.end();
    }
    if (mode === '0' && code === '2') {
      const i = st.open.findIndex(s => s.tranNo === String(req.TRAN_NO));
      if (i < 0) send(sock, { STATE: '-1', ERROR_MSG: 'Transaction not found in open batch' });
      else { const s = st.open.splice(i, 1)[0]; send(sock, result({ TRAN_MODE: '1', TRAN_CODE: '2', REQ_TXN_ID: req.REQ_TXN_ID }, { TRAN_METHOD: 'Void', AMOUNT: String(s.cents), TOTAL_AMOUNT: String(s.cents), TRAN_NO: s.tranNo, BATCH_NO: String(st.batchNo) })); }
      return sock.end();
    }
    if (mode === '3' && code === '8') return setTimeout(() => { send(sock, result(req, { TRAN_METHOD: 'Balance', AMOUNT: '0', EBT_BAL_AMOUNT: '12345' })); sock.end(); }, o.delayMs);
    if (!['1', '2', '3', '4'].includes(mode)) { send(sock, { STATE: '-1', ERROR_MSG: 'Unsupported request' }); return sock.end(); }
    const c = cents(req.AMOUNT), tail = c % 100;
    const timer = setTimeout(() => {
      st.pending.delete(req.REQ_TXN_ID);
      if (tail === 77) return sock.destroy();
      if (tail === 88) return; // hang forever
      st.stan++; const stan = String(st.stan);
      let r;
      if (tail === 13) r = { STATE: '-1', ERROR_CODE: '05', ERROR_MSG: 'DECLINED', STAN_ID: stan };
      else {
        st.tranNo++;
        let amt = c, partial = '0', extra = {};
        if (tail === 51) { amt = Math.floor(c / 2); partial = '1'; extra.AMOUNT_DUE = String(c - amt); }
        const sur = o.surchargePct > 0 && mode === '1' && code === '1' ? Math.round(amt * o.surchargePct / 100) : 0;
        const cb = mode === '2' ? cents(req.CASHBACK_AMOUNT) : 0;
        r = result(req, Object.assign({ AMOUNT: String(amt), PARTIAL: partial, SURCHARGE_AMOUNT: String(sur), CASHBACK_AMOUNT: String(cb), TOTAL_AMOUNT: String(amt + sur + cb), RRN: '5147125' + String(st.tranNo).padStart(5, '0'), CODE: 'TAS' + (700 + st.tranNo), AUTH_RSP_TEXT: 'APPROVAL TAS' + (700 + st.tranNo), TRAN_NO: String(st.tranNo), BATCH_NO: String(st.batchNo), STAN_ID: stan, TXN_ID: String(880000 + st.tranNo) }, extra));
        if (req.TRAN_CODE === '1') st.open.push({ tranNo: String(st.tranNo), cents: amt + sur + cb });
      }
      st.byStan[stan] = r; send(sock, r); sock.end();
    }, o.delayMs);
    st.pending.set(req.REQ_TXN_ID, { sock, timer });
  }
  const cancelSrv = net.createServer(sock => {
    sock.on('error', () => {});
    sock.on('data', d => {
      const req = parse(d.toString('utf8')); if (!req) return;
      st.log.push(req);
      const p = st.pending.get(req.REQ_TXN_ID);
      if (p) { clearTimeout(p.timer); st.pending.delete(req.REQ_TXN_ID); send(p.sock, { STATE: '-1', ERROR_MSG: 'Transaction Timeout/Cancelled' }); p.sock.end(); }
      send(sock, { STATE: '0', MSG: 'ACK' }); sock.end();
    });
  });
  return new Promise((resolve, reject) => {
    mainSrv.once('error', reject);
    mainSrv.listen(o.port, o.host === '127.0.0.1' ? '0.0.0.0' : o.host, () => cancelSrv.listen(o.cancelPort, '0.0.0.0', () => resolve({
      state: st, options: o,
      port: mainSrv.address().port, cancelPort: cancelSrv.address().port,
      close: () => new Promise(r => { for (const v of st.pending.values()) { clearTimeout(v.timer); v.sock.destroy(); } mainSrv.close(() => cancelSrv.close(() => r())); mainSrv.closeAllConnections && mainSrv.closeAllConnections(); cancelSrv.closeAllConnections && cancelSrv.closeAllConnections(); })
    })));
  });
}

module.exports = { startMock };

if (require.main === module) {
  const a = process.argv.slice(2), g = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  startMock({ port: +g('port', 5000), cancelPort: +g('cancel-port', 5001), framing: g('framing', 'stx'), delayMs: +g('delay', 1500), surchargePct: +g('surcharge', 0) })
    .then(m => console.log(`Mock Valor terminal listening on ${m.port} (requests) and ${m.cancelPort} (cancel), framing ${m.options.framing}. Amounts ending .13 decline, .51 partial, .77 drop, .88 hang.`))
    .catch(e => { console.error('Could not start:', e.message); process.exit(1); });
}
