import { app, net, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { authFor } from '../shared/ledgerAuth';

// Account sign-in against the PdfStudio server. Replaces activation keys.
// The session token is stored encrypted with the Windows account (Electron safeStorage / DPAPI).
// Offline use is allowed for OFFLINE_DAYS after the last time the server confirmed the session.

export const SERVER = (process.env.PDFSTUDIO_SERVER || 'https://trivedipos.com/pdfstudio').replace(/\/$/, '');
const OFFLINE_DAYS = 30;
const DAY = 86400000;
const REVALIDATE_MS = 60 * 60 * 1000;

export interface AuthStatus {
  signedIn: boolean;
  username?: string;
  email?: string;
  role?: string;
  offline?: boolean;      // true when running on the offline grace period
  daysLeft?: number;      // days of offline use left (only when offline)
  error?: string;
}
interface Session { token: string; username: string; email: string; role: string; lastOnline: number }

const file = () => path.join(app.getPath('userData'), 'session.bin');
let cache: Session | null | undefined;
let offline = false;
let listener: ((s: AuthStatus) => void) | null = null;

function load(): Session | null {
  if (cache !== undefined) return cache;
  try {
    if (!safeStorage.isEncryptionAvailable()) { cache = null; return null; }
    cache = JSON.parse(safeStorage.decryptString(fs.readFileSync(file())));
  } catch { cache = null; }
  return cache!;
}
function save(s: Session | null) {
  cache = s;
  try {
    if (!s) { fs.rmSync(file(), { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this PC.');
    fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify(s)));
  } catch (e) { if (s) throw e; }
}

export function currentStatus(): AuthStatus {
  const s = load();
  if (!s) return { signedIn: false };
  const now = Date.now();
  // A clock set back past the last confirmed time would stretch the offline window; treat as expired.
  const age = now - s.lastOnline;
  if (age < -DAY || age > OFFLINE_DAYS * DAY) {
    return { signedIn: false, error: 'Please connect to the internet and sign in again.' };
  }
  const st: AuthStatus = { signedIn: true, username: s.username, email: s.email, role: s.role };
  if (offline) { st.offline = true; st.daysLeft = Math.max(0, Math.ceil(OFFLINE_DAYS - age / DAY)); }
  return st;
}

export function currentToken(): string | null { return currentStatus().signedIn ? load()?.token || null : null; }

export function onAuthChange(cb: (s: AuthStatus) => void) { listener = cb; }
const notify = () => listener?.(currentStatus());

async function call(pathname: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const r = await net.fetch(`${SERVER}/api/${pathname}`, {
    method: init.method || 'GET', headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const j: any = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data: j };
}

// Two-step sign-in (only for people who turned it on in Ledger Desk): the server asks for a 6-digit code.
export interface LoginResult extends AuthStatus { need2fa?: string; ticket?: string; to?: string; canEmail?: boolean }

async function finishLogin(r: { ok: boolean; data: any }): Promise<LoginResult> {
  if (!r.ok) return { signedIn: false, error: r.data.error || 'Sign-in failed.' };
  if (r.data.need2fa) return { signedIn: false, need2fa: r.data.need2fa, ticket: r.data.ticket, to: r.data.to, canEmail: r.data.canEmail };
  save({ token: r.data.token, username: r.data.user.username, email: r.data.user.email, role: r.data.user.role, lastOnline: Date.now() });
  offline = false;
  return currentStatus();
}
const netError = (e: any): LoginResult => ({ signedIn: false, error: /Secure storage/.test(String(e?.message)) ? e.message : 'Could not reach the PdfStudio server. Check your internet connection.' });

// PdfStudio signs in with the Ledger Desk account. Like Ledger Desk itself, we send a value derived from
// the password (authFor), never the password.
export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    if (!(globalThis as any).crypto?.subtle) (globalThis as any).crypto = webcrypto;
    if (username.includes('@')) { try { const q = await call('login/resolve', { method: 'POST', body: { id: username } }); if (q.ok && q.data.username) username = q.data.username; } catch { /* sign-in below reports the problem */ } }
    const auth = await authFor(username, password);
    return await finishLogin(await call('login', { method: 'POST', body: { username, auth } }));
  } catch (e: any) { return netError(e); }
}

export async function login2fa(ticket: string, code: string): Promise<LoginResult> {
  try { return await finishLogin(await call('login/2fa', { method: 'POST', body: { ticket, code } })); }
  catch (e: any) { return netError(e); }
}

export async function login2faEmail(ticket: string): Promise<{ ok: boolean; to?: string; error?: string }> {
  try {
    const r = await call('login/2fa/email', { method: 'POST', body: { ticket } });
    return r.ok ? { ok: true, to: r.data.to } : { ok: false, error: r.data.error || 'Could not send a code.' };
  } catch { return { ok: false, error: 'Could not reach the PdfStudio server.' }; }
}

export async function logout(): Promise<void> {
  const s = load();
  save(null);
  offline = false;
  if (s) { try { await call('logout', { method: 'POST', token: s.token }); } catch { /* offline: server session simply expires */ } }
  notify();
}

// Asks the server whether the session is still valid. Network trouble keeps the offline grace period;
// an explicit rejection (account disabled/deleted, signed out elsewhere) signs the user out at once.
export async function revalidate(): Promise<void> {
  const s = load();
  if (!s) return;
  try {
    const r = await call('me', { token: s.token });
    if (r.status === 401 || r.status === 403) { save(null); offline = false; notify(); return; }
    if (r.ok) {
      save({ ...s, username: r.data.user.username, email: r.data.user.email, role: r.data.user.role, lastOnline: Date.now() });
      const was = offline; offline = false;
      if (was) notify();
    }
  } catch {
    if (!offline) { offline = true; notify(); }
  }
  // Grace period may have just run out.
  if (!currentStatus().signedIn) notify();
}

export function startRevalidating() {
  revalidate();
  setInterval(revalidate, REVALIDATE_MS);
}
