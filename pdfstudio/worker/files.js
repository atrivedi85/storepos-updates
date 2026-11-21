// Per-user cloud PDF library. Mounted by api.js for /pdfstudio/api/files...
// Bytes live in the private R2 bucket (binding FILES, NOT the public downloads bucket); metadata lives in D1.
// Every query is scoped to the signed-in user's id, so one user can never see or touch another's files.
const MAX_FILE = 50 * 1024 * 1024;          // 50 MB per PDF
const QUOTA = 500 * 1024 * 1024;            // 500 MB per user
const MAX_FILES = 500;

const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
const meta = (r) => ({ id: r.id, name: r.name, size: r.size, rev: r.rev, updatedAt: r.updated_at });
const objKey = (userId, id, rev) => `u/${userId}/${id}/${rev}`;

function cleanName(raw) {
  let n = String(raw || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().replace(/^\.+/, '');
  if (!n) n = 'Untitled';
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  return n.length > 120 ? n.slice(0, 116) + '.pdf' : n;
}
async function uniqueName(env, userId, name, exceptId = '') {
  const base = name.replace(/\.pdf$/i, '');
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${base} (${i}).pdf`;
    const hit = await env.DB.prepare('SELECT 1 AS x FROM files WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?').bind(userId, candidate, exceptId).first();
    if (!hit) return candidate;
  }
  return `${base}-${rand(3)}.pdf`;
}
function looksLikePdf(buf) {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  return head.includes('%PDF-');
}
async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_FILE) return { error: fail(413, 'That file is larger than the 50 MB limit.') };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_FILE) return { error: fail(413, 'That file is larger than the 50 MB limit.') };
  if (buf.byteLength < 8 || !looksLikePdf(buf)) return { error: fail(400, 'Only PDF files can be stored.') };
  return { buf };
}
async function usedBytes(env, userId, exceptId = '') {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS n FROM files WHERE user_id = ? AND id != ?').bind(userId, exceptId).first();
  return r.n;
}

export async function handleFiles(request, env, url, user, route) {
  const method = request.method;
  const m = route.match(/^files(?:\/([a-f0-9]{16}))?$/);
  if (!m) return fail(404, 'Not found.');
  const id = m[1];

  // list
  if (!id && method === 'GET') {
    const r = await env.DB.prepare('SELECT id, name, size, rev, updated_at FROM files WHERE user_id = ? ORDER BY updated_at DESC').bind(user.id).all();
    return json({ files: r.results.map(meta), used: await usedBytes(env, user.id), quota: QUOTA, maxFile: MAX_FILE });
  }

  // create
  if (!id && method === 'POST') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id = ?').bind(user.id).first();
    if (count.n >= MAX_FILES) return fail(403, `You can store up to ${MAX_FILES} files.`);
    const body = await readBody(request);
    if (body.error) return body.error;
    if ((await usedBytes(env, user.id)) + body.buf.byteLength > QUOTA) return fail(413, 'Not enough cloud storage left. Delete some files first.');
    const fid = rand(8);
    const name = await uniqueName(env, user.id, cleanName(url.searchParams.get('name')));
    const now = Date.now();
    await env.FILES.put(objKey(user.id, fid, 1), body.buf, { httpMetadata: { contentType: 'application/pdf' } });
    try {
      await env.DB.prepare('INSERT INTO files (id, user_id, name, size, rev, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind(fid, user.id, name, body.buf.byteLength, 1, now, now).run();
    } catch (e) {
      await env.FILES.delete(objKey(user.id, fid, 1));
      throw e;
    }
    return json(meta({ id: fid, name, size: body.buf.byteLength, rev: 1, updated_at: now }), 201);
  }

  if (!id) return fail(405, 'Method not allowed.');
  const row = await env.DB.prepare('SELECT id, name, size, rev, updated_at FROM files WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!row) return fail(404, 'File not found.');

  // download
  if (method === 'GET') {
    const etag = `"${row.rev}"`;
    const inm = (request.headers.get('if-none-match') || '').replace(/^W\//, '').replace(/"/g, '');
    if (inm === String(row.rev)) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'private, no-cache' } });
    const obj = await env.FILES.get(objKey(user.id, id, row.rev));
    if (!obj) return fail(404, 'File data is missing.');
    return new Response(obj.body, { headers: {
      'content-type': 'application/pdf', etag, 'cache-control': 'private, no-cache',
      'x-pdfs-rev': String(row.rev), 'x-pdfs-name': encodeURIComponent(row.name),
      'x-content-type-options': 'nosniff', 'content-disposition': 'attachment',
    } });
  }

  // overwrite (optimistic concurrency: caller must say which revision it started from)
  if (method === 'PUT') {
    const ifMatch = Number((request.headers.get('if-match') || '').replace(/"/g, ''));
    if (!ifMatch) return fail(428, 'If-Match revision is required.');
    if (ifMatch !== row.rev) return fail(409, 'This file was changed somewhere else.', { current: meta(row) });
    const body = await readBody(request);
    if (body.error) return body.error;
    if ((await usedBytes(env, user.id, id)) + body.buf.byteLength > QUOTA) return fail(413, 'Not enough cloud storage left. Delete some files first.');
    const next = row.rev + 1;
    await env.FILES.put(objKey(user.id, id, next), body.buf, { httpMetadata: { contentType: 'application/pdf' } });
    const now = Date.now();
    const res = await env.DB.prepare('UPDATE files SET size = ?, rev = ?, updated_at = ? WHERE id = ? AND user_id = ? AND rev = ?')
      .bind(body.buf.byteLength, next, now, id, user.id, row.rev).run();
    if (!res.meta.changes) {                      // lost a race with another writer
      await env.FILES.delete(objKey(user.id, id, next));
      const cur = await env.DB.prepare('SELECT id, name, size, rev, updated_at FROM files WHERE id = ? AND user_id = ?').bind(id, user.id).first();
      return fail(409, 'This file was changed somewhere else.', { current: cur ? meta(cur) : null });
    }
    await env.FILES.delete(objKey(user.id, id, row.rev));
    return json(meta({ id, name: row.name, size: body.buf.byteLength, rev: next, updated_at: now }));
  }

  // rename
  if (method === 'PATCH') {
    let b = {};
    try { b = await request.json(); } catch { /* empty */ }
    const name = await uniqueName(env, user.id, cleanName(b.name), id);
    const now = Date.now();
    await env.DB.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(name, now, id, user.id).run();
    return json(meta({ ...row, name, updated_at: now }));
  }

  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    await env.FILES.delete(objKey(user.id, id, row.rev));
    return json({ ok: true });
  }

  return fail(405, 'Method not allowed.');
}

// Removes everything a user stored (called when an admin deletes the account).
export async function purgeUserFiles(env, userId) {
  let cursor;
  do {
    const l = await env.FILES.list({ prefix: `u/${userId}/`, cursor });
    if (l.objects.length) await env.FILES.delete(l.objects.map((o) => o.key));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  await env.DB.prepare('DELETE FROM files WHERE user_id = ?').bind(userId).run();
}
