// Browser implementation of window.api (the Electron preload bridge), so the same editor runs on the web.
// Files come from the browser's file picker (File System Access API where available, plain <input>/download elsewhere).
import type { Api, AuthStatus } from '../main/preload';
import { authFor } from '../shared/ledgerAuth';
import {
  cloudClient, cloudPath, conflictName, parseCloudPath,
  CloudConflict, CloudError, CloudOffline, type CloudEvent,
} from '../shared/cloud';
import { esignClient } from '../shared/esign';
import { androidSave, isAndroid } from '../renderer/native';

const SERVER = '/pdfstudio';
const PDF_TYPES = [{ description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } }];

type Entry = { name: string; file?: File; handle?: any };
const entries = new Map<string, Entry>();
const dirs = new Map<string, any>();
let seq = 0;
const register = (e: Entry) => { const id = `web://${++seq}/${e.name}`; entries.set(id, e); return id; };

const isAbort = (e: any) => e && (e.name === 'AbortError' || e.name === 'NotAllowedError');
const w = window as any;

function download(name: string, data: Uint8Array | Blob, type = 'application/pdf') {
  if (!(data instanceof Blob) && androidSave(name, data)) return;   // Android app: native Save dialog
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.onchange = () => resolve([...(inp.files || [])]);
    inp.oncancel = () => resolve([]);
    inp.click();
  });
}

async function writeHandle(handle: any, data: Uint8Array) {
  const ws = await handle.createWritable();
  await ws.write(data as BlobPart);
  await ws.close();
}

// ---- cloud library (same server API as the desktop app; the browser has no offline cache) ----
const esignApi = esignClient((p, init) => fetch(`${SERVER}/api/${p}`, init as RequestInit));
const client = cloudClient((p, init) => fetch(`${SERVER}/api/${p}`, init as RequestInit));
const revs = new Map<string, { rev: number; name: string }>();
let cloudCb: ((e: CloudEvent) => void) | null = null;
const needOnline = (what: string) => new Error(`You need an internet connection to ${what}.`);

async function cloudRead(id: string): Promise<Uint8Array> {
  const r = await client.get(id);
  if (r.notModified) throw new Error('Unexpected server reply.');
  revs.set(id, { rev: r.rev, name: r.name });
  return r.bytes;
}
async function cloudWrite(id: string, d: Uint8Array): Promise<void> {
  const cur = revs.get(id);
  if (!cur) throw new Error('Open this file from My files first, then save.');
  try {
    const f = await client.update(id, cur.rev, d);
    revs.set(id, { rev: f.rev, name: f.name });
  } catch (x) {
    if (x instanceof CloudOffline) throw needOnline('save to the cloud');
    const gone = x instanceof CloudError && x.status === 404;
    if (x instanceof CloudConflict || gone) {
      const copy = await client.create(gone ? cur.name : conflictName(cur.name), d);
      cloudCb?.({ type: 'info', message: gone
        ? `"${cur.name}" was deleted from another device, so your version was saved again as "${copy.name}".`
        : `"${cur.name}" was changed on another device, so your edits were saved as "${copy.name}" in My files.` });
      return;
    }
    throw x;
  }
}

// ---- account (cookie session served by the Worker) ----
let authCb: ((s: AuthStatus) => void) | null = null;
const post = (p: string, body?: unknown) => fetch(`${SERVER}/api/${p}`, {
  method: 'POST', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
});
const toStatus = (u: any): AuthStatus => ({ signedIn: true, username: u.username, email: u.email, role: u.role });
async function loginResult(r: Response): Promise<any> {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { signedIn: false, error: j.error || 'Sign-in failed.' };
  if (j.need2fa) return { signedIn: false, need2fa: j.need2fa, ticket: j.ticket, to: j.to, canEmail: j.canEmail };
  return toStatus(j.user);
}

async function authStatus(): Promise<AuthStatus> {
  try {
    const r = await fetch(`${SERVER}/api/me`);
    if (r.ok) return toStatus((await r.json()).user);
    return { signedIn: false };
  } catch { return { signedIn: false, error: 'Cannot reach the PdfStudio server.' }; }
}
// A rejected session (account disabled, signed out elsewhere) locks the editor; network trouble does not.
setInterval(async () => {
  try {
    const r = await fetch(`${SERVER}/api/me`);
    if (r.status === 401 || r.status === 403) authCb?.({ signedIn: false, error: 'Your session has ended. Sign in to continue.' });
  } catch { /* offline: keep working */ }
}, 10 * 60 * 1000);

// Same shape as the Electron bridge; the on*() subscribers just return nothing in the browser.
const api: { [K in keyof Api]: (...a: Parameters<Api[K]>) => any } = {
  checkUpdates: async () => {},
  installUpdate: async () => {},
  onUpdate: () => {},
  authStatus,
  login: async (username, password) => {
    try {
      if (username.includes('@')) { try { const q = await (await post('login/resolve', { id: username })).json(); if (q.username) username = q.username; } catch { /* sign-in below reports the problem */ } }
      const r = await post('login', { username, auth: await authFor(username, password) });
      return await loginResult(r);
    } catch { return { signedIn: false, error: 'Cannot reach the PdfStudio server.' }; }
  },
  login2fa: async (ticket, code) => {
    try { return await loginResult(await post('login/2fa', { ticket, code })); }
    catch { return { signedIn: false, error: 'Cannot reach the PdfStudio server.' }; }
  },
  login2faEmail: async (ticket) => {
    try {
      const r = await post('login/2fa/email', { ticket }); const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, to: j.to } : { ok: false, error: j.error || 'Could not send a code.' };
    } catch { return { ok: false, error: 'Cannot reach the PdfStudio server.' }; }
  },
  logout: async () => {
    try { await post('logout'); } catch { /* ignore */ }
    authCb?.({ signedIn: false });
  },
  onAuthChanged: (cb) => { authCb = cb; },
  initFiles: async () => [],
  esign: (method: string, path: string, body?: unknown) => esignApi.json(method, path, body),
  esignBytes: (path: string) => esignApi.bytes(path),
  esignCreate: (meta: unknown, pdf: Uint8Array) => esignApi.create(meta, pdf),
  esignPutFinal: (id: string, pdf: Uint8Array) => esignApi.putFinal(id, pdf),
  cloudList: async () => {
    try { const l = await client.list(); return { ...l, offline: false }; }
    catch (x) { if (x instanceof CloudOffline) return { files: [], used: 0, quota: 0, offline: true }; throw x; }
  },
  cloudCreate: async (name, bytes) => {
    try { const f = await client.create(name, bytes); revs.set(f.id, { rev: f.rev, name: f.name }); return cloudPath(f.id, f.name); }
    catch (x) { if (x instanceof CloudOffline) throw needOnline('add a file to the cloud'); throw x; }
  },
  cloudRename: async (id, name) => {
    try { await client.rename(id, name); } catch (x) { if (x instanceof CloudOffline) throw needOnline('rename a file'); throw x; }
  },
  cloudDelete: async (id) => {
    try { await client.remove(id); } catch (x) { if (x instanceof CloudOffline) throw needOnline('delete a file'); throw x; }
  },
  onCloudEvent: (cb) => { cloudCb = cb; },
  readFile: async (p) => {
    const cid = parseCloudPath(p);
    if (cid) return cloudRead(cid);
    const e = entries.get(p);
    if (!e) throw new Error('File is no longer available. Open it again.');
    const f: File = e.handle ? await e.handle.getFile() : e.file!;
    return new Uint8Array(await f.arrayBuffer());
  },
  writeFile: async (p, d) => {
    const cid = parseCloudPath(p);
    if (cid) { await cloudWrite(cid, d); return true; }
    const e = entries.get(p);
    if (e?.handle) await writeHandle(e.handle, d);
    else download(e?.name || p.split('/').pop() || 'document.pdf', d);
    return true;
  },
  openDialog: async (multi = false) => {
    if (w.showOpenFilePicker && !isAndroid()) {
      try {
        const hs = await w.showOpenFilePicker({ multiple: multi, types: PDF_TYPES });
        return hs.map((h: any) => register({ name: h.name, handle: h }));
      } catch (e) { if (isAbort(e)) return []; throw e; }
    }
    return (await pickFiles('.pdf,application/pdf', multi)).map((f) => register({ name: f.name, file: f }));
  },
  saveDialog: async (name) => {
    if (w.showSaveFilePicker && !isAndroid()) {
      try {
        const h = await w.showSaveFilePicker({ suggestedName: name, types: PDF_TYPES });
        return register({ name: h.name, handle: h });
      } catch (e) { if (isAbort(e)) return null; throw e; }
    }
    return register({ name }); // browsers without the picker: Save downloads a copy
  },
  imageDialog: async () => {
    const [f] = await pickFiles('image/png,image/jpeg,image/gif,image/bmp,image/webp', false);
    return f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
  },
  folderDialog: async () => {
    if (w.showDirectoryPicker) {
      try {
        const d = await w.showDirectoryPicker({ mode: 'readwrite' });
        const id = `webdir://${++seq}/${d.name}`;
        dirs.set(id, d);
        return id;
      } catch (e) { if (isAbort(e)) return null; throw e; }
    }
    return 'webdir://downloads';
  },
  writeMany: async (folder, files) => {
    const d = dirs.get(folder);
    for (const f of files) {
      if (d) await writeHandle(await d.getFileHandle(f.name, { create: true }), f.data);
      else { download(f.name, f.data); await new Promise((r) => setTimeout(r, 250)); }
    }
    return files.length;
  },
  getRecent: async () => [],
  clearRecent: async () => true,
  reveal: async () => {},
  confirmClose: async () => { w.__allowUnload = true; window.close(); },
  setTitle: async (t) => { document.title = t; },
  version: async () => {
    try { return String((await (await fetch('version.json')).json()).version); } catch { return 'web'; }
  },
  onCloseRequest: () => {},
  onOpenFiles: () => {},
  pathForFile: (f) => register({ name: f.name, file: f }),
};

// Warn before leaving the tab with unsaved edits (the desktop app does this in its close handler).
window.addEventListener('beforeunload', (e) => {
  if (!w.__allowUnload && w.app?.tabs?.some((t: any) => t.dirty)) { e.preventDefault(); e.returnValue = ''; }
});

// The auto-update buttons make no sense in a browser.
document.documentElement.classList.add('web');
const st = document.createElement('style');
st.textContent = 'html.web #stUpdate, html.web #tbUpdate, html.web #updDot { display: none !important; }';
document.head.appendChild(st);

w.api = api;
