// Camera scanner: take photos of paper (or pick photos), straighten + clean them up, and turn them into a PDF.
// Flow per page: camera (or photo) -> crop with 4 draggable corners (found automatically) -> filter -> Add page / Retake / Done.
import { PDFDocument } from 'pdf-lib';
import { el, esc, modal, toast } from './util';
import { icon } from './icons';
import { applyFilter, detectDocument, insetQuad, outputSize, warpPerspective, type Filter, type Img, type Pt, type Quad } from './imgproc';

export type ScanMode = 'scan' | 'photos';
export interface ScanHost { finish(bytes: Uint8Array, name: string): Promise<void> }

interface ScanPage { blob: Blob; w: number; h: number; thumb: string }

const MAX_SRC = 2400;     // biggest side of a photo we keep while cropping
const MAX_OUT = 2000;     // biggest side of a finished page
const JPEG_Q = 0.85;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'color', label: 'Color' }, { id: 'gray', label: 'Grayscale' }, { id: 'bw', label: 'Black & White' }, { id: 'original', label: 'Original' },
];

const pad = (n: number) => String(n).padStart(2, '0');
/** "Scan 2026-11-24 11-49.pdf" in the phone's local time. */
export function scanName(prefix = 'Scan', d = new Date()) {
  return `${prefix} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}.pdf`;
}

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const canvasOf = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const toImg = (c: HTMLCanvasElement): Img => { const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height); return { data: d.data, width: d.width, height: d.height }; };
const blobOf = (c: HTMLCanvasElement, type = 'image/jpeg', q = JPEG_Q) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not make the picture'))), type, q));

async function fileToCanvas(f: Blob): Promise<HTMLCanvasElement> {
  let src: ImageBitmap | HTMLImageElement;
  try { src = await createImageBitmap(f, { imageOrientation: 'from-image' } as any); }
  catch {
    src = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Not a picture')); i.src = URL.createObjectURL(f); });
  }
  const w0 = (src as any).naturalWidth || (src as any).width, h0 = (src as any).naturalHeight || (src as any).height;
  const s = Math.min(1, MAX_SRC / Math.max(w0, h0));
  const c = canvasOf(Math.max(1, Math.round(w0 * s)), Math.max(1, Math.round(h0 * s)));
  c.getContext('2d')!.drawImage(src as CanvasImageSource, 0, 0, c.width, c.height);
  (src as any).close?.();
  return c;
}

export class Scanner {
  root = el('div', 'scn');
  pages: ScanPage[] = [];
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private camError = '';
  private queue: File[] = [];
  private screen: 'base' | 'crop' | 'filter' | 'busy' = 'base';
  private cur: { src: HTMLCanvasElement; img?: Img; quad: Quad; base?: Img; filter: Filter; fromCamera: boolean } | null = null;
  private closed = false;

  constructor(private mode: ScanMode, private host: ScanHost) {}

  async open() {
    document.body.appendChild(this.root);
    document.body.classList.add('scanning');
    if (this.mode === 'scan') {
      this.root.replaceChildren(el('div', 'scn-wait', {}, 'Starting the camera…'));
      await this.startCamera();
    }
    if (!this.closed) this.showBase();
  }

  /** Photos mode: the picker was opened straight from the tap; its pictures arrive here. */
  async addFiles(files: File[]) {
    this.queue.push(...files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name)));
    if (this.screen === 'base' && this.queue.length) await this.nextFromQueue();
  }

  // ---------- camera ----------
  private async startCamera() {
    this.camError = '';
    if (!navigator.mediaDevices?.getUserMedia) { this.camError = 'This device has no camera we can use here.'; return; }
    try {
      try { this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false }); }
      catch (e: any) { if (e?.name === 'OverconstrainedError') this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); else throw e; }
      const v = document.createElement('video');
      v.autoplay = true; v.muted = true; v.playsInline = true; v.setAttribute('playsinline', '');
      v.srcObject = this.stream;
      this.video = v;
      await v.play().catch(() => {});
    } catch (e: any) {
      this.stream = null; this.video = null;
      this.camError = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        ? 'The camera is blocked. Allow the camera for PdfStudio in your phone settings, or take or choose photos instead.'
        : 'No camera was found. You can take or choose photos instead.';
    }
  }
  private stopCamera() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; this.video = null; }

  // ---------- base screen: camera view (or the photo buttons when there is no camera) ----------
  private pickPhotos(capture: boolean) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    if (capture) inp.setAttribute('capture', 'environment');
    inp.onchange = () => { const f = [...(inp.files || [])]; if (f.length) void this.addFiles(f); };
    inp.click();
  }

  private showBase() {
    if (this.closed) return;
    this.screen = 'base'; this.cur = null;
    const r = this.root;
    r.className = 'scn scn-base';
    const top = el('div', 'scn-top');
    const x = el('button', 'scn-btn', { 'aria-label': 'Close' }, icon('close')); x.onclick = () => void this.back();
    const title = el('div', 'scn-title', {}, this.mode === 'photos' ? 'Photos to PDF' : 'Scan');
    const photos = el('button', 'scn-btn txt', {}, `${icon('photos')}<span>Photos</span>`); photos.onclick = () => this.pickPhotos(false);
    top.append(x, title, photos);
    const mid = el('div', 'scn-mid');
    if (this.video) {
      mid.classList.add('live');
      mid.append(this.video);
      void this.video.play().catch(() => {});
      mid.append(el('div', 'scn-hint', {}, 'Put the page inside the frame, then tap the round button'));
    } else {
      const msg = this.camError || (this.mode === 'photos' ? 'Choose photos of your pages. Each one can be straightened and cleaned up before it goes into the PDF.' : '');
      mid.append(el('div', 'scn-nocam', {}, `${icon('camera')}<p>${esc(msg)}</p>`));
      const b1 = el('button', 'btn primary', {}, 'Take a photo'); b1.onclick = () => this.pickPhotos(true);
      const b2 = el('button', 'btn', {}, 'Choose photos'); b2.onclick = () => this.pickPhotos(false);
      mid.querySelector('.scn-nocam')!.append(b1, b2);
    }
    const strip = el('div', 'scn-strip');
    this.renderStrip(strip);
    const bar = el('div', 'scn-bar cam');
    const cnt = el('div', 'scn-count', {}, this.pages.length ? `<b>${this.pages.length}</b> page${this.pages.length > 1 ? 's' : ''}` : '');
    const shut = el('button', 'scn-shutter', { 'aria-label': 'Take picture' }, '<i></i>');
    if (!this.video) shut.style.visibility = 'hidden';
    shut.onclick = () => this.shoot();
    const done = el('button', 'btn primary scn-done', {}, 'Done');
    done.style.visibility = this.pages.length ? 'visible' : 'hidden';
    done.onclick = () => void this.finish();
    bar.append(cnt, shut, done);
    r.replaceChildren(top, mid, strip, bar);
  }

  private renderStrip(box: HTMLElement) {
    box.replaceChildren();
    box.classList.toggle('empty', !this.pages.length);
    this.pages.forEach((p, i) => {
      const c = el('div', 'scn-th');
      c.innerHTML = `<img alt="Page ${i + 1}" src="${p.thumb}"><b>${i + 1}</b>`;
      const row = el('div', 'scn-th-btns');
      const l = el('button', '', { 'aria-label': 'Move earlier' }, '‹'), d = el('button', 'del', { 'aria-label': 'Delete page' }, '×'), rr = el('button', '', { 'aria-label': 'Move later' }, '›');
      l.disabled = i === 0; rr.disabled = i === this.pages.length - 1;
      l.onclick = () => this.move(i, -1); rr.onclick = () => this.move(i, 1);
      d.onclick = () => { this.pages.splice(i, 1); this.showBase(); };
      row.append(l, d, rr);
      c.append(row);
      box.append(c);
    });
  }
  private move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= this.pages.length) return;
    [this.pages[i], this.pages[j]] = [this.pages[j], this.pages[i]];
    this.showBase();
  }

  private shoot() {
    const v = this.video;
    if (!v || !v.videoWidth) { toast('The camera is not ready yet', true); return; }
    const s = Math.min(1, MAX_SRC / Math.max(v.videoWidth, v.videoHeight));
    const c = canvasOf(Math.round(v.videoWidth * s), Math.round(v.videoHeight * s));
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    void this.beginCrop(c, true);
  }

  private async nextFromQueue() {
    const f = this.queue.shift();
    if (!f) { this.showBase(); return; }
    this.root.replaceChildren(el('div', 'scn-wait', {}, 'Opening photo…'));
    try { await this.beginCrop(await fileToCanvas(f), false); }
    catch { toast(`Could not open ${f.name || 'that photo'}`, true); await this.nextFromQueue(); }
  }

  // ---------- crop ----------
  private async beginCrop(src: HTMLCanvasElement, fromCamera: boolean) {
    this.screen = 'busy';
    this.root.className = 'scn';
    this.root.replaceChildren(el('div', 'scn-wait', {}, 'Looking for the page…'));
    await wait(30);
    const img = toImg(src);
    let quad: Quad | null = null;
    try { quad = detectDocument(img); } catch { quad = null; }
    this.cur = { src, img, quad: quad || insetQuad(src.width, src.height, 0.05), filter: 'color', fromCamera };
    this.showCrop();
  }

  private showCrop() {
    const cur = this.cur!;
    this.screen = 'crop';
    const r = this.root;
    r.className = 'scn scn-crop';
    const top = el('div', 'scn-top');
    const back = el('button', 'scn-btn txt', {}, `${icon('chevl')}<span>${cur.fromCamera ? 'Retake' : 'Skip'}</span>`);
    back.onclick = () => void this.retake();
    top.append(back, el('div', 'scn-title', {}, 'Adjust the corners'), el('span', 'scn-gap'));
    const stage = el('div', 'scn-stage');
    const box = el('div', 'scn-imgbox');
    const { src } = cur;
    const view = canvasOf(src.width, src.height);
    view.getContext('2d')!.drawImage(src, 0, 0);
    view.className = 'scn-img';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'scn-poly');
    svg.setAttribute('viewBox', `0 0 ${src.width} ${src.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = '<path fill="rgba(0,0,0,.55)" fill-rule="evenodd"></path><polygon fill="rgba(77,141,255,.12)" stroke="#4d8dff" stroke-width="3" vector-effect="non-scaling-stroke"></polygon>';
    box.append(view, svg);
    const handles: HTMLElement[] = [];
    const paint = () => {
      const q = cur.quad;
      (svg.querySelector('polygon') as SVGElement).setAttribute('points', q.map((p) => p.join(',')).join(' '));
      (svg.querySelector('path') as SVGElement).setAttribute('d', `M0 0H${src.width}V${src.height}H0Z M${q.map((p) => p.join(' ')).join(' L')}Z`);
      handles.forEach((h, i) => { h.style.left = `${(q[i][0] / src.width) * 100}%`; h.style.top = `${(q[i][1] / src.height) * 100}%`; });
    };
    ['top left', 'top right', 'bottom right', 'bottom left'].forEach((nm, i) => {
      const h = el('div', 'scn-h', { role: 'slider', 'aria-label': `${nm} corner` }, '<i></i>');
      h.dataset.corner = String(i);
      h.onpointerdown = (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        const mv = (ev: PointerEvent) => {
          const b = box.getBoundingClientRect();
          const x = Math.min(src.width, Math.max(0, ((ev.clientX - b.left) / b.width) * src.width));
          const y = Math.min(src.height, Math.max(0, ((ev.clientY - b.top) / b.height) * src.height));
          cur.quad[i] = [x, y] as Pt; paint();
        };
        const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); };
        h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      };
      handles.push(h); box.append(h);
    });
    stage.append(box);
    // fit the picture inside the stage keeping its shape
    const fit = () => {
      const sb = stage.getBoundingClientRect();
      const k = Math.min((sb.width - 44) / src.width, (sb.height - 44) / src.height);
      if (k > 0) { box.style.width = `${src.width * k}px`; box.style.height = `${src.height * k}px`; }
    };
    const bar = el('div', 'scn-bar crop');
    const full = el('button', 'btn', {}, 'Whole photo'); full.onclick = () => { cur.quad = [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]]; paint(); };
    const auto = el('button', 'btn', {}, 'Auto'); auto.onclick = () => { cur.quad = (cur.img && detectDocument(cur.img)) || insetQuad(src.width, src.height, 0.05); paint(); };
    const next = el('button', 'btn primary', {}, 'Next'); next.onclick = () => void this.showFilter();
    bar.append(auto, full, next);
    r.replaceChildren(top, stage, bar);
    fit(); paint();
    requestAnimationFrame(() => { fit(); paint(); });
  }

  // ---------- filter ----------
  private async showFilter() {
    const cur = this.cur!;
    this.screen = 'filter';
    const r = this.root;
    r.className = 'scn scn-filter';
    r.replaceChildren(el('div', 'scn-wait', {}, 'Straightening the page…'));
    await wait(30);
    let sz: { w: number; h: number };
    try {
      sz = outputSize(cur.quad, MAX_OUT);
      cur.base = warpPerspective(cur.img || toImg(cur.src), cur.quad, sz.w, sz.h);
    } catch { toast('Those corners do not make a page. Move them apart.', true); this.showCrop(); return; }
    const top = el('div', 'scn-top');
    const back = el('button', 'scn-btn txt', {}, `${icon('chevl')}<span>Crop</span>`); back.onclick = () => this.showCrop();
    top.append(back, el('div', 'scn-title', {}, 'Choose a look'), el('span', 'scn-gap'));
    const stage = el('div', 'scn-stage');
    const out = canvasOf(sz.w, sz.h); out.className = 'scn-out';
    stage.append(out);
    const draw = async () => {
      await wait(0);
      const f = applyFilter(cur.base!, cur.filter);
      out.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
    };
    const chips = el('div', 'scn-chips');
    for (const f of FILTERS) {
      const b = el('button', 'chip' + (f.id === cur.filter ? ' on' : ''), { 'data-filter': f.id }, f.label);
      b.onclick = async () => { cur.filter = f.id; chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b)); await draw(); };
      chips.append(b);
    }
    const bar = el('div', 'scn-bar filt');
    const retake = el('button', 'btn', {}, cur.fromCamera ? 'Retake' : 'Skip'); retake.onclick = () => void this.retake();
    const add = el('button', 'btn', { 'data-act': 'add' }, 'Add page'); add.onclick = async () => { if (await this.commit()) await this.afterAdd(); };
    const done = el('button', 'btn primary', { 'data-act': 'done' }, 'Done'); done.onclick = async () => { if (await this.commit()) await this.finish(); };
    bar.append(retake, add, done);
    r.replaceChildren(top, stage, chips, bar);
    await draw();
  }

  private async commit(): Promise<boolean> {
    const cur = this.cur;
    if (!cur?.base) return false;
    try {
      const f = applyFilter(cur.base, cur.filter);
      const c = canvasOf(f.width, f.height);
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
      const blob = await blobOf(c);
      const t = canvasOf(Math.max(1, Math.round(f.width * Math.min(1, 140 / Math.max(f.width, f.height)))), Math.max(1, Math.round(f.height * Math.min(1, 140 / Math.max(f.width, f.height)))));
      t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
      this.pages.push({ blob, w: f.width, h: f.height, thumb: t.toDataURL('image/jpeg', 0.7) });
      return true;
    } catch (e: any) { toast(`Could not add the page: ${e?.message || e}`, true); return false; }
  }
  private async afterAdd() {
    this.cur = null;
    if (this.queue.length) await this.nextFromQueue(); else this.showBase();
  }
  private async retake() {
    this.cur = null;
    if (this.queue.length) await this.nextFromQueue(); else this.showBase();
  }

  // ---------- finish ----------
  async finish() {
    if (!this.pages.length) { toast('Take a picture first', true); return; }
    this.root.replaceChildren(el('div', 'scn-wait', {}, 'Making your PDF…'));
    await wait(30);
    try {
      const bytes = await buildPdfFromPages(this.pages);
      const name = scanName(this.mode === 'photos' ? 'Photos' : 'Scan');
      this.close();
      await this.host.finish(bytes, name);
    } catch (e: any) {
      toast(`Could not make the PDF: ${e?.message || e}`, true);
      this.showBase();
    }
  }

  /** Android back button / close X. Returns true (it always handles the press while the scanner is up). */
  async back(): Promise<boolean> {
    if (this.screen === 'filter') { this.showCrop(); return true; }
    if (this.screen === 'crop') { await this.retake(); return true; }
    if (this.screen === 'busy') return true;
    if (this.pages.length || this.queue.length) {
      const r = await modal('Discard this scan?', `You have ${this.pages.length} scanned page${this.pages.length === 1 ? '' : 's'} that are not saved yet.`, [
        { label: 'Keep scanning', value: 'cancel' }, { label: 'Discard', kind: 'danger', value: 'discard' }]);
      if (r !== 'discard') return true;
    }
    this.close();
    return true;
  }

  close() {
    this.closed = true;
    this.stopCamera();
    this.root.remove();
    document.body.classList.remove('scanning');
    if (active === this) active = null;
  }
}

/** pdf-lib: one JPEG per page. Pages shaped like Letter get a Letter sheet (picture fitted inside); anything else gets a page of its own shape. */
export async function buildPdfFromPages(pages: { blob: Blob; w: number; h: number }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const LW = 612, LH = 792;
  for (const p of pages) {
    const img = await doc.embedJpg(new Uint8Array(await p.blob.arrayBuffer()));
    const aspect = p.w / p.h;
    const portrait = aspect <= 1;
    const letter = portrait ? LW / LH : LH / LW;
    let pw: number, ph: number;
    if (Math.abs(aspect - letter) / letter <= 0.12) { pw = portrait ? LW : LH; ph = portrait ? LH : LW; }
    else if (portrait) { pw = Math.round(LH * aspect); ph = LH; }
    else { pw = LH; ph = Math.round(LH / aspect); }
    const page = doc.addPage([pw, ph]);
    const k = Math.min(pw / p.w, ph / p.h);
    const w = p.w * k, h = p.h * k;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return doc.save();
}

let active: Scanner | null = null;
export const scannerOpen = () => !!active;
export function scannerBack(): Promise<boolean> { return active ? active.back() : Promise.resolve(false); }

/** Open the scanner. 'photos' pops the photo picker right away (it must run inside the tap that called us). */
export function openScanner(mode: ScanMode, host: ScanHost): Scanner {
  if (active) return active;
  const s = new Scanner(mode, host);
  active = s;
  if (mode === 'photos') {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = () => { const f = [...(inp.files || [])]; if (f.length) void s.addFiles(f); };
    inp.click();
  }
  void s.open();
  return s;
}
