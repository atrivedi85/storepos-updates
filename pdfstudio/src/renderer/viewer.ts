import { DocTab, pdfjsLib } from './doc';
import { el } from './util';
import type { Box } from './types';

/** hooks implemented by the editor (annotations/forms/tools) */
export interface PageHooks {
  pageCreated(pv: PageView): void;
  pageLaidOut(pv: PageView): void;
  pageRendered(pv: PageView): void;
}

const MAX_CANVAS_PIXELS = 24_000_000;

export class PageView {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  searchLayer: HTMLDivElement;
  formLayer: HTMLDivElement;
  objLayer: HTMLDivElement;
  capLayer: HTMLDivElement;
  rendered = false;
  renderedKey = '';
  private task: any = null;
  private tl: any = null;
  private token = 0;
  visible = false;

  constructor(public view: DocView, public index: number) {
    this.el = el('div', 'page');
    this.el.dataset.page = String(index);
    this.canvas = el('canvas', 'pcanvas');
    this.textLayer = el('div', 'textLayer');
    this.searchLayer = el('div', 'layer searchLayer');
    this.formLayer = el('div', 'layer formLayer');
    this.objLayer = el('div', 'layer objLayer');
    this.capLayer = el('div', 'capLayer');
    this.el.append(this.canvas, this.searchLayer, this.textLayer, this.formLayer, this.objLayer, this.capLayer);
  }

  get tab() { return this.view.tab; }
  get info() { return this.tab.pages[this.index]; }
  get zoom() { return this.tab.zoom; }

  layout() {
    const z = this.zoom, { w, h } = this.info;
    this.el.style.width = `${w * z}px`;
    this.el.style.height = `${h * z}px`;
    this.el.style.setProperty('--total-scale-factor', String(z));
    this.el.style.setProperty('--scale-factor', String(z));
    for (const l of [this.searchLayer, this.formLayer, this.objLayer]) {
      l.style.width = `${w}px`; l.style.height = `${h}px`;
      l.style.transform = `scale(${z})`;
    }
    this.canvas.style.width = `${w * z}px`;
    this.canvas.style.height = `${h * z}px`;
    this.view.hooks.pageLaidOut(this);
  }

  /** client coords -> page coords at scale 1 (view space) */
  toPage(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  async render() {
    const key = `${this.tab.version}:${this.zoom}:${window.devicePixelRatio}`;
    if (this.rendered && this.renderedKey === key) return;
    const token = ++this.token;
    this.task?.cancel?.();
    try {
      const page = await this.tab.getPage(this.index);
      if (token !== this.token) return;
      const dpr = window.devicePixelRatio || 1;
      let scale = this.zoom * dpr;
      const { w, h } = this.info;
      if (w * h * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.className = 'pcanvas';
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.style.width = `${w * this.zoom}px`; c.style.height = `${h * this.zoom}px`;
      this.task = page.render({ canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS } as any);
      await this.task.promise;
      if (token !== this.token) return;
      this.canvas.replaceWith(c);
      this.canvas = c;
      this.rendered = true; this.renderedKey = key;
      // text layer
      this.textLayer.replaceChildren();
      const tvp = page.getViewport({ scale: this.zoom });
      this.tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: this.textLayer, viewport: tvp });
      await this.tl.render();
      this.view.hooks.pageRendered(this);
    } catch (e: any) {
      if (e?.name !== 'RenderingCancelledException') console.error('render error', e);
    }
  }

  release() {
    this.token++;
    this.task?.cancel?.();
    if (this.rendered) {
      this.canvas.width = 1; this.canvas.height = 1;
      this.textLayer.replaceChildren();
      this.rendered = false; this.renderedKey = '';
    }
  }

  setSearch(hits: { box: Box; cur: boolean }[]) {
    this.searchLayer.replaceChildren();
    for (const h of hits) {
      const d = el('div', 'hit' + (h.cur ? ' cur' : ''));
      d.style.cssText = `left:${h.box.x}px;top:${h.box.y}px;width:${h.box.w}px;height:${h.box.h}px`;
      this.searchLayer.appendChild(d);
    }
  }
}

export class DocView {
  root = el('div', 'docview');
  inner = el('div', 'docinner');
  pages: PageView[] = [];
  private io!: IntersectionObserver;
  onPageChange?: (page: number) => void;
  private scrollRaf = 0;
  private zoomTimer = 0;

  constructor(public tab: DocTab, public hooks: PageHooks) {
    this.root.appendChild(this.inner);
    this.root.addEventListener('scroll', () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => { this.scrollRaf = 0; this.updateCurrent(); });
    });
  }

  build() {
    this.io?.disconnect();
    this.inner.replaceChildren();
    this.pages = [];
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const pv = this.pages[Number((en.target as HTMLElement).dataset.page)];
        if (!pv) continue;
        pv.visible = en.isIntersecting;
        if (en.isIntersecting) pv.render(); else pv.release();
      }
    }, { root: this.root, rootMargin: '900px 0px' });
    this.applyZoomMode();
    for (let i = 0; i < this.tab.pages.length; i++) {
      const pv = new PageView(this, i);
      this.pages.push(pv);
      this.inner.appendChild(pv.el);
      this.hooks.pageCreated(pv);
      pv.layout();
      this.io.observe(pv.el);
    }
  }

  applyZoomMode() {
    const t = this.tab;
    if (typeof t.zoomMode === 'number') { t.zoom = t.zoomMode; return; }
    const info = t.pages[Math.min(t.currentPage, t.pages.length - 1)] || { w: 612, h: 792 };
    const availW = Math.max(100, this.root.clientWidth - (this.root.clientWidth <= 600 ? 16 : 48));
    const availH = Math.max(100, this.root.clientHeight - 36);
    t.zoom = t.zoomMode === 'fitwidth' ? availW / info.w : Math.min(availW / info.w, availH / info.h);
    t.zoom = Math.max(0.1, Math.min(6, t.zoom));
  }

  setZoom(mode: DocTab['zoomMode']) {
    const t = this.tab;
    const anchorPage = t.currentPage;
    const pv = this.pages[anchorPage];
    // keep relative scroll position inside current page
    const frac = pv ? (this.root.scrollTop - pv.el.offsetTop + 18) / Math.max(1, pv.el.offsetHeight) : 0;
    t.zoomMode = mode;
    this.applyZoomMode();
    for (const p of this.pages) { p.layout(); p.rendered = false; p.renderedKey = ''; }
    if (pv) this.root.scrollTop = pv.el.offsetTop - 18 + frac * pv.el.offsetHeight;
    clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.pages.forEach((p) => p.visible && p.render()), 120);
  }

  refit() {
    if (typeof this.tab.zoomMode !== 'number') this.setZoom(this.tab.zoomMode);
  }

  updateCurrent() {
    const mid = this.root.scrollTop + this.root.clientHeight * 0.35;
    let cur = 0;
    for (const p of this.pages) {
      if (p.el.offsetTop - 7 <= mid) cur = p.index; else break;
    }
    if (cur !== this.tab.currentPage) {
      this.tab.currentPage = cur;
      this.onPageChange?.(cur);
    }
  }

  scrollToPage(i: number, y = 0) {
    const pv = this.pages[i];
    if (!pv) return;
    this.root.scrollTop = pv.el.offsetTop - 14 + y * this.tab.zoom;
    this.tab.currentPage = i;
    this.onPageChange?.(i);
  }

  scrollToBox(i: number, b: Box) {
    const pv = this.pages[i];
    if (!pv) return;
    const top = pv.el.offsetTop + b.y * this.tab.zoom;
    const view = this.root;
    if (top < view.scrollTop + 60 || top > view.scrollTop + view.clientHeight - 100) {
      view.scrollTop = top - view.clientHeight / 3;
    }
    const left = pv.el.offsetLeft + b.x * this.tab.zoom;
    if (left < view.scrollLeft || left > view.scrollLeft + view.clientWidth - 60) view.scrollLeft = left - view.clientWidth / 3;
  }

  destroy() { this.io?.disconnect(); this.root.remove(); }
}
