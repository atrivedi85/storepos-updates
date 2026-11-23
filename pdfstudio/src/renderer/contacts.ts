// Saved contacts for "Send for signature": names + emails only.
// The master list lives on the PdfStudio server, per signed-in user (same list in the web version and the desktop app).
// Offline or signed out: a copy in this browser/app is used, and new people are sent to the server next time.
import { el, esc, toast } from './util';

export interface Contact { name: string; email: string; lastUsed: number; count: number }
interface Pending { name: string; email: string; lastUsed: number; uses: number }

const EMAIL_SYNTAX = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
/** a usable address: valid shape and not the account's placeholder (name@ledger.invalid) */
export const EMAIL_OK = { test: (e: string) => EMAIL_SYNTAX.test(e) && !/\.(invalid|test|example|localhost)$/i.test(e) };
const K_LIST = 'pdfstudio.contacts', K_PEND = 'pdfstudio.contactsPending', K_DEL = 'pdfstudio.contactsDeleted', K_SAVE = 'pdfstudio.saveContacts';

const read = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* none */ }; };

export const getSavePref = () => { try { return localStorage.getItem(K_SAVE) !== '0'; } catch { return true; } };
export const setSavePref = (on: boolean) => { try { localStorage.setItem(K_SAVE, on ? '1' : '0'); } catch { /* none */ } };

const sortList = (l: Contact[]) => l.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));

function applyPending(base: Contact[], pend: Pending[], del: string[]): Contact[] {
  const m = new Map(base.map((c) => [c.email, { ...c }]));
  for (const p of pend) {
    const c = m.get(p.email);
    if (c) { c.name = p.name; c.lastUsed = Math.max(c.lastUsed, p.lastUsed); c.count += p.uses; }
    else m.set(p.email, { name: p.name, email: p.email, lastUsed: p.lastUsed, count: p.uses });
  }
  for (const e of del) m.delete(e);
  return sortList([...m.values()]);
}

/** Sends anything saved while offline to the server; returns the server list, or null if it cannot be reached. */
async function sync(): Promise<Contact[] | null> {
  try {
    let pend = read<Pending[]>(K_PEND, []);
    let del = read<string[]>(K_DEL, []);
    let list: Contact[] | null = null;
    if (pend.length) { list = (await window.api.esign('POST', 'contacts', { contacts: pend })).contacts; write(K_PEND, []); pend = []; }
    for (const e of del) { list = (await window.api.esign('DELETE', 'contacts', { email: e })).contacts; }
    if (del.length) write(K_DEL, []);
    if (!list) list = (await window.api.esign('GET', 'contacts')).contacts;
    list = sortList(list as Contact[]);
    write(K_LIST, list);
    return list;
  } catch { return null; }
}

export async function loadContacts(): Promise<Contact[]> {
  const fresh = await sync();
  if (fresh) return fresh;
  return applyPending(read<Contact[]>(K_LIST, []), read<Pending[]>(K_PEND, []), read<string[]>(K_DEL, []));
}

/** Call after a request was sent: updates people already saved and (if allowed) adds new ones. */
export async function recordUsed(signers: { name: string; email: string }[], addNew: boolean) {
  const known = new Set((await loadContacts()).map((c) => c.email));
  const now = Date.now();
  const add: Pending[] = [];
  for (const s of signers) {
    const email = s.email.trim().toLowerCase(), name = s.name.trim();
    if (!name || !EMAIL_OK.test(email)) continue;
    if (known.has(email) || addNew) add.push({ name, email, lastUsed: now, uses: 1 });
  }
  if (!add.length) return;
  write(K_PEND, [...read<Pending[]>(K_PEND, []), ...add]);
  await sync();
}

export async function removeContact(email: string): Promise<void> {
  write(K_PEND, read<Pending[]>(K_PEND, []).filter((p) => p.email !== email));
  write(K_LIST, read<Contact[]>(K_LIST, []).filter((c) => c.email !== email));
  write(K_DEL, [...read<string[]>(K_DEL, []), email]);
  if (!(await sync())) toast('Removed here; it will be removed on the server when you are back online');
}

const score = (c: Contact, q: string) => {
  const n = c.name.toLowerCase(), e = c.email.toLowerCase();
  return !q || n.includes(q) || e.includes(q);
};

/** Dropdown of matching contacts under a name/email box. `pick` fills the row; `taken` are emails already used. */
export function attachSuggest(inputs: HTMLInputElement[], all: () => Contact[], taken: () => Set<string>, pick: (c: Contact) => void) {
  const menu = el('div', 'suggest');
  menu.style.display = 'none';
  document.body.appendChild(menu);
  let cur: HTMLInputElement | null = null, items: Contact[] = [], hi = -1;
  const hide = () => { menu.style.display = 'none'; menu.replaceChildren(); hi = -1; items = []; };
  const mark = () => [...menu.children].forEach((c, i) => c.classList.toggle('hi', i === hi));
  const choose = (c: Contact) => { hide(); pick(c); };
  const show = (inp: HTMLInputElement) => {
    cur = inp;
    const q = inp.value.trim().toLowerCase(), tk = taken();
    items = all().filter((c) => !tk.has(c.email) && score(c, q)).slice(0, 6);
    menu.replaceChildren(); hi = -1;
    if (!items.length) { hide(); return; }
    for (const c of items) {
      const d = el('div', 'sg', {}, `<b>${esc(c.name)}</b><span>${esc(c.email)}</span>`);
      d.onmousedown = (e) => { e.preventDefault(); choose(c); };
      menu.appendChild(d);
    }
    const r = inp.getBoundingClientRect();
    menu.style.cssText = `display:block;left:${r.left}px;top:${r.bottom + 2}px;min-width:${Math.max(r.width, 260)}px`;
  };
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!inputs.includes(t as HTMLInputElement) || menu.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = (hi + 1) % items.length; mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = (hi - 1 + items.length) % items.length; mark(); }
    else if (e.key === 'Enter' && hi >= 0) { e.preventDefault(); e.stopPropagation(); choose(items[hi]); }
    else if (e.key === 'Escape') { e.stopPropagation(); hide(); }
  };
  window.addEventListener('keydown', onKey, true);   // window capture runs before the dialog's own Enter/Escape handling
  for (const i of inputs) attachOne(i);
  function attachOne(i: HTMLInputElement) {
    i.autocomplete = 'off';
    i.addEventListener('input', () => show(i));
    i.addEventListener('focus', () => { if (i.value.trim()) show(i); });
    i.addEventListener('blur', () => setTimeout(() => { if (cur === i) hide(); }, 120));
  }
  return { add: attachOne, destroy: () => { hide(); menu.remove(); window.removeEventListener('keydown', onKey, true); } };
}

/** Small searchable list with checkboxes, shown inside the dialog. onAdd gets the ticked people. */
export function contactsPanel(all: () => Contact[], taken: () => Set<string>, onAdd: (c: Contact[]) => void, onRemoved: (email: string) => void) {
  const box = el('div', 'cpanel');
  box.style.display = 'none';
  const q = el('input', '', { placeholder: 'Search contacts', type: 'search' }) as HTMLInputElement;
  const list = el('div', 'clist');
  const foot = el('div', 'row');
  const addBtn = el('button', 'btn primary', {}, 'Add selected'), close = el('button', 'btn', {}, 'Close');
  foot.append(addBtn, close);
  box.append(q, list, foot);
  const ticked = new Set<string>();
  const render = () => {
    list.replaceChildren();
    const tk = taken(), term = q.value.trim().toLowerCase();
    const rows = all().filter((c) => !tk.has(c.email) && score(c, term));
    if (!rows.length) list.appendChild(el('div', 'hint', {}, all().length ? 'No one else matches.' : 'No saved contacts yet. People you send to are saved here.'));
    for (const c of rows) {
      const r = el('label', 'crow');
      const cb = el('input', '', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = ticked.has(c.email);
      cb.onchange = () => { if (cb.checked) ticked.add(c.email); else ticked.delete(c.email); };
      const t = el('span', 'ct', {}, `<b>${esc(c.name)}</b> <small>${esc(c.email)}</small>`);
      const x = el('button', 'btn', { title: 'Remove from contacts', type: 'button' }, '×'); x.style.padding = '2px 9px';
      x.onclick = async (e) => {
        e.preventDefault();
        if (!confirm(`Remove ${c.name} <${c.email}> from your saved contacts?`)) return;
        ticked.delete(c.email);
        await removeContact(c.email); onRemoved(c.email); render();
      };
      r.append(cb, t, x); list.appendChild(r);
    }
  };
  q.oninput = render;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); } }, true);
  const onEnter = (e: KeyboardEvent) => { if (e.key === 'Enter' && e.target === q) { e.stopPropagation(); e.preventDefault(); } };
  window.addEventListener('keydown', onEnter, true);   // keeps Enter in the search box from sending the dialog
  addBtn.onclick = () => { const sel = all().filter((c) => ticked.has(c.email)); ticked.clear(); box.style.display = 'none'; if (sel.length) onAdd(sel); };
  close.onclick = () => { box.style.display = 'none'; };
  return { el: box, destroy: () => window.removeEventListener('keydown', onEnter, true), toggle: () => { const on = box.style.display === 'none'; box.style.display = on ? 'flex' : 'none'; if (on) { q.value = ''; render(); q.focus(); } } };
}

// ---- sender details for the final "Send ...?" box: remembered on the server per user, copy kept locally ----
export interface Profile { fromName: string; notifyEmail: string }
const K_FROM = 'pdfstudio.esignFrom', K_NOTIFY = 'pdfstudio.esignNotify';
const lget = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
export async function loadProfile(fallbackName: string, accountEmail: string): Promise<Profile> {
  let p: Profile = { fromName: '', notifyEmail: '' };
  try { p = await window.api.esign('GET', 'profile'); } catch { /* offline: use the local copy */ }
  const local = lget(K_NOTIFY);
  return {
    fromName: p.fromName || lget(K_FROM) || fallbackName,
    notifyEmail: [p.notifyEmail, local, accountEmail].find((e) => e && EMAIL_OK.test(e)) || '',
  };
}
export async function saveProfile(p: Profile) {
  try { localStorage.setItem(K_FROM, p.fromName); localStorage.setItem(K_NOTIFY, p.notifyEmail); } catch { /* none */ }
  try { await window.api.esign('PUT', 'profile', p); } catch { /* kept locally; saved on the server next time */ }
}
