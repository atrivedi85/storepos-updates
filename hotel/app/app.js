// Hotel Desk: the screens. Talks to the server at /hotel/api (cloud/src/hotel-core.js).
'use strict';
let S = null;                       // everything the server sent: config, rooms, reservations, balances
let view = { name: 'home', tapeStart: '', q: '', floor: '', rep: '', from: '', to: '', opt: {}, setup: 'property', listDate: '', listSort: null };
const $ = (s, el) => (el || document).querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = v => Math.round(parseFloat(String(v).replace(/[^0-9.\-]/g, '')) * 100);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const nights = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const dshort = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'numeric', day: 'numeric', year: '2-digit' }) : '';
const dlong = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
const stamp = t => t ? new Date(t).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const gname = r => (r.last || '') + (r.first ? ', ' + r.first : '');
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };

async function api(path, body) {
  const r = await fetch('/hotel/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  let j = {}; try { j = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok) { const e = new Error(j.error || 'The server did not answer (' + r.status + ').'); e.status = r.status; throw e; }
  return j;
}
const op = (name, a) => api('/op', { op: name, a });
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', bad ? 6000 : 2600); }
async function run(fn) { try { return await fn(); } catch (e) { if (e.status === 401 || (e.status === 403 && /turned off/.test(e.message))) { S = null; M = null; return showLogin(e.status === 403 ? e.message : ''); } toast(e.message, true); } }
let M = null;                       // the master account's list of hotels (only for the seller)
async function refresh() {
  if (!S) { const w = await api('/auth/whoami'); if (w.user.role === 'master' && !w.hotel) { S = null; return masterLoad(w.user); } M = null; }
  S = await api('/state'); if (!view.tapeStart) view.tapeStart = S.config.bdate; render();
}

/* ---------- helpers on the data ---------- */
const B = () => S.config.bdate;
const boss = () => ['owner', 'manager'].includes(S.me.role);
const active = () => S.res.filter(r => r.status === 'reserved' || r.status === 'inhouse');
const cond = no => (S.roomstate[no] || {}).cond || 'R';
const isOOO = (no, d) => S.blocks.some(b => b.room === no && b.start <= d && d <= b.end);
const inRoom = no => S.res.find(r => r.status === 'inhouse' && r.room === no);
function roomFree(no, from, to, exceptId) {
  if (S.blocks.some(b => b.room === no && b.start < to && from <= b.end)) return false;
  return !active().some(r => r.id !== exceptId && r.room === no && r.arrive < to && from < r.depart);
}
function rateFor(type, d) { const t = S.config.types.find(x => x.code === type); let v = t ? t.rate : 0; const dow = new Date(d + 'T00:00:00Z').getUTCDay(); for (const r of S.config.rateRules || []) if (r.from <= d && d <= r.to && (r.type === '*' || r.type === type) && (!r.days || !r.days.length || r.days.includes(dow))) v = r.rate; return v; }
// What the nights of a stay cost at the standard rate (group rate first, then the company's rate, then rates by date).
function quote(r) { const g = r.groupId && S.groups.find(x => x.id === +r.groupId), co = r.companyId && S.companies.find(x => x.id === +r.companyId), out = []; for (let d = r.arrive; d < r.depart; d = addDays(d, 1)) out.push(g && g.rates && g.rates[r.type] > 0 ? g.rates[r.type] : co && co.rate > 0 ? co.rate : rateFor(r.type, d)); return out; }
function groupHold(type, d, exceptGroup) { let n = 0; for (const g of S.groups) { if (g.id === exceptGroup || g.status === 'cancelled' || !(g.arrive <= d && d < g.depart) || (g.cutoff && g.cutoff < B())) continue; const blk = (g.blocks || {})[type] || 0; if (blk) n += Math.max(0, blk - active().filter(r => r.groupId === g.id && r.type === type && r.arrive <= d && d < r.depart).length); } return n; }
function availOfType(type, from, to, exceptId, forGroup) {
  const rooms = S.config.rooms.filter(r => r.type === type).map(r => r.no); let min = rooms.length;
  for (let d = from; d < to; d = addDays(d, 1)) { const sold = active().filter(r => r.id !== exceptId && r.type === type && r.arrive <= d && d < r.depart).length; min = Math.min(min, rooms.length - sold - rooms.filter(no => isOOO(no, d)).length - groupHold(type, d, +forGroup || 0)); }
  return min;
}
const statusBadge = r => ({ reserved: '<span class="badge b">Reserved</span>', inhouse: r.depart <= B() ? '<span class="badge a">Due out</span>' : '<span class="badge g">In House</span>', out: '<span class="badge s">Checked out</span>', cancelled: '<span class="badge r">Cancelled</span>', noshow: '<span class="badge r">No show</span>' }[r.status] || '');
const condBtns = no => `<span class="cond">${['R', 'C', 'D'].map(k => `<button class="${k} ${cond(no) === k ? 'on' : ''}" data-act="cond" data-room="${esc(no)}" data-cond="${k}" title="${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[k]}">${k}</button>`).join('')}</span>`;

/* ---------- sign in, forgot password, choose a password from an e-mailed link ---------- */
const urlToken = () => { const t = new URLSearchParams(location.search).get('t'); return t && /^[a-f0-9]{64}$/.test(t) ? t : ''; };
async function showLogin(msg, mode) {
  $('#modal').innerHTML = ''; const token = urlToken(); let h = '', tk = null, need = { needed: false };
  if (token && !mode) { try { tk = await api('/auth/token-check', { token }); mode = 'token'; } catch (e) { msg = e.message; history.replaceState(null, '', location.pathname); } }
  if (!mode) { try { need = await api('/auth/setup-needed'); } catch (e) { /* show sign in */ } if (need.needed) mode = 'setup'; }
  const pw = (label, auto) => `<label>${label}<input id="lp" type="password" autocomplete="${auto}" required></label>`;
  if (mode === 'setup') h = need.owner ? `<p class="hint">Welcome. Make your <b>master account</b>. You'll use it to add hotels, give each owner their login, and turn a hotel off or on.</p><label>Your name<input id="ln" maxlength="80" required></label><label>Your e-mail address<input id="lu" type="email" autocomplete="username" required></label>${pw('Password (at least 8 characters)', 'new-password')}<button class="btn blue" type="submit">Make the master account</button>`
    : '<p class="hint">Hotel Desk is not set up yet. The website owner sets it up: sign in to <a href="/books/">Ledger Desk</a> as the owner, then come back to this page.</p>';
  else if (mode === 'forgot') h = `<p class="hint">Type your e-mail address. We'll send you a link to choose a new password.</p><label>E-mail address<input id="lu" type="email" autocomplete="username" required></label><button class="btn blue" type="submit">Send the link</button><p class="hint" style="margin-top:14px"><a href="#" data-act="loginBack">Back to sign in</a></p>`;
  else if (mode === 'sent') h = `<p>If <b>${esc(msg)}</b> has a Hotel Desk login, a link is on its way. It works for 60 minutes. Check the spam folder too.</p><p class="hint">No e-mail after a few minutes? Ask your manager (or the hotel's owner) to send you a new link from Setup › Logins.</p><p class="hint" style="margin-top:14px"><a href="#" data-act="loginBack">Back to sign in</a></p>`;
  else if (mode === 'token') h = `<p class="hint">${tk.kind === 'invite' ? 'Welcome, ' + esc(tk.name) + '. Choose a password for your Hotel Desk login.' : 'Choose a new password.'}</p><label>E-mail address<input value="${esc(tk.email)}" autocomplete="username" disabled></label>${pw('New password (at least 8 characters)', 'new-password')}<label>Type it again<input id="lp2" type="password" autocomplete="new-password" required></label><button class="btn blue" type="submit">Save password and sign in</button>`;
  else h = `<p class="hint">Sign in to the front desk.</p><label>E-mail address<input id="lu" type="email" autocomplete="username" required></label>${pw('Password', 'current-password')}<button class="btn blue" type="submit">Sign in</button><p class="hint" style="margin-top:14px"><a href="#" data-act="forgot">Forgot your password?</a></p>`;
  $('#app').innerHTML = `<form class="login" id="lf"><h1>Hotel Desk</h1>${h}<div class="err" id="le">${mode === 'sent' ? '' : esc(msg || '')}</div></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); $('#le').textContent = '';
    try {
      if (mode === 'setup') await api('/master/setup', { email: $('#lu').value, password: $('#lp').value, name: $('#ln').value });
      else if (mode === 'forgot') { const em = $('#lu').value.trim(); await api('/auth/forgot', { email: em }); return showLogin(em, 'sent'); }
      else if (mode === 'token') { if ($('#lp').value !== $('#lp2').value) throw new Error('The two passwords are not the same.'); await api('/auth/reset', { token, password: $('#lp').value }); history.replaceState(null, '', location.pathname); }
      else await api('/auth/login', { email: $('#lu').value, password: $('#lp').value });
      await refresh();
    } catch (x) { if (x.status === 403 && /turned off/.test(x.message)) history.replaceState(null, '', location.pathname); $('#le').textContent = x.message; }
  };
}
function linkBox(title, r, email) {   // shows the "choose your password" link after a login is made
  $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle">${esc(title)}</div><p>${r.sent ? 'We e-mailed the link to <b>' + esc(email) + '</b>.' : '<b>The e-mail could not be sent</b> (e-mail is not set up yet, or the address refused it).'} ${r.sent ? 'You can also copy it and send it yourself:' : 'Copy this link and send it to ' + esc(email) + ' yourself:'}</p><textarea id="linkTxt" rows="3" readonly style="font-family:Consolas,monospace;font-size:13px">${esc(r.link)}</textarea><p class="hint">The link lets that person choose their password. It works for 7 days, one time. Send it only to them.</p><div class="mfoot"><button class="btn blue" data-act="copyLink">Copy link</button><button class="btn" data-act="closeModal">Done</button></div></div></div>`;
}
function pwBox() { $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle">My password</div><div class="grid"><label class="c12">Current password<input type="password" id="pw_old" autocomplete="current-password"></label><label class="c12">New password (8 or more)<input type="password" id="pw_new" autocomplete="new-password"></label></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="pwSave">Change password</button></div></div></div>`; }

/* ---------- master account: the hotels you sell to ---------- */
async function masterLoad(user) { const r = await api('/master/hotels'); M = { user: user || (M && M.user), hotels: r.hotels, mail: r.mail }; masterDraw(); }
function masterDraw() {
  const today = localToday(), on = M.hotels.filter(h => h.status === 'active').length;
  $('#app').innerHTML = `<header><div class="brand"><img src="icon.png" alt="">Hotel Desk · Master account</div><nav></nav><div class="who"><b>${esc(M.user.name)}</b><a href="#" data-act="myPw" style="color:#8fb4ff">My password</a> · <a href="#" data-act="logout" style="color:#8fb4ff">Sign out</a></div></header>
  <main><h1>Hotels</h1><div class="bar"><button class="btn green" data-act="mHotelNew">+ Add a hotel</button><button class="btn teal" data-act="mTestHotel">+ Test hotel (55 rooms)</button><button class="btn" data-act="mMail">E-mail settings${M.mail.user && M.mail.hasPass ? '' : ' (not set up)'}</button><span class="hint">${M.hotels.length} hotels · ${on} on · ${M.hotels.length - on} off</span></div>
  ${M.mail.user && M.mail.hasPass ? '' : '<div class="card" style="margin-bottom:12px;border-color:var(--amber)"><b>E-mail is not set up yet.</b> Until it is, "Forgot password" and new-login e-mails cannot be sent. You can still copy each new login\'s link and send it yourself. Click E-mail settings to set it up.</div>'}
  ${M.hotels.length ? `<div class="wrap"><table><tr><th>Hotel</th><th>Owner</th><th>Status</th><th>Paid through</th><th class="num">Logins</th><th>Note</th><th></th></tr>${M.hotels.map(h => `<tr><td><b>${esc(h.name)}</b><br><span class="hint">since ${new Date(h.created).toLocaleDateString()}</span></td><td>${h.ownerEmail ? `${esc(h.ownerName)}<br><span class="hint">${esc(h.ownerEmail)}${h.ownerSignedIn ? '' : ' · has not signed in yet'}</span>` : '<span class="badge a">Test hotel</span><br><span class="hint">no owner login · use Open</span>'}</td>
    <td>${h.status === 'active' ? '<span class="badge g">ON</span>' : '<span class="badge r">OFF</span>'}</td><td>${h.paidThrough ? dshort(h.paidThrough) + (h.paidThrough < today ? ' <span class="badge r">past due</span>' : '') : ''}</td><td class="num">${h.users}</td><td>${esc(h.note || '')}</td>
    <td><div class="acts">${h.status === 'active' ? `<button class="btn sm red" data-act="mStatus" data-id="${h.id}" data-to="off">Turn off</button>` : `<button class="btn sm green" data-act="mStatus" data-id="${h.id}" data-to="active">Turn on</button>`}<button class="btn sm" data-act="mHotelEdit" data-id="${h.id}">Edit</button><button class="btn sm" data-act="mOpen" data-id="${h.id}">Open</button>${h.ownerEmail ? `<button class="btn sm" data-act="mInvite" data-id="${h.id}">Owner link</button>` : ''}</div></td></tr>`).join('')}</table></div>` : '<div class="empty">No hotels yet. Click "Add a hotel" to make the first one.</div>'}
  <p class="hint" style="margin-top:14px"><b>Turn off</b> is the kill switch: everyone at that hotel is signed out at once and nobody there can sign in until you turn it on again. Their data is kept. <b>Open</b> lets you go into a hotel as its owner (to help them or set it up). <b>Owner link</b> makes a fresh link for the owner to choose a password.</p></main>`;
}
function mHotelBox(h) {
  const n = !h; h = h || { name: '', paidThrough: '', note: '' };
  $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle">${n ? 'Add a hotel' : 'Edit ' + esc(h.name)}</div><div class="grid"><label class="c12">Hotel name<input id="mh_name" maxlength="80" value="${esc(h.name)}"></label>
    ${n ? `<label class="c6">Owner's name<input id="mh_ownerName" maxlength="80"></label><label class="c6">Owner's e-mail address<input id="mh_ownerEmail" type="email" maxlength="120"></label><label class="c6">Start with<select id="mh_template"><option value="blank">A blank hotel (owner adds rooms)</option><option value="ky55">My hotel's 55 rooms, rates and taxes</option></select></label><label class="c6">Time zone<select id="mh_tz">${[['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii']].map(z => `<option value="${z[0]}">${z[1]}</option>`).join('')}</select></label>` : ''}
    <label class="c6">Paid through (for your records)<input type="date" id="mh_paid" value="${esc(h.paidThrough || '')}"></label><label class="c12">Note (only you see it)<input id="mh_note" maxlength="500" value="${esc(h.note || '')}"></label></div>
    ${n ? '<p class="hint" style="margin:10px 0 0">The owner gets a link to choose their password. Then they sign in and make logins for their general manager and employees.</p>' : ''}
    <div class="err" id="mh_err"></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="mHotelSave" data-id="${esc(h.id || '')}">${n ? 'Add hotel' : 'Save'}</button></div></div></div>`;
}
function mMailBox() {
  const m = M.mail;
  $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle">E-mail settings</div><p class="hint">Hotel Desk sends "choose your password" and "forgot password" e-mails from this address. For Gmail: use an <b>app password</b> (myaccount.google.com/apppasswords), not your normal password.</p><div class="grid"><label class="c6">Send from (e-mail address)<input id="mm_user" type="email" value="${esc(m.user)}" maxlength="120"></label><label class="c6">App password ${m.hasPass ? '(saved; blank = keep)' : ''}<input id="mm_pass" type="password" autocomplete="new-password"></label><label class="c6">Sender name<input id="mm_fromName" value="${esc(m.fromName)}" maxlength="60"></label><label class="c3">Mail server<input id="mm_host" value="${esc(m.host)}"></label><label class="c3">Port<input id="mm_port" value="${esc(m.port)}"></label></div><div class="err" id="mm_err"></div><div class="mfoot"><button class="btn" data-act="closeModal">Close</button><button class="btn" data-act="mMailTest">Save and send me a test</button><button class="btn green" data-act="mMailSave">Save</button></div></div></div>`;
}

/* ---------- the frame ---------- */
const NAV = [['home', 'Home'], ['tape', 'Tape Chart'], ['arrivals', 'Arrivals'], ['inhouse', 'In House'], ['departures', 'Departures'], ['groups', 'Groups'], ['companies', 'Companies'], ['hk', 'Housekeeping'], ['reports', 'Reports'], ['setup', 'Setup']];
function render() {
  if (!S || drawing) return;
  const hk = S.me.role === 'hk'; if (hk) view.name = 'hk';
  const nav = NAV.filter(n => hk ? n[0] === 'hk' : n[0] !== 'setup' || boss());
  if (!boss() && view.name === 'setup') view.name = 'home';
  const keep = $('main') ? $('main').scrollTop : 0, keepX = $('main') ? $('main').scrollLeft : 0, focusId = document.activeElement && document.activeElement.id;
  drawing = true; try { paint(hk, nav); } finally { drawing = false; }
  $('main').scrollTop = keep; $('main').scrollLeft = keepX;
  if (focusId && $('#' + focusId)) { const el = $('#' + focusId); el.focus(); if (el.setSelectionRange && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length); }
  if (view.name === 'reports' && view.rep && view.repStage === 'result') drawReport();
  if (view.name === 'reports' && view.repStage !== 'options' && view.repStage !== 'result') repFilter();
  if (view.name === 'reports' && view.rep && view.repStage === 'options') fillShiftUsers();
}
const IC_PERSON = '<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
const IC_BUILD = '<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 21V4h9v17M14 9h5v12M3 21h18M8 8h3M8 12h3M8 16h3"/></svg>';
function paint(hk, nav) {
  const it = (label, attr) => `<a href="#" ${attr}>${label}</a>`, N = (v, label) => it(label, `data-nav="${v}"`), A = (a, label, x) => it(label, `data-act="${a}" ${x || ''}`);
  const menu = (name, items, cls) => `<div class="menu ${cls || ''}"><button type="button">${name}</button><div class="drop">${items.filter(Boolean).join('')}</div></div>`;
  const menus = hk ? '<button type="button" class="on" data-nav="hk">Housekeeping</button>' : `<button type="button" data-nav="home" class="${view.name === 'home' ? 'on' : ''}">Home</button>` +
    menu('Find', [A('findOpen', 'Reservation'), A('findOpen', 'Guest Profile'), N('companies', 'Company Profile'), N('companies', 'Direct Bill Account'), N('groups', 'Group Master')]) +
    menu('View', [N('inhouse', 'In House'), N('arrivals', 'Arrivals'), N('departures', 'Departures'), N('departures', "Today's Checked Out Guests"), N('stats', 'Quick Statistics'), A('repGo', 'Future Availability', 'data-rep="future"'), N('companies', 'Company Profiles'), A('repGo', 'Night Audit', 'data-rep="stats"')]) +
    menu('Create', [A('newRes', 'Reservation'), A('walkIn', 'Walk-In'), A('coNew', 'Company Profile'), A('coNew', 'Direct Bill Account'), A('grpNew', 'Group Master')]) +
    menu('Manage', [A('shift', 'Cashier Shift' + (S.shift ? ' (open)' : '')), A('repGo', 'No Show Reservations', 'data-rep="noshow"'), N('hk', 'Housekeeping Center'), A('blockNew', 'Room Blocking'), N('dnr', 'Do Not Rent List'), boss() && A('setupGo', 'Packages', 'data-tab="packages"'), boss() && N('setup', 'Hotel Configuration'), boss() && A('setupGo', 'Manage Rates', 'data-tab="rates"'), boss() && A('setupGo', 'Logins', 'data-tab="users"'), N('tape', 'Tape Chart')]) +
    menu('Run', [N('reports', 'Reports'), boss() && A('nightAudit', 'Night Audit')]);
  $('#app').innerHTML = `<header><div class="brand"><img src="icon.png" alt="">${esc(S.config.name)}</div><nav class="menus">${menus}</nav>
    <div class="hright">${S.me.master ? '<button class="btn sm amber" data-act="mClose">◀ All hotels</button>' : ''}${hk ? '' : '<span class="rj"><input id="roomJump" placeholder="Room #" autocomplete="off" aria-label="Room number"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg></span><input class="find" id="find" placeholder="Find guest or conf. #">'}
    ${menu(IC_PERSON + ' ' + esc(S.me.name), [A('myPw', 'My password'), A('logout', 'Logout')], 'user')}<span class="bdate">${esc(dshort(B()))}</span></div></header>
    <main><div class="hline">${IC_BUILD}<span>${esc(S.config.name)}</span></div>${({ home: vHome, tape: vTape, arrivals: vArrivals, inhouse: vInHouse, departures: vDepartures, hk: vHk, reports: vReports, setup: vSetup, find: vFind, dnr: vDnr, groups: vGroups, companies: vCompanies, stats: vStats }[view.name] || vHome)()}</main>`;
}

/* ---------- Home ---------- */
function vHome() {
  const s = S.stats, d = B(), hr = new Date().getHours(), hello = hr < 12 ? 'Good Morning' : hr < 18 ? 'Good Afternoon' : 'Good Evening';
  const types = S.config.types.map(t => ({ t, n: availOfType(t.code, d, addDays(d, 1)) })).sort((a, b) => b.n - a.n);
  const dirtyVacant = S.config.rooms.filter(r => !inRoom(r.no) && cond(r.no) === 'D').length, arrToday = s.checkedIn + s.arrivalsLeft;
  const outToday = S.res.filter(r => r.status === 'out' && r.depart === d).length;
  const T = (attr, icon, label) => `<button class="tile" ${attr}><span class="ic">${icon}</span><span>${label}</span></button>`;
  return `<div class="tiles">${T('data-act="shift"', '$', 'Cashier<br>Shift')}${T('data-nav="arrivals"', '🛎', 'View<br>Arrivals')}${T('data-nav="inhouse"', '🧳', 'In House<br>List')}${T('data-nav="departures"', '🚗', 'View Departures<br>List')}${T('data-nav="stats"', '📊', 'Quick<br>Statistics')}${T('data-nav="tape"', '▦', 'Tape<br>Chart')}${T('data-nav="hk"', '🧹', 'Housekeeping<br>Center')}
    ${T('data-act="newRes"', '＋', 'Create<br>Reservation')}${T('data-act="walkIn"', '🚶', 'Walk-In')}${T('data-act="findOpen"', '👤', 'Find<br>Guest')}${T('data-act="blockNew"', '⛔', 'Room<br>Blocking')}${T('data-nav="groups"', '👥', 'Group<br>Master')}${T('data-nav="companies"', '🏢', 'Company<br>Profiles')}${T('data-nav="reports"', '📄', 'Reports')}</div>
  <div class="band"><div class="greet">${hello},<br>${esc(String(S.me.name).split(' ')[0])}!</div>
    <div class="bigs"><div><b>${s.occ}%</b><span>Today's Occupancy</span></div><div><b>${money(s.adr)}</b><span>Expected ADR</span></div></div>
    <div class="trio"><div><b>${arrToday}</b><span>Total Arrivals Today</span></div><div><b>${s.checkedIn}</b><span>Check Ins Completed</span></div><div><b>${s.arrivalsLeft}</b><span>Check Ins Remaining</span></div></div>
    <div class="trio"><div><b>${s.dueOut + outToday}</b><span>Total Departures Today</span></div><div><b>${dirtyVacant}</b><span>Vacant/Dirty Rooms Remaining</span></div><div><b>${s.vacant}</b><span>Total Rooms Available</span></div></div>
    <div class="stack">${[[s.arrivalsLeft, '#1c1c1c', 'check ins', 't'], [s.stayovers, '#6b6b6b', 'stayovers', 'b'], [s.vacant, '#4a4a4a', 'vacant', 't'], [s.ooo, 'var(--red)', 'OOO', 'b']].map(x => `<div class="seg" style="flex:${x[0]} 1 0"><span class="sl">${x[3] === 't' ? x[2] : ''}</span><div class="sb" style="background:${x[1]}">${x[0]}</div><span class="sl">${x[3] === 'b' ? x[2] : ''}</span></div>`).join('')}</div></div>
  <div class="availrow"><div class="availtot"><b>${s.vacant}</b><span>Available</span></div>${types.map(x => `<div class="availtype"><span>${esc(x.t.code)}<br>${money(rateFor(x.t.code, d))}</span><b>${x.n}</b></div>`).join('')}</div>`;
}
function vStats() {
  const s = S.stats, d = B(), act = active(), inh = act.filter(r => r.status === 'inhouse'), arr = act.filter(r => r.status === 'reserved' && r.arrive <= d);
  const gtd = arr.filter(r => !/6 PM/.test(r.guarantee || '')).length, occOf = k => S.config.rooms.filter(r => cond(r.no) === k && inRoom(r.no)).length, vacOf = k => S.config.rooms.filter(r => cond(r.no) === k && !inRoom(r.no)).length;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0); const madeToday = S.res.filter(r => r.created >= today0.getTime()).length, cxlToday = S.res.filter(r => r.status === 'cancelled' && r.cxlAt >= today0.getTime()).length;
  const row = (a, b, c) => `<tr><td>${a}</td><td class="num">${b}</td>${c === undefined ? '' : `<td class="num">${c}</td>`}</tr>`;
  return `<h1>Hotel Quick Stats: ${esc(dlong(d))}</h1><div class="statgrid">
  <div><h2>Property Availability</h2><div class="wrap"><table><tr><th class="num">Avail</th><th class="num">Rooms Sold</th><th class="num">OOO</th><th class="num">Total Rooms</th></tr><tr><td class="num">${s.vacant}</td><td class="num">${s.sold}</td><td class="num">${s.ooo}</td><td class="num">${s.total}</td></tr></table></div>
    <h2>Room Types / Availability / Rates</h2><div class="wrap"><table><tr><th>Type</th><th class="num">Avail</th><th class="num">Rooms Sold</th><th class="num">OOO</th><th class="num">Total Rooms</th><th class="num">Rate</th></tr>${S.config.types.map(t => { const rooms = S.config.rooms.filter(r => r.type === t.code); return `<tr><td><b>${esc(t.code)}</b></td><td class="num">${availOfType(t.code, d, addDays(d, 1))}</td><td class="num">${inh.filter(r => r.type === t.code).length}</td><td class="num">${rooms.filter(r => isOOO(r.no, d)).length}</td><td class="num">${rooms.length}</td><td class="num">${money(rateFor(t.code, d))}</td></tr>`; }).join('')}</table></div></div>
  <div><h2>Room Status</h2><div class="wrap"><table><tr><th>Rooms</th><th class="num">Count</th></tr>${row('Total Rooms:', s.total)}${row('Due Out Rooms:', s.dueOut)}${row('Out of Order Rooms:', s.ooo)}${row('Stayover Rooms:', s.stayovers)}${row('Vacant Rooms:', s.vacant)}${row('Guaranteed Arrivals:', gtd)}${row('Non-Guaranteed Arrivals:', arr.length - gtd)}${row('Total Arrivals:', arr.length)}${row('Rooms Available to Sell:', S.config.types.reduce((n, t) => n + Math.max(0, availOfType(t.code, d, addDays(d, 1))), 0))}</table></div>
    <h2>Guests</h2><div class="wrap"><table><tr><th>Guests</th><th class="num">Adults</th><th class="num">Children</th></tr>${row('In House:', s.adults, s.children)}${row('Reserved:', arr.reduce((n, r) => n + (r.adults || 0), 0), arr.reduce((n, r) => n + (r.children || 0), 0))}</table></div></div>
  <div><h2>Housekeeping</h2><div class="wrap"><table><tr><th>Housekeeping</th><th class="num">Occupied</th><th class="num">Vacant</th></tr>${row('Dirty:', occOf('D'), vacOf('D'))}${row('Clean:', occOf('C'), vacOf('C'))}${row('Ready:', occOf('R'), vacOf('R'))}</table></div>
    <h2>Today's Activity</h2><div class="wrap"><table><tr><th></th><th class="num">Count</th></tr>${row('New Reservations:', madeToday)}${row('Cancellations:', cxlToday)}${row('Checked In Today:', s.checkedIn)}</table></div>
    <h2>Statistics</h2><div class="wrap"><table><tr><th></th><th class="num">Today</th></tr>${row('Occupancy % with OOO:', s.occAll + '%')}${row('Occupancy % w/o OOO:', s.occ + '%')}${row('ADR:', money(s.adr))}${row('Rev PAR:', money(s.revpar))}</table></div></div></div>
  <div class="acts" style="margin-top:14px"><button class="btn sm" data-act="findOpen">Find Guest</button><button class="btn sm" data-act="newRes">Create Reservation</button><button class="btn sm" data-act="walkIn">Walk-In</button><button class="btn sm" data-nav="groups">Find Group Master</button></div>`;
}

/* ---------- Tape chart ---------- */
function vTape() {
  const days = []; for (let i = 0; i < 14; i++) days.push(addDays(view.tapeStart, i));
  const end = addDays(view.tapeStart, 14);
  const rooms = S.config.rooms.filter(r => !view.floor || r.floor === view.floor);
  const floors = [...new Set(S.config.rooms.map(r => r.floor))].sort();
  const shown = S.res.filter(r => r.room && r.status !== 'cancelled' && r.status !== 'noshow');
  const rows = rooms.map(rm => {
    let tds = '', i = 0;
    while (i < days.length) {
      const d = days[i]; const r = shown.find(x => x.room === rm.no && x.arrive <= d && d < x.depart && (x.status !== 'out' || d < B())) || (d === B() ? null : null);
      const blk = !r && S.blocks.find(b => b.room === rm.no && b.start <= d && d <= b.end);
      if (r) { let n = 0; while (i + n < days.length && days[i + n] < r.depart) n++; const cls = r.status === 'inhouse' ? (r.depart <= B() ? 'due' : 'inhouse') : r.status; tds += `<td colspan="${n}"><button class="tbar ${cls}" data-act="openRes" data-id="${r.id}" title="${esc(gname(r))} · ${dshort(r.arrive)} to ${dshort(r.depart)}">${esc(gname(r))}</button></td>`; i += n; }
      else if (blk) { let n = 0; while (i + n < days.length && days[i + n] <= blk.end) n++; tds += `<td colspan="${n}"><span class="tbar ooo" title="${esc(blk.reason)}">Out of order${blk.reason ? ': ' + esc(blk.reason) : ''}</span></td>`; i += n; }
      else { tds += `<td class="${d >= B() ? 'free' : ''}" ${d >= B() ? `data-act="newRes" data-room="${esc(rm.no)}" data-date="${d}"` : ''}></td>`; i++; }
    }
    return `<tr><td class="rm"><a href="#" data-act="newRes" data-room="${esc(rm.no)}" data-date="${B()}">${esc(rm.no)}</a></td><td class="ty">${esc(rm.type)}</td><td class="cd">${condBtns(rm.no)}</td>${tds}</tr>`;
  }).join('');
  const un = active().filter(r => !r.room && r.arrive < end).sort((a, b) => a.arrive.localeCompare(b.arrive));
  const byDay = {}; for (const r of un) (byDay[r.arrive] = byDay[r.arrive] || []).push(r);
  return `<h1 class="pgt">Tape Chart</h1><div class="bar"><span class="hint">Start Date:</span><input type="date" id="tapeDate" value="${view.tapeStart}"><button class="btn sm blue" data-act="tapeToday">TODAY</button><button class="btn sm" data-act="tapeMove" data-n="-7">◀ Week</button><button class="btn sm" data-act="tapeMove" data-n="7">Week ▶</button>
    <select id="tapeFloor"><option value="">All floors</option>${floors.map(f => `<option ${view.floor === f ? 'selected' : ''} value="${esc(f)}">Floor ${esc(f)}</option>`).join('')}</select><span class="flex"></span><button class="btn sm red" data-act="blockNew">Room Blocking…</button></div>
  <div class="tapewrap"><div class="wrap" style="max-height:calc(100vh - 200px);flex:1"><table class="tape"><tr><th class="c1">Room #</th><th class="c2">Type</th><th class="c3">Condition</th>${days.map(d => { const dt = new Date(d + 'T00:00:00Z'); const we = [5, 6].includes(dt.getUTCDay()); return `<th class="${we ? 'we' : ''} ${d === B() ? 'td' : ''}">${dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })}.<br>${dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}</th>`; }).join('')}</tr>${rows}</table></div>
  <aside class="tside"><h3>Overview</h3><div class="lg"><i style="background:var(--green)"></i>In House</div><div class="lg"><i style="background:var(--blue)"></i>Reserved</div><div class="lg"><i style="background:var(--amber)"></i>Due Out</div><div class="lg"><i style="background:#9aa6b8"></i>Checked Out</div><div class="lg"><i style="background:var(--red)"></i>Out of Order</div><p class="hint">R ready · C clean · D dirty.<br>Click an empty day to book that room.</p>
    <h3>Unassigned Reservations</h3>${un.length ? Object.keys(byDay).sort().map(d => `<div class="uday">Arrival Date: ${new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })}</div>` + byDay[d].map(r => `<a href="#" class="un" data-act="openRes" data-id="${r.id}"><span>${esc(gname(r))}</span><span>${esc(r.type)}</span><span>${nights(r.arrive, r.depart)}</span></a>`).join('')).join('') : '<p class="hint">None.</p>'}</aside></div>`;
}

/* ---------- Lists: Arrivals, In House and Departures share one builder ---------- */
const byName = (a, b) => gname(a).localeCompare(gname(b));   // also used by the reports
const dmdy = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
const balTxt = c => c < 0 ? '(' + money(-c) + ')' : money(c);   // negative balances in parentheses
const condWord = r => r.room ? ({ R: 'Ready', C: 'Clean', D: 'Dirty' })[cond(r.room)] || '' : '';
const condBadge = r => r.room ? ({ R: '<span class="badge g">Ready</span>', C: '<span class="badge a">Clean</span>', D: '<span class="badge r">Dirty</span>' })[cond(r.room)] || '' : '';
// Every column the three list screens can show: heading, sort value, kind (text | num | room) and cell HTML.
const LC = {
  guest: { head: 'Guest Name', val: gname, cell: r => `<b>${esc(gname(r))}</b>${r.vip ? ' <span class="badge a">VIP</span>' : ''}` },
  city: { head: 'City', val: r => r.city || '', cell: r => esc(r.city) },
  zip: { head: 'Postal Code', val: r => r.zip || '', cell: r => esc(r.zip) },
  gtd: { head: 'Guarantee', val: r => r.guarantee || '', cell: r => esc(r.guarantee) },
  nights: { head: '# Nights', kind: 'num', val: r => nights(r.arrive, r.depart), cell: r => nights(r.arrive, r.depart) },
  room: { head: 'Room #', kind: 'room', val: r => r.room || '', cell: r => r.room ? `<b>${esc(r.room)}</b>` : '<span class="badge r">None</span>' },
  type: { head: 'Type', val: r => r.type || '', cell: r => esc(r.type) },
  cond: { head: 'Condition', val: condWord, cell: condBadge },
  rate: { head: 'Rate Plan', val: r => r.pkg || 'BAR', cell: r => esc(r.pkg || 'BAR') },
  company: { head: 'Company Profile Name', val: r => r.company || '', cell: r => esc(r.company) },
  group: { head: 'Group Name', val: r => r.groupName || '', cell: r => esc(r.groupName) },
  conf: { head: 'Conf. #', val: r => r.conf || '', cell: r => esc(r.conf) },
  arrive: { head: 'Arrival', val: r => r.arrive || '', cell: r => dshort(r.arrive) },
  depart: { head: 'Departure', val: r => r.depart || '', cell: r => dshort(r.depart) },
  pay: { head: 'Payment Type', val: r => r.payType || '', cell: r => esc(r.payType) },
  bal: { head: 'Balance', kind: 'num', val: r => S.bal[r.id] || 0, cell: r => balTxt(S.bal[r.id] || 0) },
};
// o: {title (escaped), empty, rows, cols (keys of LC), sort {col, dir} (the default), dateRow (optional HTML)}.
// view.listSort (set by clicking a heading) wins over the default while its column is on this screen.
function listScreen(o) {
  const all = o.rows, q = view.q.trim().toUpperCase();
  let list = q ? all.filter(r => (gname(r) + ' ' + r.conf + ' ' + (r.room || '') + ' ' + (r.company || '')).toUpperCase().includes(q)) : all;
  const s = view.listSort && o.cols.includes(view.listSort.col) ? view.listSort : o.sort, L = LC[s.col];
  const cmp = (x, y) => L.kind === 'num' ? x - y : String(x).localeCompare(String(y), 'en', L.kind === 'room' ? { numeric: true } : undefined);
  list = list.slice().sort((a, b) => { const c = cmp(L.val(a), L.val(b)); return s.dir === 'desc' ? -c : c; });
  const guests = list.reduce((n, r) => n + (r.adults || 0) + (r.children || 0), 0);
  const th = k => { const c = LC[k], on = s.col === k; return `<th class="sortable${c.kind === 'num' ? ' num' : ''}" data-act="listSort" data-col="${k}">${c.head} <span class="sarr${on ? ' on' : ''}">${on ? (s.dir === 'desc' ? '▼' : '▲') : '⇅'}</span></th>`; };
  const table = `<div class="wrap"><table class="lst"><tr>${o.cols.map(th).join('')}</tr>${list.map(r => `<tr class="click" data-act="openRes" data-id="${r.id}">${o.cols.map(k => `<td class="${LC[k].kind === 'num' ? 'num' : ''}">${LC[k].cell(r)}</td>`).join('')}</tr>`).join('')}</table></div>`;
  return `<h1 class="pgt-c">${o.title}</h1>` + (all.length ? '' : `<div class="lst-empty">${esc(o.empty)}</div>`) + (o.dateRow || '') +
    `<div class="lst-bar"><span>Guest Count: <b>${guests}</b></span><span>Room Count: <b>${list.length}</b></span><span class="flex"></span><label class="lst-q">Quick Search: <input id="q" value="${esc(view.q)}"></label></div>` +
    table;
}
// The date row above Arrivals and Departures: ◀ [date] ▶ UPDATE. Enter in the date box also applies it.
const listDateRow = (label, day) => `<div class="lst-date"><span class="lst-lbl">${label}</span><button class="btn sm" data-act="listDateStep" data-n="-1" title="Previous day">◀</button><input type="date" id="listDate" value="${esc(day)}" style="width:180px"><button class="btn sm" data-act="listDateStep" data-n="1" title="Next day">▶</button><button class="btn sm blue" data-act="listDateGo">UPDATE</button></div>`;
// The business date shows what is due now; any other date shows the bookings for that date.
const vArrivals = () => {
  const day = view.listDate || B(), today = day === B();
  const rows = S.res.filter(r => today ? r.status === 'reserved' && r.arrive <= B() : r.arrive === day && ['reserved', 'inhouse', 'out'].includes(r.status));
  return listScreen({ title: 'Arrivals: ' + esc(dmdy(day)), empty: 'No scheduled arrivals found.', rows, cols: ['guest', 'city', 'zip', 'gtd', 'nights', 'room', 'type', 'cond', 'rate', 'company', 'group', 'conf'], sort: { col: 'guest', dir: 'asc' }, dateRow: listDateRow('Arrival Date:', day) });
};
const vInHouse = () => listScreen({ title: 'In House List', empty: 'Nobody is checked in.', rows: S.res.filter(r => r.status === 'inhouse'), cols: ['room', 'guest', 'city', 'zip', 'type', 'cond', 'rate', 'arrive', 'depart', 'company', 'group', 'pay', 'bal'], sort: { col: 'room', dir: 'asc' } });
const vDepartures = () => {
  const day = view.listDate || B(), today = day === B();
  const rows = S.res.filter(r => today ? r.status === 'inhouse' && r.depart <= B() : r.depart === day && ['reserved', 'inhouse', 'out'].includes(r.status));
  return listScreen({ title: 'Departures: ' + esc(dmdy(day)), empty: 'No scheduled departures found.', rows, cols: ['room', 'guest', 'city', 'type', 'arrive', 'depart', 'pay', 'bal', 'company', 'group', 'conf'], sort: { col: 'room', dir: 'asc' }, dateRow: listDateRow('Departure Date:', day) }) +
    (today ? '<h2>Checked out today</h2>' + (() => { const l = S.res.filter(r => r.status === 'out' && r.coAt && new Date(r.coAt).getTime() > Date.now() - 36 * 36e5 && r.depart >= addDays(B(), -1)); return l.length ? `<div class="wrap"><table><tr><th>Room</th><th>Guest</th><th>Checked out</th><th class="num">Balance</th></tr>${l.map(r => `<tr class="click" data-act="openRes" data-id="${r.id}"><td><b>${esc(r.room)}</b></td><td>${esc(gname(r))}</td><td>${stamp(r.coAt)}</td><td class="num">${balTxt(S.bal[r.id] || 0)}</td></tr>`).join('')}</table></div>` : '<div class="hint">Nobody yet.</div>'; })() : '');
};
function vFind() {
  const l = view.found || [];
  return `<h1 class="pgt">Find Reservation / Guest</h1><div class="bar"><input id="find2" placeholder="Last name, phone or confirmation #" value="${esc(view.findQ || '')}" style="width:320px"><button class="btn sm blue" data-act="findGo">SEARCH</button></div>` + (view.findQ ? '' : '<div class="empty">Type a last name, a phone number or a confirmation number.</div>') + (!view.findQ ? '' : (l.length ? `<div class="wrap"><table><tr><th>Guest</th><th>Status</th><th>Arrival</th><th>Departure</th><th>Room</th><th>Type</th><th>Phone</th><th>Conf. #</th></tr>${l.map(r => `<tr class="click" data-act="openRes" data-id="${r.id}"><td><b>${esc(gname(r))}</b></td><td>${statusBadge(r)}</td><td>${dshort(r.arrive)}</td><td>${dshort(r.depart)}</td><td>${esc(r.room)}</td><td>${esc(r.type)}</td><td>${esc(r.phone)}</td><td>${esc(r.conf)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Nothing found. Search by last name, phone number or confirmation number.</div>'));
}

/* ---------- Housekeeping ---------- */
function service(no) { const g = inRoom(no); if (g) return g.depart <= B() ? 'Check Out' : 'Stay Over'; return cond(no) === 'D' ? 'Check Out' : 'None'; }
const hkPreText = no => { const g = inRoom(no); return g ? [g.crib && 'Crib', g.rollaway && 'Rollaway'].filter(Boolean).join(' · ') : ''; };
const hkPre = no => hkPreText(no) ? `<span class="hkpre">${hkPreText(no)}</span>` : '';   // read-only prefix in the Notes cell
function vHk() {
  const floors = [...new Set(S.config.rooms.map(r => r.floor))].sort();
  const rooms = S.config.rooms.filter(r => !view.floor || r.floor === view.floor);
  const cnt = k => rooms.filter(r => cond(r.no) === k).length;
  return `<h1>Housekeeping</h1><div class="bar"><select id="hkFloor"><option value="">All floors</option>${floors.map(f => `<option ${view.floor === f ? 'selected' : ''} value="${esc(f)}">Floor ${esc(f)}</option>`).join('')}</select>
    <span class="badge r">${cnt('D')} dirty</span><span class="badge a">${cnt('C')} clean</span><span class="badge g">${cnt('R')} ready</span><span class="flex"></span>
    <span class="hint">Rooms</span><input id="hkFrom" placeholder="from" style="width:80px"><input id="hkTo" placeholder="to" style="width:80px"><button class="btn sm red" data-act="hkRange" data-cond="D">Dirty</button><button class="btn sm amber" data-act="hkRange" data-cond="C">Clean</button><button class="btn sm green" data-act="hkRange" data-cond="R">Ready</button><button class="btn sm" data-act="printHk">Print check-off list</button></div>
  <div class="wrap"><table><tr><th>Room</th><th>Type</th><th>Room status</th><th>Condition</th><th>Service</th><th>Assigned to</th><th>Do not disturb</th><th>Notes</th></tr>
  ${rooms.map(rm => { const st = S.roomstate[rm.no] || {}; const occ = !!inRoom(rm.no); return `<tr><td><b>${esc(rm.no)}</b></td><td>${esc(rm.type)}</td><td>${isOOO(rm.no, B()) ? '<span class="badge r">Out of order</span>' : occ ? '<span class="badge g">Occupied</span>' : '<span class="badge s">Vacant</span>'}</td><td>${condBtns(rm.no)}</td><td>${service(rm.no)}</td>
    <td><select data-hk="hk" data-room="${esc(rm.no)}" style="min-height:34px;padding:4px 8px"><option value=""></option>${S.config.housekeepers.map(h => `<option ${st.hk === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></td>
    <td><input type="checkbox" data-hk="dnd" data-room="${esc(rm.no)}" ${st.dnd ? 'checked' : ''}></td><td class="hknote">${hkPre(rm.no)}<input data-hk="note" data-room="${esc(rm.no)}" value="${esc(st.note || '')}" maxlength="200" style="min-height:34px;padding:4px 8px"></td></tr>`; }).join('')}</table></div>
  ${S.config.housekeepers.length ? '' : '<p class="hint">To assign rooms, a manager adds the housekeepers\' names in Setup › Housekeepers.</p>'}`;
}

/* ---------- Reservation window ---------- */
let ED = null;   // the reservation being edited
function resForm(r, mode) {
  const isNew = !r.id, locked = !isNew && !['reserved', 'inhouse'].includes(r.status);
  const n = nights(r.arrive, r.depart), types = S.config.types;
  const from = r.status === 'inhouse' && B() > r.arrive ? B() : r.arrive;
  const freeRooms = S.config.rooms.filter(x => (x.no === r.room) || (roomFree(x.no, from, r.depart, r.id)));
  const t = types.find(x => x.code === r.type) || types[0];
  const taxPct = r.taxExempt ? 0 : S.config.taxes.filter(x => ((S.config.codes.find(k => k.code === 'RM') || {}).tax || []).includes(x.code)).reduce((s, x) => s + x.pct, 0);
  const q = r.arrive < r.depart ? quote(r) : [t.rate], manual = !!r.rateManual && r.rate != null, nightly = manual ? q.map(() => r.rate) : q;
  const pk = r.pkg && (S.config.packages || []).find(x => x.code === r.pkg), varies = new Set(nightly).size > 1;
  const est = Math.round((nightly.reduce((a, b) => a + b, 0) + (pk ? pk.price * n : 0)) * (1 + taxPct / 100));
  const grpOpts = S.groups.filter(g => g.status !== 'cancelled' && (g.id === +r.groupId || (g.arrive <= r.arrive && r.depart <= g.depart)));
  const f = (k, label, cls, extra) => `<label class="${cls || ''}">${label}<input id="r_${k}" value="${esc(r[k] == null ? '' : r[k])}" ${locked ? 'disabled' : ''} ${extra || ''}></label>`;
  const bal = S.bal[r.id] || 0;
  const A = (act, label) => `<a href="#" data-act="${act}">${label}</a>`;
  const listed = !isNew && dnrMatchC(r), dnrAct = isNew || locked && !listed ? '' : listed ? (boss() ? A('dnrRemoveRes', 'Remove from Do Not Rent List') : '') : A('dnrAddRes', 'Add to Do Not Rent List');
  const acts = `<a href="#" data-act="closeModal">${isNew ? 'Cancel' : 'Back'}</a>` + (locked ? '' : `<a href="#" data-act="saveRes">${mode === 'walkin' ? 'Check In Now' : isNew ? 'Book Reservation' : 'Save Changes'}</a>`) + (isNew ? '' : `${A('folio', 'Guest Folio')}${r.status === 'reserved' ? A('checkIn', 'Check In') + A('cancelRes', 'Cancel Reservation') + (r.arrive <= B() ? A('noShow', 'No Show') : '') : ''}${r.status === 'inhouse' ? A('checkOut', 'Check Out') + A('undoCheckIn', 'Undo Check In') : ''}${r.status === 'out' ? A('undoCheckOut', 'Undo Check Out') : ''}${['cancelled', 'noshow'].includes(r.status) ? A('reinstate', 'Reinstate') : ''}${A('printReg', 'Print Registration Card')}${A('printConf', 'Print Confirmation')}${A('emailConf', 'E-mail Confirmation')}${A('viewChanges', 'View Changes')}`) + dnrAct;
  const side = `<aside class="pside"><h3>Overview</h3><dl><dt>Status:</dt><dd class="big">${isNew ? 'New' : { reserved: 'Reserved', inhouse: 'In House', out: 'Checked Out', cancelled: 'Cancelled', noshow: 'No Show' }[r.status]}</dd><dt>Guest Name:</dt><dd>${esc(((r.first || '') + ' ' + (r.last || '')).trim().toUpperCase())}</dd>${r.groupId ? `<dt>Group Master:</dt><dd>${esc((S.groups.find(g => g.id === +r.groupId) || {}).name || '')}</dd>` : ''}<dt>Account Number:</dt><dd>${esc(r.conf || '')}</dd><dt>Balance:</dt><dd>${bal < 0 ? '(' + money(-bal) + ')' : money(bal)}</dd></dl><h3>Actions</h3><div class="alinks">${acts}</div></aside>`;
  return `<div class="mback"><div class="mbox page"><div class="pg"><div class="pgmain">${dnrBanner(r)}<div class="mtitle">${isNew ? (mode === 'walkin' ? 'Walk-In' : 'Create Reservation') : 'Reservation Information: ' + esc(((r.first || '') + ' ' + (r.last || '')).trim().toUpperCase())} ${isNew ? '' : statusBadge(r)}</div>
  <div class="sec">Stay</div><div class="grid">
    <label class="c3">Arrival<input type="date" id="r_arrive" value="${r.arrive}" ${locked || mode === 'walkin' || r.status === 'inhouse' ? 'disabled' : ''}></label>
    <label class="c2">Nights<input type="number" id="r_nights" min="1" max="365" value="${n}" ${locked ? 'disabled' : ''}></label>
    <label class="c3">Departure<input type="date" id="r_depart" value="${r.depart}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Adults<input type="number" id="r_adults" min="1" value="${r.adults || 1}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Children<input type="number" id="r_children" min="0" value="${r.children || 0}" ${locked ? 'disabled' : ''}></label>
    <label>Room type<select id="r_type" ${locked ? 'disabled' : ''}>${types.map(x => `<option value="${esc(x.code)}" ${x.code === r.type ? 'selected' : ''}>${esc(x.code)} · ${esc(x.name)} · ${availOfType(x.code, from, r.depart, r.id, r.groupId)} left · ${money(rateFor(x.code, r.arrive))}</option>`).join('')}</select></label>
    <label>Room<select id="r_room" ${locked ? 'disabled' : ''}><option value="">${mode === 'walkin' ? 'Pick a room' : 'Not assigned yet'}</option>${freeRooms.filter(x => x.type === r.type || x.no === r.room).map(x => `<option value="${esc(x.no)}" ${x.no === r.room ? 'selected' : ''}>${esc(x.no)} · ${esc(x.type)} · ${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(x.no)]}${inRoom(x.no) && inRoom(x.no).id !== r.id ? ' · occupied' : ''}</option>`).join('')}</select></label>
    <label class="c2">Rate / night<input id="r_rate" inputmode="decimal" value="${(nightly[0] / 100).toFixed(2)}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Estimated total<input value="${money(est)}" disabled></label>
    <label>Group<select id="r_groupId" ${locked ? 'disabled' : ''}><option value="0">No group</option>${grpOpts.map(g => `<option value="${g.id}" ${g.id === +r.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <label>Company<select id="r_companyId" ${locked ? 'disabled' : ''}><option value="0">No company</option>${S.companies.filter(c => !c.inactive || c.id === +r.companyId).sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}" ${c.id === +r.companyId ? 'selected' : ''}>${esc(c.name)}${c.directBill ? ' · direct bill' : ''}</option>`).join('')}</select></label>
    <label>Package<select id="r_pkg" ${locked ? 'disabled' : ''}><option value="">No package</option>${(S.config.packages || []).map(k => `<option value="${esc(k.code)}" ${k.code === r.pkg ? 'selected' : ''}>${esc(k.name)} · ${money(k.price)} / night</option>`).join('')}</select></label></div>
  <p class="hint" style="margin:6px 0 0">${manual ? `Rate typed by hand: ${money(r.rate)} every night. <a href="#" data-act="rateStd">Use the standard rate</a>` : varies ? 'The rate changes by night: ' + nightly.map((v, i) => dshort(addDays(r.arrive, i)).replace(/\/\d+$/, '') + ' ' + money(v)).join(', ') + '. Type a rate to charge one rate every night.' : 'Standard rate. Type a different rate to override it.'}</p>
  <div class="sec">Guest ${locked ? '' : '<button class="btn sm" data-act="scanId" style="float:right;margin-top:-8px">Scan ID</button>'}</div><div class="grid">${f('last', 'Last name *', '', 'maxlength="60"')}${f('first', 'First name', '', 'maxlength="60"')}${f('phone', 'Phone', '', 'maxlength="30" inputmode="tel"')}${f('email', 'E-mail', 'c8', 'maxlength="100"')}
    ${f('addr1', 'Address', 'c6', 'maxlength="100"')}${f('city', 'City', 'c3', 'maxlength="60"')}${f('state', 'State', 'c2', 'maxlength="30"')}${f('zip', 'Postal code', 'c2', 'maxlength="15"')}${f('guestId', 'Guest ID (license #)', '', 'maxlength="40"')}${f('vehicle', 'Vehicle / plate', '', 'maxlength="40"')}</div>
  <div class="sec">Payment and notes</div><div class="grid">
    <label>Guarantee<select id="r_guarantee" ${locked ? 'disabled' : ''}>${['Credit card', 'Cash deposit', 'Direct bill', '6 PM hold (no guarantee)'].map(x => `<option ${r.guarantee === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="c3">Pays with<select id="r_payType" ${locked ? 'disabled' : ''}>${['', 'Card', 'Cash', 'Check', 'Direct bill'].map(x => `<option ${r.payType === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="c3">Card type<select id="r_cardType" ${locked ? 'disabled' : ''}>${['', 'Visa', 'MC', 'Amex', 'Discover'].map(x => `<option ${r.cardType === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="c2">Card last 4<input id="r_cardLast4" maxlength="4" inputmode="numeric" value="${esc(r.cardLast4 || '')}" ${locked ? 'disabled' : ''}></label>
    <label>Source<select id="r_source" ${locked ? 'disabled' : ''}>${['Phone', 'Walk-In', 'Website', 'Travel agent', 'Company', 'Other'].map(x => `<option ${r.source === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="chk c2"><input type="checkbox" id="r_taxExempt" ${r.taxExempt ? 'checked' : ''} ${locked ? 'disabled' : ''}>Tax exempt</label><label class="chk c2"><input type="checkbox" id="r_vip" ${r.vip ? 'checked' : ''} ${locked ? 'disabled' : ''}>VIP</label><label class="chk c2"><input type="checkbox" id="r_noPost" ${r.noPost ? 'checked' : ''} ${locked ? 'disabled' : ''}>No room charge</label>
    ${[['crib', 'Crib'], ['rollaway', 'Rollaway'], ['suppressRate', 'Suppress Rate']].map(([k, l]) => `<label class="chk c2"><input type="checkbox" id="r_${k}" ${r[k] ? 'checked' : ''} ${locked ? 'disabled' : ''}>${l}</label>`).join('')}
    <label class="c6">Special requests<input id="r_requests" maxlength="300" value="${esc(r.requests || '')}" ${locked ? 'disabled' : ''}></label><label class="c6">Notes<input id="r_notes" maxlength="1000" value="${esc(r.notes || '')}" ${locked ? 'disabled' : ''}></label></div>
  <p class="hint" style="margin:10px 0 0">Card numbers are never saved here, only the card type and last 4 digits. Run the card on your card terminal.</p>
  <div class="err" id="r_err"></div>
  <div class="mfoot"><button class="btn" data-act="closeModal">${locked ? 'Close' : 'Cancel'}</button>${locked ? '' : `<button class="btn ${mode === 'walkin' ? 'teal' : 'green'}" data-act="saveRes">${mode === 'walkin' ? 'Check In Now' : isNew ? 'Book Reservation' : 'Save Changes'}</button>`}</div></div>${side}</div></div></div>`;
}
function readForm() {
  const r = ED.r, el = k => $('#r_' + k);   // only the fields on the screen are read; the rest keep their values
  for (const k of ['last', 'first', 'phone', 'email', 'addr1', 'addr2', 'country', 'city', 'state', 'zip', 'guestId', 'vehicle', 'guarantee', 'payType', 'cardType', 'cardLast4', 'source', 'requests', 'notes', 'arrive', 'depart', 'type', 'room']) if (el(k)) r[k] = el(k).value;
  if (el('adults')) r.adults = +el('adults').value || 1; if (el('children')) r.children = +el('children').value || 0;
  if (el('groupId')) r.groupId = +el('groupId').value || 0; if (el('companyId')) r.companyId = +el('companyId').value || 0; if (el('pkg')) r.pkg = el('pkg').value || '';
  if (el('rate') && r.rateManual) { const c = toCents(el('rate').value); if (isNaN(c)) r.rateManual = false; else r.rate = c; }
  for (const k of ['taxExempt', 'vip', 'noPost', 'crib', 'rollaway', 'suppressRate']) if (el(k)) r[k] = el(k).checked;
}
let drawing = false;   // replacing the window can fire a field's "change" again; ignore that second call
function drawRes() {
  if (drawing) return; drawing = true;
  try { $('#modal').innerHTML = ED.mode === 'edit' ? resForm(ED.r, ED.mode) : wizForm(); } finally { drawing = false; }
  if (ED.mode !== 'edit' && ED.step === 3 && $('#r_last') && !$('#r_last').value) $('#r_last').focus();
}
async function openRes(id) { let r = S.res.find(x => x.id === +id); if (!r) { const f = await api('/folio?id=' + id); r = f.res; S.bal[r.id] = f.balance; } ED = { mode: 'edit', r: JSON.parse(JSON.stringify(r)) }; drawRes(); }

/* ---------- Do Not Rent: does this guest match a list entry? (guest ID letters and digits, or last AND first name) ---------- */
function dnrMatchC(r) {
  const idn = x => String(x || '').replace(/[^a-z0-9]/gi, '').toLowerCase(), nm = x => String(x || '').trim().toLowerCase();
  return (S.dnr || []).find(e => (idn(e.guestId) && idn(e.guestId) === idn(r.guestId)) || (nm(e.last) && nm(e.first) && nm(e.last) === nm(r.last) && nm(e.first) === nm(r.first))) || null;
}
const dnrBanHtml = r => { const e = dnrMatchC(r); return e ? 'DO NOT RENT: ' + esc(e.reason) : ''; };
const dnrBanner = r => `<div class="dnrban" id="dnrBan" ${dnrMatchC(r) ? '' : 'hidden'}>${dnrBanHtml(r)}</div>`;
function dnrBanUpdate() {   // follows what is typed, without redrawing the page
  const b = $('#dnrBan'); if (!b || !ED) return; const v = k => { const el = $('#r_' + k); return el ? el.value : ED.r[k]; };
  const t = { last: v('last'), first: v('first'), guestId: v('guestId') }; b.innerHTML = dnrBanHtml(t); b.hidden = !dnrMatchC(t);
}
const dnrDate = e => { const d = e.bdate || new Date(e.at).toISOString().slice(0, 10); return +d.slice(5, 7) + '/' + +d.slice(8, 10) + '/' + d.slice(0, 4); };

/* ---------- New reservation and Walk-In: a wizard in four steps (ED.step 1 to 4) ---------- */
function stayCalc(r, type) {   // nights, nightly rates and the estimated total for a stay; `type` tries another room type
  const n = Math.max(0, nights(r.arrive, r.depart)), taxPct = r.taxExempt ? 0 : S.config.taxes.filter(x => ((S.config.codes.find(k => k.code === 'RM') || {}).tax || []).includes(x.code)).reduce((s, x) => s + x.pct, 0);
  const r2 = { ...r, type: type || r.type }, std = r.arrive < r.depart ? quote(r2) : [rateFor(r2.type, r.arrive)], manual = !!r.rateManual && r.rate != null, nightly = manual ? std.map(() => r.rate) : std;
  const pk = r.pkg && (S.config.packages || []).find(x => x.code === r.pkg);
  return { n, nightly, manual, pk, varies: new Set(nightly).size > 1, est: Math.round((nightly.reduce((a, b) => a + b, 0) + (pk ? pk.price * n : 0)) * (1 + taxPct / 100)) };
}
const rateHint = (r, c) => c.manual ? `Rate typed by hand: ${money(r.rate)} every night.` : c.varies ? 'The rate changes by night: ' + c.nightly.map((v, i) => dshort(addDays(r.arrive, i)).replace(/\/\d+$/, '') + ' ' + money(v)).join(', ') + '. Type a rate to charge one rate every night.' : 'Standard rate. Type a different rate to override it.';
const grpOptHtml = r => `<option value="0">No group</option>` + S.groups.filter(g => g.status !== 'cancelled' && (g.id === +r.groupId || (g.arrive <= r.arrive && r.depart <= g.depart))).map(g => `<option value="${g.id}" ${g.id === +r.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
function startWiz(mode, r, chosen) { ED = { mode, step: 1, r, hi: chosen ? r.type : '', gs: [], gsq: '', gsby: 'name', gsDone: false }; drawRes(); }
function openNew(mode, room, date) {
  const rm = S.config.rooms.find(x => x.no === room), arrive = mode === 'walkin' ? B() : (date || B());
  startWiz(mode, { id: 0, status: 'reserved', arrive, depart: addDays(arrive, 1), type: rm ? rm.type : S.config.types[0].code, room: room || '', adults: 1, children: 0, rate: null, country: 'United States', guarantee: mode === 'walkin' ? 'Cash deposit' : 'Credit card', source: mode === 'walkin' ? 'Walk-In' : 'Phone' }, !!rm);
}
function wizSide(step) {
  const r = ED.r, c = stayCalc(r), tp = S.config.types.find(t => t.code === r.type), co = r.companyId && S.companies.find(x => x.id === +r.companyId), g = r.groupId && S.groups.find(x => x.id === +r.groupId);
  const blk = (n, title, st, rows) => `<div class="wzb"><span class="wzn">${n}</span><b>${title}</b><button class="btn sm blue" data-act="wizGo" data-step="${st}">EDIT</button></div><dl>${rows.map(x => `<dt>${x[0]}:</dt><dd${x[2] ? ` id="${x[2]}"` : ''}>${x[1]}</dd>`).join('')}</dl>`;
  const b1 = blk(1, 'Stay Info', 1, [['Arrival', dshort(r.arrive)], ['Nights', c.n], ['Departure', dshort(r.depart)], ['Rooms', 1], ['Adults', r.adults || 1], ['Children', r.children || 0], ['Rate Plan', c.pk ? esc(c.pk.name) : 'BAR'], ['Company', esc(co ? co.name : '') || 'None'], ['Group', esc(g ? g.name : '') || 'None']]);
  const b2 = blk(2, 'Room &amp; Rate Info', 2, [['Room Type', esc(r.type) + (tp ? ' · ' + esc(tp.name) : '')], ['Rate', money(c.nightly[0] || 0) + (c.varies ? ' <span class="hint">varies</span>' : '')], ['Estimated Total Cost', money(c.est), 'wzEst'], ['Assigned Room', esc(r.room) || 'Not assigned']]);
  const b3 = blk(3, 'Guest Info', 3, [['Name', esc(gname(r)) || '-'], ['Phone', esc(r.phone) || '-'], ['City / State', esc([r.city, r.state].filter(Boolean).join(', ')) || '-']]);
  return b1 + (step >= 3 ? b2 : '') + (step >= 4 ? b3 : '');
}
function gsHtml() {
  if (!ED.gsDone) return '';
  return ED.gs.length ? ED.gs.map((g, i) => `<a href="#" class="gsrow" data-act="guestPick" data-i="${i}"><b>${esc(gname(g))}</b><span>${esc([g.city, g.state].filter(Boolean).join(', '))}${g.phone ? ' · ' + esc(g.phone) : ''}</span></a>`).join('') : '<div class="hint">No past guests found.</div>';
}
function wizForm() {
  const r = ED.r, step = ED.step, walk = ED.mode === 'walkin', c = stayCalc(r, step === 2 ? (ED.hi || r.type) : null);
  const titles = ['Stay Information', 'Room & Rate', 'Guest Information', 'Payment Information'];
  const track = `<div class="wztrack"><b>${walk ? 'Walk-In' : 'New Reservation'}</b>` + ['Stay', 'Room & Rate', 'Guest', 'Payment'].map((x, i) => `<span class="${i + 1 === step ? 'on' : ''}">${i + 1} ${esc(x)}</span>`).join('') + '</div>';
  const F = (k, label, extra) => `<label for="r_${k}">${label}</label><input id="r_${k}" value="${esc(r[k] == null ? '' : r[k])}" ${extra || ''}>`;
  const CK = (k, label) => `<label for="r_${k}">${label}</label><input type="checkbox" id="r_${k}" ${r[k] ? 'checked' : ''}>`;
  const SEL = (k, label, list) => `<label for="r_${k}">${label}</label><select id="r_${k}">${list.map(x => `<option ${r[k] === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  let main = '', side = '';
  if (step === 1) {
    const n = nights(r.arrive, r.depart);
    main = `<p class="hint wzreq">*Required</p><div class="wzf">
      <label for="r_arrive">*Arrival</label><input type="date" id="r_arrive" value="${esc(r.arrive)}" ${walk ? 'disabled' : ''}>
      <label for="r_nights">*Nights</label><input type="number" id="r_nights" min="1" max="365" value="${n > 0 ? n : ''}">
      <label for="r_depart">*Departure</label><input type="date" id="r_depart" value="${esc(r.depart)}">
      <label for="wz_rooms">*Rooms</label><input id="wz_rooms" value="1" disabled>
      <label for="r_adults">*Adults</label><input type="number" id="r_adults" min="1" value="${r.adults || 1}">
      <label for="r_children">Children</label><input type="number" id="r_children" min="0" value="${r.children || 0}">
      <label for="r_companyId">Company Profile Name</label><select id="r_companyId"><option value="0"></option>${S.companies.filter(x => !x.inactive || x.id === +r.companyId).sort((a, b) => a.name.localeCompare(b.name)).map(x => `<option value="${x.id}" ${x.id === +r.companyId ? 'selected' : ''}>${esc(x.name)}${x.directBill ? ' · direct bill' : ''}</option>`).join('')}</select>
      <label for="r_groupId">Pickup Group</label><select id="r_groupId">${grpOptHtml(r)}</select>
      <label>Rate Plan</label><div class="wzrp">BAR · Best Available Rate</div>
      <label for="r_pkg">Package</label><select id="r_pkg"><option value="">No package</option>${(S.config.packages || []).map(k => `<option value="${esc(k.code)}" ${k.code === r.pkg ? 'selected' : ''}>${esc(k.name)} · ${money(k.price)} / night</option>`).join('')}</select></div>
      <div class="err" id="r_err"></div><button class="btn blue wzbtn" data-act="wizNext">SEARCH AVAILABILITY</button>`;
    side = `<h3>Guest Search</h3><div class="wzgs"><label for="gs_by">Search Guest By:</label><select id="gs_by"><option value="name" ${ED.gsby === 'name' ? 'selected' : ''}>Name</option><option value="phone" ${ED.gsby === 'phone' ? 'selected' : ''}>Phone</option></select><input id="gs_q" value="${esc(ED.gsq)}" autocomplete="off" aria-label="Guest search"><button class="btn blue" data-act="guestFind">FIND GUEST</button><div id="gs_res">${gsHtml()}</div></div>`;
  } else if (step === 2) {
    const hi = ED.hi, from = r.arrive, rooms = hi ? S.config.rooms.filter(x => x.type === hi && (x.no === r.room || roomFree(x.no, from, r.depart, 0))) : [];
    main = `<div class="wrap"><table class="wzt"><tr><th>Type</th><th>Description</th><th class="num">Available</th><th class="num">Rate</th><th class="num">Estimated Total</th><th></th></tr>${S.config.types.map(t => { const av = Math.max(0, availOfType(t.code, from, r.depart, 0, r.groupId)), q = stayCalc({ ...r, rateManual: false }, t.code); return `<tr class="click ${t.code === hi ? 'hi' : ''}" data-act="wizHi" data-type="${esc(t.code)}"><td><b>${esc(t.code)}</b></td><td>${esc(t.name)}</td><td class="num">${av}</td><td class="num">${money(q.nightly[0] || 0)}${q.varies ? ' <span class="hint">varies</span>' : ''}</td><td class="num">${money(q.est)}</td><td class="num"><button class="btn sm blue" data-act="wizType" data-type="${esc(t.code)}" ${av < 1 ? 'disabled' : ''}>SELECT</button></td></tr>`; }).join('')}</table></div>
      <p class="hint" style="margin:6px 0 0">Estimated Total is the room nights${c.pk ? ' and the package' : ''} plus tax. ${walk ? 'For a walk-in, click a room type, pick the room below, then SELECT.' : 'Click a row to see its rooms below.'}</p>
      <div class="wzf" style="margin-top:12px"><label for="r_room">Assigned Room:</label><select id="r_room" ${hi ? '' : 'disabled'}><option value="">${hi ? (walk ? 'Pick a room' : 'Not assigned yet') : 'Click a room type above'}</option>${rooms.map(x => `<option value="${esc(x.no)}" ${x.no === r.room ? 'selected' : ''}>${esc(x.no)} · ${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(x.no)]}${inRoom(x.no) && inRoom(x.no).id !== r.id ? ' · occupied' : ''}</option>`).join('')}</select>
      <label for="r_rate">Rate / night</label><input id="r_rate" inputmode="decimal" value="${((c.nightly[0] || 0) / 100).toFixed(2)}"></div>
      <p class="hint" style="margin:6px 0 0"><span id="rateHint">${rateHint(r, c)}</span> <a href="#" data-act="rateStd" id="rateLink" ${c.manual ? '' : 'hidden'}>Use the standard rate</a></p><div class="err" id="r_err"></div>${hi ? '<button class="btn blue wzbtn" data-act="wizNext">CONTINUE</button>' : ''}`;
    side = wizSide(2);
  } else if (step === 3) {
    main = `<div class="wz3"><div class="wzcol"><div class="wzf cmp">${F('last', '*Last Name', 'maxlength="60"')}${F('first', 'First Name', 'maxlength="60"')}${F('addr1', 'Address 1', 'maxlength="100"')}${F('addr2', 'Address 2', 'maxlength="100"')}${F('country', 'Country', 'maxlength="40"')}${F('zip', 'Postal Code', 'maxlength="15"')}${F('city', 'City', 'maxlength="60"')}${F('state', 'State', 'maxlength="30"')}${F('phone', 'Phone', 'maxlength="30" inputmode="tel"')}${F('email', 'E-mail', 'maxlength="100"')}${F('guestId', 'Guest ID', 'maxlength="40"')}${CK('taxExempt', 'Tax Exempt')}${F('vehicle', 'Vehicle ID', 'maxlength="40"')}${CK('vip', 'VIP')}</div>
      <div class="err" id="r_err"></div><button class="btn blue wzbtn" data-act="wizNext">CONTINUE</button></div>
      <div class="wzcol"><h3>Notes and Special Requests</h3><div class="wzf cmp">${CK('crib', 'Crib')}${CK('rollaway', 'Rollaway')}${CK('suppressRate', 'Suppress Rate')}${CK('noPost', 'No room charge')}${F('requests', 'Special requests', 'maxlength="300"')}${F('notes', 'Notes', 'maxlength="1000"')}</div><button class="btn wzbtn" data-act="scanId">SCAN ID</button></div></div>`;
    side = wizSide(3);
  } else {
    main = `<div class="wzf">${SEL('guarantee', 'Guarantee', ['Credit card', 'Cash deposit', 'Direct bill', '6 PM hold (no guarantee)'])}${SEL('payType', 'Pays with', ['', 'Card', 'Cash', 'Check', 'Direct bill'])}${SEL('cardType', 'Card type', ['', 'Visa', 'MC', 'Amex', 'Discover'])}
      <label for="r_cardLast4">Card last 4</label><input id="r_cardLast4" maxlength="4" inputmode="numeric" value="${esc(r.cardLast4 || '')}">${SEL('source', 'Source', ['Phone', 'Walk-In', 'Website', 'Travel agent', 'Company', 'Other'])}</div>
      <p class="hint" style="margin:10px 0 0">Card numbers are never saved here, only the card type and last 4 digits. Run the card on your card terminal.</p><div class="err" id="r_err"></div>
      <button class="btn blue wzbtn" data-act="saveRes">${walk ? 'CHECK IN NOW' : 'BOOK RESERVATION'}</button>`;
    side = wizSide(4);
  }
  return `<div class="mback"><div class="mbox page"><div class="pg"><div class="pgmain wz">${step >= 3 ? dnrBanner(r) : ''}<div class="mtitle">${titles[step - 1]}</div>${track}${main}</div><aside class="pside wz">${side}<h3>Actions</h3><div class="alinks"><a href="#" data-act="closeModal">Cancel</a></div></aside></div></div></div>`;
}
const wizErr = m => { const e = $('#r_err'); if (e) e.textContent = m; return false; };
function wizNext() {
  readForm(); const r = ED.r, okD = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d + 'T00:00:00Z'));
  if (ED.step === 1) {
    if (!okD(r.arrive) || !okD(r.depart) || r.depart <= r.arrive) return wizErr('Check the dates: the departure must be after the arrival.');
    if (r.arrive < B()) return wizErr('The arrival date is before today\'s business date (' + dshort(B()) + ').');
    if (nights(r.arrive, r.depart) > 365) return wizErr('A stay can be at most 365 nights.');
    if (r.room && !roomFree(r.room, r.arrive, r.depart, 0)) r.room = '';
    ED.step = 2;
  } else if (ED.step === 2) {
    const type = ED.hi; if (!type) return wizErr('Pick a room type: click SELECT on a row.');
    const rm = r.room && S.config.rooms.find(x => x.no === r.room); if (rm && rm.type !== type) r.room = '';
    if (!r.room && availOfType(type, r.arrive, r.depart, 0, r.groupId) < 1) return wizErr('No ' + type + ' rooms are left for those dates. Pick another room type.');
    r.type = type; ED.step = 3;
  } else if (ED.step === 3) {
    if (!String(r.last || '').trim()) return wizErr('Type the guest\'s last name.');
    ED.step = 4;
  }
  drawRes();
}
async function guestFind() {
  const by = $('#gs_by').value, raw = $('#gs_q').value.trim(); ED.gsby = by; ED.gsq = raw; const q = by === 'phone' ? raw.replace(/\D/g, '') : raw;
  if (q.length < (by === 'phone' ? 3 : 2)) { ED.gs = []; ED.gsDone = false; $('#gs_res').innerHTML = `<div class="hint">Type at least ${by === 'phone' ? '3 digits of the phone number' : '2 letters of the name'}.</div>`; return; }
  const found = (await api('/find?q=' + encodeURIComponent(q))).list, seen = new Set(), out = [];
  for (const g of found) { const key = [g.last, g.first, g.phone, g.city].join('|').toLowerCase(); if (!seen.has(key)) { seen.add(key); out.push(g); } }
  if (!ED) return; ED.gs = out.slice(0, 8); ED.gsDone = true; $('#gs_res').innerHTML = gsHtml();
}
function guestPick(i) {
  const g = ED.gs[+i]; if (!g) return; readForm();
  for (const k of ['last', 'first', 'addr1', 'addr2', 'country', 'zip', 'city', 'state', 'phone', 'email', 'guestId', 'vehicle']) if (g[k]) ED.r[k] = g[k];
  if (g.companyId && S.companies.some(c => c.id === +g.companyId && !c.inactive)) ED.r.companyId = +g.companyId;
  drawRes(); toast('Guest details copied. The dates were not changed.');
}
function wizChanged(id) {   // typing in the wizard never redraws the page, so a click on the next button is never lost
  const r = ED.r, oldN = nights(r.arrive, r.depart); readForm();
  if (id === 'r_nights') r.depart = addDays(r.arrive, Math.max(1, +$('#r_nights').value || 1));
  if (id === 'r_arrive' && r.arrive) r.depart = addDays(r.arrive, Math.max(1, oldN));
  if (id === 'r_rate') { const c = toCents($('#r_rate').value); r.rateManual = !isNaN(c); if (r.rateManual) r.rate = c; const c2 = stayCalc(r, ED.hi || r.type), h = $('#rateHint'); if (h) { h.textContent = rateHint(r, c2); $('#rateLink').hidden = !c2.manual; } }
  if (ED.step === 1 && ['r_nights', 'r_arrive', 'r_depart'].includes(id)) { const n = nights(r.arrive, r.depart); $('#r_nights').value = n > 0 ? n : ''; $('#r_depart').value = r.depart; if (!(r.arrive < r.depart) || !S.groups.some(g => g.id === +r.groupId && g.arrive <= r.arrive && r.depart <= g.depart)) r.groupId = 0; $('#r_groupId').innerHTML = grpOptHtml(r); }
  if (ED.step === 3 && id === 'r_taxExempt') { const e = $('#wzEst'); if (e) e.textContent = money(stayCalc(r).est); }
}
function resFieldChanged(id) {
  if (!ED || !/^r_/.test(id)) return; if (ED.mode !== 'edit') return wizChanged(id);
  const r = ED.r, old = { type: r.type, a: r.arrive, d: r.depart }; const oldN = nights(r.arrive, r.depart); readForm();
  if (id === 'r_nights') r.depart = addDays(r.arrive, Math.max(1, +$('#r_nights').value || 1));
  if (id === 'r_arrive' && r.arrive) r.depart = addDays(r.arrive, oldN);
  if (id === 'r_rate') { const c = toCents($('#r_rate').value); r.rateManual = !isNaN(c); if (r.rateManual) r.rate = c; }
  if (id === 'r_type') r.room = '';
  if (['r_nights', 'r_arrive', 'r_depart', 'r_type', 'r_taxExempt', 'r_rate', 'r_room', 'r_groupId', 'r_companyId', 'r_pkg'].includes(id)) { if (r.room && !(r.arrive < r.depart && (roomFree(r.room, r.status === 'inhouse' && B() > r.arrive ? B() : r.arrive, r.depart, r.id)))) r.room = ''; drawRes(); }
}
async function saveRes() {
  readForm(); const r = ED.r, wiz = ED.mode !== 'edit';
  if (wiz) {
    if (!String(r.last || '').trim()) return wizErr('Type the guest\'s last name (click EDIT beside Guest Info).');
    if (!(r.arrive < r.depart)) return wizErr('Check the dates: the departure must be after the arrival.');
    if (ED.mode === 'walkin' && !r.room) return wizErr('Pick a room for the walk-in: click EDIT beside Room & Rate Info.');
  }
  const a = { ...r, rateManual: !!r.rateManual }; delete a.status; delete a.history; delete a.rates; if (!a.rateManual) delete a.rate;
  const flags = {}, go = () => ED.mode === 'walkin' ? op('walkIn', { ...a, ...flags }) : op('resSave', { ...a, ...flags });
  try {
    let res;
    for (;;) {   // the server may ask first: dirty room (412), Do Not Rent guest (428). OK tries again with the answer; Cancel stays on the form.
      try { res = await go(); break; } catch (e) { if (e.status === 412 && !flags.dirtyOk && confirm(e.message)) flags.dirtyOk = true; else if (e.status === 428 && !flags.dnrOk && confirm(e.message)) flags.dnrOk = true; else throw e; }
    }
    $('#modal').innerHTML = ''; ED = null; await refresh(); toast(r.id ? 'Saved.' : (res.conf ? 'Booked. Confirmation # ' + res.conf : 'Saved.'));
  } catch (e) { const el = $('#r_err'); if (el) el.textContent = e.message; }
}
async function resAction(act) {
  const r = ED.r, done = async msg => { await refresh(); toast(msg); const fresh = S.res.find(x => x.id === r.id); if (fresh) { ED.r = JSON.parse(JSON.stringify(fresh)); drawRes(); } else { $('#modal').innerHTML = ''; ED = null; } };
  try {
    if (act === 'checkIn') { readForm(); if (!r.room) throw new Error('Pick a room first.'); await op('resSave', (({ status, history, rates, ...a }) => { a.rateManual = !!a.rateManual; if (!a.rateManual) delete a.rate; return a; })(r)); const fl = {}; for (;;) { try { await op('checkIn', { id: r.id, ...fl }); break; } catch (e) { if (e.status === 412 && !fl.dirtyOk && confirm(e.message)) fl.dirtyOk = true; else if (e.status === 428 && !fl.dnrOk && confirm(e.message)) fl.dnrOk = true; else throw e; } } await done('Checked in to room ' + r.room + '.'); }
    else if (act === 'checkOut') { try { await op('checkOut', { id: r.id }); } catch (e) { if (e.status === 412 && boss() && confirm(e.message + '\n\nCheck out anyway and leave the balance on the folio?')) await op('checkOut', { id: r.id, force: true }); else if (e.status === 412) { toast(e.message, true); return openFolio(r.id); } else throw e; } await done('Checked out.'); }
    else if (act === 'undoCheckIn') { if (confirm('Undo the check-in for ' + gname(r) + '?')) { await op('undoCheckIn', { id: r.id }); await done('Check-in undone.'); } }
    else if (act === 'undoCheckOut') { await op('undoCheckOut', { id: r.id }); await done('Guest is back in house.'); }
    else if (act === 'cancelRes') { const why = prompt('Cancel the reservation for ' + gname(r) + '?\nReason (optional):', ''); if (why !== null) { const x = await op('cancel', { id: r.id, reason: why }); await done('Cancelled. Cancellation # ' + x.cxlNo); } }
    else if (act === 'noShow') { if (confirm('Mark ' + gname(r) + ' as a no show?')) { await op('noShow', { id: r.id }); await done('Marked as a no show.'); } }
    else if (act === 'reinstate') { await op('reinstate', { id: r.id }); await done('Reinstated.'); }
    else if (act === 'folio') openFolio(r.id);
    else if (act === 'viewChanges') { const x = await op('history', { id: r.id }); $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="hist"><div class="mbox"><div class="mtitle">Changes: ${esc(gname(r))}</div><div class="wrap"><table><tr><th>When</th><th>Who</th><th>What</th></tr>${x.history.map(h => `<tr><td>${stamp(h.at)}</td><td>${esc(h.by)}</td><td>${esc(h.what)}</td></tr>`).join('')}</table></div><div class="mfoot"><button class="btn" data-act="closeHist">Close</button></div></div></div>`); }
    else if (act === 'emailConf') { const to = prompt('Send the confirmation to this e-mail address:', r.email || ''); if (to) { const x = await op('emailConf', { id: r.id, to }); toast('Confirmation e-mailed to ' + x.to + '.'); } }
    else if (act === 'printReg') printReg(r); else if (act === 'printConf') printConf(r);
  } catch (e) { toast(e.message, true); }
}

/* ---------- Folio ---------- */
let FO = null;
async function openFolio(id) { await run(async () => { FO = await api('/folio?id=' + id); drawFolio(); }); }
function folioTable(f) { return `<table><tr><th>Item #</th><th>Date</th><th>Posted</th><th>Description</th><th>Comments</th><th>By</th><th class="num">Amount</th></tr>${f.lines.map(l => `<tr><td>${l.id}</td><td>${dshort(l.bdate)}</td><td>${stamp(l.at)}</td><td>${esc(l.descr)}</td><td>${esc(l.comment)}</td><td>${esc(l.user)}</td><td class="num">${l.amount < 0 ? '(' + money(-l.amount) + ')' : money(l.amount)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing is posted yet.</td></tr>'}<tr><td colspan="6" class="num"><b>Balance</b></td><td class="num"><b>${f.balance < 0 ? '(' + money(-f.balance) + ')' : money(f.balance)}</b></td></tr></table>`; }
function drawFolio() {
  const r = FO.res, b = FO.balance, L = (act, label, x) => `<a href="#" data-act="${act}" ${x || ''}>${label}</a>`;
  $('#modal').innerHTML = `<div class="mback"><div class="mbox page"><div class="pg"><div class="pgmain"><div class="mtitle">Guest Folio ${statusBadge(r)} <span class="hint">${dshort(r.arrive)} to ${dshort(r.depart)}</span></div>
    <div id="postBox"></div><div class="hint" style="margin-bottom:6px">Viewing Lines 1 through ${FO.lines.length} of ${FO.lines.length}</div><div class="wrap" style="max-height:66vh">${folioTable(FO)}</div></div>
    <aside class="pside"><h3>Overview</h3><dl><dt>Guest Status:</dt><dd class="big">${{ reserved: 'Reserved', inhouse: 'In House', out: 'Checked Out', cancelled: 'Cancelled', noshow: 'No Show' }[r.status]}</dd><dt>First Name:</dt><dd>${esc((r.first || '').toUpperCase())}</dd><dt>Last Name:</dt><dd>${esc((r.last || '').toUpperCase())}</dd><dt>Account #:</dt><dd>${esc(r.conf)}</dd><dt>Room #:</dt><dd>${esc(r.room || '')}</dd><dt>Balance:</dt><dd>${b < 0 ? '(' + money(-b) + ')' : money(b)}</dd></dl>
    <h3>Actions</h3><div class="alinks">${L('folioBack', 'Back')}${L('postOpen', 'Post Charge', 'data-kind="charge"')}${L('postOpen', 'Post Payment', 'data-kind="payment"')}${L('postOpen', 'Post Adjustment', 'data-kind="adjust"')}${L('printFolio', 'Print')}${L('emailFolio', 'Email Folio')}${r.status === 'inhouse' ? L('folioCheckOut', 'Check Out') : ''}${L('closeModal', 'Close')}</div></aside></div></div></div>`;
}
function postOpen(kind) {
  const pay = ['CASH', 'CRED', 'AREC', 'GFTCRD'], codes = S.config.codes.filter(k => kind === 'payment' ? pay.includes(k.type) : !pay.includes(k.type) && k.type !== 'ADMIN');
  const bal = FO.balance;
  $('#postBox').innerHTML = `<div class="card" style="margin-bottom:10px"><b>${{ charge: 'Post a charge', payment: 'Post a payment', adjust: 'Post an adjustment (takes a charge off)' }[kind]}</b><div class="grid" style="margin-top:8px">
    <label>${kind === 'payment' ? 'Payment type' : 'Charge'}<select id="p_code">${codes.map(k => `<option value="${esc(k.code)}">${esc(k.name)}</option>`).join('')}</select></label>
    <label class="c3">Amount<input id="p_amt" inputmode="decimal" value="${kind === 'payment' && bal > 0 ? (bal / 100).toFixed(2) : ''}"></label>
    ${kind === 'payment' ? '<label class="c2">Card last 4<input id="p_last4" maxlength="4" inputmode="numeric"></label>' : ''}
    <label class="${kind === 'payment' ? 'c3' : 'c6'}">${kind === 'adjust' ? 'Reason *' : 'Comment'}<input id="p_note" maxlength="150"></label></div>
    <p class="hint" style="margin:8px 0 0">${kind === 'charge' ? 'Taxes are added automatically.' : kind === 'adjust' ? 'The taxes on that amount come off too.' : 'Run the card on your terminal first. "Guest Refund" and "Cash Paid Out" give money back.'}</p>
    <div class="mfoot" style="margin-top:8px"><button class="btn sm" data-act="postCancel">Cancel</button><button class="btn sm green" data-act="postSave" data-kind="${kind}">Post</button></div></div>`;
  $('#p_amt').focus();
}
async function postSave(kind) {
  await run(async () => { const amount = toCents($('#p_amt').value); if (!(amount > 0)) throw new Error('Type an amount above zero.'); await op('post', { res: FO.res.id, kind, code: $('#p_code').value, amount, comment: $('#p_note').value, last4: $('#p_last4') ? $('#p_last4').value : '' }); FO = await api('/folio?id=' + FO.res.id); drawFolio(); refresh(); toast('Posted.'); });
}

/* ---------- printing ---------- */
function printHtml(html) { $('#print').innerHTML = html; window.print(); }
const letterHead = () => `<h1>${esc(S.config.name)}</h1><div>${esc(S.config.address)}${S.config.phone ? ' · ' + esc(S.config.phone) : ''}</div><hr>`;
function printReg(r) { printHtml(letterHead() + `<h2>Guest Registration</h2><table><tr><td><b>Guest</b></td><td>${esc(gname(r))}</td><td><b>Conf. #</b></td><td>${esc(r.conf)}</td></tr><tr><td><b>Address</b></td><td>${esc([r.addr1, r.city, r.state, r.zip].filter(Boolean).join(', '))}</td><td><b>Phone</b></td><td>${esc(r.phone)}</td></tr><tr><td><b>Arrival</b></td><td>${dlong(r.arrive)}</td><td><b>Departure</b></td><td>${dlong(r.depart)}</td></tr><tr><td><b>Room</b></td><td>${esc(r.room || '')} (${esc(r.type)})</td><td><b>Rate</b></td><td>${r.suppressRate ? 'on file' : money(r.rate) + ' plus tax, per night'}</td></tr><tr><td><b>Guests</b></td><td>${r.adults} adults, ${r.children} children</td><td><b>Vehicle</b></td><td>${esc(r.vehicle)}</td></tr><tr><td><b>Company</b></td><td>${esc(r.company)}</td><td><b>E-mail</b></td><td>${esc(r.email)}</td></tr></table><p>Check-out time is ${esc(S.config.checkoutTime)}.</p><p>${esc(S.config.regText)}</p><p style="margin-top:40px">Guest signature: ______________________________________ &nbsp; Date: ______________</p>`); }
function printConf(r) { printHtml(letterHead() + `<h2>Reservation Confirmation</h2><p>Dear ${esc(r.first || '')} ${esc(r.last)},</p><p>Thank you for choosing ${esc(S.config.name)}. Your reservation is confirmed.</p><table><tr><td><b>Confirmation #</b></td><td>${esc(r.conf)}</td></tr><tr><td><b>Arrival</b></td><td>${dlong(r.arrive)} (check-in from ${esc(S.config.checkinTime)})</td></tr><tr><td><b>Departure</b></td><td>${dlong(r.depart)} (check-out by ${esc(S.config.checkoutTime)})</td></tr><tr><td><b>Room type</b></td><td>${esc((S.config.types.find(t => t.code === r.type) || {}).name || r.type)}</td></tr><tr><td><b>Guests</b></td><td>${r.adults} adults, ${r.children} children</td></tr><tr><td><b>Rate</b></td><td>${r.suppressRate ? 'on file' : money(r.rate) + ' plus tax, per night'}</td></tr><tr><td><b>Guarantee</b></td><td>${esc(r.guarantee || '')}</td></tr></table><p>We look forward to your stay.</p>`); }
function printFolio() { const r = FO.res; printHtml(letterHead() + `<h2>Guest Folio</h2><p><b>${esc(gname(r))}</b><br>${esc([r.addr1, r.city, r.state, r.zip].filter(Boolean).join(', '))}<br>Room ${esc(r.room)} · ${dshort(r.arrive)} to ${dshort(r.depart)} · Conf. # ${esc(r.conf)}${r.company ? '<br>' + esc(r.company) : ''}</p>` + folioTable(FO) + '<p style="margin-top:30px">Guest signature: ______________________________________</p>'); }

/* ---------- Reports ---------- */
const REPORTS = [['arrivals', 'Arrival List'], ['departures', 'Departure List'], ['inhouse', 'In House List'], ['vacant', 'Vacant Room List'], ['hkcheck', 'Housekeeping Check-off List'], ['ledger', 'Guest Ledger (balances)'], ['future', 'Future Availability (14 days)'],
  ['activity', 'Reservation Activity Report'], ['stats', 'Hotel Statistics'], ['closeout', 'Final Transaction Closeout'], ['shift', 'Shift Reconciliation'], ['journal', 'Hotel Journal Detail'], ['cancel', 'Cancellation List'], ['noshow', 'No Show Report'], ['araging', 'Accounts Receivable Aging'], ['grouppickup', 'Group Pickup'], ['shifts', 'Cashier Shifts']];
const REPORT_CATS = [
  ['TOP 10 LIST', [['Shift Reconciliation', 'shift'], ['Vacant Room List', 'vacant'], ['Housekeeping Check-off List', 'hkcheck'], ['Final Transaction Closeout', 'closeout'], ['Hotel Statistics', 'stats'], ['In House List', 'inhouse'], ['Reservation Activity Report', 'activity']]],
  ['Emergency Reports', [['Account Balance Report', 'ledger'], ['Arrival List', 'arrivals'], ['Departure List', 'departures'], ['In House List', 'inhouse'], ['Vacant Room List', 'vacant']]],
  ['Accounting Reports', [['Final Transaction Closeout', 'closeout'], ['Hotel Statistics', 'stats'], ['Guest Ledger', 'ledger'], ['Hotel Journal Detail', 'journal'], ['Shift Reconciliation', 'shift'], ['Cashier Shifts', 'shifts']]],
  ['Front Desk Reports', [['Cancellation List', 'cancel'], ['No Show Report', 'noshow']]],
  ['Housekeeping Reports', [['Housekeeping Check-off List', 'hkcheck']]],
  ['Reservation Reports', [['Reservation Activity Report', 'activity'], ['10 Day Availability', 'future'], ['No Show Report', 'noshow']]],
  ['Group Reports', [['Group Pickup Summary', 'grouppickup']]],
  ['Accounts Receivable Reports', [['Accounts Receivable Aging Report', 'araging']]]];
const REPORT_INFO = {
  arrivals: 'Guests with a reservation due to arrive who have not checked in yet.', departures: 'In-house guests due to leave today or earlier, with their balances.',
  inhouse: 'Every guest checked in right now, with room, dates, rate and balance.', vacant: 'Rooms that are empty tonight, with their housekeeping condition.',
  hkcheck: 'A room-by-room sheet for housekeepers to check off as each room is done.', ledger: 'Every stay that has a balance owing or a credit, with the total.',
  future: 'How many rooms of each type are still available over the next 14 days.', stats: 'Rooms, occupancy, revenue, ADR and RevPAR for the day, month to date and year to date, with last year beside them.',
  closeout: 'Every posting code for the day: opening balance, totals, adjustments, month to date and year to date.', shift: 'Payments taken on a day by posting code, with the lines behind each total, to balance the drawer.',
  journal: 'Every line posted to a folio, in order, with who posted it and when.', cancel: 'Reservations that were cancelled and were due to arrive in the dates chosen.', noshow: 'Reservations that were due to arrive in the dates chosen and never came.',
  activity: 'Reservations made (created) in the dates chosen, whatever their status now.',
  araging: 'What each direct-bill company owes, grouped by how old the charge is.', grouppickup: 'For each group, the rooms blocked, picked up and still left.',
  shifts: 'Each cashier shift with opening cash, cash taken in, counted cash and over or short.' };
// Options page of each report: [key, kind, label, choices or default]. Keys `from` and `to` are the date boxes (ids repFrom / repTo).
const optTypes = () => [['', 'Select All']].concat(S.config.types.map(t => [t.code, t.code + (t.name ? ' - ' + t.name : '')]));
const OPT_RANGE = () => [{ k: 'from', t: 'date', l: '*Start Date:' }, { k: 'to', t: 'date', l: 'End Date:' }];
const REP_OPTS = {
  shift: () => [{ k: 'from', t: 'date', l: 'Date:' }, { k: 'user', t: 'select', l: 'User ID:', o: [['All', 'Select All']], d: 'All' }, { k: 'drawer', t: 'money', l: 'Drawer Total:', d: '' }, { k: 'details', t: 'check', l: 'Transaction Details:', d: true }],
  closeout: () => [{ k: 'from', t: 'date', l: 'Date:' }],
  stats: OPT_RANGE, journal: OPT_RANGE, cancel: OPT_RANGE, noshow: OPT_RANGE, shifts: OPT_RANGE,
  inhouse: () => [{ k: 'sort', t: 'select', l: 'Sort:', o: [['name', 'Guest Name'], ['room', 'Room'], ['account', 'Account']], d: 'name' }, { k: 'type', t: 'select', l: 'Room Type:', o: optTypes(), d: '' }],
  vacant: () => [{ k: 'type', t: 'select', l: 'Room Type:', o: optTypes(), d: '' }, { k: 'cond', t: 'select', l: 'Condition:', o: [['', 'Select All'], ['R', 'Ready'], ['C', 'Clean'], ['D', 'Dirty']], d: '' },
    { k: 'ooo', t: 'check', l: 'Include Out of Order Rooms:', d: true }, { k: 'arr', t: 'check', l: "Include Today's Arrival:", d: true }, { k: 'names', t: 'check', l: 'Include Guest Names:', d: true }],
  activity: () => [{ k: 'sort', t: 'select', l: 'Sort:', o: [['arrive', 'Arrival Date'], ['name', 'Guest Name'], ['created', 'Created']], d: 'arrive' }, { k: 'from', t: 'date', l: '*Start Date:' }, { k: 'to', t: 'date', l: '*End Date:' }, { k: 'type', t: 'select', l: 'Room Type:', o: optTypes(), d: '' }],
  arrivals: () => [{ k: 'sort', t: 'select', l: 'Sort:', o: [['name', 'Guest Name'], ['room', 'Room']], d: 'name' }],
  departures: () => [{ k: 'sort', t: 'select', l: 'Sort:', o: [['name', 'Guest Name'], ['room', 'Room']], d: 'room' }] };
const CSV_FIELD = { k: 'csv', t: 'check', l: 'Generate report as .CSV file:', d: false };
const repFields = () => (REP_OPTS[view.rep] ? REP_OPTS[view.rep]() : []);
const fieldId = f => f.k === 'from' ? 'repFrom' : f.k === 'to' ? 'repTo' : 'opt_' + f.k;
const optVal = f => f.k === 'from' ? view.from : f.k === 'to' ? view.to : view.opt && view.opt[f.k] !== undefined ? view.opt[f.k] : f.d;
function optField(f) {
  const id = fieldId(f), v = optVal(f); let ctl;
  if (f.t === 'date') ctl = `<input type="date" id="${id}" value="${esc(v)}">`;
  else if (f.t === 'money') ctl = `<input id="${id}" inputmode="decimal" placeholder="0.00" value="${esc(v)}">`;
  else if (f.t === 'check') ctl = `<input type="checkbox" id="${id}" ${v ? 'checked' : ''}>`;
  else { const o = f.o.some(x => String(x[0]) === String(v)) ? f.o : f.o.concat([[v, v]]); ctl = `<select id="${id}">${o.map(x => `<option value="${esc(x[0])}" ${String(x[0]) === String(v) ? 'selected' : ''}>${esc(x[1])}</option>`).join('')}</select>`; }
  return `<label class="fl" for="${id}">${esc(f.l)}</label><div class="fc">${ctl}</div>`;
}
function readOpts() {   // copy what is typed on the options page into view
  view.opt = view.opt || {};
  for (const f of repFields().concat([CSV_FIELD])) { const el = $('#' + fieldId(f)); if (!el) continue; if (f.k === 'from') view.from = el.value || view.from; else if (f.k === 'to') view.to = el.value; else view.opt[f.k] = f.t === 'check' ? el.checked : el.value; }
}
async function fillShiftUsers() {   // the User ID box lists everyone who posted a payment on that date
  if (view.rep !== 'shift' || !$('#opt_user')) return;
  try {
    const R = await api('/report?name=shift2&date=' + encodeURIComponent(($('#repFrom') && $('#repFrom').value) || view.from)), sel = $('#opt_user'); if (!sel) return;
    const cur = (view.opt && view.opt.user) || 'All'; if (cur !== 'All' && !R.users.includes(cur)) view.opt.user = 'All';
    sel.innerHTML = [['All', 'Select All']].concat(R.users.map(u => [u, u])).map(o => `<option value="${esc(o[0])}" ${o[0] === view.opt.user ? 'selected' : ''}>${esc(o[1])}</option>`).join('');
  } catch (e) { /* leave Select All */ }
}
const repFilter = () => {
  const q = ((view.repQ || '')).trim().toLowerCase();
  document.querySelectorAll('.rcat').forEach(c => { let n = 0; c.querySelectorAll('.rlink').forEach(a => { const ok = !q || a.textContent.toLowerCase().includes(q); a.style.display = ok ? '' : 'none'; if (ok) n++; }); c.style.display = n ? '' : 'none'; });
};
function repTitle() { return view.repLabel || (REPORTS.find(r => r[0] === view.rep) || [])[1] || ''; }
function vReports() {
  if (!view.from) view.from = view.to = B();
  view.opt = view.opt || {};
  const rep = REPORTS.find(r => r[0] === view.rep), fields = repFields();
  if (view.rep && rep && view.repStage === 'options') {
    return `<h1 class="rtitle">${esc(repTitle())}</h1><p class="rdesc">${esc(REPORT_INFO[view.rep] || '')}</p>
    ${fields.length ? `<div class="rform">${fields.map(optField).join('')}</div>` : ''}
    <hr class="dash"><div class="rfmt">Formatting Options:</div><div class="rform">${optField(CSV_FIELD)}</div>
    <div class="rbtns"><button class="btn blue" data-act="repBack">BACK</button><button class="btn blue" data-act="repRun">SUBMIT</button></div>`;
  }
  if (view.rep && rep && view.repStage === 'result') {
    return `<div class="rbtns left"><button class="btn blue" data-act="repBack">BACK</button><button class="btn blue" data-act="printRep">PRINT</button></div>
    <div id="repOut"><div class="hint">Loading…</div></div>`;
  }
  const col = view.repCol || {}, allOff = REPORT_CATS.every(c => col[c[0]]);
  return `<h1 class="rtitle">Reports</h1><div class="rsearch"><label for="repSearch">Search:</label><br><input type="text" id="repSearch" value="${esc(view.repQ || '')}" autocomplete="off"></div><hr class="dash">
  <div class="rtop"><button class="btn blue" data-act="repAll">${allOff ? 'EXPAND ALL' : 'COLLAPSE ALL'}</button></div>
  <div class="rcols">${REPORT_CATS.map(c => `<div class="rcat ${col[c[0]] ? 'off' : ''}"><div class="rch" data-act="repCat" data-cat="${esc(c[0])}"><span class="tri">${col[c[0]] ? '▶' : '▼'}</span>${esc(c[0])}</div>${c[1].map(r => `<a class="rlink" href="#" data-act="rep" data-rep="${r[1]}" data-label="${esc(r[0])}">${esc(r[0])}</a>`).join('')}</div>`).join('')}</div>`;
}

/* The report sheet: every report is drawn on this "paper" (title, header line, body, footer). PRINT prints exactly this. */
const mm = c => c < 0 ? '(' + money(-c) + ')' : money(c);   // money, negative in parentheses
const mdy = d => d ? d.slice(5, 7) + '/' + d.slice(8, 10) + '/' + d.slice(0, 4) : '';
const printedAt = () => new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '');
function sheet(title, bodyHtml, o) {
  o = o || {};
  return `<div class="sheet"><div class="sh-title">${esc(title)}</div>
    <div class="sh-head"><span>Business Date: ${esc(mdy(o.date || B()))}</span><span>Property: ${esc(S.config.name)}</span><span>Shift: ${esc(o.shift || 'All')}</span><span>User: ${esc(o.user || S.me.name)}</span></div>
    <div class="sh-body">${bodyHtml}</div>
    <div class="sh-foot"><span>Date/Time of Printing: ${esc(printedAt())}</span><span>Page 1 of 1</span></div></div>`;
}
function downloadCsv(name, rows) {
  const text = rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}
const DATED = { shift: 1, closeout: 1, stats: 1, activity: 1, journal: 1, cancel: 1, noshow: 1, shifts: 1 };
async function buildReport() {
  const title = repTitle(), opt = view.opt || {}, money = mm; let h = '', csv = null;
  const plain = x => { const d = document.createElement('div'); d.innerHTML = String(x == null ? '' : x).replace(/<br\s*\/?>/gi, ' '); return d.textContent.replace(/\s+/g, ' ').trim(); };
  // T: a table. Headings starting with # are numbers (right aligned). A row is a list of cells, or a ready-made <tr> string. The first table is what CSV saves.
  const T = (heads, rows, cls) => {
    if (!csv) csv = [heads.map(x => plain(String(x).replace(/^#/, '')))].concat(rows.filter(Array.isArray).map(r => r.map(plain)));
    const num = heads.map(x => /^#/.test(x));
    return `<table class="rt ${cls || ''}"><tr>${heads.map((x, i) => `<th class="${num[i] ? 'num' : ''}">${x.replace(/^#/, '')}</th>`).join('')}</tr>${rows.map(r => typeof r === 'string' ? r : `<tr>${r.map((c, i) => `<td class="${num[i] ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${heads.length}" class="empty">Nothing to show.</td></tr>`}</table>`;
  };
  const tot = (label, vals, lead) => `<tr class="tot"><td class="lbl" colspan="${lead || 1}">${label}</td>${vals.map(v => `<td class="num amt">${v}</td>`).join('')}</tr>`;
  const sortRoom = (a, b) => String(a.room || a.no).localeCompare(String(b.room || b.no), 'en', { numeric: true });
  const sorter = k => k === 'room' ? sortRoom : byName;
  const rateOf = r => r.rate != null ? r.rate : (r.rates && r.rates[B()]) != null ? r.rates[B()] : rateFor(r.type, B());
  const shortDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : '';
  const kv = (a, b, cls) => `<tr class="${cls || ''}"><td class="lbl">${a}</td><td class="num">${b}</td></tr>`;
  let date = DATED[view.rep] ? view.from : B(), user = '';
  const api2 = (name, extra) => api(`/report?name=${name}&from=${view.from}&to=${view.to}${extra || ''}`);
  if (view.rep === 'arrivals') h = T(['Guest', 'Room', 'Type', '#Nights', '#Rate', 'Guarantee', 'Phone', 'Conf. #'], S.res.filter(r => r.status === 'reserved' && r.arrive <= B()).sort(sorter(opt.sort || 'name')).map(r => [esc(gname(r)), esc(r.room), esc(r.type), nights(r.arrive, r.depart), money(r.rate), esc(r.guarantee), esc(r.phone), esc(r.conf)]));
  else if (view.rep === 'departures') h = T(['Room', 'Guest', 'Arrival', 'Departure', '#Balance'], S.res.filter(r => r.status === 'inhouse' && r.depart <= B()).sort(sorter(opt.sort || 'room')).map(r => [esc(r.room), esc(gname(r)), dshort(r.arrive), dshort(r.depart), money(S.bal[r.id] || 0)]));
  else if (view.rep === 'inhouse') {
    const gtd = g => /credit/i.test(g || '') ? 'CC' : /cash/i.test(g || '') ? 'CA' : /direct/i.test(g || '') ? 'DB' : /6 ?pm/i.test(g || '') ? '6PM' : '';
    const l = S.res.filter(r => r.status === 'inhouse' && (!opt.type || r.type === opt.type)).sort(opt.sort === 'room' ? sortRoom : opt.sort === 'account' ? (a, b) => String(a.conf).localeCompare(String(b.conf), 'en', { numeric: true }) : byName);
    const guest = r => { const g = r.groupId && (S.groups || []).find(x => x.id === +r.groupId); return `<b>${esc(gname(r))}</b>` + [r.company, g && g.name, r.vehicle].filter(Boolean).map(x => `<div class="sub">${esc(x)}</div>`).join(''); };
    h = T(['Room', 'Account', 'VIP', 'Guest Name', 'Notes', 'Arrive', 'Depart', 'Adults/ Children', 'Room Type', 'Package', '#Rate', 'GTD', 'Source', '#Balance'], l.map(r => [esc(r.room), esc(r.conf), r.vip ? 'VIP' : '', guest(r), `<div class="note">${esc(r.notes)}</div>`, dshort(r.arrive), dshort(r.depart), (r.adults || 0) + '/' + (r.children || 0), esc(r.type), esc(r.pkg), money(rateOf(r)), gtd(r.guarantee), esc(r.source), money(S.bal[r.id] || 0)]), 'inh')
      + `<div class="sh-total">Total Guests: ${l.reduce((s, r) => s + (r.adults || 0) + (r.children || 0), 0)} &nbsp; &nbsp;Total Rooms: ${l.length}</div>`;
  }
  else if (view.rep === 'vacant') {
    const rows = S.config.rooms.filter(r => !inRoom(r.no) && (!opt.type || r.type === opt.type) && (!opt.cond || cond(r.no) === opt.cond) && (opt.ooo !== false || !isOOO(r.no, B()))).map(r => ({ r, out: isOOO(r.no, B()), a: S.res.find(x => x.status === 'reserved' && x.room === r.no && x.arrive <= B()) })).filter(x => opt.arr !== false || !x.a);
    const names = opt.names !== false, heads = ['Room', 'Type', 'Condition', 'Status'].concat(names ? ['Arriving Guest'] : []);
    h = T(heads, rows.map(x => [esc(x.r.no), esc(x.r.type), { R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(x.r.no)], x.out ? 'Out of Order' : 'Vacant'].concat(names ? [x.a ? esc(gname(x.a)) : ''] : []))) + `<div class="sh-total">Total Vacant Rooms: ${rows.filter(x => !x.out).length}</div>`;
  }
  else if (view.rep === 'hkcheck') h = hkCheckHtml();
  else if (view.rep === 'ledger') { const l = S.res.filter(r => (S.bal[r.id] || 0) !== 0).sort(sortRoom); h = T(['Room', 'Guest', 'Status', 'Arrival', 'Departure', '#Balance'], l.map(r => [esc(r.room), esc(gname(r)), r.status, dshort(r.arrive), dshort(r.depart), money(S.bal[r.id])]).concat([tot('Total:', [money(l.reduce((s, r) => s + S.bal[r.id], 0))], 5)])); }
  else if (view.rep === 'future') { const days = []; for (let i = 0; i < 14; i++) days.push(addDays(B(), i)); h = T(['Type'].concat(days.map(d => '#' + dshort(d).replace(/\/\d+$/, ''))), S.config.types.map(t => [`<b>${esc(t.code)}</b>`].concat(days.map(d => availOfType(t.code, d, addDays(d, 1))))).concat([['<b>Hotel</b>'].concat(days.map(d => '<b>' + S.config.types.reduce((s, t) => s + availOfType(t.code, d, addDays(d, 1)), 0) + '</b>'))])); }
  else if (view.rep === 'closeout') {
    const R = await api(`/report?name=closeout2&date=${view.from}`), row = (label, x) => [label, mm(x.opening), mm(x.today), mm(x.adj), mm(x.net), mm(x.ptd), mm(x.ytd)];
    const rows = []; for (const g of R.groups) { rows.push(`<tr class="grp"><td colspan="7">Transaction Type: ${esc(g.label)}</td></tr>`); for (const x of g.rows) rows.push(`<tr><td class="lbl">${esc(x.name)} (${esc(x.code)})</td>${row('', x).slice(1).map(v => `<td class="num">${v}</td>`).join('')}</tr>`); rows.push(tot('Total For ' + esc(g.label) + ':', row('', g.total).slice(1))); }
    if (R.groups.length) rows.push(tot('Grand Total:', row('', R.grand).slice(1)));
    h = T(['Description (Transaction Code)', "#Today's Opening Balance", "#Today's Totals (Include Corrections)", "#Today's Adjustments", "#Today's Net", '#PTD Totals', '#YTD Totals'], rows, 'co');
    csv = [csv[0]].concat(R.groups.flatMap(g => g.rows.map(x => row(`${x.name} (${x.code})`, x)).concat([row('Total For ' + g.label + ':', g.total)])), R.groups.length ? [row('Grand Total:', R.grand)] : []);
  }
  else if (view.rep === 'shift') {
    const R = await api(`/report?name=shift2&date=${view.from}&user=${encodeURIComponent(opt.user || 'All')}` + (String(opt.drawer || '').trim() ? '&drawer=' + toCents(opt.drawer) : ''));
    const drawer = String(opt.drawer || '').trim() ? toCents(opt.drawer) || 0 : 0;
    h = `<div class="sh-sub"><span>Shift: All</span><span>User: ${esc(R.user || 'All')}</span></div>`
      + T(['Transaction Code', '#Total'], R.codes.map(g => [esc(g.name) + ' (' + esc(g.code) + ')', money(g.total)]).concat([tot('Grand Total:', [money(R.grand)])]))
      + `<div class="sh-h">Summary:</div><table class="rt kv">${kv('Grand Total:', money(R.grand))}${kv('Beginning Bank:', money(R.beginBank))}${kv('Drawer Total:', money(drawer))}${kv(R.overShort < 0 ? 'Short:' : 'Over:', money(R.overShort), 'b')}</table>`;
    if (opt.details !== false) for (const g of R.codes) h += `<div class="sh-h">Transaction Code: ${esc(g.name)} (${esc(g.code)})</div>`
      + `<table class="rt det"><colgroup>${[10, 11, 6, 9, 8, 11, 22, 5, 9, 9].map(w => `<col style="width:${w}%">`).join('')}</colgroup><tr>${['Posting Date', 'User ID', 'Shift ID', 'Room/ Invoice', 'Account Type', 'Account', 'Name Comment', 'Type', '#Amount', '#Adjustment'].map(x => `<th class="${/^#/.test(x) ? 'num' : ''}">${x.replace(/^#/, '')}</th>`).join('')}</tr>`
      + g.rows.map(x => `<tr><td>${mdy(x.bdate)}</td><td>${esc(x.user)}</td><td>${esc(x.shift)}</td><td>${esc(x.room)}</td><td>${esc(x.accType)}</td><td>${esc(x.account)}</td><td><div>${esc(x.name)}</div>${x.comment ? `<div class="sub">${esc(x.comment)}</div>` : ''}</td><td></td><td class="num">${money(x.amount)}</td><td class="num">${money(x.adj)}</td></tr>`).join('')
      + tot('Total For: ' + esc(g.name) + ' (' + esc(g.code) + ')', [money(g.total), money(0)], 8) + '</table>';
    if (!R.codes.length) h += '<div class="empty">No payments were posted on this date.</div>';
  }
  else if (view.rep === 'stats') {
    const R = await api(`/report?name=stats2&from=${view.from}&to=${view.to}`), C = R.cols, cs = [C.day, C.ptd, C.lyPtd, C.ytd, C.lyYtd];
    const line = (label, f, o) => { o = o || {}; return `<tr class="${o.b ? 'b' : ''}"><td class="ind">${label}</td>${cs.map(c => `<td class="num">${f(c)}</td>`).join('')}</tr>`; };
    const sec = n => `<tr class="ssec"><td colspan="6">${n}</td></tr>`, int = k => c => c[k], pct = k => c => c[k].toFixed(2) + '%', mon = k => c => mm(c[k]);
    const rows = [sec('Room Statistics'), line('Total Rooms', int('total')), line('Out Of Order', int('ooo')), line('Rooms Available to Sell', int('avail'), { b: 1 }), line('Stay Over Rooms', int('stay')), line('Total Revenue Rooms', int('revRooms'), { b: 1 }), line('Total Occupied Rooms', int('occupied'), { b: 1 }),
      sec('Performance Statistics'), line('Occ% of Total Available Rooms', pct('occAvail')), line('Occ% of Total Rooms', pct('occTotal')), line('ADR for Total Rev Rooms', mon('adr')), line('RevPar', mon('revpar')),
      sec('Revenue'), line('Room Revenue', mon('roomRev')), line('Other Revenue', mon('otherRev')), line('Total Tax', mon('tax')), line('Total Revenue', mon('totalRev'), { b: 1 }), line('Total Payments', mon('payments'))];
    h = T(['', '#' + (R.from === R.to ? mdy(R.from) : mdy(R.from) + ' - ' + mdy(R.to)), '#PTD', '#Last Year PTD', '#YTD', '#Last YTD'], rows, 'st');
    csv = [csv[0]].concat(rows.filter(r => !/class="ssec"/.test(r)).map(r => { const d = document.createElement('table'); d.innerHTML = r; return [...d.querySelectorAll('td')].map(td => td.textContent); }));
    if (R.includesToday) h += '<div class="sh-note">Includes the open business date (today so far).</div>';
  }
  else if (view.rep === 'activity') {
    const R = await api2('activity', `&sort=${encodeURIComponent(opt.sort || 'arrive')}&type=${encodeURIComponent(opt.type || '')}&tz=${encodeURIComponent((Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '')}`);
    h = T(['Account', 'Guest Name', 'Arrive', 'Depart', '#Nights', 'Status', '#Rate', 'Package', 'Type', 'Room', 'Source', 'Pay', 'Created', 'User'], R.rows.map(x => [esc(x.conf), esc(x.name), dshort(x.arrive), dshort(x.depart), x.nights, x.status, money(x.rate), esc(x.pkg), esc(x.type), esc(x.room), esc(x.source), x.pay, shortDate(x.created), esc(x.user)]), 'act')
      + `<div class="sh-total">Total Reservations: ${R.count}</div><div class="sh-total">Total Room Nights: ${R.roomNights}</div>`;
  }
  else {
    const R = await api2(view.rep === 'cancel' || view.rep === 'noshow' ? 'history' : view.rep);
    if (view.rep === 'journal') h = T(['Item #', 'Date', 'Posted', 'Room', 'Guest', 'Description', 'Comments', 'By', '#Amount'], R.rows.map(l => [l.id, dshort(l.bdate), stamp(l.at), esc(l.room), esc(l.name), esc(l.descr), esc(l.comment), esc(l.user), money(l.amount)]));
    else if (view.rep === 'araging') h = T(['Company', '#0–30 days', '#31–60', '#61–90', '#Over 90', '#Unapplied credit', '#Balance'], R.rows.map(x => [esc(x.name), money(x.cur), money(x.d30), money(x.d60), money(x.d90), money(x.credit), '<b>' + money(x.balance) + '</b>']).concat([tot('Total owed:', [money(R.rows.reduce((s, x) => s + x.balance, 0))], 6)]));
    else if (view.rep === 'grouppickup') h = T(['Group', 'Arrival', 'Departure', 'Cut-off', '#Blocked', '#Picked up', '#Left', '#Room revenue', 'Status'], R.rows.map(x => [esc(x.name), dshort(x.arrive), dshort(x.depart), dshort(x.cutoff), x.blocked, x.picked, x.left, money(x.revenue), x.status]));
    else if (view.rep === 'shifts') h = T(['Cashier', 'Opened', 'Closed', '#Opening cash', '#Cash taken in', '#Expected', '#Counted', '#Over / short'], R.rows.map(x => [esc(x.user), stamp(x.openAt), x.closeAt ? stamp(x.closeAt) : 'Open', money(x.openCash), x.closeAt ? money(x.cashIn) : '', x.closeAt ? money(x.expected) : '', x.closeAt ? money(x.counted) : '', x.closeAt ? money(x.overShort) : '']));
    else if (view.rep === 'cancel' || view.rep === 'noshow') { const l = view.rep === 'cancel' ? R.cancelled : R.noshow; h = T(['Guest', 'Arrival', 'Departure', 'Type', 'Room', '#Rate', '#Balance', 'Conf. #'], l.map(r => [esc(r.name), dshort(r.arrive), dshort(r.depart), esc(r.type), esc(r.room), money(r.rate), money(r.bal), esc(r.conf)])) + `<div class="sh-total">Total: ${l.length}</div>`; }
  }
  return { title, html: sheet(title, h, { date, user }), csv: csv || [[title]], date };
}
async function drawReport() {
  const out = $('#repOut'); if (!out) return;
  try { const r = await buildReport(); out.innerHTML = r.html; out.dataset.title = r.title; }
  catch (e) { out.innerHTML = sheet(repTitle(), `<div class="err">${esc(e.message)}</div>`); }
}
const hkCheckHtml = () => `<table class="rt"><tr><th>Room</th><th>Type</th><th>Status</th><th>Condition</th><th>Service</th><th>Housekeeper</th><th>Notes</th><th>Done</th></tr>${S.config.rooms.map(rm => { const st = S.roomstate[rm.no] || {}; return `<tr><td><b>${esc(rm.no)}</b></td><td>${esc(rm.type)}</td><td>${inRoom(rm.no) ? 'Occupied' : 'Vacant'}</td><td>${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(rm.no)]}</td><td>${service(rm.no)}${st.dnd ? ' (DND)' : ''}</td><td>${esc(st.hk || '')}</td><td>${esc([hkPreText(rm.no), st.note].filter(Boolean).join(' · '))}</td><td>☐</td></tr>`; }).join('')}</table>`;
async function nightAudit() {
  const s = S.stats;
  if (!confirm(`Run the night audit for ${dlong(B())}?\n\n• Posts tonight's room charge and tax to ${s.sold} in-house rooms\n• Marks ${s.arrivalsLeft} arrivals that did not check in as no shows\n• Extends ${s.dueOut} guests who were due out but are still checked in\n• Moves the business date to ${dlong(addDays(B(), 1))}\n\nThis cannot be undone.`)) return;
  await run(async () => { const x = (await op('nightAudit', { date: B() })).audit; view.tapeStart = x.newDate; view.from = x.date; view.to = x.newDate; await refresh(); alert(`Night audit finished for ${dshort(x.date)}.\n\nRoom charges posted: ${x.posted} (${money(x.revenue)})\nNo shows: ${x.noShows.length}${x.noShows.length ? '\n  ' + x.noShows.join('\n  ') : ''}\nStays extended: ${x.extended.length}${x.extended.length ? '\n  ' + x.extended.join('\n  ') : ''}\n\nThe business date is now ${dlong(x.newDate)}.`); });
}

/* ---------- Companies and direct-bill accounts ---------- */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function vCompanies() {
  const q = view.q.trim().toUpperCase(), l = S.companies.filter(c => !q || c.name.toUpperCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return `<h1>Companies</h1><div class="bar"><input id="q" placeholder="Quick search" value="${esc(view.q)}" style="width:240px"><button class="btn green" data-act="coNew">+ Company</button><span class="hint">Total owed on direct-bill accounts: <b>${money(Object.values(S.arBal).reduce((a, b) => a + b, 0))}</b></span></div>
  ${l.length ? `<div class="wrap"><table><tr><th>Company</th><th>Contact</th><th>Phone</th><th>Direct bill</th><th class="num">Company rate</th><th class="num">Credit limit</th><th class="num">Owes</th></tr>${l.map(c => `<tr class="click" data-act="coOpen" data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.inactive ? ' <span class="badge s">Inactive</span>' : ''}</td><td>${esc(c.contact)}</td><td>${esc(c.phone)}</td><td>${c.directBill ? '<span class="badge g">Yes</span>' : ''}</td><td class="num">${c.rate ? money(c.rate) : ''}</td><td class="num">${c.limit ? money(c.limit) : ''}</td><td class="num"><b>${money(S.arBal[c.id] || 0)}</b></td></tr>`).join('')}</table></div>` : '<div class="empty">No companies yet. Add one to give it a negotiated rate or a direct-bill account.</div>'}`;
}
let CO = null;
async function coOpen(id) { CO = id ? await api('/company?id=' + id) : { company: { name: '' }, ledger: [], balance: 0 }; coDraw(); }
function coDraw() {
  const c = CO.company, n = !c.id, f = (k, label, cls, extra) => `<label class="${cls || ''}">${label}<input id="co_${k}" value="${esc(c[k] == null ? '' : c[k])}" ${extra || ''}></label>`;
  $('#modal').innerHTML = `<div class="mback"><div class="mbox wide"><div class="mtitle">${n ? 'New company' : esc(c.name)} ${n ? '' : `<span class="hint">Owes ${money(CO.balance)}</span>`}</div>
  <div class="grid">${f('name', 'Company name *', 'c6', 'maxlength="80"')}${f('contact', 'Contact person', 'c6', 'maxlength="80"')}${f('phone', 'Phone', '', 'maxlength="30"')}${f('email', 'E-mail', '', 'maxlength="100"')}${f('corpId', 'Corporate ID', '', 'maxlength="30"')}${f('address', 'Billing address', 'c12', 'maxlength="200"')}
    <label class="c3">Company rate / night (0 = none)<input id="co_rate" inputmode="decimal" value="${((c.rate || 0) / 100).toFixed(2)}"></label><label class="chk c3"><input type="checkbox" id="co_directBill" ${c.directBill ? 'checked' : ''} ${boss() ? '' : 'disabled'}>Direct-bill account</label><label class="c3">Credit limit (0 = none)<input id="co_limit" inputmode="decimal" value="${((c.limit || 0) / 100).toFixed(2)}" ${boss() ? '' : 'disabled'}></label><label class="chk c3"><input type="checkbox" id="co_inactive" ${c.inactive ? 'checked' : ''}>Inactive</label>${f('notes', 'Notes', 'c12', 'maxlength="500"')}</div>
  ${n ? '' : `<div class="sec">Account (direct bill)</div><div class="acts" style="margin-bottom:8px"><button class="btn sm green" data-act="coPayOpen">Receive payment</button><button class="btn sm" data-act="coPrint">Print statement</button></div><div id="coPay"></div><div class="wrap" style="max-height:34vh">${coLedger()}</div><p class="hint">To bill a stay to this company: pick the company in the reservation, then in the Guest Folio use Post Payment › Direct Bill.</p>`}
  <div class="err" id="co_err"></div><div class="mfoot"><button class="btn" data-act="closeModal">Close</button><button class="btn green" data-act="coSave">${n ? 'Add company' : 'Save'}</button></div></div></div>`;
}
const coLedger = () => `<table><tr><th>Date</th><th>Entry</th><th>By</th><th class="num">Amount</th></tr>${CO.ledger.map(l => `<tr><td>${dshort(l.bdate)}</td><td>${l.kind === 'payment' ? 'Payment: ' : 'Stay: '}${esc(l.descr)}</td><td>${esc(l.user)}</td><td class="num">${l.amount < 0 ? '(' + money(-l.amount) + ')' : money(l.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing billed yet.</td></tr>'}<tr><td colspan="3" class="num"><b>Balance owed</b></td><td class="num"><b>${money(CO.balance)}</b></td></tr></table>`;

/* ---------- Groups ---------- */
function vGroups() {
  const l = S.groups.slice().sort((a, b) => a.arrive.localeCompare(b.arrive));
  const picked = g => S.res.filter(r => r.groupId === g.id && ['reserved', 'inhouse', 'out'].includes(r.status)).length, blocked = g => Object.values(g.blocks || {}).reduce((a, b) => a + b, 0);
  return `<h1>Groups</h1><div class="bar"><button class="btn green" data-act="grpNew">+ Group</button><span class="hint">A group holds rooms (a block) until its cut-off date. Reservations added to the group get the group's rate.</span></div>
  ${l.length ? `<div class="wrap"><table><tr><th>Group</th><th>Arrival</th><th>Departure</th><th>Cut-off</th><th class="num">Blocked</th><th class="num">Picked up</th><th class="num">Left</th><th>Status</th></tr>${l.map(g => `<tr class="click" data-act="grpOpen" data-id="${g.id}"><td><b>${esc(g.name)}</b></td><td>${dshort(g.arrive)}</td><td>${dshort(g.depart)}</td><td>${dshort(g.cutoff)}${g.cutoff && g.cutoff < B() ? ' <span class="badge s">released</span>' : ''}</td><td class="num">${blocked(g)}</td><td class="num">${picked(g)}</td><td class="num">${Math.max(0, blocked(g) - picked(g))}</td><td>${g.status === 'cancelled' ? '<span class="badge r">Cancelled</span>' : '<span class="badge g">Active</span>'}</td></tr>`).join('')}</table></div>` : '<div class="empty">No groups yet.</div>'}`;
}
let GR = null;
async function grpOpen(id) { GR = id ? await api('/group?id=' + id) : { group: { name: '', arrive: B(), depart: addDays(B(), 2), cutoff: '', blocks: {}, rates: {}, status: 'active' }, members: [] }; grpDraw(); }
function grpDraw() {
  const g = GR.group, n = !g.id, f = (k, label, cls, extra) => `<label class="${cls || ''}">${label}<input id="g_${k}" value="${esc(g[k] == null ? '' : g[k])}" ${extra || ''}></label>`;
  $('#modal').innerHTML = `<div class="mback"><div class="mbox wide"><div class="mtitle">${n ? 'New group' : esc(g.name)}</div>
  <div class="grid">${f('name', 'Group name *', 'c6', 'maxlength="80"')}${f('contact', 'Contact person', 'c3', 'maxlength="80"')}${f('phone', 'Phone', 'c3', 'maxlength="30"')}${f('arrive', 'Arrival', 'c3', 'type="date"')}${f('depart', 'Departure', 'c3', 'type="date"')}${f('cutoff', 'Cut-off date (unsold rooms go back on sale after it)', 'c6', 'type="date"')}
    <label class="c6">Company (optional)<select id="g_companyId"><option value="0">No company</option>${S.companies.map(c => `<option value="${c.id}" ${c.id === g.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>${f('email', 'E-mail', 'c6', 'maxlength="100"')}${f('notes', 'Notes', 'c12', 'maxlength="500"')}</div>
  <div class="sec">Rooms held and group rate</div><div class="wrap"><table><tr><th>Room type</th><th class="num">Hotel has</th><th>Rooms to hold</th><th>Group rate / night (blank = normal rate)</th></tr>${S.config.types.map(t => `<tr><td><b>${esc(t.code)}</b> ${esc(t.name)}</td><td class="num">${S.config.rooms.filter(r => r.type === t.code).length}</td><td><input data-gb="${esc(t.code)}" type="number" min="0" value="${(g.blocks || {})[t.code] || ''}" style="width:110px;min-height:34px"></td><td><input data-gr="${esc(t.code)}" inputmode="decimal" value="${(g.rates || {})[t.code] ? ((g.rates[t.code]) / 100).toFixed(2) : ''}" style="width:130px;min-height:34px"></td></tr>`).join('')}</table></div>
  ${n ? '' : `<div class="sec">Reservations in this group (${GR.members.length})</div><div class="acts" style="margin-bottom:8px"><button class="btn sm green" data-act="grpAddRes">+ Reservation in this group</button><button class="btn sm" data-act="grpPrint">Print rooming list</button>${g.status === 'cancelled' ? '<button class="btn sm" data-act="grpStatus" data-to="active">Reactivate group</button>' : '<button class="btn sm red" data-act="grpStatus" data-to="cancelled">Cancel group (release the rooms)</button>'}</div><div class="wrap" style="max-height:30vh">${grpMembers()}</div>`}
  <div class="err" id="g_err"></div><div class="mfoot"><button class="btn" data-act="closeModal">Close</button><button class="btn green" data-act="grpSave">${n ? 'Add group' : 'Save'}</button></div></div></div>`;
}
const grpMembers = () => `<table><tr><th>Guest</th><th>Status</th><th>Arrival</th><th>Departure</th><th>Type</th><th>Room</th><th class="num">Rate</th><th class="num">Balance</th><th>Conf. #</th></tr>${GR.members.sort(byName).map(r => `<tr class="click" data-act="openRes" data-id="${r.id}"><td><b>${esc(gname(r))}</b></td><td>${statusBadge(r)}</td><td>${dshort(r.arrive)}</td><td>${dshort(r.depart)}</td><td>${esc(r.type)}</td><td>${esc(r.room)}</td><td class="num">${money(r.rate)}</td><td class="num">${money(r.bal)}</td><td>${esc(r.conf)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No reservations in this group yet.</td></tr>'}</table>`;

/* ---------- Do Not Rent List screen ---------- */
function vDnr() {
  const q = view.q.trim().toUpperCase(), all = S.dnr || [], list = all.filter(e => !q || [e.last, e.first, e.guestId, e.phone, e.reason, e.by].join(' ').toUpperCase().includes(q));
  return `<h1 class="pgt-c">Do Not Rent List</h1>${all.length ? '' : '<div class="lst-empty">Nobody is on the Do Not Rent list.</div>'}
  <div class="lst-bar"><span>Entries: <b>${list.length}</b></span><button class="btn sm green" data-act="dnrNew">+ Add</button><button class="btn sm" data-act="dnrCsv">Export .CSV</button><span class="flex"></span><label class="lst-q">Quick Search: <input id="q" value="${esc(view.q)}"></label></div>
  <div class="wrap"><table class="lst"><tr><th>Name</th><th>Guest ID</th><th>Phone</th><th>Reason</th><th>Added By</th><th>Date</th><th></th></tr>${list.map(e => `<tr><td><b>${esc(gname(e).toUpperCase())}</b></td><td>${esc(e.guestId)}</td><td>${esc(e.phone)}</td><td>${esc(e.reason)}</td><td>${esc(e.by)}</td><td>${esc(dnrDate(e))}</td><td>${boss() ? `<button class="btn sm red" data-act="dnrDel" data-id="${e.id}">Remove</button>` : ''}</td></tr>`).join('')}</table></div>`;
}

/* ---------- Cashier shift ---------- */
async function shiftBox() {
  if (!S.shift) { $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle">Open my cashier shift</div><div class="grid"><label class="c12">Cash in the drawer now<input id="sh_cash" inputmode="decimal" value="0.00"></label></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="shiftOpen">Open shift</button></div></div></div>`; $('#sh_cash').select(); return; }
  const x = await op('shiftPeek', {});
  $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle">My cashier shift <span class="hint">opened ${stamp(x.shift.openAt)}</span></div>${shiftTable(x, x.shift.openCash)}<div class="grid" style="margin-top:12px"><label class="c6">Cash counted in the drawer<input id="sh_counted" inputmode="decimal" placeholder="${(x.expected / 100).toFixed(2)}"></label></div><div class="mfoot"><button class="btn" data-act="closeModal">Keep working</button><button class="btn amber" data-act="shiftClose">Close shift</button></div></div></div>`;
}
const shiftTable = (x, openCash) => `<div class="wrap"><table><tr><th>Payment type</th><th class="num">Count</th><th class="num">Total</th></tr>${x.by.map(b => `<tr><td>${esc(b.name)}</td><td class="num">${b.cnt}</td><td class="num">${money(b.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No payments taken yet.</td></tr>'}<tr><td colspan="2" class="num">Opening cash</td><td class="num">${money(openCash)}</td></tr><tr><td colspan="2" class="num">Cash taken in</td><td class="num">${money(x.cashIn)}</td></tr><tr><td colspan="2" class="num"><b>Cash that should be in the drawer</b></td><td class="num"><b>${money(x.expected)}</b></td></tr></table></div>`;

/* ---------- Scan ID: a 2D barcode scanner reads the back of a driver's license and types it here ---------- */
const scanState = { manual: false, t: 0 };
function scanBox() {
  readForm(); if ($('#scan')) return; scanState.manual = false;
  $('#modal').insertAdjacentHTML('beforeend', `<div class="scanov" id="scan"><div class="scanbox"><div class="scantxt">SCANNING PLEASE WAIT…</div><div class="scanbar"><i></i></div><div class="err scanerr" id="scanErr"></div>
    <textarea id="scanTxt" class="scancap" rows="5" autocomplete="off" spellcheck="false" aria-label="Scanned ID text"></textarea>
    <div id="scanManual" hidden><div class="mfoot" style="margin-top:6px"><button class="btn green" data-act="scanUse">Fill in the guest</button></div></div>
    <div class="scanlinks"><a href="#" data-act="scanCancel">Cancel</a><a href="#" data-act="scanType" id="scanTypeLink">Type or paste instead</a></div></div></div>`);
  $('#scanTxt').focus();
}
function scanClose() { clearTimeout(scanState.t); const b = $('#scan'); if (b) b.remove(); }
function scanFill(g) { scanClose(); if (!ED) return; Object.assign(ED.r, Object.fromEntries(Object.entries(g).filter(x => x[1]))); drawRes(); }   // guest fields only: the stay is not touched
function scanRead() {   // 400 ms after the last character from the scanner
  const t = $('#scanTxt'); if (!t || scanState.manual || !t.value.trim()) return;
  const g = parseLicense(t.value); if (g.last) return scanFill(g);
  $('#scanErr').textContent = 'That did not read as an ID barcode. Scan the large barcode on the back of the card.'; t.value = '';
}
function parseLicense(t) {   // AAMVA format used by US and Canadian licenses
  const get = code => { const m = new RegExp('(?:^|[\\n\\r\\x1e]|DL|ID)' + code + '([^\\n\\r\\x1e]*)').exec(t); return m ? m[1].trim() : ''; };
  const tidy = x => x.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  let last = get('DCS'), first = get('DAC') || get('DCT'); if (!last && get('DAA')) { const p = get('DAA').split(','); last = p[0] || ''; first = p[1] || ''; }
  const zip = get('DAK').replace(/\s/g, ''); return { last: tidy(last), first: tidy(first.split(/[ ,]/)[0] || ''), addr1: tidy(get('DAG')), city: tidy(get('DAI')), state: get('DAJ').toUpperCase(), zip: /^\d{9}$/.test(zip) ? (zip.slice(5) === '0000' ? zip.slice(0, 5) : zip.slice(0, 5) + '-' + zip.slice(5)) : zip.slice(0, 10), guestId: get('DAQ') };
}

/* ---------- Setup (managers) ---------- */
const SETUP = [['property', 'Property'], ['types', 'Room types and rates'], ['rooms', 'Rooms'], ['taxes', 'Taxes'], ['codes', 'Posting codes'], ['rates', 'Rates by date'], ['packages', 'Packages'], ['hks', 'Housekeepers'], ['users', 'Logins'], ['ooo', 'Out of order rooms']];
function vSetup() {
  const c = S.config; let body = '';
  const save = '<div class="mfoot" style="justify-content:flex-start"><button class="btn green" data-act="setupSave">Save</button></div>';
  if (view.setup === 'property') body = `<div class="grid card"><label class="c6">Hotel name<input id="s_name" value="${esc(c.name)}" maxlength="80"></label><label class="c6">Phone<input id="s_phone" value="${esc(c.phone)}" maxlength="40"></label><label class="c12">Address<input id="s_address" value="${esc(c.address)}" maxlength="200"></label><label class="c3">Check-in time<input id="s_checkinTime" value="${esc(c.checkinTime)}"></label><label class="c3">Check-out time<input id="s_checkoutTime" value="${esc(c.checkoutTime)}"></label><label class="chk c12"><input type="checkbox" id="s_requireShift" ${c.requireShift ? 'checked' : ''}>Front desk must open a cashier shift before taking payments</label><label class="c12">Words on the registration card<textarea id="s_regText" rows="3" maxlength="1500">${esc(c.regText)}</textarea></label></div>${save}`;
  else if (view.setup === 'types') body = `<p class="hint">One line per room type: code, name, nightly rate. Example: NK, King, 80.00</p><textarea id="s_types" rows="12" class="card" style="font-family:Consolas,monospace">${esc(c.types.map(t => `${t.code}, ${t.name}, ${(t.rate / 100).toFixed(2)}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'rooms') body = `<p class="hint">One line per room: room number, room type code, floor. Example: 101, NK, 1 &nbsp;(${c.rooms.length} rooms now)</p><textarea id="s_rooms" rows="18" class="card" style="font-family:Consolas,monospace">${esc(c.rooms.map(r => `${r.no}, ${r.type}, ${r.floor}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'taxes') body = `<p class="hint">One line per tax: code, name, percent. Example: T1, State Tax, 6.24</p><textarea id="s_taxes" rows="6" class="card" style="font-family:Consolas,monospace">${esc(c.taxes.map(t => `${t.code}, ${t.name}, ${t.pct}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'codes') body = `<p class="hint">One line per code: code, name, type, taxes that apply (separated by spaces). Types: ROOM and MISC are charges; CASH, CRED, AREC and GFTCRD are payments; ADMIN is for write-offs. Keep RM (the night audit posts it).</p><textarea id="s_codes" rows="20" class="card" style="font-family:Consolas,monospace">${esc(c.codes.map(k => `${k.code}, ${k.name}, ${k.type}, ${(k.tax || []).join(' ')}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'rates') body = `<p class="hint">Rates that change by date. One line each: name, from, through, days, room type, rate. Dates as YYYY-MM-DD. Days: <b>all</b>, or any of Sun Mon Tue Wed Thu Fri Sat. Room type: a code, or * for every type. When two lines cover the same night, the lower line wins. Nights with no line use the room type's normal rate.<br>Example: Derby weekend, 2027-05-01, 2027-05-02, all, *, 189.00 &nbsp;·&nbsp; Summer weekends, 2027-06-01, 2027-08-31, Fri Sat, NQQ, 109.00</p><textarea id="s_rates" rows="12" class="card" style="font-family:Consolas,monospace">${esc((c.rateRules || []).map(k => `${k.name}, ${k.from}, ${k.to}, ${k.days && k.days.length ? k.days.map(d => DOW[d]).join(' ') : 'all'}, ${k.type}, ${(k.rate / 100).toFixed(2)}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'packages') body = `<p class="hint">Extras sold with the room and charged every night by the night audit. One line each: code, name, price per night, posting code (leave blank for MS, Miscellaneous). Taxes follow the posting code.<br>Example: BKF, Breakfast for two, 18.00, MS</p><textarea id="s_packages" rows="8" class="card" style="font-family:Consolas,monospace">${esc((c.packages || []).map(k => `${k.code}, ${k.name}, ${(k.price / 100).toFixed(2)}, ${k.charge}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'hks') body = `<p class="hint">One housekeeper's name per line.</p><textarea id="s_hks" rows="8" class="card">${esc(c.housekeepers.join('\n'))}</textarea>${save}`;
  else if (view.setup === 'users') body = `<p class="hint">Everyone signs in with their own e-mail address. A new person gets a link to choose their password, and can reset it later with "Forgot your password?" on the sign-in page.</p><div id="usersBox" class="hint">Loading…</div><h2>Add or change a login</h2><div class="grid card"><label>E-mail address<input id="u_email" type="email" autocapitalize="off" maxlength="120"></label><label class="c3">Name<input id="u_name" maxlength="80"></label><label class="c3">Role<select id="u_role"></select></label><label class="chk c2"><input type="checkbox" id="u_disabled">Turned off</label><label class="c12" style="flex-direction:row;gap:8px"><button class="btn green" data-act="userSave">Save login</button><button class="btn" data-act="userInvite">Send a new password link</button></label></div>`;
  else if (view.setup === 'ooo') body = `<div class="bar"><button class="btn red" data-act="blockNew">Take a room out of order…</button></div><div class="wrap"><table><tr><th>Room</th><th>From</th><th>Through</th><th>Reason</th><th></th></tr>${S.blocks.map(b => `<tr><td><b>${esc(b.room)}</b></td><td>${dshort(b.start)}</td><td>${dshort(b.end)}</td><td>${esc(b.reason)}</td><td><button class="btn sm" data-act="blockRemove" data-id="${b.id}">Put back in order</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No rooms are out of order.</td></tr>'}</table></div>`;
  if (view.setup === 'users') setTimeout(async () => { const box = $('#usersBox'); if (!box) return; try { const R = await api('/account/users'), names = { owner: 'Owner', manager: 'Manager (GM)', desk: 'Front desk', hk: 'Housekeeping only' }; $('#u_role').innerHTML = R.may.map(r => `<option value="${r}">${names[r]}</option>`).join(''); if (R.may.includes('desk')) $('#u_role').value = 'desk';
    box.innerHTML = `<div class="wrap"><table><tr><th>Name</th><th>E-mail address</th><th>Role</th><th>Status</th><th>Last sign-in</th></tr>${R.users.map(x => `<tr class="click" data-act="userPick" data-u="${esc(JSON.stringify(x))}"><td><b>${esc(x.name)}</b></td><td>${esc(x.email)}</td><td>${names[x.role]}</td><td>${x.disabled ? '<span class="badge r">Off</span>' : x.hasPassword ? '<span class="badge g">On</span>' : '<span class="badge a">Has not chosen a password yet</span>'}</td><td>${x.lastLogin ? stamp(x.lastLogin) : ''}</td></tr>`).join('')}</table></div>${R.mailOn ? '' : '<p class="hint">E-mail sending is not set up yet, so copy each new login\'s link and send it yourself.</p>'}`; } catch (e) { box.textContent = e.message; } }, 0);
  return `<h1>Setup</h1><div class="acts" style="margin-bottom:12px">${SETUP.map(s => `<button class="btn sm ${view.setup === s[0] ? 'blue' : ''}" data-act="setupTab" data-tab="${s[0]}">${s[1]}</button>`).join('')}</div>${body}`;
}
async function setupSave() {
  const lines = id => $('#' + id).value.split('\n').map(l => l.split(',').map(x => x.trim())).filter(p => p[0]);
  const c = {};
  if (view.setup === 'property') { for (const k of ['name', 'phone', 'address', 'checkinTime', 'checkoutTime', 'regText']) c[k] = $('#s_' + k).value; c.requireShift = $('#s_requireShift').checked; }
  if (view.setup === 'rates') c.rateRules = lines('s_rates').map(p => ({ name: p[0], from: p[1], to: p[2], days: /^all$/i.test(p[3] || 'all') ? [] : (p[3] || '').split(/\s+/).map(x => DOW.findIndex(d => d.toLowerCase() === x.slice(0, 3).toLowerCase())).filter(x => x >= 0), type: p[4] || '*', rate: toCents(p[5] || '') }));
  if (view.setup === 'packages') c.packages = lines('s_packages').map(p => ({ code: p[0], name: p[1] || p[0], price: toCents(p[2] || '0'), charge: p[3] || 'MS' }));
  if (view.setup === 'types') c.types = lines('s_types').map(p => ({ code: p[0], name: p[1] || p[0], rate: toCents(p[2] || '0') }));
  if (view.setup === 'rooms') c.rooms = lines('s_rooms').map(p => ({ no: p[0], type: p[1] || '', floor: p[2] || p[0][0] }));
  if (view.setup === 'taxes') c.taxes = lines('s_taxes').map(p => ({ code: p[0], name: p[1] || p[0], pct: parseFloat(p[2]) || 0 }));
  if (view.setup === 'codes') c.codes = lines('s_codes').map(p => ({ code: p[0], name: p[1] || p[0], type: p[2] || 'MISC', tax: (p[3] || '').split(/\s+/).filter(Boolean).map(x => x.toUpperCase()) }));
  if (view.setup === 'hks') c.housekeepers = $('#s_hks').value.split('\n').map(x => x.trim()).filter(Boolean);
  await run(async () => { await op('configSave', { config: c }); await refresh(); toast('Saved.'); });
}
function blockNew() {
  $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle">Take a room out of order</div><div class="grid"><label class="c12">Room<select id="b_room">${S.config.rooms.map(r => `<option>${esc(r.no)}</option>`).join('')}</select></label><label class="c6">From<input type="date" id="b_start" value="${B()}"></label><label class="c6">Through<input type="date" id="b_end" value="${B()}"></label><label class="c12">Reason<input id="b_reason" maxlength="120" placeholder="AC repair, plumbing…"></label></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn red" data-act="blockSave">Take out of order</button></div></div></div>`;
}

/* ---------- clicks and typing ---------- */
document.addEventListener('click', async e => {
  const mb = e.target.closest('.menu>button'); if (mb) { mb.focus(); return; }
  if (e.target.closest('.drop')) setTimeout(() => { const h = $('header'); if (h) h.classList.add('nohover'); }, 0);
  const nav = e.target.closest('[data-nav]'); if (nav) { if (nav.tagName === 'A') e.preventDefault(); if (view.name !== nav.dataset.nav) { view.listDate = ''; view.listSort = null; } view.name = nav.dataset.nav; view.q = ''; if (view.name === 'reports') { view.repStage = 'list'; view.rep = ''; view.repQ = ''; } render(); return; }
  const el = e.target.closest('[data-act]'); if (!el) return; const a = el.dataset.act; if (el.tagName === 'A') e.preventDefault();
  if (a === 'cond') return run(async () => { e.stopPropagation(); await op('roomCond', { rooms: [el.dataset.room], cond: el.dataset.cond }); await refresh(); });
  if (a === 'logout') return run(async () => { await api('/auth/logout', {}); S = null; M = null; showLogin(); });
  if (a === 'forgot') return showLogin('', 'forgot');
  if (a === 'loginBack') return showLogin('', 'signin');
  if (a === 'myPw') return pwBox();
  if (a === 'copyLink') { const t = $('#linkTxt'); t.select(); try { await navigator.clipboard.writeText(t.value); toast('Link copied.'); } catch (x) { document.execCommand('copy'); toast('Link copied.'); } return; }
  if (a === 'mHotelNew') return mHotelBox();
  if (a === 'mTestHotel') return run(async () => { const n = M.hotels.filter(h => h.test).length; const r = await api('/master/hotelSave', { test: true, name: 'Test Hotel' + (n ? ' ' + (n + 1) : ''), note: 'Practice hotel for testing' }); await api('/master/open', { id: r.id }); M = null; S = null; view = { name: 'home', tapeStart: '', q: '', floor: '', rep: '', from: '', to: '', setup: 'property' }; await refresh(); toast('Test hotel ready. Click "All hotels" to go back.'); });
  if (a === 'mHotelEdit') return mHotelBox(M.hotels.find(h => h.id === el.dataset.id));
  if (a === 'mHotelSave') { try { const id = el.dataset.id, email = id ? '' : $('#mh_ownerEmail').value.trim(); const r = await api('/master/hotelSave', id ? { id, name: $('#mh_name').value, paidThrough: $('#mh_paid').value, note: $('#mh_note').value } : { name: $('#mh_name').value, ownerName: $('#mh_ownerName').value, ownerEmail: email, template: $('#mh_template').value, tz: $('#mh_tz').value, paidThrough: $('#mh_paid').value, note: $('#mh_note').value }); $('#modal').innerHTML = ''; await masterLoad(); if (r.link) linkBox('Hotel added. Send the owner their link', r, email); else toast('Saved.'); } catch (x) { $('#mh_err').textContent = x.message; } return; }
  if (a === 'mStatus') return run(async () => { const h = M.hotels.find(x => x.id === el.dataset.id), off = el.dataset.to === 'off'; if (off && !confirm('Turn OFF ' + h.name + '?\n\nEveryone there is signed out right now and nobody at that hotel can sign in until you turn it back on. Their data is kept.')) return; await api('/master/status', { id: h.id, status: el.dataset.to }); await masterLoad(); toast(h.name + (off ? ' is OFF.' : ' is ON.'), off); });
  if (a === 'mInvite') return run(async () => { const h = M.hotels.find(x => x.id === el.dataset.id); if (!confirm('Make a new "choose your password" link for ' + h.ownerEmail + '?')) return; linkBox('Owner link for ' + h.name, await api('/master/ownerInvite', { id: h.id }), h.ownerEmail); });
  if (a === 'mOpen') return run(async () => { await api('/master/open', { id: el.dataset.id }); M = null; S = null; view = { name: 'home', tapeStart: '', q: '', floor: '', rep: '', from: '', to: '', setup: 'property' }; await refresh(); });
  if (a === 'mClose') return run(async () => { await api('/master/close', {}); S = null; $('#modal').innerHTML = ''; await refresh(); });
  if (a === 'mMail') return mMailBox();
  if (a === 'mMailSave' || a === 'mMailTest') { try { await api('/master/mail', { user: $('#mm_user').value, pass: $('#mm_pass').value, fromName: $('#mm_fromName').value, host: $('#mm_host').value, port: $('#mm_port').value }); if (a === 'mMailTest') { $('#mm_err').textContent = 'Sending…'; const r = await api('/master/mailTest', {}); $('#mm_err').textContent = ''; toast('Test e-mail sent to ' + r.to + '.'); } else toast('Saved.'); const keep = a === 'mMailTest'; await masterLoad(); if (keep) mMailBox(); else $('#modal').innerHTML = ''; } catch (x) { $('#mm_err').textContent = x.message; } return; }
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.menu')) document.activeElement.blur();
  if (a === 'findOpen') { view.name = 'find'; view.findQ = ''; view.found = []; render(); const f = $('#find2'); if (f) f.focus(); return; }
  if (a === 'findGo') return doFind($('#find2').value);
  if (a === 'setupGo') { view.name = 'setup'; view.setup = el.dataset.tab; return render(); }
  if (a === 'repGo') { view.name = 'reports'; view.rep = el.dataset.rep; view.repLabel = ''; view.repStage = 'result'; view.opt = {}; view.from = view.to = B(); return render(); }
  if (a === 'newRes') return openNew('new', el.dataset.room, el.dataset.date);
  if (a === 'walkIn') return openNew('walkin');
  if (a === 'openRes') return run(() => openRes(el.dataset.id));
  if (a === 'closeModal') { clearTimeout(scanState.t); $('#modal').innerHTML = ''; ED = null; FO = null; CO = null; GR = null; return; }
  if (a === 'closeHist') { $('#hist').remove(); return; }
  if (a === 'saveRes') return saveRes();
  if (['checkIn', 'checkOut', 'undoCheckIn', 'undoCheckOut', 'cancelRes', 'noShow', 'reinstate', 'folio', 'viewChanges', 'printReg', 'printConf'].includes(a)) return resAction(a);
  if (a === 'rateStd') { readForm(); ED.r.rateManual = false; return drawRes(); }
  if (a === 'scanId') return scanBox();
  if (a === 'scanCancel') return scanClose();
  if (a === 'scanType') { scanState.manual = true; clearTimeout(scanState.t); $('#scanTxt').classList.remove('scancap'); $('#scanManual').hidden = false; el.hidden = true; $('#scanTxt').focus(); return; }
  if (a === 'scanUse') { const g = parseLicense($('#scanTxt').value); if (!g.last) { $('#scanErr').textContent = 'That did not read as an ID barcode. Scan the large barcode on the back of the card.'; return; } return scanFill(g); }
  if (a === 'wizNext') return wizNext();
  if (a === 'wizGo') { readForm(); ED.step = +el.dataset.step; return drawRes(); }
  if (a === 'wizHi') { readForm(); ED.hi = el.dataset.type; const rm = ED.r.room && S.config.rooms.find(x => x.no === ED.r.room); if (rm && rm.type !== ED.hi) ED.r.room = ''; return drawRes(); }
  if (a === 'wizType') { readForm(); ED.hi = el.dataset.type; return wizNext(); }
  if (a === 'guestFind') return run(guestFind);
  if (a === 'guestPick') return guestPick(el.dataset.i);
  if (a === 'dnrAddRes') return run(async () => { readForm(); const r = ED.r, reason = prompt('Add ' + gname(r) + ' to the Do Not Rent list.\nReason:', ''); if (reason === null) return; await op('dnrAdd', { last: r.last, first: r.first, guestId: r.guestId, phone: r.phone, reason }); await refresh(); if (ED) drawRes(); toast('Added to the Do Not Rent list.'); });
  if (a === 'dnrRemoveRes') return run(async () => { readForm(); const e0 = dnrMatchC(ED.r); if (!e0 || !confirm('Remove ' + gname(ED.r) + ' from the Do Not Rent list?')) return; await op('dnrRemove', { id: e0.id }); await refresh(); if (ED) drawRes(); toast('Removed from the Do Not Rent list.'); });
  if (a === 'dnrNew') { $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle">Add to the Do Not Rent list</div><div class="grid"><label class="c6">Last name<input id="dn_last" maxlength="60"></label><label class="c6">First name<input id="dn_first" maxlength="60"></label><label class="c6">Guest ID<input id="dn_guestId" maxlength="40"></label><label class="c6">Phone<input id="dn_phone" maxlength="30"></label><label class="c12">Reason *<input id="dn_reason" maxlength="300"></label></div><div class="err" id="dn_err"></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn red" data-act="dnrSave">Add to the list</button></div></div></div>`; $('#dn_last').focus(); return; }
  if (a === 'dnrSave') { try { await op('dnrAdd', Object.fromEntries(['last', 'first', 'guestId', 'phone', 'reason'].map(k => [k, $('#dn_' + k).value]))); $('#modal').innerHTML = ''; await refresh(); toast('Added to the Do Not Rent list.'); } catch (x) { $('#dn_err').textContent = x.message; } return; }
  if (a === 'dnrDel') return run(async () => { const e0 = (S.dnr || []).find(x => x.id === +el.dataset.id); if (!e0 || !confirm('Remove ' + gname(e0) + ' from the Do Not Rent list?')) return; await op('dnrRemove', { id: e0.id }); await refresh(); toast('Removed.'); });
  if (a === 'dnrCsv') return downloadCsv('do-not-rent-list-' + B() + '.csv', [['Last name', 'First name', 'Guest ID', 'Phone', 'Reason', 'Added by', 'Date']].concat((S.dnr || []).map(e => [e.last, e.first, e.guestId, e.phone, e.reason, e.by, dnrDate(e)])));
  if (a === 'emailFolio') return run(async () => { const to = prompt('Send the folio to this e-mail address:', FO.res.email || ''); if (to) { const x = await op('emailFolio', { id: FO.res.id, to }); toast('Folio e-mailed to ' + x.to + '.'); } });
  if (a === 'shift') return run(shiftBox);
  if (a === 'shiftOpen') return run(async () => { await op('shiftOpen', { cash: toCents($('#sh_cash').value) || 0 }); $('#modal').innerHTML = ''; await refresh(); toast('Shift opened.'); });
  if (a === 'shiftClose') return run(async () => { const v = $('#sh_counted').value.trim(); if (!v) throw new Error('Count the cash in the drawer and type the amount.'); const x = (await op('shiftClose', { counted: toCents(v) })).summary; await refresh(); const os = x.overShort; $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle">Shift closed</div><div id="shiftSum"><p><b>${esc(x.user)}</b> · ${stamp(x.openAt)} to ${stamp(x.closeAt)}</p>${shiftTable(x, x.openCash)}<p>Cash counted: <b>${money(x.counted)}</b> &nbsp; ${os === 0 ? 'The drawer balances.' : os > 0 ? 'Over by <b>' + money(os) + '</b>' : 'Short by <b>' + money(-os) + '</b>'}</p></div><div class="mfoot"><button class="btn" data-act="shiftPrint">Print</button><button class="btn green" data-act="closeModal">Done</button></div></div></div>`; });
  if (a === 'shiftPrint') return printHtml(letterHead() + '<h2>Cashier shift</h2>' + $('#shiftSum').innerHTML);
  if (a === 'coNew') return run(() => coOpen(0));
  if (a === 'coOpen') return run(() => coOpen(el.dataset.id));
  if (a === 'coSave') { try { const c = CO.company, v = k => $('#co_' + k).value; const r = await op('companySave', { id: c.id || 0, name: v('name'), contact: v('contact'), phone: v('phone'), email: v('email'), corpId: v('corpId'), address: v('address'), notes: v('notes'), rate: toCents(v('rate')) || 0, limit: toCents(v('limit')) || 0, directBill: $('#co_directBill').checked, inactive: $('#co_inactive').checked }); await refresh(); await coOpen(r.id); toast('Saved.'); } catch (x) { $('#co_err').textContent = x.message; } return; }
  if (a === 'coPayOpen') { $('#coPay').innerHTML = `<div class="card" style="margin-bottom:10px"><b>Receive a payment from ${esc(CO.company.name)}</b><div class="grid" style="margin-top:8px"><label>Paid by<select id="cp_code">${S.config.codes.filter(k => ['CASH', 'CRED'].includes(k.type) && !['GR', 'PO'].includes(k.code)).map(k => `<option value="${esc(k.code)}" ${k.code === 'CK' ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label><label class="c3">Amount<input id="cp_amt" inputmode="decimal" value="${CO.balance > 0 ? (CO.balance / 100).toFixed(2) : ''}"></label><label class="c3">Check # / note<input id="cp_note" maxlength="120"></label><label class="c2" style="justify-content:flex-end"><button class="btn sm green" data-act="coPaySave">Post</button></label></div></div>`; return; }
  if (a === 'coPaySave') return run(async () => { const amount = toCents($('#cp_amt').value); if (!(amount > 0)) throw new Error('Type an amount above zero.'); await op('arPay', { company: CO.company.id, code: $('#cp_code').value, amount, comment: $('#cp_note').value }); await refresh(); await coOpen(CO.company.id); toast('Payment posted.'); });
  if (a === 'coPrint') return printHtml(letterHead() + `<h2>Statement</h2><p><b>${esc(CO.company.name)}</b><br>${esc(CO.company.address || '')}</p>` + coLedger().replace(/<th>By<\/th>/, '<th></th>') + `<p>Statement date: ${dlong(B())}</p>`);
  if (a === 'grpNew') return run(() => grpOpen(0));
  if (a === 'grpOpen') return run(() => grpOpen(el.dataset.id));
  if (a === 'grpSave' || a === 'grpStatus') { try { const g = GR.group, v = k => $('#g_' + k).value, blocks = {}, rates = {}; document.querySelectorAll('[data-gb]').forEach(i => blocks[i.dataset.gb] = i.value); document.querySelectorAll('[data-gr]').forEach(i => rates[i.dataset.gr] = i.value.trim() ? toCents(i.value) : ''); if (a === 'grpStatus' && el.dataset.to === 'cancelled' && !confirm('Cancel this group? Its unsold rooms go back on sale. Reservations already made stay as they are.')) return; const r = await op('groupSave', { id: g.id || 0, name: v('name'), contact: v('contact'), phone: v('phone'), email: v('email'), notes: v('notes'), arrive: v('arrive'), depart: v('depart'), cutoff: v('cutoff'), companyId: +v('companyId') || 0, blocks, rates, ...(a === 'grpStatus' ? { status: el.dataset.to } : {}) }); await refresh(); await grpOpen(r.id); toast('Saved.'); } catch (x) { $('#g_err').textContent = x.message; } return; }
  if (a === 'grpAddRes') { const g = GR.group, t = S.config.types.find(t => (g.blocks || {})[t.code]) || S.config.types[0]; const arrive = g.arrive > B() ? g.arrive : B(); startWiz('new', { id: 0, status: 'reserved', arrive, depart: g.depart > arrive ? g.depart : addDays(arrive, 1), type: t.code, room: '', adults: 1, children: 0, rate: null, country: 'United States', guarantee: 'Credit card', source: 'Phone', groupId: g.id, companyId: g.companyId || 0 }, true); return; }
  if (a === 'grpPrint') return printHtml(letterHead() + `<h2>Rooming list: ${esc(GR.group.name)}</h2><p>${dlong(GR.group.arrive)} to ${dlong(GR.group.depart)}</p>` + grpMembers());
  if (a === 'postOpen') return postOpen(el.dataset.kind);
  if (a === 'postCancel') { $('#postBox').innerHTML = ''; return; }
  if (a === 'postSave') return postSave(el.dataset.kind);
  if (a === 'printFolio') return printFolio();
  if (a === 'folioBack') return run(() => openRes(FO.res.id));
  if (a === 'folioCheckOut') { ED = { mode: 'edit', r: FO.res }; await resAction('checkOut'); if (ED && FO) { const st = (S.res.find(x => x.id === FO.res.id) || {}).status; if (st === 'out') { $('#modal').innerHTML = ''; ED = null; FO = null; } } return; }
  if (a === 'tapeMove') { view.tapeStart = addDays(view.tapeStart, +el.dataset.n); return render(); }
  if (a === 'tapeToday') { view.tapeStart = B(); return render(); }
  if (a === 'listSort') { const c = el.dataset.col, s = view.listSort; view.listSort = s && s.col === c && s.dir === 'asc' ? { col: c, dir: 'desc' } : { col: c, dir: 'asc' }; return render(); }
  if (a === 'listDateStep') { view.listDate = addDays(view.listDate || B(), +el.dataset.n); return render(); }
  if (a === 'listDateGo') { const v = $('#listDate').value; if (!v) return toast('Pick a date.', true); view.listDate = v; return render(); }
  if (a === 'hkRange') return run(async () => { const f = $('#hkFrom').value.trim(), t = $('#hkTo').value.trim() || f; if (!f) throw new Error('Type the first room number.'); const nums = S.config.rooms.map(r => r.no).filter(no => no.localeCompare(f, 'en', { numeric: true }) >= 0 && no.localeCompare(t, 'en', { numeric: true }) <= 0); if (!nums.length) throw new Error('No rooms in that range.'); await op('roomCond', { rooms: nums, cond: el.dataset.cond }); await refresh(); toast(nums.length + ' rooms updated.'); });
  if (a === 'printHk') return printHtml(sheet('Housekeeping Check-off List', hkCheckHtml()));
  if (a === 'rep') { view.rep = el.dataset.rep; view.repLabel = el.dataset.label || ''; view.repStage = 'options'; view.opt = {}; view.from = view.to = B(); return render(); }
  if (a === 'repRun') return run(async () => {
    readOpts(); view.from = view.from || B(); if (!repFields().some(f => f.k === 'to') || !view.to || view.to < view.from) view.to = view.from;
    if (view.opt.csv) { const r = await buildReport(), base = r.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase(); downloadCsv(`${base}-${r.date}.csv`, r.csv); return toast('Saved ' + base + '.csv'); }
    view.repStage = 'result'; render(); });
  if (a === 'repBack') { if (view.repStage === 'result') view.repStage = 'options'; else { view.repStage = 'list'; view.rep = ''; } return render(); }
  if (a === 'repCat') { view.repCol = view.repCol || {}; view.repCol[el.dataset.cat] = !view.repCol[el.dataset.cat]; return render(); }
  if (a === 'repAll') { const off = !REPORT_CATS.every(c => (view.repCol || {})[c[0]]); view.repCol = {}; if (off) REPORT_CATS.forEach(c => view.repCol[c[0]] = true); return render(); }
  if (a === 'printRep') return printHtml($('#repOut').innerHTML);
  if (a === 'nightAudit') return nightAudit();
  if (a === 'setupTab') { view.setup = el.dataset.tab; return render(); }
  if (a === 'setupSave') return setupSave();
  if (a === 'pwSave') return run(async () => { await api('/account/password', { old: $('#pw_old').value, new: $('#pw_new').value }); $('#modal').innerHTML = ''; toast('Password changed.'); });
  if (a === 'userPick') { const u = JSON.parse(el.dataset.u); $('#u_email').value = u.email; $('#u_name').value = u.name; if ([...$('#u_role').options].some(o => o.value === u.role)) $('#u_role').value = u.role; $('#u_disabled').checked = u.disabled; return; }
  if (a === 'userSave') return run(async () => { const email = $('#u_email').value.trim(); const r = await api('/account/userSave', { email, name: $('#u_name').value, role: $('#u_role').value, disabled: $('#u_disabled').checked }); render(); if (r.link) linkBox('Login made. Send them their link', r, email); else toast('Login saved.'); });
  if (a === 'userInvite') return run(async () => { const email = $('#u_email').value.trim(); if (!email) throw new Error('Click a login in the list first.'); linkBox('New password link', await api('/account/userInvite', { email }), email); });
  if (a === 'blockNew') return blockNew();
  if (a === 'blockSave') return run(async () => { await op('blockAdd', { room: $('#b_room').value, start: $('#b_start').value, end: $('#b_end').value, reason: $('#b_reason').value }); $('#modal').innerHTML = ''; await refresh(); toast('Room is out of order.'); });
  if (a === 'blockRemove') return run(async () => { await op('blockRemove', { id: +el.dataset.id }); await refresh(); });
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.hk) return run(async () => { await op('hkSet', { room: t.dataset.room, [t.dataset.hk]: t.type === 'checkbox' ? t.checked : t.value }); S.roomstate[t.dataset.room] = { ...(S.roomstate[t.dataset.room] || {}), [t.dataset.hk]: t.type === 'checkbox' ? t.checked : t.value }; });
  if (t.id === 'tapeDate' && t.value) { view.tapeStart = t.value; return render(); }
  if (t.id === 'tapeFloor' || t.id === 'hkFloor') { view.floor = t.value; return render(); }
  if (t.closest && t.closest('.rform')) { readOpts(); if (t.id === 'repFrom') fillShiftUsers(); return; }
  resFieldChanged(t.id);
});
document.addEventListener('input', e => { if (e.target.id === 'scanTxt' && !scanState.manual) { clearTimeout(scanState.t); scanState.t = setTimeout(scanRead, 400); } if (['r_last', 'r_first', 'r_guestId'].includes(e.target.id)) dnrBanUpdate(); if (e.target.closest && e.target.closest('.rform')) readOpts(); if (e.target.id === 'q') { view.q = e.target.value; render(); } if (e.target.id === 'repSearch') { view.repQ = e.target.value; repFilter(); } });
document.addEventListener('focusout', e => { if (e.target.id === 'scanTxt' && !scanState.manual) setTimeout(() => { const t = $('#scanTxt'); if (t && !scanState.manual) t.focus(); }, 0); });   // the scanner types into this box, so keep it focused
document.addEventListener('mousemove', () => { const h = $('header'); if (h && h.classList.contains('nohover')) h.classList.remove('nohover'); });
const doFind = q => run(async () => { view.findQ = String(q || '').trim(); view.found = view.findQ ? (await api('/find?q=' + encodeURIComponent(view.findQ))).list : []; view.name = 'find'; render(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.id === 'find' || e.target.id === 'find2')) return doFind(e.target.value);
  if (e.key === 'Enter' && e.target.id === 'gs_q') return run(guestFind);
  if (e.key === 'Enter' && e.target.id === 'listDate' && e.target.value) { view.listDate = e.target.value; return render(); }
  if (e.key === 'Enter' && e.target.id === 'roomJump') { const no = e.target.value.trim(); if (!no) return; const g = S.res.find(r => r.status === 'inhouse' && String(r.room).toLowerCase() === no.toLowerCase()); if (!g) return toast('Nobody is checked in to room ' + no, true); e.target.value = ''; return run(() => openRes(g.id)); }
  if (e.key === 'Escape' && $('#modal').innerHTML && !$('#linkTxt')) { if ($('#scan')) scanClose(); else if ($('#hist')) $('#hist').remove(); else { $('#modal').innerHTML = ''; ED = null; FO = null; } }
});
// Keep every front-desk screen current: other computers' changes show up within 20 seconds.
setInterval(() => { if (S && !M && !$('#modal').innerHTML && document.visibilityState === 'visible' && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) refresh().catch(e => { if (e.status === 401 || e.status === 403) { S = null; showLogin(e.status === 403 ? e.message : ''); } }); }, 20000);
refresh().catch(e => showLogin(e.status === 403 ? e.message : ''));
