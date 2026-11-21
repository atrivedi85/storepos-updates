// Cloud library client shared by the desktop app (main process) and the web app (browser).
// The caller supplies a fetcher that talks to /pdfstudio/api/ with the right credentials.

export interface CloudFile { id: string; name: string; size: number; rev: number; updatedAt: number }
export interface CloudInfo extends CloudFile { dirty?: boolean; cached?: boolean }
export interface CloudListing { files: CloudInfo[]; used: number; quota: number; offline: boolean }
export interface CloudEvent { type: 'info' | 'error' | 'pending'; message?: string; pending?: number }

export class CloudOffline extends Error { constructor() { super('Cannot reach the PdfStudio server.'); } }
export class CloudConflict extends Error {
  constructor(public current: CloudFile | null) { super('This file was changed somewhere else.'); }
}
export class CloudError extends Error { constructor(public status: number, message: string) { super(message); } }

export type Fetcher = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: any }) => Promise<Response>;

export const cloudPath = (id: string, name: string) => `cloud://${id}/${name}`;
export const parseCloudPath = (p: string): string | null => (p.match(/^cloud:\/\/([a-f0-9]{16})\//) || [])[1] || null;

export function conflictName(name: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return `${name.replace(/\.pdf$/i, '')} (conflict copy ${d}).pdf`;
}

export function cloudClient(f: Fetcher) {
  const call: Fetcher = async (path, init) => {
    try { return await f(path, init); } catch { throw new CloudOffline(); }
  };
  const bad = async (r: Response): Promise<never> => {
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 409) throw new CloudConflict(j.current || null);
    throw new CloudError(r.status, j.error || `Server error (${r.status})`);
  };
  return {
    async list(): Promise<{ files: CloudFile[]; used: number; quota: number }> {
      const r = await call('files');
      if (!r.ok) return bad(r);
      return r.json() as any;
    },
    async get(id: string, haveRev?: number): Promise<{ notModified: true } | { notModified: false; bytes: Uint8Array; rev: number; name: string }> {
      const r = await call(`files/${id}`, haveRev ? { headers: { 'if-none-match': `"${haveRev}"` } } : undefined);
      if (r.status === 304) return { notModified: true };
      if (!r.ok) return bad(r);
      return {
        notModified: false, bytes: new Uint8Array(await r.arrayBuffer()),
        rev: Number(r.headers.get('x-pdfs-rev')), name: decodeURIComponent(r.headers.get('x-pdfs-name') || ''),
      };
    },
    async create(name: string, bytes: Uint8Array): Promise<CloudFile> {
      const r = await call(`files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: bytes });
      if (!r.ok) return bad(r);
      return r.json() as any;
    },
    async update(id: string, rev: number, bytes: Uint8Array): Promise<CloudFile> {
      const r = await call(`files/${id}`, { method: 'PUT', headers: { 'content-type': 'application/pdf', 'if-match': `"${rev}"` }, body: bytes });
      if (!r.ok) return bad(r);
      return r.json() as any;
    },
    async rename(id: string, name: string): Promise<CloudFile> {
      const r = await call(`files/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!r.ok) return bad(r);
      return r.json() as any;
    },
    async remove(id: string): Promise<void> {
      const r = await call(`files/${id}`, { method: 'DELETE' });
      if (!r.ok) return bad(r);
    },
  };
}
