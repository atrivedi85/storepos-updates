// Small email sender (SMTP) for Ledger Desk Server invites. No extra packages.
// Works with Gmail (smtp.gmail.com, port 465, an app password) and most other mail services (port 587 with STARTTLS).
'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function encWord(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?='; }
const cleanHeader = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const validEmail = s => /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}$/.test(String(s || '').trim());

function sendMail(cfg, msg) {
  return new Promise((resolve, reject) => {
    const host = cfg.host, port = Number(cfg.port) || 465, implicitTLS = port === 465 || cfg.secure === true;
    let sock, buf = '', waiter = null, done = false;
    const timer = setTimeout(() => fail(new Error('The email server did not answer in time.')), 30000);
    function fail(e) { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch (x) {} reject(e); }
    function onData(d) {
      buf += d.toString('utf8');
      // a full reply ends with a line "NNN text" (not "NNN-text")
      const lines = buf.split('\r\n'); if (lines[lines.length - 1] !== '') return;
      const last = lines[lines.length - 2] || '';
      if (!/^\d{3} /.test(last)) return;
      const reply = buf; buf = '';
      if (waiter) { const w = waiter; waiter = null; w(reply); }
    }
    function attach(s) { sock = s; s.on('data', onData); s.on('error', e => fail(friendly(e))); s.on('close', () => { if (!done) fail(new Error('The email server closed the connection.')); }); }
    const next = () => new Promise(r => { waiter = r; });
    async function cmd(line, okCodes, hide) {
      const p = next(); sock.write(line + '\r\n');
      const r = await p, code = +r.slice(0, 3);
      if (!okCodes.includes(code)) throw new Error(explain(code, r, hide ? '(login)' : line.split(' ')[0]));
      return r;
    }
    function explain(code, r, what) {
      const text = r.trim().split('\r\n').pop().slice(4);
      if (code === 535 || code === 534) return 'The email account or app password was not accepted. For Gmail, use an app password (myaccount.google.com/apppasswords), not your normal password.';
      return 'The email server refused ' + what + ': ' + code + ' ' + text;
    }
    function friendly(e) { return e.code === 'ENOTFOUND' ? new Error('Could not find the email server ' + host + '.') : e.code === 'ECONNREFUSED' ? new Error('The email server refused the connection.') : e; }
    async function run() {
      let r = await next();
      if (!/^220/.test(r)) throw new Error('Unexpected greeting from the email server.');
      const me = 'ledgerdesk.local';
      r = await cmd('EHLO ' + me, [250]);
      if (!implicitTLS && /STARTTLS/i.test(r) && cfg.starttls !== false) {
        await cmd('STARTTLS', [220]);
        sock.removeAllListeners('data');
        await new Promise((res, rej) => { const t = tls.connect({ socket: sock, servername: host }, res); t.on('error', rej); attach(t); });
        r = await cmd('EHLO ' + me, [250]);
      }
      if (cfg.user) {
        if (/AUTH[ =][^\r\n]*PLAIN/i.test(r)) await cmd('AUTH PLAIN ' + Buffer.from('\0' + cfg.user + '\0' + cfg.pass, 'utf8').toString('base64'), [235], true);
        else { await cmd('AUTH LOGIN', [334]); await cmd(b64(cfg.user), [334], true); await cmd(b64(cfg.pass), [235], true); }
      }
      const from = cleanHeader(cfg.from || cfg.user);
      await cmd('MAIL FROM:<' + from + '>', [250]);
      await cmd('RCPT TO:<' + cleanHeader(msg.to) + '>', [250, 251]);
      await cmd('DATA', [354]);
      const body = b64(msg.text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
      const head = [
        'From: ' + (msg.fromName ? encWord(cleanHeader(msg.fromName)) + ' ' : '') + '<' + from + '>',
        'To: <' + cleanHeader(msg.to) + '>',
        'Subject: ' + encWord(cleanHeader(msg.subject)),
        'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
        'Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@ledgerdesk.local>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64'
      ].join('\r\n');
      await cmd(head + '\r\n\r\n' + body + '.', [250]);
      try { sock.write('QUIT\r\n'); } catch (e) {}
      done = true; clearTimeout(timer); setTimeout(() => { try { sock.destroy(); } catch (e) {} }, 500);
      resolve(true);
    }
    const s0 = implicitTLS ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    attach(s0);
    s0.once(implicitTLS ? 'secureConnect' : 'connect', () => run().catch(fail));
  });
}
module.exports = { sendMail, validEmail };
