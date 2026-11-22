// "Send for signature" (like DocuSign) for PdfStudio.
// The owner uploads a PDF plus boxes for each signer. Each signer gets an email link (no account needed),
// fills in only their own boxes and submits. When everyone has signed, the owner's PdfStudio builds the
// signed PDF (with a "certificate of completion" page) and uploads it; then everyone is emailed a copy.
//
// Storage: D1 tables below (created on first use) + the FILES R2 bucket under esign/<requestId>/.

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256Bytes = async (b) => hex(await crypto.subtle.digest('SHA-256', b));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const KINDS = new Set(['signature', 'initials', 'date', 'text']);
const MAX_PDF = 25 * 1024 * 1024;
const MAX_SIGNERS = 10;
const MAX_FIELDS = 200;
const MAX_IMG = 1536 * 1024; // one signature picture (data URL length)

let ready = false;
async function ensureTables(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS esign_requests (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_name TEXT, notify_email TEXT, title TEXT NOT NULL, message TEXT,
      file_name TEXT, fields TEXT NOT NULL, status TEXT NOT NULL, doc_hash TEXT, final_hash TEXT,
      created_at INTEGER NOT NULL, completed_at INTEGER, finalized_at INTEGER, canceled_at INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS esign_signers (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, idx INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE, status TEXT NOT NULL, emailed_at INTEGER, email_error TEXT, viewed_at INTEGER,
      signed_at INTEGER, declined_at INTEGER, decline_reason TEXT, ip TEXT, ua TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS esign_events (request_id TEXT NOT NULL, at INTEGER NOT NULL, who TEXT, what TEXT NOT NULL, ip TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS esign_req_owner ON esign_requests(owner_id, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS esign_sig_req ON esign_signers(request_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS esign_ev_req ON esign_events(request_id, at)'),
  ]);
  ready = true;
}
const ipOf = (request) => request.headers.get('cf-connecting-ip') || '';
async function logEvent(env, reqId, who, what, ip = '') {
  await env.DB.prepare('INSERT INTO esign_events (request_id, at, who, what, ip) VALUES (?,?,?,?,?)').bind(reqId, Date.now(), who, what, ip).run();
}

// ---------- email (Resend) ----------
async function sendMail(env, { to, subject, html, text, replyTo }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Email sending is not set up yet.' };
  try {
    const body = { from: env.SIGN_FROM || 'PdfStudio Signing <sign@trivedipos.com>', to: [to], subject, html, text };
    if (replyTo && EMAIL_RE.test(replyTo)) body.reply_to = replyTo;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return { ok: true };
    let why = ''; try { why = String((await r.json()).message || '').slice(0, 200); } catch { /* none */ }
    return { ok: false, error: `Email service said ${r.status}${why ? ': ' + why : ''}` };
  } catch { return { ok: false, error: 'Could not reach the email service.' }; }
}
const mailBox = (title, lead, button, link, foot) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2430">
<h2 style="margin:0 0 12px;font-size:20px">${title}</h2>${lead}
${button ? `<p style="margin:24px 0"><a href="${escHtml(link)}" style="background:#5b3df0;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">${button}</a></p>` : ''}
<p style="font-size:12px;color:#889;line-height:1.5">${foot}</p></div>`;

async function emailSigner(env, origin, rq, s) {
  const link = `${origin}/pdfstudio/s/${s.token}`;
  const from = rq.owner_name || 'Someone';
  const lead = `<p style="line-height:1.5">${escHtml(from)} sent you <b>${escHtml(rq.title)}</b> to sign.</p>` +
    (rq.message ? `<p style="line-height:1.5;background:#f4f5fa;border-radius:8px;padding:10px 12px;white-space:pre-wrap">${escHtml(rq.message)}</p>` : '') +
    '<p style="line-height:1.5">No account or download is needed. Open the document, fill in the highlighted boxes, and press Finish.</p>';
  const foot = `Only use this link if you expected it. Do not forward it: anyone with the link can sign as you.<br>If the button does not work, paste this into your browser: ${escHtml(link)}`;
  const r = await sendMail(env, {
    to: s.email, subject: `Please sign: ${rq.title}`, replyTo: rq.notify_email,
    html: mailBox('Document waiting for your signature', lead, 'Review and sign', link, foot),
    text: `${from} sent you "${rq.title}" to sign.\n\n${rq.message ? rq.message + '\n\n' : ''}Open it here (no account needed): ${link}\n\nDo not forward this link: anyone with it can sign as you.`,
  });
  await env.DB.prepare('UPDATE esign_signers SET emailed_at = ?, email_error = ? WHERE id = ?').bind(r.ok ? Date.now() : null, r.ok ? null : r.error, s.id).run();
  return r;
}

// ---------- helpers ----------
async function loadRequest(env, id) {
  const rq = await env.DB.prepare('SELECT * FROM esign_requests WHERE id = ?').bind(id).first();
  if (!rq) return null;
  const { results } = await env.DB.prepare('SELECT * FROM esign_signers WHERE request_id = ? ORDER BY idx').bind(id).all();
  return { rq, signers: results || [] };
}
function ownerView(origin, rq, signers, events) {
  return {
    id: rq.id, title: rq.title, message: rq.message || '', fileName: rq.file_name, status: rq.status,
    createdAt: rq.created_at, completedAt: rq.completed_at, finalizedAt: rq.finalized_at, notifyEmail: rq.notify_email || '',
    docHash: rq.doc_hash, finalHash: rq.final_hash, fields: JSON.parse(rq.fields || '[]'),
    signers: signers.map((s) => ({
      id: s.id, idx: s.idx, name: s.name, email: s.email, status: s.status, link: `${origin}/pdfstudio/s/${s.token}`,
      emailedAt: s.emailed_at, emailError: s.email_error, viewedAt: s.viewed_at, signedAt: s.signed_at,
      declinedAt: s.declined_at, declineReason: s.decline_reason, ip: s.ip, ua: s.ua,
    })),
    events: events || undefined,
  };
}
async function readBody(request, max) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > max) return null;
  const buf = await request.arrayBuffer();
  return buf.byteLength > max ? null : new Uint8Array(buf);
}
function cleanFields(list, nSigners) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_FIELDS) return null;
  const out = [];
  for (const f of list) {
    const n = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : NaN;
    const o = { id: String(f.id || rand(6)).slice(0, 32), page: Math.trunc(Number(f.page)), signer: Math.trunc(Number(f.signer)), kind: String(f.kind), x: n(f.x), y: n(f.y), w: n(f.w), h: n(f.h), label: String(f.label || '').slice(0, 60) };
    if (!KINDS.has(o.kind) || !(o.page >= 0) || !(o.signer >= 0 && o.signer < nSigners) || [o.x, o.y, o.w, o.h].some((v) => !Number.isFinite(v)) || o.w <= 2 || o.h <= 2) return null;
    out.push(o);
  }
  return out;
}

// ---------- router ----------
export async function handleEsign(request, env, url, route, getAuth) {
  await ensureTables(env);
  const method = request.method;
  const origin = url.origin;

  // ===== public: signer by link token =====
  let m = route.match(/^esign\/t\/([a-f0-9]+)(?:\/(pdf|submit|decline|final))?$/);
  if (m) {
    const token = m[1], sub = m[2] || '';
    if (!TOKEN_RE.test(token)) return fail(404, 'This signing link is not valid.');
    const s = await env.DB.prepare('SELECT * FROM esign_signers WHERE token = ?').bind(token).first();
    if (!s) return fail(404, 'This signing link is not valid.');
    const rq = await env.DB.prepare('SELECT * FROM esign_requests WHERE id = ?').bind(s.request_id).first();
    if (!rq) return fail(404, 'This signing link is not valid.');
    const ip = ipOf(request);

    if (sub === '' && method === 'GET') {
      if (rq.status !== 'canceled' && !s.viewed_at) {
        await env.DB.prepare('UPDATE esign_signers SET viewed_at = ?, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?').bind(Date.now(), 'sent', 'viewed', s.id).run();
        await logEvent(env, rq.id, `${s.name} <${s.email}>`, 'Opened the document', ip);
      }
      const fields = JSON.parse(rq.fields).filter((f) => f.signer === s.idx).map(({ signer, ...f }) => f);
      return json({
        title: rq.title, message: rq.message || '', from: rq.owner_name || '', name: s.name, email: s.email,
        status: rq.status === 'canceled' ? 'canceled' : s.status, requestStatus: rq.status, fields, hasFinal: !!rq.finalized_at,
      });
    }
    if (sub === 'pdf' && method === 'GET') {
      if (rq.status === 'canceled') return fail(410, 'This request was canceled by the sender.');
      const obj = await env.FILES.get(`esign/${rq.id}/original.pdf`);
      if (!obj) return fail(404, 'The document is missing.');
      return new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } });
    }
    if (sub === 'final' && method === 'GET') {
      const obj = rq.finalized_at ? await env.FILES.get(`esign/${rq.id}/final.pdf`) : null;
      if (!obj) return fail(404, 'The signed copy is not ready yet.');
      const name = (rq.file_name || 'document.pdf').replace(/\.pdf$/i, '') + ' (signed).pdf';
      return new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${name.replace(/[^\w .()-]/g, '_')}"` } });
    }
    if (sub === 'decline' && method === 'POST') {
      if (rq.status !== 'sent' || s.status === 'signed' || s.status === 'declined') return fail(409, 'This document can no longer be declined.');
      let b = {}; try { b = await request.json(); } catch { /* empty */ }
      const reason = String(b.reason || '').slice(0, 500);
      await env.DB.prepare('UPDATE esign_signers SET status = ?, declined_at = ?, decline_reason = ?, ip = ?, ua = ? WHERE id = ?')
        .bind('declined', Date.now(), reason, ip, String(request.headers.get('user-agent') || '').slice(0, 300), s.id).run();
      await env.DB.prepare('UPDATE esign_requests SET status = ? WHERE id = ?').bind('declined', rq.id).run();
      await logEvent(env, rq.id, `${s.name} <${s.email}>`, `Declined to sign${reason ? ': ' + reason : ''}`, ip);
      if (rq.notify_email) await sendMail(env, {
        to: rq.notify_email, subject: `Declined: ${rq.title}`,
        html: mailBox('A signer declined', `<p style="line-height:1.5"><b>${escHtml(s.name)}</b> (${escHtml(s.email)}) declined to sign <b>${escHtml(rq.title)}</b>.</p>${reason ? `<p style="line-height:1.5">Reason: ${escHtml(reason)}</p>` : ''}`, '', '', 'Open PdfStudio, Sign, Signing requests to see the details.'),
        text: `${s.name} (${s.email}) declined to sign "${rq.title}".${reason ? ' Reason: ' + reason : ''}`,
      });
      return json({ ok: true });
    }
    if (sub === 'submit' && method === 'POST') {
      if (rq.status === 'canceled') return fail(410, 'This request was canceled by the sender.');
      if (s.status === 'signed') return fail(409, 'You already signed this document.');
      if (s.status === 'declined' || rq.status !== 'sent') return fail(409, 'This document can no longer be signed.');
      let b; try { b = await request.json(); } catch { return fail(400, 'Bad request.'); }
      if (b.consent !== true) return fail(400, 'Please tick the box to agree to sign electronically.');
      const mine = JSON.parse(rq.fields).filter((f) => f.signer === s.idx);
      const vals = b.values && typeof b.values === 'object' ? b.values : {};
      const clean = {};
      for (const f of mine) {
        const v = vals[f.id];
        if (f.kind === 'signature' || f.kind === 'initials') {
          if (typeof v !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > MAX_IMG) return fail(400, `Please fill in every ${f.kind === 'initials' ? 'initials' : 'signature'} box.`);
          clean[f.id] = v;
        } else if (f.kind === 'date') {
          clean[f.id] = new Date().toISOString(); // the server's date, not the signer's computer
        } else {
          const t = typeof v === 'string' ? v.trim().slice(0, 300) : '';
          if (!t) return fail(400, 'Please fill in every box.');
          clean[f.id] = t;
        }
      }
      const tz = String(b.tz || '').slice(0, 60);
      const now = Date.now();
      await env.FILES.put(`esign/${rq.id}/${s.id}.json`, JSON.stringify({ values: clean, tz, signedAt: now }), { httpMetadata: { contentType: 'application/json' } });
      await env.DB.prepare('UPDATE esign_signers SET status = ?, signed_at = ?, ip = ?, ua = ? WHERE id = ?')
        .bind('signed', now, ip, String(request.headers.get('user-agent') || '').slice(0, 300), s.id).run();
      await logEvent(env, rq.id, `${s.name} <${s.email}>`, 'Signed', ip);
      const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM esign_signers WHERE request_id = ? AND status != ?').bind(rq.id, 'signed').first();
      if ((left?.n || 0) === 0) {
        await env.DB.prepare('UPDATE esign_requests SET status = ?, completed_at = ? WHERE id = ? AND status = ?').bind('completed', now, rq.id, 'sent').run();
        await logEvent(env, rq.id, 'PdfStudio', 'Everyone has signed', '');
        if (rq.notify_email) await sendMail(env, {
          to: rq.notify_email, subject: `Everyone signed: ${rq.title}`,
          html: mailBox('Everyone has signed', `<p style="line-height:1.5">All signers have signed <b>${escHtml(rq.title)}</b>.</p><p style="line-height:1.5">Open PdfStudio and go to <b>Sign → Signing requests</b>. PdfStudio puts the signed PDF together there and emails a copy to every signer.</p>`, 'Open PdfStudio', `${origin}/pdfstudio/app/`, 'You get this because you sent the document for signature in PdfStudio.'),
          text: `All signers have signed "${rq.title}". Open PdfStudio (Sign, Signing requests) to get the signed PDF: ${origin}/pdfstudio/app/`,
        });
      }
      return json({ ok: true, allDone: (left?.n || 0) === 0 });
    }
    return fail(405, 'Method not allowed.');
  }

  // ===== owner (signed in to PdfStudio) =====
  const auth = await getAuth();
  if (!auth) return fail(401, 'Not signed in.');
  const me = auth.user;

  if (route === 'esign/requests' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM esign_requests WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100').bind(me.id).all();
    const out = [];
    for (const rq of results || []) {
      const { results: sg } = await env.DB.prepare('SELECT * FROM esign_signers WHERE request_id = ? ORDER BY idx').bind(rq.id).all();
      out.push(ownerView(origin, rq, sg || []));
    }
    return json({ requests: out, emailReady: !!env.RESEND_API_KEY });
  }

  if (route === 'esign/requests' && method === 'POST') {
    // multipart-free: JSON meta in the "x-esign-meta" header would be too small, so the body is: 4-byte meta length + meta JSON + PDF bytes
    const body = await readBody(request, MAX_PDF + 1024 * 1024);
    if (!body || body.length < 8) return fail(413, 'The PDF is too large (25 MB at most).');
    const metaLen = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
    if (metaLen <= 0 || metaLen > 1024 * 1024 || metaLen + 4 >= body.length) return fail(400, 'Bad request.');
    let meta; try { meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + metaLen))); } catch { return fail(400, 'Bad request.'); }
    const pdf = body.subarray(4 + metaLen);
    if (pdf.length > MAX_PDF) return fail(413, 'The PDF is too large (25 MB at most).');
    if (new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') return fail(400, 'That is not a PDF.');
    const title = String(meta.title || '').trim().slice(0, 150) || 'Document';
    const message = String(meta.message || '').trim().slice(0, 2000);
    const notify = String(meta.notifyEmail || me.email || '').trim().toLowerCase();
    const signers = Array.isArray(meta.signers) ? meta.signers : [];
    if (!signers.length || signers.length > MAX_SIGNERS) return fail(400, `Add between 1 and ${MAX_SIGNERS} signers.`);
    const cleanSigners = signers.map((x) => ({ name: String(x.name || '').trim().slice(0, 100), email: String(x.email || '').trim().toLowerCase().slice(0, 200) }));
    for (const x of cleanSigners) if (!x.name || !EMAIL_RE.test(x.email)) return fail(400, `Check the name and email for every signer${x.email ? ` (${x.email})` : ''}.`);
    const fields = cleanFields(meta.fields, cleanSigners.length);
    if (!fields) return fail(400, 'Place at least one box on the document for the signers.');
    for (let i = 0; i < cleanSigners.length; i++) if (!fields.some((f) => f.signer === i)) return fail(400, `${cleanSigners[i].name} has no boxes to fill in. Add at least one, or remove them.`);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM esign_requests WHERE owner_id = ? AND created_at > ?').bind(me.id, Date.now() - 3600000).first();
    if ((recent?.n || 0) >= 30) return fail(429, 'Too many requests in the last hour. Try again later.');

    const id = rand(10), now = Date.now();
    const docHash = await sha256Bytes(pdf);
    await env.FILES.put(`esign/${id}/original.pdf`, pdf, { httpMetadata: { contentType: 'application/pdf' } });
    const ownerName = String(meta.fromName || me.username || '').trim().slice(0, 100);
    await env.DB.prepare('INSERT INTO esign_requests (id, owner_id, owner_name, notify_email, title, message, file_name, fields, status, doc_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, me.id, ownerName, EMAIL_RE.test(notify) ? notify : null, title, message, String(meta.fileName || 'document.pdf').slice(0, 150), JSON.stringify(fields), 'sent', docHash, now).run();
    const rows = cleanSigners.map((x, i) => ({ id: rand(8), idx: i, token: rand(24), ...x }));
    await env.DB.batch(rows.map((s) => env.DB.prepare('INSERT INTO esign_signers (id, request_id, idx, name, email, token, status) VALUES (?,?,?,?,?,?,?)').bind(s.id, id, s.idx, s.name, s.email, s.token, 'sent')));
    await logEvent(env, id, `${ownerName} (${me.username})`, `Sent "${title}" for signature to ${cleanSigners.map((x) => `${x.name} <${x.email}>`).join(', ')}`, ipOf(request));
    const rq = await env.DB.prepare('SELECT * FROM esign_requests WHERE id = ?').bind(id).first();
    for (const s of rows) await emailSigner(env, origin, rq, s);
    const full = await loadRequest(env, id);
    return json(ownerView(origin, full.rq, full.signers));
  }

  m = route.match(/^esign\/requests\/([a-f0-9]{20})(?:\/(remind|cancel|original|values|final))?$/);
  if (m) {
    const full = await loadRequest(env, m[1]);
    if (!full || full.rq.owner_id !== me.id) return fail(404, 'Not found.');
    const { rq, signers } = full, sub = m[2] || '';
    if (sub === '' && method === 'GET') {
      const { results: ev } = await env.DB.prepare('SELECT at, who, what, ip FROM esign_events WHERE request_id = ? ORDER BY at').bind(rq.id).all();
      return json(ownerView(origin, rq, signers, ev || []));
    }
    if (sub === 'original' && method === 'GET') {
      const obj = await env.FILES.get(`esign/${rq.id}/original.pdf`);
      return obj ? new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } }) : fail(404, 'Missing.');
    }
    if (sub === 'values' && method === 'GET') {
      const out = {};
      for (const s of signers) if (s.status === 'signed') {
        const o = await env.FILES.get(`esign/${rq.id}/${s.id}.json`);
        if (o) out[s.id] = await o.json();
      }
      return json({ values: out });
    }
    if (sub === 'final' && method === 'GET') {
      const obj = rq.finalized_at ? await env.FILES.get(`esign/${rq.id}/final.pdf`) : null;
      return obj ? new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } }) : fail(404, 'Not ready.');
    }
    if (sub === 'final' && method === 'PUT') {
      if (rq.status !== 'completed') return fail(409, 'Not everyone has signed yet.');
      if (rq.finalized_at) return json({ ok: true, already: true });
      const pdf = await readBody(request, MAX_PDF * 2);
      if (!pdf || new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') return fail(400, 'That is not a PDF.');
      const fh = await sha256Bytes(pdf);
      await env.FILES.put(`esign/${rq.id}/final.pdf`, pdf, { httpMetadata: { contentType: 'application/pdf' } });
      const now = Date.now();
      await env.DB.prepare('UPDATE esign_requests SET finalized_at = ?, final_hash = ? WHERE id = ?').bind(now, fh, rq.id).run();
      await logEvent(env, rq.id, 'PdfStudio', 'Signed copy completed and sent to everyone', '');
      const name = (rq.file_name || 'document.pdf').replace(/\.pdf$/i, '');
      for (const s of signers) {
        const link = `${origin}/pdfstudio/api/esign/t/${s.token}/final`;
        await sendMail(env, {
          to: s.email, subject: `Completed: ${rq.title}`, replyTo: rq.notify_email,
          html: mailBox('Everyone has signed', `<p style="line-height:1.5"><b>${escHtml(rq.title)}</b> has been signed by everyone. Keep a copy for your records.</p>`, 'Download the signed PDF', link, `File: ${escHtml(name)} (signed).pdf`),
          text: `"${rq.title}" has been signed by everyone. Download your copy: ${link}`,
        });
      }
      return json({ ok: true });
    }
    if (sub === 'remind' && method === 'POST') {
      if (rq.status !== 'sent') return fail(409, 'This request is not waiting for signatures.');
      let b = {}; try { b = await request.json(); } catch { /* all */ }
      const results = [];
      for (const s of signers) {
        if (s.status === 'signed' || s.status === 'declined') continue;
        if (b.signerId && b.signerId !== s.id) continue;
        const r = await emailSigner(env, origin, rq, s);
        results.push({ id: s.id, ok: r.ok, error: r.error });
      }
      await logEvent(env, rq.id, me.username, 'Sent a reminder', ipOf(request));
      return json({ results });
    }
    if (sub === 'cancel' && method === 'POST') {
      if (rq.status === 'completed' || rq.status === 'canceled') return fail(409, 'This request can no longer be canceled.');
      await env.DB.prepare('UPDATE esign_requests SET status = ?, canceled_at = ? WHERE id = ?').bind('canceled', Date.now(), rq.id).run();
      await logEvent(env, rq.id, me.username, 'Canceled the request', ipOf(request));
      return json({ ok: true });
    }
  }
  return fail(404, 'Not found.');
}
