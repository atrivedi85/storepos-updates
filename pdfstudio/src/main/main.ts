import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { currentStatus, login, login2fa, login2faEmail, logout, onAuthChange, startRevalidating } from './auth';
import * as cloud from './cloud';
import { parseCloudPath } from '../shared/cloud';
import { autoUpdater } from 'electron-updater';

const isDev = !app.isPackaged;
let win: BrowserWindow | null = null;
let forceClose = false;
const pendingOpen: string[] = [];

const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
function loadRecent(): string[] {
  try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')); } catch { return []; }
}
function saveRecent(list: string[]) {
  try { fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 15))); } catch { /* ignore */ }
}
function addRecent(p: string) {
  const list = loadRecent().filter((x) => x.toLowerCase() !== p.toLowerCase());
  list.unshift(p);
  saveRecent(list);
}

function pdfArgs(argv: string[]): string[] {
  return argv.slice(1).filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#1e2230',
    title: 'PdfStudio',
    icon: path.join(__dirname, '../../build/icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => win?.show());

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (isDev && process.env.PDFSTUDIO_LOG) console.log(`[renderer:${level}] ${message} (${source}:${line})`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (forceClose || !win) return;
    e.preventDefault();
    win.webContents.send('app:close-request');
  });
  win.on('closed', () => { win = null; });

  // Optional automation for self-testing: run a script then screenshot.
  if (!app.isPackaged && process.env.PDFSTUDIO_SHOT) {
    const shot = process.env.PDFSTUDIO_SHOT;
    const script = process.env.PDFSTUDIO_SCRIPT ? fs.readFileSync(process.env.PDFSTUDIO_SCRIPT, 'utf8') : '';
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      if (script) {
        try {
          const res = await win!.webContents.executeJavaScript(script);
          if (res !== undefined) console.log('[script-result]', typeof res === 'string' ? res : JSON.stringify(res));
        } catch (err) { console.log('[script-error]', String(err)); }
      }
      await new Promise((r) => setTimeout(r, Number(process.env.PDFSTUDIO_WAIT || 1500)));
      const img = await win!.webContents.capturePage();
      fs.writeFileSync(shot, img.toPNG());
      forceClose = true;
      app.quit();
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !(isDev && process.env.PDFSTUDIO_SHOT)) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = pdfArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (files.length) win.webContents.send('app:open-files', files);
    }
  });
  app.whenReady().then(() => {
    pendingOpen.push(...pdfArgs(process.argv));
    createWindow();
    onAuthChange((s) => { win?.webContents.send('auth:changed', s); if (s.signedIn) cloud.syncAll(); });
    cloud.onCloudEvent((e) => win?.webContents.send('cloud:event', e));
    startRevalidating();
    cloud.startSync();
    setupUpdater();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------- IPC ----------
// Everything that touches files requires a signed-in account, so the app is useless without one.
function gated(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...a: any[]) => any) {
  ipcMain.handle(channel, (e, ...a) => {
    if (!currentStatus().signedIn) throw new Error('Please sign in to PdfStudio.');
    return fn(e, ...a);
  });
}
ipcMain.handle('auth:status', () => currentStatus());
ipcMain.handle('auth:login', (_e, u: string, p: string) => login(String(u || '').trim(), String(p || '')));
ipcMain.handle('auth:login2fa', (_e, t: string, c: string) => login2fa(String(t || ''), String(c || '')));
ipcMain.handle('auth:login2faEmail', (_e, t: string) => login2faEmail(String(t || '')));
ipcMain.handle('auth:logout', () => logout());
const pdfFilter = [{ name: 'PDF documents', extensions: ['pdf'] }];

ipcMain.handle('init:files', () => (currentStatus().signedIn ? pendingOpen.splice(0) : []));
// Cloud library (server + offline cache). Paths look like cloud://<id>/<name>.
gated('cloud:list', () => cloud.list());
gated('cloud:create', (_e, name: string, data: Uint8Array) => cloud.create(String(name), data));
gated('cloud:rename', (_e, id: string, name: string) => cloud.rename(String(id), String(name)));
gated('cloud:delete', (_e, id: string) => cloud.remove(String(id)));
gated('file:read', async (_e, p: string) => {
  const cid = parseCloudPath(p);
  if (cid) return cloud.read(cid);
  const buf = await fs.promises.readFile(p);
  addRecent(p);
  return new Uint8Array(buf);
});
gated('file:write', async (_e, p: string, data: Uint8Array) => {
  const cid = parseCloudPath(p);
  if (cid) { await cloud.write(cid, data); return true; }
  await fs.promises.writeFile(p, Buffer.from(data));
  addRecent(p);
  return true;
});
gated('dialog:open', async (_e, multi: boolean) => {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Open PDF', filters: pdfFilter,
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  return r.canceled ? [] : r.filePaths;
});
gated('dialog:save', async (_e, defaultName: string) => {
  const r = await dialog.showSaveDialog(win!, { title: 'Save PDF', defaultPath: defaultName, filters: pdfFilter });
  return r.canceled ? null : r.filePath!;
});
gated('dialog:image', async () => {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Insert image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), bytes: new Uint8Array(await fs.promises.readFile(p)) };
});
gated('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
gated('files:writeMany', async (_e, folder: string, files: { name: string; data: Uint8Array }[]) => {
  for (const f of files) await fs.promises.writeFile(path.join(folder, f.name), Buffer.from(f.data));
  return files.length;
});
ipcMain.handle('recent:get', () => loadRecent().filter((p) => fs.existsSync(p)));
ipcMain.handle('recent:clear', () => { saveRecent([]); return true; });
ipcMain.handle('shell:reveal', (_e, p: string) => { shell.showItemInFolder(p); });
ipcMain.handle('app:confirm-close', () => { forceClose = true; win?.close(); });
ipcMain.handle('app:set-title', (_e, t: string) => { win?.setTitle(t); });

// ---------- auto-update (GitHub Releases) ----------
type UpdateMsg = { state: 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number; message?: string; notes?: string };
let manualCheck = false;
function sendUpdate(m: UpdateMsg) { win?.webContents.send('update:state', m); }
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => manualCheck && sendUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => { if (manualCheck) sendUpdate({ state: 'none' }); manualCheck = false; });
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => { manualCheck = false; sendUpdate({ state: 'ready', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.replace(/<[^>]+>/g, '').trim() : '' }); });
  autoUpdater.on('error', (e) => { if (manualCheck) sendUpdate({ state: 'error', message: String(e?.message || e).split('\n')[0] }); manualCheck = false; });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) { sendUpdate({ state: 'error', message: 'Updates only work in the installed app.' }); return; }
  manualCheck = true;
  try { await autoUpdater.checkForUpdates(); } catch (e: any) { manualCheck = false; sendUpdate({ state: 'error', message: String(e?.message || e).split('\n')[0] }); }
});
ipcMain.handle('update:install', () => { forceClose = true; autoUpdater.quitAndInstall(false, true); });
ipcMain.handle('app:version', () => app.getVersion());
