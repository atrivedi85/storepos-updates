import {
  PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb, PDFName, PDFHexString, PDFTextField, PDFCheckBox,
  PDFRadioGroup, PDFDropdown, PDFOptionList, BlendMode, LineCapStyle, PDFArray, PDFDict, PDFNumber,
  PDFRef, PDFStream, PDFRawStream, decodePDFRawStream, pushGraphicsState, popGraphicsState, beginText, endText,
  setFontAndSize, setTextMatrix, showText, setFillingRgbColor,
} from 'pdf-lib';
import type { DocTab } from './doc';
import type { FieldObj, FontKey, Obj, TextObj } from './types';

type RGB = ReturnType<typeof rgb>;

export function parseColor(c: string): RGB {
  c = (c || '#000').trim();
  let m = c.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  if (m) return rgb(+m[1] / 255, +m[2] / 255, +m[3] / 255);
  m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1]; if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  return rgb(0, 0, 0);
}

function stdFont(key: FontKey, bold: boolean, italic: boolean): StandardFonts {
  if (key === 'times') return bold ? (italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold) : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  if (key === 'courier') return bold ? (italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold) : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  return bold ? (italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold) : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

class PageMapper {
  W: number; H: number; ox: number; oy: number; rot: number;
  constructor(page: PDFPage) {
    const cb = page.getCropBox();
    this.W = cb.width; this.H = cb.height; this.ox = cb.x; this.oy = cb.y;
    this.rot = ((page.getRotation().angle % 360) + 360) % 360;
  }
  /** view (top-left, rotated) coords -> user space */
  pt(vx: number, vy: number): [number, number] {
    const { W, H } = this;
    let ux: number, uy: number;
    switch (this.rot) {
      case 90: ux = vy; uy = vx; break;
      case 180: ux = W - vx; uy = vy; break;
      case 270: ux = W - vy; uy = H - vx; break;
      default: ux = vx; uy = H - vy;
    }
    return [ux + this.ox, uy + this.oy];
  }
}

function pathOf(pts: [number, number][], close: boolean) {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(3)} ${(-y).toFixed(3)}`).join(' ') + (close ? ' Z' : '');
}

function safeText(font: PDFFont, s: string) {
  const set = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xa0) out += ' ';
    else if (cp === 0x2018 || cp === 0x2019) out += "'";
    else if (cp === 0x201c || cp === 0x201d) out += '"';
    else out += set.has(cp) ? ch : '?';
  }
  return out;
}

/** Delete annotations (stamps, ink, signature widgets...) that sit mostly inside the erased area. Links are left alone. */
function removeAnnotsInside(doc: PDFDocument, page: PDFPage, pts: [number, number][], warnings: string[]) {
  try {
    const annots = page.node.Annots();
    if (!annots) return;
    const ex0 = Math.min(...pts.map((p) => p[0])), ex1 = Math.max(...pts.map((p) => p[0]));
    const ey0 = Math.min(...pts.map((p) => p[1])), ey1 = Math.max(...pts.map((p) => p[1]));
    for (let i = annots.size() - 1; i >= 0; i--) {
      const d = doc.context.lookupMaybe(annots.get(i), PDFDict);
      if (!d) continue;
      const sub = String(d.get(PDFName.of('Subtype')) ?? '');
      if (sub === '/Link' || sub === '/Popup') continue;
      const r = d.lookupMaybe(PDFName.of('Rect'), PDFArray);
      if (!r || r.size() < 4) continue;
      const n = [0, 1, 2, 3].map((k) => (r.lookup(k, PDFNumber) as PDFNumber).asNumber());
      const ax0 = Math.min(n[0], n[2]), ax1 = Math.max(n[0], n[2]), ay0 = Math.min(n[1], n[3]), ay1 = Math.max(n[1], n[3]);
      const iw = Math.min(ax1, ex1) - Math.max(ax0, ex0), ih = Math.min(ay1, ey1) - Math.max(ay0, ey0);
      const area = Math.max(1e-6, (ax1 - ax0) * (ay1 - ay0));
      if (iw > 0 && ih > 0 && (iw * ih) / area >= 0.5) annots.remove(i);
    }
  } catch (e) { warnings.push('Could not remove annotations under an erased area: ' + (e as Error).message); }
}


/* ---------- keep the document's own font when editing existing text ---------- */
// The edited text is written with the same font the PDF already uses, when every letter typed exists in it.
// Subset fonts only contain the letters the document used, so anything else falls back to the closest built-in font.
interface OrigFont { res: string; encode: (s: string) => string | null }
const normFont = (n: string) => String(n || '').replace(/^[A-Z]{6}\+/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

function streamText(doc: PDFDocument, v: unknown): string | null {
  const st = doc.context.lookup(v as any);
  try {
    if (st instanceof PDFRawStream) return new TextDecoder('latin1').decode(decodePDFRawStream(st).decode());
    if (st instanceof PDFStream) return new TextDecoder('latin1').decode((st as any).getContents());
  } catch { /* unreadable */ }
  return null;
}
function hexToStr(h: string) {
  const b: number[] = []; for (let i = 0; i + 1 < h.length; i += 2) b.push(parseInt(h.slice(i, i + 2), 16));
  let out = ''; for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return out;
}
/** unicode letter -> char code (hex) from a ToUnicode CMap */
function parseToUnicode(cm: string): { map: Map<string, string>; bytes: number } {
  const map = new Map<string, string>();
  const cs = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(cm); const bytes = cs ? Math.max(1, cs[1].length / 2) : 1;
  const pad = (n: number) => n.toString(16).padStart(bytes * 2, '0');
  const put = (code: string, uni: string) => { if ([...uni].length === 1 && !map.has(uni)) map.set(uni, code.toLowerCase()); };
  for (const blk of cm.matchAll(/beginbfchar([\s\S]*?)endbfchar/gi))
    for (const m of blk[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) put(m[1].padStart(bytes * 2, '0'), hexToStr(m[2]));
  for (const blk of cm.matchAll(/beginbfrange([\s\S]*?)endbfrange/gi)) {
    for (const m of blk[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(\[[^\]]*\]|<[0-9a-f]*>)/gi)) {
      const lo = parseInt(m[1], 16), hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (m[3].startsWith('[')) { const items = [...m[3].matchAll(/<([0-9a-f]*)>/gi)].map((x) => x[1]); items.forEach((d, i) => { if (lo + i <= hi) put(pad(lo + i), hexToStr(d)); }); }
      else { const d = m[3].slice(1, -1); const base = hexToStr(d); if (!base) continue; const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) put(pad(c), base.slice(0, -1) + String.fromCharCode(last + (c - lo))); }
    }
  }
  return { map, bytes };
}

function findOrigFont(doc: PDFDocument, page: PDFPage, name: string, pageChars: string, counter: { n: number }): OrigFont | null {
  const want = normFont(name); if (!want) return null;
  const res = page.node.Resources(); if (!res) return null;
  let fonts = res.lookupMaybe(PDFName.of('Font'), PDFDict);
  // candidate fonts: the page's own, then fonts inside its form XObjects (one level)
  const cands: { key: PDFName; ref: any; onPage: boolean }[] = [];
  const scan = (fd: PDFDict | undefined, onPage: boolean) => { if (fd) for (const [k, v] of fd.entries()) cands.push({ key: k, ref: v, onPage }); };
  scan(fonts, true);
  const xo = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (xo) for (const [, v] of xo.entries()) {
    const x = doc.context.lookup(v) as any; const d: PDFDict | undefined = x && x.dict;
    const r = d && d.lookupMaybe(PDFName.of('Resources'), PDFDict); scan(r && r.lookupMaybe(PDFName.of('Font'), PDFDict), false);
  }
  for (const c of cands) {
    const fd = doc.context.lookupMaybe(c.ref, PDFDict); if (!fd) continue;
    const base = fd.lookupMaybe(PDFName.of('BaseFont'), PDFName); if (!base || normFont(base.decodeText()) !== want) continue;
    const subtype = (fd.lookupMaybe(PDFName.of('Subtype'), PDFName) || PDFName.of('')).decodeText();
    let enc: ((s: string) => string | null) | null = null;
    const tu = fd.get(PDFName.of('ToUnicode')); const cm = tu ? streamText(doc, tu) : null;
    if (cm) {
      const { map } = parseToUnicode(cm);
      enc = (s) => { let h = ''; for (const ch of s) { const code = map.get(ch === ' ' ? ' ' : ch); if (code === undefined) return null; h += code; } return h; };
    } else if (subtype !== 'Type0' && subtype !== 'Type3') {
      // simple font without a ToUnicode map: plain letters only, and only ones the page already shows in this font (subset fonts)
      const e = fd.get(PDFName.of('Encoding')); const encName = e instanceof PDFName ? e.decodeText() : e ? 'custom' : 'none';
      if (encName !== 'WinAnsiEncoding' && encName !== 'StandardEncoding' && encName !== 'none') continue;
      const subset = /^[A-Z]{6}\+/.test(base.decodeText()); const seen = new Set(pageChars + ' ');
      enc = (s) => { let h = ''; for (const ch of s) { const cp = ch.codePointAt(0)!; if (cp < 0x20 || cp > 0x7e || (subset && !seen.has(ch))) return null; h += cp.toString(16).padStart(2, '0'); } return h; };
    }
    if (!enc) continue;
    let key = c.key;
    if (!c.onPage) { // font lives in an XObject: make it available to the page under a new name
      if (!fonts) { fonts = doc.context.obj({}); res.set(PDFName.of('Font'), fonts); }
      key = PDFName.of('PSo' + (++counter.n)); while (fonts.has(key)) key = PDFName.of('PSo' + (++counter.n));
      fonts.set(key, c.ref);
    }
    return { res: key.decodeText(), encode: enc };
  }
  return null;
}

export interface BuildResult { bytes: Uint8Array; warnings: string[] }

/** Apply form values + overlay objects onto the current bytes. */
export async function buildPdf(tab: DocTab): Promise<BuildResult> {
  const warnings: string[] = [];
  const doc = await PDFDocument.load(tab.bytes, { ignoreEncryption: true, updateMetadata: false });
  const fontCache = new Map<string, PDFFont>();
  const getFont = async (k: FontKey, b: boolean, i: boolean) => {
    const s = stdFont(k, b, i);
    let f = fontCache.get(s);
    if (!f) { f = await doc.embedFont(s); fontCache.set(s, f); }
    return f;
  };

  // ---- existing form values ----
  if (tab.hasFormEdits()) {
    try {
      const form = doc.getForm();
      const done = new Set<string>();
      for (const ff of tab.formFields) {
        if (done.has(ff.name)) continue;
        const v = tab.formValues[ff.name];
        if (v === undefined) continue;
        const orig = tab.formFields.find((x) => x.name === ff.name)!.value;
        if (v === orig && ff.type !== 'radio') continue;
        done.add(ff.name);
        try {
          const f = form.getField(ff.name);
          if (f instanceof PDFTextField) f.setText(String(v) || undefined);
          else if (f instanceof PDFCheckBox) { v ? f.check() : f.uncheck(); }
          else if (f instanceof PDFRadioGroup) { if (v) f.select(String(v)); }
          else if (f instanceof PDFDropdown) { if (v) { if (!f.getOptions().includes(String(v))) f.addOptions(String(v)); f.select(String(v)); } else f.clear(); }
          else if (f instanceof PDFOptionList) { if (v) f.select(String(v)); }
        } catch (e) { warnings.push(`Field "${ff.name}": ${(e as Error).message}`); }
      }
    } catch (e) { warnings.push('Form: ' + (e as Error).message); }
  }

  // ---- overlay objects ----
  const pages = doc.getPages();
  const fields: { page: number; f: FieldObj }[] = [];
  const imgCache = new Map<string, any>();
  let lossy = false, fontFallback = false;
  const origCache = new Map<string, OrigFont | null>(); const origCounter = { n: 0 };
  for (const [pi, list] of Object.entries(tab.objects)) {
    const page = pages[Number(pi)];
    if (!page || !list) continue;
    const m = new PageMapper(page);
    // erased areas are applied first so anything added on top of them stays visible
    const ordered = [...(list as Obj[])].sort((a, b) => (a.type === 'erase' ? 0 : 1) - (b.type === 'erase' ? 0 : 1));
    for (const o of ordered) {
      switch (o.type) {
        case 'erase': {
          const pts = [m.pt(o.x, o.y), m.pt(o.x + o.w, o.y), m.pt(o.x + o.w, o.y + o.h), m.pt(o.x, o.y + o.h)];
          if (o.removeAnnots) removeAnnotsInside(doc, page, pts, warnings);
          page.drawSvgPath(pathOf(pts, true), { x: 0, y: 0, color: parseColor(o.color), borderWidth: 0 });
          break;
        }
        case 'markup': {
          for (const r of o.rects) {
            if (o.kind === 'highlight') {
              const pts = [m.pt(r.x, r.y), m.pt(r.x + r.w, r.y), m.pt(r.x + r.w, r.y + r.h), m.pt(r.x, r.y + r.h)];
              page.drawSvgPath(pathOf(pts, true), { x: 0, y: 0, color: parseColor(o.color), opacity: 0.45, borderWidth: 0, blendMode: BlendMode.Multiply });
            } else {
              const yy = o.kind === 'underline' ? r.y + r.h - 1.2 : r.y + r.h * 0.55;
              const a = m.pt(r.x, yy), b = m.pt(r.x + r.w, yy);
              page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: 1.2, color: parseColor(o.color) });
            }
          }
          break;
        }
        case 'ink': {
          const pts = o.pts.map(([px, py]) => m.pt(o.x + px * o.w, o.y + py * o.h));
          if (pts.length > 1) page.drawSvgPath(pathOf(pts, false), { x: 0, y: 0, borderColor: parseColor(o.color), borderWidth: o.width, borderLineCap: LineCapStyle.Round });
          break;
        }
        case 'shape': {
          const stroke = parseColor(o.stroke);
          const fill = o.fill ? parseColor(o.fill) : undefined;
          if (o.shape === 'rect') {
            const hw = o.width / 2;
            const pts = [m.pt(o.x + hw, o.y + hw), m.pt(o.x + o.w - hw, o.y + hw), m.pt(o.x + o.w - hw, o.y + o.h - hw), m.pt(o.x + hw, o.y + o.h - hw)];
            page.drawSvgPath(pathOf(pts, true), { x: 0, y: 0, borderColor: stroke, borderWidth: o.width, color: fill });
          } else if (o.shape === 'ellipse') {
            const pts: [number, number][] = [];
            for (let i = 0; i < 72; i++) {
              const a = (i / 72) * Math.PI * 2;
              pts.push(m.pt(o.x + o.w / 2 + Math.cos(a) * (o.w / 2 - o.width / 2), o.y + o.h / 2 + Math.sin(a) * (o.h / 2 - o.width / 2)));
            }
            page.drawSvgPath(pathOf(pts, true), { x: 0, y: 0, borderColor: stroke, borderWidth: o.width, color: fill });
          } else {
            const [x1, y1, x2, y2] = [o.x + o.l[0] * o.w, o.y + o.l[1] * o.h, o.x + o.l[2] * o.w, o.y + o.l[3] * o.h];
            const a = m.pt(x1, y1), b = m.pt(x2, y2);
            page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: o.width, color: stroke, lineCap: LineCapStyle.Round });
            if (o.shape === 'arrow') {
              const ang = Math.atan2(y2 - y1, x2 - x1), L = 10 + o.width * 2.5, sp = 0.45;
              const p1 = m.pt(x2 - L * Math.cos(ang - sp), y2 - L * Math.sin(ang - sp));
              const p2 = m.pt(x2 - L * Math.cos(ang + sp), y2 - L * Math.sin(ang + sp));
              page.drawSvgPath(pathOf([b, p1, p2], true), { x: 0, y: 0, color: stroke, borderWidth: 0 });
            }
          }
          break;
        }
        case 'note': {
          const c = parseColor(o.color);
          const pts = [m.pt(o.x + 2, o.y + 2), m.pt(o.x + 24, o.y + 2), m.pt(o.x + 24, o.y + 18), m.pt(o.x + 18, o.y + 24), m.pt(o.x + 2, o.y + 24)];
          page.drawSvgPath(pathOf(pts, true), { x: 0, y: 0, color: c, borderColor: rgb(0.63, 0.48, 0), borderWidth: 1 });
          for (const yy of [8, 12]) {
            const a = m.pt(o.x + 6, o.y + yy), b = m.pt(o.x + 20, o.y + yy);
            page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: 1.3, color: rgb(0.48, 0.36, 0) });
          }
          // real text annotation carrying the note contents
          const a = m.pt(o.x, o.y), b = m.pt(o.x + 26, o.y + 26);
          const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
          const ref = doc.context.register(doc.context.obj({
            Type: 'Annot', Subtype: 'Text', Rect: rect, Contents: PDFHexString.fromText(o.text), Name: 'Note',
            T: PDFHexString.fromText('PdfStudio'), F: 4 + 8 + 16, Open: false,
            C: [parseColor(o.color).red, parseColor(o.color).green, parseColor(o.color).blue],
          }));
          page.node.addAnnot(ref);
          break;
        }
        case 'text': {
          const t = o as TextObj;
          if (t.cover) {
            const cv = t.cover;
            const pts = [m.pt(cv.x, cv.y), m.pt(cv.x + cv.w, cv.y), m.pt(cv.x + cv.w, cv.y + cv.h), m.pt(cv.x, cv.y + cv.h)];
            page.drawSvgPath(pathOf(pts, true), { x: 0, y: 0, color: parseColor(cv.color), borderWidth: 0 });
          }
          if (!t.text) break;
          if (t.orig) {
            const ck = pi + '|' + t.orig.name;
            if (!origCache.has(ck)) { let f: OrigFont | null = null; try { f = findOrigFont(doc, page, t.orig.name, t.orig.chars, origCounter); } catch { f = null; } origCache.set(ck, f); }
            const of = origCache.get(ck);
            const lines = t.text.split('\n');
            const hexes = of ? lines.map((ln) => (ln ? of.encode(ln) : '')) : null;
            if (of && hexes && hexes.every((h) => h !== null)) {
              const col = parseColor(t.color), a = (m.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
              lines.forEach((ln, i) => {
                if (!ln) return;
                const [bx, by] = m.pt(t.x, t.y + t.size * 0.9465 + i * t.size * 1.2);
                page.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(of.res, t.size), setFillingRgbColor(col.red, col.green, col.blue),
                  setTextMatrix(cs, sn, -sn, cs, bx, by), showText(PDFHexString.of(hexes[i] as string)), endText(), popGraphicsState());
              });
              break;
            }
            fontFallback = true;
          }
          const font = await getFont(t.font, t.bold, t.italic);
          const lines = t.text.split('\n');
          lines.forEach((ln, i) => {
            if (!ln) return;
            const clean = safeText(font, ln);
            if (clean !== ln) lossy = true;
            const [bx, by] = m.pt(t.x, t.y + t.size * 0.9465 + i * t.size * 1.2);
            page.drawText(clean, { x: bx, y: by, size: t.size, font, color: parseColor(t.color), rotate: degrees(m.rot) });
          });
          break;
        }
        case 'image': {
          const a = tab.assets.get(o.asset);
          if (!a) break;
          let img = imgCache.get(o.asset);
          if (!img) { img = a.mime === 'image/png' ? await doc.embedPng(a.bytes) : await doc.embedJpg(a.bytes); imgCache.set(o.asset, img); }
          const [x, y] = m.pt(o.x, o.y + o.h);
          page.drawImage(img, { x, y, width: o.w, height: o.h, rotate: degrees(m.rot) });
          break;
        }
        case 'field': fields.push({ page: Number(pi), f: o }); break;
      }
    }
  }
  if (fontFallback) warnings.push('Some edited text uses letters that are not in the document\'s original font, so a similar built-in font was used for that text.');
  if (lossy) warnings.push('Some characters are not supported by the built-in PDF fonts and were replaced with "?".');

  // ---- new form fields ----
  if (fields.length) {
    const form = doc.getForm();
    const helv = await getFont('helv', false, false);
    for (const { page: pi, f } of fields) {
      const page = pages[pi];
      const m = new PageMapper(page);
      const a = m.pt(f.x, f.y), b = m.pt(f.x + f.w, f.y + f.h);
      const rect = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
      const style = { ...rect, borderWidth: 1, borderColor: rgb(0.25, 0.3, 0.6), backgroundColor: rgb(0.93, 0.95, 1), font: helv };
      try {
        if (f.kind === 'text') {
          const tf = form.createTextField(f.name);
          if (f.multiline) tf.enableMultiline();
          tf.addToPage(page, style); tf.setFontSize(f.multiline ? Math.min(f.fontSize, 12) : 0);
          if (!f.multiline) tf.setFontSize(Math.round(Math.max(8, Math.min(12, rect.height * 0.6))));
        } else if (f.kind === 'check') {
          const cb = form.createCheckBox(f.name);
          cb.addToPage(page, { ...rect, borderWidth: 1, borderColor: rgb(0.25, 0.3, 0.6), backgroundColor: rgb(0.93, 0.95, 1) });
        } else {
          const dd = form.createDropdown(f.name);
          dd.addOptions(f.options.length ? f.options : ['Option 1']);
          dd.addToPage(page, style); dd.setFontSize(Math.round(Math.max(8, Math.min(12, rect.height * 0.6))));
        }
      } catch (e) { warnings.push(`Field "${f.name}": ${(e as Error).message}`); }
    }
    form.updateFieldAppearances(helv);
  }

  void PDFName; void PDFArray;
  const bytes = await doc.save();
  return { bytes, warnings };
}

// ---------------- page operations (all operate on baked bytes) ----------------

async function transformDoc(tab: DocTab, fn: (doc: PDFDocument) => Promise<void> | void) {
  const { bytes } = await buildPdf(tab);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  await fn(doc);
  return doc.save();
}

/** Run a page-level change: pushes history, rebuilds the document. */
export async function applyDocChange(tab: DocTab, fn: (doc: PDFDocument) => Promise<void> | void) {
  const out = await transformDoc(tab, fn);
  tab.push();
  tab.objects = {};
  tab.formValues = {};
  await tab.load(out);
}

export function reorderPages(doc: PDFDocument, from: number[], to: number) {
  const n = doc.getPageCount();
  const moving = [...new Set(from)].sort((a, b) => a - b);
  const rest: number[] = [];
  for (let i = 0; i < n; i++) if (!moving.includes(i)) rest.push(i);
  const before = moving.filter((i) => i < to).length;
  const at = to - before;
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  const pages = doc.getPages();
  for (let i = n - 1; i >= 0; i--) doc.removePage(i);
  for (const i of order) doc.addPage(pages[i]);
  return order;
}

export function rotatePages(doc: PDFDocument, idx: number[], deg: number) {
  for (const i of idx) {
    const p = doc.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + deg) % 360) + 360) % 360));
  }
}
export function deletePages(doc: PDFDocument, idx: number[]) {
  [...idx].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
}
export function insertBlank(doc: PDFDocument, after: number) {
  const ref = doc.getPage(Math.min(Math.max(after, 0), doc.getPageCount() - 1));
  const { width, height } = ref.getSize();
  const rot = ref.getRotation().angle;
  const p = doc.insertPage(after + 1, [width, height]);
  p.setRotation(degrees(rot));
}

export async function extractPages(tab: DocTab, idx: number[]): Promise<Uint8Array> {
  const { bytes } = await buildPdf(tab);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, [...idx].sort((a, b) => a - b));
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

export async function appendPdfs(doc: PDFDocument, files: Uint8Array[]) {
  for (const f of files) {
    const src = await PDFDocument.load(f, { ignoreEncryption: true });
    const pages = await doc.copyPages(src, src.getPageIndices());
    pages.forEach((p) => doc.addPage(p));
  }
}

export function parseRanges(spec: string, n: number): number[][] | null {
  const out: number[][] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a || b > n) return null;
    const r: number[] = [];
    for (let i = a; i <= b; i++) r.push(i - 1);
    out.push(r);
  }
  return out.length ? out : null;
}

export async function splitDoc(tab: DocTab, groups: number[][], baseName: string) {
  const { bytes } = await buildPdf(tab);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const files: { name: string; data: Uint8Array }[] = [];
  let k = 1;
  for (const g of groups) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, g);
    pages.forEach((p) => out.addPage(p));
    const label = g.length === 1 ? `p${g[0] + 1}` : `p${g[0] + 1}-${g[g.length - 1] + 1}`;
    files.push({ name: `${baseName}_part${k++}_${label}.pdf`, data: await out.save() });
  }
  return files;
}

export async function blankPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return d.save();
}
