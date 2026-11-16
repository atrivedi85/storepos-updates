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
async function run(fn) { try { return await fn(); } catch (e) { if (e.status === 401) { S = null; return showLogin(); } toast(e.message, true); } }
async function refresh() { S = await api('/state'); if (!view.tapeStart) view.tapeStart = S.config.bdate; render(); }

/* ---------- helpers on the data ---------- */
const B = () => S.config.bdate;
const active = () => S.res.filter(r => r.status === 'reserved' || r.status === 'inhouse');
const cond = no => (S.roomstate[no] || {}).cond || 'R';
const isOOO = (no, d) => S.blocks.some(b => b.room === no && b.start <= d && d <= b.end);
const inRoom = no => S.res.find(r => r.status === 'inhouse' && r.room === no);
function roomFree(no, from, to, exceptId) {
  if (S.blocks.some(b => b.room === no && b.start < to && from <= b.end)) return false;
  return !active().some(r => r.id !== exceptId && r.room === no && r.arrive < to && from < r.depart);
}
function availOfType(type, from, to, exceptId) {
  const rooms = S.config.rooms.filter(r => r.type === type).map(r => r.no); let min = rooms.length;
  for (let d = from; d < to; d = addDays(d, 1)) { const sold = active().filter(r => r.id !== exceptId && r.type === type && r.arrive <= d && d < r.depart).length; min = Math.min(min, rooms.length - sold - rooms.filter(no => isOOO(no, d)).length); }
  return min;
}
const statusBadge = r => ({ reserved: '<span class="badge b">Reserved</span>', inhouse: r.depart <= B() ? '<span class="badge a">Due out</span>' : '<span class="badge g">In House</span>', out: '<span class="badge s">Checked out</span>', cancelled: '<span class="badge r">Cancelled</span>', noshow: '<span class="badge r">No show</span>' }[r.status] || '');
const condBtns = no => `<span class="cond">${['R', 'C', 'D'].map(k => `<button class="${k} ${cond(no) === k ? 'on' : ''}" data-act="cond" data-room="${esc(no)}" data-cond="${k}" title="${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[k]}">${k}</button>`).join('')}</span>`;

/* ---------- sign in and first setup ---------- */
async function showLogin() {
  let need = { needed: false }; try { need = await api('/setup-needed'); } catch (e) { /* show sign in */ }
  const setup = need.needed;
  $('#modal').innerHTML = '';
  $('#app').innerHTML = `<form class="login" id="lf"><h1>Hotel Desk</h1>
    ${setup ? (need.owner ? '<p class="hint">Welcome. Create the first manager login for your hotel.</p><label>Hotel name<input id="lh" maxlength="80" required></label><label>Your name<input id="ln" maxlength="80"></label>'
      : '<p class="hint">The hotel is not set up yet. The website owner sets it up: sign in to <a href="/books/">Ledger Desk</a> as the owner, then come back to this page.</p>') : '<p class="hint">Sign in to the front desk.</p>'}
    <label>User name<input id="lu" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="32" required></label>
    <label>Password${setup ? ' (at least 8 characters)' : ''}<input id="lp" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required></label>
    <div class="err" id="le"></div><button class="btn blue" type="submit">${setup ? 'Set up the hotel' : 'Sign in'}</button></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); $('#le').textContent = '';
    try {
      if (setup) await api('/setup', { username: $('#lu').value, password: $('#lp').value, name: $('#ln') ? $('#ln').value : '', hotel: $('#lh') ? $('#lh').value : '', today: localToday() });
      else await api('/login', { username: $('#lu').value, password: $('#lp').value });
      await refresh();
    } catch (x) { $('#le').textContent = x.message; }
  };
}

/* ---------- the frame ---------- */
const NAV = [['home', 'Home'], ['tape', 'Tape Chart'], ['arrivals', 'Arrivals'], ['inhouse', 'In House'], ['departures', 'Departures'], ['hk', 'Housekeeping'], ['reports', 'Reports'], ['setup', 'Setup']];
function render() {
  if (!S || drawing) return;
  const hk = S.me.role === 'hk'; if (hk) view.name = 'hk';
  const nav = NAV.filter(n => hk ? n[0] === 'hk' : n[0] !== 'setup' || S.me.role === 'manager');
  const keep = $('main') ? $('main').scrollTop : 0, keepX = $('main') ? $('main').scrollLeft : 0, focusId = document.activeElement && document.activeElement.id;
  drawing = true; try { paint(hk, nav); } finally { drawing = false; }
  $('main').scrollTop = keep; $('main').scrollLeft = keepX;
  if (focusId && $('#' + focusId)) { const el = $('#' + focusId); el.focus(); if (el.setSelectionRange && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length); }
  if (view.name === 'reports' && view.rep) drawReport();
}
function paint(hk, nav) {
  $('#app').innerHTML = `<header><div class="brand"><img src="icon.png" alt="">${esc(S.config.name)}</div>
    <nav>${nav.map(n => `<button data-nav="${n[0]}" class="${view.name === n[0] ? 'on' : ''}">${n[1]}</button>`).join('')}</nav>
    ${hk ? '' : '<input class="find" id="find" placeholder="Find guest or conf. #"><button class="btn sm green" data-act="newRes">+ Reservation</button><button class="btn sm teal" data-act="walkIn">Walk-In</button>'}
    <div class="who"><b>${esc(dshort(B()))}</b>${esc(S.me.name)} · <a href="#" data-act="logout" style="color:#8fb4ff">Sign out</a></div></header>
    <main>${({ home: vHome, tape: vTape, arrivals: vArrivals, inhouse: vInHouse, departures: vDepartures, hk: vHk, reports: vReports, setup: vSetup, find: vFind }[view.name] || vHome)()}</main>`;
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
  const est = Math.round((r.rate == null ? t.rate : r.rate) * n * (1 + taxPct / 100));
  const f = (k, label, cls, extra) => `<label class="${cls || ''}">${label}<input id="r_${k}" value="${esc(r[k] == null ? '' : r[k])}" ${locked ? 'disabled' : ''} ${extra || ''}></label>`;
  const bal = S.bal[r.id] || 0;
  const A = (act, label, cls) => `<button class="btn sm ${cls || ''}" data-act="${act}">${label}</button>`;
  const acts = isNew ? '' : `<div class="acts" style="margin-bottom:6px">${A('folio', 'Guest Folio', 'blue')}${r.status === 'reserved' ? A('checkIn', 'Check In', 'green') + A('cancelRes', 'Cancel Reservation', 'red') + (r.arrive <= B() ? A('noShow', 'No Show') : '') : ''}${r.status === 'inhouse' ? A('checkOut', 'Check Out', 'amber') + A('undoCheckIn', 'Undo Check In') : ''}${r.status === 'out' ? A('undoCheckOut', 'Undo Check Out') : ''}${['cancelled', 'noshow'].includes(r.status) ? A('reinstate', 'Reinstate', 'green') : ''}${A('printReg', 'Print Registration Card')}${A('printConf', 'Print Confirmation')}${A('viewChanges', 'View Changes')}</div>`;
  return `<div class="mback"><div class="mbox wide"><div class="mtitle">${isNew ? (mode === 'walkin' ? 'Walk-In' : 'New Reservation') : esc(gname(r))} ${isNew ? '' : statusBadge(r) + `<span class="hint">Conf. # ${esc(r.conf)} · Balance ${money(bal)}</span>`}</div>
  ${acts}
  <div class="sec">Stay</div><div class="grid">
    <label class="c3">Arrival<input type="date" id="r_arrive" value="${r.arrive}" ${locked || mode === 'walkin' || r.status === 'inhouse' ? 'disabled' : ''}></label>
    <label class="c2">Nights<input type="number" id="r_nights" min="1" max="365" value="${n}" ${locked ? 'disabled' : ''}></label>
    <label class="c3">Departure<input type="date" id="r_depart" value="${r.depart}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Adults<input type="number" id="r_adults" min="1" value="${r.adults || 1}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Children<input type="number" id="r_children" min="0" value="${r.children || 0}" ${locked ? 'disabled' : ''}></label>
    <label>Room type<select id="r_type" ${locked ? 'disabled' : ''}>${types.map(x => `<option value="${esc(x.code)}" ${x.code === r.type ? 'selected' : ''}>${esc(x.code)} · ${esc(x.name)} · ${availOfType(x.code, from, r.depart, r.id)} left · ${money(x.rate)}</option>`).join('')}</select></label>
    <label>Room<select id="r_room" ${locked ? 'disabled' : ''}><option value="">${mode === 'walkin' ? 'Pick a room' : 'Not assigned yet'}</option>${freeRooms.filter(x => x.type === r.type || x.no === r.room).map(x => `<option value="${esc(x.no)}" ${x.no === r.room ? 'selected' : ''}>${esc(x.no)} · ${esc(x.type)} · ${{ R: 'Ready', C: 'Clean', D: 'Dirty' }[cond(x.no)]}${inRoom(x.no) && inRoom(x.no).id !== r.id ? ' · occupied' : ''}</option>`).join('')}</select></label>
    <label class="c2">Rate / night<input id="r_rate" inputmode="decimal" value="${((r.rate == null ? t.rate : r.rate) / 100).toFixed(2)}" ${locked ? 'disabled' : ''}></label>
    <label class="c2">Estimated total<input value="${money(est)}" disabled></label></div>
  <div class="sec">Guest</div><div class="grid">${f('last', 'Last name *', '', 'maxlength="60"')}${f('first', 'First name', '', 'maxlength="60"')}${f('phone', 'Phone', '', 'maxlength="30" inputmode="tel"')}${f('email', 'E-mail', 'c6', 'maxlength="100"')}${f('company', 'Company', 'c6', 'maxlength="80"')}
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
  for (const k of ['last', 'first', 'phone', 'email', 'company', 'addr1', 'city', 'state', 'zip', 'guestId', 'vehicle', 'guarantee', 'payType', 'cardType', 'cardLast4', 'source', 'requests', 'notes', 'arrive', 'depart', 'type', 'room']) r[k] = v(k);
  r.adults = +v('adults') || 1; r.children = +v('children') || 0; const c = toCents(v('rate')); r.rate = isNaN(c) ? null : c;
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
  if (id === 'r_type') { r.room = ''; r.rate = (S.config.types.find(t => t.code === r.type) || {}).rate; }
  if (['r_nights', 'r_arrive', 'r_depart', 'r_type', 'r_taxExempt', 'r_rate', 'r_room'].includes(id)) { if (r.room && !(r.arrive < r.depart && (roomFree(r.room, r.status === 'inhouse' && B() > r.arrive ? B() : r.arrive, r.depart, r.id)))) r.room = ''; drawRes(); }
}
async function saveRes() {
  readForm(); const r = ED.r, a = { ...r }; delete a.status; delete a.history;
  const go = async dirtyOk => { if (ED.mode === 'walkin') return op('walkIn', { ...a, dirtyOk }); return op('resSave', a); };
  try {
    let res; try { res = await go(false); } catch (e) { if (e.status === 412 && confirm(e.message)) res = await go(true); else throw e; }
    $('#modal').innerHTML = ''; ED = null; await refresh(); toast(r.id ? 'Saved.' : (res.conf ? 'Booked. Confirmation # ' + res.conf : 'Saved.'));
  } catch (e) { $('#r_err').textContent = e.message; }
}
async function resAction(act) {
  const r = ED.r, done = async msg => { await refresh(); toast(msg); const fresh = S.res.find(x => x.id === r.id); if (fresh) { ED.r = JSON.parse(JSON.stringify(fresh)); drawRes(); } else { $('#modal').innerHTML = ''; ED = null; } };
  try {
    if (act === 'checkIn') { readForm(); if (!r.room) throw new Error('Pick a room first.'); await op('resSave', (({ status, history, ...a }) => a)(r)); try { await op('checkIn', { id: r.id }); } catch (e) { if (e.status === 412 && confirm(e.message)) await op('checkIn', { id: r.id, dirtyOk: true }); else throw e; } await done('Checked in to room ' + r.room + '.'); }
    else if (act === 'checkOut') { try { await op('checkOut', { id: r.id }); } catch (e) { if (e.status === 412 && S.me.role === 'manager' && confirm(e.message + '\n\nCheck out anyway and leave the balance on the folio?')) await op('checkOut', { id: r.id, force: true }); else if (e.status === 412) { toast(e.message, true); return openFolio(r.id); } else throw e; } await done('Checked out.'); }
    else if (act === 'undoCheckIn') { if (confirm('Undo the check-in for ' + gname(r) + '?')) { await op('undoCheckIn', { id: r.id }); await done('Check-in undone.'); } }
    else if (act === 'undoCheckOut') { await op('undoCheckOut', { id: r.id }); await done('Guest is back in house.'); }
    else if (act === 'cancelRes') { const why = prompt('Cancel the reservation for ' + gname(r) + '?\nReason (optional):', ''); if (why !== null) { const x = await op('cancel', { id: r.id, reason: why }); await done('Cancelled. Cancellation # ' + x.cxlNo); } }
    else if (act === 'noShow') { if (confirm('Mark ' + gname(r) + ' as a no show?')) { await op('noShow', { id: r.id }); await done('Marked as a no show.'); } }
    else if (act === 'reinstate') { await op('reinstate', { id: r.id }); await done('Reinstated.'); }
    else if (act === 'folio') openFolio(r.id);
    else if (act === 'viewChanges') { const x = await op('history', { id: r.id }); $('#modal').insertAdjacentHTML('beforeend', `<div class="mback" id="hist"><div class="mbox"><div class="mtitle">Changes: ${esc(gname(r))}</div><div class="wrap"><table><tr><th>When</th><th>Who</th><th>What</th></tr>${x.history.map(h => `<tr><td>${stamp(h.at)}</td><td>${esc(h.by)}</td><td>${esc(h.what)}</td></tr>`).join('')}</table></div><div class="mfoot"><button class="btn" data-act="closeHist">Close</button></div></div></div>`); }
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
    <div class="acts" style="margin-bottom:10px"><button class="btn sm blue" data-act="postOpen" data-kind="charge">Post Charge</button><button class="btn sm green" data-act="postOpen" data-kind="payment">Post Payment</button><button class="btn sm" data-act="postOpen" data-kind="adjust">Post Adjustment</button><button class="btn sm" data-act="printFolio">Print</button>${r.status === 'inhouse' ? '<button class="btn sm amber" data-act="folioCheckOut">Check Out</button>' : ''}</div>
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
  ['stats', 'Hotel Statistics', 1], ['closeout', 'Final Transaction Closeout', 1], ['shift', 'Shift Reconciliation', 1], ['journal', 'Hotel Journal Detail', 1], ['history', 'No Show, Cancellation and Departed List', 1]];
function vReports() {
  if (!view.from) view.from = view.to = B();
  const needDates = (REPORTS.find(r => r[0] === view.rep) || [])[2];
  return `<h1>Reports</h1><div class="bar">${S.me.role === 'manager' ? '<button class="btn red" data-act="nightAudit">Run Night Audit…</button>' : ''}<span class="hint">Business date ${dlong(B())}</span></div>
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

/* ---------- Setup (managers) ---------- */
const SETUP = [['property', 'Property'], ['types', 'Room types and rates'], ['rooms', 'Rooms'], ['taxes', 'Taxes'], ['codes', 'Posting codes'], ['hks', 'Housekeepers'], ['users', 'Logins'], ['ooo', 'Out of order rooms']];
function vSetup() {
  const c = S.config; let body = '';
  const save = '<div class="mfoot" style="justify-content:flex-start"><button class="btn green" data-act="setupSave">Save</button></div>';
  if (view.setup === 'property') body = `<div class="grid card"><label class="c6">Hotel name<input id="s_name" value="${esc(c.name)}" maxlength="80"></label><label class="c6">Phone<input id="s_phone" value="${esc(c.phone)}" maxlength="40"></label><label class="c12">Address<input id="s_address" value="${esc(c.address)}" maxlength="200"></label><label class="c3">Check-in time<input id="s_checkinTime" value="${esc(c.checkinTime)}"></label><label class="c3">Check-out time<input id="s_checkoutTime" value="${esc(c.checkoutTime)}"></label><label class="c12">Words on the registration card<textarea id="s_regText" rows="3" maxlength="1500">${esc(c.regText)}</textarea></label></div>${save}
    <h2>My password</h2><div class="grid card"><label>Current password<input type="password" id="pw_old" autocomplete="current-password"></label><label>New password (8 or more)<input type="password" id="pw_new" autocomplete="new-password"></label><label style="justify-content:flex-end"><button class="btn" data-act="pwSave">Change password</button></label></div>`;
  else if (view.setup === 'types') body = `<p class="hint">One line per room type: code, name, nightly rate. Example: NK, King, 80.00</p><textarea id="s_types" rows="12" class="card" style="font-family:Consolas,monospace">${esc(c.types.map(t => `${t.code}, ${t.name}, ${(t.rate / 100).toFixed(2)}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'rooms') body = `<p class="hint">One line per room: room number, room type code, floor. Example: 101, NK, 1 &nbsp;(${c.rooms.length} rooms now)</p><textarea id="s_rooms" rows="18" class="card" style="font-family:Consolas,monospace">${esc(c.rooms.map(r => `${r.no}, ${r.type}, ${r.floor}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'taxes') body = `<p class="hint">One line per tax: code, name, percent. Example: T1, State Tax, 6.24</p><textarea id="s_taxes" rows="6" class="card" style="font-family:Consolas,monospace">${esc(c.taxes.map(t => `${t.code}, ${t.name}, ${t.pct}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'codes') body = `<p class="hint">One line per code: code, name, type, taxes that apply (separated by spaces). Types: ROOM and MISC are charges; CASH, CRED, AREC and GFTCRD are payments; ADMIN is for write-offs. Keep RM (the night audit posts it).</p><textarea id="s_codes" rows="20" class="card" style="font-family:Consolas,monospace">${esc(c.codes.map(k => `${k.code}, ${k.name}, ${k.type}, ${(k.tax || []).join(' ')}`).join('\n'))}</textarea>${save}`;
  else if (view.setup === 'hks') body = `<p class="hint">One housekeeper's name per line.</p><textarea id="s_hks" rows="8" class="card">${esc(c.housekeepers.join('\n'))}</textarea>${save}`;
  else if (view.setup === 'users') body = `<div id="usersBox" class="hint">Loading…</div><h2>Add or change a login</h2><div class="grid card"><label class="c3">User name<input id="u_username" autocapitalize="off" maxlength="32"></label><label class="c3">Name<input id="u_name" maxlength="80"></label><label class="c3">Role<select id="u_role"><option value="desk">Front desk</option><option value="manager">Manager</option><option value="hk">Housekeeping only</option></select></label><label class="c3">Password (blank = keep)<input id="u_password" type="password" autocomplete="new-password"></label><label class="chk c3"><input type="checkbox" id="u_disabled">Turned off</label><label class="c3"><button class="btn green" data-act="userSave">Save login</button></label></div>`;
  else if (view.setup === 'ooo') body = `<div class="bar"><button class="btn red" data-act="blockNew">Take a room out of order…</button></div><div class="wrap"><table><tr><th>Room</th><th>From</th><th>Through</th><th>Reason</th><th></th></tr>${S.blocks.map(b => `<tr><td><b>${esc(b.room)}</b></td><td>${dshort(b.start)}</td><td>${dshort(b.end)}</td><td>${esc(b.reason)}</td><td><button class="btn sm" data-act="blockRemove" data-id="${b.id}">Put back in order</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No rooms are out of order.</td></tr>'}</table></div>`;
  if (view.setup === 'users') setTimeout(async () => { const box = $('#usersBox'); if (!box) return; try { const u = (await api('/users')).users; box.innerHTML = `<div class="wrap"><table><tr><th>User name</th><th>Name</th><th>Role</th><th>Status</th></tr>${u.map(x => `<tr class="click" data-act="userPick" data-u="${esc(JSON.stringify(x))}"><td><b>${esc(x.username)}</b></td><td>${esc(x.name)}</td><td>${{ manager: 'Manager', desk: 'Front desk', hk: 'Housekeeping only' }[x.role]}</td><td>${x.disabled ? '<span class="badge r">Off</span>' : '<span class="badge g">On</span>'}</td></tr>`).join('')}</table></div>`; } catch (e) { box.textContent = e.message; } }, 0);
  return `<h1>Setup</h1><div class="acts" style="margin-bottom:12px">${SETUP.map(s => `<button class="btn sm ${view.setup === s[0] ? 'blue' : ''}" data-act="setupTab" data-tab="${s[0]}">${s[1]}</button>`).join('')}</div>${body}`;
}
async function setupSave() {
  const lines = id => $('#' + id).value.split('\n').map(l => l.split(',').map(x => x.trim())).filter(p => p[0]);
  const c = {};
  if (view.setup === 'property') for (const k of ['name', 'phone', 'address', 'checkinTime', 'checkoutTime', 'regText']) c[k] = $('#s_' + k).value;
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
  if (a === 'logout') return run(async () => { await api('/logout', {}); S = null; showLogin(); });
  if (a === 'newRes') return openNew('new', el.dataset.room, el.dataset.date);
  if (a === 'walkIn') return openNew('walkin');
  if (a === 'openRes') return run(() => openRes(el.dataset.id));
  if (a === 'closeModal') { $('#modal').innerHTML = ''; ED = null; FO = null; return; }
  if (a === 'closeHist') { $('#hist').remove(); return; }
  if (a === 'saveRes') return saveRes();
  if (['checkIn', 'checkOut', 'undoCheckIn', 'undoCheckOut', 'cancelRes', 'noShow', 'reinstate', 'folio', 'viewChanges', 'printReg', 'printConf'].includes(a)) return resAction(a);
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
  if (a === 'pwSave') return run(async () => { await op('password', { old: $('#pw_old').value, new: $('#pw_new').value }); $('#pw_old').value = $('#pw_new').value = ''; toast('Password changed.'); });
  if (a === 'userPick') { const u = JSON.parse(el.dataset.u); $('#u_username').value = u.username; $('#u_name').value = u.name; $('#u_role').value = u.role; $('#u_disabled').checked = u.disabled; $('#u_password').value = ''; return; }
  if (a === 'userSave') return run(async () => { await op('userSave', { username: $('#u_username').value, name: $('#u_name').value, role: $('#u_role').value, password: $('#u_password').value, disabled: $('#u_disabled').checked }); toast('Login saved.'); render(); });
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
  if (e.key === 'Escape' && $('#modal').innerHTML) { if ($('#hist')) $('#hist').remove(); else { $('#modal').innerHTML = ''; ED = null; FO = null; } }
});
// Keep every front-desk screen current: other computers' changes show up within 20 seconds.
setInterval(() => { if (S && !$('#modal').innerHTML && document.visibilityState === 'visible' && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) refresh().catch(() => { }); }, 20000);
refresh().catch(() => showLogin());
