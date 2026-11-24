// Phone home screen (like Adobe Acrobat mobile): welcome, tips, big tiles, Recent / Starred / On device / Cloud lists,
// a "+" button and a bottom tab bar. Used on narrow screens (<= 820px) and always inside the Android app.
// The desktop layout never sees any of this (everything is behind html.mob).
import type { App } from './app';
import type { DocTab } from './doc';
import { $, baseName, closeMenu, el, esc, prompt, showMenu, toast, type MenuItem } from './util';
import { icon } from './icons';
import { isAndroid, shareBytes } from './native';
import { getBytes, fmtSize, fmtWhen, listRecents, putRecent, recordRecent, removeRecent, type RecentEntry } from './recents';
import { openScanner, scannerBack, scannerOpen } from './scan';
import { appendPdfs } from './pdfops';
import { PDFDocument } from 'pdf-lib';

const NARROW = '(max-width: 820px)';
const TIPS_KEY = 'pdfstudio.tips.dismissed';
type View = 'home' | 'files' | 'tools';
type Tab = 'recent' | 'starred' | 'device' | 'cloud';

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

const TIPS = [
  { id: 'scan', icon: 'camera', title: 'Scan paper to PDF', text: 'Use your camera to turn paper into a clean PDF.', act: 'scan' },
  { id: 'sign', icon: 'sign', title: 'Sign documents', text: 'Your saved signatures follow your account.', act: 'sign' },
];
const TILES: { id: string; label: string; icon: string; color: string }[] = [
  { id: 'scan', label: 'Scan', icon: 'camera', color: '#2f7dff' },
  { id: 'open', label: 'Open PDF', icon: 'open', color: '#e5484d' },
  { id: 'sign', label: 'Fill & Sign', icon: 'sign', color: '#7c5cff' },
  { id: 'edit', label: 'Edit PDF', icon: 'edittext', color: '#f08a2e' },
  { id: 'organize', label: 'Organize pages', icon: 'pages', color: '#14b8a6' },
  { id: 'create', label: 'Create PDF', icon: 'photos', color: '#e2559d' },
  { id: 'merge', label: 'Merge PDFs', icon: 'merge', color: '#3fb950' },
];
const TOOLS: typeof TILES = [
  ...TILES,
  { id: 'blank', label: 'New blank PDF', icon: 'addpage', color: '#5b6cff' },
  { id: 'highlight', label: 'Highlight', icon: 'highlight', color: '#d9a400' },
  { id: 'draw', label: 'Draw', icon: 'pen', color: '#c24bd6' },
  { id: 'textbox', label: 'Add text', icon: 'text', color: '#4aa3df' },
  { id: 'image', label: 'Add image', icon: 'image', color: '#d9598a' },
  { id: 'erase', label: 'Erase', icon: 'eraser', color: '#8a8fa8' },
  { id: 'send', label: 'Send for signature', icon: 'share', color: '#2fa36b' },
  { id: 'cloud', label: 'Cloud files', icon: 'cloud', color: '#3b82f6' },
];

export class Mobile {
  mob = false;
  view: View = 'home';
  tab: Tab = 'recent';
  home = true;                    // the home screen is showing (no document in front)
  query = '';
  searching = false;
  fabOpen = false;
  user: string | null = null;
  private keys = new WeakMap<DocTab, string>();
  private root!: HTMLElement;
  private listBox!: HTMLElement;
  private mq = window.matchMedia(NARROW);

  constructor(private app: App) {}

  init() {
    this.root = el('div', 'hidden');
    this.root.id = 'mhome';
    document.body.appendChild(this.root);
    this.mq.addEventListener('change', () => this.refreshMode());
    this.wireTopbar();
    this.refreshMode();
  }

  // ---------- phone mode on/off ----------
  refreshMode() {
    this.mob = isAndroid() || this.mq.matches;
    document.documentElement.classList.toggle('mob', this.mob);
    this.root.classList.toggle('hidden', !this.mob);
    if (!this.mob) { document.body.classList.remove('mhome'); return; }
    this.home = !this.app.active;
    this.sync();
    this.render();
  }

  private sync() {
    document.body.classList.toggle('mhome', this.mob && this.home);
    this.root.classList.toggle('on', this.mob && this.home);
  }

  setUser(name: string | null) { this.user = name; if (this.mob) this.renderTitle(); }
  private firstName() {
    if (!this.user) return '';
    const f = this.user.split(/[\s._@+-]+/)[0] || '';
    return f ? f.charAt(0).toUpperCase() + f.slice(1) : '';
  }

  /** Called whenever a document comes to the front (tab) or none is left. */
  onActivate(tab: DocTab | null) {
    if (!this.mob) return;
    this.home = !tab;
    this.fabOpen = false;
    this.sync();
    if (this.home) { this.render(); }
  }
  showHome(view: View = 'home') {
    this.home = true; this.view = view; this.fabOpen = false;
    document.body.classList.remove('side-open');
    this.sync(); this.render();
  }
  async backFromDoc() {
    const t = this.app.active;
    if (t && !(await this.app.closeTab(t))) return;
    this.showHome(this.view);
  }

  private wireTopbar() {
    $('#mobBack').onclick = () => void this.backFromDoc();
    $('#mobSearch').onclick = () => { this.searching = !this.searching; if (!this.searching) this.query = ''; this.render(); if (this.searching) (this.root.querySelector('.mh-q input') as HTMLInputElement | null)?.focus(); };
  }

  // ---------- recents bookkeeping ----------
  keyFor(path: string | null, name: string) {
    const m = path?.match(/^cloud:\/\/([a-f0-9]+)\//);
    return m ? `cloud:${m[1]}` : `local:${name.toLowerCase()}`;
  }
  keyOfTab(t: DocTab) { return this.keys.get(t) || this.keyFor(t.path, t.name); }

  /** Remember a document (with its bytes) so it can be reopened from Recent, even offline. */
  async record(tab: DocTab, bytes: Uint8Array, source?: RecentEntry['source']) {
    if (!this.mob) return;
    try {
      const key = this.keyFor(tab.path, tab.name);
      this.keys.set(tab, key);
      const old = (await listRecents()).find((e) => e.key === key);
      const src = source || (tab.path?.startsWith('cloud://') ? 'cloud' : old?.source || 'device');
      const meta = await recordRecent({ key, name: tab.name, source: src, path: tab.path?.startsWith('cloud://') ? tab.path : undefined }, bytes);
      const thumb = await this.thumbOf(tab).catch(() => '');
      if (thumb) { meta.thumb = thumb; await putRecent(meta); }
      if (this.home) void this.renderList();
    } catch (e) { console.warn('recent files not saved', e); }
  }

  private async thumbOf(tab: DocTab): Promise<string> {
    const page = await tab.getPage(0);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 140 / base.width });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: g, viewport: vp } as any).promise;
    return c.toDataURL('image/jpeg', 0.7);
  }

  async openEntry(e: RecentEntry) {
    const open = this.app.tabs.find((t) => this.keyOfTab(t) === e.key);
    if (open) { await this.app.activate(open); return; }
    let bytes: Uint8Array | null = null, path: string | null = null;
    if (e.source === 'cloud' && e.path) { try { bytes = await this.app.api.readFile(e.path); path = e.path; } catch { /* offline: use the saved copy */ } }
    if (!bytes) bytes = await getBytes(e.id);
    if (!bytes || !bytes.length) { toast('That file is no longer stored on this phone. Open it again.', true); await removeRecent(e.id); void this.renderList(); return; }
    await this.app.openBytes(bytes, e.name, e.source, path);
  }

  // ---------- doing things ----------
  private async pickAnd(after?: () => void | Promise<void>) {
    const paths = await this.app.api.openDialog(false);
    if (!paths.length) return;
    await this.app.openPaths(paths);
    if (after && this.app.active) await after();
  }
  private scan(mode: 'scan' | 'photos') {
    openScanner(mode, { finish: (bytes, name) => this.app.openBytes(bytes, name, 'scan') });
  }
  private async merge() {
    const paths = await this.app.api.openDialog(true);
    if (!paths.length) return;
    if (paths.length < 2) { toast('Choose two or more PDFs to merge', true); return; }
    try {
      const files = await Promise.all(paths.map((p) => this.app.api.readFile(p)));
      const doc = await PDFDocument.create();
      await appendPdfs(doc, files);
      const d = new Date(), pad = (n: number) => String(n).padStart(2, '0');
      await this.app.openBytes(await doc.save(), `Merged ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}.pdf`, 'new');
      toast(`Merged ${paths.length} PDFs`);
    } catch (e: any) { toast(`Could not merge: ${e?.message || e}`, true); }
  }

  runTool(id: string) {
    const app = this.app;
    switch (id) {
      case 'scan': return this.scan('scan');
      case 'create': return this.scan('photos');
      case 'open': return void this.pickAnd();
      case 'blank': return void app.newBlank();
      case 'merge': return void this.merge();
      case 'cloud': return void app.cloudPanel();
      case 'sign': return void this.pickAnd(() => app.signMenu($('[data-action=sign]')));
      case 'edit': return void this.pickAnd(() => app.editor.setTool('edittext'));
      case 'highlight': case 'draw': case 'textbox': case 'erase': return void this.pickAnd(() => app.editor.setTool(id as any));
      case 'image': return void this.pickAnd(() => app.insertImage());
      case 'send': return void this.pickAnd(() => app.sendForSignature());
      case 'organize': return void this.pickAnd(() => {
        if (this.mq.matches) document.body.classList.add('side-open'); else app.pagesMenu($('[data-action=pagesMenu]'));
      });
    }
  }

  // ---------- drawing ----------
  render() {
    if (!this.mob) return;
    const r = this.root;
    r.replaceChildren();
    const scroll = el('div', 'mh-scroll');
    if (this.view === 'home') {
      scroll.append(el('h1', 'mh-title', {}, ''));
      if (this.searching) scroll.append(this.searchRow());
      const tips = this.tipsRow(); if (tips) scroll.append(tips);
      scroll.append(el('h2', 'mh-h', {}, 'What would you like to do?'), this.tilesRow(TILES, 'row'));
      scroll.append(this.tabsRow(), this.listBox = el('div', 'mh-list'));
    } else if (this.view === 'files') {
      scroll.append(el('h1', 'mh-title', {}, 'Files'));
      if (this.searching) scroll.append(this.searchRow());
      scroll.append(this.tabsRow(), this.listBox = el('div', 'mh-list'));
    } else {
      scroll.append(el('h1', 'mh-title', {}, 'Tools'));
      scroll.append(this.tilesRow(TOOLS, 'grid'));
    }
    r.append(scroll);
    if (this.view !== 'tools') {
      const fab = el('button', 'mh-fab', { 'aria-label': 'Add', 'aria-expanded': String(this.fabOpen) }, icon('plus'));
      fab.onclick = () => { this.fabOpen = !this.fabOpen; this.render(); };
      r.append(fab);
      if (this.fabOpen) {
        const back = el('div', 'mh-fabback'); back.onclick = () => { this.fabOpen = false; this.render(); };
        const m = el('div', 'mh-fabmenu');
        for (const [id, label, ic] of [['scan', 'Scan', 'camera'], ['open', 'Open PDF', 'open'], ['create', 'Create from photos', 'photos'], ['blank', 'New blank PDF', 'addpage']]) {
          const b = el('button', '', { 'data-id': id }, `<span class="ico">${icon(ic)}</span><span>${label}</span>`);
          b.onclick = () => { this.fabOpen = false; this.render(); this.runTool(id); };
          m.append(b);
        }
        r.append(back, m);
      }
    }
    r.append(this.navBar());
    this.renderTitle();
    if (this.listBox) void this.renderList();
  }

  private renderTitle() {
    const h = this.root.querySelector('.mh-title');
    if (h && this.view === 'home') h.textContent = this.firstName() ? `Welcome back, ${this.firstName()}` : 'Welcome back';
  }

  private searchRow() {
    const row = el('div', 'mh-q', {}, `${icon('search')}<input type="search" placeholder="Search your files" value="${esc(this.query)}" aria-label="Search your files"><button aria-label="Clear">${icon('close')}</button>`);
    const inp = row.querySelector('input')!;
    inp.oninput = () => { this.query = inp.value; void this.renderList(); };
    row.querySelector('button')!.onclick = () => { this.query = ''; this.searching = false; this.render(); };
    return row;
  }

  private tipsRow(): HTMLElement | null {
    let gone: string[] = [];
    try { gone = JSON.parse(lsGet(TIPS_KEY) || '[]'); } catch { /* ignore */ }
    const tips = TIPS.filter((t) => !gone.includes(t.id));
    if (!tips.length) return null;
    const row = el('div', 'mh-tips');
    for (const t of tips) {
      const c = el('div', 'mh-tip', {}, `<span class="ico">${icon(t.icon)}</span><div><b>${esc(t.title)}</b><small>${esc(t.text)}</small></div><button class="x" aria-label="Dismiss tip">${icon('close')}</button>`);
      c.onclick = () => this.runTool(t.act);
      (c.querySelector('.x') as HTMLElement).onclick = (ev) => { ev.stopPropagation(); lsSet(TIPS_KEY, JSON.stringify([...gone, t.id])); this.render(); };
      row.append(c);
    }
    return row;
  }

  private tilesRow(list: typeof TILES, kind: 'row' | 'grid') {
    const box = el('div', kind === 'row' ? 'mh-tiles' : 'mh-grid');
    for (const t of list) {
      const b = el('button', 'mh-tile', { 'data-id': t.id }, `<span class="sq" style="background:${t.color}">${icon(t.icon)}</span><span class="lb">${esc(t.label)}</span>`);
      b.onclick = () => this.runTool(t.id);
      box.append(b);
    }
    return box;
  }

  private tabsRow() {
    const tabs: [Tab, string][] = [['recent', 'Recent'], ['starred', 'Starred'], ['device', 'On device'], ['cloud', 'Cloud']];
    const row = el('div', 'mh-tabs', { role: 'tablist' });
    for (const [id, label] of tabs) {
      const b = el('button', this.tab === id ? 'on' : '', { role: 'tab', 'data-tab': id, 'aria-selected': String(this.tab === id) }, label);
      b.onclick = () => { this.tab = id; row.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); }); void this.renderList(); };
      row.append(b);
    }
    return row;
  }

  private navBar() {
    const nav = el('nav', 'mh-nav');
    const items: [string, string, string][] = [['home', 'Home', 'home'], ['scan', 'Scan', 'camera'], ['files', 'Files', 'files'], ['tools', 'Tools', 'tools']];
    for (const [id, label, ic] of items) {
      const on = id === this.view;
      const b = el('button', on ? 'on' : '', { 'data-nav': id, 'aria-label': label }, `${icon(ic)}<span>${label}</span>`);
      b.onclick = () => {
        if (id === 'scan') { this.scan('scan'); return; }
        this.view = id as View; this.fabOpen = false; this.searching = false; this.query = '';
        this.render();
        this.root.querySelector('.mh-scroll')?.scrollTo(0, 0);
      };
      nav.append(b);
    }
    return nav;
  }

  async renderList() {
    const box = this.listBox;
    if (!box || !box.isConnected) return;
    const q = this.query.trim().toLowerCase();
    const mine = ++this.listSeq;
    if (this.tab === 'cloud') { await this.renderCloud(box, q, mine); return; }
    const all = await listRecents();
    if (mine !== this.listSeq) return;
    let rows = all;
    if (this.tab === 'starred') rows = all.filter((e) => e.starred);
    else if (this.tab === 'device') rows = all.filter((e) => e.source !== 'cloud');
    if (q) rows = rows.filter((e) => e.name.toLowerCase().includes(q));
    box.replaceChildren();
    if (this.tab === 'device') {
      const b = el('button', 'btn primary mh-choose', {}, `${icon('open')}<span>Choose a PDF from this phone</span>`);
      b.onclick = () => void this.pickAnd();
      box.append(b);
    }
    if (!rows.length) {
      const msg = this.tab === 'starred' ? 'Nothing starred yet. Tap ⋮ next to a file and choose Star.'
        : q ? 'No files match your search.'
        : this.tab === 'device' ? 'Files you open from this phone will show up here.'
        : 'Files you open or scan will show up here.';
      box.append(el('div', 'mh-empty', {}, esc(msg)));
      return;
    }
    for (const e of rows) box.append(this.row(e));
  }
  private listSeq = 0;

  private row(e: RecentEntry) {
    const r = el('div', 'mh-row', { 'data-name': e.name });
    const th = el('div', 'th', {}, e.thumb ? `<img alt="" src="${e.thumb}">` : icon('pages'));
    const info = el('div', 'inf', {}, `<b>${esc(e.name)}${e.starred ? ` <span class="st" aria-label="Starred">${icon('star')}</span>` : ''}</b><small>PDF · ${esc(fmtWhen(e.time))} · ${esc(fmtSize(e.size))}</small>`);
    const more = el('button', 'more', { 'aria-label': `More for ${e.name}` }, icon('more'));
    more.onclick = (ev) => { ev.stopPropagation(); this.entryMenu(e, more); };
    r.append(th, info, more);
    r.onclick = () => void this.openEntry(e);
    return r;
  }

  private entryMenu(e: RecentEntry, anchor: HTMLElement) {
    const b = anchor.getBoundingClientRect();
    const items: MenuItem[] = [
      { label: 'Open', icon: 'open', action: () => void this.openEntry(e) },
      { label: e.starred ? 'Unstar' : 'Star', icon: 'star', action: async () => { await putRecent({ ...e, starred: !e.starred }); void this.renderList(); } },
      { label: 'Share', icon: 'share', action: () => void this.shareEntry(e) },
      { label: 'Rename', icon: 'rename', action: () => void this.renameEntry(e) },
      { sep: true },
      { label: 'Remove from list', icon: 'trash', action: async () => { await removeRecent(e.id); void this.renderList(); } },
    ];
    showMenu(items, b.right - 210, b.bottom + 2);
  }

  async shareEntry(e: RecentEntry) {
    const bytes = await getBytes(e.id);
    if (!bytes) { toast('That file is no longer stored on this phone.', true); return; }
    const r = await shareBytes(e.name, bytes);
    if (r === 'downloaded') toast(`Saved ${e.name} to your downloads`);
  }

  private async renameEntry(e: RecentEntry) {
    const n = await prompt('Rename file', 'Name', e.name.replace(/\.pdf$/i, ''));
    if (!n || !n.trim()) return;
    const name = n.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/(\.pdf)?$/i, '.pdf');
    let path = e.path;
    const cid = e.path?.match(/^cloud:\/\/([a-f0-9]+)\//)?.[1];
    if (cid) { try { await this.app.api.cloudRename(cid, name); path = `cloud://${cid}/${name}`; } catch (x: any) { toast(String(x?.message || x), true); return; } }
    await putRecent({ ...e, name, path, key: cid ? e.key : this.keyFor(null, name) });
    void this.renderList();
  }

  private async renderCloud(box: HTMLElement, q: string, mine: number) {
    box.replaceChildren(el('div', 'mh-empty', {}, 'Loading your cloud files…'));
    let l: Awaited<ReturnType<App['api']['cloudList']>>;
    try { l = await this.app.api.cloudList(); }
    catch (x: any) { if (mine === this.listSeq) box.replaceChildren(el('div', 'mh-empty', {}, esc(`Could not load your files: ${String(x?.message || x)}`))); return; }
    if (mine !== this.listSeq) return;
    box.replaceChildren();
    const all = el('button', 'btn mh-choose', {}, `${icon('cloud')}<span>Manage cloud files</span>`);
    all.onclick = () => void this.app.cloudPanel();
    box.append(all);
    if (l.offline) box.append(el('div', 'mh-empty', {}, 'You are offline. Connect to see your cloud files.'));
    const files = (l.files || []).filter((f) => !q || f.name.toLowerCase().includes(q));
    if (!files.length && !l.offline) box.append(el('div', 'mh-empty', {}, q ? 'No files match your search.' : 'No cloud files yet. Open a PDF and choose Cloud to save it here.'));
    for (const f of files) {
      const r = el('div', 'mh-row', { 'data-name': f.name });
      r.append(el('div', 'th', {}, icon('cloud')), el('div', 'inf', {}, `<b>${esc(f.name)}</b><small>PDF · ${esc(fmtWhen(f.updatedAt))} · ${esc(fmtSize(f.size))}</small>`));
      r.onclick = () => void this.app.openPaths([`cloud://${f.id}/${f.name}`]);
      box.append(r);
    }
  }

  // ---------- Android / phone back button ----------
  /** true = handled here (the app stays open); false = nothing to go back to, let the app close. */
  back(): boolean {
    if (!$('#lock').classList.contains('hidden')) return false;
    const mb = document.querySelector('#modal-root .modal-bg');
    if (mb) {
      const m = mb.querySelector('.modal') as any;
      if (m?._done) m._done('cancel'); else (mb.querySelector('.footer button') as HTMLElement | null)?.click();
      return true;
    }
    if (document.querySelector('#menu-root .menu')) { closeMenu(); return true; }
    if (scannerOpen()) { void scannerBack(); return true; }
    if (!$('#searchbar').classList.contains('hidden')) { this.app.closeSearch(); return true; }
    if (document.body.classList.contains('side-open')) { document.body.classList.remove('side-open'); return true; }
    if (!this.mob) return false;
    if (this.home) {
      if (this.fabOpen) { this.fabOpen = false; this.render(); return true; }
      if (this.searching) { this.searching = false; this.query = ''; this.render(); return true; }
      if (this.view !== 'home') { this.view = 'home'; this.render(); return true; }
      return false;
    }
    if (this.app.active) { void this.backFromDoc(); return true; }
    return false;
  }
}
