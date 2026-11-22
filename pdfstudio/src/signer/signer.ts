// Public signing page: /pdfstudio/s/<token>. No account needed.
// Shows the document, lets the signer fill in only their own boxes, then submits to the server.
import { pdfjsLib } from '../renderer/doc';
import { getSignature } from '../renderer/sign';
import { el, esc, modal, toast } from '../renderer/util';

type Kind = 'signature' | 'initials' | 'date' | 'text';
interface Field { id: string; page: number; kind: Kind; x: number; y: number; w: number; h: number; label: string }
interface Info { title: string; message: string; from: string; name: string; email: string; status: string; requestStatus: string; fields: Field[]; hasFinal: boolean }

const token = location.pathname.split('/').filter(Boolean).pop() || '';
const API = `/pdfstudio/api/esign/t/${token}`;
const main = document.getElementById('main')!;
const bar = document.getElementById('bar')!;
const values: Record<string, string> = {};
const adopted: { signature?: string; initials?: string } = {};
let info: Info;

const base = (d: string) => new URL(`./${d}/`, location.href).href;

function card(icon: string, title: string, body: string) {
  bar.classList.add('hidden');
  main.innerHTML = `<div class="done-card"><div class="big">${icon}</div><h2>${esc(title)}</h2><p>${body}</p></div>`;
}

async function start() {
  let r: Response;
  try { r = await fetch(API, { cache: 'no-store' }); } catch { card('⚠️', 'Could not connect', 'Check your internet connection and reload this page.'); return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { card('🔗', 'Link not valid', esc(j.error || 'This signing link is not valid. Ask the sender for a new one.')); return; }
  info = j as Info;
  document.title = `Sign: ${info.title}`;
  const finalLink = info.hasFinal ? `<p><a class="btn primary" href="${API}/final">Download the signed PDF</a></p>` : '';
  if (info.status === 'canceled') return card('🚫', 'Request canceled', `${esc(info.from || 'The sender')} canceled this signing request. You do not need to do anything.`);
  if (info.status === 'signed') return card('✅', 'You already signed', `Thank you, ${esc(info.name)}. ${info.hasFinal ? 'Everyone has signed.' : 'You will get an email with the signed copy once everyone has signed.'}${finalLink}`);
  if (info.status === 'declined') return card('✋', 'You declined', 'You declined to sign this document. Contact the sender if this was a mistake.');
  if (info.requestStatus !== 'sent') return card('ℹ️', 'Nothing to sign', 'This document is no longer waiting for signatures.');

  const intro = el('div', 'intro');
  intro.innerHTML = `<h1>${esc(info.title)}</h1>
    <p><b>${esc(info.from || 'Someone')}</b> asked you, <b>${esc(info.name)}</b>, to sign this document.</p>
    ${info.message ? `<p class="msg">${esc(info.message)}</p>` : ''}
    <p class="muted">Tap each yellow box to fill it in. When every box is done, tick the agreement at the bottom and press <b>Finish</b>.</p>`;
  main.replaceChildren(intro);

  let pdf: any;
  try {
    const bytes = new Uint8Array(await (await fetch(`${API}/pdf`, { cache: 'no-store' })).arrayBuffer());
    pdf = await pdfjsLib.getDocument({ data: bytes, cMapUrl: base('cmaps'), cMapPacked: true, standardFontDataUrl: base('standard_fonts'), iccUrl: base('iccs'), wasmUrl: base('wasm') } as any).promise;
  } catch { card('⚠️', 'Could not open the document', 'Reload the page to try again.'); return; }

  const width = Math.min(main.clientWidth - 4, 900);
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = width / vp1.width;
    const vp = page.getViewport({ scale: scale * Math.min(2, window.devicePixelRatio || 1) });
    const wrap = el('div', 'page');
    wrap.style.width = `${vp1.width * scale}px`; wrap.style.height = `${vp1.height * scale}px`;
    const c = el('canvas') as HTMLCanvasElement;
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    wrap.appendChild(c);
    main.append(wrap, el('div', 'pnum', {}, `Page ${i + 1} of ${pdf.numPages}`));
    page.render({ canvas: c, viewport: vp } as any);
    for (const f of info.fields.filter((x) => x.page === i)) wrap.appendChild(fieldEl(f, scale));
  }
  bar.classList.remove('hidden');
  update();
}

function fieldEl(f: Field, scale: number): HTMLElement {
  const e = el('div', `fld ${f.kind}`);
  e.dataset.id = f.id;
  e.style.cssText = `left:${f.x * scale}px;top:${f.y * scale}px;width:${f.w * scale}px;height:${f.h * scale}px;font-size:${Math.max(10, Math.min(16, f.h * scale * 0.55))}px`;
  const label = f.kind === 'signature' ? 'Sign here' : f.kind === 'initials' ? 'Initials' : f.label || 'Type here';
  if (f.kind === 'date') {
    values[f.id] = 'now';
    e.classList.add('done');
    e.innerHTML = `<span class="dt">${esc(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}</span>`;
    e.title = 'Filled in automatically with the date you sign';
    return e;
  }
  if (f.kind === 'text') {
    const inp = el('input', '', { type: 'text', placeholder: label, 'aria-label': label }) as HTMLInputElement;
    if (/name/i.test(f.label || '')) inp.value = info.name;
    const sync = () => { values[f.id] = inp.value.trim(); e.classList.toggle('done', !!values[f.id]); update(); };
    inp.oninput = sync; e.appendChild(inp); sync();
    return e;
  }
  e.innerHTML = `<span class="lbl">${label}</span>`;
  e.onclick = async () => {
    const kind = f.kind as 'signature' | 'initials';
    let url = values[f.id] ? null : adopted[kind] || null;
    if (!url) url = await getSignature(kind);
    if (!url) return;
    adopted[kind] = url; values[f.id] = url;
    e.classList.add('done');
    e.innerHTML = `<img src="${url}" alt="${label}"><span class="chg">change</span>`;
    update();
  };
  return e;
}

function missing(): Field[] { return info.fields.filter((f) => !values[f.id]); }

function update() {
  const left = missing().length, total = info.fields.length;
  (document.getElementById('progTxt') as HTMLElement).textContent = left ? `${total - left} of ${total} boxes done` : 'All boxes done';
  (document.getElementById('nextBtn') as HTMLElement).classList.toggle('hidden', !left);
  const consent = (document.getElementById('consent') as HTMLInputElement).checked;
  (document.getElementById('finishBtn') as HTMLButtonElement).disabled = !!left || !consent;
}

function goNext() {
  const f = missing()[0]; if (!f) return;
  const e = document.querySelector(`.fld[data-id="${f.id}"]`) as HTMLElement | null;
  if (!e) return;
  e.scrollIntoView({ behavior: 'smooth', block: 'center' });
  e.classList.remove('pulse'); void e.offsetWidth; e.classList.add('pulse');
}

async function finish() {
  const btn = document.getElementById('finishBtn') as HTMLButtonElement;
  if (missing().length) { goNext(); return; }
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await fetch(`${API}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values, consent: true, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    card('✅', 'Thank you, you are done', j.allDone
      ? 'Everyone has now signed. You will get an email with the signed copy shortly.'
      : 'Your signature was recorded. You will get an email with the signed copy once everyone has signed. You can close this page.');
    window.scrollTo(0, 0);
  } catch (e: any) {
    toast(e?.message || 'Could not send. Try again.', true);
    btn.disabled = false; btn.textContent = 'Finish';
  }
}

async function decline() {
  const box = el('div');
  box.innerHTML = '<p style="margin:0">If you decline, the sender is told and you will not be able to sign this document.</p><textarea rows="3" placeholder="Reason (optional)"></textarea>';
  const r = await modal('Decline to sign?', box, [{ label: 'Go back', value: 'cancel' }, { label: 'Decline', kind: 'danger', value: 'ok' }]);
  if (r !== 'ok') return;
  try {
    const res = await fetch(`${API}/decline`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: (box.querySelector('textarea') as HTMLTextAreaElement).value }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `Error ${res.status}`);
    card('✋', 'You declined', 'The sender has been told. You can close this page.');
  } catch (e: any) { toast(e?.message || 'Could not send. Try again.', true); }
}

document.getElementById('consent')!.addEventListener('change', update);
document.getElementById('nextBtn')!.addEventListener('click', goNext);
document.getElementById('finishBtn')!.addEventListener('click', finish);
document.getElementById('declineBtn')!.addEventListener('click', decline);
start();
