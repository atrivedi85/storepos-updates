import { DocTab } from './doc';
import { DocView, PageView, PageHooks } from './viewer';
import { Thumbs } from './thumbs';
import { searchDoc, Hit } from './search';
import { hydrateIcons, icon } from './icons';
import { $, baseName, el, esc, toast, modal, showMenu, uid, type MenuItem } from './util';
import { Editor } from './editor';
import {
  applyDocChange, buildPdf, reorderPages, rotatePages, deletePages, insertBlank, extractPages, appendPdfs,
  parseRanges, splitDoc, blankPdf,
} from './pdfops';
import { getSignature, dataUrlToBytes, SigKind } from './sign';
import { openCloudPanel } from './cloud';
import { setupEsign, startSend, requestsPanel } from './esign';
import type { ToolName } from './types';
import type { Api } from '../main/preload';

declare global { interface Window { api: Api; app: App } }

const api = window.api;

export class App implements PageHooks {
  tabs: DocTab[] = [];
  views = new Map<string, DocView>();
  active: DocTab | null = null;
  thumbs: Thumbs;
  editor: Editor;
  hits: Hit[] = [];
  hitIdx = -1;
  searchTimer = 0;
  busy = false;

  constructor() {
    this.editor = new Editor(this);
    setupEsign(this);
    this.thumbs = new Thumbs($('#thumbs'), {
      goto: (i) => this.view?.scrollToPage(i),
      reorder: (from, to) => this.reorder(from, to),
      rotate: (pages, deg) => this.rotate(pages, deg),
      del: (pages) => this.deletePages(pages),
      insertBlank: (after) => this.insertBlankAfter(after),
    });
  }

  get view() { return this.active ? this.views.get(this.active.id) || null : null; }

  // ---- hooks ----
  pageCreated(pv: PageView) { this.editor.attach(pv); this.editor.renderPage(pv); }
  pageLaidOut(_pv: PageView) {}
  pageRendered(pv: PageView) { this.applySearchToPage(pv); }

  // ---- tabs ----
  async openPaths(paths: string[]) {
    for (const p of paths) {
      const existing = this.tabs.find((t) => t.path && t.path.toLowerCase() === p.toLowerCase());
      if (existing) { await this.activate(existing); continue; }
      try {
        const bytes = await api.readFile(p);
        await this.addTab(await DocTab.create(bytes, p));
      } catch (e: any) {
        toast(`Could not open ${baseName(p)}: ${e?.message || e}`, true);
      }
    }
  }

  async newBlank() {
    const n = this.tabs.filter((t) => !t.path).length + 1;
    await this.addTab(await DocTab.create(await blankPdf(), null, `Untitled${n > 1 ? n : ''}.pdf`));
  }

  async addTab(tab: DocTab) {
    this.tabs.push(tab);
    const v = new DocView(tab, this);
    this.views.set(tab.id, v);
    $('#docs').appendChild(v.root);
    v.onPageChange = (i) => { if (tab === this.active) this.onPageChanged(i); };
    await this.activate(tab);
  }

  async activate(tab: DocTab | null) {
    this.active = tab;
    this.editor.select(null);
    for (const [id, v] of this.views) v.root.classList.toggle('active', tab?.id === id);
    $('#welcome').classList.toggle('hidden', !!tab);
    if (tab) {
      const v = this.views.get(tab.id)!;
      if (!v.pages.length) v.build(); else v.refit();
      await this.thumbs.show(tab);
      if (tab.currentPage) v.scrollToPage(tab.currentPage);
      this.editor.setTool(this.editor.tool);
    } else {
      await this.thumbs.show(null);
      this.refreshRecent();
    }
    this.closeSearchResults();
    this.renderTabs();
    this.updateUi();
    this.syncToolbar();
    this.editor.buildOptions();
  }

  async closeTab(tab: DocTab) {
    if (tab.dirty) {
      await this.activate(tab);
      const r = await modal('Unsaved changes', `Save changes to <b>${esc(tab.name)}</b> before closing?`, [
        { label: 'Cancel', value: 'cancel' }, { label: "Don't save", kind: 'danger', value: 'no' }, { label: 'Save', kind: 'primary', value: 'yes' },
      ]);
      if (r === 'cancel') return false;
      if (r === 'yes' && !(await this.saveTab(tab, false))) return false;
    }
    const idx = this.tabs.indexOf(tab);
    this.tabs.splice(idx, 1);
    this.views.get(tab.id)?.destroy();
    this.views.delete(tab.id);
    tab.destroy();
    if (this.active === tab) await this.activate(this.tabs[Math.min(idx, this.tabs.length - 1)] || null);
    else this.renderTabs();
    return true;
  }

  renderTabs() {
    const bar = $('#tabbar');
    bar.replaceChildren();
    bar.style.display = this.tabs.length ? '' : 'none';
    for (const t of this.tabs) {
      const d = el('div', 'tab' + (t === this.active ? ' active' : ''), { title: t.path || t.name });
      d.innerHTML = `${t.dirty ? '<span class="dot"></span>' : ''}<span class="tname">${esc(t.name)}</span><span class="x">${icon('close')}</span>`;
      d.onclick = () => { if (this.tabDragged) { this.tabDragged = false; return; } this.activate(t); };
      d.onpointerdown = (e) => this.tabPointerDown(e, d, t);
      d.onauxclick = (e) => { if (e.button === 1) this.closeTab(t); };
      (d.querySelector('.x') as HTMLElement).onclick = (e) => { e.stopPropagation(); this.closeTab(t); };
      bar.appendChild(d);
    }
  }

  tabDragged = false;

  /** Chrome-style tab dragging: press, move more than 5px, other tabs slide aside, drop to reorder. */
  tabPointerDown(e: PointerEvent, d: HTMLElement, t: DocTab) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.x')) return;
    const bar = $('#tabbar');
    const els = Array.from(bar.children) as HTMLElement[];
    const from = els.indexOf(d);
    if (from < 0 || els.length < 2) return;
    const startX = e.clientX, startScroll = bar.scrollLeft;
    const lefts = els.map((x) => x.offsetLeft), widths = els.map((x) => x.offsetWidth);
    const gap = els.length > 1 ? lefts[1] - lefts[0] - widths[0] : 2;
    let dragging = false, curX = startX, to = from, raf = 0;
    const layout = () => {
      const dx = curX - startX + (bar.scrollLeft - startScroll);
      const lo = -lefts[from], hi = bar.scrollWidth - lefts[from] - widths[from];
      const mx = Math.max(lo, Math.min(hi, dx));
      d.style.transform = `translateX(${mx}px)`;
      const centre = lefts[from] + widths[from] / 2 + mx;
      to = 0;
      els.forEach((x, i) => { if (i !== from && lefts[i] + widths[i] / 2 < centre) to++; });
      els.forEach((x, i) => {
        if (i === from) return;
        let sh = 0;
        if (i > from && i <= to) sh = -(widths[from] + gap);
        else if (i < from && i >= to) sh = widths[from] + gap;
        x.style.transform = sh ? `translateX(${sh}px)` : '';
      });
    };
    const tick = () => {
      if (!dragging) return;
      const r = bar.getBoundingClientRect();
      if (curX < r.left + 30) bar.scrollLeft -= 12; else if (curX > r.right - 30) bar.scrollLeft += 12;
      layout();
      raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      curX = ev.clientX;
      if (!dragging) {
        if (Math.abs(curX - startX) < 5) return;
        dragging = true;
        try { d.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
        d.style.transition = 'none'; d.style.zIndex = '5'; d.style.position = 'relative'; d.style.opacity = '.9';
        els.forEach((x) => { if (x !== d) x.style.transition = 'transform .15s ease'; });
        raf = requestAnimationFrame(tick);
      }
      layout();
    };
    const end = (ev: PointerEvent) => {
      d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', end); d.removeEventListener('pointercancel', end);
      cancelAnimationFrame(raf);
      if (!dragging) return;
      dragging = false;
      this.tabDragged = true;
      setTimeout(() => { this.tabDragged = false; }, 0);
      if (ev.type === 'pointercancel') to = from;
      if (to !== from) { this.tabs.splice(from, 1); this.tabs.splice(to, 0, t); }
      this.renderTabs();
    };
    d.addEventListener('pointermove', move); d.addEventListener('pointerup', end); d.addEventListener('pointercancel', end);
  }

  onPageChanged(i: number) {
    this.thumbs.setCurrent(i);
    ($('#pageInput') as HTMLInputElement).value = String(i + 1);
  }

  /** called after any content mutation */
  onDocChanged() {
    this.renderTabs();
    this.updateUi();
    this.syncToolbar();
  }

  updateUi() {
    const t = this.active;
    $('#pageTotal').textContent = `/ ${t ? t.pages.length : 0}`;
    ($('#pageInput') as HTMLInputElement).value = t ? String(t.currentPage + 1) : '1';
    $('#stDoc').textContent = t ? (t.path?.startsWith('cloud://') ? `Cloud: ${t.name}` : (t.path || t.name)) : 'No document';
    $('#stZoom').textContent = t ? `${Math.round(t.zoom * 100)}%` : '';
    const sel = $('#zoomSelect') as HTMLSelectElement;
    if (t) {
      const v = typeof t.zoomMode === 'number' ? String(t.zoomMode) : t.zoomMode;
      sel.querySelectorAll('[data-tmp]').forEach((x) => x.remove());
      if (![...sel.options].some((o) => o.value === v)) sel.appendChild(el('option', '', { value: v, 'data-tmp': '1' }, `${Math.round(t.zoom * 100)}%`));
      sel.value = v;
    }
    const title = t ? `${t.name}${t.dirty ? ' •' : ''} — PdfStudio` : 'PdfStudio';
    document.title = title;
    api.setTitle(title);
  }

  syncToolbar() {
    const t = this.active;
    document.querySelectorAll<HTMLButtonElement>('.tb.tool').forEach((b) => b.classList.toggle('active', !!t && b.dataset.tool === this.editor.tool));
    document.querySelectorAll<HTMLButtonElement>('#toolbar .tb').forEach((b) => {
      const a = b.dataset.action;
      if (b.classList.contains('tool') || (a && ['image', 'save', 'saveAs', 'pagesMenu', 'zoomIn', 'zoomOut', 'search'].includes(a))) b.disabled = !t;
    });
    ($('[data-action=undo]') as HTMLButtonElement).disabled = !t || !t.past.length;
    ($('[data-action=redo]') as HTMLButtonElement).disabled = !t || !t.future.length;
  }

  // ---- zoom ----
  zoomBy(f: number) {
    const t = this.active; if (!t) return;
    this.view!.setZoom(Math.round(Math.min(6, Math.max(0.1, t.zoom * f)) * 100) / 100);
    this.updateUi();
  }
  setZoomMode(v: string) {
    if (!this.active) return;
    this.view!.setZoom(v === 'fitwidth' || v === 'fitpage' ? v : Number(v));
    this.updateUi();
  }

  // ---- search ----
  openSearch() {
    if (!this.active) return;
    $('#searchbar').classList.remove('hidden');
    const i = $('#searchInput') as HTMLInputElement;
    i.focus(); i.select();
  }
  closeSearch() { $('#searchbar').classList.add('hidden'); this.closeSearchResults(); }
  closeSearchResults() {
    this.hits = []; this.hitIdx = -1;
    $('#searchCount').textContent = '';
    this.views.forEach((v) => v.pages.forEach((p) => p.setSearch([])));
  }
  async runSearch() {
    const t = this.active; if (!t) return;
    const q = ($('#searchInput') as HTMLInputElement).value;
    const mc = ($('#searchCase') as HTMLInputElement).checked;
    this.hits = await searchDoc(t, q, mc);
    this.hitIdx = this.hits.length ? 0 : -1;
    this.paintSearch(true);
  }
  stepSearch(d: number) {
    if (!this.hits.length) return;
    this.hitIdx = (this.hitIdx + d + this.hits.length) % this.hits.length;
    this.paintSearch(true);
  }
  paintSearch(scroll: boolean) {
    const v = this.view; if (!v) return;
    $('#searchCount').textContent = this.hits.length ? `${this.hitIdx + 1} of ${this.hits.length}` : ($('#searchInput') as HTMLInputElement).value ? 'No results' : '';
    v.pages.forEach((p) => this.applySearchToPage(p));
    if (scroll && this.hitIdx >= 0) { const h = this.hits[this.hitIdx]; v.scrollToBox(h.page, h.box); }
  }
  applySearchToPage(pv: PageView) {
    const out: { box: any; cur: boolean }[] = [];
    this.hits.forEach((h, i) => { if (h.page === pv.index) out.push({ box: h.box, cur: i === this.hitIdx }); });
    pv.setSearch(out);
  }

  // ---- welcome ----
  async refreshRecent() {
    const list = await api.getRecent();
    const box = $('#recentList');
    box.replaceChildren();
    if (!list.length) { box.innerHTML = '<div class="hint" style="color:var(--muted)">No recent files yet.</div>'; return; }
    for (const p of list.slice(0, 8)) {
      const d = el('div', 'recent-item', {}, `<span>${esc(baseName(p))}</span><small>${esc(p)}</small>`);
      d.onclick = () => this.openPaths([p]);
      box.appendChild(d);
    }
    const clr = el('button', 'btn', {}, 'Clear list'); clr.style.marginTop = '8px';
    clr.onclick = async () => { await api.clearRecent(); this.refreshRecent(); };
    box.appendChild(clr);
  }

  async openDialog() {
    const paths = await api.openDialog(true);
    if (paths.length) await this.openPaths(paths);
  }

  // ---- save / history ----
  async saveTab(tab: DocTab, saveAs: boolean): Promise<boolean> {
    let path = tab.path;
    if (!path || saveAs) {
      path = await api.saveDialog(tab.path ? tab.name : tab.name);
      if (!path) return false;
    }
    try {
      this.editor.select(null);
      const { bytes, warnings } = await buildPdf(tab);
      await api.writeFile(path, bytes);
      tab.path = path; tab.name = baseName(path); tab.dirty = false;
      this.renderTabs(); this.updateUi();
      toast(`Saved ${tab.name}`);
      for (const w of warnings) toast(w, true);
      return true;
    } catch (e: any) {
      toast(`Save failed: ${e?.message || e}`, true);
      return false;
    }
  }
  save(as = false) { if (this.active) return this.saveTab(this.active, as); }

  // ---- cloud library ----
  async saveToCloud(tab: DocTab) {
    try {
      this.editor.select(null);
      const { bytes, warnings } = await buildPdf(tab);
      const path = await api.cloudCreate(tab.name, bytes);
      tab.path = path; tab.name = baseName(path); tab.dirty = false;
      this.renderTabs(); this.updateUi();
      toast(`Saved ${tab.name} to your cloud files`);
      for (const w of warnings) toast(w, true);
    } catch (e: any) {
      toast(`Could not save to the cloud: ${String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, true);
    }
  }
  cloudPanel() {
    return openCloudPanel({
      api,
      openPaths: (p) => this.openPaths(p),
      hasActive: () => !!this.active,
      saveActive: async () => { if (this.active) await this.saveToCloud(this.active); },
    });
  }

  async undo(redo = false) {
    const t = this.active; if (!t) return;
    if (document.activeElement && (document.activeElement as HTMLElement).isContentEditable) return;
    this.editor.select(null);
    const r = redo ? await t.redo() : await t.undo();
    if (r === null) return;
    if (r) await this.rebuildView(t); else this.editor.refresh();
    this.onDocChanged();
  }

  async rebuildView(t: DocTab) {
    const v = this.views.get(t.id)!;
    const keep = t.currentPage;
    v.build();
    await this.thumbs.show(t);
    v.scrollToPage(Math.min(keep, t.pages.length - 1));
    this.editor.setTool(this.editor.tool);
    this.onDocChanged();
  }

  // ---- page operations ----
  targetPages(): number[] {
    const t = this.active!;
    return t.selectedPages.size ? [...t.selectedPages].sort((a, b) => a - b) : [t.currentPage];
  }

  async runOp(fn: () => Promise<void>) {
    if (this.busy || !this.active) return;
    this.busy = true;
    try { this.editor.select(null); await fn(); }
    catch (e: any) { console.error(e); toast(`Operation failed: ${e?.message || e}`, true); }
    finally { this.busy = false; }
  }

  reorder(from: number[], to: number) {
    return this.runOp(async () => {
      const t = this.active!;
      let order: number[] = [];
      await applyDocChange(t, (d) => { order = reorderPages(d, from, to); });
      const moved = new Set(from);
      t.selectedPages = new Set(order.map((o, i) => (moved.has(o) ? i : -1)).filter((i) => i >= 0));
      t.currentPage = [...t.selectedPages][0] ?? 0;
      await this.rebuildView(t);
    });
  }
  rotate(pages: number[], deg: number) {
    return this.runOp(async () => {
      const t = this.active!;
      await applyDocChange(t, (d) => rotatePages(d, pages, deg));
      await this.rebuildView(t);
    });
  }
  deletePages(pages: number[]) {
    return this.runOp(async () => {
      const t = this.active!;
      if (pages.length >= t.pages.length) { toast('A document needs at least one page', true); return; }
      const r = await modal('Delete pages', `Delete ${pages.length === 1 ? `page ${pages[0] + 1}` : `${pages.length} pages`}? You can undo this.`, [
        { label: 'Cancel', value: 'cancel' }, { label: 'Delete', kind: 'danger', value: 'ok' }]);
      if (r !== 'ok') return;
      await applyDocChange(t, (d) => deletePages(d, pages));
      t.selectedPages.clear();
      t.currentPage = Math.min(pages[0], t.pages.length - 1);
      await this.rebuildView(t);
    });
  }
  insertBlankAfter(after: number) {
    return this.runOp(async () => {
      const t = this.active!;
      await applyDocChange(t, (d) => insertBlank(d, after));
      t.currentPage = after + 1;
      await this.rebuildView(t);
    });
  }
  extract() {
    return this.runOp(async () => {
      const t = this.active!;
      const pages = this.targetPages();
      const path = await api.saveDialog(t.name.replace(/\.pdf$/i, '') + '_extract.pdf');
      if (!path) return;
      await api.writeFile(path, await extractPages(t, pages));
      toast(`Extracted ${pages.length} page${pages.length > 1 ? 's' : ''} to ${baseName(path)}`);
    });
  }
  merge() {
    return this.runOp(async () => {
      const t = this.active!;
      const paths = await api.openDialog(true);
      if (!paths.length) return;
      const files = await Promise.all(paths.map((p) => api.readFile(p)));
      await applyDocChange(t, (d) => appendPdfs(d, files));
      t.currentPage = Math.max(0, t.pages.length - 1);
      await this.rebuildView(t);
      toast(`Merged ${paths.length} file${paths.length > 1 ? 's' : ''} (appended at the end)`);
    });
  }
  split() {
    return this.runOp(async () => {
      const t = this.active!;
      const n = t.pages.length;
      const wrap = el('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:380px';
      wrap.innerHTML = `
        <label class="chk"><input type="radio" name="sm" value="every" checked> Split every <input id="sn" type="number" min="1" max="${n}" value="1" style="width:60px"> page(s)</label>
        <label class="chk"><input type="radio" name="sm" value="ranges"> Custom ranges <input id="sr" placeholder="e.g. 1-3, 4, 5-8" style="flex:1"></label>
        <span>Document has ${n} pages. Each part is saved as its own PDF.</span>`;
      const r = await modal('Split document', wrap, [{ label: 'Cancel', value: 'cancel' }, { label: 'Choose folder & split', kind: 'primary', value: 'ok' }]);
      if (r !== 'ok') return;
      const mode = (wrap.querySelector('input[name=sm]:checked') as HTMLInputElement).value;
      let groups: number[][] | null;
      if (mode === 'every') {
        const k = Math.max(1, Number((wrap.querySelector('#sn') as HTMLInputElement).value) || 1);
        groups = [];
        for (let i = 0; i < n; i += k) groups.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j));
      } else groups = parseRanges((wrap.querySelector('#sr') as HTMLInputElement).value, n);
      if (!groups) { toast('Invalid page ranges', true); return; }
      const folder = await api.folderDialog();
      if (!folder) return;
      const files = await splitDoc(t, groups, t.name.replace(/\.pdf$/i, ''));
      await api.writeMany(folder, files);
      toast(`Created ${files.length} files in ${folder}`);
    });
  }

  pagesMenu(b: HTMLElement) {
    if (!this.active) return;
    const r = b.getBoundingClientRect();
    const pg = this.targetPages();
    const label = pg.length === 1 ? `page ${pg[0] + 1}` : `${pg.length} pages`;
    showMenu([
      { label: `Rotate left (${label})`, icon: 'rotl', action: () => this.rotate(pg, -90) },
      { label: `Rotate right (${label})`, icon: 'rotr', action: () => this.rotate(pg, 90) },
      { label: `Delete ${label}`, icon: 'trash', action: () => this.deletePages(pg) },
      { sep: true },
      { label: 'Insert blank page after current', icon: 'addpage', action: () => this.insertBlankAfter(this.active!.currentPage) },
      { label: `Extract ${label}…`, icon: 'extract', action: () => this.extract() },
      { sep: true },
      { label: 'Merge PDFs into this document…', icon: 'merge', action: () => this.merge() },
      { label: 'Split document…', icon: 'split', action: () => this.split() },
    ], r.left, r.bottom + 4);
  }

  /** Install a downloaded update, making sure the user does not lose unsaved work. */
  async restartForUpdate(): Promise<void> {
    const dirty = this.tabs.filter((t) => t.dirty);
    if (dirty.length) {
      const r = await modal('Save your work first', `You have unsaved changes in ${dirty.length} document${dirty.length > 1 ? 's' : ''}:<br><b>${dirty.map((t) => esc(t.name)).join('<br>')}</b>`, [
        { label: 'Cancel', value: 'cancel' }, { label: "Don't save, restart", kind: 'danger', value: 'no' }, { label: 'Save all & restart', kind: 'primary', value: 'yes' },
      ]);
      if (r === 'cancel') return;
      if (r === 'yes') for (const t of dirty) { if (!(await this.saveTab(t, false))) return; }
    }
    api.installUpdate();
  }

  // ---- update pop-up: opens the moment an update is found, shows the download, then offers "Restart now" ----
  private upPop: { bg: HTMLElement; title: HTMLElement; msg: HTMLElement; bar: HTMLElement; fill: HTMLElement; notes: HTMLElement; now: HTMLButtonElement; later: HTMLButtonElement } | null = null;
  private upDismissed = '';
  private upReady = false;

  private openUpdatePopup(version: string, notes?: string) {
    if (this.upPop || this.upDismissed === version) return;
    const bg = el('div', 'modal-bg'); const m = el('div', 'modal');
    const title = el('h2', '', {}, 'Update available'); m.appendChild(title);
    const body = el('div', 'body');
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:360px;max-width:480px';
    body.innerHTML = `<div style="display:flex;align-items:center;gap:12px"><div style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:26px;height:26px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg></div><div><div style="color:var(--text);font-size:15px;font-weight:600">PdfStudio ${esc(version)} is available</div><div data-k="msg">Downloading the update…</div></div></div><div data-k="bar" style="height:6px;border-radius:3px;background:var(--line);overflow:hidden"><div data-k="fill" style="height:100%;width:0%;background:var(--accent2);transition:width .3s"></div></div><div data-k="notes" style="background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;white-space:pre-wrap;max-height:160px;overflow:auto;display:none"></div>`;
    m.appendChild(body);
    const f = el('div', 'footer');
    const later = el('button', 'btn', {}, 'Later') as HTMLButtonElement;
    const now = el('button', 'btn primary', {}, 'Restart now') as HTMLButtonElement; now.disabled = true;
    f.appendChild(later); f.appendChild(now); m.appendChild(f); bg.appendChild(m);
    document.getElementById('modal-root')!.appendChild(bg);
    const close = () => { this.upDismissed = version; bg.remove(); this.upPop = null; document.removeEventListener('keydown', onKey, true); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    later.onclick = close;
    now.onclick = async () => { close(); await this.restartForUpdate(); };
    this.upPop = { bg, title, msg: body.querySelector('[data-k=msg]') as HTMLElement, bar: body.querySelector('[data-k=bar]') as HTMLElement, fill: body.querySelector('[data-k=fill]') as HTMLElement, notes: body.querySelector('[data-k=notes]') as HTMLElement, now, later };
    if (notes) { this.upPop.notes.textContent = "What's new\n" + notes; this.upPop.notes.style.display = ''; }
    if (this.upReady) this.updateReady(version, notes);
  }

  /** An update was found (shown right away, even while it downloads). */
  updateFound(version: string, notes?: string) { this.upReady = false; this.openUpdatePopup(version, notes); }

  updateProgress(percent: number | undefined) {
    if (!this.upPop || this.upReady) return;
    this.upPop.fill.style.width = `${Math.max(2, Math.min(100, percent || 0))}%`;
    this.upPop.msg.textContent = `Downloading the update… ${percent || 0}%`;
  }

  /** The update has finished downloading: offer to restart. */
  updateReady(version: string, notes?: string) {
    this.upReady = true;
    if (!this.upPop) { this.openUpdatePopup(version, notes); return; }
    const p = this.upPop;
    p.title.textContent = 'Update ready to install';
    p.msg.textContent = 'It has been downloaded. Restart now to finish, or choose Later - it installs automatically the next time you close PdfStudio.';
    p.fill.style.width = '100%';
    if (notes && !p.notes.textContent) { p.notes.textContent = "What's new\n" + notes; p.notes.style.display = ''; }
    p.now.disabled = false; p.now.focus();
  }

  // ---- images & signatures ----
  async makeAsset(bytes: Uint8Array): Promise<{ id: string; w: number; h: number } | null> {
    let mime: 'image/png' | 'image/jpeg' = 'image/png';
    let data = bytes;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    let blob = new Blob([bytes as BlobPart]);
    let bmp: ImageBitmap;
    try { bmp = await createImageBitmap(blob); } catch { toast('Unsupported image file', true); return null; }
    if (isJpg) mime = 'image/jpeg';
    else if (!isPng) {
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
      data = new Uint8Array(await blob.arrayBuffer());
    }
    const id = uid('img');
    this.active!.assets.set(id, { bytes: data, mime, url: URL.createObjectURL(new Blob([data as BlobPart], { type: mime })) });
    return { id, w: bmp.width, h: bmp.height };
  }

  startPlacing(a: { id: string; w: number; h: number }, targetW: number, repeat = false) {
    const t = this.active!;
    const pageW = t.pages[t.currentPage]?.w ?? 600;
    const w = Math.min(targetW, pageW * 0.6);
    this.editor.pending = { asset: a.id, w, h: w * (a.h / a.w), repeat };
    this.editor.setTool('place');
    toast('Click on the page to place it (or drag to size it). Esc cancels.');
  }

  async insertImage() {
    if (!this.active) return;
    const f = await api.imageDialog();
    if (!f) return;
    const a = await this.makeAsset(f.bytes);
    if (a) this.startPlacing(a, 260);
  }

  async sign(kind: SigKind = 'signature') {
    if (!this.active) return;
    const url = await getSignature(kind);
    if (!url) return;
    const a = await this.makeAsset(await dataUrlToBytes(url));
    if (a) this.startPlacing(a, kind === 'initials' ? 80 : 170, false);
  }

  signMenu(b: HTMLElement) {
    const r = b.getBoundingClientRect();
    const has = !!this.active;
    showMenu([
      { label: 'Add signature…', icon: 'sign', action: () => this.sign('signature'), disabled: !has },
      { label: 'Add initials…', icon: 'type', action: () => this.sign('initials'), disabled: !has },
      { sep: true },
      { label: 'Send for others to sign…', icon: 'sign', action: () => { void startSend(this); }, disabled: !has },
      { label: 'Signing requests…', icon: 'open', action: () => { void requestsPanel(this); } },
    ], r.left, r.bottom + 4);
  }
}

const app = new App();
window.app = app;

function bind() {
  hydrateIcons();
  const actions: Record<string, (b: HTMLElement) => void> = {
    open: () => app.openDialog(),
    newBlank: () => app.newBlank(),
    save: () => app.save(false),
    saveAs: () => app.save(true),
    cloud: () => app.cloudPanel(),
    undo: () => app.undo(false),
    redo: () => app.undo(true),
    zoomIn: () => app.zoomBy(1.2),
    zoomOut: () => app.zoomBy(1 / 1.2),
    search: () => app.openSearch(),
    searchClose: () => app.closeSearch(),
    searchNext: () => app.stepSearch(1),
    searchPrev: () => app.stepSearch(-1),
    prevPage: () => app.view?.scrollToPage(Math.max(0, (app.active?.currentPage ?? 0) - 1)),
    nextPage: () => app.view?.scrollToPage(Math.min((app.active?.pages.length ?? 1) - 1, (app.active?.currentPage ?? 0) + 1)),
    image: () => app.insertImage(),
    sign: (b) => app.signMenu(b),
    pagesMenu: (b) => app.pagesMenu(b),
  };
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tool = t.closest('[data-tool]') as HTMLElement | null;
    if (tool) {
      const name = tool.dataset.tool as ToolName;
      app.editor.setTool(app.editor.tool === name && name !== 'select' ? 'select' : name);
      return;
    }
    const b = t.closest('[data-action]') as HTMLElement | null;
    if (b && actions[b.dataset.action!]) actions[b.dataset.action!](b);
  });

  ($('#zoomSelect') as HTMLSelectElement).onchange = (e) => app.setZoomMode((e.target as HTMLSelectElement).value);
  const pi = $('#pageInput') as HTMLInputElement;
  pi.onchange = () => { const n = Number(pi.value) - 1; if (app.active && n >= 0 && n < app.active.pages.length) app.view!.scrollToPage(n); };
  const si = $('#searchInput') as HTMLInputElement;
  si.oninput = () => { clearTimeout(app.searchTimer); app.searchTimer = window.setTimeout(() => app.runSearch(), 200); };
  si.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); app.stepSearch(e.shiftKey ? -1 : 1); } };
  ($('#searchCase') as HTMLInputElement).onchange = () => app.runSearch();

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-bg')) return;
    const inField = !!(e.target as HTMLElement).matches?.('input,textarea,select,[contenteditable=true]');
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (!ctrl) {
      if (e.key === 'Escape' && !$('#searchbar').classList.contains('hidden')) app.closeSearch();
      return;
    }
    if (k === 'o') { e.preventDefault(); app.openDialog(); }
    else if (k === 'n') { e.preventDefault(); app.newBlank(); }
    else if (k === 's') { e.preventDefault(); app.save(e.shiftKey); }
    else if (k === 'f') { e.preventDefault(); app.openSearch(); }
    else if (k === 'z' && !inField) { e.preventDefault(); app.undo(e.shiftKey); }
    else if (k === 'y' && !inField) { e.preventDefault(); app.undo(true); }
    else if (e.key === '=' || e.key === '+') { e.preventDefault(); app.zoomBy(1.2); }
    else if (e.key === '-') { e.preventDefault(); app.zoomBy(1 / 1.2); }
    else if (e.key === '0') { e.preventDefault(); app.setZoomMode('fitwidth'); }
    else if (k === 'w') { e.preventDefault(); if (app.active) app.closeTab(app.active); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      if (app.tabs.length > 1) { const i = app.tabs.indexOf(app.active!); app.activate(app.tabs[(i + (e.shiftKey ? -1 : 1) + app.tabs.length) % app.tabs.length]); }
    }
  });
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey && app.active) { e.preventDefault(); app.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }
  }, { passive: false });

  const drop = $('#dropOverlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; drop.classList.remove('hidden'); } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    depth = 0; drop.classList.add('hidden');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter((p) => /\.pdf$/i.test(p));
    if (paths.length) await app.openPaths(paths);
  });

  // ---- auto-update ----
  const upBtn = $('#stUpdate') as HTMLButtonElement, upTxt = $('#stUpdateText');
  const tbBtn = $('#tbUpdate') as HTMLButtonElement, tbTxt = $('#tbUpdateText'), dot = $('#updDot');
  let upReady = false;
  api.version().then((v) => { $('#stVer').textContent = `v${v}`; $('#stVer').style.marginLeft = '10px'; tbBtn.title = `Check for updates (you have v${v})`; });
  const clickUpdate = () => { if (upReady) app.restartForUpdate(); else api.checkUpdates(); };
  upBtn.onclick = clickUpdate;
  tbBtn.onclick = (e) => { e.stopPropagation(); clickUpdate(); };
  const setBusy = (b: boolean) => tbBtn.classList.toggle('busy', b);
  const onUpdate = (m: { state: string; version?: string; percent?: number; message?: string; notes?: string }) => {
    setBusy(m.state === 'checking' || m.state === 'available' || m.state === 'downloading');
    switch (m.state) {
      case 'checking': upTxt.textContent = 'Checking…'; tbTxt.textContent = 'Checking…'; break;
      case 'available': upTxt.textContent = `Downloading v${m.version}…`; tbTxt.textContent = 'Downloading…'; app.updateFound(`v${m.version}`, m.notes); break;
      case 'downloading': upTxt.textContent = `Downloading update ${m.percent}%`; tbTxt.textContent = `${m.percent}%`; app.updateProgress(m.percent); break;
      case 'none': upTxt.textContent = 'Check for updates'; tbTxt.textContent = 'Updates'; toast('You are on the latest version'); break;
      case 'error': upTxt.textContent = 'Check for updates'; tbTxt.textContent = 'Updates'; toast(`Update check failed: ${m.message}`, true); break;
      case 'ready':
        upReady = true; upTxt.textContent = `Restart to update to v${m.version}`; upBtn.style.color = 'var(--accent2)';
        tbTxt.textContent = 'Restart to update'; tbBtn.classList.add('ready'); dot.classList.remove('hidden');
        tbBtn.title = `Update v${m.version} is ready - click to restart and install`;
        app.updateReady(`v${m.version}`, m.notes);
        break;
    }
  };
  api.onUpdate(onUpdate);
  ((window as any).__dbg ||= {}).fakeUpdate = onUpdate;
  new ResizeObserver(() => app.view?.refit()).observe($('#stage'));
  api.onOpenFiles((f) => app.openPaths(f));
  api.onCloudEvent((e) => {
    if (e.pending !== undefined) $('#stCloud').textContent = e.pending ? `Cloud: ${e.pending} waiting to sync` : '';
    if (e.message) toast(e.message, e.type === 'error');
  });
  api.onCloseRequest(async () => {
    for (const t of [...app.tabs]) { if (t.dirty && !(await app.closeTab(t))) return; }
    api.confirmClose();
  });
}

type AuthSt = Awaited<ReturnType<typeof api.authStatus>>;

function showAccount(st: AuthSt) {
  const el = $('#stLic');
  el.textContent = '';
  const who = document.createElement('span');
  who.textContent = `Signed in as ${st.username}` + (st.offline ? ` (offline - reconnect within ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'})` : '');
  const out = document.createElement('button');
  out.className = 'tb small';
  out.textContent = 'Sign out';
  out.onclick = signOut;
  el.append(who, out);

  // Account button, top right
  const btn = $('#acctBtn') as HTMLButtonElement;
  const name = st.username || 'Account';
  btn.classList.remove('hidden');
  btn.title = `Account: ${name}`;
  btn.innerHTML = `<span class="av"></span><span class="nm"></span>`;
  btn.querySelector('.av')!.textContent = name.charAt(0).toUpperCase();
  btn.querySelector('.nm')!.textContent = name;
  btn.onclick = () => {
    const r = btn.getBoundingClientRect();
    const items: MenuItem[] = [{ label: `Signed in as ${name}`, disabled: true }];
    if (st.offline) items.push({ label: `Offline: reconnect within ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'}`, disabled: true });
    items.push({ sep: true }, { label: 'My cloud files', icon: 'cloud', action: () => app.cloudPanel() }, { label: 'Switch app', icon: 'apps', action: () => appsMenu() }, { label: 'Sign out', icon: 'logout', action: signOut });
    showMenu(items, r.right - 220, r.bottom + 4);
  };
}

// Same list as the Apps button on the other trivedipos.com apps (worker/apps-switcher.txt).
const SITE = 'https://trivedipos.com';
const SITE_APPS: { name: string; path: string; icon?: string; current?: boolean }[] = [
  { name: 'Home: all apps', path: '/', icon: 'home' },
  { name: 'Ledger Desk (accounting)', path: '/books/' },
  { name: 'Hotel Desk (front desk)', path: '/hotel/' },
  { name: 'Store POS (back office)', path: '/pos/' },
  { name: 'PdfStudio (you are here)', path: '/pdfstudio/', current: true },
];
function openSiteApp(path: string) {
  if (location.protocol.startsWith('http')) location.href = path;   // web: same tab, so the browser Back button works
  else window.open(SITE + path);                                    // desktop app: opens in the default browser
}
function appsMenu() {
  const b = $('#appsBtn').getBoundingClientRect();
  showMenu(SITE_APPS.map((a) => ({ label: a.name, icon: a.icon, disabled: a.current, action: () => openSiteApp(a.path) })), b.left, b.bottom + 4);
}
$('#appsBtn').onclick = appsMenu;

async function signOut() {
  if (app.tabs.some((t) => t.dirty) && !confirm('You have unsaved changes. Sign out anyway?')) return;
  await api.logout();
}

let prompting: Promise<void> | null = null;
function promptLogin(message?: string): Promise<void> {
  if (prompting) return prompting;
  prompting = new Promise<void>((resolve) => {
    const lock = $('#lock');
    const form = $('#lockForm') as HTMLFormElement;
    const err = $('#lockErr'), go = $('#lockGo') as HTMLButtonElement;
    const user = $('#lockUser') as HTMLInputElement, pass = $('#lockPass') as HTMLInputElement;
    lock.classList.remove('hidden');
    err.textContent = message || '';
    pass.value = '';
    const code = $('#lockCode') as HTMLInputElement, pwRows = $('#lockPwRows'), codeRows = $('#lockCodeRows');
    const sub = $('#lockSub');
    let ticket: string | null = null;
    const reset2fa = () => { ticket = null; pwRows.classList.remove('hidden'); codeRows.classList.add('hidden'); code.value = ''; sub.textContent = 'Use your Ledger Desk username and password.'; };
    reset2fa();
    $('#lockResend').onclick = async () => {
      if (!ticket) return;
      const r = await api.login2faEmail(ticket);
      err.textContent = r.ok ? `We emailed a new code to ${r.to || 'you'}.` : r.error || 'Could not send a code.';
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!ticket && (!user.value.trim() || !pass.value)) { err.textContent = 'Enter your username and password.'; return; }
      if (ticket && !code.value.trim()) { err.textContent = 'Enter the 6-digit code.'; return; }
      err.textContent = '';
      go.disabled = true;
      const r = ticket ? await api.login2fa(ticket, code.value) : await api.login(user.value, pass.value);
      go.disabled = false;
      if (r.signedIn) {
        pass.value = '';
        reset2fa();
        lock.classList.add('hidden');
        showAccount(r);
        prompting = null;
        resolve();
      } else if (r.need2fa && r.ticket) {
        ticket = r.ticket;
        pwRows.classList.add('hidden'); codeRows.classList.remove('hidden');
        $('#lockResend').classList.toggle('hidden', !r.canEmail);
        sub.textContent = r.need2fa === 'email' ? `We emailed a 6-digit code to ${r.to || 'you'}.` : r.need2fa === 'app' ? 'Enter the 6-digit code from your authenticator app.' : 'Two-step sign-in is required. Set it up in Ledger Desk first, then sign in here.';
        code.focus();
      } else {
        err.textContent = r.error || 'Sign-in failed.';
        if (ticket && /Sign in again|Too many/.test(r.error || '')) reset2fa();
      }
    };
    (user.value ? pass : user).focus();
  });
  return prompting;
}

async function ensureSignedIn(): Promise<void> {
  const st = await api.authStatus();
  if (st.signedIn) { showAccount(st); return; }
  await promptLogin(st.error);
}
async function main() {
  bind();
  await ensureSignedIn();
  api.onAuthChanged((s) => {
    if (s.signedIn) { showAccount(s); return; }
    $('#stLic').textContent = '';
    $('#acctBtn').classList.add('hidden');
    promptLogin(s.error || 'You have been signed out. Sign in to continue.');
  });
  app.renderTabs();
  app.updateUi();
  app.syncToolbar();
  app.editor.buildOptions();
  app.refreshRecent();
  const files = await api.initFiles();
  if (files.length) await app.openPaths(files);
}
main();

(window as any).__dbg = Object.assign((window as any).__dbg || {}, { buildPdf });
