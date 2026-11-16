// Hotel Desk: the screens. Talks to the server at /hotel/api (cloud/src/hotel-core.js).
'use strict';
let S = null;                       // everything the server sent: config, rooms, reservations, balances
let view = { name: 'home', tapeStart: '', q: '', floor: '', rep: '', from: '', to: '', setup: 'property' };
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
  if (view.name === 'reports' && view.rep) drawReport();
}
function paint(hk, nav) {
  $('#app').innerHTML = `<header><div class="brand"><img src="icon.png" alt="">${esc(S.config.name)}</div>
    <nav>${nav.map(n => `<button data-nav="${n[0]}" class="${view.name === n[0] ? 'on' : ''}">${n[1]}</button>`).join('')}</nav>
    ${hk ? '' : '<input class="find" id="find" placeholder="Find guest or conf. #"><button class="btn sm green" data-act="newRes">+ Reservation</button><button class="btn sm teal" data-act="walkIn">Walk-In</button><button class="btn sm ' + (S.shift ? 'amber' : 'slate') + '" data-act="shift">' + (S.shift ? 'Shift open' : 'Open shift') + '</button>'}
    ${S.me.master ? '<button class="btn sm amber" data-act="mClose">◀ All hotels</button>' : ''}<div class="who"><b>${esc(dshort(B()))}</b>${esc(S.me.name)} · <a href="#" data-act="myPw" style="color:#8fb4ff">My password</a> · <a href="#" data-act="logout" style="color:#8fb4ff">Sign out</a></div></header>
    <main>${({ home: vHome, tape: vTape, arrivals: vArrivals, inhouse: vInHouse, departures: vDepartures, hk: vHk, reports: vReports, setup: vSetup, find: vFind, groups: vGroups, companies: vCompanies }[view.name] || vHome)()}</main>`;
}

/* ---------- Home ---------- */
function vHome() {
  const s = S.stats, d = B();
  const types = S.config.types.map(t => ({ t, n: availOfType(t.code, d, addDays(d, 1)) }));
  const dirtyVacant = S.config.rooms.filter(r => !inRoom(r.no) && cond(r.no) === 'D').length;
  return `<div class="tiles">
    <button class="tile blue" data-nav="arrivals">Arrivals<br><small>${s.arrivalsLeft} left to check in</small></button>
    <button class="tile green" data-nav="inhouse">In House<br><small>${s.sold} rooms</small></button>
    <button class="tile amber" data-nav="departures">Departures<br><small>${s.dueOut} due out</small></button>
    <button class="tile slate" data-nav="tape">Tape Chart</button>
    <button class="tile teal" data-nav="hk">Housekeeping<br><small>${dirtyVacant} vacant dirty</small></button>
    <button class="tile slate" data-nav="reports">Reports</button></div>
  <div class="stats">
    <div class="stat"><b>${s.occ}%</b><span>Today's occupancy</span></div><div class="stat"><b>${money(s.adr)}</b><span>ADR</span></div><div class="stat"><b>${money(s.revpar)}</b><span>RevPAR</span></div>
    <div class="stat"><b>${s.checkedIn}</b><span>Checked in today</span></div><div class="stat"><b>${s.arrivalsLeft}</b><span>Check-ins remaining</span></div><div class="stat"><b>${s.dueOut}</b><span>Departures remaining</span></div>
    <div class="stat"><b>${s.stayovers}</b><span>Stayovers</span></div><div class="stat"><b>${s.vacant}</b><span>Vacant rooms</span></div><div class="stat"><b>${s.ooo}</b><span>Out of order</span></div>
    <div class="stat"><b>${s.adults + s.children}</b><span>Guests in house (${s.adults} adults, ${s.children} children)</span></div></div>
  <h2>Rooms available tonight</h2>
  <div class="wrap"><table><tr><th>Type</th><th>Name</th><th class="num">Available</th><th class="num">Total</th><th class="num">Rate</th></tr>
  ${types.map(x => `<tr><td><b>${esc(x.t.code)}</b></td><td>${esc(x.t.name)}</td><td class="num"><b>${x.n}</b></td><td class="num">${S.config.rooms.filter(r => r.type === x.t.code).length}</td><td class="num">${money(x.t.rate)}</td></tr>`).join('')}</table></div>`;
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
    return `<tr><td class="rm">${esc(rm.no)}<small>${esc(rm.type)}</small> <span style="float:right">${condBtns(rm.no)}</span></td>${tds}</tr>`;
  }).join('');
  const un = active().filter(r => !r.room && r.arrive < end).sort((a, b) => a.arrive.localeCompare(b.arrive));
  return `<h1>Tape Chart</h1><div class="bar"><button class="btn sm" data-act="tapeMove" data-n="-7">◀ Week</button><input type="date" id="tapeDate" value="${view.tapeStart}"><button class="btn sm" data-act="tapeMove" data-n="7">Week ▶</button><button class="btn sm" data-act="tapeToday">Today</button>
    <select id="tapeFloor"><option value="">All floors</option>${floors.map(f => `<option ${view.floor === f ? 'selected' : ''} value="${esc(f)}">Floor ${esc(f)}</option>`).join('')}</select><span class="flex"></span><button class="btn sm red" data-act="blockNew">Out of order…</button></div>
  <div class="legend"><span><i style="background:var(--green)"></i>In house</span><span><i style="background:var(--amber)"></i>Due out</span><span><i style="background:var(--blue)"></i>Reserved</span><span><i style="background:#9aa6b8"></i>Checked out</span><span><i style="background:var(--red)"></i>Out of order</span><span class="hint">R = ready, C = clean, D = dirty. Click an empty day to book that room.</span></div>
  <div class="wrap" style="max-height:calc(100vh - 250px)"><table class="tape"><tr><th style="width:230px;position:sticky;left:0;z-index:3">Room</th>${days.map(d => { const dt = new Date(d + 'T00:00:00Z'); const we = [5, 6].includes(dt.getUTCDay()); return `<th class="${we ? 'we' : ''}" ${d === B() ? 'style="background:var(--green)"' : ''}>${dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })}<br>${dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}</th>`; }).join('')}</tr>${rows}</table></div>
  <h2>Reservations without a room (${un.length})</h2>
  ${un.length ? `<div class="wrap"><table><tr><th>Arrival</th><th>Guest</th><th>Type</th><th class="num">Nights</th><th>Conf. #</th></tr>${un.map(r => `<tr class="click" data-act="openRes" data-id="${r.id}"><td>${dshort(r.arrive)}</td><td><b>${esc(gname(r))}</b></td><td>${esc(r.type)}</td><td class="num">${nights(r.arrive, r.depart)}</td><td>${esc(r.conf)}</td></tr>`).join('')}</table></div>` : '<div class="hint">Every reservation in this window has a room.</div>'}`;
}

/* ---------- Lists ---------- */
function listTable(list, cols, emptyMsg) {
  const q = view.q.trim().toUpperCase(); if (q) list = list.filter(r => (gname(r) + ' ' + r.conf + ' ' + (r.room || '') + ' ' + (r.company || '')).toUpperCase().includes(q));
  const C = { guest: ['Guest Name', r => `<b>${esc(gname(r))}</b>${r.vip ? ' <span class="badge a">VIP</span>' : ''}`], city: ['City', r => esc(r.city)], zip: ['Postal Code', r => esc(r.zip)], gtd: ['Guarantee', r => esc(r.guarantee || '')], nights: ['Nights', r => nights(r.arrive, r.depart), 1],
    room: ['Room', r => r.room ? `<b>${esc(r.room)}</b>` : '<span class="badge r">None</span>'], type: ['Type', r => esc(r.type)], cond: ['Condition', r => r.room ? ({ R: '<span class="badge g">Ready</span>', C: '<span class="badge a">Clean</span>', D: '<span class="badge r">Dirty</span>' }[cond(r.room)]) : ''],
    rate: ['Rate', r => money(r.rate), 1], arrive: ['Arrival', r => dshort(r.arrive)], depart: ['Departure', r => dshort(r.depart)], company: ['Company', r => esc(r.company)], pay: ['Payment', r => esc(r.payType || '')], bal: ['Balance', r => money(S.bal[r.id] || 0), 1], conf: ['Conf. #', r => esc(r.conf)], status: ['Status', statusBadge] };
  return `<div class="bar"><input id="q" placeholder="Quick search" value="${esc(view.q)}" style="width:240px"><span class="hint">${list.length} ${list.length === 1 ? 'guest' : 'guests'}</span></div>` +
    (list.length ? `<div class="wrap"><table><tr>${cols.map(c => `<th class="${C[c][2] ? 'num' : ''}">${C[c][0]}</th>`).join('')}</tr>${list.map(r => `<tr class="click" data-act="openRes" data-id="${r.id}">${cols.map(c => `<td class="${C[c][2] ? 'num' : ''}">${C[c][1](r)}</td>`).join('')}</tr>`).join('')}</table></div>` : `<div class="empty">${emptyMsg}</div>`);
}
const byName = (a, b) => gname(a).localeCompare(gname(b));
const vArrivals = () => `<h1>Arrivals: ${esc(dlong(B()))}</h1>` + listTable(S.res.filter(r => r.status === 'reserved' && r.arrive <= B()).sort(byName), ['guest', 'city', 'zip', 'gtd', 'nights', 'room', 'type', 'cond', 'rate', 'company', 'conf'], 'No arrivals are waiting to check in.');
const vInHouse = () => '<h1>In House</h1>' + listTable(S.res.filter(r => r.status === 'inhouse').sort((a, b) => a.room.localeCompare(b.room, 'en', { numeric: true })), ['room', 'guest', 'city', 'type', 'rate', 'arrive', 'depart', 'company', 'pay', 'bal', 'status'], 'Nobody is checked in.');
const vDepartures = () => `<h1>Departures: ${esc(dlong(B()))}</h1>` + listTable(S.res.filter(r => r.status === 'inhouse' && r.depart <= B()).sort((a, b) => a.room.localeCompare(b.room, 'en', { numeric: true })), ['room', 'guest', 'type', 'arrive', 'depart', 'pay', 'bal', 'status'], 'No departures are left today.') +
  '<h2>Checked out today</h2>' + (() => { const l = S.res.filter(r => r.status === 'out' && r.coAt && new Date(r.coAt).getTime() > Date.now() - 36 * 36e5 && r.depart >= addDays(B(), -1)); return l.length ? `<div class="wrap"><table><tr><th>Room</th><th>Guest</th><th>Checked out</th><th class="num">Balance</th></tr>${l.map(r => `<tr class="click" data-act="openRes" data-id="${r.id}"><td><b>${esc(r.room)}</b></td><td>${esc(gname(r))}</td><td>${stamp(r.coAt)}</td><td class="num">${money(S.bal[r.id] || 0)}</td></tr>`).join('')}</table></div>` : '<div class="hint">Nobody yet.</div>'; })();
function vFind() {
  const l = view.found || [];
  return `<h1>Find: “${esc(view.findQ || '')}”</h1>` + (l.length ? `<div class="wrap"><table><tr><th>Guest</th><th>Status</th><th>Arrival</th><th>Departure</th><th>Room</th><th>Type</th><th>Phone</th><th>Conf. #</th></tr>${l.map(r => `<tr class="click" data-act="openRes" data-id="${r.id}"><td><b>${esc(gname(r))}</b></td><td>${statusBadge(r)}</td><td>${dshort(r.arrive)}</td><td>${dshort(r.depart)}</td><td>${esc(r.room)}</td><td>${esc(r.type)}</td><td>${esc(r.phone)}</td><td>${esc(r.conf)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Nothing found. Search by last name, phone number or confirmation number.</div>');
}

/* ---------- Housekeeping ---------- */
function service(no) { const g = inRoom(no); if (g) return g.depart <= B() ? 'Check Out' : 'Stay Over'; return cond(no) === 'D' ? 'Check Out' : 'None'; }
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
    <td><input type="checkbox" data-hk="dnd" data-room="${esc(rm.no)}" ${st.dnd ? 'checked' : ''}></td><td><input data-hk="note" data-room="${esc(rm.no)}" value="${esc(st.note || '')}" maxlength="200" style="min-height:34px;padding:4px 8px"></td></tr>`; }).join('')}</table></div>
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
  const A = (act, label, cls) => `<button class="btn sm ${cls || ''}" data-act="${act}">${label}</button>`;
  const acts = isNew ? '' : `<div class="acts" style="margin-bottom:6px">${A('folio', 'Guest Folio', 'blue')}${r.status === 'reserved' ? A('checkIn', 'Check In', 'green') + A('cancelRes', 'Cancel Reservation', 'red') + (r.arrive <= B() ? A('noShow', 'No Show') : '') : ''}${r.status === 'inhouse' ? A('checkOut', 'Check Out', 'amber') + A('undoCheckIn', 'Undo Check In') : ''}${r.status === 'out' ? A('undoCheckOut', 'Undo Check Out') : ''}${['cancelled', 'noshow'].includes(r.status) ? A('reinstate', 'Reinstate', 'green') : ''}${A('printReg', 'Print Registration Card')}${A('printConf', 'Print Confirmation')}${A('emailConf', 'E-mail Confirmation')}${A('viewChanges', 'View Changes')}</div>`;
  return `<div class="mback"><div class="mbox wide"><div class="mtitle">${isNew ? (mode === 'walkin' ? 'Walk-In' : 'New Reservation') : esc(gname(r))} ${isNew ? '' : statusBadge(r) + `<span class="hint">Conf. # ${esc(r.conf)} · Balance ${money(bal)}</span>`}</div>
  ${acts}
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
    <label class="c6">Special requests<input id="r_requests" maxlength="300" value="${esc(r.requests || '')}" ${locked ? 'disabled' : ''}></label><label class="c6">Notes<input id="r_notes" maxlength="1000" value="${esc(r.notes || '')}" ${locked ? 'disabled' : ''}></label></div>
  <p class="hint" style="margin:10px 0 0">Card numbers are never saved here, only the card type and last 4 digits. Run the card on your card terminal.</p>
  <div class="err" id="r_err"></div>
  <div class="mfoot"><button class="btn" data-act="closeModal">${locked ? 'Close' : 'Cancel'}</button>${locked ? '' : `<button class="btn ${mode === 'walkin' ? 'teal' : 'green'}" data-act="saveRes">${mode === 'walkin' ? 'Check In Now' : isNew ? 'Book Reservation' : 'Save Changes'}</button>`}</div></div></div>`;
}
function readForm() {
  const r = ED.r, v = k => { const el = $('#r_' + k); return el ? el.value : r[k]; };
  for (const k of ['last', 'first', 'phone', 'email', 'addr1', 'city', 'state', 'zip', 'guestId', 'vehicle', 'guarantee', 'payType', 'cardType', 'cardLast4', 'source', 'requests', 'notes', 'arrive', 'depart', 'type', 'room']) r[k] = v(k);
  r.adults = +v('adults') || 1; r.children = +v('children') || 0; r.groupId = +v('groupId') || 0; r.companyId = +v('companyId') || 0; r.pkg = v('pkg') || '';
  if (r.rateManual) { const c = toCents(v('rate')); if (isNaN(c)) r.rateManual = false; else r.rate = c; }
  for (const k of ['taxExempt', 'vip', 'noPost']) r[k] = $('#r_' + k).checked;
}
let drawing = false;   // replacing the window can fire a field's "change" again; ignore that second call
function drawRes() { if (drawing) return; drawing = true; try { $('#modal').innerHTML = resForm(ED.r, ED.mode); } finally { drawing = false; } }
function openNew(mode, room, date) {
  const rm = S.config.rooms.find(x => x.no === room), arrive = mode === 'walkin' ? B() : (date || B());
  ED = { mode, r: { id: 0, status: 'reserved', arrive, depart: addDays(arrive, 1), type: rm ? rm.type : S.config.types[0].code, room: room || '', adults: 1, children: 0, rate: null, guarantee: mode === 'walkin' ? 'Cash deposit' : 'Credit card', source: mode === 'walkin' ? 'Walk-In' : 'Phone' } };
  drawRes(); $('#r_last').focus();
}
async function openRes(id) { let r = S.res.find(x => x.id === +id); if (!r) { const f = await api('/folio?id=' + id); r = f.res; S.bal[r.id] = f.balance; } ED = { mode: 'edit', r: JSON.parse(JSON.stringify(r)) }; drawRes(); }
function resFieldChanged(id) {
  if (!ED || !/^r_/.test(id)) return; const r = ED.r, old = { type: r.type, a: r.arrive, d: r.depart }; const oldN = nights(r.arrive, r.depart); readForm();
  if (id === 'r_nights') r.depart = addDays(r.arrive, Math.max(1, +$('#r_nights').value || 1));
  if (id === 'r_arrive' && r.arrive) r.depart = addDays(r.arrive, oldN);
  if (id === 'r_rate') { const c = toCents($('#r_rate').value); r.rateManual = !isNaN(c); if (r.rateManual) r.rate = c; }
  if (id === 'r_type') r.room = '';
  if (['r_nights', 'r_arrive', 'r_depart', 'r_type', 'r_taxExempt', 'r_rate', 'r_room', 'r_groupId', 'r_companyId', 'r_pkg'].includes(id)) { if (r.room && !(r.arrive < r.depart && (roomFree(r.room, r.status === 'inhouse' && B() > r.arrive ? B() : r.arrive, r.depart, r.id)))) r.room = ''; drawRes(); }
}
async function saveRes() {
  readForm(); const r = ED.r, a = { ...r, rateManual: !!r.rateManual }; delete a.status; delete a.history; delete a.rates; if (!a.rateManual) delete a.rate;
  const go = async dirtyOk => { if (ED.mode === 'walkin') return op('walkIn', { ...a, dirtyOk }); return op('resSave', a); };
  try {
    let res; try { res = await go(false); } catch (e) { if (e.status === 412 && confirm(e.message)) res = await go(true); else throw e; }
    $('#modal').innerHTML = ''; ED = null; await refresh(); toast(r.id ? 'Saved.' : (res.conf ? 'Booked. Confirmation # ' + res.conf : 'Saved.'));
  } catch (e) { $('#r_err').textContent = e.message; }
}
async function resAction(act) {
  const r = ED.r, done = async msg => { await refresh(); toast(msg); const fresh = S.res.find(x => x.id === r.id); if (fresh) { ED.r = JSON.parse(JSON.stringify(fresh)); drawRes(); } else { $('#modal').innerHTML = ''; ED = null; } };
  try {
    if (act === 'checkIn') { readForm(); if (!r.room) throw new Error('Pick a room first.'); await op('resSave', (({ status, history, rates, ...a }) => { a.rateManual = !!a.rateManual; if (!a.rateManual) delete a.rate; return a; })(r)); try { await op('checkIn', { id: r.id }); } catch (e) { if (e.status === 412 && confirm(e.message)) await op('checkIn', { id: r.id, dirtyOk: true }); else throw e; } await done('Checked in to room ' + r.room + '.'); }
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
  const r = FO.res;
  $('#modal').innerHTML = `<div class="mback"><div class="mbox wide"><div class="mtitle">Guest Folio: ${esc(gname(r))} ${statusBadge(r)} <span class="hint">Room ${esc(r.room || 'none')} · ${dshort(r.arrive)} to ${dshort(r.depart)} · Conf. # ${esc(r.conf)}</span></div>
    <div class="acts" style="margin-bottom:10px"><button class="btn sm blue" data-act="postOpen" data-kind="charge">Post Charge</button><button class="btn sm green" data-act="postOpen" data-kind="payment">Post Payment</button><button class="btn sm" data-act="postOpen" data-kind="adjust">Post Adjustment</button><button class="btn sm" data-act="printFolio">Print</button><button class="btn sm" data-act="emailFolio">E-mail Folio</button>${r.status === 'inhouse' ? '<button class="btn sm amber" data-act="folioCheckOut">Check Out</button>' : ''}</div>
    <div id="postBox"></div><div class="wrap" style="max-height:52vh">${folioTable(FO)}</div>
    <div class="mfoot"><button class="btn" data-act="folioBack">Back to reservation</button><button class="btn" data-act="closeModal">Close</button></div></div></div>`;
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
function printReg(r) { printHtml(letterHead() + `<h2>Guest Registration</h2><table><tr><td><b>Guest</b></td><td>${esc(gname(r))}</td><td><b>Conf. #</b></td><td>${esc(r.conf)}</td></tr><tr><td><b>Address</b></td><td>${esc([r.addr1, r.city, r.state, r.zip].filter(Boolean).join(', '))}</td><td><b>Phone</b></td><td>${esc(r.phone)}</td></tr><tr><td><b>Arrival</b></td><td>${dlong(r.arrive)}</td><td><b>Departure</b></td><td>${dlong(r.depart)}</td></tr><tr><td><b>Room</b></td><td>${esc(r.room || '')} (${esc(r.type)})</td><td><b>Rate</b></td><td>${money(r.rate)} plus tax, per night</td></tr><tr><td><b>Guests</b></td><td>${r.adults} adults, ${r.children} children</td><td><b>Vehicle</b></td><td>${esc(r.vehicle)}</td></tr><tr><td><b>Company</b></td><td>${esc(r.company)}</td><td><b>E-mail</b></td><td>${esc(r.email)}</td></tr></table><p>Check-out time is ${esc(S.config.checkoutTime)}.</p><p>${esc(S.config.regText)}</p><p style="margin-top:40px">Guest signature: ______________________________________ &nbsp; Date: ______________</p>`); }
function printConf(r) { printHtml(letterHead() + `<h2>Reservation Confirmation</h2><p>Dear ${esc(r.first || '')} ${esc(r.last)},</p><p>Thank you for choosing ${esc(S.config.name)}. Your reservation is confirmed.</p><table><tr><td><b>Confirmation #</b></td><td>${esc(r.conf)}</td></tr><tr><td><b>Arrival</b></td><td>${dlong(r.arrive)} (check-in from ${esc(S.config.checkinTime)})</td></tr><tr><td><b>Departure</b></td><td>${dlong(r.depart)} (check-out by ${esc(S.config.checkoutTime)})</td></tr><tr><td><b>Room type</b></td><td>${esc((S.config.types.find(t => t.code === r.type) || {}).name || r.type)}</td></tr><tr><td><b>Guests</b></td><td>${r.adults} adults, ${r.children} children</td></tr><tr><td><b>Rate</b></td><td>${money(r.rate)} plus tax, per night</td></tr><tr><td><b>Guarantee</b></td><td>${esc(r.guarantee || '')}</td></tr></table><p>We look forward to your stay.</p>`); }
function printFolio() { const r = FO.res; printHtml(letterHead() + `<h2>Guest Folio</h2><p><b>${esc(gname(r))}</b><br>${esc([r.addr1, r.city, r.state, r.zip].filter(Boolean).join(', '))}<br>Room ${esc(r.room)} · ${dshort(r.arrive)} to ${dshort(r.depart)} · Conf. # ${esc(r.conf)}${r.company ? '<br>' + esc(r.company) : ''}</p>` + folioTable(FO) + '<p style="margin-top:30px">Guest signature: ______________________________________</p>'); }

/* ---------- Reports ---------- */
const REPORTS = [['arrivals', 'Arrival List'], ['departures', 'Departure List'], ['inhouse', 'In House List'], ['vacant', 'Vacant Room List'], ['hkcheck', 'Housekeeping Check-off List'], ['ledger', 'Guest Ledger (balances)'], ['future', 'Future Availability (14 days)'],
  ['stats', 'Hotel Statistics', 1], ['closeout', 'Final Transaction Closeout', 1], ['shift', 'Shift Reconciliation', 1], ['journal', 'Hotel Journal Detail', 1], ['history', 'No Show, Cancellation and Departed List', 1], ['araging', 'Accounts Receivable Aging'], ['grouppickup', 'Group Pickup'], ['shifts', 'Cashier Shifts', 1]];
function vReports() {
  if (!view.from) view.from = view.to = B();
  const needDates = (REPORTS.find(r => r[0] === view.rep) || [])[2];
  return `<h1>Reports</h1><div class="bar">${boss() ? '<button class="btn red" data-act="nightAudit">Run Night Audit…</button>' : ''}<span class="hint">Business date ${dlong(B())}</span></div>
  <div class="acts" style="margin-bottom:12px">${REPORTS.map(r => `<button class="btn sm ${view.rep === r[0] ? 'blue' : ''}" data-act="rep" data-rep="${r[0]}">${r[1]}</button>`).join('')}</div>
  ${view.rep ? `<div class="bar">${needDates ? `<span class="hint">From</span><input type="date" id="repFrom" value="${view.from}"><span class="hint">to</span><input type="date" id="repTo" value="${view.to}">` : ''}<button class="btn sm" data-act="printRep">Print</button></div><div class="wrap" id="repOut" style="padding:12px"><div class="hint">Loading…</div></div>` : '<div class="empty">Pick a report.</div>'}`;
}
async function drawReport() {
  const out = $('#repOut'); if (!out) return; const title = REPORTS.find(r => r[0] === view.rep)[1]; let h = '';
  const T = (heads, rows) => `<table><tr>${heads.map(x => `<th class="${/^#/.test(x) ? 'num' : ''}">${x.replace(/^#/, '')}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${/^#/.test(heads[i]) ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${heads.length}" class="empty">Nothing to show.</td></tr>`}</table>`;
  const sortRoom = (a, b) => String(a.room || a.no).localeCompare(String(b.room || b.no), 'en', { numeric: true });
  try {
    if (view.rep === 'arrivals') h = T(['Guest', 'Room', 'Type', '#Nights', '#Rate', 'Guarantee', 'Phone', 'Conf. #'], S.res.filter(r => r.status === 'reserved' && r.arrive <= B()).sort(byName).map(r => [esc(gname(r)), esc(r.room), esc(r.type), nights(r.arrive, r.depart), money(r.rate), esc(r.guarantee), esc(r.phone), esc(r.conf)]));
    else if (view.rep === 'departures') h = T(['Room', 'Guest', 'Arrival', 'Departure', '#Balance'], S.res.filter(r => r.status === 'inhouse' && r.depart <= B()).sort(sortRoom).map(r => [esc(r.room), esc(gname(r)), dshort(r.arrive), dshort(r.depart), money(S.bal[r.id] || 0)]));
    else if (view.rep === 'inhouse') h = T(['Room', 'Guest', 'Type', 'Arrival', 'Departure', '#Adults', '#Children', '#Rate', '#Balance'], S.res.filter(r => r.status === 'inhouse').sort(sortRoom).map(r => [esc(r.room), esc(gname(r)), esc(r.type), dshort(r.arrive), dshort(r.depart), r.adults, r.children, money(r.rate), money(S.bal[r.id] || 0)]));
    else if (view.rep === 'vacant') h = T(['Room', 'Type', 'Condition', 'Arriving today'], S.config.rooms.filter(r => !inRoom(r.no) && !isOOO(r.no, B())).map(r => { const a = S.res.find(x => x.status === 'reserved' && x.room === r.no && x.arrive <= B()); return [esc(r.no), esc(r.type), { R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(r.no)], a ? esc(gname(a)) : '']; }));
    else if (view.rep === 'hkcheck') h = hkCheckHtml();
    else if (view.rep === 'ledger') { const l = S.res.filter(r => (S.bal[r.id] || 0) !== 0).sort(sortRoom); h = T(['Room', 'Guest', 'Status', 'Arrival', 'Departure', '#Balance'], l.map(r => [esc(r.room), esc(gname(r)), r.status, dshort(r.arrive), dshort(r.depart), money(S.bal[r.id])])) + `<p><b>Total: ${money(l.reduce((s, r) => s + S.bal[r.id], 0))}</b></p>`; }
    else if (view.rep === 'future') { const days = []; for (let i = 0; i < 14; i++) days.push(addDays(B(), i)); h = T(['Type'].concat(days.map(d => '#' + dshort(d).replace(/\/\d+$/, ''))), S.config.types.map(t => [`<b>${esc(t.code)}</b>`].concat(days.map(d => availOfType(t.code, d, addDays(d, 1))))).concat([['<b>Hotel</b>'].concat(days.map(d => '<b>' + S.config.types.reduce((s, t) => s + availOfType(t.code, d, addDays(d, 1)), 0) + '</b>'))])); }
    else {
      const R = await api(`/report?name=${view.rep}&from=${view.from}&to=${view.to}`);
      if (view.rep === 'stats') h = T(['Date', '#Rooms', '#Sold', '#Out of order', '#Occupancy %', '#Room revenue', '#ADR', '#RevPAR', '#No shows'], R.rows.map(x => [dshort(x.date) + (x.live ? ' (today so far)' : ''), x.total, x.sold, x.ooo, x.occ, money(x.roomRev), money(x.adr), money(x.revpar), x.noShows == null ? '' : x.noShows]));
      else if (view.rep === 'closeout') { const tot = R.rows.reduce((s, x) => s + x.total, 0); h = T(['Code', 'Description', '#Count', '#Total'], R.rows.map(x => [esc(x.code), esc(x.descr), x.cnt, money(x.total)])) + `<p><b>Charges less payments: ${money(tot)}</b></p>`; }
      else if (view.rep === 'shift') h = T(['User', 'Code', 'Description', '#Count', '#Total'], R.rows.map(x => [esc(x.user), esc(x.code), esc(x.descr), x.cnt, money(x.total)]));
      else if (view.rep === 'journal') h = T(['Item #', 'Date', 'Posted', 'Room', 'Guest', 'Description', 'Comments', 'By', '#Amount'], R.rows.map(l => [l.id, dshort(l.bdate), stamp(l.at), esc(l.room), esc(l.name), esc(l.descr), esc(l.comment), esc(l.user), money(l.amount)]));
      else if (view.rep === 'araging') h = T(['Company', '#0–30 days', '#31–60', '#61–90', '#Over 90', '#Unapplied credit', '#Balance'], R.rows.map(x => [esc(x.name), money(x.cur), money(x.d30), money(x.d60), money(x.d90), money(x.credit), '<b>' + money(x.balance) + '</b>'])) + `<p><b>Total owed: ${money(R.rows.reduce((s, x) => s + x.balance, 0))}</b></p>`;
      else if (view.rep === 'grouppickup') h = T(['Group', 'Arrival', 'Departure', 'Cut-off', '#Blocked', '#Picked up', '#Left', '#Room revenue', 'Status'], R.rows.map(x => [esc(x.name), dshort(x.arrive), dshort(x.depart), dshort(x.cutoff), x.blocked, x.picked, x.left, money(x.revenue), x.status]));
      else if (view.rep === 'shifts') h = T(['Cashier', 'Opened', 'Closed', '#Opening cash', '#Cash taken in', '#Expected', '#Counted', '#Over / short'], R.rows.map(x => [esc(x.user), stamp(x.openAt), x.closeAt ? stamp(x.closeAt) : '<span class="badge a">Open</span>', money(x.openCash), x.closeAt ? money(x.cashIn) : '', x.closeAt ? money(x.expected) : '', x.closeAt ? money(x.counted) : '', x.closeAt ? (x.overShort < 0 ? '(' + money(-x.overShort) + ')' : money(x.overShort)) : '']));
      else if (view.rep === 'history') { const L = (t, l) => `<h2>${t} (${l.length})</h2>` + T(['Guest', 'Arrival', 'Departure', 'Type', 'Room', '#Rate', '#Balance', 'Conf. #'], l.map(r => [esc(r.name), dshort(r.arrive), dshort(r.depart), esc(r.type), esc(r.room), money(r.rate), money(r.bal), esc(r.conf)])); h = L('No shows', R.noshow) + L('Cancellations', R.cancelled) + L('Departed', R.out); }
    }
  } catch (e) { h = `<div class="err">${esc(e.message)}</div>`; }
  out.innerHTML = `<h2 style="margin-top:0">${title}</h2>` + h; out.dataset.title = title;
}
function hkCheckHtml() { return `<table><tr><th>Room</th><th>Type</th><th>Status</th><th>Condition</th><th>Service</th><th>Housekeeper</th><th>Notes</th><th>Done</th></tr>${S.config.rooms.map(rm => { const st = S.roomstate[rm.no] || {}; return `<tr><td><b>${esc(rm.no)}</b></td><td>${esc(rm.type)}</td><td>${inRoom(rm.no) ? 'Occupied' : 'Vacant'}</td><td>${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(rm.no)]}</td><td>${service(rm.no)}${st.dnd ? ' (DND)' : ''}</td><td>${esc(st.hk || '')}</td><td>${esc(st.note || '')}</td><td>☐</td></tr>`; }).join('')}</table>`; }
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

/* ---------- Cashier shift ---------- */
async function shiftBox() {
  if (!S.shift) { $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle">Open my cashier shift</div><div class="grid"><label class="c12">Cash in the drawer now<input id="sh_cash" inputmode="decimal" value="0.00"></label></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="shiftOpen">Open shift</button></div></div></div>`; $('#sh_cash').select(); return; }
  const x = await op('shiftPeek', {});
  $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle">My cashier shift <span class="hint">opened ${stamp(x.shift.openAt)}</span></div>${shiftTable(x, x.shift.openCash)}<div class="grid" style="margin-top:12px"><label class="c6">Cash counted in the drawer<input id="sh_counted" inputmode="decimal" placeholder="${(x.expected / 100).toFixed(2)}"></label></div><div class="mfoot"><button class="btn" data-act="closeModal">Keep working</button><button class="btn amber" data-act="shiftClose">Close shift</button></div></div></div>`;
}
const shiftTable = (x, openCash) => `<div class="wrap"><table><tr><th>Payment type</th><th class="num">Count</th><th class="num">Total</th></tr>${x.by.map(b => `<tr><td>${esc(b.name)}</td><td class="num">${b.cnt}</td><td class="num">${money(b.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No payments taken yet.</td></tr>'}<tr><td colspan="2" class="num">Opening cash</td><td class="num">${money(openCash)}</td></tr><tr><td colspan="2" class="num">Cash taken in</td><td class="num">${money(x.cashIn)}</td></tr><tr><td colspan="2" class="num"><b>Cash that should be in the drawer</b></td><td class="num"><b>${money(x.expected)}</b></td></tr></table></div>`;

/* ---------- Scan ID: a 2D barcode scanner reads the back of a driver's license and types it here ---------- */
function scanBox() { readForm(); $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="scan"><div class="mbox sm"><div class="mtitle">Scan ID</div><p class="hint">Click in the box, then scan the barcode on the <b>back</b> of the driver's license or state ID with your 2D barcode scanner.</p><textarea id="scanTxt" rows="5" autocomplete="off" spellcheck="false" style="font-size:12px"></textarea><div class="err" id="scanErr"></div><div class="mfoot"><button class="btn" data-act="scanCancel">Cancel</button><button class="btn green" data-act="scanUse">Fill in the guest</button></div></div></div>`); $('#scanTxt').focus(); }
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
  const nav = e.target.closest('[data-nav]'); if (nav) { view.name = nav.dataset.nav; view.q = ''; render(); return; }
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
  if (a === 'newRes') return openNew('new', el.dataset.room, el.dataset.date);
  if (a === 'walkIn') return openNew('walkin');
  if (a === 'openRes') return run(() => openRes(el.dataset.id));
  if (a === 'closeModal') { $('#modal').innerHTML = ''; ED = null; FO = null; CO = null; GR = null; return; }
  if (a === 'closeHist') { $('#hist').remove(); return; }
  if (a === 'saveRes') return saveRes();
  if (['checkIn', 'checkOut', 'undoCheckIn', 'undoCheckOut', 'cancelRes', 'noShow', 'reinstate', 'folio', 'viewChanges', 'printReg', 'printConf'].includes(a)) return resAction(a);
  if (a === 'rateStd') { readForm(); ED.r.rateManual = false; return drawRes(); }
  if (a === 'scanId') return scanBox();
  if (a === 'scanCancel') { $('#scan').remove(); return; }
  if (a === 'scanUse') { const g = parseLicense($('#scanTxt').value); if (!g.last) { $('#scanErr').textContent = 'That did not read as a license barcode. Scan the big barcode on the back of the card.'; return; } Object.assign(ED.r, Object.fromEntries(Object.entries(g).filter(x => x[1]))); return drawRes(); }
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
  if (a === 'grpAddRes') { const g = GR.group, t = S.config.types.find(t => (g.blocks || {})[t.code]) || S.config.types[0]; const arrive = g.arrive > B() ? g.arrive : B(); ED = { mode: 'new', r: { id: 0, status: 'reserved', arrive, depart: g.depart > arrive ? g.depart : addDays(arrive, 1), type: t.code, room: '', adults: 1, children: 0, rate: null, guarantee: 'Credit card', source: 'Phone', groupId: g.id, companyId: g.companyId || 0 } }; drawRes(); $('#r_last').focus(); return; }
  if (a === 'grpPrint') return printHtml(letterHead() + `<h2>Rooming list: ${esc(GR.group.name)}</h2><p>${dlong(GR.group.arrive)} to ${dlong(GR.group.depart)}</p>` + grpMembers());
  if (a === 'postOpen') return postOpen(el.dataset.kind);
  if (a === 'postCancel') { $('#postBox').innerHTML = ''; return; }
  if (a === 'postSave') return postSave(el.dataset.kind);
  if (a === 'printFolio') return printFolio();
  if (a === 'folioBack') return run(() => openRes(FO.res.id));
  if (a === 'folioCheckOut') { ED = { mode: 'edit', r: FO.res }; await resAction('checkOut'); if (ED && FO) { const st = (S.res.find(x => x.id === FO.res.id) || {}).status; if (st === 'out') { $('#modal').innerHTML = ''; ED = null; FO = null; } } return; }
  if (a === 'tapeMove') { view.tapeStart = addDays(view.tapeStart, +el.dataset.n); return render(); }
  if (a === 'tapeToday') { view.tapeStart = B(); return render(); }
  if (a === 'hkRange') return run(async () => { const f = $('#hkFrom').value.trim(), t = $('#hkTo').value.trim() || f; if (!f) throw new Error('Type the first room number.'); const nums = S.config.rooms.map(r => r.no).filter(no => no.localeCompare(f, 'en', { numeric: true }) >= 0 && no.localeCompare(t, 'en', { numeric: true }) <= 0); if (!nums.length) throw new Error('No rooms in that range.'); await op('roomCond', { rooms: nums, cond: el.dataset.cond }); await refresh(); toast(nums.length + ' rooms updated.'); });
  if (a === 'printHk') return printHtml(letterHead() + `<h2>Housekeeping Check-off List: ${dlong(B())}</h2>` + hkCheckHtml());
  if (a === 'rep') { view.rep = el.dataset.rep; return render(); }
  if (a === 'printRep') return printHtml(letterHead() + $('#repOut').innerHTML);
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
  if (t.id === 'repFrom' || t.id === 'repTo') { view.from = $('#repFrom').value || B(); view.to = $('#repTo').value || view.from; if (view.to < view.from) view.to = view.from; return render(); }
  resFieldChanged(t.id);
});
document.addEventListener('input', e => { if (e.target.id === 'q') { view.q = e.target.value; render(); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'find') return run(async () => { view.findQ = e.target.value.trim(); view.found = (await api('/find?q=' + encodeURIComponent(view.findQ))).list; view.name = 'find'; render(); });
  if (e.key === 'Escape' && $('#modal').innerHTML && !$('#linkTxt')) { if ($('#hist')) $('#hist').remove(); else { $('#modal').innerHTML = ''; ED = null; FO = null; } }
});
// Keep every front-desk screen current: other computers' changes show up within 20 seconds.
setInterval(() => { if (S && !M && !$('#modal').innerHTML && document.visibilityState === 'visible' && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) refresh().catch(e => { if (e.status === 401 || e.status === 403) { S = null; showLogin(e.status === 403 ? e.message : ''); } }); }, 20000);
refresh().catch(e => showLogin(e.status === 403 ? e.message : ''));
