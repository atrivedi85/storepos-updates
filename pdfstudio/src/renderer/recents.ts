// Phone "Recent files": the last ~20 documents are kept INSIDE this browser/app (IndexedDB), bytes included,
// so they open again without a connection. Nothing here is sent anywhere.
export interface RecentEntry {
  id: string; key: string; name: string; size: number; time: number; starred: boolean;
  source: 'device' | 'cloud' | 'scan' | 'new'; path?: string; thumb?: string;
}
const KEEP = 20;
let dbp: Promise<IDBDatabase> | null = null;
const mem = new Map<string, { meta: RecentEntry; bytes: Uint8Array }>();   // used when IndexedDB is not available
let useMem = false;

function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('pdfstudio-recent', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('meta', { keyPath: 'id' }); r.result.createObjectStore('bytes'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
  return dbp;
}
const wrap = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export async function listRecents(): Promise<RecentEntry[]> {
  let all: RecentEntry[];
  if (useMem) all = [...mem.values()].map((m) => m.meta);
  else {
    try { all = await wrap((await db()).transaction('meta').objectStore('meta').getAll()); }
    catch { useMem = true; return listRecents(); }
  }
  return all.sort((a, b) => b.time - a.time);
}

export async function getBytes(id: string): Promise<Uint8Array | null> {
  if (useMem) return mem.get(id)?.bytes || null;
  try { const b = await wrap((await db()).transaction('bytes').objectStore('bytes').get(id)); return b ? new Uint8Array(b) : null; }
  catch { return null; }
}

export async function putRecent(meta: RecentEntry, bytes?: Uint8Array): Promise<void> {
  if (!useMem) {
    try {
      const d = await db();
      const t = d.transaction(['meta', 'bytes'], 'readwrite');
      t.objectStore('meta').put(meta);
      if (bytes) t.objectStore('bytes').put(bytes.slice().buffer, meta.id);
      await done(t);
      return;
    } catch { useMem = true; }
  }
  const old = mem.get(meta.id);
  mem.set(meta.id, { meta, bytes: bytes || old?.bytes || new Uint8Array() });
}

export async function removeRecent(id: string): Promise<void> {
  if (!useMem) {
    try {
      const t = (await db()).transaction(['meta', 'bytes'], 'readwrite');
      t.objectStore('meta').delete(id); t.objectStore('bytes').delete(id);
      await done(t); return;
    } catch { useMem = true; }
  }
  mem.delete(id);
}

/** Keeps every starred file plus the newest KEEP others. */
export async function trimRecents(): Promise<void> {
  const rest = (await listRecents()).filter((e) => !e.starred);
  for (const e of rest.slice(KEEP)) await removeRecent(e.id);
}

/** Add or refresh a file in the list. Same cloud file / same name = same entry. */
export async function recordRecent(info: { key: string; name: string; source: RecentEntry['source']; path?: string; thumb?: string }, bytes: Uint8Array): Promise<RecentEntry> {
  const all = await listRecents();
  const old = all.find((e) => e.key === info.key);
  const meta: RecentEntry = {
    id: old?.id || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    key: info.key, name: info.name, size: bytes.length, time: Date.now(), starred: old?.starred || false,
    source: info.source, path: info.path, thumb: info.thumb || old?.thumb,
  };
  await putRecent(meta, bytes);
  await trimRecents();
  return meta;
}

// ---- small text helpers for the list ----
export function fmtSize(n: number) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`; }
export function fmtWhen(t: number, now = Date.now()) {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(t), n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
}
