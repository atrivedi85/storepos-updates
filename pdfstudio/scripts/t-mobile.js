// Phone home screen + camera scanner + Android bridge test (headless Chromium with a fake camera).
//   node build.mjs && node scripts/t-mobile.js [screenshotFolder]
// Serves dist-web/app, fakes the PdfStudio server answers (sign-in) and the site account button.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const shots = process.argv[2] || path.join(os.tmpdir(), 'pdfm');
fs.mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(root, 'dist-web/app', p);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); } });
});
let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };
const SAMPLE = path.join(root, 'samples/sample.pdf');
const FAKE_ACCT = `(function(){var s=document.getElementById('acctSlot');if(!s)return;var b=document.createElement('button');b.id='fakeAvatar';b.textContent='M';b.style.cssText='width:36px;height:36px;border-radius:50%;border:0;background:#1f6fd1;color:#fff;font-weight:700';s.appendChild(b);})();`;

async function newPage(browser, url, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: !opts.desktop, hasTouch: !opts.desktop, permissions: opts.noCamera ? [] : ['camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
  await page.route('**/pdfstudio/api/**', (r) => {
    const u = r.request().url();
    if (u.endsWith('/api/me')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { username: 'milan', role: 'admin' } }) });
    if (/\/api\/files(\?|$)/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [{ id: 'a'.repeat(16), name: 'Cloud lease.pdf', size: 20480, rev: 1, updatedAt: Date.now() - 86400000 * 3 }], used: 20480, quota: 1e9 }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/account-bar.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_ACCT }));
  await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(url);
  await page.waitForFunction(() => window.app && document.querySelector('#mhome'));
  await page.waitForTimeout(400);
  return page;
}
const pickWith = async (page, clickFn, files) => {
  const fc = page.waitForEvent('filechooser');
  await clickFn();
  await (await fc).setFiles(files);
};

(async () => {
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  // ================= phone: home =================
  let page = await newPage(browser, url);
  const s = (n) => page.screenshot({ path: path.join(shots, n + '.png') });
  check('phone mode on', await page.evaluate(() => document.documentElement.classList.contains('mob')));
  check('home visible', await page.locator('#mhome.on').isVisible());
  check('welcome title uses first name', (await page.locator('.mh-title').innerText()) === 'Welcome back, Milan');
  check('7 tiles', (await page.locator('.mh-tiles .mh-tile').count()) === 7);
  check('4 tabs (Recent, Starred, On device, Cloud)', (await page.locator('.mh-tabs button').allInnerTexts()).join('|') === 'Recent|Starred|On device|Cloud');
  check('bottom bar Home/Scan/Files/Tools', (await page.locator('.mh-nav button').allInnerTexts()).join('|').replace(/\s/g, '') === 'Home|Scan|Files|Tools');
  check('2 tip cards', (await page.locator('.mh-tip').count()) === 2);
  check('one account avatar only', (await page.locator('#fakeAvatar:visible, #acctBtn:visible').count()) === 1);
  check('search icon visible', await page.locator('#mobSearch').isVisible());
  check('old welcome screen hidden', !(await page.locator('#welcome').isVisible()));
  await s('01-home');
  // dismiss a tip, remembered after reload
  await page.locator('.mh-tip .x').first().click();
  check('tip dismissed', (await page.locator('.mh-tip').count()) === 1);
  await page.reload(); await page.waitForFunction(() => window.app && document.querySelector('.mh-title')); await page.waitForTimeout(300);
  check('tip stays dismissed after reload', (await page.locator('.mh-tip').count()) === 1);

  // + menu
  await page.locator('.mh-fab').click();
  check('+ menu has 4 entries', (await page.locator('.mh-fabmenu button').allInnerTexts()).map((t) => t.trim()).join('|') === 'Scan|Open PDF|Create from photos|New blank PDF');
  await s('02-plus-menu');
  await page.locator('.mh-fabback').click({ position: { x: 20, y: 200 } });
  check('+ menu closes', (await page.locator('.mh-fabmenu').count()) === 0);

  // tools tab
  await page.locator('.mh-nav [data-nav=tools]').click();
  check('tools grid has all tools', (await page.locator('.mh-grid .mh-tile').count()) >= 14);
  await s('03-tools');
  await page.locator('.mh-nav [data-nav=home]').click();

  // ================= open a PDF, recents =================
  await pickWith(page, () => page.locator('.mh-tile[data-id=open]').click(), SAMPLE);
  await page.waitForSelector('.page canvas', { timeout: 15000 });
  check('document opened, home hidden', !(await page.locator('#mhome.on').count()) && (await page.locator('#mobBack').isVisible()));
  check('back button is in the top bar', await page.locator('#mobBack').isVisible());
  await s('06b-open-doc');
  await page.locator('#mobBack').click(); await page.waitForTimeout(500);
  check('back returns Home', await page.locator('#mhome.on').isVisible());
  let row = page.locator('.mh-row', { hasText: 'sample.pdf' });
  check('recent shows the file', (await row.count()) === 1);
  const meta = await row.locator('small').innerText();
  check('recent meta "PDF · Just now · 46.3 KB" style', /^PDF · Just now · \d+(\.\d)? (KB|MB)$/.test(meta), meta);
  check('recent has a page-1 thumbnail', (await row.locator('img').count()) === 1);
  // menu
  await row.locator('.more').click();
  check('menu: Open/Star/Share/Rename/Remove', (await page.locator('#menu-root .menu button').allInnerTexts()).map((t) => t.trim()).join('|') === 'Open|Star|Share|Rename|Remove from list');
  await page.locator('#menu-root .menu button', { hasText: 'Star' }).click();
  await page.locator('.mh-tabs [data-tab=starred]').click(); await page.waitForTimeout(200);
  check('starred tab lists it', (await page.locator('.mh-row', { hasText: 'sample.pdf' }).count()) === 1);
  await page.locator('.mh-tabs [data-tab=device]').click(); await page.waitForTimeout(200);
  check('on device tab: choose button + file', (await page.locator('.mh-choose').count()) === 1 && (await page.locator('.mh-row', { hasText: 'sample.pdf' }).count()) === 1);
  await page.locator('.mh-tabs [data-tab=cloud]').click(); await page.waitForTimeout(400);
  check('cloud tab lists cloud files', (await page.locator('.mh-row', { hasText: 'Cloud lease.pdf' }).count()) === 1);
  await page.locator('.mh-tabs [data-tab=recent]').click(); await page.waitForTimeout(200);
  // share (browser without share API -> download)
  const dl = page.waitForEvent('download');
  await page.locator('.mh-row .more').first().click();
  await page.locator('#menu-root .menu button', { hasText: 'Share' }).click();
  check('share falls back to a download on a browser without share', (await (await dl).suggestedFilename()) === 'sample.pdf');
  // rename
  await page.locator('.mh-row .more').first().click();
  await page.locator('#menu-root .menu button', { hasText: 'Rename' }).click();
  await page.locator('.modal input').fill('Lease renamed'); await page.locator('.modal .btn.primary').click(); await page.waitForTimeout(300);
  check('rename works', (await page.locator('.mh-row', { hasText: 'Lease renamed.pdf' }).count()) === 1);
  // reload: still there; reopen from stored bytes
  await page.reload(); await page.waitForFunction(() => window.app && document.querySelector('.mh-title')); await page.waitForTimeout(500);
  row = page.locator('.mh-row', { hasText: 'Lease renamed.pdf' });
  check('recent survives a reload', (await row.count()) === 1);
  await row.click(); await page.waitForSelector('.page canvas', { timeout: 15000 });
  check('reopened from the stored copy', (await page.evaluate(() => window.app.active.pages.length)) >= 1 && (await page.evaluate(() => window.app.active.name)) === 'Lease renamed.pdf');
  await page.locator('#mobBack').click(); await page.waitForTimeout(400);
  // remove
  await page.locator('.mh-row .more').first().click();
  await page.locator('#menu-root .menu button', { hasText: 'Remove from list' }).click(); await page.waitForTimeout(300);
  check('remove from list', (await page.locator('.mh-row', { hasText: 'Lease renamed.pdf' }).count()) === 0);

  // ================= tile flows =================
  await pickWith(page, () => page.locator('.mh-tile[data-id=edit]').click(), SAMPLE);
  await page.waitForSelector('.page canvas', { timeout: 15000 });
  check('Edit PDF opens file and selects Edit text', (await page.evaluate(() => window.app.editor.tool)) === 'edittext');
  await page.locator('#mobBack').click(); await page.waitForTimeout(400);
  await pickWith(page, () => page.locator('.mh-tile[data-id=organize]').click(), SAMPLE);
  await page.waitForSelector('.page canvas', { timeout: 15000 }); await page.waitForTimeout(300);
  check('Organize pages opens the Pages drawer', await page.evaluate(() => document.body.classList.contains('side-open')));
  await page.locator('#mobBack').click(); await page.waitForTimeout(400);
  await pickWith(page, () => page.locator('.mh-tile[data-id=sign]').click(), SAMPLE);
  await page.waitForSelector('.page canvas', { timeout: 15000 }); await page.waitForTimeout(300);
  check('Fill & Sign opens the sign menu', (await page.locator('#menu-root .menu').innerText()).includes('Add signature'));
  await page.keyboard.press('Escape'); await page.mouse.click(200, 400);
  await page.locator('#mobBack').click(); await page.waitForTimeout(400);
  const pagesOf = (b) => page.evaluate(async () => window.app.active.pages.length);
  await pickWith(page, () => page.locator('.mh-tile[data-id=merge]').click(), [SAMPLE, SAMPLE]);
  await page.waitForSelector('.page canvas', { timeout: 15000 });
  const mergedPages = await pagesOf();
  check('Merge PDFs makes one document with both', mergedPages >= 2 && /^Merged /.test(await page.evaluate(() => window.app.active.name)), String(mergedPages));
  await page.locator('#mobBack').click(); await page.waitForTimeout(400);

  // ================= scanner with the fake camera =================
  await page.locator('.mh-tile[data-id=scan]').click();
  await page.waitForFunction(() => { const v = document.querySelector('.scn video'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
  await page.waitForTimeout(3000);   // let the "Merged" toast fade so it is not in the picture
  check('camera view with shutter', await page.locator('.scn-shutter').isVisible());
  await s('04-scanner-camera');
  await page.locator('.scn-shutter').click();
  await page.waitForSelector('.scn-crop .scn-h', { timeout: 10000 });
  check('crop screen has 4 corner handles', (await page.locator('.scn-h').count()) === 4);
  await s('05-scanner-crop');
  // drag a handle and check the polygon follows
  const hb = await page.locator('.scn-h[data-corner="0"]').boundingBox();
  const before = await page.evaluate(() => document.querySelector('.scn-poly polygon').getAttribute('points'));
  await page.mouse.move(hb.x + 24, hb.y + 24); await page.mouse.down(); await page.mouse.move(hb.x + 60, hb.y + 80, { steps: 5 }); await page.mouse.up();
  const after = await page.evaluate(() => document.querySelector('.scn-poly polygon').getAttribute('points'));
  check('dragging a corner moves it', before !== after);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForSelector('.scn-filter .scn-out');
  check('filter chips', (await page.locator('.scn-chips .chip').allInnerTexts()).join('|') === 'Color|Grayscale|Black & White|Original');
  await page.locator('.chip[data-filter=bw]').click(); await page.waitForTimeout(500);
  await s('05b-scanner-filter');
  await page.locator('[data-act=add]').click();
  await page.waitForSelector('.scn-base .scn-strip:not(.empty)');
  check('page strip shows page 1', (await page.locator('.scn-th').count()) === 1);
  await page.locator('.scn-shutter').click();
  await page.waitForSelector('.scn-crop .scn-h');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForSelector('.scn-filter .scn-out');
  await page.locator('[data-act=add]').click();
  await page.waitForSelector('.scn-base .scn-th:nth-child(2)');
  check('page strip shows 2 pages', (await page.locator('.scn-th').count()) === 2);
  // reorder + delete strip controls
  await page.locator('.scn-th').nth(1).locator('button[aria-label="Move earlier"]').click();
  await page.locator('.scn-th').nth(0).locator('button[aria-label="Delete page"]').click();
  check('strip delete works', (await page.locator('.scn-th').count()) === 1);
  await page.locator('.scn-shutter').click(); await page.waitForSelector('.scn-crop .scn-h');
  await page.getByRole('button', { name: 'Next' }).click(); await page.waitForSelector('.scn-filter .scn-out');
  await page.locator('[data-act=done]').click();
  await page.waitForSelector('.page canvas', { timeout: 20000 });
  await page.waitForTimeout(600);
  const doc = await page.evaluate(() => ({ n: window.app.active.pages.length, name: window.app.active.name, hasCam: !!document.querySelector('.scn') }));
  check('scan finished: document with 2 pages is open', doc.n === 2 && !doc.hasCam, JSON.stringify(doc));
  check('named "Scan YYYY-MM-DD HH-mm.pdf"', /^Scan \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.pdf$/.test(doc.name), doc.name);
  await s('06-scan-in-editor');
  await page.locator('#mobBack').click(); await page.waitForTimeout(500);
  check('scan is in Recent', (await page.locator('.mh-row', { hasText: doc.name }).count()) === 1);
  await s('01b-home-with-recent');

  // ================= no camera: photo fallback =================
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 900; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, 900, 1200); g.fillStyle = '#f4f4f0'; g.fillRect(120, 140, 640, 900); g.fillStyle = '#222'; for (let i = 0; i < 18; i++) g.fillRect(170, 200 + i * 44, 400 + (i % 4) * 40, 14); return c.toDataURL('image/png').split(',')[1]; });
  const photo = Buffer.from(png, 'base64');
  const p2 = await newPage(browser, url, { noCamera: true, init: () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); } });
  await p2.locator('.mh-tile[data-id=scan]').click();
  await p2.waitForSelector('.scn-nocam');
  check('denied camera -> friendly message + photo buttons', (await p2.locator('.scn-nocam').innerText()).includes('blocked') && (await p2.locator('.scn-nocam .btn').count()) === 2);
  await pickWith(p2, () => p2.getByRole('button', { name: 'Choose photos' }).click(), [{ name: 'a.png', mimeType: 'image/png', buffer: photo }, { name: 'b.png', mimeType: 'image/png', buffer: photo }]);
  await p2.waitForSelector('.scn-crop .scn-h', { timeout: 15000 });
  const auto = await p2.evaluate(() => document.querySelector('.scn-poly polygon').getAttribute('points'));
  const a0 = auto.split(' ')[0].split(',').map(Number);
  check('page edges found automatically (top-left near the sheet corner 120,140, not the 5% inset 45,60)', Math.abs(a0[0] - 120) < 25 && Math.abs(a0[1] - 140) < 25, auto);
  await p2.getByRole('button', { name: 'Next' }).click(); await p2.waitForSelector('.scn-filter .scn-out');
  await p2.locator('[data-act=add]').click();
  await p2.waitForSelector('.scn-crop .scn-h', { timeout: 15000 });   // second photo from the queue
  await p2.getByRole('button', { name: 'Next' }).click(); await p2.waitForSelector('.scn-filter .scn-out');
  await p2.locator('[data-act=done]').click();
  await p2.waitForSelector('.page canvas', { timeout: 20000 });
  check('photos to PDF: 2-page document', (await p2.evaluate(() => window.app.active.pages.length)) === 2);
  // Create PDF tile uses the same pipeline
  await p2.locator('#mobBack').click(); await p2.waitForTimeout(400);
  await pickWith(p2, () => p2.locator('.mh-tile[data-id=create]').click(), [{ name: 'c.png', mimeType: 'image/png', buffer: photo }]);
  await p2.waitForSelector('.scn-crop .scn-h', { timeout: 15000 });
  await p2.getByRole('button', { name: 'Next' }).click(); await p2.waitForSelector('.scn-filter .scn-out');
  await p2.locator('[data-act=done]').click(); await p2.waitForSelector('.page canvas', { timeout: 20000 });
  check('Create PDF tile -> 1-page document named Photos ...', (await p2.evaluate(() => window.app.active.pages.length)) === 1 && /^Photos /.test(await p2.evaluate(() => window.app.active.name)));
  // Android-style back inside the scanner flow
  await p2.locator('#mobBack').click(); await p2.waitForTimeout(400);
  await p2.context().close();

  // ================= Android bridge =================
  const b64 = fs.readFileSync(SAMPLE).toString('base64');
  const p3 = await newPage(browser, url, { init: `
    window.__log = []; window.__first = { name: 'Opened with.pdf', b64: ${JSON.stringify(b64)} };
    window.PdfAndroid = {
      saveFile(n, b) { window.__log.push(['save', n, b.length]); },
      shareFile(n, b) { window.__log.push(['share', n, b.length]); },
      takeOpenedFile() { const f = window.__first; window.__first = null; return f ? JSON.stringify(f) : ''; },
    };` });
  await p3.waitForSelector('.page canvas', { timeout: 15000 });
  check('Android: file opened from another app at startup', (await p3.evaluate(() => window.app.active.name)) === 'Opened with.pdf');
  check('Android: back button handled (editor -> Home)', (await p3.evaluate(() => window.pdfAndroidBack())) === true);
  await p3.waitForTimeout(500);
  check('Android: now on Home', await p3.locator('#mhome.on').isVisible());
  check('Android: back on Home lets the app close', (await p3.evaluate(() => window.pdfAndroidBack())) === false);
  await p3.evaluate((b) => window.pdfAndroidOpen('Second.pdf', b), b64);
  await p3.waitForFunction(() => window.app.active && window.app.active.name === 'Second.pdf', null, { timeout: 15000 });
  check('Android: pdfAndroidOpen opens a PDF while running', true);
  await p3.locator('[data-action=saveAs]').click(); await p3.waitForTimeout(800);
  check('Android: Save As uses native saveFile', JSON.stringify((await p3.evaluate(() => window.__log)).filter((x) => x[0] === 'save').map((x) => x[1])) === '["Second.pdf"]', JSON.stringify(await p3.evaluate(() => window.__log)));
  await p3.locator('[data-action=share]').click(); await p3.waitForTimeout(800);
  check('Android: Share in the editor uses shareFile', (await p3.evaluate(() => window.__log)).some((x) => x[0] === 'share' && x[1] === 'Second.pdf'));
  await p3.evaluate(() => window.pdfAndroidBack()); await p3.waitForTimeout(500);
  await p3.locator('.mh-row', { hasText: 'Second.pdf' }).locator('.more').click();
  await p3.locator('#menu-root .menu button', { hasText: 'Share' }).click(); await p3.waitForTimeout(500);
  check('Android: Share in Recent menu uses shareFile', (await p3.evaluate(() => window.__log.filter((x) => x[0] === 'share').length)) === 2);
  // back closes a dialog first
  await p3.locator('.mh-row', { hasText: 'Second.pdf' }).locator('.more').click();
  await p3.locator('#menu-root .menu button', { hasText: 'Rename' }).click(); await p3.waitForSelector('.modal');
  check('Android: back closes a dialog first', (await p3.evaluate(() => window.pdfAndroidBack())) === true && (await p3.locator('.modal').count()) === 0);
  // back inside the scanner
  await p3.locator('.mh-tile[data-id=scan]').click(); await p3.waitForSelector('.scn');
  check('Android: back closes the scanner', (await p3.evaluate(() => window.pdfAndroidBack())) === true && (await p3.locator('.scn').count()) === 0);
  await p3.context().close();

  // ================= desktop stays as it was =================
  const pd = await newPage(browser, url, { desktop: true, viewport: { width: 1400, height: 900 } });
  check('desktop: not in phone mode', !(await pd.evaluate(() => document.documentElement.classList.contains('mob'))));
  check('desktop: normal start screen shown, phone home hidden', (await pd.locator('#welcome').isVisible()) && !(await pd.locator('#mhome').isVisible()));
  check('desktop: phone-only buttons hidden', !(await pd.locator('#mobBack').isVisible()) && !(await pd.locator('#mobSearch').isVisible()) && !(await pd.locator('[data-action=share]').isVisible()));
  check('desktop web: Scan / Photos menu item present', await pd.locator('[data-action=scan]').isVisible());
  await pd.locator('[data-action=scan]').click();
  check('desktop: Scan menu offers camera + photos', (await pd.locator('#menu-root .menu').innerText()).includes('Photos to PDF'));
  await pd.close();

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
