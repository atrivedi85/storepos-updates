import { androidSave } from './native';
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, attrs?: Record<string, string>, html?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (html !== undefined) e.innerHTML = html;
  return e;
}
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

let _id = 0;
export const uid = (p = 'o') => `${p}${Date.now().toString(36)}${(_id++).toString(36)}`;

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function baseName(p: string) { return p.split(/[\\/]/).pop() || p; }
export function dirName(p: string) { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i >= 0 ? p.slice(0, i) : ''; }

export function toast(msg: string, err = false) {
  const t = el('div', 'toast' + (err ? ' err' : ''));
  t.textContent = msg;
  document.getElementById('toasts')!.appendChild(t);
  setTimeout(() => t.remove(), err ? 5000 : 2600);
}

export function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function download(bytes: Uint8Array, name: string) {
  if (androidSave(name, bytes)) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart]));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- modal / menu helpers ----------
export interface ModalBtn { label: string; kind?: 'primary' | 'danger' | ''; value: string }

export function modal(title: string, body: HTMLElement | string, buttons: ModalBtn[]): Promise<string> {
  return new Promise((resolve) => {
    const bg = el('div', 'modal-bg');
    const m = el('div', 'modal');
    m.appendChild(el('h2', '', {}, esc(title)));
    const b = el('div', 'body');
    if (typeof body === 'string') b.innerHTML = body; else b.appendChild(body);
    m.appendChild(b);
    const f = el('div', 'footer');
    const done = (v: string) => { bg.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    for (const bt of buttons) {
      const x = el('button', 'btn ' + (bt.kind || ''), {}, esc(bt.label));
      x.onclick = () => done(bt.value);
      f.appendChild(x);
    }
    m.appendChild(f); bg.appendChild(m);
    document.getElementById('modal-root')!.appendChild(bg);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); done('cancel'); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        const p = buttons.find((x) => x.kind === 'primary'); if (p) { e.stopPropagation(); done(p.value); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    (m.querySelector('input,textarea,select') as HTMLElement | null)?.focus();
    (m as any)._done = done;
  });
}

export async function prompt(title: string, label: string, value = ''): Promise<string | null> {
  const wrap = el('div', 'row');
  wrap.innerHTML = `<label>${esc(label)}</label><input type="text" value="${esc(value)}">`;
  const inp = wrap.querySelector('input')!;
  const p = modal(title, wrap, [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', kind: 'primary', value: 'ok' }]);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
  const r = await p;
  return r === 'ok' ? inp.value : null;
}

export interface MenuItem { label?: string; icon?: string; kbd?: string; action?: () => void; sep?: boolean; disabled?: boolean }

export function showMenu(items: MenuItem[], x: number, y: number) {
  closeMenu();
  const root = document.getElementById('menu-root')!;
  const m = el('div', 'menu');
  import('./icons').then(({ icon }) => {
    for (const it of items) {
      if (it.sep) { m.appendChild(el('hr')); continue; }
      const b = el('button', '', {}, `${it.icon ? icon(it.icon) : '<span style="width:16px"></span>'}<span>${esc(it.label || '')}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ''}`);
      b.disabled = !!it.disabled;
      b.onclick = () => { closeMenu(); it.action?.(); };
      m.appendChild(b);
    }
    root.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
    setTimeout(() => {
      const off = (e: Event) => { if (!m.contains(e.target as Node)) closeMenu(); };
      document.addEventListener('mousedown', off, { once: true, capture: true });
    }, 0);
  });
}
export function closeMenu() { document.getElementById('menu-root')!.innerHTML = ''; }
