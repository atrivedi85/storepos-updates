// Ledger Desk never receives a password. Its sign-in sends this derived value instead
// (same algorithm as vault.js `authFor` in Ledger Desk). PdfStudio signs in with Ledger Desk,
// so it must derive exactly the same value. Works in browsers and in Node/Electron (WebCrypto).
const AUTH_ITER = 200000;

export async function authFor(username: string, password: string): Promise<string> {
  const te = new TextEncoder();
  const subtle: SubtleCrypto = (globalThis as any).crypto?.subtle;
  if (!subtle) throw new Error('This device cannot sign in securely (no WebCrypto).');
  const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('ledgerdesk-auth|' + String(username).trim().toLowerCase()), iterations: AUTH_ITER },
    base, 256,
  );
  let s = '';
  for (const b of new Uint8Array(bits)) s += String.fromCharCode(b);
  return btoa(s);
}
