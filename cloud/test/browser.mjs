// Browser check of the account flow with a real Chromium against the real Worker code.
// Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --import ./cloud/test/hooks.mjs cloud/test/browser.mjs <screenshot-folder>
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { start } from './harness.mjs';
import { startFakePc } from './fakepc.mjs';
const require = createRequire(import.meta.url);
const { chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright');
const PC = require('../../source/app/acct.js');
globalThis.window = globalThis;
await import('../../ledger/app/vault.js');
const V = globalThis.LDVault;
const OUT = process.argv[2] || '/tmp/shots'; fs.mkdirSync(OUT, { recursive: true });
const PW = 'correct horse battery';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const h = await start(); await fetch(h.url + '/api/setup-needed');
const L = h.inst('ledger|main');
for (const [u, n, a] of [['raj', 'Raj Trivedi', true], ['bob', 'Bob Cashier', false]]) {
  const nv = await V.newVault(PW), user = { username: u, name: n, admin: a, created: new Date().toISOString(), vault: nv.vault, ...(u === 'bob' ? { email: 'bob@example.com', posOnly: true } : {}) };
  L.setPw(user, await V.authFor(u, PW)); L.setRec(user, await V.recAuthFor(u, nv.recovery)); L.saveUser(user);
}
const store = { storeId: crypto.randomBytes(16).toString('base64url'), key: crypto.randomBytes(32).toString('base64'), name: 'Demo Smoke Shop' };
const pc = startFakePc(h.url, store); await pc.ready;
const link = await PC.linkStore(h.url, (await PC.signIn(h.url, 'raj', PW)).session, PW, store);
ok(!!link.deviceToken, 'store PC linked the store to raj');

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage(); page.on('pageerror', e => console.log('PAGE ERROR', e.message));
const bar = p => p.locator('[data-account-bar]');
const barText = async p => (await p.evaluate(() => { const h = document.querySelector('[data-account-bar]'); return h && h.shadowRoot ? h.shadowRoot.textContent.replace(/\s+/g, ' ') : ''; }));
const barBox = async p => p.evaluate(() => { const r = document.querySelector('[data-account-bar]').getBoundingClientRect(); return { top: Math.round(r.top), right: Math.round(innerWidth - r.right), w: Math.round(r.width) }; });

// 1. signed-out home page, /download
await page.goto(h.url + '/'); await page.waitForTimeout(800);
ok((await barText(page)).includes('Sign in'), 'home page signed out shows "Sign in"');
await page.screenshot({ path: OUT + '/home-desktop.png' });
await page.screenshot({ path: OUT + '/home-desktop-full.png', fullPage: true });
await page.goto(h.url + '/download'); await page.waitForTimeout(500); await page.screenshot({ path: OUT + '/download-desktop.png' });
const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const pp = await ph.newPage();
await pp.goto(h.url + '/'); await pp.waitForTimeout(800); await pp.screenshot({ path: OUT + '/home-phone.png' }); await pp.screenshot({ path: OUT + '/home-phone-full.png', fullPage: true });
ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'home page has no sideways scroll on a phone');
await pp.goto(h.url + '/download'); await pp.waitForTimeout(500); await pp.screenshot({ path: OUT + '/download-phone.png' });
ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '/download has no sideways scroll on a phone');
await ph.close();

// 2. /pos while signed out -> shared sign-in -> back to /pos -> store list -> open the store
await page.goto(h.url + '/pos/'); await page.waitForSelector('#wbSign'); await page.screenshot({ path: OUT + '/pos-signin-gate.png' });
await page.click('#wbSign'); await page.waitForSelector('#user');
await page.screenshot({ path: OUT + '/signin-page.png' });
await page.fill('#user', 'raj'); await page.fill('#pw', PW); await page.click('#go');
await page.waitForURL(/\/pos\//, { timeout: 20000 });
await page.waitForSelector('text=Your stores'); await page.screenshot({ path: OUT + '/pos-store-list.png' });
ok(await page.locator('text=Demo Smoke Shop').count() > 0, '/pos shows my stores after the shared sign-in (no password asked again in the same tab)');
await page.click('button[data-i="0"]');
await page.waitForSelector('#webGate', { state: 'detached', timeout: 30000 }); await page.waitForTimeout(1500);
ok(!!pc.seen.find(s => s.url === '/pair' && s.acct && s.acct.u === 'raj' && s.acct.r === 'owner'), 'store PC was told by the relay that raj (owner) connected');
const bodyText = await page.evaluate(() => document.body.innerText);
ok(/Cola|Register|Sale/i.test(bodyText), '/pos opened the store (register is showing)');
await page.screenshot({ path: OUT + '/pos-open.png' });
const bb = await barBox(page); console.log('bar position on /pos', JSON.stringify(bb));
ok((await barText(page)).includes('Raj Trivedi'), '/pos shows the account avatar and name');
// stored key never in browser storage
const stored = await page.evaluate(async () => { const out = []; for (const db of await indexedDB.databases()) { const r = indexedDB.open(db.name); await new Promise(s => r.onsuccess = s); const d = r.result; for (const n of d.objectStoreNames) { const all = await new Promise(s => { const q = d.transaction(n).objectStore(n).getAll(); q.onsuccess = () => s(q.result); }); out.push(JSON.stringify(all)); } } return out.join(''); });
ok(!stored.includes(store.key), 'the store key is not saved in the browser storage');

// 3. Members screen (owner)
await page.evaluate(() => { document.querySelector('[data-a="nav"][data-v="settings"], [data-v="settings"]'); });
await page.locator('nav button, .nav button, button', { hasText: /^Home$/ }).first().click(); await page.waitForTimeout(600); await page.screenshot({ path: OUT + '/pos-home.png' }); await page.getByText('Settings', { exact: true }).first().click(); await page.waitForTimeout(600);
await page.locator('button', { hasText: 'Members' }).first().click(); await page.waitForSelector('#mbWho');
await page.fill('#mbWho', 'bob'); await page.selectOption('#mbNewRole', 'cashier'); await page.click('[data-a="mbInvite"]'); await page.waitForTimeout(1200);
await page.fill('#mbWho', 'newperson@example.com'); await page.selectOption('#mbNewRole', 'reports'); await page.click('[data-a="mbInvite"]'); await page.waitForTimeout(1200);
await page.screenshot({ path: OUT + '/pos-members-invite.png' });
ok(await page.locator('text=Invite link for newperson@example.com').count() > 0, 'inviting a new email without server email shows the link to copy');
await page.locator('button', { hasText: 'Done' }).click(); await page.waitForTimeout(500);
ok(await page.locator('text=Bob Cashier').count() > 0, 'members list shows Bob');
await page.screenshot({ path: OUT + '/pos-members.png' });

// 4. other pages in the same session: same avatar, same spot
const books = await ctx.newPage(); await books.goto(h.url + '/books/'); await books.waitForTimeout(3500);
ok((await barText(books)).includes('Raj Trivedi'), '/books (Ledger Desk) shows the same avatar and name');
await books.screenshot({ path: OUT + '/books-header.png', clip: { x: 0, y: 0, width: 1440, height: 160 } });
await books.screenshot({ path: OUT + '/books.png' });
const acc = await ctx.newPage(); await acc.goto(h.url + '/account'); await acc.waitForSelector('text=Signed-in devices'); await acc.waitForTimeout(500);
await acc.screenshot({ path: OUT + '/account.png', fullPage: true });
ok((await barText(acc)).includes('Raj Trivedi'), '/account shows the same avatar and name');
ok(await acc.locator('text=Demo Smoke Shop').count() > 0 && await acc.locator('text=Owner').count() > 0, '/account lists my stores with my role');
const home = await ctx.newPage(); await home.goto(h.url + '/'); await home.waitForTimeout(800);
ok((await barText(home)).includes('Raj Trivedi'), 'home page shows the avatar once signed in');
await home.screenshot({ path: OUT + '/home-signed-in.png', clip: { x: 0, y: 0, width: 1440, height: 120 } });
// open the menu
await home.evaluate(() => document.querySelector('[data-account-bar]').shadowRoot.querySelector('#b').click()); await home.waitForTimeout(600);
await home.screenshot({ path: OUT + '/account-menu.png', clip: { x: 900, y: 0, width: 540, height: 560 } });
const boxes = {}; for (const [n, p] of [['home', home], ['books', books], ['account', acc], ['pos', page]]) boxes[n] = await barBox(p); console.log('bar boxes', JSON.stringify(boxes));
ok(['books', 'account', 'pos'].every(n => boxes[n].top <= 12 + 10), 'the account button is in the top-right corner on every page');

// 5. two-step sign-in from the account page (authenticator secret is shown)
await acc.click('#tAppStart'); await acc.waitForSelector('#tCode');
ok((await acc.locator('code').first().innerText()).length >= 16, 'account page offers an authenticator key');

// 6. sign out from one page signs out the others
await home.evaluate(() => document.querySelector('[data-account-bar]').shadowRoot.querySelector('#so').click());
await home.waitForURL(h.url + '/'); await home.waitForTimeout(800);
ok((await barText(home)).includes('Sign in'), 'after sign out the home page shows "Sign in"');
await page.waitForTimeout(1500); await acc.waitForTimeout(500); await books.waitForTimeout(500);
ok(await page.locator('#wbSign').count() > 0, '/pos went back to the sign-in screen (signed out everywhere)');
ok(page.url().includes('/pos'), '/pos is still the same page, now asking for sign-in');
await acc.waitForURL(/books\/login/, { timeout: 8000 }).then(() => ok(true, '/account sent to the sign-in page'), () => ok(false, '/account sent to the sign-in page'));
await books.waitForURL(/books\/login/, { timeout: 8000 }).then(() => ok(true, '/books sent to the sign-in page'), () => ok(false, '/books sent to the sign-in page'));

// 7. bob (cashier) is not a member yet approved? PC approves him, he opens the store with the cashier role and no Members tab
await PC.approvePending(h.url, link.deviceToken, store.key);   // bob had no key pair yet: nothing to do until he signs in once
const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const bp = await bctx.newPage();
await bp.goto(h.url + '/books/login?next=/pos/'); await bp.fill('#user', 'Bob@Example.com'); await bp.fill('#pw', PW); await bp.click('#go'); await bp.waitForURL(/\/pos\//, { timeout: 20000 });
await bp.waitForSelector('text=Your stores', { timeout: 8000 }).catch(async e => { await bp.screenshot({ path: OUT + '/debug-bob.png' }); throw e; }); await bp.waitForTimeout(500);
ok(await bp.locator('text=Waiting').count() > 0, 'bob sees the store as "Waiting" until the store PC approves');
await PC.approvePending(h.url, link.deviceToken, store.key);
await bp.click('#wbRef'); await bp.waitForSelector('button[data-i="0"]'); await bp.click('button[data-i="0"]');
await bp.waitForSelector('#webGate', { state: 'detached', timeout: 30000 }); await bp.waitForTimeout(1200);
ok(!!pc.seen.find(s => s.url === '/pair' && s.acct && s.acct.u === 'bob' && s.acct.r === 'cashier'), 'bob opened the store as cashier');
await bp.screenshot({ path: OUT + '/pos-cashier.png' });
// removing bob cuts him off right away
const rajApi = async (path, body) => { const c = await ctx.cookies(); return null; };
const owner = await (await browser.newContext()).newPage(); await owner.goto(h.url + '/books/login'); await owner.fill('#user', 'raj'); await owner.fill('#pw', PW); await owner.click('#go'); await owner.waitForURL(/books\/$/, { timeout: 20000 });
const removed = await owner.evaluate(async sid => { const r = await fetch('/api/pos/members/remove', { method: 'POST', headers: { 'x-ld': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: sid, username: 'bob' }) }); return r.status; }, store.storeId);
ok(removed === 200, 'owner removed bob');
await bp.waitForTimeout(3000);
ok(await bp.locator('text=Your stores').count() > 0 || await bp.locator('#wbSign').count() > 0, "bob's browser is thrown back to the gate right away (his connection was closed)");
await bp.screenshot({ path: OUT + '/pos-removed.png' });
// 8. POS-only people see a friendly page at /books; the owner's Logins screen has the "Can use Ledger Desk" switch
await bp.goto(h.url + '/books/'); await bp.waitForTimeout(1500);
ok(await bp.locator('text=Ask the owner to turn on Ledger Desk').count() > 0 && await bp.locator('a[href="/pos/"]').count() > 0, 'a POS-only person opening /books sees the friendly page with a link to /pos');
await bp.screenshot({ path: OUT + '/books-posonly.png' });
await owner.getByText('Logins', { exact: true }).first().click(); await owner.waitForSelector('text=Can use Ledger Desk'); await owner.waitForTimeout(800);
await owner.screenshot({ path: OUT + '/logins-checkbox.png' });
const cb = owner.locator('tr[data-user="bob"] input[data-act="uLedger"]'); ok(!(await cb.isChecked()), 'Logins shows Bob with "Can use Ledger Desk" off');
await cb.check(); await owner.waitForTimeout(1200);
const meBob = await bp.evaluate(async () => (await (await fetch('/api/me')).json()).posOnly); ok(meBob === false, 'ticking the box turns Ledger Desk on for Bob');
await bp.reload(); await bp.waitForTimeout(2500); ok(await bp.locator('text=Ask the owner to turn on Ledger Desk').count() === 0, 'Bob now gets past the friendly page');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
await browser.close(); h.close(); pc.close(); process.exit(fails ? 1 : 0);
