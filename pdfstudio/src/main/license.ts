import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pub from './pubkey.json';

export interface LicenseStatus {
  licensed: boolean; name?: string; expires?: string; machineId: string; error?: string;
}

const licFile = () => path.join(app.getPath('userData'), 'license.key');

let cachedMachine = '';
export function machineId(): string {
  if (cachedMachine) return cachedMachine;
  let raw = '';
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true });
    raw = (out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i) || [])[1] || '';
  } catch { /* fall through */ }
  if (!raw) raw = process.env.COMPUTERNAME + '|' + process.env.USERNAME;
  const h = crypto.createHash('sha256').update('pdfstudio:' + raw).digest('hex').toUpperCase().slice(0, 16);
  cachedMachine = h.match(/.{4}/g)!.join('-');
  return cachedMachine;
}

export function verifyKey(key: string): LicenseStatus {
  const mid = machineId();
  const bad = (error: string): LicenseStatus => ({ licensed: false, machineId: mid, error });
  try {
    const m = key.trim().replace(/\s+/g, '').match(/^PDFS-([\w-]+)\.([\w-]+)$/);
    if (!m) return bad('That does not look like a PdfStudio license key.');
    const data = Buffer.from(m[1], 'base64url');
    const sig = Buffer.from(m[2], 'base64url');
    const ok = crypto.verify(null, data, crypto.createPublicKey(pub.pem), sig);
    if (!ok) return bad('Invalid license key.');
    const p = JSON.parse(data.toString('utf8')) as { name: string; machine?: string; exp?: string };
    if (p.machine && p.machine.toUpperCase() !== mid) return bad('This key was issued for a different computer.');
    if (p.exp && new Date(p.exp + 'T23:59:59') < new Date()) return bad(`This license expired on ${p.exp}.`);
    return { licensed: true, name: p.name, expires: p.exp, machineId: mid };
  } catch {
    return bad('Invalid license key.');
  }
}

export function currentStatus(): LicenseStatus {
  try {
    const key = fs.readFileSync(licFile(), 'utf8');
    return verifyKey(key);
  } catch {
    return { licensed: false, machineId: machineId() };
  }
}

export function activate(key: string): LicenseStatus {
  const st = verifyKey(key);
  if (st.licensed) fs.writeFileSync(licFile(), key.trim());
  return st;
}

export function deactivate() {
  try { fs.unlinkSync(licFile()); } catch { /* ignore */ }
}
