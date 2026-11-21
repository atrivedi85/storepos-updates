import type { App } from './app';
import type { PageView } from './viewer';
import { el } from './util';

/** Overlay interactive inputs for the existing AcroForm fields on a page. */
export function renderFormFields(app: App, pv: PageView) {
  const tab = pv.tab;
  pv.formLayer.replaceChildren();
  const fields = tab.formFields.filter((f) => f.page === pv.index);
  for (const f of fields) {
    const { x, y, w, h } = f.rect;
    const common = (e: HTMLElement) => {
      e.classList.add('fieldinput');
      e.style.left = `${x}px`; e.style.top = `${y}px`; e.style.width = `${w}px`; e.style.height = `${h}px`;
      e.title = f.name;
      pv.formLayer.appendChild(e);
    };
    const commit = (v: string | boolean) => {
      if (tab.formValues[f.name] === v) return;
      tab.push();
      tab.formValues[f.name] = v;
      app.onDocChanged();
    };
    const fs = f.fontSize > 0 ? f.fontSize : Math.max(7, Math.min(h * 0.68, 16));
    if (f.type === 'text') {
      const val = String(tab.formValues[f.name] ?? '');
      let inp: HTMLInputElement | HTMLTextAreaElement;
      if (f.multiline) { inp = el('textarea'); inp.style.resize = 'none'; inp.style.paddingTop = '2px'; }
      else { inp = el('input', '', { type: 'text' }); }
      inp.value = val;
      inp.style.fontSize = `${fs}px`;
      if (f.readOnly) inp.readOnly = true;
      common(inp);
      inp.addEventListener('change', () => commit(inp.value));
      inp.addEventListener('keydown', (e) => e.stopPropagation());
    } else if (f.type === 'check') {
      const inp = el('input', 'fchk', { type: 'checkbox' }) as HTMLInputElement;
      inp.checked = !!tab.formValues[f.name];
      common(inp);
      inp.addEventListener('change', () => { commit(inp.checked); });
    } else if (f.type === 'radio') {
      const inp = el('input', 'fchk', { type: 'radio' }) as HTMLInputElement;
      inp.style.borderRadius = '50%';
      inp.checked = tab.formValues[f.name] === f.radioValue;
      common(inp);
      inp.addEventListener('change', () => { if (inp.checked) { commit(f.radioValue ?? ''); app.editor.refresh(pv.index); } });
    } else {
      const sel = el('select');
      if (f.type === 'list') { sel.size = Math.max(2, Math.floor(h / 14)); }
      const cur = String(tab.formValues[f.name] ?? '');
      const opts = f.options.length ? f.options : [];
      if (!opts.includes(cur) && cur) opts.unshift(cur);
      sel.innerHTML = (f.type === 'dropdown' ? '<option value=""></option>' : '') + opts.map((o) => `<option value="${o.replace(/"/g, '&quot;')}">${o.replace(/</g, '&lt;')}</option>`).join('');
      sel.value = cur;
      sel.style.fontSize = `${Math.min(fs, 14)}px`;
      common(sel);
      sel.addEventListener('change', () => commit(sel.value));
    }
  }
}

