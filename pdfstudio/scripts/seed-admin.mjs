// Creates the FIRST admin invite. Prints the one-time join link and writes worker/seed-admin.sql.
// Usage: node scripts/seed-admin.mjs you@example.com [https://trivedipos.com]
//   then: npx wrangler d1 execute pdfstudio-db --file worker/seed-admin.sql [--local | --remote]
import crypto from 'node:crypto';
import fs from 'node:fs';

const email = (process.argv[2] || '').trim().toLowerCase();
const origin = process.argv[3] || 'http://localhost:8787';
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error('Usage: node scripts/seed-admin.mjs you@example.com [origin]'); process.exit(1); }

const token = crypto.randomBytes(24).toString('hex');
const hash = crypto.createHash('sha256').update(token).digest('hex');
const now = Date.now();
const sql = `INSERT INTO invites (id, token_hash, email, role, user_id, expires_at, created_by, created_at)
VALUES ('${crypto.randomBytes(8).toString('hex')}', '${hash}', '${email.replace(/'/g, "''")}', 'admin', NULL, ${now + 7 * 86400000}, 'seed', ${now});\n`;
fs.writeFileSync('worker/seed-admin.sql', sql);
console.log(`Admin invite for ${email} (valid 7 days, works once):\n${origin}/pdfstudio/join?token=${token}`);
