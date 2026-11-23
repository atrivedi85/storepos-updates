// "Send for signature" (DocuSign-style), owner side.
// 1. Owner lists the signers, places boxes for each of them on the document, presses Send.
// 2. The server emails each signer a link (no account). They sign on the web page /pdfstudio/s/<token>.
// 3. When everyone has signed, this module builds the signed PDF (+ a certificate page) from the original
//    and the signers' answers, uploads it, and the server emails everyone a copy.
import { PDFDocument, StandardFonts, degrees, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { App } from './app';
import type { SignFieldObj } from './types';
import { buildPdf } from './pdfops';
import { SIGNER_COLORS } from './editor';
import { el, esc, modal, toast, download } from './util';
import { dataUrlToBytes } from './sign';
import { loadContacts, recordUsed, attachSuggest, contactsPanel, getSavePref, setSavePref, EMAIL_OK, type Contact } from './contacts';

interface Signer {
  id: string; idx: number; name: string; email: string; status: string; link: string;
  emailedAt?: number; emailError?: string; viewedAt?: number; signedAt?: number; declinedAt?: number; declineReason?: string; ip?: string; ua?: string;
}
interface Req {
  id: string; title: string; message: string; fileName: string; status: string; createdAt: number; completedAt?: number; finalizedAt?: number;
  notifyEmail: string; docHash: string; finalHash?: string;
  fields: { id: string; page: number; signer: number; kind: SignFieldObj['kind']; x: number; y: number; w: number; h: number; label: string }[];
  signers: Signer[]; events?: { at: number; who: string; what: string; ip: string }[];
}

const cleanErr = (e: any) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const when = (t?: number) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function setupEsign(app: App) {
  app.editor.onEsign = {
    send: () => { void send(app); },
    editSigners: () => { void editSigners(app, false); },
    cancel: () => cancelDraft(app),
  };
}

// ---------------- step 1: who signs ----------------
async function editSigners(app: App, first: boolean): Promise<boolean> {
  const ed = app.editor;
  const d = ed.esign || { title: (app.active?.name || 'Document').replace(/\.pdf$/i, ''), message: '', signers: [{ name: '', email: '' }], cur: 0, kind: 'signature' as const };
  const box = el('div');
  box.style.cssText = 'display:flex;flex-direction:column;gap:8px;width:min(560px,86vw)';
  const list = el('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  const rows: { name: HTMLInputElement; email: HTMLInputElement }[] = [];
  let contacts: Contact[] = [];
  const taken = (except?: { name: HTMLInputElement; email: HTMLInputElement }) => new Set(rows.filter((x) => x !== except).map((x) => x.email.value.trim().toLowerCase()).filter(Boolean));
  const fillRow = (ent: { name: HTMLInputElement; email: HTMLInputElement }, c: Contact) => { ent.name.value = c.name; ent.email.value = c.email; };
  const hooks: ReturnType<typeof attachSuggest>[] = [];
  const addRow = (n = '', e = '') => {
    const i = rows.length;
    const r = el('div', 'row');
    const dot = el('span'); dot.style.cssText = `width:12px;height:12px;border-radius:50%;flex:none;background:${SIGNER_COLORS[i % SIGNER_COLORS.length]}`;
    const name = el('input', '', { placeholder: 'Full name', value: n }) as HTMLInputElement;
    const email = el('input', '', { placeholder: 'Email', type: 'email', value: e }) as HTMLInputElement;
    const rm = el('button', 'btn', { title: 'Remove' }, '×'); rm.style.padding = '4px 10px';
    rm.onclick = () => { const k = rows.indexOf(ent); if (rows.length > 1 && k >= 0) { rows.splice(k, 1); r.remove(); } };
    const ent = { name, email };
    r.append(dot, name, email, rm); list.appendChild(r); rows.push(ent);
    for (const inp of [name, email]) hooks.push(attachSuggest([inp], () => contacts, () => taken(ent), (c) => fillRow(ent, c)));
  };
  d.signers.forEach((s) => addRow(s.name, s.email));
  const more = el('button', 'btn', {}, '+ Add another signer');
  more.onclick = () => { if (rows.length < 10) addRow(); };
  const panel = contactsPanel(() => contacts, () => taken(), (picked) => {
    for (const c of picked) {
      if (rows.length >= 10) { toast('You can add up to 10 signers', true); break; }
      const empty = rows.find((x) => !x.name.value.trim() && !x.email.value.trim());
      if (empty) fillRow(empty, c); else { addRow(c.name, c.email); }
    }
  }, (email) => { contacts = contacts.filter((c) => c.email !== email); });
  const fromContacts = el('button', 'btn', {}, '\u{1F465} Add from contacts');
  fromContacts.onclick = () => panel.toggle();
  const btns = el('div', 'row'); btns.append(more, fromContacts);
  const saveBox = el('input', '', { type: 'checkbox', id: 'saveContacts' }) as HTMLInputElement;
  saveBox.checked = getSavePref();
  saveBox.onchange = () => setSavePref(saveBox.checked);
  const saveRow = el('label'); saveRow.style.cssText = 'display:flex;align-items:center;justify-content:flex-start;gap:8px;cursor:pointer;color:var(--text)';
  saveRow.append(saveBox, el('span', '', {}, 'Save new people to my contacts'));
  void loadContacts().then((l) => { contacts = l; });
  const title = el('input', '', { value: d.title }) as HTMLInputElement;
  const msg = el('textarea', '', { rows: '3', placeholder: 'Message to the signers (optional)' }) as HTMLTextAreaElement;
  msg.value = d.message;
  const tRow = el('div', 'row'); tRow.append(el('label', '', {}, 'Subject'), title);
  box.append(el('div', '', {}, 'Who needs to sign? They get an email link and do not need an account.'), list, btns, panel.el, saveRow, tRow, msg);
  const r = await modal(first ? 'Send for signature' : 'Signers', box, [{ label: 'Cancel', value: 'cancel' }, { label: first ? 'Next: place boxes' : 'Save', kind: 'primary', value: 'ok' }]);
  hooks.forEach((h) => h.destroy()); panel.destroy();
  if (r !== 'ok') return false;
  const signers = rows.map((x) => ({ name: x.name.value.trim(), email: x.email.value.trim().toLowerCase() })).filter((x) => x.name || x.email);
  const bad = signers.find((x) => !x.name || !EMAIL_OK.test(x.email));
  if (!signers.length || bad) { toast(bad ? `Check the name and email for ${bad.name || bad.email}` : 'Add at least one signer', true); return editSigners(app, first); }
  ed.esign = { ...d, signers, title: title.value.trim() || d.title, message: msg.value.trim(), cur: Math.min(d.cur, signers.length - 1) };
  // boxes for signers that were removed go back to the first signer
  const t = app.active;
  if (t) for (const list2 of Object.values(t.objects)) for (const o of list2 || []) if (o.type === 'signfield' && o.signer >= signers.length) o.signer = 0;
  ed.refresh(); ed.buildOptions();
  return true;
}

export async function startSend(app: App) {
  if (!app.active) { toast('Open the PDF you want signed first', true); return; }
  if (!app.editor.esign && !(await editSigners(app, true))) return;
  app.editor.setTool('signfield');
  toast('Pick a signer and box type above, then click on the page where they should fill in');
}

function cancelDraft(app: App) {
  const t = app.active;
  if (t) {
    const has = Object.values(t.objects).some((l) => (l || []).some((o) => o.type === 'signfield'));
    if (has) { t.push(); for (const k of Object.keys(t.objects)) t.objects[Number(k)] = (t.objects[Number(k)] || []).filter((o) => o.type !== 'signfield'); }
  }
  app.editor.esign = null;
  app.editor.setTool('select');
  app.editor.refresh();
}

// ---------------- step 2: send ----------------
async function send(app: App) {
  const t = app.active, d = app.editor.esign;
  if (!t || !d) return;
  const fields: Req['fields'] = [];
  for (const [p, list] of Object.entries(t.objects)) for (const o of list || []) if (o.type === 'signfield')
    fields.push({ id: o.id, page: Number(p), signer: o.signer, kind: o.kind, x: o.x, y: o.y, w: o.w, h: o.h, label: o.label });
  if (!fields.length) { toast('Click on the page to add at least one box first', true); return; }
  const missing = d.signers.filter((_, i) => !fields.some((f) => f.signer === i));
  if (missing.length) { toast(`${missing.map((m) => m.name).join(', ')} ${missing.length > 1 ? 'have' : 'has'} no boxes yet. Add one, or remove them in Edit signers.`, true); return; }
  const body = el('div');
  body.innerHTML = `<p style="margin:0">PdfStudio will email a signing link to:</p><ul style="margin:6px 0">${d.signers.map((s) => `<li><b>${esc(s.name)}</b> &lt;${esc(s.email)}&gt;: ${fields.filter((f) => f.signer === d.signers.indexOf(s)).length} box(es)</li>`).join('')}</ul>
    <div class="row"><label>From</label><input id="frm" placeholder="Your name or company, as signers will see it"></div>
    <div class="row"><label>Tell me at</label><input id="ntf" type="email" placeholder="your email for updates"></div>`;
  const ntf = body.querySelector('#ntf') as HTMLInputElement, frm = body.querySelector('#frm') as HTMLInputElement;
  const me = await window.api.authStatus().catch(() => ({} as any));
  try { ntf.value = localStorage.getItem('pdfstudio.esignNotify') || (EMAIL_RE.test(me.email || '') ? me.email : ''); frm.value = localStorage.getItem('pdfstudio.esignFrom') || me.username || ''; } catch { /* none */ }
  const ok = await modal(`Send "${d.title}"?`, body, [{ label: 'Back', value: 'cancel' }, { label: 'Send now', kind: 'primary', value: 'ok' }]);
  if (ok !== 'ok') return;
  const notifyEmail = ntf.value.trim();
  if (notifyEmail && !EMAIL_RE.test(notifyEmail)) { toast('That email for updates does not look right', true); return; }
  const fromName = frm.value.trim();
  try { localStorage.setItem('pdfstudio.esignNotify', notifyEmail); localStorage.setItem('pdfstudio.esignFrom', fromName); } catch { /* none */ }
  try {
    app.editor.select(null);
    toast('Sending…');
    const { bytes } = await buildPdf(t);
    const meta = { title: d.title, message: d.message, fileName: t.name, signers: d.signers, fields, notifyEmail, fromName: fromName || me.username || '' };
    const res = await window.api.esignCreate(meta, bytes) as Req;
    void recordUsed(d.signers, getSavePref()).catch(() => { /* contacts are a convenience only */ });
    // the boxes were only for sending: remove them from the open document
    t.push();
    for (const k of Object.keys(t.objects)) t.objects[Number(k)] = (t.objects[Number(k)] || []).filter((o) => o.type !== 'signfield');
    app.editor.esign = null; app.editor.setTool('select'); app.editor.refresh();
    const failed = res.signers.filter((s) => !s.emailedAt);
    if (failed.length) toast(`Sent, but the email to ${failed.map((s) => s.email).join(', ')} did not go out. Use "Copy link" in Signing requests.`, true);
    else toast(`Sent to ${res.signers.length} signer${res.signers.length > 1 ? 's' : ''}. Track it under Sign → Signing requests.`);
    void requestsPanel(app);
  } catch (e) { toast(`Could not send: ${cleanErr(e)}`, true); }
}

// ---------------- step 3: track + finish ----------------
const STATUS: Record<string, string> = { sent: 'Waiting', viewed: 'Opened', signed: 'Signed', declined: 'Declined' };

export async function requestsPanel(app: App): Promise<void> {
  const body = el('div');
  body.style.cssText = 'width:min(600px,84vw);max-height:65vh;overflow:auto;display:flex;flex-direction:column;gap:10px';
  let closeIt: ((v: string) => void) | null = null;
  const render = async () => {
    body.replaceChildren(el('div', 'hint', {}, 'Loading…'));
    let reqs: Req[]; let emailReady = true;
    try { const j = await window.api.esign('GET', 'requests'); reqs = j.requests; emailReady = j.emailReady; }
    catch (e) { body.replaceChildren(el('div', 'hint', {}, esc(`Could not load: ${cleanErr(e)}`))); return; }
    body.replaceChildren();
    if (!emailReady) body.appendChild(el('div', 'hint', {}, 'Email sending is not set up yet, so use "Copy link" to send each person their link yourself.'));
    if (!reqs.length) { body.appendChild(el('div', 'hint', {}, 'Nothing sent yet. Open a PDF, then Sign → Send for others to sign.')); return; }
    for (const r of reqs) {
      // finish automatically once everyone has signed
      if (r.status === 'completed' && !r.finalizedAt) {
        try { await finalize(app, r); r.finalizedAt = Date.now(); } catch (e) { toast(`Could not finish "${r.title}": ${cleanErr(e)}`, true); }
      }
      const st = r.status === 'completed' ? (r.finalizedAt ? 'Completed' : 'Everyone signed') : r.status === 'sent' ? 'Waiting for signatures' : r.status === 'declined' ? 'Declined' : 'Canceled';
      const card = el('div');
      card.style.cssText = 'border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px';
      card.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><b style="color:var(--text)">${esc(r.title)}</b><small>${esc(st)} · sent ${esc(when(r.createdAt))}</small></div>`;
      for (const s of r.signers) {
        const line = el('div', 'row');
        line.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
        const extra = s.status === 'signed' ? ` ${when(s.signedAt)}` : s.status === 'declined' ? `${s.declineReason ? `: ${s.declineReason}` : ''}` : s.emailError ? ` (email failed: ${s.emailError})` : '';
        line.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:${SIGNER_COLORS[s.idx % SIGNER_COLORS.length]}"></span><span style="flex:1;min-width:180px">${esc(s.name)} &lt;${esc(s.email)}&gt;</span><small>${esc((STATUS[s.status] || s.status) + extra)}</small>`;
        if (r.status === 'sent' && s.status !== 'signed' && s.status !== 'declined') {
          const cp = el('button', 'btn', {}, 'Copy link'); cp.style.padding = '3px 8px';
          cp.onclick = async () => { try { await navigator.clipboard.writeText(s.link); toast(`Link for ${s.name} copied. Only send it to them.`); } catch { await modal('Signing link', `<input value="${esc(s.link)}" style="width:100%" readonly>`, [{ label: 'Close', value: 'x' }]); } };
          const rm = el('button', 'btn', {}, 'Email again'); rm.style.padding = '3px 8px';
          rm.onclick = async () => { try { const j = await window.api.esign('POST', `requests/${r.id}/remind`, { signerId: s.id }); const x = j.results?.[0]; toast(x?.ok ? `Reminder sent to ${s.email}` : `Email failed: ${x?.error || 'unknown'}`, !x?.ok); } catch (e) { toast(cleanErr(e), true); } };
          line.append(cp, rm);
        }
        card.appendChild(line);
      }
      const acts = el('div'); acts.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap';
      if (r.finalizedAt) {
        const op = el('button', 'btn primary', {}, 'Open signed PDF'); op.onclick = async () => { closeIt?.('x'); await openFinal(app, r); };
        const dl = el('button', 'btn', {}, 'Download'); dl.onclick = async () => { try { download(await window.api.esignBytes(`requests/${r.id}/final`), signedName(r)); } catch (e) { toast(cleanErr(e), true); } };
        acts.append(op, dl);
      }
      if (r.status === 'sent' || r.status === 'declined') {
        const cx = el('button', 'btn', {}, 'Cancel request');
        cx.onclick = async () => {
          if ((await modal('Cancel this request?', 'The signing links stop working. This cannot be undone.', [{ label: 'Keep it', value: 'no' }, { label: 'Cancel request', kind: 'danger', value: 'yes' }])) !== 'yes') return;
          try { await window.api.esign('POST', `requests/${r.id}/cancel`); toast('Canceled'); void render(); } catch (e) { toast(cleanErr(e), true); }
        };
        acts.appendChild(cx);
      }
      if (acts.childElementCount) card.appendChild(acts);
      body.appendChild(card);
    }
  };
  void render();
  const p = modal('Signing requests', body, [{ label: 'Refresh', value: 'refresh' }, { label: 'Close', kind: 'primary', value: 'close' }]);
  closeIt = (v) => { (document.querySelector('.modal-bg:last-child .modal') as any)?._done?.(v); };
  if ((await p) === 'refresh') return requestsPanel(app);
}

const signedName = (r: Req) => `${(r.fileName || r.title || 'document').replace(/\.pdf$/i, '')} (signed).pdf`;

async function openFinal(app: App, r: Req) {
  try {
    const bytes = await window.api.esignBytes(`requests/${r.id}/final`);
    const { DocTab } = await import('./doc');
    await app.addTab(await DocTab.create(bytes, null, signedName(r)));
    toast('This is the signed copy. Use Save As or Cloud to keep it.');
  } catch (e) { toast(cleanErr(e), true); }
}

// ---------------- build the signed PDF ----------------
class Mapper {
  W: number; H: number; ox: number; oy: number; rot: number;
  constructor(page: PDFPage) {
    const cb = page.getCropBox();
    this.W = cb.width; this.H = cb.height; this.ox = cb.x; this.oy = cb.y;
    this.rot = ((page.getRotation().angle % 360) + 360) % 360;
  }
  pt(vx: number, vy: number): [number, number] {
    const { W, H } = this; let ux: number, uy: number;
    switch (this.rot) { case 90: ux = vy; uy = vx; break; case 180: ux = W - vx; uy = vy; break; case 270: ux = W - vy; uy = H - vx; break; default: ux = vx; uy = H - vy; }
    return [ux + this.ox, uy + this.oy];
  }
}
const ascii = (font: PDFFont, s: string) => { const ok = new Set(font.getCharacterSet()); let o = ''; for (const ch of s) o += ok.has(ch.codePointAt(0)!) ? ch : '?'; return o; };

async function finalize(app: App, r0: Req) {
  const r = await window.api.esign('GET', `requests/${r0.id}`) as Req;
  const original = await window.api.esignBytes(`requests/${r.id}/original`);
  const { values } = await window.api.esign('GET', `requests/${r.id}/values`) as { values: Record<string, { values: Record<string, string>; tz?: string; signedAt: number }> };
  const doc = await PDFDocument.load(original, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  for (const f of r.fields) {
    const s = r.signers.find((x) => x.idx === f.signer); const sv = s && values[s.id];
    const v = sv?.values?.[f.id]; const page = pages[f.page];
    if (!v || !page) continue;
    const m = new Mapper(page);
    if (f.kind === 'signature' || f.kind === 'initials') {
      const img = await doc.embedPng(await dataUrlToBytes(v));
      const k = Math.min(f.w / img.width, f.h / img.height);
      const dw = img.width * k, dh = img.height * k, ox = (f.w - dw) / 2, oy = (f.h - dh) / 2;
      const [x, y] = m.pt(f.x + ox, f.y + oy + dh);
      page.drawImage(img, { x, y, width: dw, height: dh, rotate: degrees(m.rot) });
    } else {
      let text = v;
      if (f.kind === 'date') {
        try { text = new Date(v).toLocaleDateString('en-US', { timeZone: sv?.tz || undefined, year: 'numeric', month: 'short', day: 'numeric' }); }
        catch { text = new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
      }
      text = ascii(font, text);
      let size = Math.min(12, f.h * 0.7);
      while (size > 5 && font.widthOfTextAtSize(text, size) > f.w - 4) size -= 0.5;
      const [x, y] = m.pt(f.x + 2, f.y + f.h / 2 + size * 0.35);
      page.drawText(text, { x, y, size, font, color: rgb(0.07, 0.09, 0.15), rotate: degrees(m.rot) });
    }
  }
  // ---- certificate of completion ----
  const utc = (t?: number) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-');
  const lines: [string, PDFFont, number][] = [];
  const L = (t: string, f = font, s = 9.5) => lines.push([t, f, s]);
  L('Certificate of completion', bold, 16); L('');
  L(`Document: ${r.title}`, bold, 11); L(`File: ${r.fileName}`); L(`Request ID: ${r.id}`);
  L(`Original document SHA-256: ${r.docHash}`); L(`Sent: ${utc(r.createdAt)}    Completed: ${utc(r.completedAt)}`);
  L('Signed electronically through PdfStudio (trivedipos.com). Each signer agreed to sign electronically before signing.'); L('');
  for (const s of r.signers) {
    L(`${s.name} <${s.email}>`, bold, 11);
    L(`Status: ${STATUS[s.status] || s.status}    Opened: ${utc(s.viewedAt)}    Signed: ${utc(s.signedAt)}`);
    L(`IP address: ${s.ip || '-'}`); L(`Device: ${(s.ua || '-').slice(0, 140)}`); L('');
  }
  L('History', bold, 11);
  for (const e of r.events || []) L(`${utc(e.at)}  ${e.who ? e.who + ': ' : ''}${e.what}${e.ip ? `  (IP ${e.ip})` : ''}`, font, 8.5);
  let page = doc.addPage([612, 792]); let y = 750;
  for (const [t, f, s] of lines) {
    const words = ascii(f, t).split(' '); let cur = '';
    const flush = () => { if (y < 50) { page = doc.addPage([612, 792]); y = 750; } page.drawText(cur, { x: 50, y, size: s, font: f, color: rgb(0.1, 0.12, 0.18) }); y -= s * 1.45; cur = ''; };
    if (!t) { y -= 6; continue; }
    for (const w of words) { const nx = cur ? `${cur} ${w}` : w; if (f.widthOfTextAtSize(nx, s) > 512 && cur) { flush(); cur = w; } else cur = nx; }
    if (cur) flush();
  }
  doc.setTitle(`${r.title} (signed)`); doc.setProducer('PdfStudio');
  const out = await doc.save();
  await window.api.esignPutFinal(r.id, out);
  toast(`"${r.title}" is complete. Everyone was emailed the signed copy.`);
}
