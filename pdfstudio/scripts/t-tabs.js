// Tab drag-to-reorder test. Runs the built renderer (dist/renderer) in headless Chromium with a stub for window.api
// (no Electron needed). Usage:  node build.mjs && node scripts/t-tabs.js [screenshotFolder]
// Web build:  node scripts/t-tabs.js <screenshotFolder> web   (serves dist-web/app, fakes the sign-in answer of the server)
// Needs the "playwright" npm package (global or local) and a Chrome/Chromium.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const WEB = process.argv[3] === 'web';
const shots = process.argv[2] || path.join(require('os').tmpdir(), 'pdftabs');
fs.mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.json': 'application/json', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  let f = p.startsWith('/samples/') ? path.join(root, p) : path.join(root, WEB ? 'dist-web/app' : 'dist/renderer', p);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); } });
});
let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  if (WEB) await page.route('**/pdfstudio/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: r.request().url().endsWith('/api/me') ? JSON.stringify({ user: { username: 'test', role: 'admin' } }) : '{}' }));
  if (WEB) await page.addInitScript(() => { delete window.showOpenFilePicker; });
  if (!WEB) await page.addInitScript(() => {
    const base = { authStatus: async () => ({ signedIn: true, username: 'test', role: 'admin' }), initFiles: async () => [], getRecent: async () => [],
      version: async () => '0', readFile: async () => new Uint8Array(await (await fetch('/samples/sample.pdf')).arrayBuffer()), pathForFile: () => '' };
    window.api = new Proxy(base, { get: (t, k) => k in t ? t[k] : (k.startsWith('on') ? () => {} : async () => null) });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.app);
  if (WEB) {
    const buf = fs.readFileSync(path.join(root, 'samples/sample.pdf'));
    for (const n of ['A1', 'B2', 'C3', 'D4']) {
      const fc = page.waitForEvent('filechooser');
      await page.evaluate(() => { window.app.openDialog(); });
      await (await fc).setFiles({ name: n + '.pdf', mimeType: 'application/pdf', buffer: buf });
      await page.waitForTimeout(700);
    }
  } else await page.evaluate(async () => { for (const n of ['A1', 'B2', 'C3', 'D4']) await window.app.openPaths([`/x/${n}.pdf`]); });
  await page.waitForTimeout(800);
  const names = () => page.evaluate(() => window.app.tabs.map((t) => t.name.replace('.pdf', '')).join(','));
  const domNames = () => page.evaluate(() => [...document.querySelectorAll('#tabbar .tab .tname')].map((e) => e.textContent.replace('.pdf', '')).join(','));
  const active = () => page.evaluate(() => window.app.active.name.replace('.pdf', ''));
  const box = async (i) => (await page.locator('#tabbar .tab').nth(i).boundingBox());
  check('4 tabs open', (await names()) === 'A1,B2,C3,D4', await names());
  check('last opened is active', (await active()) === 'D4');

  // plain click switches tab
  let b = await box(0); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(200);
  check('click switches tab', (await active()) === 'A1', await active());
  check('click does not reorder', (await names()) === 'A1,B2,C3,D4');
  // tiny movement (3px) is still a click
  b = await box(1); await page.mouse.move(b.x + 20, b.y + 10); await page.mouse.down(); await page.mouse.move(b.x + 23, b.y + 10); await page.mouse.up();
  await page.waitForTimeout(200);
  check('3px wiggle = click', (await active()) === 'B2' && (await names()) === 'A1,B2,C3,D4', await active());

  // drag tab 1 (A1) to the end; A1 is not active (B2 is) -> active must stay B2
  b = await box(0); const last = await box(3);
  const sx = b.x + 30, sy = b.y + b.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(sx + (last.x + last.width - b.x - 20) * i / 12, sy); await page.waitForTimeout(20); }
  await page.waitForTimeout(250);
  const mid = await page.evaluate(() => [...document.querySelectorAll('#tabbar .tab')].map((e) => e.style.transform));
  check('others slide aside mid-drag', mid.slice(1).every((t) => /translateX\(-/.test(t)), JSON.stringify(mid));
  await page.screenshot({ path: path.join(shots, 'mid-drag.png'), clip: { x: 0, y: 130, width: 1200, height: 60 } });
  await page.mouse.up(); await page.waitForTimeout(300);
  check('A1 dragged to end', (await names()) === 'B2,C3,D4,A1', await names());
  check('DOM matches list', (await domNames()) === 'B2,C3,D4,A1', await domNames());
  check('active tab stays B2', (await active()) === 'B2', await active());
  await page.screenshot({ path: path.join(shots, 'after-1-to-end.png'), clip: { x: 0, y: 130, width: 1200, height: 60 } });

  // drag tab 4 (A1) back... first drag the last tab (A1) to the start
  b = await box(3); const first = await box(0);
  const ex = b.x + 30;
  await page.mouse.move(ex, sy); await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(ex - (b.x - first.x + 20) * i / 12, sy); await page.waitForTimeout(20); }
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, 'mid-drag-to-start.png'), clip: { x: 0, y: 130, width: 1200, height: 60 } });
  await page.mouse.up(); await page.waitForTimeout(300);
  check('tab 4 dragged to start', (await names()) === 'A1,B2,C3,D4', await names());
  check('active still B2', (await active()) === 'B2');
  // middle drag: move tab 0 one slot right only
  b = await box(0); await page.mouse.move(b.x + 30, sy); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(b.x + 30 + (b.width + 2) * 1.2 * i / 8, sy); await page.waitForTimeout(20); }
  await page.mouse.up(); await page.waitForTimeout(300);
  check('one-slot drag swaps neighbours', (await names()) === 'B2,A1,C3,D4', await names());
  // keyboard follows new order: Ctrl+Tab from B2 -> A1
  await page.keyboard.press('Control+Tab'); await page.waitForTimeout(300);
  check('Ctrl+Tab follows new order', (await active()) === 'A1', await active());
  await page.screenshot({ path: path.join(shots, 'after-final.png'), clip: { x: 0, y: 130, width: 1200, height: 60 } });

  // x button closes and never drags
  b = await box(3); const xb = await page.locator('#tabbar .tab').nth(3).locator('.x').boundingBox();
  await page.mouse.click(xb.x + xb.width / 2, xb.y + xb.height / 2); await page.waitForTimeout(300);
  check('x closes tab', (await names()) === 'B2,A1,C3', await names());
  // middle click closes
  b = await box(2); await page.mouse.click(b.x + 30, b.y + 10, { button: 'middle' }); await page.waitForTimeout(300);
  check('middle-click closes tab', (await names()) === 'B2,A1', await names());
  // x then drag attempt starting on x does not reorder
  const xb2 = await page.locator('#tabbar .tab').nth(0).locator('.x').boundingBox();
  const names0 = await names();
  await page.mouse.move(xb2.x + 5, xb2.y + 5); await page.mouse.down(); await page.mouse.move(xb2.x + 200, xb2.y + 5, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200);
  check('drag from x does not reorder', (await names()) === names0, await names());

  await browser.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
