import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Asset, Box, FormFieldInfo, FormValue, ObjectsByPage, PageInfo, Snapshot } from './types';
import { uid, toast } from './util';
import { openWithRepair, REPAIR_NOTICE } from './pdfrepair';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', location.href).href;
const base = (d: string) => new URL(`./${d}/`, location.href).href;

export { pdfjsLib };

export interface TextRun {
  str: string;
  /** bbox in page "view space" at scale 1 (top-left origin, rotation applied) */
  x: number; y: number; w: number; h: number;
  /** baseline-left in view space */
  bx: number; by: number;
  size: number; fontName: string; horizontal: boolean;
}
export interface PageText { runs: TextRun[]; text: string; map: { start: number; run: number }[] }

export type ZoomMode = 'fitwidth' | 'fitpage' | number;

export class DocTab {
  id = uid('t');
  path: string | null = null;
  name = 'Untitled.pdf';
  bytes!: Uint8Array;
  pdf!: PDFDocumentProxy;
  pages: PageInfo[] = [];
  objects: ObjectsByPage = {};
  formValues: Record<string, FormValue> = {};
  formFields: FormFieldInfo[] = [];
  assets = new Map<string, Asset>();
  past: Snapshot[] = [];
  future: Snapshot[] = [];
  dirty = false;
  // A new document opens showing the whole page; on a phone-size screen it fits the width instead (a whole page would be too small to read).
  zoomMode: ZoomMode = (typeof window !== 'undefined' && window.innerWidth <= 820) ? 'fitwidth' : 'fitpage';
  zoom = 1;
  currentPage = 0;
  selectedPages = new Set<number>();
  /** bumps whenever bytes change; used to invalidate caches */
  version = 0;
  private textCache = new Map<number, Promise<PageText>>();
  private pageCache = new Map<number, Promise<PDFPageProxy>>();
  private badPages = new Set<number>();
  /** true when this document was damaged and PdfStudio opened a repaired copy */
  repairedNote = false;

  static async create(bytes: Uint8Array, path: string | null, name?: string) {
    const t = new DocTab();
    t.path = path;
    t.name = name || (path ? path.split(/[\\/]/).pop()! : 'Untitled.pdf');
    await t.load(bytes);
    return t;
  }

  async load(bytes: Uint8Array) {
    const old = this.pdf;
    this.bytes = bytes;
    this.version++;
    this.textCache.clear();
    this.pageCache.clear();
    // A damaged file (broken page list, missing page, bad xref) opens from a repaired copy; those are the bytes we keep and save.
    const opened = await openWithRepair(pdfjsLib, bytes, {
      cMapUrl: base('cmaps'), cMapPacked: true,
      standardFontDataUrl: base('standard_fonts'),
      iccUrl: base('iccs'), wasmUrl: base('wasm'),
    });
    this.pdf = opened.pdf;
    this.badPages = new Set(opened.badPages);
    if (opened.repaired) { this.bytes = opened.bytes; this.dirty = true; }
    if (old) (old as any).destroy?.()?.catch?.(() => {});
    this.pages = [];
    const fields: FormFieldInfo[] = [];
    for (let i = 0; i < this.pdf.numPages; i++) {
      if (this.badPages.has(i)) { this.pages.push({ w: 612, h: 792, rotation: 0 }); continue; }   // unreadable page: blank placeholder
      const p = await this.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      this.pages.push({ w: vp.width, h: vp.height, rotation: p.rotate });
      try {
        const annots = await p.getAnnotations({ intent: 'display' });
        for (const a of annots) {
          if (a.subtype !== 'Widget' || !a.fieldName) continue;
          const p1 = vp.convertToViewportPoint(a.rect[0], a.rect[1]), p2 = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
          const r = [p1[0], p1[1], p2[0], p2[1]];
          const rect: Box = { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) };
          let type: FormFieldInfo['type'] | null = null;
          if (a.fieldType === 'Tx') type = 'text';
          else if (a.fieldType === 'Btn') type = a.checkBox ? 'check' : a.radioButton ? 'radio' : 'button';
          else if (a.fieldType === 'Ch') type = a.combo ? 'dropdown' : 'list';
          if (!type || type === 'button') continue;
          let value: FormValue = a.fieldValue ?? '';
          if (type === 'check') value = !!a.fieldValue && a.fieldValue !== 'Off' || (a.exportValue !== undefined && a.fieldValue === a.exportValue);
          if (type === 'radio') value = a.fieldValue ?? '';
          if (Array.isArray(value)) value = value[0] ?? '';
          const opts: string[] = (a.options || []).map((o: any) => (typeof o === 'string' ? o : o.displayValue ?? o.exportValue));
          const fs = (a as any).defaultAppearanceData?.fontSize || 0;
          fields.push({
            name: a.fieldName, type, page: i, rect, options: opts, value: value as FormValue,
            multiline: !!a.multiLine, fontSize: fs, radioValue: a.buttonValue ?? a.exportValue, readOnly: !!a.readOnly,
          });
        }
      } catch { /* ignore annotation errors */ }
    }
    this.formFields = fields;
    for (const f of fields) {
      if (!(f.name in this.formValues) && f.type !== 'radio') this.formValues[f.name] = f.value;
      if (f.type === 'radio' && !(f.name in this.formValues)) this.formValues[f.name] = f.value;
    }
    if (this.currentPage >= this.pages.length) this.currentPage = Math.max(0, this.pages.length - 1);
    if (opened.repaired) { this.repairedNote = true; try { toast(REPAIR_NOTICE(this.pages.length), false, 9000); } catch { /* no screen (tests) */ } }
  }

  getPage(i: number): Promise<PDFPageProxy> {
    let p = this.pageCache.get(i);
    if (!p) { p = this.pdf.getPage(i + 1); this.pageCache.set(i, p); }
    return p;
  }

  getText(i: number): Promise<PageText> {
    let t = this.textCache.get(i);
    if (!t) { t = this.buildText(i).catch((): PageText => ({ runs: [], text: '', map: [] })); this.textCache.set(i, t); }
    return t;
  }

  private async buildText(i: number): Promise<PageText> {
    const page = await this.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const raw: TextRun[] = [];
    for (const it of tc.items as any[]) {
      if (typeof it.str !== 'string') continue;
      const [a, b, c, d, e, f] = it.transform as number[];
      const size = Math.hypot(c, d) || Math.abs(d) || 10;
      const [bx, by] = vp.convertToViewportPoint(e, f);
      // direction vector of the text baseline in view space
      const [ex, ey] = vp.convertToViewportPoint(e + a, f + b);
      const dx = ex - bx, dy = ey - by;
      const horizontal = Math.abs(dy) < Math.abs(dx) * 0.05 && dx > 0;
      const w = it.width as number;
      raw.push({
        str: it.str, x: bx, y: by - size * 0.92, w, h: size * 1.17, bx, by,
        size, fontName: it.fontName, horizontal,
      });
      (raw[raw.length - 1] as any).eol = it.hasEOL;
    }
    // merge neighbouring items on the same baseline into runs (for editing)
    const runs: TextRun[] = [];
    for (const r of raw) {
      const last = runs[runs.length - 1];
      if (
        last && last.horizontal && r.horizontal && last.fontName === r.fontName &&
        Math.abs(last.by - r.by) < 0.8 && Math.abs(last.size - r.size) < 0.5 &&
        r.bx >= last.bx && r.bx - (last.bx + last.w) < last.size * 0.45 && !(last as any).eol
      ) {
        const gap = r.bx - (last.bx + last.w);
        last.str += (gap > last.size * 0.12 && !last.str.endsWith(' ') && !r.str.startsWith(' ') ? ' ' : '') + r.str;
        last.w = r.bx + r.w - last.bx;
        (last as any).eol = (r as any).eol;
      } else if (r.str.trim() !== '' || r.w > 0) runs.push({ ...r });
    }
    for (const r of runs) { r.x = r.bx; }
    let text = '';
    const map: { start: number; run: number }[] = [];
    runs.forEach((r, idx) => { map.push({ start: text.length, run: idx }); text += r.str + ' '; });
    return { runs, text, map };
  }

  // ---------- history ----------
  snapshot(): Snapshot {
    return { bytes: this.bytes, objects: JSON.stringify(this.objects), formValues: JSON.stringify(this.formValues) };
  }
  /** call BEFORE mutating state */
  push() {
    this.past.push(this.snapshot());
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.dirty = true;
  }
  async restore(s: Snapshot): Promise<boolean> {
    const pagesChanged = s.bytes !== this.bytes;
    this.objects = JSON.parse(s.objects);
    this.formValues = JSON.parse(s.formValues);
    if (pagesChanged) {
      const vals = this.formValues;
      await this.load(s.bytes);
      this.formValues = { ...Object.fromEntries(this.formFields.map((f) => [f.name, f.value])), ...vals };
    }
    return pagesChanged;
  }
  async undo(): Promise<boolean | null> {
    const s = this.past.pop();
    if (!s) return null;
    this.future.push(this.snapshot());
    this.dirty = true;
    return this.restore(s);
  }
  async redo(): Promise<boolean | null> {
    const s = this.future.pop();
    if (!s) return null;
    this.past.push(this.snapshot());
    this.dirty = true;
    return this.restore(s);
  }

  hasObjects() { return Object.values(this.objects).some((l) => l.length) || this.hasFormEdits(); }
  hasFormEdits() {
    return this.formFields.some((f) => {
      const v = this.formValues[f.name];
      return v !== undefined && v !== f.value;
    });
  }
  objectsOn(page: number) { return (this.objects[page] ||= []); }

  destroy() { (this.pdf as any)?.destroy?.()?.catch?.(() => {}); }
}


