// Bridge to the Android wrapper app (window.PdfAndroid) and phone helpers. Everything here works when the bridge is absent.
const w = window as any;

export const isAndroid = () => !!w.PdfAndroid || /PdfStudioAndroid/.test(navigator.userAgent);

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Android app: the sign-in token is kept in the app's private storage, so the person stays signed in (30 days, renewed while used)
 *  even if the web view loses its cookies. Everything is a no-op outside the Android app. */
export const androidToken = {
  available: (): boolean => typeof w.PdfAndroid?.saveToken === 'function',
  get(): string { try { return String(w.PdfAndroid?.getToken?.() || ''); } catch { return ''; } },
  set(t: string) { try { w.PdfAndroid?.saveToken?.(t); } catch { /* ignore */ } },
  clear() { try { w.PdfAndroid?.clearToken?.(); } catch { /* ignore */ } },
};

/** Android app lock (fingerprint / face / screen lock). status: 'ok' = can be switched on, 'none' = phone has no screen lock set up,
 *  'unavailable' = this phone cannot do it, '' = not the Android app (or an older app without the feature). */
export const appLock = {
  status(): 'ok' | 'none' | 'unavailable' | '' {
    try { const s = String(w.PdfAndroid?.biometricStatus?.() || ''); return s === 'ok' || s === 'none' || s === 'unavailable' ? s : ''; } catch { return ''; }
  },
  enabled(): boolean { try { return !!w.PdfAndroid?.getAppLock?.(); } catch { return false; } },
  set(on: boolean) { try { w.PdfAndroid?.setAppLock?.(on); } catch { /* ignore */ } },
};

/** Android: opens the native Save dialog. Returns false when there is no Android bridge (caller downloads instead). */
export function androidSave(name: string, bytes: Uint8Array): boolean {
  if (typeof w.PdfAndroid?.saveFile !== 'function') return false;
  w.PdfAndroid.saveFile(name, toBase64(bytes));
  return true;
}

/** Share a file: Android share sheet, else the browser share sheet with the file, else download it. */
export async function shareBytes(name: string, bytes: Uint8Array, type = 'application/pdf'): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (typeof w.PdfAndroid?.shareFile === 'function') { w.PdfAndroid.shareFile(name, toBase64(bytes)); return 'shared'; }
  try {
    const file = new File([bytes as BlobPart], name, { type });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return 'shared'; }
  } catch (e: any) { if (e?.name === 'AbortError') return 'cancelled'; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return 'downloaded';
}
