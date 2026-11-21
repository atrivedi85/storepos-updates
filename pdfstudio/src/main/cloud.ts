import { app, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER, currentToken, currentStatus } from './auth';
import {
  cloudClient, cloudPath, conflictName, CloudConflict, CloudError, CloudOffline,
  type CloudEvent, type CloudInfo, type CloudListing,
} from '../shared/cloud';

// Desktop side of the cloud library: talks to the server and keeps an offline cache.
// Edits saved while offline stay in the cache marked "dirty" and are pushed when the PC reconnects.
// The cache lives under the app's user-data folder, one sub-folder per account.

type Entry = CloudInfo & { ver?: number };
interface Manifest { files: Record<string, Entry> }

const client = cloudClient((p, init) =>
  net.fetch(`${SERVER}/api/${p}`, {
    method: init?.method,
    headers: { ...(init?.headers || {}), authorization: `Bearer ${currentToken() || ''}` },
    body: init?.body ? Buffer.from(init.body) : undefined,
    signal: AbortSignal.timeout(90000),
  }));

let emit: (e: CloudEvent) => void = () => {};
export function onCloudEvent(cb: (e: CloudEvent) => void) { emit = cb; }

function userDir(): string {
  const u = currentStatus().username;
  if (!u) throw new Error('Please sign in to PdfStudio.');
  const d = path.join(app.getPath('userData'), 'cloud', u.replace(/[^a-z0-9._-]/gi, '_'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const dataFile = (id: string) => path.join(userDir(), `${id}.pdf`);
const manifestFile = () => path.join(userDir(), 'manifest.json');
function load(): Manifest {
  try { return JSON.parse(fs.readFileSync(manifestFile(), 'utf8')); } catch { return { files: {} }; }
}
function save(m: Manifest) { fs.writeFileSync(manifestFile(), JSON.stringify(m)); }
const pendingCount = (m: Manifest) => Object.values(m.files).filter((e) => e.dirty).length;
const rm = (p: string) => { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } };
const offlineMsg = (what: string) => `You need an internet connection to ${what}.`;

export async function list(): Promise<CloudListing> {
  const m = load();
  try {
    const l = await client.list();
    const seen = new Set<string>();
    for (const f of l.files) {
      seen.add(f.id);
      const e = m.files[f.id];
      if (!e) { m.files[f.id] = { ...f, cached: false }; continue; }
      if (e.dirty) { e.name = f.name; continue; }       // keep our base revision for the pending upload
      if (e.rev !== f.rev) { e.cached = false; rm(dataFile(f.id)); }
      Object.assign(e, f);
    }
    for (const id of Object.keys(m.files)) {
      if (!seen.has(id) && !m.files[id].dirty) { rm(dataFile(id)); delete m.files[id]; }
    }
    save(m);
    return { files: Object.values(m.files), used: l.used, quota: l.quota, offline: false };
  } catch (e) {
    if (!(e instanceof CloudOffline)) throw e;
    return { files: Object.values(m.files), used: 0, quota: 0, offline: true };
  }
}

export async function read(id: string): Promise<Uint8Array> {
  let m = load();
  if (m.files[id]?.dirty) { await push(id); m = load(); }
  const e = m.files[id];
  const p = dataFile(id);
  if (e?.dirty && fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));   // still unsynced: local edits win
  try {
    const r = await client.get(id, e?.cached && fs.existsSync(p) ? e.rev : undefined);
    if (r.notModified) return new Uint8Array(fs.readFileSync(p));
    fs.writeFileSync(p, r.bytes);
    m.files[id] = { ...(e || { id, updatedAt: Date.now() }), id, name: r.name || e?.name || 'Document.pdf', rev: r.rev, size: r.bytes.length, cached: true, dirty: false };
    save(m);
    return r.bytes;
  } catch (x) {
    if (x instanceof CloudOffline) {
      if (e?.cached && fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));
      throw new Error('This file is not available offline. Connect to the internet to open it.');
    }
    throw x;
  }
}

export async function write(id: string, data: Uint8Array): Promise<void> {
  const m = load();
  const e = m.files[id];
  if (!e) throw new Error('This cloud file is no longer in your library. Use Save to cloud to store it again.');
  fs.writeFileSync(dataFile(id), data);
  e.dirty = true; e.cached = true; e.size = data.length; e.ver = (e.ver || 0) + 1;
  save(m);
  emit({ type: 'pending', pending: pendingCount(m) });
  const ok = await push(id);
  if (!ok) emit({ type: 'info', message: 'Saved on this PC. It will upload to the cloud when you are back online.', pending: pendingCount(load()) });
}

const running = new Map<string, Promise<boolean>>();
export function push(id: string): Promise<boolean> {
  const cur = running.get(id);
  if (cur) return cur;
  const p = pushNow(id).finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

async function pushNow(id: string): Promise<boolean> {
  for (;;) {
    const m = load();
    const e = m.files[id];
    if (!e?.dirty) return true;
    const ver = e.ver || 0;
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(fs.readFileSync(dataFile(id))); } catch { e.dirty = false; save(m); return true; }
    try {
      const r = await client.update(id, e.rev, bytes);
      const m2 = load();
      const e2 = m2.files[id];
      if (e2) { Object.assign(e2, r); if ((e2.ver || 0) === ver) e2.dirty = false; save(m2); if (!e2.dirty) { emit({ type: 'pending', pending: pendingCount(m2) }); return true; } }
      else return true;
      // edited again while uploading: go around and upload the newer version
    } catch (x) {
      if (x instanceof CloudOffline) return false;
      const gone = x instanceof CloudError && x.status === 404;
      if (x instanceof CloudConflict || gone) {
        try {
          const copy = await client.create(gone ? e.name : conflictName(e.name), bytes);
          const m2 = load();
          if (gone) delete m2.files[id];
          else {
            const e2 = m2.files[id];
            const theirs = x instanceof CloudConflict ? x.current : null;
            e2.dirty = false; e2.cached = false;
            if (theirs) Object.assign(e2, theirs);
            rm(dataFile(id));
          }
          m2.files[copy.id] = { ...copy, cached: true };
          fs.writeFileSync(dataFile(copy.id), bytes);
          save(m2);
          emit({ type: 'info', message: gone
            ? `"${e.name}" was deleted from another device, so your version was saved again as "${copy.name}".`
            : `"${e.name}" was changed on another device, so your edits were saved as "${copy.name}" in My files.`, pending: pendingCount(m2) });
          return true;
        } catch (y) {
          if (y instanceof CloudOffline) return false;
          throw y;
        }
      }
      emit({ type: 'error', message: `Cloud upload failed: ${(x as Error).message}` });
      return false;
    }
  }
}

export async function syncAll(): Promise<void> {
  if (!currentStatus().signedIn) return;
  let m: Manifest;
  try { m = load(); } catch { return; }
  for (const id of Object.keys(m.files)) if (m.files[id].dirty) { try { await push(id); } catch { /* retried next round */ } }
  emit({ type: 'pending', pending: pendingCount(load()) });
}
export function startSync() {
  setTimeout(syncAll, 6000);
  setInterval(syncAll, 5 * 60 * 1000);
}

export async function create(name: string, data: Uint8Array): Promise<string> {
  try {
    const f = await client.create(name, data);
    const m = load();
    fs.writeFileSync(dataFile(f.id), data);
    m.files[f.id] = { ...f, cached: true };
    save(m);
    return cloudPath(f.id, f.name);
  } catch (e) {
    if (e instanceof CloudOffline) throw new Error(offlineMsg('add a file to the cloud'));
    throw e;
  }
}
export async function rename(id: string, name: string): Promise<void> {
  try {
    const f = await client.rename(id, name);
    const m = load();
    if (m.files[id]) { m.files[id].name = f.name; save(m); }
  } catch (e) { if (e instanceof CloudOffline) throw new Error(offlineMsg('rename a file')); throw e; }
}
export async function remove(id: string): Promise<void> {
  try {
    await client.remove(id);
    const m = load();
    delete m.files[id]; rm(dataFile(id)); save(m);
  } catch (e) { if (e instanceof CloudOffline) throw new Error(offlineMsg('delete a file')); throw e; }
}
