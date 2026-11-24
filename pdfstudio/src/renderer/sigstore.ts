// Saved signatures / initials. The master copy lives on the PdfStudio server per signed-in user (D1 table esign_signatures),
// so the same signatures show up on the phone, the web and the desktop app. A copy is kept in this browser/app so the
// list shows instantly and works offline / signed out; changes made offline are sent to the server next time.
// Same idea as contacts.ts.
export type SigKind = 'signature' | 'initials';

export const MAX_SIG_URL = 300 * 1024;   // same limit as the server; bigger pictures stay on this device only
const keyList = (k: SigKind) => (k === 'initials' ? 'pdfstudio.initials' : 'pdfstudio.signatures');   // the old local keys, kept
const keyPend = (k: SigKind) => `pdfstudio.sigPending.${k}`;
const keyDel = (k: SigKind) => `pdfstudio.sigDeleted.${k}`;
const keyDone = (k: SigKind) => `pdfstudio.sigMigrated.${k}`;

const read = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* none */ } };
const syncable = (u: string) => u.startsWith('data:image/png;base64,') && u.length <= MAX_SIG_URL;
const uniq = (l: string[]) => [...new Set(l)];

/** What is saved on this device right now (includes changes not yet sent to the server). */
export function cachedSigs(kind: SigKind): string[] {
  const l = read<unknown>(keyList(kind), []);
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : [];
}

/** Sends pending changes, then fetches the server list. Returns it, or null when offline / not signed in (local copy stays). */
async function sync(kind: SigKind): Promise<string[] | null> {
  const api = window.api;
  if (!api || typeof api.esign !== 'function') return null;   // e.g. the public signing page: no account
  try {
    let pend = read<string[]>(keyPend(kind), []);
    const del = read<string[]>(keyDel(kind), []);
    const first = !read<boolean>(keyDone(kind), false);
    // first time on this device: upload what is already saved here so nobody loses theirs
    if (first) pend = uniq([...pend, ...cachedSigs(kind).filter((u) => !del.includes(u))]);
    pend = pend.filter(syncable);
    if (pend.length) await api.esign('POST', 'signatures', { kind, signatures: pend });
    write(keyPend(kind), []);
    for (const u of del) await api.esign('DELETE', 'signatures', { kind, png: u });
    write(keyDel(kind), []);
    const res = await api.esign('GET', 'signatures');
    const server: string[] = (res.signatures || []).filter((s: any) => s.kind === kind).map((s: any) => s.png);
    // keep device-only pictures (too big for the server) so they are not lost
    const local = cachedSigs(kind).filter((u) => !syncable(u) && !server.includes(u));
    write(keyDone(kind), true);
    const list = [...server, ...local];
    write(keyList(kind), list);
    return list;
  } catch { return null; }
}

export const refreshSigs = (kind: SigKind) => sync(kind);

export async function addSig(kind: SigKind, url: string): Promise<void> {
  write(keyList(kind), [url, ...cachedSigs(kind).filter((x) => x !== url)].slice(0, 100));
  if (syncable(url)) write(keyPend(kind), uniq([...read<string[]>(keyPend(kind), []), url]));
  await sync(kind);
}

export async function removeSig(kind: SigKind, url: string): Promise<void> {
  write(keyList(kind), cachedSigs(kind).filter((x) => x !== url));
  write(keyPend(kind), read<string[]>(keyPend(kind), []).filter((x) => x !== url));
  if (syncable(url)) write(keyDel(kind), uniq([...read<string[]>(keyDel(kind), []), url]));
  await sync(kind);
}
