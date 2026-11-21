// Ledger Desk is the account system for PdfStudio. This talks to Ledger Desk's own sign-in API
// (trivedipos.com/api/*, served by the storepos-sync Worker). Passwords never reach us: the browser
// sends only the derived "auth" value Ledger Desk itself uses (see src/shared/ledgerAuth.ts).
const enc = new TextEncoder();
const dec = new TextDecoder();

export const ledgerBase = (env) => String(env.LEDGER_URL || 'https://trivedipos.com').replace(/\/$/, '');

// Returns { status, data, cookies } - never throws; status 0 means Ledger Desk could not be reached.
export async function ledgerCall(env, path, { method = 'POST', body, token } = {}) {
  const headers = { 'x-ld': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.cookie = `ld_s=${token}`;
  try {
    const r = await fetch(ledgerBase(env) + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    return { status: r.status, data, cookies };
  } catch {
    return { status: 0, data: {}, cookies: [] };
  }
}

export const ledgerTokenFrom = (cookies) => {
  for (const c of cookies || []) { const m = /(?:^|\s)ld_s=([a-f0-9]{64})/.exec(c); if (m) return m[1]; }
  return null;
};
export const ledgerTokenFromRequest = (request) => {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)ld_s=([a-f0-9]{64})/);
  return m ? m[1] : null;
};

// The Ledger Desk session token is kept (encrypted) so we can re-check the account now and then.
async function aesKey(env) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set');
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('pdfstudio-ledger|' + env.SESSION_SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function sealToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(token)));
  return b64(iv) + '.' + b64(ct);
}
export async function openToken(env, sealed) {
  try {
    const [iv, ct] = String(sealed).split('.');
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct)));
  } catch { return null; }
}
