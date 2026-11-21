import { el, modal, toast } from './util';
import { pdfjsLib } from './doc';

export type SigKind = 'signature' | 'initials';
let KEY = 'pdfstudio.signatures';
const FONTS = ['Segoe Script', 'Brush Script MT', 'Lucida Handwriting', 'Ink Free', 'Segoe Print', 'cursive'];

function loadSaved(): string[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function saveSaved(list: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 100))); } catch { /* ignore */ }
}

/** Crop transparent margins of a canvas and return a PNG data URL */
function trim(c: HTMLCanvasElement): string | null {
  const ctx = c.getContext('2d')!;
  const { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const o = document.createElement('canvas');
  o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d')!.drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}

export async function dataUrlToBytes(u: string): Promise<Uint8Array> {
  const r = await fetch(u);
  return new Uint8Array(await r.arrayBuffer());
}

/** Load a PNG/JPEG/PDF file into a canvas (first page for PDFs). */
async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (isPdf) {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) } as any).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(3, 1600 / base.width) });
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvas: c, viewport: vp, background: 'rgba(0,0,0,0)' } as any).promise;
    (doc as any).destroy?.();
  } else {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1600 / bmp.width);
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  }
  return c;
}

/** Turn near-white pixels transparent (for scanned/JPEG signatures on white paper). */
function removeWhite(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0);
  const img = x.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const m = Math.min(d[i], d[i + 1], d[i + 2]);
    if (m > 235) d[i + 3] = 0;
    else if (m > 190) d[i + 3] = Math.round(d[i + 3] * (235 - m) / 45);
  }
  x.putImageData(img, 0, 0);
  return c;
}
export async function getSignature(kind: SigKind = 'signature'): Promise<string | null> {
  KEY = kind === 'initials' ? 'pdfstudio.initials' : 'pdfstudio.signatures';
  const noun = kind === 'initials' ? 'initials' : 'signature';
  let color = '#111827';
  let mode: 'draw' | 'type' | 'upload' | 'saved' = loadSaved().length ? 'saved' : 'draw';
  let chosenSaved: string | null = null;
  let remember = true;

  const root = el('div');
  root.style.cssText = 'width:520px';
  const tabs = el('div', 'tabs2');
  const pane = el('div');
  root.append(tabs, pane);

  // draw
  const canvas = el('canvas', 'sigpad') as HTMLCanvasElement;
  canvas.width = 1040; canvas.height = 320;
  canvas.style.cssText = 'width:520px;height:160px';
  const ctx = canvas.getContext('2d')!;
  let drawing = false; let drew = false;
  const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * 2, (e.clientY - r.top) * 2]; };
  canvas.onpointerdown = (e) => { drawing = true; drew = true; canvas.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); };
  canvas.onpointermove = (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.strokeStyle = color; ctx.lineTo(x, y); ctx.stroke(); };
  canvas.onpointerup = () => { drawing = false; };

  // type
  const typed = el('input', '', { type: 'text', placeholder: kind === 'initials' ? 'Type your initials' : 'Type your name' }) as HTMLInputElement;
  const fontSel = el('select') as HTMLSelectElement;
  fontSel.innerHTML = FONTS.map((f) => `<option>${f}</option>`).join('');
  const prev = el('div', 'typed-preview');
  const updPrev = () => { prev.textContent = typed.value || 'Your signature'; prev.style.fontFamily = `"${fontSel.value}", cursive`; prev.style.color = color; prev.style.opacity = typed.value ? '1' : '.35'; };
  typed.oninput = updPrev; fontSel.onchange = updPrev;

  const colorRow = el('div', 'row');
  colorRow.innerHTML = '<label>Ink</label>';
  const sw = el('div', 'swatches');
  for (const c of ['#111827', '#1d4ed8', '#b91c1c', '#047857']) {
    const s = el('div', 'swatch' + (c === color ? ' sel' : '')); s.style.background = c;
    s.onclick = () => { color = c; sw.querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel')); s.classList.add('sel'); updPrev(); };
    sw.appendChild(s);
  }
  colorRow.appendChild(sw);
  const clear = el('button', 'btn', {}, 'Clear'); clear.onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drew = false; };
  colorRow.appendChild(clear);

  // upload
  let uploadSrc: HTMLCanvasElement | null = null;
  let uploadUrl: string | null = null;
  let stripWhite = true;
  const fileIn = el('input', '', { type: 'file', accept: '.png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf' }) as HTMLInputElement;
  fileIn.style.display = 'none';
  const upPrev = el('div', 'typed-preview');
  upPrev.style.fontSize = '14px'; upPrev.style.color = '#667';
  const refreshUpload = () => {
    if (!uploadSrc) { uploadUrl = null; upPrev.textContent = 'Choose a PNG, JPEG or PDF file containing your ' + noun; return; }
    uploadUrl = trim(stripWhite ? removeWhite(uploadSrc) : uploadSrc);
    upPrev.innerHTML = uploadUrl ? `<img src="${uploadUrl}" style="max-width:96%;max-height:80px;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/12px 12px">` : 'No visible ink found in this file';
  };
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try { uploadSrc = await fileToCanvas(f); refreshUpload(); }
    catch (e: any) { uploadSrc = null; refreshUpload(); toast('Could not read that file: ' + (e?.message || e), true); }
  };
  const pickBtn = el('button', 'btn', {}, 'Choose file…');
  pickBtn.onclick = () => fileIn.click();
  const stripRow = el('label', 'chk');
  stripRow.innerHTML = '<input type="checkbox" checked> Remove white background';
  (stripRow.querySelector('input') as HTMLInputElement).onchange = (e) => { stripWhite = (e.target as HTMLInputElement).checked; refreshUpload(); };
  const remRow = el('label', 'chk');
  remRow.innerHTML = '<input type="checkbox" checked> Save this ' + noun + ' for reuse';
  (remRow.querySelector('input') as HTMLInputElement).onchange = (e) => { remember = (e.target as HTMLInputElement).checked; };

  const render = () => {
    tabs.replaceChildren();
    for (const [k, label] of [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload'], ['saved', 'Saved']] as const) {
      const b = el('button', mode === k ? 'sel' : '', {}, label);
      b.onclick = () => { mode = k; render(); };
      tabs.appendChild(b);
    }
    pane.replaceChildren();
    if (mode === 'draw') pane.append(canvas, colorRow, remRow);
    else if (mode === 'type') {
      const r = el('div', 'row'); r.append(typed, fontSel);
      pane.append(r, prev, colorRow, remRow); updPrev();
    } else if (mode === 'upload') {
      const r = el('div', 'row'); r.append(pickBtn, el('span', '', {}, 'PNG, JPEG or PDF'));
      refreshUpload();
      pane.append(r, fileIn, upPrev, stripRow, remRow);
    } else {
      const list = loadSaved();
      const box = el('div', 'sig-saved');
      if (!list.length) box.innerHTML = '<span>No saved ' + noun + 's yet.</span>';
      for (const u of list) {
        const it = el('div', 'sigitem'); it.innerHTML = `<img src="${u}">`;
        if (u === chosenSaved) it.style.borderColor = 'var(--accent)';
        it.onclick = () => { chosenSaved = u; render(); };
        it.ondblclick = () => { chosenSaved = u; (document.querySelector('.modal .footer .btn.primary') as HTMLElement)?.click(); };
        const del = el('span', '', { title: 'Remove' }, '\u00d7');
        del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#c33;color:#fff;border-radius:50%;width:16px;height:16px;text-align:center;line-height:15px;font-size:12px';
        del.onclick = (e) => { e.stopPropagation(); saveSaved(list.filter((x) => x !== u)); if (chosenSaved === u) chosenSaved = null; render(); };
        it.appendChild(del);
        box.appendChild(it);
      }
      pane.appendChild(box);
    }
  };
  render();

  const r = await modal('Add ' + noun, root, [{ label: 'Cancel', value: 'cancel' }, { label: 'Use ' + noun, kind: 'primary', value: 'ok' }]);
  if (r !== 'ok') return null;
  let url: string | null = null;
  const md = mode as string;
  if (md === 'draw') url = drew ? trim(canvas) : null;
  else if (md === 'type') {
    if (!typed.value.trim()) return null;
    const c = document.createElement('canvas'); c.width = 1200; c.height = 360;
    const x = c.getContext('2d')!;
    x.fillStyle = color; x.textBaseline = 'middle'; x.font = `140px "${fontSel.value}", cursive`;
    x.fillText(typed.value, 30, 180, 1140);
    url = trim(c);
  } else if (md === 'upload') url = uploadUrl;
  else url = chosenSaved;
  if (url && md !== 'saved' && remember) saveSaved([url, ...loadSaved().filter((x) => x !== url)]);
  return url;
}

