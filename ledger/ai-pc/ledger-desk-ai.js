/* Ledger Desk AI: runs on the owner's AI PC and answers the AI requests of the Ledger Desk website (trivedipos.com/books).
   It connects OUT to the website over a secure WebSocket (no ports opened on this PC), takes one job at a time,
   asks Ollama on this PC, and sends the answer back. Books are never stored here; only the data each request needs passes through.
   Run with the Ledger Desk Server runtime:  ELECTRON_RUN_AS_NODE=1 "Ledger Desk Server.exe" ledger-desk-ai.js  (or any Node 18+). */
'use strict';
const http = require('http'), tls = require('tls'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const DIR = __dirname, CONFIG_PATH = path.join(DIR, 'config.json'), LOG_PATH = path.join(DIR, 'ledger-desk-ai.log');
const DEFAULTS = { url: 'wss://trivedipos.com/api/ai-pc', key: '', ollama: 'http://127.0.0.1:11434', textModel: 'qwen2.5:7b', visionModel: 'qwen2.5vl:7b' };
function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (e) { return d; } }
let CFG = Object.assign({}, DEFAULTS, readJSON(CONFIG_PATH, {}));
CFG.aiEnabled = true;
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ') + '\n';
  try { if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1e6) fs.renameSync(LOG_PATH, LOG_PATH + '.old'); fs.appendFileSync(LOG_PATH, line); } catch (e) { /* ignore */ }
  process.stdout.write(line);
}
function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }

// ---------------- Ollama on this PC ----------------
function ollama(pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, CFG.ollama);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { let msg = text; try { msg = JSON.parse(text).error || text; } catch (e) {} return reject(new Error('Ollama: ' + msg)); }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('Ollama sent an unreadable answer')); }
      });
    });
    req.setTimeout(timeoutMs || 280e3, () => req.destroy(new Error('The AI took too long to answer.')));
    req.on('error', e => reject(e.code === 'ECONNREFUSED' ? new Error('The AI program (Ollama) is not running on the AI PC.') : e));
    if (data) req.write(data);
    req.end();
  });
}
async function chatJSON(model, messages, schema, numCtx) {
  const r = await ollama('/api/chat', { model, messages, stream: false, format: schema, options: { temperature: 0, num_ctx: numCtx || 8192 }, keep_alive: '10m' });
  const txt = (r.message && r.message.content) || '';
  try { return JSON.parse(txt); } catch (e) { const m = /\{[\s\S]*\}/.exec(txt); if (m) return JSON.parse(m[0]); throw new Error('The AI answer was not in the expected format. Try again.'); }
}
async function aiStatus() {
  try {
    const t = await ollama('/api/tags', null, 4000);
    const have = (t.models || []).map(m => m.name);
    const has = n => have.some(h => h === n || h === n + ':latest');
    return { ok: true, textModel: CFG.textModel, visionModel: CFG.visionModel, hasText: has(CFG.textModel), hasVision: has(CFG.visionModel) };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ---------------- the AI jobs (same as Ledger Desk Server 2.0) ----------------
// Same context size for every text request, so the model isn't reloaded between jobs (fits an 8 GB graphics card).
const TEXT_CTX = 24576;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

async function aiCategorize(body, ctx) {
  const cats = (body.categories || []).slice(0, 400).map(c => ({ name: clip(c.name, 80), type: clip(c.type, 12) })).filter(c => c.name);
  const txns = (body.txns || []).slice(0, 25).map(t => ({ id: clip(t.id, 40), date: clip(t.date, 10), payee: clip(t.payee, 120), memo: clip(t.memo, 160), amount: Number(t.amount) || 0, account: clip(t.account, 80), accountKind: clip(t.accountKind, 20), bankDeposit: !!t.bankDeposit }));
  if (!cats.length || !txns.length) throw httpErr(400, 'Nothing to categorize');
  const examples = (body.examples || []).slice(0, 120).map(e => clip(e.payee, 80) + ' → ' + clip(e.category, 80)).join('\n');
  const rules = (body.rules || []).slice(0, 150).map(r => '"' + clip(r.match, 60) + '"' + (r.sign === 'out' ? ' (money out)' : r.sign === 'in' ? ' (money in)' : '') + ' → ' + clip(r.category, 80)).join('\n');
  const notes = clip(body.notes, 3000);
  const names = cats.map(c => c.name);
  const sys = `You are a careful bookkeeper for a small US business${body.business ? ' (' + clip(body.business, 80) + ')' : ''}. For each bank or credit card transaction, pick the best category from the list. Use ONLY names from the list, spelled exactly.
How to read amounts: on a credit card, a negative amount is a charge and a positive amount is a payment or refund. On a bank account, negative is money out and positive is money in.
Rules you must follow:
- A deposit into a bank account (bankDeposit true) is NEVER income.
- Payments to a credit card or loan, and transfers between the owner's own accounts, go to that card, loan or bank account (or a transfers account), never to an expense.
- If the payee looks personal or you really cannot tell, use the closest category and set confidence "low".
- "high" only when the payee clearly matches the business's past choices, its rules, or an obvious merchant type. Otherwise "medium" or "low".
- reason: one short sentence a business owner understands (for example "Sam's Club is a warehouse store; your past Sam's Club charges are Hotel Supplies").`;
  const user = `CATEGORIES (name | type):\n${cats.map(c => c.name + ' | ' + c.type).join('\n')}\n\n` +
    (rules ? `THE OWNER'S BANK RULES (payee text → category):\n${rules}\n\n` : '') +
    (examples ? `HOW THIS BUSINESS CATEGORIZED PAST PAYEES:\n${examples}\n\n` : '') +
    (notes ? `OWNER'S NOTES:\n${notes}\n\n` : '') +
    `TRANSACTIONS TO CATEGORIZE (JSON):\n${JSON.stringify(txns)}\n\nAnswer with one result for every transaction id.`;
  const schema = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, category: { type: 'string', enum: names }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' } }, required: ['id', 'category', 'confidence', 'reason'] } } }, required: ['results'] };
  const out = await chatJSON(CFG.textModel, [{ role: 'system', content: sys }, { role: 'user', content: user }], schema, TEXT_CTX, ctx);
  const ids = new Set(txns.map(t => t.id));
  return { results: (out.results || []).filter(r => ids.has(r.id) && names.indexOf(r.category) > -1).map(r => ({ id: r.id, category: r.category, confidence: r.confidence, reason: clip(r.reason, 300) })) };
}
async function aiAsk(body, aiCtx) {
  const q = clip(body.question, 1000).trim();
  if (!q) throw httpErr(400, 'Type a question');
  const ctx = clip(body.context, 60000);
  const hist = (body.history || []).slice(-6).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: clip(h.content, 2000) }));
  const sys = `You answer questions about one company's books in Ledger Desk. Today is ${new Date().toISOString().slice(0, 10)}.
Use ONLY the figures in BOOKS DATA below. They were calculated by the app and are correct; copy them, do not recalculate unless you must add a few numbers.
If the answer is not in the data, say what is missing and which Ledger Desk screen would show it (Transactions, Reports, Chart of Accounts). Never guess numbers.
Money is US dollars. Credit card and loan balances are amounts owed. Keep answers short and plain: a direct answer first, then a few supporting lines. No tables wider than 4 columns.`;
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  const msgs = [{ role: 'system', content: sys + '\n\nBOOKS DATA:\n' + ctx }].concat(hist, [{ role: 'user', content: q }]);
  const out = await chatJSON(CFG.textModel, msgs, schema, TEXT_CTX, aiCtx);
  return { answer: clip(out.answer, 6000) };
}
async function aiCheck(body, ctx) {
  const img = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!img || img.length > 14e6 || !/^[A-Za-z0-9+/=\s]+$/.test(img.slice(0, 2000))) throw httpErr(400, 'Send a JPG or PNG picture of the check.');
  const schema = { type: 'object', properties: { payee: { type: 'string' }, amount: { type: 'number' }, date: { type: 'string' }, checkNumber: { type: 'string' }, memo: { type: 'string' }, payer: { type: 'string' } }, required: ['payee', 'amount', 'date', 'checkNumber', 'memo', 'payer'] };
  const prompt = 'This is a picture of a paper check (or a bank\'s check image). Read it. payee = the name after "Pay to the order of". amount = the dollar amount as a number. date = the date written on the check as YYYY-MM-DD. checkNumber = the check number (top right, or the number in the MICR line at the bottom). memo = the memo line. payer = the account holder printed at the top left. Use "" for anything you cannot read and 0 for an unreadable amount. Do not guess.';
  const out = await chatJSON(CFG.visionModel, [{ role: 'user', content: prompt, images: [img] }], schema, 8192, ctx);
  return { payee: clip(out.payee, 120), amount: Math.round((Number(out.amount) || 0) * 100) / 100, date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '', checkNumber: clip(String(out.checkNumber || '').replace(/[^0-9]/g, ''), 12), memo: clip(out.memo, 160), payer: clip(out.payer, 120) };
}

// "Explain my numbers": the app sends figures it already calculated; the AI only puts them into words.
async function aiExplain(body, ctx) {
  const facts = clip(body.facts, 40000);
  if (!facts) throw httpErr(400, 'Nothing to explain');
  const sys = `You write a short monthly money summary for the owner of ${clip(body.company, 80) || 'a small business'} (${clip(body.business, 120) || 'small business'}).
Use ONLY the figures in FACTS. They are correct; copy them exactly and never invent or recalculate numbers.
Bank deposits are not income in these books; the owner records income separately, so income may be missing or low. If income is zero, say income hasn't been recorded yet instead of calling it a loss.
Say WHAT changed (with the amounts and the payees in FACTS). Do NOT guess WHY (no 'likely due to', no 'possibly'); if a change is large, put it under watch as something to check. Write for a busy owner in plain English. headline: one sentence. points: 3 to 6 short sentences about what changed and why (name categories and payees). watch: 0 to 3 short things worth checking.`;
  const schema = { type: 'object', properties: { headline: { type: 'string' }, points: { type: 'array', items: { type: 'string' } }, watch: { type: 'array', items: { type: 'string' } } }, required: ['headline', 'points', 'watch'] };
  const out = await chatJSON(CFG.textModel, [{ role: 'system', content: sys }, { role: 'user', content: 'FACTS:\n' + facts }], schema, TEXT_CTX, ctx);
  // small models like to guess causes; keep only what the figures show
  const noGuess = x => clip(String(x || '').replace(/,?\s*(which )?(is |are |was |were )?(likely|possibly|probably|perhaps|could be|may be|might be|which could|which may|suggesting|indicating)\b[^.]*/gi, '').replace(/\s+\./g, '.').trim(), 400);
  return { headline: noGuess(out.headline), points: (out.points || []).slice(0, 6).map(noGuess).filter(Boolean), watch: (out.watch || []).slice(0, 3).map(x => clip(x, 300)) };
}
// "Spot problems": the AI looks for charges that don't fit the business. Exact checks (duplicates, price jumps) are done by the app.
async function aiReview(body, ctx) {
  const txns = (body.txns || []).slice(0, 80).map(t => ({ id: clip(t.id, 40), date: clip(t.date, 10), payee: clip(t.payee, 100), amount: Number(t.amount) || 0, category: clip(t.category, 60), account: clip(t.account, 60) }));
  if (!txns.length) return { flags: [] };
  const sys = `You review a small business's recent spending for anything worth a second look. Business: ${clip(body.company, 80)}. ${clip(body.notes, 2500)}
Flag ONLY transactions that look wrong: a personal-looking purchase in a business category, a category that doesn't fit the payee, an unusual one-off for this kind of business, or a fee/penalty/interest that may be avoidable. Do NOT flag normal supplies, utilities, payroll, taxes, loan payments or transfers.
Return at most 10 flags. reason: one short sentence. severity: "high" or "medium". If nothing looks wrong, return an empty list.`;
  const schema = { type: 'object', properties: { flags: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium'] } }, required: ['id', 'reason', 'severity'] } } }, required: ['flags'] };
  const out = await chatJSON(CFG.textModel, [{ role: 'system', content: sys }, { role: 'user', content: 'TRANSACTIONS (JSON):\n' + JSON.stringify(txns) }], schema, TEXT_CTX, ctx);
  const ids = new Set(txns.map(t => t.id));
  return { flags: (out.flags || []).filter(f => ids.has(f.id)).slice(0, 10).map(f => ({ id: f.id, reason: clip(f.reason, 300), severity: f.severity === 'high' ? 'high' : 'medium' })) };
}
// Receipts, bills, invoices and checks: read the picture.
async function aiDocument(body, ctx) {
  const img = String(body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!img || img.length > 14e6 || !/^[A-Za-z0-9+/=\s]+$/.test(img.slice(0, 2000))) throw httpErr(400, 'Send a JPG or PNG picture.');
  const cats = (body.categories || []).slice(0, 200).map(c => clip(c, 80)).filter(Boolean);
  const schema = { type: 'object', properties: {
    kind: { type: 'string', enum: ['receipt', 'bill', 'invoice', 'check', 'other'] }, vendor: { type: 'string' }, date: { type: 'string' }, total: { type: 'number' }, tax: { type: 'number' },
    number: { type: 'string' }, memo: { type: 'string' }, payer: { type: 'string' },
    items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, amount: { type: 'number' } }, required: ['description', 'amount'] } },
    category: cats.length ? { type: 'string', enum: cats.concat(['']) } : { type: 'string' } }, required: ['kind', 'vendor', 'date', 'total', 'tax', 'number', 'memo', 'payer', 'items', 'category'] };
  const prompt = 'Read this business document (a store receipt, a utility or vendor bill, an invoice, or a paper check). kind: which one it is. vendor: the business that was paid (for a check: the name after "Pay to the order of"). date: the purchase/bill/check date as YYYY-MM-DD. total: the final amount paid or due, as a number. tax: sales tax as a number (0 if none). number: the invoice, account or check number. memo: anything short worth keeping (for a bill: the service period). payer: who paid (the account holder on a check, or "" ). items: up to 8 main lines with amounts. category: the best match from this list, or "" if unsure: ' + cats.join(', ') + '. Use "" or 0 for anything you cannot read. Do not guess.';
  const out = await chatJSON(CFG.visionModel, [{ role: 'user', content: prompt, images: [img] }], schema, 8192, ctx);
  return { kind: out.kind || 'other', vendor: clip(out.vendor, 120), date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '', total: Math.round((Number(out.total) || 0) * 100) / 100, tax: Math.round((Number(out.tax) || 0) * 100) / 100,
    number: clip(String(out.number || ''), 40), memo: clip(out.memo, 160), payer: clip(out.payer, 120), items: (out.items || []).slice(0, 8).map(i => ({ description: clip(i.description, 80), amount: Math.round((Number(i.amount) || 0) * 100) / 100 })),
    category: cats.includes(out.category) ? out.category : '' };
}


const JOBS = { '/api/ai/categorize': aiCategorize, '/api/ai/ask': aiAsk, '/api/ai/check': aiCheck, '/api/ai/explain': aiExplain, '/api/ai/review': aiReview, '/api/ai/document': aiDocument };
let chain = Promise.resolve();
const oneAtATime = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

// ---------------- WebSocket client (no extra packages) ----------------
let sock = null, lastIn = 0, retry = 5e3, timers = [];
function frame(op, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const n = data.length, mask = crypto.randomBytes(4);
  const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  const out = Buffer.alloc(n); for (let i = 0; i < n; i++) out[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, out]);
}
function send(obj) { if (sock && sock.ready) sock.write(frame(1, JSON.stringify(obj))); }
function stopTimers() { timers.forEach(clearInterval); timers = []; }
function reconnect(why) {
  if (sock) { try { sock.destroy(); } catch (e) {} sock = null; }
  stopTimers();
  log('disconnected' + (why ? ': ' + why : '') + '. Trying again in ' + Math.round(retry / 1000) + ' s');
  setTimeout(connect, retry); retry = Math.min(retry * 2, 120e3);
}
async function pushStatus() { const st = await aiStatus(); send({ t: 'status', status: st }); return st; }
async function onMessage(text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (m.t !== 'job' || !m.id) return;
  const fn = JOBS[m.path];
  if (!fn) { send({ t: 'done', id: m.id, error: 'This AI PC does not know ' + m.path + '. Update Ledger Desk AI.' }); return; }
  const t0 = Date.now();
  try { const result = await oneAtATime(() => fn(m.body || {})); send({ t: 'done', id: m.id, result }); log('done', m.path, ((Date.now() - t0) / 1000).toFixed(1) + ' s'); }
  catch (e) { send({ t: 'done', id: m.id, error: e.message }); log('error', m.path, e.message); }
}
function connect() {
  CFG = Object.assign({}, DEFAULTS, readJSON(CONFIG_PATH, {}));
  if (!/^[a-f0-9]{64}$/.test(CFG.key || '')) { log('No AI PC key in config.json yet. Checking again in 60 s.'); setTimeout(connect, 60e3); return; }
  const u = new URL(CFG.url), host = u.hostname, port = Number(u.port) || 443;
  const s = tls.connect({ host, port, servername: host });
  sock = s; let buf = Buffer.alloc(0), open = false, parts = [];
  s.setNoDelay(true);
  s.on('secureConnect', () => {
    s.write(`GET ${u.pathname}?key=${CFG.key} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: LedgerDeskAI/1.0\r\n\r\n`);
  });
  s.on('data', d => {
    lastIn = Date.now(); buf = Buffer.concat([buf, d]);
    if (!open) {
      const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
      const first = buf.slice(0, i).toString().split('\r\n')[0]; buf = buf.slice(i + 4);
      if (!/^HTTP\/1\.1 101/.test(first)) { if (/ 403/.test(first)) retry = 300e3; reconnect('the website said ' + first + (/ 403/.test(first) ? ' (wrong AI PC key)' : '')); return; }
      open = true; s.ready = true; retry = 5e3; log('connected to', host);
      pushStatus().then(st => log('AI status:', st.ok ? 'ok, text model ' + (st.hasText ? 'ready' : 'MISSING') + ', vision model ' + (st.hasVision ? 'ready' : 'MISSING') : st.reason));
      timers.push(setInterval(() => send({ t: 'ping' }), 30e3));
      timers.push(setInterval(pushStatus, 120e3));
      timers.push(setInterval(() => { if (Date.now() - lastIn > 100e3) reconnect('no answer from the website for 100 s'); }, 20e3));
    }
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mk = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len); buf = buf.slice(off + len);
      if (mk) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3]; }
      if (op === 8) { reconnect('closed by the website' + (payload.length >= 2 ? ' (' + payload.readUInt16BE(0) + ' ' + payload.slice(2).toString() + ')' : '')); return; }
      if (op === 9) { s.write(frame(10, payload)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) { parts.push(payload); if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; onMessage(text); } }
    }
  });
  s.on('error', e => { if (sock === s) reconnect(e.message); });
  s.on('close', () => { if (sock === s) reconnect('connection closed'); });
}
log('Ledger Desk AI starting. Website:', CFG.url, '· Ollama:', CFG.ollama);
connect();
