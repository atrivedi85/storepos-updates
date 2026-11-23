import type { App } from './app';
import type { PageView } from './viewer';
import type { Box, EraseObj, FontKey, InkObj, MarkupObj, NoteObj, Obj, ShapeObj, TextObj, ToolName, ImageObj, FieldObj, SignFieldObj } from './types';
import { el, uid, clamp, modal, esc, toast } from './util';
import { icon } from './icons';
import { renderFormFields } from './forms';

export const FONT_CSS: Record<FontKey, string> = {
  helv: 'Helvetica, Arial, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};
const CAP_TOOLS: ToolName[] = ['draw', 'shape', 'note', 'textbox', 'field', 'place', 'erase', 'signfield'];
/** one colour per signer in "Send for signature" */
export const SIGNER_COLORS = ['#e3a400', '#2f80ed', '#27ae60', '#e5484d', '#8e44ad', '#16a085', '#d35400', '#c2185b', '#5d6d7e', '#00838f'];
const SF_LABEL: Record<SignFieldObj['kind'], string> = { signature: 'Signature', initials: 'Initials', date: 'Date signed', text: 'Name' };
const SF_SIZE: Record<SignFieldObj['kind'], [number, number]> = { signature: [170, 42], initials: [70, 36], date: [110, 22], text: [170, 22] };
export interface EsignDraft { title: string; message: string; signers: { name: string; email: string }[]; cur: number; kind: SignFieldObj['kind'] }
const SWATCHES = ['#ffe14d', '#ff9f43', '#ff5d73', '#2ed573', '#19c3b1', '#4da3ff', '#7c5cff', '#111111', '#ffffff'];

export interface Options {
  hl: string; ul: string; st: string; stroke: string; fill: string; width: number;
  shape: ShapeObj['shape']; fontSize: number; fontColor: string; font: FontKey; bold: boolean; italic: boolean;
  fieldKind: FieldObj['kind']; noteColor: string; inkColor: string; eraseRemoveAnnots: boolean;
}

export class Editor {
  tool: ToolName = 'select';
  opt: Options = {
    hl: '#ffe14d', ul: '#ff5d73', st: '#ff5d73', stroke: '#e5384f', fill: '', width: 2, shape: 'rect',
    fontSize: 14, fontColor: '#111111', font: 'helv', bold: false, italic: false, fieldKind: 'text',
    noteColor: '#ffd84d', inkColor: '#2f6bff', eraseRemoveAnnots: true,
  };
  sel: { page: number; id: string } | null = null;
  /** image waiting to be placed (insert image / signature) */
  pending: { asset: string; w: number; h: number; repeat?: boolean } | null = null;
  /** "Send for signature" in progress (signers + which box type is being placed) */
  esign: EsignDraft | null = null;
  /** set by the esign module: opens the send dialog / signer list */
  onEsign: { send: () => void; editSigners: () => void; cancel: () => void } | null = null;
  private pvs = new Set<PageView>();

  constructor(private app: App) {
    document.addEventListener('selectionchange', () => { /* reserved */ });
    document.addEventListener('mouseup', (e) => this.onMouseUp(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  get tab() { return this.app.active; }

  // ---------------- page hooks ----------------
  attach(pv: PageView) {
    this.pvs.add(pv);
    pv.capLayer.addEventListener('pointerdown', (e) => this.capDown(pv, e));
    pv.el.addEventListener('pointerdown', (e) => this.pageDown(pv, e));
    pv.el.addEventListener('pointermove', (e) => this.pageMove(pv, e));
    pv.el.addEventListener('pointerleave', () => this.clearHover(pv));
    pv.el.addEventListener('click', (e) => this.pageClick(pv, e));
    this.applyToolClass(pv);
  }

  applyToolClass(pv: PageView) {
    const c = pv.el.classList;
    [...c].filter((x) => x.startsWith('tool-')).forEach((x) => c.remove(x));
    c.add('tool-' + this.tool);
    c.toggle('capture', CAP_TOOLS.includes(this.tool));
    c.toggle('notarget', this.tool !== 'select');
    c.toggle('hasfields-hl', this.tool === 'select' || this.tool === 'field');
  }

  setTool(t: ToolName) {
    if (t !== 'place') this.pending = null;
    this.tool = t;
    if (t !== 'select') this.select(null);
    for (const [, v] of this.app.views) v.pages.forEach((p) => this.applyToolClass(p));
    this.app.syncToolbar();
    this.buildOptions();
    window.getSelection()?.removeAllRanges();
  }

  // ---------------- rendering ----------------
  renderPage(pv: PageView) {
    const tab = pv.tab;
    pv.objLayer.replaceChildren();
    const list = tab.objects[pv.index] || [];
    for (const o of list) if (o.type === 'erase') this.mount(pv, o);
    for (const o of list) if (o.type !== 'erase') this.mount(pv, o);
    renderFormFields(this.app, pv);
    this.drawSelection(pv);
  }
  refresh(page?: number) {
    const v = this.app.view;
    if (!v) return;
    for (const pv of v.pages) if (page === undefined || pv.index === page) this.renderPage(pv);
    this.app.onDocChanged();
  }

  private mount(pv: PageView, o: Obj) {
    if (o.type === 'text' && o.cover) {
      const c = el('div', 'cover');
      c.dataset.for = o.id;
      c.style.cssText = `left:${o.cover.x}px;top:${o.cover.y}px;width:${o.cover.w}px;height:${o.cover.h}px;background:${o.cover.color}`;
      pv.objLayer.appendChild(c);
    }
    const e = this.buildEl(pv, o);
    pv.objLayer.appendChild(e);
  }

  private bbox(o: Obj): Box {
    if (o.type === 'markup') {
      const xs = o.rects.map((r) => r.x), ys = o.rects.map((r) => r.y);
      const x2 = o.rects.map((r) => r.x + r.w), y2 = o.rects.map((r) => r.y + r.h);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...x2) - x, h: Math.max(...y2) - y };
    }
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }

  private buildEl(pv: PageView, o: Obj): HTMLElement {
    const b = this.bbox(o);
    const e = el('div', 'obj ' + o.type);
    e.dataset.id = o.id;
    e.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
    switch (o.type) {
      case 'erase': {
        e.classList.add('movable');
        e.style.background = o.color;
        e.title = 'Erased area (select it to move, resize or delete)';
        break;
      }
      case 'markup': {
        e.classList.add('markup');
        for (const r of o.rects) {
          const d = el('div', 'rect');
          d.style.left = `${r.x - b.x}px`; d.style.top = `${r.y - b.y}px`; d.style.width = `${r.w}px`; d.style.height = `${r.h}px`;
          if (o.kind === 'highlight') { d.style.background = o.color; d.style.opacity = '.45'; d.style.mixBlendMode = 'multiply'; }
          else if (o.kind === 'underline') { d.style.borderBottom = `1.6px solid ${o.color}`; d.style.height = `${r.h - 1}px`; }
          else { d.style.background = `linear-gradient(${o.color},${o.color}) 0 50%/100% 1.6px no-repeat`; }
          e.appendChild(d);
        }
        break;
      }
      case 'ink': {
        e.classList.add('movable');
        const pts = o.pts.map(([px, py]) => `${(px * o.w).toFixed(2)},${(py * o.h).toFixed(2)}`).join(' ');
        e.innerHTML = `<svg width="${o.w}" height="${o.h}"><polyline points="${pts}" fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        break;
      }
      case 'shape': {
        e.classList.add('movable');
        e.innerHTML = this.shapeSvg(o);
        break;
      }
      case 'note': {
        e.classList.add('movable');
        e.title = o.text;
        e.innerHTML = `<svg viewBox="0 0 26 26"><path d="M2 2h22v16l-6 6H2z" fill="${o.color}" stroke="#a07a00" stroke-width="1.2"/><path d="M18 24v-6h6" fill="#0002" stroke="#a07a00" stroke-width="1.2"/><path d="M6 8h14M6 12h14" stroke="#7a5d00" stroke-width="1.4" stroke-linecap="round"/></svg>`;
        e.ondblclick = () => this.editNote(pv, o);
        break;
      }
      case 'text': {
        e.classList.add('movable');
        e.textContent = o.text;
        e.style.cssText += `;font-family:${o.orig ? `"${o.orig.css}", ` : ''}${FONT_CSS[o.font]};font-size:${o.size}px;color:${o.color};font-weight:${o.bold ? 700 : 400};font-style:${o.italic ? 'italic' : 'normal'};width:auto;min-width:${o.w}px;height:auto;min-height:${o.h}px`;
        e.ondblclick = (ev) => { ev.stopPropagation(); this.editText(pv, o, e); };
        break;
      }
      case 'image': {
        e.classList.add('movable');
        const a = pv.tab.assets.get(o.asset);
        e.innerHTML = `<img src="${a?.url || ''}" draggable="false" style="width:100%;height:100%;display:block;pointer-events:none">`;
        break;
      }
      case 'signfield': {
        e.classList.add('movable');
        const col = SIGNER_COLORS[o.signer % SIGNER_COLORS.length];
        const who = this.esign?.signers[o.signer]?.name || `Signer ${o.signer + 1}`;
        e.style.cssText += `;border:1.5px dashed ${col};background:${col}22;color:${col};font-size:10px;font-weight:700`;
        e.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.1;overflow:hidden"><span>${esc(o.label || SF_LABEL[o.kind])}<br><span style="font-weight:400">${esc(who)}</span></span></div>`;
        e.title = `${SF_LABEL[o.kind]} for ${who}`;
        break;
      }
      case 'field': {
        e.classList.add('movable', o.kind === 'check' ? 'check' : 'x');
        e.innerHTML = o.kind === 'check' ? icon('check').replace('<svg', '<svg style="width:70%;height:70%;position:static;stroke:#4a3bb0;fill:none;stroke-width:2.5"') : `<span>${esc(o.name)}${o.kind === 'dropdown' ? ' ▾' : ''}</span>`;
        e.title = `${o.kind} field "${o.name}"`;
        e.ondblclick = () => this.editField(pv, o);
        break;
      }
    }
    e.addEventListener('pointerdown', (ev) => this.objDown(pv, o, e, ev));
    return e;
  }

  private shapeSvg(o: ShapeObj) {
    const { w, h } = o, sw = o.width;
    const stroke = o.stroke || 'none', fill = o.fill || 'none';
    if (o.shape === 'rect') return `<svg width="${w}" height="${h}"><rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
    if (o.shape === 'ellipse') return `<svg width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - sw / 2)}" ry="${Math.max(0, h / 2 - sw / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
    const [x1, y1, x2, y2] = [o.l[0] * w, o.l[1] * h, o.l[2] * w, o.l[3] * h];
    let head = '';
    if (o.shape === 'arrow') {
      const ang = Math.atan2(y2 - y1, x2 - x1), L = 10 + sw * 2.5, sp = 0.45;
      const p1 = [x2 - L * Math.cos(ang - sp), y2 - L * Math.sin(ang - sp)], p2 = [x2 - L * Math.cos(ang + sp), y2 - L * Math.sin(ang + sp)];
      head = `<polygon points="${x2},${y2} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}" fill="${stroke}"/>`;
    }
    return `<svg width="${w}" height="${h}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>${head}</svg>`;
  }

  // ---------------- selection ----------------
  findObj(page: number, id: string): Obj | undefined {
    return this.tab?.objects[page]?.find((o) => o.id === id);
  }
  get selObj() { return this.sel ? this.findObj(this.sel.page, this.sel.id) : undefined; }

  select(s: { page: number; id: string } | null) {
    const prev = this.sel?.page;
    this.sel = s;
    const v = this.app.view;
    if (v) for (const pv of v.pages) if (pv.index === prev || pv.index === s?.page) this.drawSelection(pv);
    this.buildOptions();
  }

  private drawSelection(pv: PageView) {
    pv.objLayer.querySelectorAll('.handle,.sfdel').forEach((h) => h.remove());
    pv.objLayer.querySelectorAll('.obj.sel').forEach((x) => x.classList.remove('sel'));
    if (!this.sel || this.sel.page !== pv.index) return;
    const e = pv.objLayer.querySelector(`.obj[data-id="${this.sel.id}"]`) as HTMLElement | null;
    const o = this.selObj;
    if (!e || !o) return;
    e.classList.add('sel');
    if (o.type === 'markup' || o.type === 'note' || o.type === 'text') return;
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const d = el('div', 'handle'); d.dataset.h = h;
      d.addEventListener('pointerdown', (ev) => this.resizeDown(pv, o, h, ev));
      e.appendChild(d);
    }
    if (o.type === 'signfield') {
      const x = el('div', 'sfdel', { title: 'Delete this box' }, '\u00d7');
      x.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      x.addEventListener('click', (ev) => { ev.stopPropagation(); this.deleteSelected(); });
      e.appendChild(x);
    }
  }

  deleteSelected() {
    const t = this.tab, s = this.sel;
    if (!t || !s) return;
    t.push();
    t.objects[s.page] = (t.objects[s.page] || []).filter((o) => o.id !== s.id);
    this.sel = null;
    this.refresh(s.page);
    this.buildOptions();
  }

  // ---------------- move / resize ----------------
  private objDown(pv: PageView, o: Obj, e: HTMLElement, ev: PointerEvent) {
    const sfMode = this.tool === 'signfield' && o.type === 'signfield';
    if ((this.tool !== 'select' && !sfMode) || ev.button !== 0) return;
    if ((ev.target as HTMLElement).classList.contains('handle') || (ev.target as HTMLElement).classList.contains('sfdel')) return;
    if (e.isContentEditable) return;
    ev.stopPropagation();
    this.select({ page: pv.index, id: o.id });
    if (o.type === 'markup') return;
    const tab = pv.tab, z = tab.zoom;
    const sx = ev.clientX, sy = ev.clientY, ox = o.x, oy = o.y;
    let moved = false;
    const move = (m: PointerEvent) => {
      const dx = (m.clientX - sx) / z, dy = (m.clientY - sy) / z;
      if (!moved && Math.hypot(dx, dy) * z < 3) return;
      if (!moved) { tab.push(); moved = true; }
      o.x = ox + dx; o.y = oy + dy;
      if (o.type === 'signfield') { o.x = clamp(o.x, 0, Math.max(0, pv.info.w - o.w)); o.y = clamp(o.y, 0, Math.max(0, pv.info.h - o.h)); }
      const cur = pv.objLayer.querySelector(`.obj[data-id="${o.id}"]`) as HTMLElement;
      if (cur) { cur.style.left = `${o.x}px`; cur.style.top = `${o.y}px`; }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved) this.refresh(pv.index);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  private resizeDown(pv: PageView, o: Obj, h: string, ev: PointerEvent) {
    if (o.type === 'markup' || o.type === 'note' || o.type === 'text') return;
    ev.stopPropagation(); ev.preventDefault();
    const tab = pv.tab, z = tab.zoom;
    const sx = ev.clientX, sy = ev.clientY;
    const b = { x: o.x, y: o.y, w: o.w, h: o.h };
    const keep = o.type === 'image' && h.length === 2;
    let started = false;
    const move = (m: PointerEvent) => {
      const dx = (m.clientX - sx) / z, dy = (m.clientY - sy) / z;
      if (!started) { tab.push(); started = true; }
      let { x, y, w, h: hh } = b;
      if (h.includes('e')) w = b.w + dx;
      if (h.includes('s')) hh = b.h + dy;
      if (h.includes('w')) { w = b.w - dx; x = b.x + dx; }
      if (h.includes('n')) { hh = b.h - dy; y = b.y + dy; }
      if (keep) {
        const r = b.w / b.h;
        if (Math.abs(w - b.w) / b.w > Math.abs(hh - b.h) / b.h) hh = w / r; else w = hh * r;
        if (h.includes('w')) x = b.x + b.w - w;
        if (h.includes('n')) y = b.y + b.h - hh;
      }
      const mw = o.type === 'signfield' ? 30 : 6, mh = o.type === 'signfield' ? 16 : 6;
      if (w < mw) { if (h.includes('w')) x -= mw - w; w = mw; }
      if (hh < mh) { if (h.includes('n')) y -= mh - hh; hh = mh; }
      if (o.type === 'signfield') {   // keep the box on the page
        if (x < 0) { w += x; x = 0; } if (y < 0) { hh += y; y = 0; }
        if (x + w > pv.info.w) w = pv.info.w - x; if (y + hh > pv.info.h) hh = pv.info.h - y;
        w = Math.max(w, mw); hh = Math.max(hh, mh);
      }
      o.x = x; o.y = y; o.w = w; o.h = hh;
      const old = pv.objLayer.querySelector(`.obj[data-id="${o.id}"]`);
      if (old) { const ne = this.buildEl(pv, o); old.replaceWith(ne); this.drawSelection(pv); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      this.refresh(pv.index);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // ---------------- page-level pointer handling ----------------
  private pageDown(pv: PageView, e: PointerEvent) {
    if (this.tool === 'select' && !(e.target as HTMLElement).closest('.obj,.handle,.fieldinput')) this.select(null);
  }

  private hoverEl: HTMLElement | null = null;
  private clearHover(pv: PageView) { this.hoverEl?.remove(); this.hoverEl = null; }
  private async pageMove(pv: PageView, e: PointerEvent) {
    if (this.tool !== 'edittext') return;
    const p = pv.toPage(e);
    const r = await this.runAt(pv, p.x, p.y);
    this.hoverEl?.remove(); this.hoverEl = null;
    if (r) {
      const d = el('div', 'hover-run');
      d.style.cssText = `left:${r.x - 1}px;top:${r.y - 1}px;width:${r.w + 2}px;height:${r.h + 2}px`;
      pv.objLayer.appendChild(d); this.hoverEl = d;
    }
  }

  private async runAt(pv: PageView, x: number, y: number) {
    const pt = await pv.tab.getText(pv.index);
    return pt.runs.find((r) => r.horizontal && r.str.trim() && x >= r.x - 1 && x <= r.x + r.w + 1 && y >= r.y && y <= r.y + r.h);
  }

  private async pageClick(pv: PageView, e: MouseEvent) {
    if (this.tool !== 'edittext') return;
    if ((e.target as HTMLElement).closest('.obj')) return;
    if (window.getSelection()?.toString()) return;
    const p = pv.toPage(e);
    const run = await this.runAt(pv, p.x, p.y);
    if (run) await this.editExistingRun(pv, run);
    else this.createText(pv, p.x, p.y, true);
  }

  // ---------------- capture tools ----------------
  private capDown(pv: PageView, e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const p0 = pv.toPage(e);
    const tab = pv.tab;
    if (this.tool === 'note') {
      this.addNote(pv, p0.x, p0.y);
      return;
    }
    if (this.tool === 'textbox') { this.createText(pv, p0.x, p0.y, true); this.setTool('select'); return; }
    const draft = el('div', 'draft');
    pv.objLayer.appendChild(draft);
    const pts: [number, number][] = [[p0.x, p0.y]];
    let cur = p0;
    const o = this.opt;
    const render = () => {
      if (this.tool === 'draw') {
        draft.style.cssText = 'left:0;top:0';
        draft.innerHTML = `<svg width="${pv.info.w}" height="${pv.info.h}" style="position:absolute;overflow:visible"><polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${o.inkColor}" stroke-width="${o.width}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      } else {
        const x = Math.min(p0.x, cur.x), y = Math.min(p0.y, cur.y), w = Math.abs(cur.x - p0.x), h = Math.abs(cur.y - p0.y);
        draft.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
        if (this.tool === 'shape' && (o.shape === 'rect' || o.shape === 'ellipse'))
          draft.style.cssText += `border:${o.width}px solid ${o.stroke};${o.shape === 'ellipse' ? 'border-radius:50%;' : ''}background:${o.fill || 'transparent'}`;
        else if (this.tool === 'shape') {
          draft.style.cssText = 'left:0;top:0';
          draft.innerHTML = `<svg width="${pv.info.w}" height="${pv.info.h}" style="position:absolute;overflow:visible"><line x1="${p0.x}" y1="${p0.y}" x2="${cur.x}" y2="${cur.y}" stroke="${o.stroke}" stroke-width="${o.width}"/></svg>`;
        } else draft.style.cssText += 'border:1.5px dashed #7c5cff;background:#7c5cff22';
      }
    };
    const move = (m: PointerEvent) => {
      cur = pv.toPage(m);
      if (this.tool === 'draw') pts.push([cur.x, cur.y]);
      render();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      draft.remove();
      const w = Math.abs(cur.x - p0.x), h = Math.abs(cur.y - p0.y);
      if (this.tool === 'draw') {
        if (pts.length < 2) return;
        const pad = o.width / 2 + 1;
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
        const bw = Math.max(...xs) - Math.min(...xs) + pad * 2, bh = Math.max(...ys) - Math.min(...ys) + pad * 2;
        const ink: InkObj = { id: uid(), type: 'ink', x, y, w: bw, h: bh, color: o.inkColor, width: o.width, pts: pts.map(([px, py]) => [(px - x) / bw, (py - y) / bh]) };
        this.addObj(pv, ink);
      } else if (this.tool === 'shape') {
        const isLine = o.shape === 'line' || o.shape === 'arrow';
        if (w < 4 && h < 4) return;
        const x = Math.min(p0.x, cur.x), y = Math.min(p0.y, cur.y);
        const bw = Math.max(w, 1), bh = Math.max(h, 1);
        const l: ShapeObj['l'] = [(p0.x - x) / bw, (p0.y - y) / bh, (cur.x - x) / bw, (cur.y - y) / bh];
        const s: ShapeObj = { id: uid(), type: 'shape', shape: o.shape, x, y, w: bw, h: bh, l, stroke: o.stroke, fill: isLine ? '' : o.fill, width: o.width };
        this.addObj(pv, s);
      } else if (this.tool === 'place' && this.pending) {
        const pd = this.pending;
        let bw = pd.w, bh = pd.h, x = p0.x - bw / 2, y = p0.y - bh / 2;
        if (w > 10 && h > 10) { x = Math.min(p0.x, cur.x); y = Math.min(p0.y, cur.y); bw = w; bh = bw * (pd.h / pd.w); }
        const img: ImageObj = { id: uid(), type: 'image', x: clamp(x, 0, Math.max(0, pv.info.w - bw)), y: clamp(y, 0, Math.max(0, pv.info.h - bh)), w: bw, h: bh, asset: pd.asset };
        if (!pd.repeat) this.pending = null;
        this.addObj(pv, img);
        if (!pd.repeat) {
          this.setTool('select');
          this.select({ page: pv.index, id: img.id });
        }
      } else if (this.tool === 'erase') {
        if (w < 6 || h < 6) return;
        const box = { x: Math.min(p0.x, cur.x), y: Math.min(p0.y, cur.y), w, h };
        const o2: EraseObj = { id: uid(), type: 'erase', ...box, color: this.sampleColors(pv, box).bg, removeAnnots: this.opt.eraseRemoveAnnots };
        this.addObj(pv, o2, true);
        this.setTool('select');
        this.select({ page: pv.index, id: o2.id });
        toast('Area erased. Now use Sign (or Draw) to add the new signature here.');
      } else if (this.tool === 'signfield' && this.esign) {
        const k = this.esign.kind, [dw, dh] = SF_SIZE[k];
        const bw = w < 8 ? dw : w, bh = h < 8 ? dh : h;
        const x = w < 8 ? p0.x - bw / 2 : Math.min(p0.x, cur.x), y = h < 8 ? p0.y - bh / 2 : Math.min(p0.y, cur.y);
        const sf: SignFieldObj = { id: uid(), type: 'signfield', kind: k, signer: this.esign.cur, label: SF_LABEL[k],
          x: clamp(x, 0, Math.max(0, pv.info.w - bw)), y: clamp(y, 0, Math.max(0, pv.info.h - bh)), w: bw, h: bh };
        this.addObj(pv, sf, true);
        this.sfOrder.push(sf.id);
        this.select({ page: pv.index, id: sf.id });
      } else if (this.tool === 'field') {
        let fw = w < 8 ? (this.opt.fieldKind === 'check' ? 18 : 160) : w, fh = h < 8 ? (this.opt.fieldKind === 'check' ? 18 : 24) : h;
        if (this.opt.fieldKind === 'check') fw = fh = Math.max(14, Math.min(fw, fh) || 18);
        const x = w < 8 ? p0.x : Math.min(p0.x, cur.x), y = h < 8 ? p0.y : Math.min(p0.y, cur.y);
        this.createField(pv, x, y, fw, fh);
      }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    void tab;
  }

  /** ids of signing boxes in the order they were placed (for "Undo last box") */
  sfOrder: string[] = [];
  undoLastBox() {
    const t = this.tab; if (!t) return;
    while (this.sfOrder.length) {
      const id = this.sfOrder.pop()!;
      for (const k of Object.keys(t.objects)) {
        const list = t.objects[Number(k)] || [];
        if (list.some((o) => o.id === id)) {
          t.push(); t.objects[Number(k)] = list.filter((o) => o.id !== id);
          if (this.sel?.id === id) this.sel = null;
          this.refresh(); this.buildOptions(); return;
        }
      }
    }
    toast('No boxes to undo');
  }
  clearBoxesFor(signer: number) {
    const t = this.tab; if (!t) return;
    t.push();
    for (const k of Object.keys(t.objects)) t.objects[Number(k)] = (t.objects[Number(k)] || []).filter((o) => !(o.type === 'signfield' && o.signer === signer));
    this.sel = null; this.refresh(); this.buildOptions();
  }

  addObj(pv: PageView, o: Obj, keepSel = false) {
    const tab = pv.tab;
    tab.push();
    tab.objectsOn(pv.index).push(o);
    this.refresh(pv.index);
    if (!keepSel && this.tool === 'select') this.select({ page: pv.index, id: o.id });
  }

  // ---------------- notes / text / fields ----------------
  private async addNote(pv: PageView, x: number, y: number) {
    const text = await this.askText('Sticky note', '');
    if (text === null) return;
    const n: NoteObj = { id: uid(), type: 'note', x, y, w: 26, h: 26, text, color: this.opt.noteColor };
    this.addObj(pv, n, true);
    this.setTool('select');
  }
  private async editNote(pv: PageView, o: NoteObj) {
    const t = await this.askText('Edit note', o.text);
    if (t === null || t === o.text) return;
    pv.tab.push(); o.text = t; this.refresh(pv.index);
  }
  async askText(title: string, value: string): Promise<string | null> {
    const ta = el('textarea', '', { rows: '6' });
    ta.style.cssText = 'width:420px;resize:vertical';
    ta.value = value;
    const r = await modal(title, ta, [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', kind: 'primary', value: 'ok' }]);
    return r === 'ok' ? ta.value : null;
  }

  createText(pv: PageView, x: number, y: number, edit: boolean, init?: Partial<TextObj>) {
    const o = this.opt;
    const t: TextObj = {
      id: uid(), type: 'text', x, y: y - o.fontSize * 0.6, w: 40, h: o.fontSize * 1.2, text: '',
      size: o.fontSize, color: o.fontColor, font: o.font, bold: o.bold, italic: o.italic, ...init,
    };
    pv.tab.push();
    pv.tab.objectsOn(pv.index).push(t);
    this.refresh(pv.index);
    if (edit) {
      const e = pv.objLayer.querySelector(`.obj[data-id="${t.id}"]`) as HTMLElement;
      this.editText(pv, t, e, true);
    }
    return t;
  }

  editText(pv: PageView, o: TextObj, e: HTMLElement, fresh = false) {
    if (!e || e.isContentEditable) return;
    const before = o.text;
    e.contentEditable = 'true';
    e.spellcheck = false;
    e.classList.add('sel');
    e.focus();
    const range = document.createRange(); range.selectNodeContents(e);
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range);
    if (fresh) s.collapseToEnd();
    const finish = () => {
      e.removeEventListener('blur', finish);
      const text = (e.innerText || '').replace(/\r/g, '').replace(/\n$/, '');
      e.contentEditable = 'false';
      const tab = pv.tab;
      if (!text.trim() && fresh) {
        // cancel empty new text box: drop it and the history entry created for it
        tab.objects[pv.index] = tab.objectsOn(pv.index).filter((x) => x.id !== o.id);
        tab.past.pop();
        this.refresh(pv.index);
        return;
      }
      if (text !== before) {
        if (!fresh) tab.push();
        o.text = text;
        const r = e.getBoundingClientRect();
        o.w = Math.max(10, r.width / tab.zoom); o.h = Math.max(o.size * 1.2, r.height / tab.zoom);
      }
      this.refresh(pv.index);
      this.select({ page: pv.index, id: o.id });
    };
    e.addEventListener('blur', finish);
    e.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); e.blur(); } ev.stopPropagation(); });
  }

  /** Edit existing text: cover original with sampled background and overlay matched replacement text. */
  async editExistingRun(pv: PageView, run: import('./doc').TextRun) {
    const tab = pv.tab;
    // already edited? (object covering this run) -> edit that one
    const existing = (tab.objects[pv.index] || []).find((o) => o.type === 'text' && o.cover && Math.abs(o.cover.x - (run.x - 1)) < 2 && Math.abs(o.cover.y - run.y) < 3) as TextObj | undefined;
    if (existing) {
      const e = pv.objLayer.querySelector(`.obj[data-id="${existing.id}"]`) as HTMLElement;
      this.editText(pv, existing, e); return;
    }
    const fi = await this.fontInfo(pv, run.fontName);
    const size = Math.round(run.size * 10) / 10;
    const colors = this.sampleColors(pv, run);
    const cover = { x: run.x - 1.5, y: run.y - 0.5, w: run.w + 3, h: run.h + 1, color: colors.bg };
    const t: TextObj = {
      id: uid(), type: 'text', x: run.bx, y: run.by - size * 0.9465, w: run.w, h: size * 1.2, text: run.str,
      size, color: colors.fg, font: fi.font, bold: fi.bold, italic: fi.italic, cover,
    };
    // Keep the document's own font: remember it so saving reuses it instead of a built-in font.
    if (fi.name) {
      let chars = '';
      try { const pt = await tab.getText(pv.index); chars = [...new Set(pt.runs.filter((r) => r.fontName === run.fontName).map((r) => r.str).join(''))].join(''); } catch { /* ignore */ }
      t.orig = { name: fi.name, css: run.fontName, chars };
    }
    tab.push();
    tab.objectsOn(pv.index).push(t);
    this.refresh(pv.index);
    const e = pv.objLayer.querySelector(`.obj[data-id="${t.id}"]`) as HTMLElement;
    this.editText(pv, t, e);
  }

  private async fontInfo(pv: PageView, name: string): Promise<{ font: FontKey; bold: boolean; italic: boolean; name: string }> {
    let n = '', bold = false, italic = false, serif = false, mono = false;
    try {
      const page = await pv.tab.getPage(pv.index);
      const c: any = (page as any).commonObjs;
      let f: any = null;
      if (c.has(name)) f = c.get(name);
      if (f) { n = f.name || ''; bold = !!f.bold || !!f.black; italic = !!f.italic; serif = !!f.isSerifFont; mono = !!f.isMonospace; }
    } catch { /* ignore */ }
    const s = n.toLowerCase();
    if (/bold|black|heavy|semibold|demi/.test(s)) bold = true;
    if (/italic|oblique/.test(s)) italic = true;
    if (/times|serif|georgia|garamond|minion|cambria|palatino|book|roman/.test(s) && !/sans/.test(s)) serif = true;
    if (/courier|mono|consolas|typewriter/.test(s)) mono = true;
    return { font: mono ? 'courier' : serif ? 'times' : 'helv', bold, italic, name: n };
  }

  private sampleColors(pv: PageView, run: Box) {
    const out = { bg: '#ffffff', fg: '#000000' };
    try {
      const c = pv.canvas;
      const sc = c.width / pv.info.w;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx || c.width < 10) return out;
      const px = (x: number, y: number) => ctx.getImageData(clamp(Math.round(x * sc), 0, c.width - 1), clamp(Math.round(y * sc), 0, c.height - 1), 1, 1).data;
      const samples = [px(run.x - 3, run.y + run.h / 2), px(run.x + run.w + 3, run.y + run.h / 2), px(run.x + 2, run.y - 2), px(run.x + run.w / 2, run.y + run.h + 2)];
      const key = (d: Uint8ClampedArray) => `${d[0] >> 4},${d[1] >> 4},${d[2] >> 4}`;
      const counts = new Map<string, Uint8ClampedArray[]>();
      for (const s of samples) { const k = key(s); counts.set(k, [...(counts.get(k) || []), s]); }
      const best = [...counts.values()].sort((a, b) => b.length - a.length)[0][0];
      out.bg = `rgb(${best[0]},${best[1]},${best[2]})`;
      // text colour: mean of the pixels furthest from the background
      const x0 = Math.round(run.x * sc), y0 = Math.round(run.y * sc), w = Math.max(1, Math.round(run.w * sc)), h = Math.max(1, Math.round(run.h * sc));
      const img = ctx.getImageData(clamp(x0, 0, c.width - 1), clamp(y0, 0, c.height - 1), Math.min(w, c.width - x0), Math.min(h, c.height - y0));
      const arr: { d: number; r: number; g: number; b: number }[] = [];
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        arr.push({ d: Math.abs(r - best[0]) + Math.abs(g - best[1]) + Math.abs(b - best[2]), r, g, b });
      }
      arr.sort((a, b) => b.d - a.d);
      const top = arr.slice(0, Math.max(1, Math.floor(arr.length * 0.04)));
      if (top[0] && top[0].d > 60) {
        const m = (k: 'r' | 'g' | 'b') => Math.round(top.reduce((s, v) => s + v[k], 0) / top.length);
        out.fg = `rgb(${m('r')},${m('g')},${m('b')})`;
      }
    } catch { /* tainted/unsupported */ }
    return out;
  }

  private async createField(pv: PageView, x: number, y: number, w: number, h: number) {
    const kind = this.opt.fieldKind;
    const tab = pv.tab;
    const existing = new Set<string>([...tab.formFields.map((f) => f.name), ...Object.values(tab.objects).flat().filter((o): o is FieldObj => o.type === 'field').map((o) => o.name)]);
    let n = 1; const label = kind === 'text' ? 'TextField' : kind === 'check' ? 'CheckBox' : 'Dropdown';
    while (existing.has(`${label}${n}`)) n++;
    const wrap = el('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px';
    wrap.innerHTML = `<div class="row"><label>Field name</label><input id="fname" value="${label}${n}"></div>` +
      (kind === 'dropdown' ? `<div class="row"><label>Options</label><textarea id="fopts" rows="4" placeholder="One option per line">Option 1\nOption 2\nOption 3</textarea></div>` : '') +
      (kind === 'text' ? `<div class="row"><label>Multiline</label><input type="checkbox" id="fml" style="flex:none"></div>` : '');
    const r = await modal(`New ${kind === 'text' ? 'text field' : kind === 'check' ? 'checkbox' : 'dropdown'}`, wrap, [{ label: 'Cancel', value: 'cancel' }, { label: 'Create', kind: 'primary', value: 'ok' }]);
    if (r !== 'ok') return;
    const name = (wrap.querySelector('#fname') as HTMLInputElement).value.trim();
    if (!name) return;
    if (existing.has(name) && kind !== 'check') { toast(`A field named "${name}" already exists`, true); return; }
    const opts = kind === 'dropdown' ? (wrap.querySelector('#fopts') as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    const f: FieldObj = {
      id: uid(), type: 'field', kind, name, x, y, w, h, options: opts, fontSize: Math.max(8, Math.min(14, h * 0.6)),
      multiline: kind === 'text' && (wrap.querySelector('#fml') as HTMLInputElement).checked,
    };
    this.addObj(pv, f, true);
    this.setTool('select');
    this.select({ page: pv.index, id: f.id });
  }
  private async editField(pv: PageView, o: FieldObj) {
    const name = await (await import('./util')).prompt('Field name', 'Name', o.name);
    if (!name || name === o.name) return;
    pv.tab.push(); o.name = name; this.refresh(pv.index);
  }

  // ---------------- text markup ----------------
  private onMouseUp(e: MouseEvent) {
    const kind = ({ highlight: 'highlight', underline: 'underline', strike: 'strike' } as const)[this.tool as 'highlight'];
    if (!kind) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const tab = this.tab; const v = this.app.view;
    if (!tab || !v) return;
    const color = kind === 'highlight' ? this.opt.hl : kind === 'underline' ? this.opt.ul : this.opt.st;
    const byPage = new Map<number, Box[]>();
    for (const pv of v.pages) {
      const tl = pv.textLayer;
      const pr = pv.el.getBoundingClientRect();
      if (!sel.containsNode(tl, true)) continue;
      const rects: Box[] = [];
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        const spans = tl.querySelectorAll('span:not(.markedContent)');
        spans.forEach((sp) => {
          if (!range.intersectsNode(sp)) return;
          const tn = sp.firstChild;
          const rr = document.createRange();
          if (tn && tn.nodeType === 3) {
            const len = (tn as Text).length;
            const s = sp === range.startContainer.parentElement || sp === range.startContainer ? (range.startContainer === tn ? range.startOffset : 0) : 0;
            const en = range.endContainer === tn ? range.endOffset : len;
            rr.setStart(tn, Math.min(s, len)); rr.setEnd(tn, Math.min(Math.max(en, s), len));
          } else rr.selectNodeContents(sp);
          for (const r of rr.getClientRects()) {
            if (r.width < 1 || r.height < 1) continue;
            rects.push({ x: (r.left - pr.left) / tab.zoom, y: (r.top - pr.top) / tab.zoom, w: r.width / tab.zoom, h: r.height / tab.zoom });
          }
        });
      }
      if (rects.length) byPage.set(pv.index, mergeRects(rects));
    }
    if (!byPage.size) return;
    tab.push();
    for (const [page, rects] of byPage) {
      const m: MarkupObj = { id: uid(), type: 'markup', kind, color, rects };
      tab.objectsOn(page).push(m);
    }
    sel.removeAllRanges();
    this.refresh();
    void e;
  }

  // ---------------- keyboard ----------------
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.matches?.('input,textarea,select,[contenteditable=true]')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.deleteSelected(); return; }
    if (e.key === 'Escape') {
      if (this.tool !== 'select') this.setTool('select'); else this.select(null);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const o = this.selObj;
    if (o && o.type !== 'markup' && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      this.tab!.push();
      if (e.key === 'ArrowLeft') o.x -= d; if (e.key === 'ArrowRight') o.x += d;
      if (e.key === 'ArrowUp') o.y -= d; if (e.key === 'ArrowDown') o.y += d;
      this.refresh(this.sel!.page);
      return;
    }
    const map: Record<string, ToolName> = { v: 'select', h: 'highlight', u: 'underline', d: 'draw', s: 'shape', n: 'note', t: 'textbox', e: 'edittext', x: 'erase' };
    const tool = map[e.key.toLowerCase()];
    if (tool && this.tab) this.setTool(tool);
    else if (e.key.toLowerCase() === 'i' && this.tab) this.app.insertImage();
  }

  // ---------------- options bar ----------------
  buildOptions() {
    const bar = document.getElementById('optionsbar')!;
    bar.replaceChildren();
    const o = this.opt;
    const so = this.selObj;
    const add = (html: string) => { const d = el('div', 'opt', {}, html); bar.appendChild(d); return d; };
    const title = (t: string) => add(`<span class="opt-title">${t}</span>`);
    const swatches = (cur: string, set: (c: string) => void, allowNone = false) => {
      const d = add('');
      const wrap = el('div', 'swatches');
      const mk = (c: string) => {
        const s = el('div', 'swatch' + (c.toLowerCase() === (cur || '').toLowerCase() ? ' sel' : ''));
        s.style.background = c || 'transparent';
        if (!c) s.style.border = '2px dashed #888';
        s.onclick = () => { set(c); this.buildOptions(); };
        wrap.appendChild(s);
      };
      if (allowNone) mk('');
      SWATCHES.forEach(mk);
      const ci = el('input', '', { type: 'color' }) as HTMLInputElement;
      ci.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#ff0000';
      ci.oninput = () => set(ci.value);
      ci.onchange = () => this.buildOptions();
      d.append(wrap, ci);
    };
    const slider = (label: string, min: number, max: number, val: number, set: (v: number) => void) => {
      const d = add(`<span>${label}</span><input type="range" min="${min}" max="${max}" step="0.5" value="${val}"><span class="v">${val}</span>`);
      const r = d.querySelector('input') as HTMLInputElement;
      r.oninput = () => { (d.querySelector('.v') as HTMLElement).textContent = r.value; set(Number(r.value)); };
    };
    const seg = (items: [string, string][], cur: string, set: (v: string) => void) => {
      const d = add(''); const s = el('div', 'seg');
      for (const [v, label] of items) { const b = el('button', v === cur ? 'sel' : '', {}, label); b.onclick = () => { set(v); this.buildOptions(); }; s.appendChild(b); }
      d.appendChild(s);
    };
    const textControls = (get: () => { size: number; color: string; font: FontKey; bold: boolean; italic: boolean }, set: (p: Partial<{ size: number; color: string; font: FontKey; bold: boolean; italic: boolean }>) => void) => {
      const g = get();
      const d = add(`<span>Font</span><select>${(['helv:Sans (Helvetica)', 'times:Serif (Times)', 'courier:Mono (Courier)']).map((s) => { const [k, l] = s.split(':'); return `<option value="${k}" ${k === g.font ? 'selected' : ''}>${l}</option>`; }).join('')}</select><span>Size</span><input type="number" min="4" max="200" value="${Math.round(g.size * 10) / 10}" style="width:60px">`);
      (d.querySelector('select') as HTMLSelectElement).onchange = (e) => set({ font: (e.target as HTMLSelectElement).value as FontKey });
      (d.querySelector('input') as HTMLInputElement).onchange = (e) => set({ size: clamp(Number((e.target as HTMLInputElement).value) || 12, 4, 200) });
      const s2 = el('div', 'seg');
      const b = el('button', g.bold ? 'sel' : '', {}, '<b>B</b>'); b.onclick = () => { set({ bold: !g.bold }); this.buildOptions(); };
      const i = el('button', g.italic ? 'sel' : '', {}, '<i>I</i>'); i.onclick = () => { set({ italic: !g.italic }); this.buildOptions(); };
      s2.append(b, i); add('').appendChild(s2);
      swatches(g.color, (c) => set({ color: c }));
    };

    // ---- selected object takes priority ----
    if (so && this.tool === 'select') {
      const pg = this.sel!.page;
      const mod = (fn: () => void) => { this.tab!.push(); fn(); this.refresh(pg); };
      if (so.type === 'markup') {
        title(`${so.kind[0].toUpperCase()}${so.kind.slice(1)}`);
        swatches(so.color, (c) => mod(() => { so.color = c; }));
      } else if (so.type === 'ink') {
        title('Drawing'); swatches(so.color, (c) => mod(() => { so.color = c; }));
        slider('Width', 1, 24, so.width, (v) => mod(() => { so.width = v; }));
      } else if (so.type === 'shape') {
        title('Shape'); swatches(so.stroke, (c) => mod(() => { so.stroke = c; }));
        if (so.shape === 'rect' || so.shape === 'ellipse') { add('<span>Fill</span>'); swatches(so.fill, (c) => mod(() => { so.fill = c; }), true); }
        slider('Width', 1, 24, so.width, (v) => mod(() => { so.width = v; }));
      } else if (so.type === 'text') {
        title(so.cover ? 'Edited text' : 'Text');
        textControls(() => so, (p) => mod(() => {
          Object.assign(so, p);
          // picking another font, bold or italic means the person no longer wants the original font
          if (p.font !== undefined || p.bold !== undefined || p.italic !== undefined) delete so.orig;
          if (p.size) so.h = so.size * 1.2;
        }));
      } else if (so.type === 'note') {
        title('Note'); swatches(so.color, (c) => mod(() => { so.color = c; }));
        const b = el('button', 'btn', {}, 'Edit text…'); b.onclick = () => this.editNote(this.app.view!.pages[pg], so); add('').appendChild(b);
      } else if (so.type === 'erase') {
        title('Erased area'); add('<span>Cover colour</span>'); swatches(so.color, (c) => mod(() => { so.color = c; }));
        const cb = add('<label class="chk"><input type="checkbox" ' + (so.removeAnnots ? 'checked' : '') + '> Also remove signature / annotation objects underneath</label>');
        (cb.querySelector('input') as HTMLInputElement).onchange = (e) => mod(() => { so.removeAnnots = (e.target as HTMLInputElement).checked; });
      } else if (so.type === 'image') {
        title('Signature / image — drag to move, drag the corner squares to resize');
        const copy = el('button', 'btn', {}, 'Add another copy');
        copy.onclick = () => {
          this.pending = { asset: so.asset, w: so.w, h: so.h };
          this.setTool('place');
          toast('Click on the page to place another copy');
        };
        add('').appendChild(copy);
      }
      else if (so.type === 'signfield') {
        title('Box for a signer');
        const signers = this.esign?.signers || [];
        const d = add(`<span>Who</span><select>${signers.map((x, i) => `<option value="${i}" ${i === so.signer ? 'selected' : ''}>${esc(x.name || `Signer ${i + 1}`)}</option>`).join('')}</select>`);
        (d.querySelector('select') as HTMLSelectElement).onchange = (e) => mod(() => { so.signer = Number((e.target as HTMLSelectElement).value); });
        seg([['signature', 'Signature'], ['initials', 'Initials'], ['date', 'Date signed'], ['text', 'Text']], so.kind, (v) => mod(() => { so.kind = v as SignFieldObj['kind']; so.label = SF_LABEL[so.kind]; }));
        if (so.kind === 'text') {
          const t = add(`<span>Label</span><input value="${esc(so.label)}" style="width:140px">`);
          (t.querySelector('input') as HTMLInputElement).onchange = (e) => mod(() => { so.label = (e.target as HTMLInputElement).value.trim().slice(0, 60) || 'Text'; });
        }
      }
      else if (so.type === 'field') {
        title(`Form field "${so.name}"`);
        const b = el('button', 'btn', {}, 'Rename…'); b.onclick = () => this.editField(this.app.view!.pages[pg], so); add('').appendChild(b);
      }
      const del = el('button', 'btn danger', {}, 'Delete'); del.onclick = () => this.deleteSelected();
      add('').appendChild(del);
      return;
    }

    switch (this.tool) {
      case 'select': add('<span class="opt-title">Select</span><span>Click an object to edit it · Double-click text to edit · Fill forms directly</span>'); break;
      case 'highlight': title('Highlight'); swatches(o.hl, (c) => { o.hl = c; }); add('<span>Select text to highlight it</span>'); break;
      case 'underline': title('Underline'); swatches(o.ul, (c) => { o.ul = c; }); add('<span>Select text to underline it</span>'); break;
      case 'strike': title('Strikethrough'); swatches(o.st, (c) => { o.st = c; }); add('<span>Select text to strike it out</span>'); break;
      case 'draw': title('Freehand'); swatches(o.inkColor, (c) => { o.inkColor = c; }); slider('Width', 1, 24, o.width, (v) => { o.width = v; }); break;
      case 'shape':
        title('Shape');
        seg([['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['arrow', 'Arrow']], o.shape, (v) => { o.shape = v as ShapeObj['shape']; });
        swatches(o.stroke, (c) => { o.stroke = c; });
        add('<span>Fill</span>'); swatches(o.fill, (c) => { o.fill = c; }, true);
        slider('Width', 1, 24, o.width, (v) => { o.width = v; });
        break;
      case 'note': title('Sticky note'); swatches(o.noteColor, (c) => { o.noteColor = c; }); add('<span>Click on the page to add a note</span>'); break;
      case 'textbox': case 'edittext':
        title(this.tool === 'edittext' ? 'Edit text' : 'Text box');
        add(this.tool === 'edittext' ? '<span>Click existing text to edit it (font &amp; size are matched) · click empty space to add new text</span>' : '<span>Click on the page to type</span>');
        textControls(() => ({ size: o.fontSize, color: o.fontColor, font: o.font, bold: o.bold, italic: o.italic }), (p) => {
          if (p.size) o.fontSize = p.size; if (p.color) o.fontColor = p.color; if (p.font) o.font = p.font;
          if (p.bold !== undefined) o.bold = p.bold; if (p.italic !== undefined) o.italic = p.italic;
        });
        break;
      case 'field':
        title('Form field');
        seg([['text', 'Text field'], ['check', 'Checkbox'], ['dropdown', 'Dropdown']], o.fieldKind, (v) => { o.fieldKind = v as FieldObj['kind']; });
        add('<span>Click or drag on the page to place the field</span>');
        break;
      case 'erase': {
        title('Erase area');
        add('<span>Drag a box over the old signature (or anything) to erase it</span>');
        const cb = add('<label class="chk"><input type="checkbox" ' + (o.eraseRemoveAnnots ? 'checked' : '') + '> Also remove signature / annotation objects underneath</label>');
        (cb.querySelector('input') as HTMLInputElement).onchange = (e) => { o.eraseRemoveAnnots = (e.target as HTMLInputElement).checked; };
        break;
      }
      case 'signfield': {
        title('Send for signature');
        const d = this.esign;
        if (!d) break;
        const chips = add('<span>Signer</span>');
        d.signers.forEach((x, i) => {
          const col = SIGNER_COLORS[i % SIGNER_COLORS.length];
          const b = el('button', 'btn' + (i === d.cur ? ' primary' : ''), {}, esc(x.name || `Signer ${i + 1}`));
          b.style.cssText = `padding:4px 10px;border:2px solid ${col};${i === d.cur ? `background:${col};` : ''}`;
          b.onclick = () => { d.cur = i; this.buildOptions(); };
          chips.appendChild(b);
        });
        const eb = el('button', 'btn', {}, 'Edit signers…'); eb.style.padding = '4px 10px'; eb.onclick = () => this.onEsign?.editSigners(); chips.appendChild(eb);
        seg([['signature', 'Signature'], ['initials', 'Initials'], ['date', 'Date signed'], ['text', 'Name / text']], d.kind, (v) => { d.kind = v as SignFieldObj['kind']; });
        add('<span>Click on the page where this person fills in. Click a box to move, resize or delete it.</span>');
        const fix = add('');
        const ub = el('button', 'btn', {}, 'Undo last box'); ub.style.padding = '4px 10px'; ub.onclick = () => this.undoLastBox();
        const cb2 = el('button', 'btn', {}, 'Clear this signer\u2019s boxes'); cb2.style.padding = '4px 10px'; cb2.onclick = () => this.clearBoxesFor(d.cur);
        fix.append(ub, cb2);
        const acts = add('');
        const send = el('button', 'btn primary', {}, 'Send…'); send.onclick = () => this.onEsign?.send();
        const cancel = el('button', 'btn', {}, 'Cancel'); cancel.onclick = () => this.onEsign?.cancel();
        acts.append(send, cancel);
        break;
      }
      case 'place': title('Place'); add(`<span>Click on the page to place (drag to size). ${this.pending?.repeat ? 'Click again to place more copies. ' : ''}Esc when done.</span>`); break;
    }
  }
}

function mergeRects(rects: Box[]): Box[] {
  // merge boxes on the same line that touch/overlap
  rects.sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Box[] = [];
  for (const r of rects) {
    const l = out[out.length - 1];
    if (l && Math.abs(l.y - r.y) < l.h * 0.5 && Math.abs(l.h - r.h) < l.h * 0.5 && r.x <= l.x + l.w + 3) {
      const x2 = Math.max(l.x + l.w, r.x + r.w);
      l.x = Math.min(l.x, r.x); l.w = x2 - l.x;
      const y2 = Math.max(l.y + l.h, r.y + r.h); l.y = Math.min(l.y, r.y); l.h = y2 - l.y;
    } else out.push({ ...r });
  }
  return out;
}
