// Hotel Desk: the screens. Talks to the server at /hotel/api (cloud/src/hotel-core.js).
'use strict';
let S = null;                       // everything the server sent: config, rooms, reservations, balances
let view = { name: 'home', tapeStart: '', q: '', floor: '', rep: '', from: '', to: '', opt: {}, setup: '', listDate: '', listSort: null };
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
const woOpen = no => (S.workorders || []).some(w => w.status === 'open' && w.room === no);   // does this room have an open work order?
const wrench = no => woOpen(no) ? ' <span class="wo" title="This room has an open work order">🔧</span>' : '';
function roomFree(no, from, to, exceptId) {
  if (S.blocks.some(b => b.room === no && b.start < to && from <= b.end)) return false;
  return !active().some(r => r.id !== exceptId && r.room === no && r.arrive < to && from < r.depart);
}
function rateFor(type, d) { const t = S.config.types.find(x => x.code === type); let v = t ? t.rate : 0; const dow = new Date(d + 'T00:00:00Z').getUTCDay(); for (const r of S.config.rateRules || []) if (r.from <= d && d <= r.to && (r.type === '*' || r.type === type) && (!r.days || !r.days.length || r.days.includes(dow))) v = r.rate; return v; }
// What the nights of a stay cost at the standard rate (group rate first, then the company's rate, then rates by date).
function quote(r) { const g = r.groupId && S.groups.find(x => x.id === +r.groupId), co = r.companyId && S.companies.find(x => x.id === +r.companyId), out = []; for (let d = r.arrive; d < r.depart; d = addDays(d, 1)) out.push(g && g.rates && g.rates[r.type] > 0 ? g.rates[r.type] : co && co.rate > 0 ? co.rate : rateFor(r.type, d)); return out; }
// Has the group let go of its unsold rooms for night d? Rolling cut-off: each night goes back on sale cutoffDays before it. Otherwise the fixed date.
const grpGone = (g, d) => g.cutoffDays != null ? B() > addDays(d, -g.cutoffDays) : !!g.cutoff && g.cutoff < B();
const cutTxt = g => g.cutoffDays != null ? 'Rolling, ' + g.cutoffDays + (g.cutoffDays === 1 ? ' day' : ' days') : dshort(g.cutoff);
function groupHold(type, d, exceptGroup) { let n = 0; for (const g of S.groups) { if (g.id === exceptGroup || g.status === 'cancelled' || !(g.arrive <= d && d < g.depart) || grpGone(g, d)) continue; const blk = (g.blocks || {})[type] || 0; if (blk) n += Math.max(0, blk - active().filter(r => r.groupId === g.id && r.type === type && r.arrive <= d && d < r.depart).length); } return n; }
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
  else if (mode === 'forgot') h = `<p class="hint">Type your e-mail address. We'll send you a link to choose a new password.</p><label>E-mail address<input id="lu" type="email" autocomplete="username" required></label><button class="btn blue" type="submit">Send the link</button><p class="hint" style="margin-top:14px">Cannot get e-mail? <a href="#" data-act="recoverMode">Use a recovery code</a></p><p class="hint"><a href="#" data-act="loginBack">Back to sign in</a></p>`;
  else if (mode === 'recover') h = `<p class="hint">Type your e-mail address, the recovery code you wrote down when you chose your password, and a new password.</p><label>E-mail address<input id="lu" type="email" autocomplete="username" required></label><label>Recovery code<input id="lc" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7Q2-M9XD-4TPA" required></label>${pw('New password (at least 8 characters)', 'new-password')}<label>Repeat new password<input id="lp2" type="password" autocomplete="new-password" required></label><button class="btn blue" type="submit">Choose the new password</button><p class="hint" style="margin-top:14px"><a href="#" data-act="loginBack">Back to sign in</a></p>`;
  else if (mode === 'sent') h = `<p>If <b>${esc(msg)}</b> has a Hotel Desk login, a link is on its way. It works for 60 minutes. Check the spam folder too.</p><p class="hint">No e-mail after a few minutes? Ask your manager (or the hotel's owner) to send you a new link from Setup › Logins.</p><p class="hint" style="margin-top:14px"><a href="#" data-act="loginBack">Back to sign in</a></p>`;
  else if (mode === 'token') h = `<p class="hint">${tk.kind === 'invite' ? 'Welcome, ' + esc(tk.name) + '. Choose a password for your Hotel Desk login.' : 'Choose a new password.'}</p><label>E-mail address<input value="${esc(tk.email)}" autocomplete="username" disabled></label>${pw('New password (at least 8 characters)', 'new-password')}<label>Type it again<input id="lp2" type="password" autocomplete="new-password" required></label><button class="btn blue" type="submit">Save password and sign in</button>`;
  else h = `<p class="hint">Sign in to the front desk.</p><label>E-mail address<input id="lu" type="email" autocomplete="username" required></label>${pw('Password', 'current-password')}<button class="btn blue" type="submit">Sign in</button><p class="hint" style="margin-top:14px"><a href="#" data-act="forgot">Forgot your password?</a></p>`;
  $('#app').innerHTML = `<form class="login" id="lf"><h1>Hotel Desk</h1>${h}<div class="err" id="le">${mode === 'sent' ? '' : esc(msg || '')}</div></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); $('#le').textContent = '';
    try {
      if (mode === 'setup') await api('/master/setup', { email: $('#lu').value, password: $('#lp').value, name: $('#ln').value });
      else if (mode === 'forgot') { const em = $('#lu').value.trim(); await api('/auth/forgot', { email: em }); return showLogin(em, 'sent'); }
      else if (mode === 'recover') { if ($('#lp').value !== $('#lp2').value) throw new Error('The two passwords are not the same.'); const r = await api('/auth/recover', { email: $('#lu').value, code: $('#lc').value, password: $('#lp').value, password2: $('#lp2').value }); return showRecovery(r.recoveryCode, $('#lu').value.trim().toLowerCase(), true); }
      else if (mode === 'token') { if ($('#lp').value !== $('#lp2').value) throw new Error('The two passwords are not the same.'); const r = await api('/auth/reset', { token, password: $('#lp').value }); history.replaceState(null, '', location.pathname); if (r.recoveryCode) return showRecovery(r.recoveryCode, tk.email, true); }
      else await api('/auth/login', { email: $('#lu').value, password: $('#lp').value });
      await refresh();
    } catch (x) { if (x.status === 403 && /turned off/.test(x.message)) history.replaceState(null, '', location.pathname); $('#le').textContent = x.message; }
  };
}
// The recovery code is shown ONCE. Continue stays off until "I wrote it down" is ticked.
function showRecovery(code, email, signIn) {
  $('#modal').innerHTML = `<div class="mback"><div class="mbox sm" id="rcScreen"><div class="mtitle">Your recovery code</div><p><b>Write it down and keep it somewhere safe.</b> If you forget your password, you can use it to choose a new one. It works once.</p><div class="rccode" id="rcCode">${esc(code)}</div><div class="mfoot" style="justify-content:center"><button class="btn" data-act="rcCopy">Copy</button><button class="btn" data-act="rcPrint">Print</button></div><label class="chk"><input type="checkbox" id="rcOk">I wrote it down</label><p class="hint">We cannot show this code again. A new one can be made any time from My password.</p><div class="mfoot"><button class="btn blue" id="rcGo" data-act="rcDone" disabled>Continue</button></div></div></div>`;
  $('#rcOk').onchange = () => { $('#rcGo').disabled = !$('#rcOk').checked; }; RCODE = { code, email, signIn };
}
let RCODE = null, rcLater = false;
const needCode = () => { const u = S ? S.me : M && M.user; return !!(u && u.recovery === false && !rcLater); };
const rcBanner = () => needCode() ? '<div class="rcbanner"><span><b>Make a recovery code.</b> It lets you choose a new password if you cannot get e-mail.</span><span><button class="btn sm blue" data-act="rcAsk">Make it now</button> <button class="btn sm" data-act="rcLater">Later</button></span></div>' : '';
function rcBox() { $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle">Make a new recovery code</div><p class="hint">A new code replaces the old one. Type your current password to go on.</p><div class="grid"><label class="c12">Current password<input type="password" id="rc_pw" autocomplete="current-password"></label></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="rcMake">Make a new recovery code</button></div></div></div>`; }
function linkBox(title, r, email) {   // shows the "choose your password" link after a login is made
  $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle">${esc(title)}</div><p>${r.sent ? 'We e-mailed the link to <b>' + esc(email) + '</b>.' : '<b>The e-mail could not be sent</b> (e-mail is not set up yet, or the address refused it).'} ${r.sent ? 'You can also copy it and send it yourself:' : 'Copy this link and send it to ' + esc(email) + ' yourself:'}</p><textarea id="linkTxt" rows="3" readonly style="font-family:Consolas,monospace;font-size:13px">${esc(r.link)}</textarea><p class="hint">The link lets that person choose their password. It works for 7 days, one time. Send it only to them.</p><div class="mfoot"><button class="btn blue" data-act="copyLink">Copy link</button><button class="btn" data-act="closeModal">Done</button></div></div></div>`;
}
function pwBox() { $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle">My password</div><div class="grid"><label class="c12">Current password<input type="password" id="pw_old" autocomplete="current-password"></label><label class="c12">New password (8 or more)<input type="password" id="pw_new" autocomplete="new-password"></label></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="pwSave">Change password</button></div><p class="hint" style="margin-top:14px">Recovery code: <b>${(S ? S.me : M.user).recovery ? 'you have one' : 'not made yet'}</b> · <a href="#" data-act="rcAsk">Make a new recovery code</a></p></div></div>`; }

/* ---------- master account: the hotels you sell to ---------- */
async function masterLoad(user) { const r = await api('/master/hotels'); M = { user: user || (M && M.user), hotels: r.hotels, mail: r.mail }; masterDraw(); }
function masterDraw() {
  const today = localToday(), on = M.hotels.filter(h => h.status === 'active').length;
  $('#app').innerHTML = `<header><div class="brand"><img src="icon.png" alt="">Hotel Desk · Master account</div><nav></nav><div class="who"><b>${esc(M.user.name)}</b><a href="#" data-act="myPw" style="color:#8fb4ff">My password</a> · <a href="#" data-act="logout" style="color:#8fb4ff">Sign out</a></div></header>
  <main>${rcBanner()}<h1>Hotels</h1><div class="bar"><button class="btn green" data-act="mHotelNew">+ Add a hotel</button><button class="btn teal" data-act="mTestHotel">+ Test hotel (55 rooms)</button><button class="btn" data-act="mMail">E-mail settings${M.mail.user && M.mail.hasPass ? '' : ' (not set up)'}</button><span class="hint">${M.hotels.length} hotels · ${on} on · ${M.hotels.length - on} off</span></div>
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
  const hk = S.me.role === 'hk'; if (hk && view.name !== 'wo') view.name = 'hk';
  const nav = NAV.filter(n => hk ? n[0] === 'hk' : n[0] !== 'setup' || boss());
  if (!boss() && view.name === 'setup') view.name = 'home';
  if (view.name === 'members' && !rwOn()) view.name = 'home';
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
// Every screen that goes in <main>. Home has no "ios" class on <main>, so the iOS look in style.css can never reach it.
const VIEWS = () => ({ home: vHome, tape: vTape, arrivals: vArrivals, inhouse: vInHouse, departures: vDepartures, hk: vHk, wo: vWo, reports: vReports, setup: vSetup, find: vFind, dnr: vDnr, members: vMembers, groups: vGroups, companies: vCompanies, stats: vStats });
function paint(hk, nav) {
  const it = (label, attr) => `<a href="#" ${attr}>${label}</a>`, N = (v, label) => it(label, `data-nav="${v}"`), A = (a, label, x) => it(label, `data-act="${a}" ${x || ''}`);
  const menu = (name, items, cls) => `<div class="menu ${cls || ''}"><button type="button">${name}</button><div class="drop">${items.filter(Boolean).join('')}</div></div>`;
  const menus = hk ? '<button type="button" class="on" data-nav="hk">Housekeeping</button>' : `<button type="button" data-nav="home" class="${view.name === 'home' ? 'on' : ''}">Home</button>` +
    menu('Find', [A('findOpen', 'Reservation'), A('findOpen', 'Guest Profile'), N('companies', 'Company Profile'), N('companies', 'Direct Bill Account'), N('groups', 'Group Master')]) +
    menu('View', [N('inhouse', 'In House'), N('arrivals', 'Arrivals'), N('departures', 'Departures'), N('departures', "Today's Checked Out Guests"), N('stats', 'Quick Statistics'), A('repGo', 'Future Availability', 'data-rep="future"'), N('companies', 'Company Profiles'), A('repGo', 'Night Audit', 'data-rep="stats"')]) +
    menu('Create', [A('newRes', 'Reservation'), A('walkIn', 'Walk-In'), A('coNew', 'Company Profile'), A('coNew', 'Direct Bill Account'), A('grpNew', 'Group Master')]) +
    menu('Manage', [A('shift', 'Cashier Shift' + (S.shift ? ' (open)' : '')), A('repGo', 'No Show Reservations', 'data-rep="noshow"'), N('hk', 'Housekeeping Center'), N('wo', 'Work Orders'), A('blockNew', 'Room Blocking'), N('dnr', 'Do Not Rent List'), rwOn() && N('members', 'Rewards Members'), boss() && A('setupGo', 'Packages', 'data-tab="packages"'), boss() && N('setup', 'Hotel Configuration'), boss() && A('setupGo', 'Manage Rates', 'data-tab="rates"'), boss() && A('setupGo', 'Logins', 'data-tab="users"'), N('tape', 'Tape Chart')]) +
    menu('Run', [N('reports', 'Reports'), boss() && A('nightAudit', 'Night Audit')]);
  $('#app').innerHTML = `<header class="${hk ? 'hkbar' : ''}"><div class="brand"><img src="icon.png" alt="">${esc(S.config.name)}</div><nav class="menus">${menus}</nav>
    <div class="hright">${S.me.master ? '<button class="btn sm amber" data-act="mClose">◀ All hotels</button>' : ''}${hk ? '' : '<span class="rj"><input id="roomJump" placeholder="Room #" autocomplete="off" aria-label="Room number"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg></span><input class="find" id="find" placeholder="Find guest or conf. #">'}
    ${menu(IC_PERSON + ' ' + esc(S.me.name), [A('myPw', 'My password'), A('logout', 'Logout')], 'user')}<span class="bdate">${esc(dshort(B()))}</span>${hk ? '<button type="button" class="btn sm hklogout" data-act="logout">Logout</button>' : ''}</div></header>
    <main class="${view.name === 'home' || !VIEWS()[view.name] ? '' : 'ios'}">${rcBanner()}<div class="hline">${IC_BUILD}<span>${esc(S.config.name)}</span></div>${(VIEWS()[view.name] || vHome)()}</main>`;
}

/* ---------- Home ---------- */
// Every tile that can sit on Home: key -> [attributes, icon, label, who]. who 'boss' = owner or manager only (hidden for everyone else).
const TILES = {
  shift: ['data-act="shift"', '$', 'Cashier<br>Shift'], arrivals: ['data-nav="arrivals"', '🛎', 'View<br>Arrivals'], inhouse: ['data-nav="inhouse"', '🧳', 'In House<br>List'], departures: ['data-nav="departures"', '🚗', 'View Departures<br>List'],
  stats: ['data-nav="stats"', '📊', 'Quick<br>Statistics'], tape: ['data-nav="tape"', '▦', 'Tape<br>Chart'], hk: ['data-nav="hk"', '🧹', 'Housekeeping<br>Center'], newres: ['data-act="newRes"', '＋', 'Create<br>Reservation'],
  walkin: ['data-act="walkIn"', '🚶', 'Walk-In'], find: ['data-act="findOpen"', '👤', 'Find<br>Guest'], blocking: ['data-act="blockNew"', '⛔', 'Room<br>Blocking'], groups: ['data-nav="groups"', '👥', 'Group<br>Master'],
  companies: ['data-nav="companies"', '🏢', 'Company<br>Profiles'], reports: ['data-nav="reports"', '📄', 'Reports'],
  nightaudit: ['data-act="nightAudit"', '🌙', 'Night<br>Audit', 'boss'], future: ['data-act="repGo" data-rep="future"', '📅', 'Future<br>Availability'], dnr: ['data-nav="dnr"', '🚫', 'Do Not Rent<br>List'],
  findres: ['data-act="findOpen"', '🔎', 'Find<br>Reservation'], config: ['data-nav="setup"', '⚙', 'Hotel<br>Configuration', 'boss'], rates: ['data-act="setupGo" data-tab="rates"', '💲', 'Manage<br>Rates', 'boss'],
  packages: ['data-act="setupGo" data-tab="packages"', '🎁', 'Packages', 'boss'], logins: ['data-act="setupGo" data-tab="users"', '🔑', 'Logins', 'boss'], cancellations: ['data-act="repGo" data-rep="cancel"', '✖', 'Cancellation<br>List'],
  arrrep: ['data-act="repGo" data-rep="arrivals"', '📋', 'Arrival List<br>Report'], workorders: ['data-nav="wo"', '🔧', 'Work<br>Orders']
};
const QL_DEFAULT = ['shift', 'arrivals', 'inhouse', 'departures', 'stats', 'tape', 'hk', 'newres', 'walkin', 'find', 'blocking', 'groups', 'companies', 'reports'];
const qlSaved = () => (S.config.quickLinks && S.config.quickLinks.length ? S.config.quickLinks : QL_DEFAULT).filter(k => TILES[k]);
const quickKeys = () => qlSaved().filter(k => TILES[k][3] !== 'boss' || boss());   // tiles a role cannot use are hidden for that role
const tileName = k => TILES[k][2].replace(/<br>/g, ' ');
function vHome() {
  const s = S.stats, d = B(), hr = new Date().getHours(), hello = hr < 12 ? 'Good Morning' : hr < 18 ? 'Good Afternoon' : 'Good Evening';
  const types = S.config.types.map(t => ({ t, n: availOfType(t.code, d, addDays(d, 1)) })).sort((a, b) => b.n - a.n);
  const dirtyVacant = S.config.rooms.filter(r => !inRoom(r.no) && cond(r.no) === 'D').length, arrToday = s.checkedIn + s.arrivalsLeft;
  const outToday = S.res.filter(r => r.status === 'out' && r.depart === d).length;
  const T = k => { const t = TILES[k]; return `<button class="tile" ${t[0]}><span class="ic">${t[1]}</span><span>${t[2]}</span></button>`; };
  return `<div class="tiles">${quickKeys().map(T).join('')}</div>
  <div class="band">${boss() ? '<button class="btn sm blue qledit" data-act="qlEdit">EDIT</button>' : ''}<div class="greet">${hello},<br>${esc(String(S.me.name).split(' ')[0])}!</div>
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
    return `<tr><td class="rm"><a href="#" data-act="newRes" data-room="${esc(rm.no)}" data-date="${B()}">${esc(rm.no)}</a>${wrench(rm.no)}</td><td class="ty">${esc(rm.type)}</td><td class="cd">${condBtns(rm.no)}</td>${tds}</tr>`;
  }).join('');
  const un = active().filter(r => !r.room && r.arrive < end).sort((a, b) => a.arrive.localeCompare(b.arrive));
  const byDay = {}; for (const r of un) (byDay[r.arrive] = byDay[r.arrive] || []).push(r);
  return `<h1 class="pgt">Tape Chart</h1><div class="bar"><span class="hint">Start Date:</span><input type="date" id="tapeDate" value="${view.tapeStart}"><button class="btn sm blue" data-act="tapeToday">TODAY</button><button class="btn sm" data-act="tapeMove" data-n="-7">◀ Week</button><button class="btn sm" data-act="tapeMove" data-n="7">Week ▶</button>
    <select id="tapeFloor"><option value="">All floors</option>${floors.map(f => `<option ${view.floor === f ? 'selected' : ''} value="${esc(f)}">Floor ${esc(f)}</option>`).join('')}</select><span class="flex"></span><button class="btn sm red" data-act="blockNew">Room Blocking…</button></div>
  <div class="tapewrap"><div class="wrap" style="max-height:calc(100vh - 200px);flex:1"><table class="tape"><tr><th class="c1">Room #</th><th class="c2">Type</th><th class="c3">Condition</th>${days.map(d => { const dt = new Date(d + 'T00:00:00Z'); const we = [5, 6].includes(dt.getUTCDay()); return `<th class="${we ? 'we' : ''} ${d === B() ? 'td' : ''}">${dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })}.<br>${dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}</th>`; }).join('')}</tr>${rows}</table></div>
  <aside class="tside"><h3>Overview</h3><div class="lg"><i style="background:var(--green)"></i>In House</div><div class="lg"><i style="background:var(--blue)"></i>Reserved</div><div class="lg"><i style="background:var(--amber)"></i>Due Out</div><div class="lg"><i style="background:#9aa6b8"></i>Checked Out</div><div class="lg"><i style="background:var(--red)"></i>Out of Order</div><p class="hint">R ready · C clean · D dirty.<br>Click an empty day to book that room.</p>
    <h3>Optimize Room Assignments?</h3><div class="optbox"><label for="optDate" class="hint">Start Date:</label><input type="date" id="optDate" value="${esc(view.optDate || B())}"><button class="btn blue" data-act="optRun">RUN</button></div>
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
  rewards: { head: 'Rewards', val: r => rwTierOf(r), cell: r => esc(rwTierOf(r)) },
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
const withRw = cols => rwOn() ? cols.flatMap(k => k === 'guest' ? ['guest', 'rewards'] : [k]) : cols;
const vArrivals = () => {
  const day = view.listDate || B(), today = day === B();
  const rows = S.res.filter(r => today ? r.status === 'reserved' && r.arrive <= B() : r.arrive === day && ['reserved', 'inhouse', 'out'].includes(r.status));
  return listScreen({ title: 'Arrivals: ' + esc(dmdy(day)), empty: 'No scheduled arrivals found.', rows, cols: withRw(['guest', 'city', 'zip', 'gtd', 'nights', 'room', 'type', 'cond', 'rate', 'company', 'group', 'conf']), sort: { col: 'guest', dir: 'asc' }, dateRow: listDateRow('Arrival Date:', day) });
};
const vInHouse = () => listScreen({ title: 'In House List', empty: 'Nobody is checked in.', rows: S.res.filter(r => r.status === 'inhouse'), cols: withRw(['room', 'guest', 'city', 'zip', 'type', 'cond', 'rate', 'arrive', 'depart', 'company', 'group', 'pay', 'bal']), sort: { col: 'room', dir: 'asc' } });
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
/* Cleaning schedules: each room follows one. Day 1 is the first morning after the guest arrived; the pattern repeats after its last day. */
const SCH_WORD = { F: 'Full', L: 'Light', N: 'None' };
function schedOf(no) { const rm = S.config.rooms.find(r => r.no === no), l = S.config.cleanSchedules || []; return l.find(s => s.id === (rm && rm.sched)) || l[0] || null; }
function service(no) {
  const g = inRoom(no);
  if (g) {
    if (g.depart <= B()) return 'Check Out';
    const s = schedOf(no), n = nights(g.arrive, B()); if (!s || !s.days.length) return 'Stay Over';
    const k = n < 1 ? 'N' : s.days[(n - 1) % s.days.length];   // arrival day: the room was just made up
    return 'Stay Over – ' + (k === 'F' ? 'Full' : k === 'L' ? 'Light' : 'No service');
  }
  return cond(no) === 'D' ? 'Check Out' : 'None';
}
const hkPreText = no => { const g = inRoom(no); return g ? [g.crib && 'Crib', g.rollaway && 'Rollaway'].filter(Boolean).join(' · ') : ''; };
const hkPre = no => hkPreText(no) ? `<span class="hkpre">${hkPreText(no)}</span>` : '';   // read-only prefix in the Notes cell
function vHk() {
  const floors = [...new Set(S.config.rooms.map(r => r.floor))].sort();
  const rooms = S.config.rooms.filter(r => (!view.floor || r.floor === view.floor) && (!view.hkDirty || cond(r.no) === 'D'));
  const cnt = k => S.config.rooms.filter(r => (!view.floor || r.floor === view.floor) && cond(r.no) === k).length;
  const roomBadge = rm => isOOO(rm.no, B()) ? '<span class="badge r">Out of order</span>' : inRoom(rm.no) ? '<span class="badge g">Occupied</span>' : '<span class="badge s">Vacant</span>';
  const card = rm => { const st = S.roomstate[rm.no] || {}, n = esc(rm.no); return `<div class="hkcard" data-room="${n}"><div class="hkh"><span class="hkno">${n}${wrench(rm.no)}</span><span class="hkty">${esc(rm.type)}</span>${roomBadge(rm)}</div>
    <div class="hksv">Service: <b>${service(rm.no)}</b></div>
    <button type="button" class="btn wobtn" data-act="woNew" data-room="${n}">🔧 Work Order</button>
    <div class="hkbtns">${['R', 'C', 'D'].map(k => `<button type="button" class="hkb ${k} ${cond(rm.no) === k ? 'on' : ''}" data-act="cond" data-room="${n}" data-cond="${k}">${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[k]}</button>`).join('')}</div>
    <label class="swk"><input type="checkbox" data-hk="dnd" data-room="${n}" ${st.dnd ? 'checked' : ''}><i></i><span>Do not disturb</span></label>
    <div class="hknote">${hkPre(rm.no)}<input data-hk="note" data-room="${n}" value="${esc(st.note || '')}" maxlength="200" placeholder="Notes" aria-label="Notes for room ${n}"></div></div>`; };
  return `<h1>Housekeeping</h1><div class="bar hkfilter"><select id="hkFloor" aria-label="Floor"><option value="">All floors</option>${floors.map(f => `<option ${view.floor === f ? 'selected' : ''} value="${esc(f)}">Floor ${esc(f)}</option>`).join('')}</select>
    <label class="swk hkdirty"><input type="checkbox" id="hkDirty" ${view.hkDirty ? 'checked' : ''}><i></i><span>Dirty only</span></label>
    <span class="hkcnt"><span class="badge r">${cnt('D')} dirty</span><span class="badge a">${cnt('C')} clean</span><span class="badge g">${cnt('R')} ready</span></span><span class="flex hkdesk"></span>
    <span class="hkdesk hint">Rooms</span><input class="hkdesk" id="hkFrom" placeholder="from" style="width:80px"><input class="hkdesk" id="hkTo" placeholder="to" style="width:80px"><button class="btn sm red hkdesk" data-act="hkRange" data-cond="D">Dirty</button><button class="btn sm amber hkdesk" data-act="hkRange" data-cond="C">Clean</button><button class="btn sm green hkdesk" data-act="hkRange" data-cond="R">Ready</button><button class="btn sm hkdesk" data-act="printHk">Print check-off list</button><button class="btn sm" data-nav="wo">🔧 Work Orders${(S.workorders || []).filter(w => w.status === 'open').length ? ' (' + (S.workorders || []).filter(w => w.status === 'open').length + ')' : ''}</button></div>
  <div class="wrap hkwrap"><table><tr><th>Room</th><th>Type</th><th>Room status</th><th>Condition</th><th>Service</th><th>Assigned to</th><th>Do not disturb</th><th>Notes</th><th></th></tr>
  ${rooms.map(rm => { const st = S.roomstate[rm.no] || {}; return `<tr><td><b>${esc(rm.no)}</b>${wrench(rm.no)}</td><td>${esc(rm.type)}</td><td>${roomBadge(rm)}</td><td>${condBtns(rm.no)}</td><td>${service(rm.no)}</td>
    <td><select data-hk="hk" data-room="${esc(rm.no)}" style="min-height:34px;padding:4px 8px"><option value=""></option>${S.config.housekeepers.map(h => `<option ${st.hk === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></td>
    <td><input type="checkbox" data-hk="dnd" data-room="${esc(rm.no)}" ${st.dnd ? 'checked' : ''}></td><td class="hknote">${hkPre(rm.no)}<input data-hk="note" data-room="${esc(rm.no)}" value="${esc(st.note || '')}" maxlength="200" style="min-height:34px;padding:4px 8px"></td><td><button type="button" class="btn sm" data-act="woNew" data-room="${esc(rm.no)}">🔧 Work Order</button></td></tr>`; }).join('')}</table></div>
  <div class="hkcards">${rooms.map(card).join('') || '<div class="empty">No rooms to show.</div>'}</div>
  ${S.config.housekeepers.length ? '' : '<p class="hint hkdesk">To assign rooms, a manager adds the housekeepers\' names in Setup › Housekeepers.</p>'}`;
}

/* ---------- Work orders ---------- */
function vWo() {
  const f = view.woFilter || 'open', hkr = S.me.role === 'hk', l = (S.workorders || []).filter(w => f === 'all' || w.status === f);
  const row = w => `<tr><td><b>${esc(w.room)}</b></td><td>${esc(w.reason)}${w.blockId && S.blocks.some(b => b.id === w.blockId) ? ' <span class="badge r">Out of order</span>' : ''}</td><td>${esc(w.notes)}</td><td>${stamp(w.createdAt)}<div class="hint">${esc(w.createdBy)}</div></td>
    <td>${w.status === 'done' ? stamp(w.doneAt) + '<div class="hint">' + esc(w.doneBy) + '</div>' : '<span class="badge a">Open</span>'}</td><td>${w.status === 'open' ? `<button class="btn sm green" data-act="woDone" data-id="${w.id}">Mark done</button>` : ''}</td></tr>`;
  return `<p class="backl"><a href="#" data-nav="hk">‹ Housekeeping</a></p><h1>Work Orders</h1>
  <div class="bar"><span class="segc" role="group" aria-label="Show">${[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([k, l]) => `<button type="button" class="${f === k ? 'on' : ''}" data-act="woSeg" data-v="${k}">${l}</button>`).join('')}</span><select id="woFilter" class="vh" aria-label="Show"><option value="open" ${f === 'open' ? 'selected' : ''}>Open</option><option value="done" ${f === 'done' ? 'selected' : ''}>Done</option><option value="all" ${f === 'all' ? 'selected' : ''}>All</option></select><span class="flex"></span><button class="btn blue" data-act="woNew" data-room="">+ New Work Order</button></div>
  <div class="wrap"><table><tr><th>Room</th><th>Reason</th><th>Notes</th><th>Opened</th><th>Closed</th><th></th></tr>${l.map(row).join('') || '<tr><td colspan="6" class="empty">No work orders here.</td></tr>'}</table></div>
  <p class="hint">${hkr ? '' : 'Housekeeping can open and close work orders too. '}Closed work orders are kept for the most recent 300. The Maintenance Report in Reports lists them by date.</p>`;
}
function woNew(room) {
  const reasons = (S.config.woReasons || []).filter(x => x.active), hkr = S.me.role === 'hk';
  $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle thin">New Work Order</div><div class="grid">
    <label class="c12">Room<select id="wo_room"><option value="">Pick a room</option>${S.config.rooms.map(r => `<option value="${esc(r.no)}" ${r.no === room ? 'selected' : ''}>${esc(r.no)} · ${esc(r.type)}${woOpen(r.no) ? ' 🔧' : ''}</option>`).join('')}</select></label>
    <label class="c12">Reason<select id="wo_reason">${reasons.map(x => `<option>${esc(x.name)}</option>`).join('')}</select></label>
    <label class="c12">Notes<textarea id="wo_notes" rows="3" maxlength="300" placeholder="What needs doing?"></textarea></label>
    ${hkr ? '' : `<label class="chk c12"><input type="checkbox" id="wo_ooo">Also take the room out of order</label><label class="c6">From<input type="date" id="wo_from" value="${B()}"></label><label class="c6">Through<input type="date" id="wo_to" value="${B()}"></label>`}</div>
    ${reasons.length ? '' : '<p class="hint">No reasons are set up yet. A manager adds them in Setup › Work Order Reasons.</p>'}
    <div class="err" id="wo_err"></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="woAddGo">Save Work Order</button></div></div></div>`;
}
async function woAddGo() {
  const er = m => { $('#wo_err').textContent = m; }, room = $('#wo_room').value, ooo = $('#wo_ooo') && $('#wo_ooo').checked;
  if (!room) return er('Pick the room.'); if (!$('#wo_reason').value) return er('Pick a reason.');
  if (ooo && (!$('#wo_from').value || !$('#wo_to').value || $('#wo_to').value < $('#wo_from').value)) return er('Check the out of order dates.');
  await run(async () => { try { await op('woAdd', { room, reason: $('#wo_reason').value, notes: $('#wo_notes').value, ...(ooo ? { ooo: { start: $('#wo_from').value, end: $('#wo_to').value } } : {}) }); $('#modal').innerHTML = ''; await refresh(); toast('Work order saved for room ' + room + '.'); } catch (e) { if (e.status === 401) throw e; er(e.message); } });
}
function woDone(id) {
  const w = (S.workorders || []).find(x => x.id === id); if (!w) return;
  if (S.me.role !== 'hk' && w.blockId && S.blocks.some(b => b.id === w.blockId))
    $('#modal').innerHTML = `<div class="mback"><div class="mbox sm"><div class="mtitle thin">Work order done</div><p>Room ${esc(w.room)} was taken out of order for this work order. Put it back in order now?</p><div class="mfoot" style="flex-wrap:wrap"><button class="btn" data-act="closeModal">Cancel</button><button class="btn" data-act="woDoneGo" data-id="${id}" data-back="0">Done, leave out of order</button><button class="btn green" data-act="woDoneGo" data-id="${id}" data-back="1">Done, put back in order</button></div></div></div>`;
  else woDoneGo(id, false);
}
const woDoneGo = (id, back) => run(async () => { await op('woDone', { id, putBack: back }); $('#modal').innerHTML = ''; await refresh(); toast('Work order done.'); });

/* ---------- Reservation window ---------- */
let ED = null;   // the reservation being edited
function resForm(r, mode) {
  const isNew = !r.id, locked = !isNew && !['reserved', 'inhouse'].includes(r.status);
  const n = nights(r.arrive, r.depart), types = S.config.types;
  const from = r.status === 'inhouse' && B() > r.arrive ? B() : r.arrive;
  const freeRooms = rlSort(S.config.rooms.filter(x => (x.no === r.room) || (roomFree(x.no, from, r.depart, r.id))));
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
  const acts = `<a href="#" data-act="closeModal">${isNew ? 'Cancel' : 'Back'}</a>` + (locked ? '' : `<a href="#" data-act="saveRes">${mode === 'walkin' ? 'Check In Now' : isNew ? 'Book Reservation' : 'Save Changes'}</a>`) + (isNew ? '' : `${A('folio', 'Guest Folio')}${r.status === 'reserved' ? A('checkIn', 'Check In') + A('cancelRes', 'Cancel Reservation') + (r.arrive <= B() ? A('noShow', 'No Show') : '') : ''}${r.status === 'inhouse' ? A('checkOut', 'Check Out') + A('undoCheckIn', 'Undo Check In') : ''}${r.status === 'out' ? A('undoCheckOut', 'Undo Check Out') : ''}${['cancelled', 'noshow'].includes(r.status) ? A('reinstate', 'Reinstate') : ''}${A('printReg', 'Print Registration Card')}${A('printConf', 'Print Confirmation')}${A('emailConf', 'E-mail Confirmation')}${A('viewChanges', 'View Changes')}${A('recurring', 'Recurring Charges').replace('<a ', '<a data-src="ed" ')}`) + (rwOn() && !isNew && (!locked || r.memberId) ? A('rwMember', 'Rewards Member') + (r.memberId && !locked ? A('rwRemove', 'Remove from Rewards') : '') : '') + dnrAct;
  const side = `<aside class="pside"><h3>Overview</h3><dl><dt>Status:</dt><dd class="big">${isNew ? 'New' : { reserved: 'Reserved', inhouse: 'In House', out: 'Checked Out', cancelled: 'Cancelled', noshow: 'No Show' }[r.status]}</dd><dt>Guest Name:</dt><dd>${esc(((r.first || '') + ' ' + (r.last || '')).trim().toUpperCase())}</dd>${r.groupId ? `<dt>Group Master:</dt><dd>${esc((S.groups.find(g => g.id === +r.groupId) || {}).name || '')}</dd>` : ''}<dt>Account Number:</dt><dd>${esc(r.conf || '')}</dd><dt>Balance:</dt><dd>${bal < 0 ? '(' + money(-bal) + ')' : money(bal)}</dd></dl><h3>Actions</h3><div class="alinks">${acts}</div></aside>`;
  return `<div class="mback"><div class="mbox page"><div class="pg"><div class="pgmain">${dnrBanner(r)}${histBanner()}<div class="mtitle">${isNew ? (mode === 'walkin' ? 'Walk-In' : 'Create Reservation') : 'Reservation Information: ' + esc(((r.first || '') + ' ' + (r.last || '')).trim().toUpperCase())} ${isNew ? '' : statusBadge(r)}</div>
  <div class="sec">Stay</div><div class="grid">
    <label class="c3">Arrival<input type="date" id="r_arrive" value="${r.arrive}" ${locked || mode === 'walkin' || r.status === 'inhouse' ? 'disabled' : ''}></label>
    <label class="c2">Nights<input type="number" id="r_nights" min="1" max="365" value="${n}" ${locked ? 'disabled' : ''}></label>
    <label class="c3">Departure<input type="date" id="r_depart" value="${r.depart}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Adults<input type="number" id="r_adults" min="1" value="${r.adults || 1}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Children<input type="number" id="r_children" min="0" value="${r.children || 0}" ${locked ? 'disabled' : ''}></label>
    <label>Room type<select id="r_type" ${locked ? 'disabled' : ''}>${types.map(x => `<option value="${esc(x.code)}" ${x.code === r.type ? 'selected' : ''}>${esc(x.code)} · ${esc(x.name)} · ${availOfType(x.code, from, r.depart, r.id, r.groupId)} left · ${money(rateFor(x.code, r.arrive))}</option>`).join('')}</select></label>
    <label>Room<select id="r_room" ${locked ? 'disabled' : ''}><option value="">${mode === 'walkin' ? 'Pick a room' : 'Not assigned yet'}</option>${freeRooms.filter(x => x.type === r.type || x.no === r.room).map(x => `<option value="${esc(x.no)}" ${x.no === r.room ? 'selected' : ''}>${esc(x.no)}${x.accessible ? ' ♿' : ''}${woOpen(x.no) ? ' 🔧' : ''} · ${esc(x.type)} · ${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(x.no)]}${inRoom(x.no) && inRoom(x.no).id !== r.id ? ' · occupied' : ''}</option>`).join('')}</select></label>
    <label class="c2">Rate / night<input id="r_rate" inputmode="decimal" value="${(nightly[0] / 100).toFixed(2)}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Estimated total<input value="${money(est)}" disabled></label>
    <label>Group<select id="r_groupId" ${locked ? 'disabled' : ''}><option value="0">No group</option>${grpOpts.map(g => `<option value="${g.id}" ${g.id === +r.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <label>Company<select id="r_companyId" ${locked ? 'disabled' : ''}><option value="0">No company</option>${S.companies.filter(c => !c.inactive || c.id === +r.companyId).sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}" ${c.id === +r.companyId ? 'selected' : ''}>${esc(c.name)}${c.directBill ? ' · direct bill' : ''}</option>`).join('')}</select></label>
    <label>Package<select id="r_pkg" ${locked ? 'disabled' : ''}><option value="">No package</option>${(S.config.packages || []).map(k => `<option value="${esc(k.code)}" ${k.code === r.pkg ? 'selected' : ''}>${esc(k.name)} · ${money(k.price)} / night</option>`).join('')}</select></label></div>
  <p class="hint" style="margin:6px 0 0">${manual ? `Rate typed by hand: ${money(r.rate)} every night. <a href="#" data-act="rateStd">Use the standard rate</a>` : varies ? 'The rate changes by night: ' + nightly.map((v, i) => dshort(addDays(r.arrive, i)).replace(/\/\d+$/, '') + ' ' + money(v)).join(', ') + '. Type a rate to charge one rate every night.' : 'Standard rate. Type a different rate to override it.'}</p>
  <div class="sec">Guest ${locked ? '' : '<button class="btn sm" data-act="scanId" style="float:right;margin-top:-8px">Scan ID</button>'}</div><div class="grid">${f('last', 'Last name *', '', 'maxlength="60"')}${f('first', 'First name', '', 'maxlength="60"')}${f('phone', 'Phone', '', 'maxlength="30" inputmode="tel"')}${f('email', 'E-mail', 'c8', 'maxlength="100"')}
    ${f('addr1', 'Address', 'c6', 'maxlength="100"')}${f('city', 'City', 'c3', 'maxlength="60"')}${f('state', 'State', 'c2', 'maxlength="30"')}${f('zip', 'Postal code', 'c2', 'maxlength="15"')}${f('guestId', 'Guest ID (license #)', '', 'maxlength="40"')}${f('vehicle', 'Vehicle / plate', '', 'maxlength="40"')}</div>${rwRow()}
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
  if (ED.mode === 'edit' || ED.step === 3) { histPaint(); histLoad(); }
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
    const hi = ED.hi, from = r.arrive, rooms = hi ? rlSort(S.config.rooms.filter(x => x.type === hi && (x.no === r.room || roomFree(x.no, from, r.depart, 0)))) : [];
    main = `<div class="wrap"><table class="wzt"><tr><th>Type</th><th>Description</th><th class="num">Available</th><th class="num">Rate</th><th class="num">Estimated Total</th><th></th></tr>${S.config.types.map(t => { const av = Math.max(0, availOfType(t.code, from, r.depart, 0, r.groupId)), q = stayCalc({ ...r, rateManual: false }, t.code); return `<tr class="click ${t.code === hi ? 'hi' : ''}" data-act="wizHi" data-type="${esc(t.code)}"><td><b>${esc(t.code)}</b></td><td>${esc(t.name)}</td><td class="num">${av}</td><td class="num">${money(q.nightly[0] || 0)}${q.varies ? ' <span class="hint">varies</span>' : ''}</td><td class="num">${money(q.est)}</td><td class="num"><button class="btn sm blue" data-act="wizType" data-type="${esc(t.code)}" ${av < 1 ? 'disabled' : ''}>SELECT</button></td></tr>`; }).join('')}</table></div>
      <p class="hint" style="margin:6px 0 0">Estimated Total is the room nights${c.pk ? ' and the package' : ''} plus tax. ${walk ? 'For a walk-in, click a room type, pick the room below, then SELECT.' : 'Click a row to see its rooms below.'}</p>
      <div class="wzf" style="margin-top:12px"><label for="r_room">Assigned Room:</label><select id="r_room" ${hi ? '' : 'disabled'}><option value="">${hi ? (walk ? 'Pick a room' : 'Not assigned yet') : 'Click a room type above'}</option>${rooms.map(x => `<option value="${esc(x.no)}" ${x.no === r.room ? 'selected' : ''}>${esc(x.no)}${x.accessible ? ' ♿' : ''}${woOpen(x.no) ? ' 🔧' : ''} · ${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(x.no)]}${inRoom(x.no) && inRoom(x.no).id !== r.id ? ' · occupied' : ''}</option>`).join('')}</select>
      <label for="r_rate">Rate / night</label><input id="r_rate" inputmode="decimal" value="${((c.nightly[0] || 0) / 100).toFixed(2)}"></div>
      <p class="hint" style="margin:6px 0 0"><span id="rateHint">${rateHint(r, c)}</span> <a href="#" data-act="rateStd" id="rateLink" ${c.manual ? '' : 'hidden'}>Use the standard rate</a></p><div class="err" id="r_err"></div>${hi ? '<button class="btn blue wzbtn" data-act="wizNext">CONTINUE</button>' : ''}`;
    side = wizSide(2);
  } else if (step === 3) {
    main = `<div class="wz3"><div class="wzcol"><div class="wzf cmp">${F('last', '*Last Name', 'maxlength="60"')}${F('first', 'First Name', 'maxlength="60"')}${F('addr1', 'Address 1', 'maxlength="100"')}${F('addr2', 'Address 2', 'maxlength="100"')}${F('country', 'Country', 'maxlength="40"')}${F('zip', 'Postal Code', 'maxlength="15"')}${F('city', 'City', 'maxlength="60"')}${F('state', 'State', 'maxlength="30"')}${F('phone', 'Phone', 'maxlength="30" inputmode="tel"')}${F('email', 'E-mail', 'maxlength="100"')}${F('guestId', 'Guest ID', 'maxlength="40"')}${CK('taxExempt', 'Tax Exempt')}${F('vehicle', 'Vehicle ID', 'maxlength="40"')}${CK('vip', 'VIP')}</div>${rwRow()}
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
  return `<div class="mback"><div class="mbox page"><div class="pg"><div class="pgmain wz">${step >= 3 ? dnrBanner(r) : ''}${step === 3 ? histBanner() : ''}<div class="mtitle">${titles[step - 1]}</div>${track}${main}</div><aside class="pside wz">${side}<h3>Actions</h3><div class="alinks"><a href="#" data-act="closeModal">Cancel</a></div></aside></div></div></div>`;
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
    if (act === 'checkIn') { readForm(); if (!r.room) throw new Error('Pick a room first.'); const rwm = rwOn() && r.memberId ? rwMem(r.memberId) : null; ciAmen = false; if (r.notes || r.requests || rwm) { const yes = await askBox('Guest notes', ((r.notes || r.requests) ? `<div class="gnotes">${r.requests ? `<p><b>Special requests</b><br>${esc(r.requests)}</p>` : ''}${r.notes ? `<p><b>Notes</b><br>${esc(r.notes)}</p>` : ''}</div>` : '') + (rwm ? rwCheckInHtml(rwm) : ''), 'Continue check-in'); if (!yes) return; } await op('resSave', (({ status, history, rates, ...a }) => { a.rateManual = !!a.rateManual; if (!a.rateManual) delete a.rate; return a; })(r)); const fl = {}; for (;;) { try { await op('checkIn', { id: r.id, ...fl, ...(ciAmen ? { amenityGiven: true } : {}) }); break; } catch (e) { if (e.status === 412 && !fl.dirtyOk && confirm(e.message)) fl.dirtyOk = true; else if (e.status === 428 && !fl.dnrOk && confirm(e.message)) fl.dnrOk = true; else throw e; } } await done('Checked in to room ' + r.room + '.'); }
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
    <h3>Actions</h3><div class="alinks">${L('folioBack', 'Back')}${L('postOpen', 'Post Charge', 'data-kind="charge"')}${L('postOpen', 'Post Payment', 'data-kind="payment"')}${L('postOpen', 'Post Adjustment', 'data-kind="adjust"')}${L('printFolio', 'Print')}${L('emailFolio', 'Email Folio')}${L('recurring', 'Recurring Charges', 'data-src="fo"')}${r.status === 'inhouse' ? L('folioCheckOut', 'Check Out') : ''}${L('closeModal', 'Close')}</div></aside></div></div></div>`;
}
function postOpen(kind) {
  const bal = FO.balance, pay = ['CASH', 'CRED', 'AREC', 'GFTCRD'], rwm = kind === 'payment' && rwOn() && FO.res.memberId ? rwMem(FO.res.memberId) : null, rwc = S.rewards, pv = rwc.pointValue;
  const canRw = !!rwm && pv >= 1 && rwm.points >= rwc.minRedeem && Math.floor(bal / pv) >= rwc.minRedeem, rwDef = canRw ? Math.min(rwm.points, Math.floor(bal / pv)) : 0;
  const codes = S.config.codes.filter(k => k.code === 'RW' ? canRw : kind === 'payment' ? pay.includes(k.type) : !pay.includes(k.type) && k.type !== 'ADMIN');
  $('#postBox').innerHTML = `<div class="card" style="margin-bottom:10px"><b>${{ charge: 'Post a charge', payment: 'Post a payment', adjust: 'Post an adjustment (takes a charge off)' }[kind]}</b><div class="grid" style="margin-top:8px">
    <label>${kind === 'payment' ? 'Payment type' : 'Charge'}<select id="p_code">${codes.map(k => `<option value="${esc(k.code)}">${esc(k.name)}</option>`).join('')}</select></label>
    <label class="c3" id="p_amtWrap">Amount<input id="p_amt" inputmode="decimal" value="${kind === 'payment' && bal > 0 ? (bal / 100).toFixed(2) : ''}"></label>
    ${canRw ? `<label class="c3" id="p_ptsWrap" hidden>Points to redeem<input id="p_pts" inputmode="numeric" value="${rwDef}" data-max="${rwDef}"></label><span class="hint rwval" id="p_ptsVal" hidden></span>` : ''}
    ${kind === 'payment' ? '<label class="c2">Card last 4<input id="p_last4" maxlength="4" inputmode="numeric"></label>' : ''}
    <label class="${kind === 'payment' ? 'c3' : 'c6'}">${kind === 'adjust' ? 'Reason *' : 'Comment'}<input id="p_note" maxlength="150"></label></div>
    <p class="hint" style="margin:8px 0 0">${kind === 'charge' ? 'Taxes are added automatically.' : kind === 'adjust' ? 'The taxes on that amount come off too.' : 'Run the card on your terminal first. "Guest Refund" and "Cash Paid Out" give money back.'}</p>
    <div class="mfoot" style="margin-top:8px"><button class="btn sm" data-act="postCancel">Cancel</button><button class="btn sm green" data-act="postSave" data-kind="${kind}">Post</button></div></div>`;
  $('#p_amt').focus();
}
async function postSave(kind) {
  await run(async () => { if ($('#p_code').value === 'RW') { const points = parseInt($('#p_pts').value, 10); if (!(points > 0)) throw new Error('Type the points to redeem.'); await op('post', { res: FO.res.id, kind, code: 'RW', points, comment: $('#p_note').value }); FO = await api('/folio?id=' + FO.res.id); drawFolio(); await refresh(); return toast('Redeemed ' + points.toLocaleString('en-US') + ' points.'); }
    const amount = toCents($('#p_amt').value); if (!(amount > 0)) throw new Error('Type an amount above zero.'); await op('post', { res: FO.res.id, kind, code: $('#p_code').value, amount, comment: $('#p_note').value, last4: $('#p_last4') ? $('#p_last4').value : '' }); FO = await api('/folio?id=' + FO.res.id); drawFolio(); refresh(); toast('Posted.'); });
}

/* ---------- printing ---------- */
function printHtml(html) { $('#print').innerHTML = html; window.print(); }
const letterHead = () => { const c = S.config, a = [c.address, cityLineC(c)].filter(Boolean).join(', '); return `<h1>${esc(c.name)}</h1><div>${esc(a)}${c.phone ? (a ? ' · ' : '') + esc(c.phone) : ''}${c.fax ? ' · Fax ' + esc(c.fax) : ''}</div><hr>`; };
function printReg(r) { printHtml(letterHead() + `<h2>Guest Registration</h2><table><tr><td><b>Guest</b></td><td>${esc(gname(r))}</td><td><b>Conf. #</b></td><td>${esc(r.conf)}</td></tr><tr><td><b>Address</b></td><td>${esc([r.addr1, r.city, r.state, r.zip].filter(Boolean).join(', '))}</td><td><b>Phone</b></td><td>${esc(r.phone)}</td></tr><tr><td><b>Arrival</b></td><td>${dlong(r.arrive)}</td><td><b>Departure</b></td><td>${dlong(r.depart)}</td></tr><tr><td><b>Room</b></td><td>${esc(r.room || '')} (${esc(r.type)})</td><td><b>Rate</b></td><td>${r.suppressRate ? 'on file' : money(r.rate) + ' plus tax, per night'}</td></tr><tr><td><b>Guests</b></td><td>${r.adults} adults, ${r.children} children</td><td><b>Vehicle</b></td><td>${esc(r.vehicle)}</td></tr><tr><td><b>Company</b></td><td>${esc(r.company)}</td><td><b>E-mail</b></td><td>${esc(r.email)}</td></tr></table><p>Check-out time is ${esc(t12(S.config.checkoutTime))}.</p>${policyHtml()}<p>${esc(S.config.regText)}</p><p style="margin-top:40px">Guest signature: ______________________________________ &nbsp; Date: ______________</p>`); }
function printConf(r) { printHtml(letterHead() + `<h2>Reservation Confirmation</h2><p>Dear ${esc(r.first || '')} ${esc(r.last)},</p><p>Thank you for choosing ${esc(S.config.name)}. Your reservation is confirmed.</p><table><tr><td><b>Confirmation #</b></td><td>${esc(r.conf)}</td></tr><tr><td><b>Arrival</b></td><td>${dlong(r.arrive)} (check-in from ${esc(t12(S.config.checkinTime))})</td></tr><tr><td><b>Departure</b></td><td>${dlong(r.depart)} (check-out by ${esc(t12(S.config.checkoutTime))})</td></tr><tr><td><b>Room type</b></td><td>${esc((S.config.types.find(t => t.code === r.type) || {}).name || r.type)}</td></tr><tr><td><b>Guests</b></td><td>${r.adults} adults, ${r.children} children</td></tr><tr><td><b>Rate</b></td><td>${r.suppressRate ? 'on file' : money(r.rate) + ' plus tax, per night'}</td></tr><tr><td><b>Guarantee</b></td><td>${esc(r.guarantee || '')}</td></tr></table>${policyHtml()}<p>We look forward to your stay.</p>`); }
function printFolio() { const r = FO.res; printHtml(letterHead() + `<h2>Guest Folio</h2><p><b>${esc(gname(r))}</b><br>${esc([r.addr1, r.city, r.state, r.zip].filter(Boolean).join(', '))}<br>Room ${esc(r.room)} · ${dshort(r.arrive)} to ${dshort(r.depart)} · Conf. # ${esc(r.conf)}${r.company ? '<br>' + esc(r.company) : ''}</p>` + folioTable(FO) + '<p style="margin-top:30px">Guest signature: ______________________________________</p>'); }

/* ---------- Reports ---------- */
const REPORTS = [['arrivals', 'Arrival List'], ['departures', 'Departure List'], ['inhouse', 'In House List'], ['vacant', 'Vacant Room List'], ['hkcheck', 'Housekeeping Check-off List'], ['ledger', 'Guest Ledger (balances)'], ['future', 'Future Availability (14 days)'],
  ['activity', 'Reservation Activity Report'], ['stats', 'Hotel Statistics'], ['closeout', 'Final Transaction Closeout'], ['shift', 'Shift Reconciliation'], ['journal', 'Hotel Journal Detail'], ['cancel', 'Cancellation List'], ['noshow', 'No Show Report'], ['araging', 'Accounts Receivable Aging'], ['grouppickup', 'Group Pickup'], ['shifts', 'Cashier Shifts'], ['rwmembers', 'Rewards Program Members'], ['rwstats', 'Rewards Program Statistics'], ['maintenance', 'Maintenance Report']];
const REPORT_CATS = [
  ['TOP 10 LIST', [['Shift Reconciliation', 'shift'], ['Vacant Room List', 'vacant'], ['Housekeeping Check-off List', 'hkcheck'], ['Final Transaction Closeout', 'closeout'], ['Hotel Statistics', 'stats'], ['In House List', 'inhouse'], ['Reservation Activity Report', 'activity']]],
  ['Emergency Reports', [['Account Balance Report', 'ledger'], ['Arrival List', 'arrivals'], ['Departure List', 'departures'], ['In House List', 'inhouse'], ['Vacant Room List', 'vacant']]],
  ['Accounting Reports', [['Final Transaction Closeout', 'closeout'], ['Hotel Statistics', 'stats'], ['Guest Ledger', 'ledger'], ['Hotel Journal Detail', 'journal'], ['Shift Reconciliation', 'shift'], ['Cashier Shifts', 'shifts']]],
  ['Front Desk Reports', [['Cancellation List', 'cancel'], ['No Show Report', 'noshow']]],
  ['Housekeeping Reports', [['Housekeeping Check-off List', 'hkcheck'], ['Maintenance Report', 'maintenance']]],
  ['Reservation Reports', [['Reservation Activity Report', 'activity'], ['10 Day Availability', 'future'], ['No Show Report', 'noshow']]],
  ['Group Reports', [['Group Pickup Summary', 'grouppickup']]],
  ['Accounts Receivable Reports', [['Accounts Receivable Aging Report', 'araging']]]];
const repCats = () => REPORT_CATS.map(c => c[0] === 'Front Desk Reports' && rwOn() ? [c[0], c[1].concat([['Rewards Program Members', 'rwmembers'], ['Rewards Program Statistics', 'rwstats']])] : c);
const REPORT_INFO = {
  rwmembers: 'Every rewards member with tier, points, lifetime points, nights, stays and room revenue, best guests first.', rwstats: 'For each tier: members, points outstanding, lifetime points, nights and revenue, and what all the outstanding points are worth.',
  arrivals: 'Guests with a reservation due to arrive who have not checked in yet.', departures: 'In-house guests due to leave today or earlier, with their balances.',
  inhouse: 'Every guest checked in right now, with room, dates, rate and balance.', vacant: 'Rooms that are empty tonight, with their housekeeping condition.',
  maintenance: 'Work orders for rooms: what is broken or needs doing, who opened it and when. Open ones only, or everything opened in the dates chosen.',
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
  maintenance: () => [{ k: 'show', t: 'select', l: 'Show:', o: [['open', 'Open work orders only'], ['all', 'All work orders opened in these dates']], d: 'open' }, { k: 'from', t: 'date', l: 'Start Date:' }, { k: 'to', t: 'date', l: 'End Date:' }],
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
  const col = view.repCol || {}, cats = repCats(), allOff = cats.every(c => col[c[0]]);
  return `<h1 class="rtitle">Reports</h1><div class="rsearch"><label for="repSearch">Search:</label><br><input type="text" id="repSearch" value="${esc(view.repQ || '')}" autocomplete="off"></div><hr class="dash">
  <div class="rtop"><button class="btn blue" data-act="repAll">${allOff ? 'EXPAND ALL' : 'COLLAPSE ALL'}</button></div>
  <div class="rcols">${cats.map(c => `<div class="rcat ${col[c[0]] ? 'off' : ''}"><div class="rch" data-act="repCat" data-cat="${esc(c[0])}"><span class="tri">${col[c[0]] ? '▶' : '▼'}</span>${esc(c[0])}</div>${c[1].map(r => `<a class="rlink" href="#" data-act="rep" data-rep="${r[1]}" data-label="${esc(r[0])}">${esc(r[0])}</a>`).join('')}</div>`).join('')}</div>`;
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
    const rwc = rwOn(), ins = (a, v) => { if (rwc) a.splice(4, 0, v); return a; };
    h = T(ins(['Room', 'Account', 'VIP', 'Guest Name', 'Notes', 'Arrive', 'Depart', 'Adults/ Children', 'Room Type', 'Package', '#Rate', 'GTD', 'Source', '#Balance'], 'Rewards'), l.map(r => ins([esc(r.room), esc(r.conf), r.vip ? 'VIP' : '', guest(r), `<div class="note">${esc(r.notes)}</div>`, dshort(r.arrive), dshort(r.depart), (r.adults || 0) + '/' + (r.children || 0), esc(r.type), esc(r.pkg), money(rateOf(r)), gtd(r.guarantee), esc(r.source), money(S.bal[r.id] || 0)], esc(rwTierOf(r)))), 'inh')
      + `<div class="sh-total">Total Guests: ${l.reduce((s, r) => s + (r.adults || 0) + (r.children || 0), 0)} &nbsp; &nbsp;Total Rooms: ${l.length}</div>`;
  }
  else if (view.rep === 'vacant') {
    const rows = S.config.rooms.filter(r => !inRoom(r.no) && (!opt.type || r.type === opt.type) && (!opt.cond || cond(r.no) === opt.cond) && (opt.ooo !== false || !isOOO(r.no, B()))).map(r => ({ r, out: isOOO(r.no, B()), a: S.res.find(x => x.status === 'reserved' && x.room === r.no && x.arrive <= B()) })).filter(x => opt.arr !== false || !x.a);
    const names = opt.names !== false, heads = ['Room', 'Type', 'Condition', 'Status'].concat(names ? ['Arriving Guest'] : []);
    h = T(heads, rows.map(x => [esc(x.r.no), esc(x.r.type), { R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(x.r.no)], x.out ? 'Out of Order' : 'Vacant'].concat(names ? [x.a ? esc(gname(x.a)) : ''] : []))) + `<div class="sh-total">Total Vacant Rooms: ${rows.filter(x => !x.out).length}</div>`;
  }
  else if (view.rep === 'hkcheck') h = hkCheckHtml();
  else if (view.rep === 'maintenance') {
    const all = opt.show === 'all', R = await api(`/report?name=maintenance&from=${view.from}&to=${view.to}&all=${all ? 1 : 0}`);
    h = T(['Room', 'Reason', 'Notes', 'Opened', 'Opened by', 'Status', 'Closed'], R.rows.map(w => [esc(w.room), esc(w.reason), esc(w.notes), dshort(w.bdate), esc(w.createdBy), w.status === 'done' ? 'Done' : 'Open', w.doneAt ? stamp(w.doneAt) + ' ' + esc(w.doneBy) : '']))
      + `<div class="sh-total">${all ? 'Work orders opened ' + dshort(view.from) + ' to ' + dshort(view.to) : 'Open work orders'}: ${R.rows.length}</div>`;
  }
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
  else if (view.rep === 'rwmembers' || view.rep === 'rwstats') {
    const R = await api('/report?name=rewards'), n = x => Number(x).toLocaleString('en-US'), tt = R.totals;
    if (view.rep === 'rwmembers') h = T(['Member #', 'Name', 'Tier', '#Points', '#Lifetime Points', '#Nights', '#Stays', '#Revenue', 'Joined'], R.rows.map(x => [esc(x.number), esc(x.name), esc(x.tier), n(x.points), n(x.earned), n(x.nights), n(x.stays), money(x.revenue), dshort(x.joined)]).concat([tot('Totals (' + n(tt.members) + (tt.members === 1 ? ' member)' : ' members)'), [n(tt.points), n(tt.earned), n(tt.nights), n(tt.stays), money(tt.revenue), ''], 3)])) + `<div class="sh-total">Total Members: ${n(tt.members)}</div>`;
    else h = T(['Tier', '#Members', '#Points Outstanding', '#Lifetime Points', '#Nights', '#Revenue'], R.tiers.map(x => [esc(x.name) + ' <span class="sub">from ' + n(x.min) + ' points</span>', n(x.members), n(x.points), n(x.earned), n(x.nights), money(x.revenue)]).concat([tot('Total:', [n(tt.members), n(tt.points), n(tt.earned), n(tt.nights), money(tt.revenue)])])) + `<div class="sh-total">Points outstanding: ${n(tt.points)} &nbsp; Value of all outstanding points: ${money(R.outstandingValue)} (each point is worth ${R.pointValue} cent${R.pointValue === 1 ? '' : 's'} when redeemed)</div>`;
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
    else if (view.rep === 'grouppickup') h = T(['Group', 'Arrival', 'Departure', 'Cut-off', '#Blocked', '#Picked up', '#Left', '#Room revenue', 'Status'], R.rows.map(x => [esc(x.name), dshort(x.arrive), dshort(x.depart), esc(cutTxt(x)), x.blocked, x.picked, x.left, money(x.revenue), x.status]));
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
const hkCheckHtml = () => `<table class="rt"><tr><th>Room</th><th>Type</th><th>Status</th><th>Condition</th><th>Service</th><th>Housekeeper</th><th>Notes</th><th>Done</th></tr>${S.config.rooms.map(rm => { const st = S.roomstate[rm.no] || {}; return `<tr><td><b>${esc(rm.no)}</b>${woOpen(rm.no) ? ' 🔧' : ''}</td><td>${esc(rm.type)}</td><td>${inRoom(rm.no) ? 'Occupied' : 'Vacant'}</td><td>${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(rm.no)]}</td><td>${service(rm.no)}${st.dnd ? ' (DND)' : ''}</td><td>${esc(st.hk || '')}</td><td>${esc([hkPreText(rm.no), st.note].filter(Boolean).join(' · '))}</td><td>☐</td></tr>`; }).join('')}</table>`;
async function nightAudit() {
  const s = S.stats;
  if (!confirm(`Run the night audit for ${dlong(B())}?\n\n• Posts tonight's room charge and tax to ${s.sold} in-house rooms\n• Marks ${s.arrivalsLeft} arrivals that did not check in as no shows\n• Extends ${s.dueOut} guests who were due out but are still checked in\n• Moves the business date to ${dlong(addDays(B(), 1))}\n\nThis cannot be undone.`)) return;
  await run(async () => { const x = (await op('nightAudit', { date: B() })).audit; view.tapeStart = x.newDate; view.from = x.date; view.to = x.newDate; await refresh(); alert(`Night audit finished for ${dshort(x.date)}.\n\nRoom charges posted: ${x.posted} (${money(x.revenue)})\nRecurring charges posted: ${x.recurring || 0}\nNo shows: ${x.noShows.length}${x.noShows.length ? '\n  ' + x.noShows.join('\n  ') : ''}\nStays extended: ${x.extended.length}${x.extended.length ? '\n  ' + x.extended.join('\n  ') : ''}\n\nThe business date is now ${dlong(x.newDate)}.`); });
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
  ${l.length ? `<div class="wrap"><table><tr><th>Group</th><th>Arrival</th><th>Departure</th><th>Cut-off</th><th class="num">Blocked</th><th class="num">Picked up</th><th class="num">Left</th><th>Status</th></tr>${l.map(g => `<tr class="click" data-act="grpOpen" data-id="${g.id}"><td><b>${esc(g.name)}</b></td><td>${dshort(g.arrive)}</td><td>${dshort(g.depart)}</td><td>${esc(cutTxt(g))}${g.cutoffDays == null && g.cutoff && g.cutoff < B() ? ' <span class="badge s">released</span>' : ''}</td><td class="num">${blocked(g)}</td><td class="num">${picked(g)}</td><td class="num">${Math.max(0, blocked(g) - picked(g))}</td><td>${g.status === 'cancelled' ? '<span class="badge r">Cancelled</span>' : '<span class="badge g">Active</span>'}</td></tr>`).join('')}</table></div>` : '<div class="empty">No groups yet.</div>'}`;
}
let GR = null;
async function grpOpen(id) { GR = id ? await api('/group?id=' + id) : { group: { name: '', arrive: B(), depart: addDays(B(), 2), cutoff: '', blocks: {}, rates: {}, recur: [], status: 'active' }, members: [] }; grpDraw(); }
function grpDraw() {
  const g = GR.group, n = !g.id, f = (k, label, cls, extra) => `<label class="${cls || ''}">${label}<input id="g_${k}" value="${esc(g[k] == null ? '' : g[k])}" ${extra || ''}></label>`;
  $('#modal').innerHTML = `<div class="mback"><div class="mbox wide"><div class="mtitle">${n ? 'New group' : esc(g.name)}</div>
  <div class="grid">${f('name', 'Group name *', 'c6', 'maxlength="80"')}${f('contact', 'Contact person', 'c3', 'maxlength="80"')}${f('phone', 'Phone', 'c3', 'maxlength="30"')}${f('arrive', 'Arrival', 'c3', 'type="date"')}${f('depart', 'Departure', 'c3', 'type="date"')}
    <label class="c6">Company (optional)<select id="g_companyId"><option value="0">No company</option>${S.companies.map(c => `<option value="${c.id}" ${c.id === g.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>${f('email', 'E-mail', 'c6', 'maxlength="100"')}${f('notes', 'Notes', 'c12', 'maxlength="500"')}</div>
  <div class="cutbox"><b>Cut-off</b> <span class="hint">(unsold rooms go back on sale)</span>
    <label class="rad"><input type="radio" name="gcm" id="g_cm_fixed" ${g.cutoffDays == null ? 'checked' : ''}> Fixed date</label><input type="date" id="g_cutoff" value="${esc(g.cutoff || '')}" aria-label="Fixed cut-off date">
    <span class="nw"><label class="rad"><input type="radio" name="gcm" id="g_cm_roll" ${g.cutoffDays != null ? 'checked' : ''}> Rolling: release each night</label><input type="number" id="g_cutoffDays" min="0" max="365" value="${g.cutoffDays != null ? g.cutoffDays : ''}" aria-label="Days before each night"><span>days before it</span></span></div>
  <div class="sec">Rooms held and group rate</div><div class="wrap"><table><tr><th>Room type</th><th class="num">Hotel has</th><th>Rooms to hold</th><th>Group rate / night (blank = normal rate)</th></tr>${S.config.types.map(t => `<tr><td><b>${esc(t.code)}</b> ${esc(t.name)}</td><td class="num">${S.config.rooms.filter(r => r.type === t.code).length}</td><td><input data-gb="${esc(t.code)}" type="number" min="0" value="${(g.blocks || {})[t.code] || ''}" style="width:110px;min-height:34px"></td><td><input data-gr="${esc(t.code)}" inputmode="decimal" value="${(g.rates || {})[t.code] ? ((g.rates[t.code]) / 100).toFixed(2) : ''}" style="width:130px;min-height:34px"></td></tr>`).join('')}</table></div>
  ${n ? '' : `<div class="sec">Reservations in this group (${GR.members.length})</div><div class="acts" style="margin-bottom:8px"><button class="btn sm green" data-act="grpAddRes">+ Reservation in this group</button><button class="btn sm" data-act="grpPrint">Print rooming list</button><button class="btn sm blue" data-act="impOpen">Import Rooming List</button>${g.status === 'cancelled' ? '<button class="btn sm" data-act="grpStatus" data-to="active">Reactivate group</button>' : '<button class="btn sm red" data-act="grpStatus" data-to="cancelled">Cancel group (release the rooms)</button>'}</div><div class="wrap" style="max-height:30vh">${grpMembers()}</div>`}
  <div class="sec">Recurring charges <span class="hint">(posted every night to every guest in the group)</span></div><div id="grRecur">${grRecur()}</div>
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
const SETUP_GROUPS = [['Hotel Settings', ['property', 'policies', 'types', 'rooms', 'rates', 'packages', 'rewards']], ['Money', ['taxes', 'codes']], ['Housekeeping', ['hks', 'schedules', 'woreasons', 'ooo']], ['People', ['users']]];
const SETUP_NAMES = { property: 'Property', policies: 'Policies', types: 'Room Types and Rates', rooms: 'Rooms', rates: 'Rates by Date', packages: 'Packages', rewards: 'Rewards', taxes: 'Taxes', codes: 'Posting Codes', hks: 'Housekeepers', schedules: 'Cleaning Schedules', woreasons: 'Work Order Reasons', ooo: 'Out of Order Rooms', users: 'Logins' };
const CODE_TYPES = [['ROOM', 'ROOM - room charge'], ['MISC', 'MISC - other charge'], ['CASH', 'CASH - cash payment'], ['CRED', 'CRED - card payment'], ['AREC', 'AREC - direct bill'], ['GFTCRD', 'GFTCRD - gift card'], ['ADMIN', 'ADMIN - write-off']];
const t12 = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!m) return String(t || ''); const h = +m[1]; return ((h % 12) || 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM'); };
const timeOpts = cur => { const l = []; for (let i = 0; i < 48; i++) l.push(String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00')); if (cur && !l.includes(cur)) l.unshift(cur); return l.map(v => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t12(v))}</option>`).join(''); };
const dollars = c => ((c || 0) / 100).toFixed(2);
const cityLineC = c => [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const defaultCancel = h => `Please cancel at least ${h} hours before your arrival to avoid a charge for the first night.`;
function policyLines() {   // the hotel's policies as plain sentences (only the ones that are filled in)
  const c = S.config, p = c.policies; if (!p) return []; const m = v => '$' + (v / 100).toFixed(2);
  const L = [p.cancelText || defaultCancel(p.cancelHours)]; if (p.deposit > 0) L.push(`A deposit of ${m(p.deposit)} is taken when you book.`); if (p.hold > 0) L.push(`A card hold of ${m(p.hold)} per stay is placed for incidentals.`);
  L.push(p.pets === 'yes' ? 'Pets are allowed' + (p.petFee > 0 ? ` for a fee of ${m(p.petFee)} per night.` : '.') : 'Pets are not allowed.'); if (p.smokingFee > 0) L.push(`A smoking fee of ${m(p.smokingFee)} applies to a room that was smoked in.`); if (p.other) L.push(p.other); return L;
}
const policyHtml = () => { const L = policyLines(); return L.length ? '<h3>Hotel Policies</h3>' + L.map(x => `<p>${esc(x)}</p>`).join('') : ''; };
const rlSort = l => l.slice().sort((a, b) => (a.rentLast ? 1 : 0) - (b.rentLast ? 1 : 0));   // Rent Last rooms go to the end of a list to pick from
const roomSort = (a, b) => String(a.no).localeCompare(String(b.no), 'en', { numeric: true });
const makeCode = (name, used, max) => {   // "Two Queens" -> "TQ"; made unique by adding a number
  let b = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, max - 2) || 'X', c = b, n = 2; while (used.has(c)) c = b + n++; return c;
};
let SD = null;   // the table being edited: { page, rows } (kept when a row is added or removed, dropped after Save)
function sdRows(page) {
  const c = S.config;
  if (page === 'types') return c.types.map(t => ({ code: t.code, name: t.name, rate: dollars(t.rate) }));
  if (page === 'rooms') return c.rooms.map(r => ({ no: r.no, type: r.type, floor: r.floor, nosmoke: !!r.nosmoke, accessible: !!r.accessible, rentLast: !!r.rentLast, sched: r.sched })).sort(roomSort);
  if (page === 'taxes') return c.taxes.map(t => ({ code: t.code, name: t.name, pct: String(t.pct) }));
  if (page === 'codes') return c.codes.map(k => ({ code: k.code, name: k.name, type: k.type, tax: (k.tax || []).slice() }));
  if (page === 'rates') return (c.rateRules || []).map(k => ({ name: k.name, from: k.from, to: k.to, days: (k.days || []).slice(), type: k.type || '*', rate: dollars(k.rate) }));
  if (page === 'packages') return (c.packages || []).map(k => ({ code: k.code, name: k.name, price: dollars(k.price), charge: k.charge || 'MS' }));
  if (page === 'woreasons') return (c.woReasons || []).map(x => ({ active: x.active !== false, name: x.name }));
  if (page === 'hks') return c.housekeepers.map(n => ({ name: n }));
  return null;
}
const sdBlank = page => ({ types: { code: '', name: '', rate: '' }, taxes: { code: '', name: '', pct: '' }, codes: { code: '', name: '', type: 'MISC', tax: [] }, rates: { name: '', from: '', to: '', days: [], type: '*', rate: '' }, packages: { code: '', name: '', price: '', charge: 'MS' }, hks: { name: '' }, woreasons: { active: true, name: '' } }[page]);
function sdStart() { SD = sdRows(view.setup) ? { page: view.setup, rows: sdRows(view.setup) } : null; }
function sdRead() {   // copy what is typed in the table into SD.rows
  const f = $('#sdForm'); if (!SD || !f || f.dataset.page !== SD.page) return;
  f.querySelectorAll('tr[data-i]').forEach(tr => { const o = SD.rows[+tr.dataset.i]; if (!o) return; const multi = {};
    tr.querySelectorAll('[data-f]').forEach(el => { const k = el.dataset.f; if (el.dataset.v !== undefined) { (multi[k] = multi[k] || []); if (el.checked) multi[k].push(isNaN(el.dataset.v) ? el.dataset.v : +el.dataset.v); } else o[k] = el.type === 'checkbox' ? el.checked : el.value; });
    Object.assign(o, multi); });
}
const sdIn = (i, f, v, ph, extra) => `<input data-f="${f}" value="${esc(v)}" ${ph ? `placeholder="${esc(ph)}"` : ''} ${extra || ''} aria-label="${esc(f)}">`;
const sdSel = (f, v, opts) => `<select data-f="${f}" aria-label="${esc(f)}">${opts.map(o => `<option value="${esc(o[0])}" ${String(o[0]) === String(v) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
const sdChk = (f, v, label) => `<input type="checkbox" data-f="${f}" ${v ? 'checked' : ''} aria-label="${esc(label || f)}">`;
const sdTable = (head, rows, o) => `<div class="wrap"><table class="sdt"><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.map((r, i) => `<tr data-i="${i}">${r}</tr>`).join('') || `<tr><td colspan="${head.length}" class="empty">${o.empty}</td></tr>`}</table></div>`;
const sdDelBtn = (i, off) => `<td><button type="button" class="btn sm" data-act="sdDel" data-i="${i}" ${off ? 'disabled' : ''}>Remove</button></td>`;
const sdFoot = add => `<div class="mfoot sdfoot" style="justify-content:flex-start">${add ? `<button type="button" class="btn blue" data-act="sdAdd">${add}</button>` : ''}<button class="btn green" data-act="setupSave">Save</button><span class="err" id="setupErr" role="alert"></span></div>`;
function sdTypesPage(c) {
  const cnt = code => c.rooms.filter(r => r.type === code).length;
  return `<p class="hint">Your kinds of rooms and what each costs per night. Leave Code empty and one is made from the name (Two Queens becomes TQ). A type that still has rooms cannot be removed.</p>` +
    sdTable(['Code', 'Name', 'Price per night', 'Rooms', ''], SD.rows.map((t, i) => `<td>${sdIn(i, 'code', t.code, 'auto', 'maxlength="8" style="width:90px;text-transform:uppercase"')}</td><td>${sdIn(i, 'name', t.name, 'King', 'maxlength="60"')}</td><td>${sdIn(i, 'rate', t.rate, '0.00', 'inputmode="decimal" style="width:110px"')}</td><td class="num">${cnt(t.code)}</td>${sdDelBtn(i)}`), { empty: 'No room types.' }) + sdFoot('+ Add Room Type');
}
function sdRoomsPage(c) {
  const opts = c.types.map(t => [t.code, t.code + ' - ' + t.name]), sopts = (c.cleanSchedules || []).map(x => [x.id, x.name]);
  return `<p class="hint">${SD.rows.length} room${SD.rows.length === 1 ? '' : 's'} in the hotel. "Rent Last" rooms are offered after all the others when a room is picked. Changes are kept when you click Save.</p><div class="bar" style="margin-bottom:8px"><button type="button" class="btn blue" data-act="rmAdd">Add Room</button><button type="button" class="btn" data-act="rmMany">Add Many Rooms</button><button type="button" class="btn" data-act="rmImport">Import rooms from a list</button></div>` +
    sdTable(['Room #', 'Type', 'Floor', 'No Smoking', 'Accessible', 'Rent Last', 'Cleaning Schedule', ''], SD.rows.map((r, i) => `<td><b>${esc(r.no)}</b></td><td>${sdSel('type', r.type, opts.some(o => o[0] === r.type) ? opts : opts.concat([[r.type, r.type]]))}</td><td>${sdIn(i, 'floor', r.floor, '', 'maxlength="4" style="width:60px"')}</td><td class="ctr">${sdChk('nosmoke', r.nosmoke, 'No smoking')}</td><td class="ctr">${sdChk('accessible', r.accessible, 'Accessible')}</td><td class="ctr">${sdChk('rentLast', r.rentLast, 'Rent last')}</td><td>${sdSel('sched', r.sched, sopts.some(o => o[0] === r.sched) ? sopts : sopts.concat([[r.sched, r.sched]]))}</td>${sdDelBtn(i)}`), { empty: 'No rooms yet. Click Add Room.' }) + sdFoot('');
}
function sdTaxesPage() {
  return `<p class="hint">Taxes added to charges. Choose which taxes each charge gets in Posting Codes.</p>` + sdTable(['Code', 'Name', 'Percent', ''], SD.rows.map((t, i) => `<td>${sdIn(i, 'code', t.code, 'auto', 'maxlength="6" style="width:80px;text-transform:uppercase"')}</td><td>${sdIn(i, 'name', t.name, 'State Tax', 'maxlength="60"')}</td><td>${sdIn(i, 'pct', t.pct, '0.00', 'inputmode="decimal" style="width:90px"')}</td>${sdDelBtn(i)}`), { empty: 'No taxes.' }) + sdFoot('+ Add Tax');
}
function sdCodesPage(c) {
  const th = ['Code', 'Name', 'Type'].concat(c.taxes.map(t => esc(t.code)), ['']);
  const rows = SD.rows.map((k, i) => ({ k, i }));
  return `<p class="hint">Everything that can be posted to a guest's bill. ROOM and MISC are charges; CASH, CRED, AREC and GFTCRD are payments; ADMIN is for write-offs. Tick the taxes each charge gets. RM (Room Charge) must stay: the night audit posts it.</p>
    <div class="bar"><input id="codeQ" type="search" placeholder="Quick search" style="max-width:260px" aria-label="Quick search"></div>` +
    sdTable(th, rows.map(({ k, i }) => `<td>${sdIn(i, 'code', k.code, '', 'maxlength="8" style="width:80px;text-transform:uppercase"')}</td><td>${sdIn(i, 'name', k.name, '', 'maxlength="60"')}</td><td>${sdSel('type', k.type, CODE_TYPES)}</td>${c.taxes.map(t => `<td class="ctr"><input type="checkbox" data-f="tax" data-v="${esc(t.code)}" ${(k.tax || []).includes(t.code) ? 'checked' : ''} aria-label="${esc(t.code)}"></td>`).join('')}${sdDelBtn(i, k.code === 'RM')}`), { empty: 'No posting codes.' }) + sdFoot('+ Add Posting Code');
}
function sdRatesPage(c) {
  const types = [['*', 'All types']].concat(c.types.map(t => [t.code, t.code + ' - ' + t.name]));
  return `<p class="hint">Rates that change by date, such as a holiday or a busy season. Leave every day unticked for all days. When two lines cover the same night, the lower line wins. Nights with no line use the room type's normal price.</p>` +
    sdTable(['Name', 'From', 'Through', 'Days', 'Room type', 'Rate', ''], SD.rows.map((k, i) => `<td>${sdIn(i, 'name', k.name, 'Derby weekend', 'maxlength="40"')}</td><td><input type="date" data-f="from" value="${esc(k.from)}" aria-label="From"></td><td><input type="date" data-f="to" value="${esc(k.to)}" aria-label="Through"></td><td class="days">${DOW.map((d, n) => `<label class="dchk"><input type="checkbox" data-f="days" data-v="${n}" ${(k.days || []).includes(n) ? 'checked' : ''}>${d}</label>`).join('')}</td><td>${sdSel('type', k.type, types.some(o => o[0] === k.type) ? types : types.concat([[k.type, k.type]]))}</td><td>${sdIn(i, 'rate', k.rate, '0.00', 'inputmode="decimal" style="width:100px"')}</td>${sdDelBtn(i)}`), { empty: 'No special rates.' }) + sdFoot('+ Add Rate');
}
function sdPackagesPage(c) {
  const codes = c.codes.filter(k => ['ROOM', 'MISC'].includes(k.type)).map(k => [k.code, k.code + ' - ' + k.name]);
  return `<p class="hint">Extras sold with the room and charged every night by the night audit, like breakfast. Taxes follow the posting code.</p>` +
    sdTable(['Code', 'Name', 'Price per night', 'Posting code', ''], SD.rows.map((k, i) => `<td>${sdIn(i, 'code', k.code, 'auto', 'maxlength="8" style="width:90px;text-transform:uppercase"')}</td><td>${sdIn(i, 'name', k.name, 'Breakfast', 'maxlength="60"')}</td><td>${sdIn(i, 'price', k.price, '0.00', 'inputmode="decimal" style="width:100px"')}</td><td>${sdSel('charge', k.charge, codes.some(o => o[0] === k.charge) ? codes : codes.concat([[k.charge, k.charge]]))}</td>${sdDelBtn(i)}`), { empty: 'No packages.' }) + sdFoot('+ Add Package');
}
function sdHksPage() {
  return `<p class="hint">The housekeepers' names, as they appear when you assign rooms.</p>` + sdTable(['Name', ''], SD.rows.map((k, i) => `<td>${sdIn(i, 'name', k.name, 'Name', 'maxlength="40"')}</td>${sdDelBtn(i)}`), { empty: 'No housekeepers yet.' }) + sdFoot('+ Add Housekeeper');
}
function sdWoReasonsPage() {
  return `<p class="hint">The reasons people can pick when they open a work order for a room. Untick Active to hide a reason without losing it. Work orders already opened keep the reason they were given.</p>` +
    sdTable(['Active', 'Reason', ''], SD.rows.map((k, i) => `<td class="ctr">${sdChk('active', k.active, 'Active')}</td><td>${sdIn(i, 'name', k.name, 'Plumbing', 'maxlength="40"')}</td>${sdDelBtn(i)}`), { empty: 'No reasons yet.' }) + sdFoot('+ Add Reason');
}
/* ---------- Cleaning Schedules: list on the left, the chosen schedule on the right ---------- */
let CS = null;   // { rows: [{id, name, days}], sel } while the page is open
const csLine = s => s.days.map((d, i) => 'Day ' + (i + 1) + ': ' + SCH_WORD[d]).join(' ');
function csStart() { CS = { rows: S.config.cleanSchedules.map(x => ({ id: x.id, name: x.name, days: x.days.slice() })), sel: Math.min(view.csSel || 0, S.config.cleanSchedules.length - 1) }; }
function csRead() { if (!CS || !$('#cs_name')) return; const x = CS.rows[CS.sel]; if (!x) return; x.name = $('#cs_name').value; x.days = x.days.map((d, i) => { const r = document.querySelector(`input[name=cs_d${i}]:checked`); return r ? r.value : d; }); }
function csPage() {
  const x = CS.rows[CS.sel], more = x.days.length <= 7;
  return `<p class="hint">Say how each room is cleaned on each day of a stay. Day 1 is the first morning after the guest arrived. After the last day the pattern starts again. Each room picks its schedule in Setup › Rooms. Check Out rooms are always cleaned in full.</p>
  <div class="csg"><div class="cslist">${CS.rows.map((r, i) => `<a href="#" class="${i === CS.sel ? 'on' : ''}" data-act="csSel" data-i="${i}"><b>${esc(r.name || '(no name)')}</b><span class="hint">${esc(csLine(r))}</span></a>`).join('')}</div>
  <div class="card csdet"><label>Name<input id="cs_name" maxlength="40" value="${esc(x.name)}"></label>
    <div class="csdays">${x.days.map((d, i) => `<div class="csday"><b>Day ${i + 1}</b>${['F', 'L', 'N'].map(k => `<label class="dchk"><input type="radio" name="cs_d${i}" value="${k}" ${d === k ? 'checked' : ''}>${SCH_WORD[k]}</label>`).join('')}</div>`).join('')}</div>
    <p style="margin:8px 0"><a href="#" data-act="${more ? 'csMore' : 'csLess'}">${more ? 'Show more days' : 'Show fewer days'}</a> <span class="hint">(up to 14 days)</span></p>
    <div class="mfoot sdfoot" style="justify-content:flex-start"><button type="button" class="btn blue" data-act="csAdd">Add Schedule</button><button type="button" class="btn green" data-act="csSave">Save</button><button type="button" class="btn red" data-act="csDel">Delete</button><span class="err" id="setupErr" role="alert"></span></div></div></div>`;
}
function csRoomsUsing(id) { return S.config.rooms.filter(r => r.sched === id).map(r => r.no); }
async function csSave(rows) {
  await run(async () => { try {
    sdErr(''); const names = new Set();
    for (const r of rows) { const n = String(r.name).trim(); if (!n) throw new Error('Give each cleaning schedule a name.'); if (names.has(n.toLowerCase())) throw new Error('Two schedules are called "' + n + '". Change one name.'); names.add(n.toLowerCase()); }
    await op('configSave', { config: { cleanSchedules: rows.map(r => ({ ...r, name: r.name.trim() })) } }); view.csSel = CS.sel; CS = null; await refresh(); toast('Saved.');
  } catch (e) { if (e.status === 401 || (e.status === 403 && /turned off/.test(e.message))) throw e; sdErr(e.message); } });
}
function csClick(a, el) {
  csRead();
  if (a === 'csSel') { CS.sel = +el.dataset.i; return render(); }
  if (a === 'csMore') { const x = CS.rows[CS.sel]; x.days = Array.from({ length: 14 }, (_, i) => x.days[i % x.days.length]); return render(); }
  if (a === 'csLess') { const x = CS.rows[CS.sel]; x.days = x.days.slice(0, 7); return render(); }
  if (a === 'csAdd') { let n = CS.rows.length + 1; while (CS.rows.some(r => r.name.toLowerCase() === 'schedule ' + n)) n++; CS.rows.push({ id: 'n' + Math.random().toString(36).slice(2, 8), name: 'Schedule ' + n, days: Array(7).fill('F') }); CS.sel = CS.rows.length - 1; return render(); }
  if (a === 'csSave') return csSave(CS.rows);
  if (a === 'csDel') {
    const x = CS.rows[CS.sel]; if (CS.rows.length < 2) return sdErr('You cannot delete the last cleaning schedule. A hotel needs at least one.');
    const used = csRoomsUsing(x.id); if (used.length) return sdErr('"' + x.name + '" cannot be deleted: ' + (used.length === 1 ? 'room ' : used.length + ' rooms use it: ') + (used.length > 12 ? used.slice(0, 12).join(', ') + ' and ' + (used.length - 12) + ' more' : used.join(', ')) + '. Change ' + (used.length === 1 ? 'that room' : 'those rooms') + ' to another schedule in Setup › Rooms first.');
    if (!confirm('Delete the cleaning schedule "' + x.name + '"?')) return;
    CS.rows.splice(CS.sel, 1); CS.sel = Math.max(0, CS.sel - 1); return csSave(CS.rows);
  }
}
function vSetup() {
  const c = S.config; let body = '';
  if (!view.setup) {   // the Setup home: links in columns
    return `<h1>Hotel Configuration</h1><div class="setcols">${SETUP_GROUPS.map(g => `<div class="card setcol"><h2>${g[0]}</h2>${g[1].map(k => `<a href="#" data-act="setupTab" data-tab="${k}">${SETUP_NAMES[k]}</a>`).join('')}</div>`).join('')}</div>`;
  }
  if (view.setup !== 'schedules') CS = null; else if (!CS) csStart();
  sdRead(); if (!SD || SD.page !== view.setup) sdStart();
  const save = sdFoot('');
  if (view.setup === 'property') body = `<div class="grid card"><label class="c6">Hotel name<input id="s_name" value="${esc(c.name)}" maxlength="80"></label><label class="c6">General Manager<input id="s_gm" value="${esc(c.gm)}" maxlength="60"></label><label class="c12">Address<input id="s_address" value="${esc(c.address)}" maxlength="200"></label><label class="c6">City<input id="s_city" value="${esc(c.city)}" maxlength="60"></label><label class="c3">State<input id="s_state" value="${esc(c.state)}" maxlength="30"></label><label class="c3">ZIP<input id="s_zip" value="${esc(c.zip)}" maxlength="15"></label><label class="c3">Phone<input id="s_phone" value="${esc(c.phone)}" maxlength="40"></label><label class="c3">Reservation phone<input id="s_resPhone" value="${esc(c.resPhone)}" maxlength="40"></label><label class="c3">Fax<input id="s_fax" value="${esc(c.fax)}" maxlength="40"></label><label class="c3">Tax ID<input id="s_taxId" value="${esc(c.taxId)}" maxlength="30"></label><label class="c3">Check-in time<select id="s_checkinTime">${timeOpts(c.checkinTime)}</select></label><label class="c3">Check-out time<select id="s_checkoutTime">${timeOpts(c.checkoutTime)}</select></label><label class="chk c12"><input type="checkbox" id="s_requireShift" ${c.requireShift ? 'checked' : ''}>Front desk must open a cashier shift before taking payments</label></div>${save}`;
  else if (view.setup === 'policies') { const p = c.policies || {}, h = p.cancelHours == null ? 24 : p.cancelHours; body = `<p class="hint">These are printed on the registration card and the confirmation. Nothing here charges a guest by itself; the desk still posts any charge.</p><div class="grid card">
    <label class="c6">Guests can cancel free up to (hours before arrival)<input id="s_cancelHours" inputmode="numeric" value="${h}"></label><label class="c6"><span>&nbsp;</span><span class="hint" style="font-weight:400">Wording below follows the hours until you change it.</span></label>
    <label class="c12">Cancellation policy wording<textarea id="s_cancelText" rows="2" maxlength="1500" data-def="${esc(defaultCancel(h))}">${esc(p.cancelText || defaultCancel(h))}</textarea></label>
    <label class="c3">Deposit taken when booking ($)<input id="s_deposit" inputmode="decimal" value="${dollars(p.deposit)}"></label><label class="c3">Card hold for incidentals ($ per stay)<input id="s_hold" inputmode="decimal" value="${dollars(p.hold)}"></label>
    <label class="c3">Pets allowed<select id="s_pets"><option value="no" ${p.pets === 'yes' ? '' : 'selected'}>No</option><option value="yes" ${p.pets === 'yes' ? 'selected' : ''}>Yes</option></select></label><label class="c3">Pet fee per night ($)<input id="s_petFee" inputmode="decimal" value="${dollars(p.petFee)}"></label>
    <label class="c3">Smoking fee ($)<input id="s_smokingFee" inputmode="decimal" value="${dollars(p.smokingFee)}"></label>
    <label class="c12">Other house rules<textarea id="s_other" rows="3" maxlength="1500">${esc(p.other)}</textarea></label>
    <label class="c12">Words on the registration card<textarea id="s_regText" rows="3" maxlength="1500">${esc(c.regText)}</textarea></label></div>${save}`; }
  else if (view.setup === 'types') body = sdTypesPage(c);
  else if (view.setup === 'rooms') body = sdRoomsPage(c);
  else if (view.setup === 'taxes') body = sdTaxesPage();
  else if (view.setup === 'codes') body = sdCodesPage(c);
  else if (view.setup === 'rates') body = sdRatesPage(c);
  else if (view.setup === 'packages') body = sdPackagesPage(c);
  else if (view.setup === 'hks') body = sdHksPage();
  else if (view.setup === 'woreasons') body = sdWoReasonsPage();
  else if (view.setup === 'schedules') body = csPage();
  else if (view.setup === 'rewards') { const w = S.rewards; body = `<p class="hint">A guest rewards program the hotel runs for its own guests. Members earn points when they check out, and spend them on the folio (Post Payment, Rewards Redemption). The posting code RW is added for you.</p><div class="grid card">
    <label class="chk c12"><input type="checkbox" id="s_rw_enabled" ${w.enabled ? 'checked' : ''}>Run the rewards program at this hotel</label>
    <label class="c6">Program name<input id="s_rw_name" maxlength="40" value="${esc(w.name)}"></label>
    <label class="c6">Points are earned by<select id="s_rw_earn"><option value="nights" ${w.earn === 'nights' ? 'selected' : ''}>Paid nights</option><option value="revenue" ${w.earn === 'revenue' ? 'selected' : ''}>Room revenue</option></select></label>
    <label class="c3">Points per paid night<input id="s_rw_perNight" inputmode="numeric" value="${w.perNight}"></label><label class="c3">Points per dollar of room revenue<input id="s_rw_perDollar" inputmode="numeric" value="${w.perDollar}"></label>
    <label class="c3">Point value when redeemed (cents)<input id="s_rw_pointValue" inputmode="numeric" value="${w.pointValue}"></label><label class="c3">Least points to redeem<input id="s_rw_minRedeem" inputmode="numeric" value="${w.minRedeem}"></label>
    <label class="c12">Tiers (up to 6). One line each: name, minimum lifetime points, welcome amenity, message for the desk. The first tier starts at 0.<textarea id="s_rw_tiers" rows="7" style="font-family:Consolas,monospace">${esc(w.tiers.map(t => `${t.name}, ${t.min}, ${t.amenity}, ${t.message}`).join('\n'))}</textarea></label></div>
    <p class="hint">Now: 1 point is worth ${w.pointValue} cent${w.pointValue === 1 ? '' : 's'}; ${w.earn === 'nights' ? w.perNight + ' points for each paid night' : w.perDollar + ' points for each whole dollar of room revenue'}. The message is shown to the desk at check-in (200 characters at most); the amenity is up to 80.</p>${save}`; }
  else if (view.setup === 'users') body = `<p class="hint">Everyone signs in with their own e-mail address. A new person gets a link to choose their password, and can reset it later with "Forgot your password?" on the sign-in page.</p><div id="usersBox" class="hint">Loading…</div><h2>Add or change a login</h2><div class="grid card"><label>E-mail address<input id="u_email" type="email" autocapitalize="off" maxlength="120"></label><label class="c3">Name<input id="u_name" maxlength="80"></label><label class="c3">Role<select id="u_role"></select></label><label class="chk c2"><input type="checkbox" id="u_disabled">Turned off</label><label class="c12" style="flex-direction:row;gap:8px"><button class="btn green" data-act="userSave">Save login</button><button class="btn" data-act="userInvite">Send a new password link</button></label></div>`;
  else if (view.setup === 'ooo') body = `<div class="bar"><button class="btn red" data-act="blockNew">Take a room out of order…</button></div><div class="wrap"><table><tr><th>Room</th><th>From</th><th>Through</th><th>Reason</th><th></th></tr>${S.blocks.map(b => `<tr><td><b>${esc(b.room)}</b></td><td>${dshort(b.start)}</td><td>${dshort(b.end)}</td><td>${esc(b.reason)}</td><td><button class="btn sm" data-act="blockRemove" data-id="${b.id}">Put back in order</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No rooms are out of order.</td></tr>'}</table></div>`;
  if (view.setup === 'users') setTimeout(async () => { const box = $('#usersBox'); if (!box) return; try { const R = await api('/account/users'), names = { owner: 'Owner', manager: 'Manager (GM)', desk: 'Front desk', hk: 'Housekeeping only' }; $('#u_role').innerHTML = R.may.map(r => `<option value="${r}">${names[r]}</option>`).join(''); if (R.may.includes('desk')) $('#u_role').value = 'desk';
    box.innerHTML = `<div class="wrap"><table><tr><th>Name</th><th>E-mail address</th><th>Role</th><th>Status</th><th>Recovery code</th><th>Last sign-in</th></tr>${R.users.map(x => `<tr class="click" data-act="userPick" data-u="${esc(JSON.stringify(x))}"><td><b>${esc(x.name)}</b></td><td>${esc(x.email)}</td><td>${names[x.role]}</td><td>${x.disabled ? '<span class="badge r">Off</span>' : x.hasPassword ? '<span class="badge g">On</span>' : '<span class="badge a">Has not chosen a password yet</span>'}</td><td>${x.hasRecovery ? 'Yes' : 'No'}</td><td>${x.lastLogin ? stamp(x.lastLogin) : ''}</td></tr>`).join('')}</table></div>${R.mailOn ? '' : '<p class="hint">E-mail sending is not set up yet, so copy each new login\'s link and send it yourself.</p>'}`; } catch (e) { box.textContent = e.message; } }, 0);
  return `<p class="backl"><a href="#" data-act="setupHome">‹ Setup</a></p><h1>${SETUP_NAMES[view.setup]}</h1><div id="sdForm" data-page="${view.setup}">${body}</div>`;
}
function sdErr(msg) { const el = $('#setupErr'); if (el) el.textContent = msg || ''; }
const needMoney = (v, label, blankOk) => { const s = String(v == null ? '' : v).trim(); if (!s) { if (blankOk) return 0; throw new Error('Type ' + label + '.'); } const n = toCents(s); if (!Number.isFinite(n) || n < 0) throw new Error('Check ' + label + '. It must be an amount like 80.00.'); return n; };
function sdCoded(rows, max, what, build) {   // drop empty rows, make a code from the name when it is empty, refuse the same code twice
  const used = new Set(rows.map(r => String(r.code || '').trim().toUpperCase()).filter(Boolean)), seen = new Set(), out = [];
  for (const r of rows) {
    const name = String(r.name || '').trim(); let code = String(r.code || '').trim().toUpperCase(); if (!code && !name && !Object.entries(r).some(([k, v]) => !['code', 'name', 'type', 'tax', 'charge'].includes(k) && String(v || '').trim())) continue;
    if (!code) { if (!name) throw new Error('Give each ' + what + ' a name or a code.'); code = makeCode(name, used, max); used.add(code); }
    if (seen.has(code)) throw new Error('Two ' + what + 's have the same code (' + code + '). Change one.'); seen.add(code); out.push(build(code, name || code, r));
  }
  return out;
}
async function setupSave() {
  const c = {}, v = id => $('#' + id).value;
  await run(async () => { try {
    sdErr(''); sdRead(); const rows = SD && SD.page === view.setup ? SD.rows : [];
    if (view.setup === 'property') { for (const k of ['name', 'gm', 'phone', 'resPhone', 'fax', 'taxId', 'address', 'city', 'state', 'zip', 'checkinTime', 'checkoutTime']) c[k] = v('s_' + k); c.requireShift = $('#s_requireShift').checked; }
    if (view.setup === 'policies') { const h = v('s_cancelHours').trim() === '' ? 24 : Math.round(Number(v('s_cancelHours'))); if (!Number.isFinite(h) || h < 0 || h > 720) throw new Error('Guests can cancel free up to a number of hours from 0 to 720.'); const txt = v('s_cancelText').trim();
      c.regText = v('s_regText'); c.policies = { cancelHours: h, cancelText: txt === defaultCancel(h) ? '' : txt, deposit: needMoney(v('s_deposit'), 'the deposit', true), hold: needMoney(v('s_hold'), 'the card hold', true), pets: v('s_pets'), petFee: needMoney(v('s_petFee'), 'the pet fee', true), smokingFee: needMoney(v('s_smokingFee'), 'the smoking fee', true), other: v('s_other') }; }
    if (view.setup === 'types') { c.types = sdCoded(rows, 8, 'room type', (code, name, r) => ({ code, name, rate: needMoney(r.rate, 'a price per night for ' + name) })); if (!c.types.length) throw new Error('Keep at least one room type.'); }
    if (view.setup === 'rooms') { const seen = new Set(); c.rooms = rows.filter(r => String(r.no).trim()).map(r => { const no = String(r.no).trim(); if (seen.has(no)) throw new Error('Room ' + no + ' is in the list twice.'); seen.add(no); return { no, type: r.type, floor: String(r.floor || '').trim() || no[0], nosmoke: !!r.nosmoke, accessible: !!r.accessible, rentLast: !!r.rentLast, sched: r.sched }; }); }
    if (view.setup === 'taxes') c.taxes = sdCoded(rows, 6, 'tax', (code, name, r) => { const p = parseFloat(String(r.pct).replace(/[^0-9.]/g, '')); if (String(r.pct).trim() && !Number.isFinite(p)) throw new Error('Check the percent for ' + name + '.'); if (p > 50) throw new Error('The percent for ' + name + ' cannot be more than 50.'); return { code, name, pct: p || 0 }; });
    if (view.setup === 'codes') { c.codes = sdCoded(rows, 8, 'posting code', (code, name, r) => ({ code, name, type: r.type || 'MISC', tax: r.tax || [] })); if (!c.codes.some(k => k.code === 'RM')) throw new Error('Keep the RM (Room Charge) code. The night audit needs it.'); }
    if (view.setup === 'rates') c.rateRules = rows.filter(r => Object.values(r).some(x => Array.isArray(x) ? false : String(x).trim() && x !== '*')).map(r => { const nm = String(r.name).trim() || 'Rate'; if (!r.from || !r.to) throw new Error('Pick the From and Through dates for "' + nm + '".'); if (r.to < r.from) throw new Error('"' + nm + '" ends before it starts. Check the dates.'); return { name: nm, from: r.from, to: r.to, days: r.days || [], type: r.type || '*', rate: needMoney(r.rate, 'a rate for "' + nm + '"') }; });
    if (view.setup === 'packages') c.packages = sdCoded(rows, 8, 'package', (code, name, r) => ({ code, name, price: needMoney(r.price, '', true), charge: r.charge || 'MS' }));
    if (view.setup === 'woreasons') { const seen = new Set(); c.woReasons = rows.map(r => ({ name: String(r.name).trim(), active: !!r.active })).filter(r => r.name).map(r => { if (seen.has(r.name.toLowerCase())) throw new Error('"' + r.name + '" is in the list twice.'); seen.add(r.name.toLowerCase()); return r; }); }
    if (view.setup === 'hks') c.housekeepers = rows.map(r => String(r.name).trim()).filter(Boolean);
    if (view.setup === 'rewards') c.rewards = { enabled: $('#s_rw_enabled').checked, name: $('#s_rw_name').value, earn: $('#s_rw_earn').value, perNight: $('#s_rw_perNight').value, perDollar: $('#s_rw_perDollar').value, pointValue: $('#s_rw_pointValue').value, minRedeem: $('#s_rw_minRedeem').value,
      tiers: $('#s_rw_tiers').value.split('\n').filter(l => l.trim()).map(l => { const p = l.split(','); return { name: (p[0] || '').trim(), min: (p[1] || '').trim(), amenity: (p[2] || '').trim(), message: p.slice(3).join(',').trim() }; }) };
    await op('configSave', { config: c }); SD = null; await refresh(); toast('Saved.');
  } catch (e) { if (e.status === 401 || (e.status === 403 && /turned off/.test(e.message))) throw e; sdErr(e.message); } });
}
/* ---------- Setup tables: add / remove a row, and the Add Room windows ---------- */
function sdAdd() { sdRead(); if (!SD || !sdBlank(SD.page)) return; SD.rows.push({ ...sdBlank(SD.page), tax: [], days: [] }); const keep = $('#codeQ'); render(); const f = $('#sdForm'); const last = f && [...f.querySelectorAll('tr[data-i]')].pop(); if (last) { const i = last.querySelector('input:not([type=checkbox])'); if (i) i.focus(); last.scrollIntoView({ block: 'nearest' }); } }
function sdDel(i) {
  sdRead(); const r = SD.rows[i]; if (!r) return;
  if (SD.page === 'types') { const n = S.config.rooms.filter(x => x.type === String(r.code).trim().toUpperCase()).length; if (n) return sdErr('Room type ' + r.code + ' still has ' + n + (n === 1 ? ' room' : ' rooms') + '. Change those rooms to another type (or remove them) in Rooms first.'); }
  if (SD.page === 'codes' && r.code === 'RM') return sdErr('Keep the RM (Room Charge) code. The night audit needs it.');
  SD.rows.splice(i, 1); const f = $('#sdForm'); if (f) f.dataset.page = '';   // the old table must not be read back into the shorter list
  render(); sdErr('');
}
const floorOpts = sel => '<option value="">Same as first digit of the room number</option>' + Array.from({ length: 20 }, (_, i) => `<option value="${i + 1}" ${String(sel) === String(i + 1) ? 'selected' : ''}>${i + 1}</option>`).join('');
const typeOpts = () => S.config.types.map(t => `<option value="${esc(t.code)}">${esc(t.code)} - ${esc(t.name)}</option>`).join('');
const schedOpts = () => (S.config.cleanSchedules || []).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
const rmFlags = () => `<label class="chk"><input type="checkbox" id="rm_nosmoke">No Smoking</label><label class="chk"><input type="checkbox" id="rm_accessible">Accessible</label><label class="chk"><input type="checkbox" id="rm_rentLast">Rent Last</label>`;
function rmAddOpen() { sdRead(); $('#modal').innerHTML = `<div class="mback" id="rmwin"><div class="mbox sm"><div class="mtitle thin">Add Room</div><div class="grid"><label class="c12">Room number<input id="rm_no" maxlength="8"></label><label class="c12">Room type<select id="rm_type">${typeOpts()}</select></label><label class="c12">Floor<select id="rm_floor">${floorOpts('')}</select></label><label class="c12">Cleaning Schedule<select id="rm_sched">${schedOpts()}</select></label><div class="c12 rmflags">${rmFlags()}</div></div><div class="err" id="rm_err"></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="rmAddGo">Add</button></div></div></div>`; $('#rm_no').focus(); }
function rmManyOpen() { sdRead(); $('#modal').innerHTML = `<div class="mback" id="rmwin"><div class="mbox sm"><div class="mtitle thin">Add Many Rooms</div><div class="grid"><label class="c6">From number<input id="rm_from" inputmode="numeric" maxlength="6"></label><label class="c6">To number<input id="rm_to" inputmode="numeric" maxlength="6"></label><label class="c12">Room type<select id="rm_type">${typeOpts()}</select></label><label class="c12">Floor<select id="rm_floor">${floorOpts('')}</select></label><label class="c12">Cleaning Schedule<select id="rm_sched">${schedOpts()}</select></label><div class="c12 rmflags">${rmFlags()}</div></div><p class="hint" id="rm_prev" style="margin:8px 0 0"></p><div class="err" id="rm_err"></div><div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="rmManyGo">Add Rooms</button></div></div></div>`; $('#rm_from').focus(); rmPreview(); }
function rmManyList() {   // the room numbers from..to that are not in the table yet
  const a = $('#rm_from').value.trim(), b = $('#rm_to').value.trim(); if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return { bad: 'Type the first and last room number (digits only).' };
  const from = +a, to = +b; if (to < from) return { bad: 'The last number must not be below the first.' }; if (to - from >= 300) return { bad: 'At most 300 rooms at once.' };
  const have = new Set(SD.rows.map(r => String(r.no))), add = [], skip = []; for (let n = from; n <= to; n++) (have.has(String(n)) ? skip : add).push(String(n)); return { add, skip };
}
function rmPreview() { const p = $('#rm_prev'); if (!p) return; const L = rmManyList(); p.textContent = L.bad ? '' : L.add.length + (L.add.length === 1 ? ' room' : ' rooms') + ' will be added' + (L.skip.length ? '; ' + L.skip.length + ' already exist and will be skipped.' : '.'); }
const rmNew = (no, floor) => ({ no, type: $('#rm_type').value, floor: floor || String(no)[0], nosmoke: $('#rm_nosmoke').checked, accessible: $('#rm_accessible').checked, rentLast: $('#rm_rentLast').checked, sched: $('#rm_sched').value });
function rmAddGo() {
  const no = $('#rm_no').value.trim(), er = m => { $('#rm_err').textContent = m; };
  if (!no) return er('Type the room number.'); if (SD.rows.some(r => String(r.no) === no)) return er('Room ' + no + ' is already in the list.');
  SD.rows.push(rmNew(no, $('#rm_floor').value)); SD.rows.sort(roomSort); $('#modal').innerHTML = ''; render(); toast('Room ' + no + ' added. Click Save to keep it.');
}
function rmManyGo() {
  const L = rmManyList(); if (L.bad) return ($('#rm_err').textContent = L.bad); if (!L.add.length) return ($('#rm_err').textContent = 'All of those rooms already exist.');
  for (const no of L.add) SD.rows.push(rmNew(no, $('#rm_floor').value)); SD.rows.sort(roomSort); $('#modal').innerHTML = ''; render(); toast(L.add.length + ' rooms added. Click Save to keep them.');
}
/* ---------- Import rooms from a list (Setup > Rooms) ---------- */
function rimParse(text) {   // -> { types:[{code,name}], rooms:[{no,type,floor,nosmoke,accessible,rentLast}], problems:[] }
  const out = { types: [], rooms: [], problems: [] }, tl = new Map(), seen = new Set(), known = new Set(S.config.types.map(t => t.code));
  const lines = String(text || '').split(/\r?\n/).map((l, i) => ({ l: l.trim(), n: i + 1 })).filter(x => x.l && x.l[0] !== '#');
  for (const { l, n } of lines) { const m = /^type\s+([A-Za-z0-9]{1,8})\s*[=:]\s*(.*)$/i.exec(l); if (!m) continue; const code = m[1].toUpperCase(), name = m[2].trim().slice(0, 60);
    if (!name) { out.problems.push('Line ' + n + ': type ' + code + ' has no name after the = sign.'); continue; } if (tl.has(code)) out.problems.push('Line ' + n + ': type ' + code + ' is defined twice.'); tl.set(code, name); known.add(code); }
  out.types = [...tl].map(([code, name]) => ({ code, name }));
  for (const { l, n } of lines) {
    if (/^type\s+[A-Za-z0-9]{1,8}\s*[=:]/i.test(l)) continue;
    const t = l.split(/[\s,\-–—]+/).filter(Boolean), no = t[0];
    if (!/^\d{1,6}$/.test(no || '')) { out.problems.push('Line ' + n + ': "' + (no || l).slice(0, 20) + '" is not a room number (digits only).'); continue; }
    const room = String(+no); if (t.length < 2) { out.problems.push('Line ' + n + ': room ' + room + ' has no room type.'); continue; }
    const code = t[1].toUpperCase(); let bad = false, smoking = false, ns = false, acc = false, rl = false;
    if (!known.has(code)) { out.problems.push('Line ' + n + ': room ' + room + ' uses type ' + code + ', which is not a room type here. Add a line like TYPE ' + code + ' = Name.'); bad = true; }
    for (const f of t.slice(2).map(x => x.toLowerCase())) { if (f === 'smoking') smoking = true; else if (f === 'nosmoking' || f === 'ns') ns = true; else if (f === 'accessible' || f === 'ada') acc = true; else if (f === 'rentlast') rl = true; else { out.problems.push('Line ' + n + ': room ' + room + ' has an unknown word "' + f + '".'); bad = true; } }
    if (seen.has(room)) { out.problems.push('Line ' + n + ': room ' + room + ' is in the list twice.'); bad = true; } seen.add(room); if (bad) continue;
    out.rooms.push({ no: room, type: code, floor: String(Math.max(1, Math.floor(+room / 100))), nosmoke: smoking ? false : true, accessible: acc, rentLast: rl });
  }
  return out;
}
function rimPlan() {
  const P = rimParse($('#im_text').value), rm = $('#im_rm').checked, have = new Map(SD.rows.map(r => [String(r.no), r])), oldT = new Map(S.config.types.map(t => [t.code, t]));
  let nw = 0, ch = 0, same = 0; const per = new Map();
  for (const r of P.rooms) { const o = have.get(r.no); if (!o) nw++; else if (o.type === r.type && String(o.floor) === r.floor && !!o.nosmoke === r.nosmoke && !!o.accessible === r.accessible && !!o.rentLast === r.rentLast) same++; else ch++; per.set(r.type, (per.get(r.type) || 0) + 1); }
  const typeNew = P.types.filter(t => !oldT.has(t.code)).length, listed = new Set(P.rooms.map(r => r.no)), removed = rm ? SD.rows.filter(r => !listed.has(String(r.no))).length : 0;
  return { P, rm, nw, ch, same, per, typeNew, removed };
}
function rimOpen() {
  sdRead(); $('#modal').innerHTML = `<div class="mback" id="rmwin"><div class="mbox"><div class="mtitle thin">Import rooms from a list</div>
    <p class="hint" style="margin:0 0 8px">Paste your room list, one per line. Describe a room type with <b>TYPE NK = King</b>. Then list rooms as <b>room number, type code, extras</b>, such as <b>102 NDD</b>, <b>102 - NDD</b>, <b>175 NHK accessible</b> or <b>173 Q smoking</b>. Extras: <b>smoking</b> (rooms are No Smoking unless you say so), <b>accessible</b> (or ada), <b>rentlast</b>. Blank lines and lines starting with # are ignored. New room types start at price 0.00; set prices in Room Types and Rates. The floor is taken from the room number.</p>
    <textarea id="im_text" rows="9" spellcheck="false" style="width:100%;font-family:ui-monospace,Consolas,monospace" placeholder="TYPE NK = King&#10;TYPE Q = Two Queens&#10;102 NK&#10;173 Q smoking"></textarea>
    <label class="chk" style="margin:8px 0"><input type="checkbox" id="im_rm">Remove rooms that are not in this list</label>
    <div id="im_prev" aria-live="polite"></div><div class="err" id="im_err" role="alert"></div>
    <p class="hint" style="margin:6px 0 0"><b>Import saves right away.</b></p>
    <div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" id="im_go" data-act="rmImportGo" disabled>Import</button></div></div></div>`; $('#im_text').focus(); rimPreview();
}
function rimPreview() {
  const box = $('#im_prev'); if (!box) return; const x = rimPlan(), P = x.P, n = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
  const sum = P.types.length || P.rooms.length ? `${n(P.types.length, 'room type')} (${x.typeNew} new), ${n(P.rooms.length, 'room')} (${x.nw} new, ${x.ch} changed, ${x.same} unchanged)${x.rm ? '; ' + n(x.removed, 'room') + ' will be removed' : ''}` : 'Nothing to import yet.';
  const rows = [...x.per].sort((a, b) => a[0].localeCompare(b[0])).map(([c, k]) => { const t = P.types.find(t => t.code === c) || S.config.types.find(t => t.code === c) || {}; return `<tr><td><b>${esc(c)}</b></td><td>${esc(t.name || '')}</td><td class="num">${k}</td></tr>`; }).join('');
  box.innerHTML = `<p style="margin:8px 0;font-weight:600" id="im_sum">${esc(sum)}</p>${rows ? `<div class="wrap"><table class="sdt" id="im_tbl"><tr><th>Type</th><th>Name</th><th>Rooms</th></tr>${rows}</table></div>` : ''}${P.problems.length ? `<ul id="im_probs" style="color:#d70015;margin:8px 0 0;padding-left:20px">${P.problems.slice(0, 12).map(p => `<li>${esc(p)}</li>`).join('')}${P.problems.length > 12 ? `<li>…and ${P.problems.length - 12} more.</li>` : ''}</ul>` : ''}`;
  $('#im_go').disabled = !!P.problems.length || !(P.types.length || P.rooms.length); $('#im_err').textContent = '';
}
function rimGo() {
  const x = rimPlan(), P = x.P; if (P.problems.length || !(P.types.length || P.rooms.length)) return;
  const types = S.config.types.map(t => ({ code: t.code, name: t.name, rate: t.rate })); for (const t of P.types) { const o = types.find(y => y.code === t.code); if (o) o.name = t.name; else types.push({ code: t.code, name: t.name, rate: 0 }); }
  const sched0 = ((S.config.cleanSchedules || [])[0] || {}).id, byNo = new Map(SD.rows.map(r => [String(r.no), r])), listed = new Set(P.rooms.map(r => r.no));
  let rooms = SD.rows.filter(r => x.rm ? listed.has(String(r.no)) : true).map(r => ({ ...r }));
  for (const r of P.rooms) { const o = byNo.get(r.no), cur = o && rooms.find(y => String(y.no) === r.no); if (cur) Object.assign(cur, { type: r.type, floor: r.floor, nosmoke: r.nosmoke, accessible: r.accessible, rentLast: r.rentLast }); else rooms.push({ ...r, sched: sched0 }); }
  rooms.sort(roomSort);
  return run(async () => { try { await op('configSave', { config: { types, rooms } }); } catch (e) { if (e.status === 401 || (e.status === 403 && /turned off/.test(e.message))) throw e; $('#im_err').textContent = e.message; return; }
    SD = null; $('#modal').innerHTML = ''; await refresh(); toast('Imported ' + P.rooms.length + ' rooms.'); });
}
/* ---------- Room Blocking: several rooms at once, and the list of what is out of order now ---------- */
let BK = null;   // what is typed in the window: from room, to room, floor filter, dates, reason
const roomIdx = no => S.config.rooms.findIndex(r => r.no === no);
function blockRooms() {   // every room from "From room" to "To room" in the hotel's room order (only one floor when a floor is picked)
  const i = roomIdx(BK.from), j = roomIdx(BK.to); if (i < 0 || j < 0) return [];
  return S.config.rooms.slice(Math.min(i, j), Math.max(i, j) + 1).filter(r => !BK.floor || r.floor === BK.floor).map(r => r.no);
}
function blockRead() { if (!$('#b_from') || !BK) return; for (const [k, id] of [['from', 'b_from'], ['to', 'b_to'], ['floor', 'b_floor'], ['start', 'b_start'], ['end', 'b_end'], ['reason', 'b_reason']]) BK[k] = $('#' + id).value; }
const blockNote = () => { const l = blockRooms(); return l.length ? l.length + (l.length === 1 ? ' room' : ' rooms') + ': ' + (l.length > 8 ? l.slice(0, 4).join(', ') + ' … ' + l.slice(-2).join(', ') : l.join(', ')) : 'No rooms picked.'; };
function blockNew() { const f = S.config.rooms[0]; BK = { from: f ? f.no : '', to: f ? f.no : '', floor: '', start: B(), end: B(), reason: '' }; blockDraw(); }
function blockSync() { blockRead(); const n = $('#bkNote'); if (n) n.textContent = blockNote(); }
function blockDraw() {
  const rs = S.config.rooms, floors = [...new Set(rs.map(r => r.floor))].sort(), rsel = (id, v) => `<select id="${id}">${rs.map(r => `<option ${r.no === v ? 'selected' : ''}>${esc(r.no)}</option>`).join('')}</select>`;
  const bl = S.blocks.slice().sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || String(a.reason).localeCompare(String(b.reason)) || String(a.room).localeCompare(String(b.room), 'en', { numeric: true }));
  const sets = {}; for (const b of bl) (sets[b.reason + '|' + b.start + '|' + b.end] = sets[b.reason + '|' + b.start + '|' + b.end] || []).push(b);
  const many = Object.values(sets).filter(l => l.length > 1);
  $('#modal').innerHTML = `<div class="mback" id="bkwin"><div class="mbox"><div class="mtitle thin">Room Blocking</div>
  <div class="grid"><label class="c3">From room${rsel('b_from', BK.from)}</label><label class="c3">To room${rsel('b_to', BK.to)}</label>
    <label class="c3">Only floor<select id="b_floor"><option value="">All floors</option>${floors.map(f => `<option value="${esc(f)}" ${BK.floor === f ? 'selected' : ''}>Floor ${esc(f)}</option>`).join('')}</select></label>
    <label class="c3" style="justify-content:flex-end"><button type="button" class="btn sm" data-act="bkFloor">Select all on this floor</button></label>
    <label class="c3">From<input type="date" id="b_start" value="${esc(BK.start)}"></label><label class="c3">Through<input type="date" id="b_end" value="${esc(BK.end)}"></label><label class="c6">Reason<input id="b_reason" maxlength="120" value="${esc(BK.reason)}" placeholder="AC repair, plumbing…"></label></div>
  <p class="hint" id="bkNote" style="margin:8px 0 0">${esc(blockNote())}</p><div class="err" id="b_err"></div>
  <div class="mfoot" style="margin-top:6px"><button class="btn" data-act="closeModal">Close</button><button class="btn red" data-act="blockSave">Take out of order</button></div>
  <div class="sec">Out of order now (${bl.length})</div>
  ${many.length ? `<div class="bkall">${many.map(l => `<a href="#" data-act="blockRemoveAll" data-ids="${l.map(b => b.id).join(',')}">Put ALL back in order: ${esc(l[0].reason || 'no reason')}, ${dshort(l[0].start)} to ${dshort(l[0].end)} (${l.length} rooms)</a>`).join('')}</div>` : ''}
  <div class="wrap" style="max-height:34vh"><table><tr><th>Room</th><th>From</th><th>Through</th><th>Reason</th><th></th></tr>${bl.map(b => `<tr><td><b>${esc(b.room)}</b></td><td>${dshort(b.start)}</td><td>${dshort(b.end)}</td><td>${esc(b.reason)}</td><td class="num"><button class="btn sm" data-act="blockRemove" data-id="${b.id}">Put back in order</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No rooms are out of order.</td></tr>'}</table></div></div></div>`;
}
async function blockSave() {
  blockRead(); const rooms = blockRooms(); try { if (!rooms.length) throw new Error('Pick the rooms first.'); await op('blockAddMany', { rooms, start: BK.start, end: BK.end, reason: BK.reason }); BK.reason = ''; await refresh(); blockDraw(); toast(rooms.length + (rooms.length === 1 ? ' room is' : ' rooms are') + ' out of order.'); } catch (e) { const el = $('#b_err'); if (el) el.textContent = e.message; else toast(e.message, true); }
}
async function blockBack(ids) { blockRead(); await run(async () => { for (const id of ids) await op('blockRemove', { id: +id }); await refresh(); if ($('#bkwin')) blockDraw(); toast(ids.length > 1 ? ids.length + ' rooms put back in order.' : 'Room put back in order.'); }); }

/* ---------- Recurring charges (a reservation's own list, and the same small list inside the group window) ---------- */
let RC = null;   // { src: 'ed' (reservation page) | 'fo' (folio) }
const rcRes = () => RC.src === 'fo' ? FO.res : ED.r;
const rcName = code => (S.config.codes.find(k => k.code === code) || {}).name || code;
const rcSet = (r, list) => { r.recur = list; const s0 = S.res.find(x => x.id === r.id); if (s0) s0.recur = list; };
const rcAddRow = (pre, act) => `<tr class="addrow"><td><select id="${pre}_code" aria-label="Charge">${S.config.codes.filter(k => ['ROOM', 'MISC'].includes(k.type)).map(k => `<option value="${esc(k.code)}">${esc(k.name)}</option>`).join('')}</select></td><td><input id="${pre}_amt" inputmode="decimal" placeholder="0.00" aria-label="Amount"></td><td><input type="date" id="${pre}_from" aria-label="From"></td><td><input type="date" id="${pre}_to" aria-label="To"></td><td><input id="${pre}_note" maxlength="100" placeholder="Comment" aria-label="Comment"></td><td><button type="button" class="btn sm blue" data-act="${act}">Add</button></td></tr>`;
const rcTable = (list, o) => `<div class="wrap rctab"><table><tr><th>Charge</th><th class="num">Amount</th><th>From</th><th>To</th><th>Comment</th><th>${o.del ? 'Remove' : ''}</th></tr>${list.map((x, i) => `<tr><td>${esc(rcName(x.code))} <span class="hint">${esc(x.code)}</span></td><td class="num">${money(x.amount)}</td><td>${dshort(x.from)}</td><td>${dshort(x.to)}</td><td>${esc(x.comment)}</td><td>${o.del ? `<button type="button" class="btn sm" data-act="${o.del}" data-i="${i}">Remove</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">${o.empty}</td></tr>`}${o.add || ''}</table></div>`;
function rcDraw() {
  const r = rcRes(), live = ['reserved', 'inhouse'].includes(r.status), g = r.groupId && S.groups.find(x => x.id === +r.groupId), old = $('#rcwin'); if (old) old.remove();
  $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="rcwin"><div class="mbox wide"><div class="mtitle thin">Recurring Charges</div><p class="hint" style="text-align:center">${esc(gname(r))}. The night audit posts these every night the guest is in house, with the code's taxes. Leave From and To empty for the whole stay.</p>
    ${rcTable(r.recur || [], { del: 'rcDel', empty: 'No recurring charges.', add: live && (r.recur || []).length < 10 ? rcAddRow('rc', 'rcAdd') : '' })}
    ${g && (g.recur || []).length ? `<h3>From the group ${esc(g.name)}</h3>${rcTable(g.recur, { empty: '' })}` : ''}
    <div class="err" id="rc_err"></div><div class="mfoot"><button class="btn" data-act="rcClose">Close</button></div></div></div>`);
}
async function rcAdd() {
  const r = rcRes(); try { const amount = toCents($('#rc_amt').value); if (!(amount > 0)) throw new Error('Type an amount above zero.'); const x = await op('recurAdd', { id: r.id, code: $('#rc_code').value, amount, comment: $('#rc_note').value, from: $('#rc_from').value, to: $('#rc_to').value }); rcSet(r, x.recur); rcDraw(); toast('Recurring charge added.'); } catch (e) { const el = $('#rc_err'); if (el) el.textContent = e.message; }
}
const grRecur = () => { const l = GR.group.recur || []; return rcTable(l, { del: 'grcDel', empty: 'None.', add: l.length < 10 ? rcAddRow('gc', 'grcAdd') : '' }) + '<p class="hint" style="margin:4px 0 0">Add and Remove here change the list; Save keeps it. Empty From / To means the group\'s dates.</p>'; };
function cutoffFields() {   // the group's cut-off: a fixed date, or a rolling number of days before each night
  if ($('#g_cm_roll').checked) { const d = $('#g_cutoffDays').value.trim(); if (d === '') throw new Error('Type how many days before each night the unsold rooms are released.'); return { cutoff: '', cutoffDays: +d }; }
  return { cutoff: $('#g_cutoff').value, cutoffDays: '' };
}

/* ---------- Room assignment optimizer (Tape Chart side panel) ---------- */
let OPT = null;
function optDraw() {
  const p = OPT.plan, n = p.filter(x => x.room).length;
  $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle thin">Optimize Room Assignments</div><p class="hint" style="text-align:center">Reservations arriving ${esc(dlong(OPT.date))} that have no room yet. Ready rooms first, then Clean, then Dirty; of equals, the room used least. Nothing is saved until you click ASSIGN ROOMS.</p>
  ${p.length ? `<div class="wrap"><table><tr><th>Guest</th><th>Type</th><th>Proposed room</th></tr>${p.map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.type)}</td><td>${x.room ? `<b>${esc(x.room)}</b> <span class="hint">${esc(x.reason)}</span>` : `<span class="noroom">${esc(x.reason)}</span>`}</td></tr>`).join('')}</table></div>` : '<div class="empty">Every reservation arriving that day already has a room.</div>'}
  <div class="mfoot"><button class="btn" data-act="closeModal">Cancel</button><button class="btn blue" data-act="optApply" ${n ? '' : 'disabled'}>ASSIGN ROOMS</button></div></div></div>`;
}

/* ---------- Quick links on Home ---------- */
let QL = null;
function qlDraw() {
  const avail = Object.keys(TILES).filter(k => !QL.includes(k)), full = QL.length >= 14, nm = k => esc(tileName(k)) + (TILES[k][3] === 'boss' ? ' <span class="hint">(managers only)</span>' : '');
  $('#modal').innerHTML = `<div class="mback"><div class="mbox"><div class="mtitle thin">Edit Quick Links</div><p class="hint" style="text-align:center">The tiles at the top of Home, in this order. Up to 14. A tile a person's login cannot use is hidden for that person.</p>
  <div class="qlcols"><div><h3>Shown (${QL.length} of 14)</h3><ul class="qllist" id="qlShown">${QL.map((k, i) => `<li><span>${nm(k)}</span><span class="qlb"><button type="button" class="btn sm" data-act="qlUp" data-i="${i}" ${i ? '' : 'disabled'} aria-label="Move up">▲</button><button type="button" class="btn sm" data-act="qlDown" data-i="${i}" ${i < QL.length - 1 ? '' : 'disabled'} aria-label="Move down">▼</button><button type="button" class="btn sm" data-act="qlRemove" data-i="${i}">Remove</button></span></li>`).join('')}</ul></div>
  <div><h3>Available</h3><ul class="qllist" id="qlAvail">${avail.map(k => `<li><span>${nm(k)}</span><span class="qlb"><button type="button" class="btn sm blue" data-act="qlAdd" data-k="${k}" ${full ? 'disabled' : ''}>Add</button></span></li>`).join('') || '<li class="hint">Everything is shown.</li>'}</ul></div></div>
  <div class="err" id="ql_err"></div><div class="mfoot"><button class="btn" data-act="qlReset">Reset to default</button><span class="flex"></span><button class="btn" data-act="closeModal">Cancel</button><button class="btn green" data-act="qlSave">Save</button></div></div></div>`;
}

/* ---------- Guests who stayed before: banner, history window ---------- */
const digitsOf = x => String(x || '').replace(/\D/g, '');
function histQuery() {
  const r = ED.r, v = k => { const el = $('#r_' + k); return el ? el.value : (r[k] || ''); }, last = v('last').trim(), first = v('first').trim(), phone = digitsOf(v('phone')), guestId = v('guestId').trim();
  if (!(last && first) && !guestId && phone.length < 7) return '';
  const q = new URLSearchParams({ last, first, phone: phone.length >= 7 ? phone : '', guestId }); if (r.id) q.set('except', r.id); return q.toString();
}
const histBanner = () => '<div class="infoban" id="histBan" hidden></div>';
function histPaint() {
  const b = $('#histBan'); if (!b || !ED) return; const h = ED.hist;
  if (!h || !h.count || !h.last) { b.hidden = true; b.innerHTML = ''; return; }
  const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  b.hidden = false; b.innerHTML = `<b>Returning guest:</b> ${pl(h.count, 'stay')}, ${pl(h.nights, 'night')}. Last stay ${esc(dshort(h.last.arrive))}${h.last.room ? ', room ' + esc(h.last.room) : ''}. <a href="#" data-act="histOpen">View history</a>${h.lastNote ? `<div class="histnote">“${esc(h.lastNote)}”</div>` : ''}`;
}
async function histLoad() {
  if (!ED) return; const key = histQuery(); if (key === ED.histKey) return histPaint();
  ED.histKey = key; if (!key) { ED.hist = null; return histPaint(); }
  try { const h = await api('/guest?' + key); if (ED && ED.histKey === key) { ED.hist = h; histPaint(); } } catch (e) { if (ED && ED.histKey === key) { ED.hist = null; histPaint(); } }
}
function histOpen() {
  const h = ED && ED.hist; if (!h) return; const old = $('#hist'); if (old) old.remove();
  $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="hist"><div class="mbox wide"><div class="mtitle thin">Guest History</div><div class="wrap"><table><tr><th>Conf. #</th><th>Arrival</th><th>Departure</th><th>Room</th><th>Type</th><th class="num">Rate</th><th>Status</th><th class="num">Balance</th><th>Notes and requests</th></tr>${h.stays.map(x => `<tr><td>${esc(x.conf)}</td><td>${dshort(x.arrive)}</td><td>${dshort(x.depart)}</td><td>${esc(x.room)}</td><td>${esc(x.type)}</td><td class="num">${money(x.rate)}</td><td>${statusBadge(x)}</td><td class="num">${balTxt(x.balance)}</td><td>${esc([x.notes, x.requests].filter(Boolean).join(' / '))}</td></tr>`).join('')}</table></div><p class="hint">${h.stays.length < h.total ? 'The newest 20 of ' + h.total + ' are shown.' : ''}</p><div class="mfoot"><button class="btn" data-act="closeHist">Close</button></div></div></div>`);
}
/* A confirm-style window: resolves true on the blue button, false on Cancel or Escape. */
let askRes = null;
function askBox(title, html, okLabel) { return new Promise(res => { askRes = res; $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="ask"><div class="mbox sm"><div class="mtitle thin">${esc(title)}</div>${html}<div class="mfoot"><button class="btn" data-act="askNo">Cancel</button><button class="btn blue" data-act="askYes">${esc(okLabel)}</button></div></div></div>`); }); }
function askDone(v) { const b = $('#ask'); if (b) b.remove(); const f = askRes; askRes = null; if (f) f(v); }

/* ---------- Import a rooming list into a group ---------- */
let IMP = null;   // { good: [rows that passed the check] }
const parseDay = t => { t = String(t || '').trim(); let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); if (!m) return ''; const [y, mo, d] = t.includes('-') ? [m[1], m[2], m[3]] : [m[3], m[1], m[2]], iso = y + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0'); return isNaN(Date.parse(iso + 'T00:00:00Z')) ? '' : iso; };
function impOpen() {
  IMP = { good: [] }; const old = $('#imp'); if (old) old.remove();
  $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="imp"><div class="mbox wide"><div class="mtitle thin">Import Rooming List</div><p class="hint">One guest per line: <b>Last, First, Room type, Arrival, Departure, Adults, Phone, E-mail</b>. Commas or tabs (paste from a spreadsheet). Only Last is needed. No room type means ${esc(impType())}; no dates means the group's dates. Dates as 2027-05-01 or 5/1/2027.</p>
    <textarea id="imp_txt" rows="7" style="font-family:Consolas,monospace" placeholder="Smith, Ann, NK, 5/1/2027, 5/3/2027, 2, 555-0100, ann@example.com&#10;Jones, Bo"></textarea><div id="imp_out"></div>
    <div class="mfoot"><button class="btn" data-act="impClose">Close</button><button class="btn blue" data-act="impCheck">Check</button></div></div></div>`);
  $('#imp_txt').focus();
}
const impType = () => (S.config.types.find(t => (GR.group.blocks || {})[t.code]) || S.config.types[0]).code;
function impParse() {
  const g = GR.group, rows = [], taken = [];
  $('#imp_txt').value.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return; const c = (raw.includes('\t') ? raw.split('\t') : raw.split(',')).map(x => x.trim());
    if (i === 0 && /^last(\s*name)?$/i.test(c[0])) return;   // a heading line
    const row = { line: i + 1, last: c[0] || '', first: c[1] || '', type: (c[2] || impType()).toUpperCase(), arrive: c[3] ? parseDay(c[3]) : (g.arrive > B() ? g.arrive : B()), depart: c[4] ? parseDay(c[4]) : g.depart, adults: c[5] ? parseInt(c[5], 10) : 1, phone: c[6] || '', email: c[7] || '', error: '' };
    const night = d => { const rooms = S.config.rooms.filter(r => r.type === row.type); return rooms.length - active().filter(r => r.type === row.type && r.arrive <= d && d < r.depart).length - rooms.filter(r => isOOO(r.no, d)).length - groupHold(row.type, d, g.id) - taken.filter(t => t.type === row.type && t.arrive <= d && d < t.depart).length; };
    if (!row.last) row.error = 'The last name is missing.';
    else if (!S.config.types.some(t => t.code === row.type)) row.error = 'Unknown room type ' + row.type + '.';
    else if (!row.arrive || !row.depart) row.error = 'A date was not understood. Use 2027-05-01 or 5/1/2027.';
    else if (!(row.adults >= 1)) row.error = 'Adults must be a number, 1 or more.';
    else if (row.depart <= row.arrive) row.error = 'The departure must be after the arrival.';
    else if (row.arrive < g.arrive || row.depart > g.depart) row.error = 'Outside the group\'s dates (' + dshort(g.arrive) + ' to ' + dshort(g.depart) + ').';
    else if (row.arrive < B()) row.error = 'The arrival is before today\'s business date.';
    else if (dnrMatchC(row)) row.error = 'DO NOT RENT: ' + dnrMatchC(row).reason;
    else { for (let d = row.arrive; d < row.depart && !row.error; d = addDays(d, 1)) if (night(d) < 1) row.error = 'No ' + row.type + ' rooms left on ' + dshort(d) + '.'; }
    if (!row.error) taken.push(row); rows.push(row);
  });
  return rows;
}
function impShow(rows, created) {
  const good = rows.filter(r => !r.error && !r.done).length;
  $('#imp_out').innerHTML = rows.length ? `<div class="wrap" style="max-height:34vh;margin-top:10px"><table><tr><th>Line</th><th>Guest</th><th>Type</th><th>Arrival</th><th>Departure</th><th class="num">Adults</th><th>Status</th></tr>${rows.map(r => `<tr><td>${r.line}</td><td><b>${esc(r.last)}${r.first ? ', ' + esc(r.first) : ''}</b></td><td>${esc(r.type)}</td><td>${dshort(r.arrive)}</td><td>${dshort(r.depart)}</td><td class="num">${r.adults || ''}</td><td>${r.done ? '<span class="badge g">Created</span>' : r.error ? `<span class="noroom">${esc(r.error)}</span>` : '<span class="badge g">OK</span>'}</td></tr>`).join('')}</table></div>
    <p class="hint">${created != null ? created + ' created. ' : ''}${good} ${good === 1 ? 'line is' : 'lines are'} OK${rows.some(r => r.error) ? '; the others will not be created' : ''}.</p>${good ? `<div class="mfoot" style="margin-top:0"><button class="btn green" data-act="impGo">Create ${good} reservation${good === 1 ? '' : 's'}</button></div>` : ''}` : '<p class="hint">Nothing to check. Type or paste at least one line.</p>';
  IMP.rows = rows;
}
async function impGo() {
  const g = GR.group, rows = IMP.rows.filter(r => !r.error && !r.done);
  await run(async () => {
    const x = await op('groupImport', { id: g.id, rows: rows.map(({ error, done, ...r }) => r) }), bad = new Map(x.problems.map(p => [p.line, p.error]));
    for (const r of rows) { if (bad.has(r.line)) r.error = bad.get(r.line); else r.done = true; }
    await refresh(); GR = await api('/group?id=' + g.id);
    if (!x.problems.length) { $('#imp').remove(); grpDraw(); return toast(x.created + ' reservation' + (x.created === 1 ? '' : 's') + ' created.'); }
    impShow(IMP.rows, x.created); toast(x.created + ' created, ' + x.problems.length + ' did not go in.', true);
  });
}

/* ---------- Guest rewards: the row on the guest pages, the member window, the Rewards Members screen ---------- */
const rwOn = () => !!(S && S.rewards && S.rewards.enabled) && S.me.role !== 'hk';
const rwMem = id => (S.members || []).find(m => m.id === +id);
const rwTierOf = r => { const m = r.memberId && rwMem(r.memberId); return m ? m.tier : ''; };
const rwTier = name => ((S.rewards || {}).tiers || []).find(t => t.name === name) || {};
const pts = n => Number(n || 0).toLocaleString('en-US');
const rwText = m => `Member ${esc(m.number)} · ${esc(m.tier)} · ${pts(m.points)} points`;
function rwPostVal() { const v = $('#p_ptsVal'), n = parseInt($('#p_pts').value, 10) || 0; if (v) v.textContent = n > 0 ? 'Worth ' + money(n * S.rewards.pointValue) + ' off the balance (' + pts(n) + ' points x ' + S.rewards.pointValue + ' cent' + (S.rewards.pointValue === 1 ? '' : 's') + ')' : ''; }
function rwPostToggle() { const rw = $('#p_code').value === 'RW', w = $('#p_ptsWrap'); if (!w) return; w.hidden = !rw; $('#p_ptsVal').hidden = !rw; $('#p_amtWrap').hidden = rw; if ($('#p_last4')) $('#p_last4').parentElement.hidden = rw; if (rw) rwPostVal(); }
let ciAmen = false;   // "Welcome amenity given" ticked in the check-in window
function rwCheckInHtml(m) { const t = rwTier(m.tier); return `<div class="rwbox"><p><b>${esc(S.rewards.name)}: ${esc(m.number)} · ${esc(m.tier)}</b> · ${pts(m.points)} points</p>${t.message ? `<p class="rwmsg">${esc(t.message)}</p>` : ''}${t.amenity ? `<label class="chk"><input type="checkbox" id="ci_amen">Welcome amenity given: ${esc(t.amenity)}</label>` : ''}</div>`; }
function rwMatch(g) {   // a member with the same guest ID, the same last + first name, or the same phone (7 or more digits)
  const idn = x => String(x || '').replace(/[^a-z0-9]/gi, '').toLowerCase(), nm = x => String(x || '').trim().toLowerCase(), dg = x => String(x || '').replace(/\D/g, ''), id = idn(g.guestId), ph = dg(g.phone);
  return (S.members || []).find(m => (id && idn(m.guestId) === id) || (nm(g.last) && nm(g.first) && nm(m.last) === nm(g.last) && nm(m.first) === nm(g.first)) || (ph.length >= 7 && dg(m.phone).slice(-10) === ph.slice(-10))) || null;
}
function rwGuest(live) { const v = k => { const el = live && $('#r_' + k); return el ? el.value : (ED.r[k] || ''); }; return { last: v('last'), first: v('first'), phone: v('phone'), email: v('email'), guestId: v('guestId') }; }
function rwRowInner(live) {
  const r = ED.r, locked = ED.mode === 'edit' && !['reserved', 'inhouse'].includes(r.status), m = r.memberId ? rwMem(r.memberId) : null;
  if (m) return `<b>${rwText(m)}</b>${locked ? '' : ' <a href="#" data-act="rwRemove">Remove</a>'}`;
  if (locked) return '<span class="hint">Not a member</span>';
  const f = rwMatch(rwGuest(live)); if (f) return `${rwText(f)} <a href="#" data-act="rwUse" data-id="${f.id}">Use this member</a> <a href="#" data-act="rwPick">Other</a>`;
  return '<a href="#" data-act="rwPick">Select Program / Enroll</a>';
}
const rwRow = () => rwOn() ? `<div class="rwrow"><span class="rwlbl">Rewards Program:</span><span id="rwRow">${rwRowInner(false)}</span></div>` : '';
function rwRowUpdate() { const el = $('#rwRow'); if (el && ED && rwOn()) el.innerHTML = rwRowInner(true); }
async function rwLink(id) {
  readForm(); if (ED.mode === 'edit') await op('memberLink', { res: ED.r.id, member: +id }); await refresh(); const m = rwMem(id);
  ED.r.memberId = +id; ED.r.memberNo = m ? m.number : ''; const w = $('#rwwin'); if (w) w.remove(); drawRes(); toast('Linked to ' + (m ? m.number : 'the member') + '.');
}
async function rwUnlink() { readForm(); if (ED.mode === 'edit') { await op('memberUnlink', { res: ED.r.id }); await refresh(); } delete ED.r.memberId; delete ED.r.memberNo; drawRes(); toast('Removed from rewards.'); }
async function rwSearchDraw(q) {
  q = q.trim().toLowerCase(); const dg = q.replace(/\D/g, ''); let l;
  if ((S.members || []).length >= 2000) l = (await api('/members?q=' + encodeURIComponent(q))).list;
  else l = S.members.filter(m => !q || [m.number, m.last + ' ' + m.first, m.first + ' ' + m.last, m.last + ', ' + m.first].some(x => x.toLowerCase().includes(q)) || (dg.length >= 3 && String(m.phone || '').replace(/\D/g, '').includes(dg)));
  const box = $('#rw_res'); if (box) box.innerHTML = l.slice(0, 8).map(m => `<a href="#" class="gsrow" data-act="rwChoose" data-id="${m.id}"><b>${esc(m.number)} ${esc(m.last)}${m.first ? ', ' + esc(m.first) : ''}</b><span>${esc(m.tier)} · ${pts(m.points)} points${m.phone ? ' · ' + esc(m.phone) : ''}</span></a>`).join('') || '<div class="hint">No member found. Enroll this guest below.</div>';
}
function rwPick() {
  readForm(); const g = rwGuest(false), old = $('#rwwin'); if (old) old.remove(); const nm = (g.last.trim() + (g.first.trim() ? ', ' + g.first.trim() : ''));
  $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="rwwin"><div class="mbox sm"><div class="mtitle thin">${esc(S.rewards.name)}</div><label>Find a member<input id="rw_q" placeholder="Member #, name or phone" autocomplete="off" value="${esc(g.last.trim())}"></label><div id="rw_res" class="rwres"></div>
    <div class="err" id="rw_err"></div><div class="mfoot"><button class="btn" data-act="rwClose">Cancel</button>${g.last.trim() ? `<button class="btn green" data-act="rwEnroll">Enroll ${esc(nm)}</button>` : ''}</div></div></div>`);
  rwSearchDraw(g.last); $('#rw_q').focus();
}
async function rwEnroll() {
  readForm(); const g = rwGuest(false); try { const x = await op('memberSave', { last: g.last, first: g.first, phone: g.phone, email: g.email, guestId: g.guestId }); await rwLink(x.id); } catch (e) { const el = $('#rw_err'); if (el) el.textContent = e.message; else toast(e.message, true); }
}
let MB = null;   // the member window: { member, tierInfo, next }
async function memOpen(id) { MB = id ? await api('/member?id=' + id) : { member: { last: '', first: '', phone: '', email: '', guestId: '', log: [] } }; memDraw(); }
function memDraw() {
  const m = MB.member, n = !m.id, old = $('#memwin'); if (old) old.remove();
  const f = (k, label, cls, x) => `<label class="${cls || ''}">${label}<input id="mem_${k}" value="${esc(m[k] || '')}" ${x || ''}></label>`, sg = v => (v > 0 ? '+' : v < 0 ? '\u2212' : '') + pts(Math.abs(v));
  const sum = n ? '' : `<div class="rwstat"><div><b>${esc(MB.tier)}</b><span>Tier</span></div><div><b>${pts(m.points)}</b><span>Points</span></div><div><b>${pts(m.earned)}</b><span>Lifetime points</span></div><div><b>${pts(m.nights)}</b><span>Nights</span></div><div><b>${pts(m.stays)}</b><span>Stays</span></div><div><b>${money(m.revenue)}</b><span>Room revenue</span></div></div>
    <p class="hint">Joined ${esc(dshort(m.joined))}. ${MB.next ? pts(MB.next.need) + ' more lifetime points to ' + esc(MB.next.name) + '.' : 'Top tier.'}${MB.tierInfo && MB.tierInfo.amenity ? ' Welcome amenity: ' + esc(MB.tierInfo.amenity) + '.' : ''}</p>`;
  $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="memwin"><div class="mbox wide"><div class="mtitle thin">${esc(S.rewards.name)}: ${n ? 'New member' : esc(m.number)}</div>${sum}
    <div class="grid">${f('last', 'Last name *', 'c6', 'maxlength="60"')}${f('first', 'First name', 'c3', 'maxlength="60"')}${f('phone', 'Phone', 'c3', 'maxlength="30"')}${f('email', 'E-mail', 'c6', 'maxlength="100"')}${f('guestId', 'Guest ID', 'c6', 'maxlength="40"')}</div>
    <div class="err" id="mem_err"></div>
    ${n ? '' : `<div class="sec">Points history</div><div class="wrap" style="max-height:26vh"><table id="memLog"><tr><th>Date</th><th>By</th><th>What</th><th class="num">Points</th></tr>${m.log.slice().reverse().map(l => `<tr><td>${dshort(l.bdate)}</td><td>${esc(l.by)}</td><td>${esc(l.what)}</td><td class="num">${l.points ? sg(l.points) : ''}</td></tr>`).join('')}</table></div>
    ${boss() ? `<div class="grid rwadj"><label class="c3">Adjust points (+ or -)<input id="mem_pts" inputmode="numeric" placeholder="500 or -200"></label><label class="c6">Reason *<input id="mem_why" maxlength="200"></label><label class="c3" style="justify-content:flex-end"><button class="btn blue" data-act="memAdjust">Adjust points</button></label></div>` : ''}`}
    <div class="mfoot"><button class="btn" data-act="memClose">Close</button><button class="btn green" data-act="memSave">${n ? 'Enroll member' : 'Save details'}</button></div></div></div>`);
  const first = $('#mem_last'); if (first && n) first.focus();
}
async function memSave() {
  const m = MB.member, v = k => $('#mem_' + k).value;
  try { const x = await op('memberSave', { id: m.id || 0, last: v('last'), first: v('first'), phone: v('phone'), email: v('email'), guestId: v('guestId') }); await refresh(); await memOpen(x.id); toast(m.id ? 'Saved.' : 'Enrolled as ' + x.number + '.'); } catch (e) { const el = $('#mem_err'); if (el) el.textContent = e.message; }
}
async function memAdjust() {
  const m = MB.member; try { await op('memberAdjust', { id: m.id, points: $('#mem_pts').value.trim() === '' ? 0 : Number($('#mem_pts').value), reason: $('#mem_why').value }); await refresh(); await memOpen(m.id); toast('Points adjusted.'); } catch (e) { const el = $('#mem_err'); if (el) el.textContent = e.message; }
}
function vMembers() {
  const q = view.q.trim().toLowerCase(), dg = q.replace(/\D/g, ''), s = view.memSort || { col: 'number', dir: 'asc' };
  const COLS = [['number', 'Member #'], ['name', 'Name'], ['phone', 'Phone'], ['tier', 'Tier'], ['points', 'Points', 1], ['earned', 'Lifetime Points', 1], ['nights', 'Nights', 1], ['stays', 'Stays', 1], ['joined', 'Joined']];
  const all = S.members || [], nameOf = m => m.last + (m.first ? ', ' + m.first : '');
  let list = all.filter(m => !q || [m.number, nameOf(m), m.first + ' ' + m.last].some(x => x.toLowerCase().includes(q)) || (dg.length >= 3 && String(m.phone || '').replace(/\D/g, '').includes(dg)));
  const val = m => s.col === 'name' ? nameOf(m) : s.col === 'tier' ? m.earned : m[s.col] == null ? '' : m[s.col], num = COLS.find(c => c[0] === s.col)[2] || s.col === 'tier';
  list = list.slice().sort((a, b) => { const c = num ? val(a) - val(b) : String(val(a)).localeCompare(String(val(b)), 'en', { numeric: true }); return s.dir === 'desc' ? -c : c; });
  const th = c => `<th class="sortable${c[2] ? ' num' : ''}" data-act="memSort" data-col="${c[0]}">${c[1]} <span class="sarr${s.col === c[0] ? ' on' : ''}">${s.col === c[0] ? (s.dir === 'desc' ? '▼' : '▲') : '⇅'}</span></th>`;
  return `<h1 class="pgt-c">Rewards Members</h1>${all.length ? '' : '<div class="lst-empty">Nobody is enrolled yet.</div>'}<div class="lst-bar"><span>Members: <b>${list.length}</b></span><button class="btn sm green" data-act="memNew">+ Member</button><span class="flex"></span><label class="lst-q">Quick Search: <input id="q" value="${esc(view.q)}"></label></div>
  <div class="wrap"><table class="lst"><tr>${COLS.map(th).join('')}</tr>${list.map(m => `<tr class="click" data-act="memOpen" data-id="${m.id}"><td><b>${esc(m.number)}</b></td><td>${esc(nameOf(m))}</td><td>${esc(m.phone)}</td><td>${esc(m.tier)}</td><td class="num">${pts(m.points)}</td><td class="num">${pts(m.earned)}</td><td class="num">${pts(m.nights)}</td><td class="num">${pts(m.stays)}</td><td>${dshort(m.joined)}</td></tr>`).join('')}</table></div>`;
}

/* ---------- clicks and typing ---------- */
document.addEventListener('click', async e => {
  const mb = e.target.closest('.menu>button'); if (mb) { mb.focus(); return; }
  if (e.target.closest('.drop')) setTimeout(() => { const h = $('header'); if (h) h.classList.add('nohover'); }, 0);
  const nav = e.target.closest('[data-nav]'); if (nav) { if (nav.tagName === 'A') e.preventDefault(); if (view.name !== nav.dataset.nav) { view.listDate = ''; view.listSort = null; } view.name = nav.dataset.nav; view.q = ''; if (view.name === 'setup') { view.setup = ''; SD = null; } if (view.name === 'reports') { view.repStage = 'list'; view.rep = ''; view.repQ = ''; } render(); return; }
  const el = e.target.closest('[data-act]'); if (!el) return; const a = el.dataset.act; if (el.tagName === 'A') e.preventDefault();
  if (a === 'cond') return run(async () => { e.stopPropagation(); await op('roomCond', { rooms: [el.dataset.room], cond: el.dataset.cond }); await refresh(); });
  if (a === 'logout') return run(async () => { await api('/auth/logout', {}); S = null; M = null; showLogin(); });
  if (a === 'forgot') return showLogin('', 'forgot');
  if (a === 'loginBack') return showLogin('', 'signin');
  if (a === 'myPw') return pwBox();
  if (a === 'rcAsk') return rcBox();
  if (a === 'rcLater') { rcLater = true; return S ? render() : masterDraw(); }
  if (a === 'recoverMode') return showLogin('', 'recover');
  if (a === 'rcMake') return run(async () => { const r = await api('/account/recovery', { password: $('#rc_pw').value }); const u = S ? S.me : M.user; u.recovery = true; showRecovery(r.recoveryCode, u.email, false); });
  if (a === 'rcCopy') { try { await navigator.clipboard.writeText(RCODE.code); } catch (x) { const r = document.createRange(); r.selectNodeContents($('#rcCode')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('copy'); } return toast('Code copied.'); }
  if (a === 'rcPrint') return printHtml(`<h1>Hotel Desk recovery code</h1><p>For ${esc(RCODE.email)}</p><p style="font:700 28px Consolas,monospace;letter-spacing:2px;margin:18px 0">${esc(RCODE.code)}</p><p>Keep this somewhere safe. If you forget your password, go to the sign-in page, click "Forgot your password?", then "Use a recovery code". It works once.</p>`);
  if (a === 'rcDone') { if (!$('#rcOk').checked) return; const go = RCODE.signIn; RCODE = null; $('#modal').innerHTML = ''; if (go) return run(refresh); return S ? render() : masterDraw(); }
  if (a === 'copyLink') { const t = $('#linkTxt'); t.select(); try { await navigator.clipboard.writeText(t.value); toast('Link copied.'); } catch (x) { document.execCommand('copy'); toast('Link copied.'); } return; }
  if (a === 'mHotelNew') return mHotelBox();
  if (a === 'mTestHotel') return run(async () => { const n = M.hotels.filter(h => h.test).length; const r = await api('/master/hotelSave', { test: true, name: 'Test Hotel' + (n ? ' ' + (n + 1) : ''), note: 'Practice hotel for testing' }); await api('/master/open', { id: r.id }); M = null; S = null; view = { name: 'home', tapeStart: '', q: '', floor: '', rep: '', from: '', to: '', setup: '' }; await refresh(); toast('Test hotel ready. Click "All hotels" to go back.'); });
  if (a === 'mHotelEdit') return mHotelBox(M.hotels.find(h => h.id === el.dataset.id));
  if (a === 'mHotelSave') { try { const id = el.dataset.id, email = id ? '' : $('#mh_ownerEmail').value.trim(); const r = await api('/master/hotelSave', id ? { id, name: $('#mh_name').value, paidThrough: $('#mh_paid').value, note: $('#mh_note').value } : { name: $('#mh_name').value, ownerName: $('#mh_ownerName').value, ownerEmail: email, template: $('#mh_template').value, tz: $('#mh_tz').value, paidThrough: $('#mh_paid').value, note: $('#mh_note').value }); $('#modal').innerHTML = ''; await masterLoad(); if (r.link) linkBox('Hotel added. Send the owner their link', r, email); else toast('Saved.'); } catch (x) { $('#mh_err').textContent = x.message; } return; }
  if (a === 'mStatus') return run(async () => { const h = M.hotels.find(x => x.id === el.dataset.id), off = el.dataset.to === 'off'; if (off && !confirm('Turn OFF ' + h.name + '?\n\nEveryone there is signed out right now and nobody at that hotel can sign in until you turn it back on. Their data is kept.')) return; await api('/master/status', { id: h.id, status: el.dataset.to }); await masterLoad(); toast(h.name + (off ? ' is OFF.' : ' is ON.'), off); });
  if (a === 'mInvite') return run(async () => { const h = M.hotels.find(x => x.id === el.dataset.id); if (!confirm('Make a new "choose your password" link for ' + h.ownerEmail + '?')) return; linkBox('Owner link for ' + h.name, await api('/master/ownerInvite', { id: h.id }), h.ownerEmail); });
  if (a === 'mOpen') return run(async () => { await api('/master/open', { id: el.dataset.id }); M = null; S = null; view = { name: 'home', tapeStart: '', q: '', floor: '', rep: '', from: '', to: '', setup: '' }; await refresh(); });
  if (a === 'mClose') return run(async () => { await api('/master/close', {}); S = null; $('#modal').innerHTML = ''; await refresh(); });
  if (a === 'mMail') return mMailBox();
  if (a === 'mMailSave' || a === 'mMailTest') { try { await api('/master/mail', { user: $('#mm_user').value, pass: $('#mm_pass').value, fromName: $('#mm_fromName').value, host: $('#mm_host').value, port: $('#mm_port').value }); if (a === 'mMailTest') { $('#mm_err').textContent = 'Sending…'; const r = await api('/master/mailTest', {}); $('#mm_err').textContent = ''; toast('Test e-mail sent to ' + r.to + '.'); } else toast('Saved.'); const keep = a === 'mMailTest'; await masterLoad(); if (keep) mMailBox(); else $('#modal').innerHTML = ''; } catch (x) { $('#mm_err').textContent = x.message; } return; }
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.menu')) document.activeElement.blur();
  if (a === 'findOpen') { view.name = 'find'; view.findQ = ''; view.found = []; render(); const f = $('#find2'); if (f) f.focus(); return; }
  if (a === 'findGo') return doFind($('#find2').value);
  if (a === 'setupGo') { view.name = 'setup'; view.setup = el.dataset.tab; SD = null; return render(); }
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
  if (a === 'grpSave' || a === 'grpStatus') { try { const g = GR.group, v = k => $('#g_' + k).value, blocks = {}, rates = {}; document.querySelectorAll('[data-gb]').forEach(i => blocks[i.dataset.gb] = i.value); document.querySelectorAll('[data-gr]').forEach(i => rates[i.dataset.gr] = i.value.trim() ? toCents(i.value) : ''); if (a === 'grpStatus' && el.dataset.to === 'cancelled' && !confirm('Cancel this group? Its unsold rooms go back on sale. Reservations already made stay as they are.')) return; const r = await op('groupSave', { id: g.id || 0, name: v('name'), contact: v('contact'), phone: v('phone'), email: v('email'), notes: v('notes'), arrive: v('arrive'), depart: v('depart'), ...cutoffFields(), recur: g.recur || [], companyId: +v('companyId') || 0, blocks, rates, ...(a === 'grpStatus' ? { status: el.dataset.to } : {}) }); await refresh(); await grpOpen(r.id); toast('Saved.'); } catch (x) { $('#g_err').textContent = x.message; } return; }
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
  if (a === 'repAll') { const off = !repCats().every(c => (view.repCol || {})[c[0]]); view.repCol = {}; if (off) repCats().forEach(c => view.repCol[c[0]] = true); return render(); }
  if (a === 'printRep') return printHtml($('#repOut').innerHTML);
  if (a === 'nightAudit') return nightAudit();
  if (a === 'setupTab') { view.setup = el.dataset.tab; SD = null; return render(); }
  if (a === 'woSeg') { view.woFilter = el.dataset.v; return render(); }
  if (a === 'setupHome') { view.setup = ''; SD = null; return render(); }
  if (a === 'sdAdd') return sdAdd();
  if (a === 'sdDel') return sdDel(+el.dataset.i);
  if (a === 'rmAdd') return rmAddOpen();
  if (a === 'rmMany') return rmManyOpen();
  if (a === 'rmImport') return rimOpen();
  if (a === 'rmImportGo') return rimGo();
  if (a === 'rmAddGo') return rmAddGo();
  if (a === 'rmManyGo') return rmManyGo();
  if (a === 'setupSave') return setupSave();
  if (a === 'pwSave') return run(async () => { await api('/account/password', { old: $('#pw_old').value, new: $('#pw_new').value }); $('#modal').innerHTML = ''; toast('Password changed.'); });
  if (a === 'userPick') { const u = JSON.parse(el.dataset.u); $('#u_email').value = u.email; $('#u_name').value = u.name; if ([...$('#u_role').options].some(o => o.value === u.role)) $('#u_role').value = u.role; $('#u_disabled').checked = u.disabled; return; }
  if (a === 'userSave') return run(async () => { const email = $('#u_email').value.trim(); const r = await api('/account/userSave', { email, name: $('#u_name').value, role: $('#u_role').value, disabled: $('#u_disabled').checked }); render(); if (r.link) linkBox('Login made. Send them their link', r, email); else toast('Login saved.'); });
  if (a === 'userInvite') return run(async () => { const email = $('#u_email').value.trim(); if (!email) throw new Error('Click a login in the list first.'); linkBox('New password link', await api('/account/userInvite', { email }), email); });
  if (a === 'blockNew') return blockNew();
  if (/^cs(Sel|More|Less|Add|Save|Del)$/.test(a)) return csClick(a, el);
  if (a === 'woNew') return woNew(el.dataset.room);
  if (a === 'woAddGo') return woAddGo();
  if (a === 'woDone') return woDone(+el.dataset.id);
  if (a === 'woDoneGo') return woDoneGo(+el.dataset.id, el.dataset.back === '1');
  if (a === 'blockSave') return blockSave();
  if (a === 'blockRemove') return blockBack([el.dataset.id]);
  if (a === 'blockRemoveAll') return blockBack(el.dataset.ids.split(','));
  if (a === 'bkFloor') { blockRead(); const f = $('#b_floor').value; if (!f) return toast('Pick a floor first.', true); const l = S.config.rooms.filter(r => r.floor === f); BK.floor = f; BK.from = l[0].no; BK.to = l[l.length - 1].no; return blockDraw(); }
  if (a === 'recurring') { RC = { src: el.dataset.src === 'fo' ? 'fo' : 'ed' }; return rcDraw(); }
  if (a === 'rcAdd') return rcAdd();
  if (a === 'rcDel') return run(async () => { const r = rcRes(), x = await op('recurRemove', { id: r.id, index: +el.dataset.i }); rcSet(r, x.recur); rcDraw(); });
  if (a === 'rcClose') { const w = $('#rcwin'); if (w) w.remove(); return; }
  if (a === 'grcAdd') { const g = GR.group, amount = toCents($('#gc_amt').value); if (!(amount > 0)) { $('#g_err').textContent = 'Type an amount above zero.'; return; } g.recur = (g.recur || []).concat([{ code: $('#gc_code').value, amount, comment: $('#gc_note').value.trim(), from: $('#gc_from').value || $('#g_arrive').value || g.arrive, to: $('#gc_to').value || $('#g_depart').value || g.depart }]); $('#grRecur').innerHTML = grRecur(); $('#g_err').textContent = ''; return; }
  if (a === 'grcDel') { GR.group.recur.splice(+el.dataset.i, 1); $('#grRecur').innerHTML = grRecur(); return; }
  if (a === 'optRun') return run(async () => { const date = $('#optDate').value || B(); view.optDate = date; const x = await op('optimize', { date }); OPT = { date, plan: x.plan }; optDraw(); });
  if (a === 'optApply') return run(async () => { const x = await op('optimize', { date: OPT.date, apply: true }); $('#modal').innerHTML = ''; OPT = null; await refresh(); toast(x.assigned + (x.assigned === 1 ? ' room' : ' rooms') + ' assigned.'); });
  if (a === 'qlEdit') { QL = qlSaved().slice(); return qlDraw(); }
  if (a === 'qlUp' || a === 'qlDown') { const i = +el.dataset.i, j = a === 'qlUp' ? i - 1 : i + 1; if (j >= 0 && j < QL.length) [QL[i], QL[j]] = [QL[j], QL[i]]; return qlDraw(); }
  if (a === 'qlRemove') { QL.splice(+el.dataset.i, 1); return qlDraw(); }
  if (a === 'qlAdd') { if (QL.length < 14 && TILES[el.dataset.k]) QL.push(el.dataset.k); return qlDraw(); }
  if (a === 'qlSave') { if (!QL.length) { $('#ql_err').textContent = 'Keep at least one link, or use Reset to default.'; return; } return run(async () => { await op('configSave', { config: { quickLinks: QL } }); $('#modal').innerHTML = ''; QL = null; await refresh(); toast('Quick links saved.'); }); }
  if (a === 'qlReset') return run(async () => { await op('configSave', { config: { quickLinks: [] } }); $('#modal').innerHTML = ''; QL = null; await refresh(); toast('Quick links are back to the default.'); });
  if (a === 'histOpen') return histOpen();
  if (a === 'rwMember') return run(async () => { readForm(); if (ED.r.memberId) return memOpen(ED.r.memberId); rwPick(); });
  if (a === 'rwPick') return rwPick();
  if (a === 'rwClose') { const w = $('#rwwin'); if (w) w.remove(); return; }
  if (a === 'rwUse' || a === 'rwChoose') return run(() => rwLink(el.dataset.id));
  if (a === 'rwEnroll') return rwEnroll();
  if (a === 'rwRemove') return run(rwUnlink);
  if (a === 'memNew') return run(() => memOpen(0));
  if (a === 'memOpen') return run(() => memOpen(el.dataset.id));
  if (a === 'memClose') { const w = $('#memwin'); if (w) w.remove(); return; }
  if (a === 'memSave') return memSave();
  if (a === 'memAdjust') return memAdjust();
  if (a === 'memSort') { const c = el.dataset.col, s = view.memSort || { col: 'number', dir: 'asc' }; view.memSort = s.col === c && s.dir === 'asc' ? { col: c, dir: 'desc' } : { col: c, dir: 'asc' }; return render(); }
  if (a === 'askYes') { ciAmen = !!($('#ci_amen') && $('#ci_amen').checked); return askDone(true); }
  if (a === 'askNo') return askDone(false);
  if (a === 'impOpen') return impOpen();
  if (a === 'impClose') { const w = $('#imp'); if (w) w.remove(); return; }
  if (a === 'impCheck') return impShow(impParse());
  if (a === 'impGo') return impGo();
});
document.addEventListener('change', e => {
  if (e.target.id === 'im_rm') return rimPreview();
  const t = e.target; if (t.id === 'rm_floor') t.dataset.t = '1';
  if (t.dataset.hk) return run(async () => { await op('hkSet', { room: t.dataset.room, [t.dataset.hk]: t.type === 'checkbox' ? t.checked : t.value }); S.roomstate[t.dataset.room] = { ...(S.roomstate[t.dataset.room] || {}), [t.dataset.hk]: t.type === 'checkbox' ? t.checked : t.value }; });
  if (t.id === 'woFilter') { view.woFilter = t.value; return render(); }
  if (t.id === 'tapeDate' && t.value) { view.tapeStart = t.value; return render(); }
  if (t.id === 'tapeFloor' || t.id === 'hkFloor') { view.floor = t.value; return render(); }
  if (t.id === 'hkDirty') { view.hkDirty = t.checked; return render(); }
  if (t.id === 'optDate') { view.optDate = t.value; return; }
  if (t.id === 'p_code') return rwPostToggle();
  if (/^b_(from|to|floor)$/.test(t.id)) return blockSync();
  if (t.closest && t.closest('.rform')) { readOpts(); if (t.id === 'repFrom') fillShiftUsers(); return; }
  resFieldChanged(t.id);
});
document.addEventListener('input', e => { if (e.target.id === 'im_text') return rimPreview(); if (e.target.id === 's_cancelHours') { const ta = $('#s_cancelText'), h = e.target.value.trim(); if (ta && /^\d+$/.test(h) && ta.value.trim() === ta.dataset.def) { ta.value = defaultCancel(h); ta.dataset.def = ta.value; } } if (e.target.id === 'codeQ') { const q = e.target.value.toLowerCase(); document.querySelectorAll('#sdForm tr[data-i]').forEach(tr => { const t = [...tr.querySelectorAll('[data-f=code],[data-f=name]')].map(x => x.value).join(' ').toLowerCase(); tr.hidden = !!q && !t.includes(q); }); } if (e.target.id === 'rm_no' && $('#rm_floor') && !$('#rm_floor').dataset.t) { const d = e.target.value.trim()[0]; $('#rm_floor').value = d && +d >= 1 ? d : ''; } if (e.target.id === 'rm_from' || e.target.id === 'rm_to') rmPreview(); if (e.target.id === 'rw_q') rwSearchDraw(e.target.value); if (e.target.id === 'p_pts') rwPostVal(); if (ED && ['r_last', 'r_first', 'r_guestId', 'r_phone'].includes(e.target.id)) rwRowUpdate(); if (e.target.id === 'g_cutoff' && $('#g_cm_fixed')) $('#g_cm_fixed').checked = true; if (e.target.id === 'g_cutoffDays' && $('#g_cm_roll')) $('#g_cm_roll').checked = true; if (e.target.id === 'imp_txt' && $('#imp_out')) $('#imp_out').innerHTML = ''; if (e.target.id === 'scanTxt' && !scanState.manual) { clearTimeout(scanState.t); scanState.t = setTimeout(scanRead, 400); } if (['r_last', 'r_first', 'r_guestId'].includes(e.target.id)) dnrBanUpdate(); if (e.target.closest && e.target.closest('.rform')) readOpts(); if (e.target.id === 'q') { view.q = e.target.value; render(); } if (e.target.id === 'repSearch') { view.repQ = e.target.value; repFilter(); } });
document.addEventListener('focusout', e => { if (ED && ['r_last', 'r_first', 'r_phone', 'r_guestId'].includes(e.target.id)) histLoad(); if (e.target.id === 'scanTxt' && !scanState.manual) setTimeout(() => { const t = $('#scanTxt'); if (t && !scanState.manual) t.focus(); }, 0); });   // the scanner types into this box, so keep it focused
document.addEventListener('mousemove', () => { const h = $('header'); if (h && h.classList.contains('nohover')) h.classList.remove('nohover'); });
const doFind = q => run(async () => { view.findQ = String(q || '').trim(); view.found = view.findQ ? (await api('/find?q=' + encodeURIComponent(view.findQ))).list : []; view.name = 'find'; render(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.id === 'find' || e.target.id === 'find2')) return doFind(e.target.value);
  if (e.key === 'Enter' && e.target.id === 'gs_q') return run(guestFind);
  if (e.key === 'Enter' && e.target.id === 'listDate' && e.target.value) { view.listDate = e.target.value; return render(); }
  if (e.key === 'Enter' && e.target.id === 'roomJump') { const no = e.target.value.trim(); if (!no) return; const g = S.res.find(r => r.status === 'inhouse' && String(r.room).toLowerCase() === no.toLowerCase()); if (!g) return toast('Nobody is checked in to room ' + no, true); e.target.value = ''; return run(() => openRes(g.id)); }
  if (e.key === 'Escape' && $('#modal').innerHTML && !$('#linkTxt')) { if ($('#ask')) askDone(false); else if ($('#memwin')) $('#memwin').remove(); else if ($('#rwwin')) $('#rwwin').remove(); else if ($('#scan')) scanClose(); else if ($('#rcwin')) $('#rcwin').remove(); else if ($('#hist')) $('#hist').remove(); else if ($('#imp')) $('#imp').remove(); else { $('#modal').innerHTML = ''; ED = null; FO = null; } }
});
// Keep every front-desk screen current: other computers' changes show up within 20 seconds.
setInterval(() => { if (S && !M && !$('#modal').innerHTML && document.visibilityState === 'visible' && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) refresh().catch(e => { if (e.status === 401 || e.status === 403) { S = null; showLogin(e.status === 403 ? e.message : ''); } }); }, 20000);
refresh().catch(e => showLogin(e.status === 403 ? e.message : ''));
