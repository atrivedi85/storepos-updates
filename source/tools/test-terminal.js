#!/usr/bin/env node
'use strict';
// Runs the card terminal driver (terminal.js) against the mock terminal. Usage: node source/tools/test-terminal.js
const path = require('path');
const T = require(path.join(__dirname, '../app/terminal.js'));
const { startMock } = require('./mock-valor-terminal.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); } };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const truthy = (a, m) => { if (!a) throw new Error(m || 'expected true'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cfgFor = (m, extra) => Object.assign({ termEnabled: true, termDriver: 'valor', termIp: '127.0.0.1', termPort: m.port, termCancelPort: m.cancelPort, termFraming: m.options.framing, termTimeoutSec: 30 }, extra);

(async () => {
  const base = 25000 + Math.floor(Math.random() * 2000) * 2;
  console.log('FrameReader');
  await t('splits chunks, accepts STX/ETX and bare JSON, ignores noise', async () => {
    const r = new T.FrameReader(); let got = [];
    got = got.concat(r.push('\x02{"STATE":"0","MS'));
    eq(got.length, 0, 'incomplete');
    got = got.concat(r.push('G":"ACK"}\x03{"STATE":"0","AMOUNT":"5","X":"a}b"}'));
    eq(got.length, 2, 'two objects'); truthy(T.isAck(got[0]), 'first is ack'); truthy(!T.isAck(got[1]), 'second is not ack'); eq(got[1].X, 'a}b', 'brace in string');
  });
  await t('safeRaw cuts card numbers to last 4', () => { const s = T.safeRaw({ MASKED_PAN: '4160 **** **** 5103', CODE: 'X', FULL_PAN: '4160123412345103' }); eq(s.MASKED_PAN, '**** 5103'); eq(s.FULL_PAN, '**** 5103'); eq(s.CODE, 'X'); });

  for (const [i, [mockFr, drvFr]] of [['stx', 'stx'], ['raw', 'raw'], ['stx', 'raw'], ['raw', 'stx']].entries()) {
    console.log(`Valor driver, mock framing ${mockFr}, driver framing ${drvFr}`);
    const m = await startMock({ port: base + i * 4, cancelPort: base + i * 4 + 1, framing: mockFr, delayMs: 150 });
    const term = T.createManager(() => cfgFor(m, { termFraming: drvFr }));
    await t('test connection (mode 96)', async () => { const r = await term.test(); truthy(r.ok, r.message); truthy(/MOCK/.test(r.message), 'version in message: ' + r.message); });
    await t('sale approved', async () => {
      const r = await term.sale({ mode: 'credit', cents: 1500, ref: 'R1' });
      truthy(r.ok, r.message); eq(r.approvedCents, 1500); eq(r.last4, '5103'); eq(r.brand, 'VISA'); eq(r.entry, 'TAP'); truthy(r.authCode.startsWith('TAS')); truthy(r.tranNo, 'tranNo'); truthy(r.batchNo); truthy(r.stan); eq(r.aid, 'A0000000031010'); eq(r.partial, false);
      truthy(!JSON.stringify(r.raw).includes('4160'), 'raw has no more than last 4'); eq(r.raw.MASKED_PAN, '**** 5103');
    });
    if (i === 0) {
      await t('first request carries our fields', () => { const q = m.state.log.find(x => x.TRAN_CODE === '1'); eq(q.AMOUNT, '1500'); eq(q.TRAN_MODE, '1'); eq(q.REQ_TXN_ID, 'R1'); eq(q.PAPER_RECEIPT, '3'); eq(q.EARLY_RESPONSE, '1'); });
      await t('debit with cash back, EBT food and EBT cash modes', async () => {
        const d = await term.sale({ mode: 'debit', cents: 1000, cashbackCents: 500, ref: 'D1' }); truthy(d.ok); eq(d.cashbackCents, 500); eq(d.totalCents, 1500);
        const q = m.state.log.find(x => x.REQ_TXN_ID === 'D1'); eq(q.TRAN_MODE, '2'); eq(q.CASHBACK_AMOUNT, '500');
        const f = await term.sale({ mode: 'ebt_food', cents: 700, ref: 'E1' }); truthy(f.ok); eq(m.state.log.find(x => x.REQ_TXN_ID === 'E1').TRAN_MODE, '3');
        const c = await term.sale({ mode: 'ebt_cash', cents: 700, ref: 'E2' }); truthy(c.ok); eq(m.state.log.find(x => x.REQ_TXN_ID === 'E2').TRAN_MODE, '4');
      });
    }
    await t('sale declined (.13)', async () => { const r = await term.sale({ mode: 'credit', cents: 1013, ref: 'R2' }); eq(r.ok, false); eq(r.errorCode, '05'); eq(r.message, 'DECLINED'); eq(r.approvedCents, 0); truthy(!r.unknown); });
    await t('sale partial (.51)', async () => { const r = await term.sale({ mode: 'credit', cents: 1051, ref: 'R3' }); truthy(r.ok); eq(r.partial, true); eq(r.approvedCents, 525); eq(r.raw.AMOUNT_DUE, '526'); });
    await t('cancel mid-transaction', async () => {
      const slow = await startMock({ port: base + 20 + i * 4, cancelPort: base + 21 + i * 4, framing: mockFr, delayMs: 3000 });
      const tm = T.createManager(() => cfgFor(slow, { termFraming: drvFr }));
      const p = tm.sale({ mode: 'credit', cents: 2000, ref: 'C1' });
      await sleep(300); const t0 = Date.now(); const c = await tm.cancel({ ref: 'C1' }); truthy(c.ok, c.message);
      const r = await p; eq(r.ok, false); truthy(r.cancelled, 'cancelled flag: ' + r.message); truthy(!r.unknown); truthy(Date.now() - t0 < 2000, 'returned quickly');
      truthy(slow.state.log.some(x => x.TRAN_MODE === '99' && x.REQ_TXN_ID === 'C1'), 'cancel frame reached port 5001');
      await slow.close();
    });
    await t('void by tranNo, then again fails', async () => {
      const s = await term.sale({ mode: 'credit', cents: 900, ref: 'V1' }); truthy(s.ok);
      const v = await term.void({ tranNo: s.tranNo, ref: 'V1v' }); truthy(v.ok, v.message); eq(v.approvedCents, 900);
      const q = m.state.log.find(x => x.TRAN_CODE === '2'); eq(q.TRAN_MODE, '0'); eq(q.TRAN_NO, s.tranNo); eq(q.VOID_CONFIRMATION, '0');
      const v2 = await term.void({ tranNo: s.tranNo, ref: 'V1w' }); eq(v2.ok, false);
    });
    await t('refund (TRAN_CODE 5)', async () => { const r = await term.refund({ mode: 'credit', cents: 1000, ref: 'F1' }); truthy(r.ok, r.message); eq(r.approvedCents, 1000); eq(m.state.log.find(x => x.REQ_TXN_ID === 'F1').TRAN_CODE, '5'); });
    await t('status by STAN', async () => { const s = await term.sale({ mode: 'credit', cents: 1100, ref: 'S1' }); const r = await term.status({ stan: s.stan }); truthy(r.ok, r.message); eq(r.tranNo, s.tranNo); eq(m.state.log.filter(x => x.TRAN_MODE === '90').pop().STAN_NO, s.stan); });
    await t('settle (close batch)', async () => { const r = await term.settle(); truthy(r.ok, r.message); truthy(+r.raw.SALE_COUNT > 0, 'sale count'); truthy(r.totalCents > 0, 'total'); const r2 = await term.settle(); eq(r2.raw.SALE_COUNT, '0'); });
    await t('ebt balance', async () => { const r = await term.ebtBalance({ mode: 'ebt_food' }); truthy(r.ok); eq(r.ebtBalanceCents, 12345); eq(m.state.log.filter(x => x.TRAN_CODE === '8').pop().TRAN_MODE, '3'); });
    await t('terminal busy: second request is refused', async () => { const p = term.sale({ mode: 'credit', cents: 100, ref: 'B1' }); const r2 = await term.sale({ mode: 'credit', cents: 200, ref: 'B2' }); truthy(r2.busy, 'busy flag'); eq(r2.message.slice(0, 13), 'Terminal busy'); truthy((await p).ok); });
    await t('turned off: nothing is sent', async () => { const n = m.state.log.length; const off = T.createManager(() => cfgFor(m, { termEnabled: false })); const r = await off.sale({ mode: 'credit', cents: 100, ref: 'X' }); eq(r.ok, false); eq(m.state.log.length, n); });
    await m.close();
  }

  console.log('Valor driver, failure cases');
  {
    const m = await startMock({ port: base + 60, cancelPort: base + 61, delayMs: 100 });
    await t('socket dropped after sending: unknown, cancel sent, NOT retried', async () => {
      const term = T.createManager(() => cfgFor(m));
      const r = await term.sale({ mode: 'credit', cents: 1077, ref: 'DR1' });
      eq(r.ok, false); truthy(r.unknown, 'unknown flag'); truthy(/terminal screen/i.test(r.message), r.message);
      eq(m.state.log.filter(x => x.REQ_TXN_ID === 'DR1' && x.TRAN_CODE === '1').length, 1, 'sale sent once');
      truthy(m.state.log.some(x => x.TRAN_MODE === '99' && x.REQ_TXN_ID === 'DR1'), 'cancel sent');
    });
    await t('no answer before timeout (hang): unknown, cancel sent, NOT retried', async () => {
      const term = T.createManager(() => cfgFor(m, { termTimeoutSec: 2 }));
      const t0 = Date.now(); const r = await term.sale({ mode: 'credit', cents: 1088, ref: 'HG1' });
      truthy(r.unknown, 'unknown flag: ' + r.message); truthy(Date.now() - t0 >= 1900 && Date.now() - t0 < 6000, 'took ' + (Date.now() - t0) + ' ms');
      eq(m.state.log.filter(x => x.REQ_TXN_ID === 'HG1' && x.TRAN_CODE === '1').length, 1, 'sale sent once');
      truthy(m.state.log.some(x => x.TRAN_MODE === '99' && x.REQ_TXN_ID === 'HG1'), 'cancel sent');
    });
    await t('cancel pressed on a hung terminal: gives up within the short wait', async () => {
      const term = T.createManager(() => cfgFor(m, { termTimeoutSec: 200 }));
      const p = term.sale({ mode: 'credit', cents: 1288, ref: 'HG2' }); await sleep(300);
      // the mock cancel frame releases the hung sale with "Cancelled" (as a real terminal does)
      await term.cancel({ ref: 'HG2' }); const r = await p; eq(r.ok, false); truthy(r.cancelled || r.unknown, r.message);
    });
    await m.close();
    await t('terminal not reachable: says so, nothing unknown', async () => {
      const term = T.createManager(() => ({ termEnabled: true, termDriver: 'valor', termIp: '127.0.0.1', termPort: base + 90, termCancelPort: base + 91, termTimeoutSec: 5 }));
      const r = await term.sale({ mode: 'credit', cents: 100, ref: 'U1' }); eq(r.ok, false); truthy(r.unreachable); truthy(!r.unknown); truthy(/Could not connect/.test(r.message), r.message);
    });
    await t('no IP set', async () => { const r = await T.createManager(() => ({ termEnabled: true, termDriver: 'valor', termIp: '' })).test(); eq(r.ok, false); truthy(/IP/.test(r.message)); });
    await t('surcharge from the terminal is reported (3%)', async () => {
      const ms = await startMock({ port: base + 70, cancelPort: base + 71, delayMs: 50, surchargePct: 3 });
      const r = await T.createManager(() => cfgFor(ms)).sale({ mode: 'credit', cents: 1500, ref: 'SU1' });
      eq(r.approvedCents, 1500); eq(r.surchargeCents, 45); eq(r.totalCents, 1545);
      const d = await T.createManager(() => cfgFor(ms)).sale({ mode: 'debit', cents: 1500, ref: 'SU2' }); eq(d.surchargeCents, 0);
      await ms.close();
    });
  }

  console.log('PAX POSLink stub');
  await t('poslink is not available yet', async () => { const r = await T.createManager(() => ({ termEnabled: true, termDriver: 'poslink' })).sale({ mode: 'credit', cents: 100, ref: 'P' }); eq(r.ok, false); truthy(/not available yet/.test(r.message), r.message); });

  console.log('Demo driver');
  {
    const term = T.createManager(() => ({ termEnabled: true, termDriver: 'demo', termDemoDelayMs: 60 }));
    await t('approve / decline .13 / partial .51 / unknown .99', async () => {
      const a = await term.sale({ mode: 'credit', cents: 1234, ref: 'a' }); truthy(a.ok); eq(a.last4, '4242'); truthy(a.authCode);
      const d = await term.sale({ mode: 'credit', cents: 1213, ref: 'b' }); eq(d.ok, false); truthy(/DECLINED/.test(d.message));
      const p = await term.sale({ mode: 'credit', cents: 1251, ref: 'c' }); truthy(p.ok && p.partial); eq(p.approvedCents, 625);
      const u = await term.sale({ mode: 'credit', cents: 1299, ref: 'd' }); truthy(u.unknown);
    });
    await t('cancel, void, settle, ebt balance', async () => {
      const slow = T.createManager(() => ({ termEnabled: true, termDriver: 'demo', termDemoDelayMs: 3000 }));
      const p = slow.sale({ mode: 'credit', cents: 500, ref: 'x' }); await sleep(100); await slow.cancel({}); const r = await p; truthy(r.cancelled, r.message);
      const s = await term.sale({ mode: 'credit', cents: 800, ref: 'y' }); const v = await term.void({ tranNo: s.tranNo }); truthy(v.ok, v.message);
      const st = await term.settle(); truthy(st.ok); truthy(st.count >= 1);
      eq((await term.ebtBalance({ mode: 'ebt_food' })).ebtBalanceCents, 12345);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
