// "My files" panel: the signed-in user's cloud library (shared between the web app and the desktop app).
import { baseName, el, esc, modal, prompt, toast } from './util';
import type { Api } from '../main/preload';

type Listing = Awaited<ReturnType<Api['cloudList']>>;

export interface CloudHost {
  api: Api;
  openPaths(paths: string[]): Promise<void>;
  hasActive(): boolean;
  saveActive(): Promise<void>;
}

const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const fmtDate = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const cleanErr = (e: any) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export async function openCloudPanel(h: CloudHost): Promise<void> {
  for (;;) {
    const action = await panelOnce(h);
    if (action === 'upload') await upload(h);
    else if (action === 'saveHere') await h.saveActive();
    else if (action.startsWith('open:')) { await h.openPaths([action.slice(5)]); return; }
    else return;
  }
}

async function upload(h: CloudHost) {
  try {
    const paths = await h.api.openDialog(true);
    let n = 0;
    for (const p of paths) {
      await h.api.cloudCreate(baseName(p), await h.api.readFile(p));
      n++;
    }
    if (n) toast(n === 1 ? 'Uploaded to your cloud files' : `Uploaded ${n} files to your cloud files`);
  } catch (e) { toast(`Upload failed: ${cleanErr(e)}`, true); }
}

function panelOnce(h: CloudHost): Promise<string> {
  const body = el('div', 'cloud-panel');
  const info = el('div', 'cloud-info');
  const list = el('div', 'cloud-list');
  body.append(info, list);
  let closeWith: (v: string) => void = () => {};

  const render = async () => {
    list.replaceChildren(el('div', 'hint', {}, 'Loading…'));
    let l: Listing;
    try { l = await h.api.cloudList(); }
    catch (e) { list.replaceChildren(el('div', 'hint', {}, esc(`Could not load your files: ${cleanErr(e)}`))); return; }
    info.textContent = l.offline
      ? 'Offline - showing files saved on this computer.'
      : `${fmtSize(l.used)} of ${fmtSize(l.quota)} used`;
    list.replaceChildren();
    if (!l.files.length) { list.append(el('div', 'hint', {}, 'No files yet. Use "Save current here" or "Upload PDF" below.')); return; }
    for (const f of l.files) {
      const unavailable = l.offline && !f.cached;
      const sub = [fmtSize(f.size), fmtDate(f.updatedAt), f.dirty ? 'waiting to sync' : '', unavailable ? 'not available offline' : ''].filter(Boolean).join(' · ');
      const row = el('div', 'cloud-row', {}, `<div class="cloud-name"><b>${esc(f.name)}</b><small>${esc(sub)}</small></div>`);
      const btns = el('div', 'cloud-btns');
      const open = el('button', 'btn', {}, 'Open');
      open.disabled = unavailable;
      open.onclick = () => closeWith(`open:cloud://${f.id}/${f.name}`);
      const ren = el('button', 'btn', {}, 'Rename');
      ren.disabled = l.offline;
      ren.onclick = async () => {
        const n = await prompt('Rename file', 'Name', f.name);
        if (!n || n === f.name) return;
        try { await h.api.cloudRename(f.id, n); } catch (e) { toast(cleanErr(e), true); }
        render();
      };
      const del = el('button', 'btn danger', {}, 'Delete');
      del.disabled = l.offline;
      del.onclick = async () => {
        const r = await modal('Delete file', `Delete <b>${esc(f.name)}</b> from your cloud files? This cannot be undone.`,
          [{ label: 'Cancel', value: 'cancel' }, { label: 'Delete', kind: 'danger', value: 'delete' }]);
        if (r !== 'delete') return;
        try { await h.api.cloudDelete(f.id); } catch (e) { toast(cleanErr(e), true); }
        render();
      };
      btns.append(open, ren, del);
      row.append(btns);
      list.append(row);
    }
  };

  const p = modal('My files (cloud)', body, [
    { label: 'Upload PDF…', value: 'upload' },
    ...(h.hasActive() ? [{ label: 'Save current here', value: 'saveHere' }] : []),
    { label: 'Close', kind: 'primary' as const, value: 'close' },
  ]);
  closeWith = (v) => (body.closest('.modal') as any)?._done?.(v);
  render();
  return p;
}
