// Saved-contacts test for "Send for signature": built renderer in headless Chromium, with window.api.esign wired to the REAL worker
// code (worker/esign.js handleContacts) running on Node's built-in SQLite. Usage: node build.mjs && node scripts/t-contacts.js [screenshotFolder]
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const shots = process.argv[2] || path.join(require('os').tmpdir(), 'pdftabs');
fs.mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]); const f = p.startsWith('/samples/') ? path.join(root, p) : path.join(root, 'dist/renderer', p === '/' ? '/index.html' : p);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); } });
});
let fails = 0;
const check = (n, ok, i = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (i ? '  ' + i : '')); if (!ok) fails++; };
(async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { handleContacts } = await import('../worker/esign.js');
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE esign_contacts (owner_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, last_used INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner_id, email))');
  const stmt = (q, a = []) => ({ bind: (...x) => stmt(q, x), run: async () => { sql.prepare(q).run(...a); return {}; }, all: async () => ({ results: sql.prepare(q).all(...a) }), first: async () => sql.prepare(q).get(...a) ?? null });
  const env = { DB: { prepare: (q) => stmt(q), batch: async (l) => { for (const s of l) await s.run(); } } };
  let online = true; const sent = [];
  await new Promise((r) => srv.listen(0, r));
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('dialog', (d) => d.accept());
  await page.exposeFunction('srvCall', async (method, body) => {
    if (!online) throw new Error('offline');
    const res = await handleContacts(new Request('https://x/', { method, body: body === undefined ? undefined : JSON.stringify(body) }), env, { id: 'u1' });
    return res.json();
  });
  await page.exposeFunction('srvSent', (m) => { sent.push(m); });
  await page.addInitScript(() => {
    const base = { authStatus: async () => ({ signedIn: true, username: 'test', email: 'me@x.com', role: 'admin' }), initFiles: async () => [], getRecent: async () => [], version: async () => '0',
      readFile: async () => new Uint8Array(await (await fetch('/samples/sample.pdf')).arrayBuffer()), pathForFile: () => '',
      esign: async (m, p, b) => window.srvCall(m, b), esignCreate: async (meta) => { await window.srvSent(meta); return { signers: meta.signers.map((s) => ({ ...s, emailedAt: 1 })) }; } };
    window.api = new Proxy(base, { get: (t, k) => k in t ? t[k] : (k.startsWith('on') ? () => {} : async () => null) });
  });
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForFunction(() => window.app);
  // seed the server list
  await page.evaluate(() => window.api.esign('POST', 'contacts', { contacts: [
    { name: 'Alice Anders', email: 'alice@acme.com', uses: 5 }, { name: 'Bob Brown', email: 'bob@brown.org', uses: 2 }, { name: 'Carol Chen', email: 'carol@chen.net', uses: 1 }, { name: 'Alan Ames', email: 'alan@ames.io', uses: 1 }, { name: 'Zed Zane', email: 'zed@zane.com', uses: 0 }] }));
  await page.evaluate(() => window.app.openPaths(['/x/doc.pdf'])); await page.waitForTimeout(800);
  const dlg = async () => { await page.locator('.tb', { hasText: 'Sign' }).first().click(); await page.getByText('Send for others to sign').click(); await page.waitForSelector('.modal .row input'); await page.waitForTimeout(400); };
  await dlg();
  const row = (i) => page.locator('.modal .row').nth(i);
  const nameIn = page.locator('.modal input[placeholder="Full name"]').first();
  await nameIn.click(); await page.keyboard.type('al');
  await page.waitForTimeout(150);
  let sg = await page.locator('.suggest .sg b').allTextContents();
  check('dropdown shows matches, most used first', sg.join() === 'Alice Anders,Alan Ames', sg.join());
  await page.screenshot({ path: path.join(shots, 'contacts-autocomplete.png') });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  check('pick fills name and email', (await nameIn.inputValue()) === 'Alice Anders' && (await page.locator('.modal input[type=email]').first().inputValue()) === 'alice@acme.com');
  check('Enter in dropdown did not submit the dialog', await page.locator('.modal').count() === 1);
  // typing an email fragment in a second row
  await page.getByText('+ Add another signer').click();
  const email2 = page.locator('.modal input[type=email]').nth(1); await email2.click(); await page.keyboard.type('brown'); await page.waitForTimeout(150);
  await page.locator('.suggest .sg').first().dispatchEvent('mousedown'); await page.waitForTimeout(150);
  check('pick by email fragment', (await page.locator('.modal input[placeholder="Full name"]').nth(1).inputValue()) === 'Bob Brown');
  // already-listed people are not offered
  const n3 = await page.evaluate(() => { const i = document.querySelectorAll('.modal input[placeholder="Full name"]')[1]; i.focus(); i.value = 'a'; i.dispatchEvent(new Event('input')); return [...document.querySelectorAll('.suggest .sg b')].map((e) => e.textContent).join(); });
  check('already-added person not offered again', !n3.includes('Alice Anders') && !n3.includes('Bob'), n3);
  await page.evaluate(() => { const i = document.querySelectorAll('.modal input[placeholder="Full name"]')[1]; i.value = 'Bob Brown'; i.blur(); });
  await page.waitForTimeout(250);
  // contacts picker
  await page.getByText('Add from contacts').click(); await page.waitForTimeout(200);
  const listed = await page.locator('.cpanel .crow b').allTextContents();
  check('picker lists only people not yet added', [...listed].sort().join() === 'Alan Ames,Carol Chen,Zed Zane', listed.join());
  await page.screenshot({ path: path.join(shots, 'contacts-picker.png') });
  await page.locator('.cpanel .crow', { hasText: 'Zed' }).locator('button').click(); await page.waitForTimeout(400);
  const afterDel = (await page.evaluate(() => window.api.esign('GET', 'contacts'))).contacts.map((c) => c.email);
  check('x (with confirm) removes a contact on the server', !afterDel.includes('zed@zane.com') && afterDel.length === 4, afterDel.join());
  check('removed person disappears from the picker', (await page.locator('.cpanel .crow').count()) === 2);
  await page.locator('.cpanel input[type=search]').fill('chen'); await page.waitForTimeout(100);
  check('picker search', (await page.locator('.cpanel .crow').count()) === 1);
  await page.locator('.cpanel input[type=search]').press('Enter');
  check('Enter in picker search does not submit', await page.locator('.modal').count() === 1);
  await page.locator('.cpanel .crow input').check();
  await page.locator('.cpanel input[type=search]').fill(''); await page.waitForTimeout(100);
  await page.locator('.cpanel .crow', { hasText: 'Alan' }).locator('input').check();
  await page.getByText('Add selected').click(); await page.waitForTimeout(200);
  const names = await page.locator('.modal input[placeholder="Full name"]').evaluateAll((l) => l.map((i) => i.value));
  check('ticked people added as rows', [...names].sort().join() === 'Alan Ames,Alice Anders,Bob Brown,Carol Chen', names.join());
  // add a brand-new person, change a known person's name, then send
  await page.getByText('+ Add another signer').click(); await page.getByText('+ Add another signer').click().catch(() => {});
  const nm = page.locator('.modal input[placeholder="Full name"]'), em = page.locator('.modal input[type=email]');
  const cnt = await nm.count();
  await nm.nth(cnt - 1).fill('Dan New'); await em.nth(cnt - 1).fill('Dan@New.com');
  await nm.nth(1).fill('Robert Brown'); // same email as Bob, new name
  // blank extra row is dropped
  check('save checkbox is on by default', await page.locator('#saveContacts').isChecked());
  await page.getByRole('button', { name: 'Next: place boxes' }).click(); await page.waitForTimeout(400);
  await page.evaluate(() => { const s = window.app.editor.esign.signers; const t = window.app.active; t.objects[0] = (t.objects[0] || []).concat(s.map((_, i) => ({ id: 'sf' + i, type: 'signfield', kind: 'signature', signer: i, label: 'Sign', x: 50, y: 50 + i * 40, w: 100, h: 30 }))); });
  await page.evaluate(() => { window.app.editor.onEsign.send(); });
  await page.waitForSelector('#frm'); await page.getByRole('button', { name: 'Send now' }).click(); await page.waitForTimeout(1200);
  const all = (await page.evaluate(() => window.api.esign('GET', 'contacts'))).contacts;
  const by = Object.fromEntries(all.map((c) => [c.email, c]));
  check('request was sent', sent.length === 1);
  check('new person saved', by['dan@new.com']?.name === 'Dan New');
  check('same email, new name: name updated', by['bob@brown.org']?.name === 'Robert Brown', by['bob@brown.org']?.name);
  check('existing contact count went up', by['alice@acme.com']?.count === 6, String(by['alice@acme.com']?.count));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  // offline: new person saved locally, pushed later
  online = false;
  await page.evaluate(() => { window.app.editor.esign = null; });
  await dlg();
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem('pdfstudio.contacts') || '[]').length);
  check('local copy kept for offline use', local >= 5, String(local));
  await browser.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
