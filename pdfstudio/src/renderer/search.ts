import type { DocTab } from './doc';
import type { Box } from './types';

export interface Hit { page: number; box: Box }

export async function searchDoc(tab: DocTab, q: string, matchCase: boolean): Promise<Hit[]> {
  const hits: Hit[] = [];
  if (!q) return hits;
  const needle = matchCase ? q : q.toLowerCase();
  for (let p = 0; p < tab.pages.length; p++) {
    const pt = await tab.getText(p);
    const hay = matchCase ? pt.text : pt.text.toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      from = i + Math.max(1, needle.length);
      const end = i + needle.length;
      // split the match across runs
      for (let m = 0; m < pt.map.length; m++) {
        const start = pt.map[m].start;
        const run = pt.runs[pt.map[m].run];
        const rEnd = start + run.str.length;
        if (rEnd <= i || start >= end) continue;
        const a = Math.max(i, start) - start, b = Math.min(end, rEnd) - start;
        const len = Math.max(1, run.str.length);
        const x = run.x + (a / len) * run.w;
        const w = ((b - a) / len) * run.w;
        hits.push({ page: p, box: { x, y: run.y, w: Math.max(w, 2), h: run.h } });
      }
    }
  }
  return hits;
}
