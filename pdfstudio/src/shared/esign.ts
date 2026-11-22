// "Send for signature" API calls, shared by the desktop app (main process) and the web app.
export type RawFetch = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: any }) => Promise<Response>;

async function bad(r: Response): Promise<never> {
  const j: any = await r.json().catch(() => ({}));
  throw new Error(j.error || `Server error (${r.status})`);
}
export function esignClient(f: RawFetch) {
  const call: RawFetch = async (p, i) => { try { return await f(`esign/${p}`, i); } catch { throw new Error('Cannot reach the PdfStudio server. Check the internet connection.'); } };
  return {
    async json(method: string, path: string, body?: unknown): Promise<any> {
      const r = await call(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (!r.ok) return bad(r);
      return r.json();
    },
    async bytes(path: string): Promise<Uint8Array> {
      const r = await call(path);
      if (!r.ok) return bad(r);
      return new Uint8Array(await r.arrayBuffer());
    },
    async create(meta: unknown, pdf: Uint8Array): Promise<any> {
      const m = new TextEncoder().encode(JSON.stringify(meta));
      const body = new Uint8Array(4 + m.length + pdf.length);
      new DataView(body.buffer).setUint32(0, m.length); body.set(m, 4); body.set(pdf, 4 + m.length);
      const r = await call('requests', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
      if (!r.ok) return bad(r);
      return r.json();
    },
    async putFinal(id: string, pdf: Uint8Array): Promise<void> {
      const r = await call(`requests/${id}/final`, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: pdf });
      if (!r.ok) return bad(r);
    },
  };
}
