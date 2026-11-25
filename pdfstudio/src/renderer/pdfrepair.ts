// Open a PDF with pdf.js; if it is damaged (broken page list, missing page object, bad xref) open a repaired copy instead.
// Works with any pdf.js build (browser or node), so the test script can use it too. Repair logic: pdfrepair-core.ts.
import { repairPdf } from './pdfrepair-core';

export interface OpenResult {
  pdf: any;               // pdf.js document
  bytes: Uint8Array;      // the bytes the document was opened from (the repaired copy when repaired)
  repaired: boolean;
  badPages: number[];     // 0-based pages that pdf.js could not load (they show blank)
}

export const REPAIR_NOTICE = (n: number) =>
  `This PDF was damaged. PdfStudio repaired it and opened ${n} page${n === 1 ? '' : 's'}; some pages or pictures may be missing. Use Save As to keep the repaired copy.`;

async function tryOpen(lib: any, bytes: Uint8Array, opts: any) {
  const task = lib.getDocument({ ...opts, data: bytes.slice() });
  const pdf = await task.promise;
  try {
    if (!pdf.numPages) throw new Error('no pages');
    const refs = new Set<number>(), bad: number[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      try { const p = await pdf.getPage(i); if (p?.ref) refs.add(p.ref.num); } catch { bad.push(i - 1); }
    }
    return { pdf, refs, bad, good: pdf.numPages - bad.length };
  } catch (e) { try { await pdf.destroy?.(); } catch { /* ignore */ } throw e; }
}

const isPassword = (e: any) => e?.name === 'PasswordException' || /password/i.test(e?.message || '');
const quiet = (pdf: any) => { try { const r = pdf?.destroy?.(); r?.catch?.(() => {}); } catch { /* ignore */ } };

export async function openWithRepair(lib: any, bytes: Uint8Array, opts: any = {}): Promise<OpenResult> {
  let orig: Awaited<ReturnType<typeof tryOpen>> | null = null, err: any = null;
  try { orig = await tryOpen(lib, bytes, opts); } catch (e) { if (isPassword(e)) throw e; err = e; }
  // Only a file pdf.js cannot open, or one with pages it cannot load, is repaired. A file that opens cleanly is never touched
  // (looking for "hidden" page objects would bring back pages that were deleted on purpose in an earlier edit).
  // One more case is checked on smaller files: pdf.js showing something that is not a page (a font, say) as a blank page.
  if (orig && !orig.bad.length && bytes.length > 40 * 1024 * 1024) return { pdf: orig.pdf, bytes, repaired: false, badPages: [] };
  let fixed: any = null;
  try { fixed = repairPdf(bytes); } catch { fixed = null; }
  if (orig && !orig.bad.length && !(fixed && [...orig.refs].some((n) => !fixed.pageNums.includes(n)))) { return { pdf: orig.pdf, bytes, repaired: false, badPages: [] }; }
  if (!fixed) { if (orig) return { pdf: orig.pdf, bytes, repaired: false, badPages: orig.bad }; throw err; }
  const real = new Set<number>(fixed.pageNums);
  let rep: Awaited<ReturnType<typeof tryOpen>> | null = null;
  try { rep = await tryOpen(lib, fixed as Uint8Array, opts); } catch { rep = null; }
  const fake = orig ? [...orig.refs].filter((n) => !real.has(n)).length : 0;   // things pdf.js showed as pages that are not pages
  const origGood = orig ? orig.good - fake : 0;
  if (rep && (!orig || rep.good > origGood || (rep.good === origGood && (fake > 0 || rep.bad.length < orig.bad.length)))) {
    if (orig) quiet(orig.pdf);
    return { pdf: rep.pdf, bytes: fixed as Uint8Array, repaired: true, badPages: rep.bad };
  }
  if (rep) quiet(rep.pdf);
  if (orig) return { pdf: orig.pdf, bytes, repaired: false, badPages: orig.bad };
  throw err;
}
