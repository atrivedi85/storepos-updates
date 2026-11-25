#!/usr/bin/env node
'use strict';
// Runs the PAX (poslink) driver in terminal.js against the pretend PAX terminal. Usage: node source/tools/test-terminal-pax.js
const path = require('path');
const net = require('net');
const T = require(path.join(__dirname, '../app/terminal.js'));
const { startMock } = require('./mock-pax-terminal.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const truthy = (a, m) => { if (!a) throw new Error(m || 'expected true'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FS = '\x1c', US = '\x1f';
const cfgFor = (m, extra) => Object.assign({ termEnabled: true, termDriver: 'poslink', termIp: '127.0.0.1', termPort: m.port, termTimeoutSec: 30, termPaxLookupDelayMs: 100 }, extra);
const sent = (m, cmd, ref) => m.state.log.filter(x => x.cmd === cmd && !x.naked && (!ref || (x.f[5] || '').split(US)[0] === ref));

(async () => {
  const base = 31000 + Math.floor(Math.random() * 2000) * 4;

  console.log('Frames (examples from the spec, section 3.3.2, and the response examples)');
  await t('LRC and frame match the 4 worked request examples', () => {
    const ex = [['AkEwMBwxLjI4A0s=', ['A00', '1.28']], ['AkEwOBwxLjI4HDAcOTAwMDADSg==', ['A08', '1.28', '0', '90000']],
      ['AkEyMBwxLjI4HDAcHBwyMDADSw==', ['A20', '1.28', '0', '', '', '200']], ['AlQwMBwxLjI4HDAxHDEwMBwcMRwcHBwcA0M=', ['T00', '1.28', '01', '100', '', '1', '', '', '', '', '']]];
    for (const [b64, fields] of ex) {
      const want = Buffer.from(b64, 'base64');
      const got = T.paxFrame(fields);
      eq(got.toString('hex'), want.toString('hex'), 'frame for ' + fields[0]);
      eq(T.paxLrc(want.subarray(1, want.length - 1)), want[want.length - 1], 'LRC of ' + fields[0]);
    }
    eq(String.fromCharCode(T.paxFrame(['A00', '1.28'])[T.paxFrame(['A00', '1.28']).length - 1]), 'K', 'A00 LRC is K');
  });
  await t('reader splits chunks, separates ACK/NAK/EOT, flags bad LRC', () => {
    const f = T.paxFrame(['0', 'A01', '1.28', '000000', 'OK']);
    const r = new T.PaxReader(); let ev = [];
    ev = ev.concat(r.push(Buffer.concat([Buffer.from([6]), f.subarray(0, 5)]))); eq(ev.length, 1); eq(ev[0].t, 'ack');
    ev = ev.concat(r.push(Buffer.concat([f.subarray(5), Buffer.from([4, 0x15])]))); eq(ev.map(e => e.t).join(','), 'ack,frame,eot,nak'); truthy(ev[1].ok);
    const bad = Buffer.from(f); bad[bad.length - 1] ^= 1; eq(new T.PaxReader().push(bad)[0].ok, false, 'bad lrc flagged');
  });
  await t('parses the spec A01 / T01 / T03 response examples', () => {
    const a01 = T.paxParseText(['A01', '1.37', '000000', 'OK', '53124007', 'S300', '', '00176F61187A', '9', '18', 'APPVERSION=' + US + 'APPNAME='].join(FS));
    eq(a01.code, '000000'); eq(a01.rest[0], '53124007'); eq(a01.rest[1], 'S300');
    const t01 = T.paxParseText(['T01', '1.26', '000000', '', ['00', 'APPROVE OFFLINE', '000000', '88888888', '123456', '1'].join(US), '01', ['600', '', '100'].join(US), ['6781', '0', '1212', '', '', '', '01'].join(US), ['1', '123456', '20110704150056'].join(US), '0', '', 'M' + US + 'S' + US + US + '1234', ''].join(FS));
    const r = T.paxToResult(t01, { edc: 'credit', requestedCents: 600 });
    eq(r.ok, true); eq(r.approvedCents, 600); eq(r.last4, '6781'); eq(r.entry, 'MANUAL'); eq(r.brand, 'VISA'); eq(r.authCode, '000000'); eq(r.tranNo, '1'); eq(r.batchNo, '1'); eq(r.txnId, '88888888');
    const t03 = T.paxParseText(['T03', '1.26', '000000', 'OK', ['00', 'APPROVE OFFLINE', '000000', '88888888', '123456', '1'].join(US), '01', '500', ['6781', '1', '1212'].join(US), ['2', '123456', '20110704150808'].join(US)].join(FS));
    const d = T.paxToResult(t03, { edc: 'debit', requestedCents: 500 }); eq(d.ok, true); eq(d.approvedCents, 500); eq(d.brand, 'DEBIT'); eq(d.entry, 'SWIPE');
  });
  await t('response codes', () => {
    eq(T.paxCodeInfo('000002').partial, true); eq(T.paxCodeInfo('100002').cancelled, true); eq(T.paxCodeInfo('000100').declined, true); eq(T.paxCodeInfo('100009').unknown, true); eq(T.paxCodeInfo('100511').busy, true);
    eq(T.paxRef('ab c#12345678901234567890'), 'abc1234567890123');
  });

  for (const proto of ['tcp', 'http']) {
    console.log(`PAX driver over ${proto.toUpperCase()}`);
    const m = await startMock({ port: base + (proto === 'tcp' ? 0 : 4), delayMs: 120 });
    const term = T.createManager(() => cfgFor(m, { termProtocol: proto }));
    await t('Initialize (A00) shows model, serial, firmware', async () => {
      const r = await term.test(); truthy(r.ok, r.message); eq(r.model, 'A35'); eq(r.serial, 'MOCKPAX0001'); eq(r.firmware, 'PayDroid 10'); truthy(/BroadPOS/.test(r.message) && /MOCKPAX0001/.test(r.message), r.message);
      eq(sent(m, 'A00').pop().f[1], '1.28');
    });
    await t('credit sale approved: fields on the wire and result', async () => {
      const r = await term.sale({ mode: 'credit', cents: 1500, ref: 'R1' });
      truthy(r.ok, r.message); eq(r.approvedCents, 1500); eq(r.last4, '5103'); eq(r.brand, 'VISA'); eq(r.entry, 'TAP'); truthy(r.authCode.startsWith('TAS')); truthy(r.tranNo); truthy(r.batchNo); truthy(r.stan); truthy(r.txnId); truthy(r.rrn); eq(r.aid, 'A0000000031010'); eq(r.partial, false);
      truthy(!JSON.stringify(r).includes('41601234'), 'full card number must not appear anywhere'); eq(r.raw.MASKED_PAN, '**** 5103');
      const q = sent(m, 'T00', 'R1')[0]; eq(q.f[2], '01', 'SALE'); eq(q.f[3], '1500', 'amount in cents'); eq(q.f[5], 'R1' + US + 'R1', 'ECR ref + invoice'); eq(q.f.length, 11, 'T00 has 9 fields after the version');
    });
    await t('credit sale never sends a surcharge field', () => { for (const q of m.state.log.filter(x => x.cmd === 'T00')) eq((q.f[3] || '').indexOf(US), -1, 'amount info has only the amount'); });
    await t('debit sale (T02) and EBT food / cash sale (T04)', async () => {
      const d = await term.sale({ mode: 'debit', cents: 1000, ref: 'D1' }); truthy(d.ok, d.message); eq(d.brand, 'VISA DEBIT'); eq(d.cashbackCents, 0);
      const qd = sent(m, 'T02', 'D1')[0]; eq(qd.f[2], '01'); eq(qd.f[3], '1000' + US + US + '0', 'cash back asked as 0 so the terminal does not prompt'); eq(qd.f.length, 8);
      const f = await term.sale({ mode: 'ebt_food', cents: 700, ref: 'E1' }); truthy(f.ok, f.message); eq(f.brand, 'EBT');
      const qf = sent(m, 'T04', 'E1')[0]; eq(qf.f[4], US + US + US + 'F', 'EBT type F'); eq(qf.f[3], '700');
      const c = await term.sale({ mode: 'ebt_cash', cents: 700, ref: 'E2' }); truthy(c.ok, c.message); eq(sent(m, 'T04', 'E2')[0].f[4], US + US + US + 'C');
      const cb = await term.sale({ mode: 'debit', cents: 1000, cashbackCents: 500, ref: 'D2' }); truthy(cb.ok); eq(sent(m, 'T02', 'D2')[0].f[3], '1000' + US + US + '500');
    });
    await t('declined (.13)', async () => { const r = await term.sale({ mode: 'credit', cents: 1013, ref: 'N1' }); eq(r.ok, false); eq(r.errorCode, '05'); eq(r.message, 'DO NOT HONOR'); eq(r.approvedCents, 0); truthy(!r.unknown && !r.cancelled); });
    await t('partial approval (.51)', async () => { const r = await term.sale({ mode: 'credit', cents: 1051, ref: 'P1' }); truthy(r.ok); eq(r.partial, true); eq(r.approvedCents, 525); eq(r.raw.AMOUNT_DUE, '526'); });
    await t('customer cancels on the terminal (.66), and customer timeout (.45)', async () => {
      const a = await term.sale({ mode: 'credit', cents: 1066, ref: 'U1' }); eq(a.ok, false); truthy(a.cancelled, a.message);
      const b = await term.sale({ mode: 'credit', cents: 1045, ref: 'U2' }); eq(b.ok, false); truthy(!b.cancelled && !b.unknown); truthy(/did not finish/.test(b.message), b.message);
    });
    await t('host receive error (.55) is "unknown", not a decline', async () => { const r = await term.sale({ mode: 'credit', cents: 1055, ref: 'U3' }); truthy(r.unknown); truthy(/terminal/i.test(r.message)); });
    await t('void by transaction number, twice; wrong card type is refused', async () => {
      const s = await term.sale({ mode: 'credit', cents: 900, ref: 'V1' }); truthy(s.ok);
      const v = await term.void({ tranNo: s.tranNo, ref: 'V1v', mode: 'credit' }); truthy(v.ok, v.message); eq(v.approvedCents, 900);
      const q = sent(m, 'T00', 'V1v')[0]; eq(q.f[2], '16', 'VOID'); eq(q.f[3], '', 'no amount on a void'); eq(q.f[5].split(US)[3], s.tranNo, 'transaction number in trace group');
      const v2 = await term.void({ tranNo: s.tranNo, ref: 'V1w', mode: 'credit' }); eq(v2.ok, false); truthy(/already voided/i.test(v2.message), v2.message);
      const dsale = await term.sale({ mode: 'debit', cents: 800, ref: 'V2' });
      const vd = await term.void({ tranNo: dsale.tranNo, ref: 'V2v', mode: 'debit' }); truthy(vd.ok, vd.message); eq(sent(m, 'T02', 'V2v').length, 1);
      const guess = await term.sale({ mode: 'debit', cents: 810, ref: 'V3' });
      const vg = await term.void({ tranNo: guess.tranNo, ref: 'V3v' }); truthy(vg.ok, 'void without mode finds the card type from the terminal: ' + vg.message); eq(sent(m, 'T02', 'V3v').length, 1);
      const none = await term.void({ ref: 'V9' }); eq(none.ok, false);
    });
    await t('refund (Return 02)', async () => { const r = await term.refund({ mode: 'credit', cents: 1000, ref: 'F1' }); truthy(r.ok, r.message); eq(r.approvedCents, 1000); eq(sent(m, 'T00', 'F1')[0].f[2], '02'); });
    await t('status lookup by ECR reference (R02, all results)', async () => {
      const s = await term.sale({ mode: 'credit', cents: 1100, ref: 'S1' });
      const r = await term.status({ ref: 'S1' }); truthy(r.ok, r.message); eq(r.tranNo, s.tranNo); eq(r.approvedCents, 1100); eq(r.authCode, s.authCode);
      const q = m.state.log.filter(x => x.cmd === 'R02').pop(); eq(q.f[8], 'S1'); eq(q.f[10], '2');
      const d = await term.status({ ref: 'N1' }); eq(d.ok, false); eq(d.errorCode, '05', 'a declined record is found and reported as declined');
      const nf = await term.status({ ref: 'NOPE' }); eq(nf.ok, false); truthy(/no record/i.test(nf.message));
    });
    await t('EBT balance (Inquiry 23): food and cash', async () => {
      const f = await term.ebtBalance({ mode: 'ebt_food', ref: 'B1' }); truthy(f.ok, f.message); eq(f.ebtBalanceCents, 12345);
      const c = await term.ebtBalance({ mode: 'ebt_cash', ref: 'B2' }); eq(c.ebtBalanceCents, 2500);
      const q = sent(m, 'T04', 'B1')[0]; eq(q.f[2], '23'); eq(q.f[3], ''); eq(q.f[4], '');
    });
    await t('batch close (B00)', async () => {
      const r = await term.settle(); truthy(r.ok, r.message); eq(r.batchNo, '78'); truthy(+r.raw.SALE_COUNT >= 3, 'count ' + r.raw.SALE_COUNT); truthy(r.totalCents > 0);
      const r2 = await term.settle(); truthy(r2.ok); eq(r2.raw.SALE_COUNT, '0'); eq(r2.batchNo, '79');
      const old = await term.void({ tranNo: '1', ref: 'V7', mode: 'credit' }); eq(old.ok, false, 'a settled payment cannot be voided');
    });
    await t('terminal busy: second request is refused; turned off: nothing is sent', async () => {
      const p = term.sale({ mode: 'credit', cents: 100, ref: 'BB1' }); const r2 = await term.sale({ mode: 'credit', cents: 200, ref: 'BB2' }); truthy(r2.busy); truthy((await p).ok);
      const n = m.state.log.length; const off = T.createManager(() => cfgFor(m, { termEnabled: false, termProtocol: proto })); eq((await off.sale({ mode: 'credit', cents: 100, ref: 'X' })).ok, false); eq(m.state.log.length, n);
    });
    await t('damaged request: terminal NAKs (.98), driver sends it again and it is charged once', async () => {
      const r = await term.sale({ mode: 'credit', cents: 1098, ref: 'NK1' });
      if (proto === 'tcp') { truthy(r.ok, r.message); eq(sent(m, 'T00', 'NK1').length, 1, 'the terminal processed it once'); eq(m.state.log.filter(x => x.naked).length >= 1, true); }
    });
    await m.close();
  }

  console.log('PAX driver: bad LRC, slow customer, split answers, surcharge');
  {
    const m = await startMock({ port: base + 10, delayMs: 100 });
    await t('terminal rejects a request with a bad LRC (NAK), and answers a good one with ACK', async () => {
      const good = T.paxFrame(['A00', '1.28']), bad = Buffer.from(good); bad[bad.length - 1] ^= 0x7f;
      const got = await new Promise(res => { const s = net.connect(m.port, '127.0.0.1', () => s.write(bad)); const b = []; s.on('data', d => { b.push(...d); if (b.length === 1) s.write(good); if (d.includes(0x02) && !s.acked) { s.acked = true; s.write(Buffer.from([6])); } if (b.includes(0x04)) { s.destroy(); res(b); } }); });
      eq(got[0], 0x15, 'first byte NAK'); eq(got[1], 0x06, 'then ACK'); eq(m.state.badFrames, 1);
    });
    await t('bad LRC in the terminal answer (.97): driver sends NAK, answer arrives again, charged once', async () => {
      const term = T.createManager(() => cfgFor(m));
      const r = await term.sale({ mode: 'credit', cents: 1097, ref: 'BL1' }); truthy(r.ok, r.message); eq(sent(m, 'T00', 'BL1').length, 1); truthy(m.state.registerNaks >= 1, 'register sent NAK');
    });
    await t('multi-packet answer (status 1 ... 0) is joined', async () => {
      const ms = await startMock({ port: base + 12, delayMs: 50, split: 37 });
      const term = T.createManager(() => cfgFor(ms));
      const r = await term.sale({ mode: 'credit', cents: 2500, ref: 'MP1' }); truthy(r.ok, r.message); eq(r.approvedCents, 2500); eq(r.last4, '5103'); truthy(r.tranNo);
      const a = await term.test(); truthy(a.ok); eq(a.model, 'A35');
      await ms.close();
    });
    await t('surcharge from the terminal is reported (3%); not on debit', async () => {
      const ms = await startMock({ port: base + 14, delayMs: 50, surchargePct: 3 });
      const term = T.createManager(() => cfgFor(ms));
      const r = await term.sale({ mode: 'credit', cents: 1500, ref: 'SU1' }); eq(r.approvedCents, 1500); eq(r.surchargeCents, 45); eq(r.totalCents, 1545);
      const d = await term.sale({ mode: 'debit', cents: 1500, ref: 'SU2' }); eq(d.surchargeCents, 0);
      await ms.close();
      const mi = await startMock({ port: base + 15, delayMs: 50, surchargePct: 3, inclusive: true });
      const ri = await T.createManager(() => cfgFor(mi)).sale({ mode: 'credit', cents: 1500, ref: 'SU3' }); eq(ri.approvedCents, 1500, 'approved amount that includes the surcharge is split'); eq(ri.surchargeCents, 45);
      await mi.close();
    });
    await t('slow customer (3 s at the terminal) still approves, one request only', async () => {
      const ms = await startMock({ port: base + 16, delayMs: 3000 });
      const term = T.createManager(() => cfgFor(ms));
      const t0 = Date.now(); const r = await term.sale({ mode: 'credit', cents: 3000, ref: 'SL1' }); truthy(r.ok, r.message); truthy(Date.now() - t0 >= 2900); eq(sent(ms, 'T00', 'SL1').length, 1);
      await ms.close();
    });
    await t('cancel pressed while the customer is deciding: A14 sent, answer is ABORTED', async () => {
      const ms = await startMock({ port: base + 18, delayMs: 5000 });
      const term = T.createManager(() => cfgFor(ms));
      const p = term.sale({ mode: 'credit', cents: 2000, ref: 'C1' }); await sleep(300); const t0 = Date.now();
      const c = await term.cancel({ ref: 'C1' }); truthy(c.ok, c.message);
      const r = await p; eq(r.ok, false); truthy(r.cancelled, r.message); truthy(!r.unknown); truthy(Date.now() - t0 < 2000, 'came back quickly');
      truthy(ms.state.log.some(x => x.cmd === 'A14'), 'A14 reached the terminal'); eq(sent(ms, 'T00', 'C1').length, 1);
      await ms.close();
    });
    await m.close();
  }

  console.log('PAX driver: never send a card payment twice');
  for (const proto of ['tcp', 'http']) {
    const m = await startMock({ port: base + 20 + (proto === 'tcp' ? 0 : 2), delayMs: 100 });
    const mk = (x) => T.createManager(() => cfgFor(m, Object.assign({ termProtocol: proto }, x)));
    await t(`${proto}: line drops after the terminal APPROVED (.77): cancel, lookup finds it, sent once`, async () => {
      const r = await mk().sale({ mode: 'credit', cents: 1077, ref: 'DR1' }); truthy(r.ok, 'recovered from the terminal record: ' + r.message); truthy(r.recovered); eq(r.approvedCents, 1077); truthy(r.tranNo);
      eq(sent(m, 'T00', 'DR1').length, 1, 'sale sent once'); truthy(m.state.log.some(x => x.cmd === 'R02' && x.f[8] === 'DR1'), 'lookup by ECR reference');
    });
    await t(`${proto}: line drops and the terminal has no record (.78): unknown, cancel + lookup tried, sent once`, async () => {
      const r = await mk().sale({ mode: 'credit', cents: 1078, ref: 'DR2' }); eq(r.ok, false); truthy(r.unknown, r.message); truthy(/terminal screen/i.test(r.message));
      eq(sent(m, 'T00', 'DR2').length, 1); truthy(m.state.log.some(x => x.cmd === 'A14'), 'cancel sent'); truthy(m.state.log.some(x => x.cmd === 'R02' && x.f[8] === 'DR2'));
    });
    await t(`${proto}: no answer before the timeout (.88): unknown, never resent`, async () => {
      const t0 = Date.now(); const r = await mk({ termTimeoutSec: 2 }).sale({ mode: 'credit', cents: 1088, ref: 'HG1' });
      truthy(r.unknown, r.message); truthy(Date.now() - t0 >= 1900 && Date.now() - t0 < 12000, 'took ' + (Date.now() - t0)); eq(sent(m, 'T00', 'HG1').length, 1);
    });
    await t(`${proto}: no answer but it WAS approved (.89): lookup recovers the approval`, async () => {
      const r = await mk({ termTimeoutSec: 2 }).sale({ mode: 'credit', cents: 1089, ref: 'HG2' }); truthy(r.ok, r.message); truthy(r.recovered); eq(sent(m, 'T00', 'HG2').length, 1);
    });
    await m.close();
  }
  await t('terminal not reachable: says so, nothing unknown', async () => {
    const term = T.createManager(() => ({ termEnabled: true, termDriver: 'poslink', termIp: '127.0.0.1', termPort: base + 90, termTimeoutSec: 5 }));
    const r = await term.sale({ mode: 'credit', cents: 100, ref: 'U1' }); eq(r.ok, false); truthy(r.unreachable); truthy(!r.unknown); truthy(/Could not connect/.test(r.message), r.message);
    eq((await term.test()).ok, false);
  });
  await t('no IP set; zero amount refused', async () => {
    const term = T.createManager(() => ({ termEnabled: true, termDriver: 'poslink', termIp: '' })); const r = await term.test(); eq(r.ok, false); truthy(/IP/.test(r.message));
    eq((await T.createManager(() => ({ termEnabled: true, termDriver: 'poslink', termIp: '127.0.0.1' })).sale({ mode: 'credit', cents: 0, ref: 'Z' })).ok, false);
  });
  await t('default port is 10009 and default protocol is TCP', async () => {
    const m = await startMock({ port: 10009, delayMs: 20 }).catch(() => null);
    if (!m) return; // port in use on this machine: skip
    const r = await T.createManager(() => ({ termEnabled: true, termDriver: 'poslink', termIp: '127.0.0.1' })).test(); truthy(r.ok, r.message); eq(m.state.log[0].kind, 'tcp'); await m.close();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
