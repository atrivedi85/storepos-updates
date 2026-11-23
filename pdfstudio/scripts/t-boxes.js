// Send-for-signature box editing + sender details test. Desktop renderer (stub api) or web build:
//   node build.mjs && node scripts/t-boxes.js [screenshotFolder] [web]
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const WEB = process.argv[3] === 'web';
const shots = process.argv[2] || path.join(require('os').tmpdir(), 'pdftabs'); fs.mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]); const f = p.startsWith('/samples/') ? path.join(root, p) : path.join(root, WEB ? 'dist-web/app' : 'dist/renderer', p === '/' ? '/index.html' : p);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); } });
});
let fails = 0; const check = (n, ok, i = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (i ? '  ' + i : '')); if (!ok) fails++; };
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  const sent = []; let profile = { fromName: '', notifyEmail: '' };
  const handle = (method, p, body) => {
    if (p === 'profile') { if (method !== 'GET') profile = { fromName: body.fromName, notifyEmail: body.notifyEmail }; return profile; }
    if (p === 'contacts') return { contacts: [] };
    if (p === 'requests') return { requests: [], emailReady: true };
    return {};
  };
  await page.exposeFunction('srvCall', (m, p, b) => handle(m, p, b));
  await page.exposeFunction('srvSent', (m) => { sent.push(m); });
  const me = { username: 'dalsania.milan', email: 'dalsania.milan@ledger.invalid', role: 'admin' };
  if (WEB) {
    await page.route('**/pdfstudio/api/**', async (r) => {
      const u = new URL(r.request().url()), p = u.pathname.replace('/pdfstudio/api/', '');
      let j = {};
      if (p === 'me') j = { user: me };
      else if (p.startsWith('esign/requests') && r.request().method() === 'POST') { const buf = r.request().postDataBuffer(); const n = buf.readUInt32BE(0); const meta = JSON.parse(buf.subarray(4, 4 + n).toString()); sent.push(meta); j = { signers: meta.signers.map((s) => ({ ...s, emailedAt: 1 })) }; }
      else if (p === 'esign/requests') j = { requests: [], emailReady: true };
      else if (p.startsWith('esign/')) j = handle(r.request().method(), p.replace('esign/', ''), r.request().postDataJSON?.() || {});
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
    });
    await page.addInitScript(() => { delete window.showOpenFilePicker; });
  } else await page.addInitScript((me) => {
    const base = { authStatus: async () => ({ signedIn: true, ...me }), initFiles: async () => [], getRecent: async () => [], version: async () => '0',
      readFile: async () => new Uint8Array(await (await fetch('/samples/sample.pdf')).arrayBuffer()), pathForFile: () => '',
      esign: async (m, p, b) => window.srvCall(m, p, b), esignCreate: async (meta) => { await window.srvSent(meta); return { signers: meta.signers.map((s) => ({ ...s, emailedAt: 1 })) }; } };
    window.api = new Proxy(base, { get: (t, k) => k in t ? t[k] : (k.startsWith('on') ? () => {} : async () => null) });
  }, me);
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForFunction(() => window.app);
  if (WEB) { const fc = page.waitForEvent('filechooser'); await page.evaluate(() => { window.app.openDialog(); }); await (await fc).setFiles({ name: 'doc.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(path.join(root, 'samples/sample.pdf')) }); }
  else await page.evaluate(() => window.app.openPaths(['/x/doc.pdf']));
  await page.waitForTimeout(1000);
  await page.locator('.tb', { hasText: 'Sign' }).first().click(); await page.getByText('Send for others to sign').click(); await page.waitForSelector('.modal');
  await page.locator('.modal input[placeholder="Full name"]').first().fill('Pat Signer'); await page.locator('.modal input[type=email]').first().fill('pat@example.com');
  await page.getByRole('button', { name: 'Next: place boxes' }).click(); await page.waitForTimeout(500);
  const boxes = () => page.evaluate(() => Object.entries(window.app.active.objects).flatMap(([p, l]) => (l || []).filter((o) => o.type === 'signfield').map((o) => ({ p: +p, id: o.id, x: Math.round(o.x), y: Math.round(o.y), w: Math.round(o.w), h: Math.round(o.h), s: o.signer }))));
  const pg = page.locator('.page').first(); await pg.scrollIntoViewIfNeeded(); const pb = await pg.boundingBox();
  const top = Math.max(pb.y, 190), bot = Math.min(pb.y + pb.height, 880);   // only the part of the page that is on screen
  const at = (fx, fy) => [pb.x + pb.width * fx, top + (bot - top) * fy];
  const click = async (fx, fy) => { const [x, y] = at(fx, fy); await page.mouse.click(x, y); await page.waitForTimeout(150); };
  await click(0.3, 0.3); check('click on empty page creates a box', (await boxes()).length === 1);
  await click(0.3, 0.3); check('click on an existing box does NOT create another', (await boxes()).length === 1, String((await boxes()).length));
  check('box is selected with handles', (await page.locator('.obj.signfield.sel .handle').count()) === 8 && (await page.locator('.sfdel').count()) === 1);
  if (0) console.log('DBG', await page.evaluate(() => ({sel: !!window.app.editor.sel, selcls: document.querySelectorAll('.obj.sel').length, handles: document.querySelectorAll('.handle').length, del: document.querySelectorAll('.sfdel').length, tool: window.app.editor.tool})));
  const clip = { x: pb.x - 10, y: top + (bot - top) * 0.1, width: 460, height: 260 };
  await page.screenshot({ path: path.join(shots, '1-selected-box.png'), clip: { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: clip.width, height: clip.height } });
  await click(0.6, 0.5); check('click on empty area creates a second box', (await boxes()).length === 2);
  // move first box
  let b0 = (await boxes())[0]; const bb = await page.locator('.obj.signfield').first().boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 80, bb.y + bb.height / 2 + 40, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(200);
  let b0n = (await boxes())[0]; check('drag moves the box', b0n.x > b0.x + 20 && b0n.y > b0.y + 10 && (await boxes()).length === 2, `${b0.x},${b0.y} -> ${b0n.x},${b0n.y}`);
  // resize with se handle
  const hb = await page.locator('.obj.signfield.sel .handle[data-h=se]').boundingBox();
  await page.mouse.move(hb.x + 5, hb.y + 5); await page.mouse.down(); await page.mouse.move(hb.x + 65, hb.y + 35, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(200);
  let b0r = (await boxes())[0]; check('corner handle resizes', b0r.w > b0n.w + 20 && b0r.h > b0n.h + 10, `${b0n.w}x${b0n.h} -> ${b0r.w}x${b0r.h}`);
  // tiny resize keeps a minimum
  const hn = await page.locator('.obj.signfield.sel .handle[data-h=se]').boundingBox();
  await page.mouse.move(hn.x + 5, hn.y + 5); await page.mouse.down(); await page.mouse.move(hn.x - 600, hn.y - 600, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  let b0m = (await boxes())[0]; check('resize keeps a minimum size', b0m.w >= 30 && b0m.h >= 16, `${b0m.w}x${b0m.h}`);
  // drag far out of page: stays inside
  const bb2 = await page.locator('.obj.signfield').first().boundingBox();
  await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2); await page.mouse.down(); await page.mouse.move(pb.x - 400, pb.y - 300, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  b0 = (await boxes())[0]; check('move stays inside the page', b0.x >= 0 && b0.y >= 0, `${b0.x},${b0.y}`);
  await page.screenshot({ path: path.join(shots, '2-after-move-resize.png') });
  // delete with x
  await page.locator('.obj.signfield').first().click({ position: { x: 4, y: 4 } }).catch(() => {});
  await page.locator('.sfdel').click(); await page.waitForTimeout(200);
  check('x on the box deletes it', (await boxes()).length === 1);
  // delete key
  await click(0.45, 0.7); check('third box placed', (await boxes()).length === 2);
  await page.keyboard.press('Delete'); await page.waitForTimeout(200);
  check('Delete key removes the selected box', (await boxes()).length === 1);
  await page.screenshot({ path: path.join(shots, '3-after-delete.png') });
  // undo last box + clear
  await click(0.2, 0.8); await click(0.7, 0.8); check('two more placed', (await boxes()).length === 3);
  await page.getByRole('button', { name: 'Undo last box' }).click(); await page.waitForTimeout(200);
  check('Undo last box removes the newest one', (await boxes()).length === 2);
  await page.getByRole('button', { name: /Clear this signer/ }).click(); await page.waitForTimeout(200);
  check('Clear removes this signer’s boxes', (await boxes()).length === 0);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
  check('Ctrl+Z brings them back', (await boxes()).length === 2, String((await boxes()).length));
  // final positions are what gets sent
  const final = await boxes();
  await page.getByRole('button', { name: 'Send…' }).click(); await page.waitForSelector('#ntf'); await page.waitForTimeout(300);
  check('.invalid address is not prefilled', (await page.locator('#ntf').inputValue()) === '', await page.locator('#ntf').inputValue());
  check('labels are plain', (await page.getByText('Email me when everyone has signed').count()) === 1 && (await page.getByText('Your name (shown to signers)').count()) === 1);
  await page.screenshot({ path: path.join(shots, '4-confirm-dialog.png') });
  await page.getByRole('button', { name: 'Send now' }).click(); await page.waitForTimeout(400);
  check('Send refused without a real email', sent.length === 0 && (await page.locator('#ntf').count()) === 1);
  await page.locator('#ntf').fill('milan@ledger.invalid'); await page.getByRole('button', { name: 'Send now' }).click(); await page.waitForTimeout(400);
  check('Send refused for an .invalid email', sent.length === 0);
  await page.locator('#frm').fill('Milan Dalsania'); await page.locator('#ntf').fill('Milan@Real.com'); await page.getByRole('button', { name: 'Send now' }).click(); await page.waitForTimeout(1200);
  check('request sent', sent.length === 1);
  const m = sent[0] || {};
  check('notify email + from name in the request', m.notifyEmail === 'milan@real.com' && m.fromName === 'Milan Dalsania', JSON.stringify([m.notifyEmail, m.fromName]));
  check('sent boxes = final positions, page and signer', JSON.stringify((m.fields || []).map((f) => [f.page, f.signer, Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h)]).sort()) === JSON.stringify(final.map((f) => [f.p, f.s, f.x, f.y, f.w, f.h]).sort()));
  check('sender details remembered on the server', profile.notifyEmail === 'milan@real.com' && profile.fromName === 'Milan Dalsania', JSON.stringify(profile));
  await browser.close(); srv.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
