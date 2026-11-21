import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CloudEvent, CloudListing } from '../shared/cloud';

export interface AuthStatus { signedIn: boolean; username?: string; email?: string; role?: string; offline?: boolean; daysLeft?: number; error?: string }
export interface LoginResult extends AuthStatus { need2fa?: string; ticket?: string; to?: string; canEmail?: boolean }

const api = {
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb: (m: { state: string; version?: string; percent?: number; message?: string; notes?: string }) => void) => ipcRenderer.on('update:state', (_e, m) => cb(m)),
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
  login: (username: string, password: string): Promise<LoginResult> => ipcRenderer.invoke('auth:login', username, password),
  login2fa: (ticket: string, code: string): Promise<LoginResult> => ipcRenderer.invoke('auth:login2fa', ticket, code),
  login2faEmail: (ticket: string): Promise<{ ok: boolean; to?: string; error?: string }> => ipcRenderer.invoke('auth:login2faEmail', ticket),
  logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  onAuthChanged: (cb: (s: AuthStatus) => void) => ipcRenderer.on('auth:changed', (_e, s) => cb(s)),
  cloudList: (): Promise<CloudListing> => ipcRenderer.invoke('cloud:list'),
  cloudCreate: (name: string, bytes: Uint8Array): Promise<string> => ipcRenderer.invoke('cloud:create', name, bytes),
  cloudRename: (id: string, name: string): Promise<void> => ipcRenderer.invoke('cloud:rename', id, name),
  cloudDelete: (id: string): Promise<void> => ipcRenderer.invoke('cloud:delete', id),
  onCloudEvent: (cb: (e: CloudEvent) => void) => ipcRenderer.on('cloud:event', (_e, m) => cb(m)),
  initFiles:(): Promise<string[]> => ipcRenderer.invoke('init:files'),
  readFile: (p: string): Promise<Uint8Array> => ipcRenderer.invoke('file:read', p),
  writeFile: (p: string, d: Uint8Array): Promise<boolean> => ipcRenderer.invoke('file:write', p, d),
  openDialog: (multi = false): Promise<string[]> => ipcRenderer.invoke('dialog:open', multi),
  saveDialog: (name: string): Promise<string | null> => ipcRenderer.invoke('dialog:save', name),
  imageDialog: (): Promise<{ name: string; bytes: Uint8Array } | null> => ipcRenderer.invoke('dialog:image'),
  folderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:folder'),
  writeMany: (folder: string, files: { name: string; data: Uint8Array }[]): Promise<number> =>
    ipcRenderer.invoke('files:writeMany', folder, files),
  getRecent: (): Promise<string[]> => ipcRenderer.invoke('recent:get'),
  clearRecent: (): Promise<boolean> => ipcRenderer.invoke('recent:clear'),
  reveal: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
  setTitle: (t: string) => ipcRenderer.invoke('app:set-title', t),
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  onCloseRequest: (cb: () => void) => ipcRenderer.on('app:close-request', () => cb()),
  onOpenFiles: (cb: (files: string[]) => void) => ipcRenderer.on('app:open-files', (_e, f) => cb(f)),
  pathForFile: (f: File): string => {
    try { return webUtils.getPathForFile(f); } catch { return ''; }
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;

