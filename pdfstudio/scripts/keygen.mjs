// PdfStudio license tool (vendor side). Keep keys/private.pem SECRET - never ship it.
//   node scripts/keygen.mjs init                       create your signing keypair (once)
//   node scripts/keygen.mjs issue --name "Jane Roe"    unlimited key, works on any PC
//   node scripts/keygen.mjs issue --name "Jane" --machine ABCD-1234-EF56-7890   locked to one PC
//   node scripts/keygen.mjs issue --name "Jane" --days 365                      expires in a year
import crypto from 'node:crypto';
import fs from 'node:fs';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (k) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined; };
const b64u = (b) => Buffer.from(b).toString('base64url');

if (cmd === 'init') {
  if (fs.existsSync('keys/private.pem')) { console.error('keys/private.pem already exists - refusing to overwrite (existing keys would stop working).'); process.exit(1); }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync('keys', { recursive: true });
  fs.writeFileSync('keys/private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync('src/main/pubkey.json', JSON.stringify({ pem: publicKey.export({ type: 'spki', format: 'pem' }) }, null, 2));
  console.log('Keypair created. Rebuild the app (npm run dist) so it embeds the new public key.');
} else if (cmd === 'issue') {
  const name = arg('name');
  if (!name) { console.error('Usage: issue --name "Customer" [--machine XXXX-XXXX-XXXX-XXXX] [--days N]'); process.exit(1); }
  const priv = crypto.createPrivateKey(fs.readFileSync('keys/private.pem'));
  const payload = { v: 1, id: crypto.randomBytes(4).toString('hex'), name, issued: new Date().toISOString().slice(0, 10) };
  if (arg('machine')) payload.machine = arg('machine').toUpperCase().trim();
  if (arg('days')) payload.exp = new Date(Date.now() + Number(arg('days')) * 864e5).toISOString().slice(0, 10);
  const data = Buffer.from(JSON.stringify(payload));
  const key = `PDFS-${b64u(data)}.${b64u(crypto.sign(null, data, priv))}`;
  fs.appendFileSync('keys/issued.log', `${new Date().toISOString()}\t${JSON.stringify(payload)}\n`);
  console.log('\n' + key + '\n');
  console.log(`Licensed to: ${name}${payload.machine ? ' | locked to PC ' + payload.machine : ' | any PC'}${payload.exp ? ' | expires ' + payload.exp : ' | no expiry'}`);
} else {
  console.log('Commands: init | issue --name "X" [--machine ID] [--days N]');
}
