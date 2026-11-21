import type { DocTab } from './doc';
import { el } from './util';
import { icon } from './icons';

export interface ThumbHandlers {
  goto(i: number): void;
  reorder(from: number[], to: number): void;
  rotate(pages: number[], deg: number): void;
  del(pages: number[]): void;
  insertBlank(after: number): void;
}

export class Thumbs {
  private items: HTMLElement[] = [];
  private io?: IntersectionObserver;
  private tab: DocTab | null = null;
  private lastClicked = 0;

  constructor(private root: HTMLElement, private h: ThumbHandlers) {}

  async show(tab: DocTab | null) {
    this.tab = tab;
    this.io?.disconnect();
    this.root.replaceChildren();
    this.items = [];
    if (!tab) return;
    this.io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { this.io!.unobserve(e.target); this.draw(e.target as HTMLElement); }
    }, { root: this.root, rootMargin: '400px' });
    const maxW = 140;
    tab.pages.forEach((p, i) => {
      const t = el('div', 'thumb');
      t.dataset.i = String(i);
      t.draggable = true;
      const hgt = Math.round((p.h / p.w) * maxW);
      const holder = el('div');
      holder.style.cssText = `width:${maxW}px;height:${hgt}px;background:#fff;box-shadow:0 2px 8px #0006`;
      holder.className = 'tph';
      const tools = el('div', 'tools');
      const mk = (ic: string, title: string, fn: () => void) => {
        const b = el('button', '', { title }, icon(ic));
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        b.draggable = false;
        tools.appendChild(b);
      };
      const sel = () => (tab.selectedPages.has(i) ? [...tab.selectedPages].sort((a, b) => a - b) : [i]);
      mk('rotl', 'Rotate left', () => this.h.rotate(sel(), -90));
      mk('rotr', 'Rotate right', () => this.h.rotate(sel(), 90));
      mk('addpage', 'Insert blank page after', () => this.h.insertBlank(i));
      mk('trash', 'Delete', () => this.h.del(sel()));
      t.append(holder, el('div', 'tnum', {}, String(i + 1)), tools);
      t.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          tab.selectedPages.has(i) ? tab.selectedPages.delete(i) : tab.selectedPages.add(i);
        } else if (e.shiftKey) {
          const [a, b] = [Math.min(this.lastClicked, i), Math.max(this.lastClicked, i)];
          tab.selectedPages.clear();
          for (let k = a; k <= b; k++) tab.selectedPages.add(k);
        } else {
          tab.selectedPages.clear(); tab.selectedPages.add(i);
          this.h.goto(i);
        }
        this.lastClicked = i;
        this.refreshState();
      });
      t.addEventListener('dragstart', (e) => {
        const pages = tab.selectedPages.has(i) ? [...tab.selectedPages] : [i];
        e.dataTransfer!.setData('application/x-pdfstudio-pages', JSON.stringify(pages));
        e.dataTransfer!.effectAllowed = 'move';
        t.classList.add('dragging');
      });
      t.addEventListener('dragend', () => { t.classList.remove('dragging'); this.clearDrop(); });
      t.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('application/x-pdfstudio-pages')) return;
        e.preventDefault();
        this.clearDrop();
        const r = t.getBoundingClientRect();
        t.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
      });
      t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
      t.addEventListener('drop', (e) => {
        const data = e.dataTransfer?.getData('application/x-pdfstudio-pages');
        if (!data) return;
        e.preventDefault();
        const r = t.getBoundingClientRect();
        const to = e.clientY < r.top + r.height / 2 ? i : i + 1;
        this.clearDrop();
        this.h.reorder(JSON.parse(data), to);
      });
      this.root.appendChild(t);
      this.items.push(t);
      this.io!.observe(t);
    });
    this.refreshState();
  }

  private clearDrop() { this.items.forEach((t) => t.classList.remove('drop-before', 'drop-after')); }

  private async draw(t: HTMLElement) {
    const tab = this.tab;
    if (!tab) return;
    const i = Number(t.dataset.i);
    const ver = tab.version;
    try {
      const page = await tab.getPage(i);
      const maxW = 140;
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (maxW / base.width) * dpr });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.style.width = `${maxW}px`; c.style.height = `${Math.round((base.height / base.width) * maxW)}px`;
      await page.render({ canvas: c, viewport: vp } as any).promise;
      if (tab !== this.tab || ver !== tab.version) return;
      const holder = t.querySelector('.tph')!;
      holder.replaceChildren(c);
    } catch { /* ignore */ }
  }

  refreshState() {
    const tab = this.tab;
    if (!tab) return;
    this.items.forEach((t, i) => {
      t.classList.toggle('current', i === tab.currentPage);
      t.classList.toggle('selected', tab.selectedPages.has(i));
    });
  }

  setCurrent(i: number) {
    this.refreshState();
    this.items[i]?.scrollIntoView({ block: 'nearest' });
  }
}
