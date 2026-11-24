// Hotel Desk (trivedipos.com/hotel): the hotel front-desk system's rules and storage.
// This file has no Cloudflare-specific code, so it can be tested on a plain computer (see hotel/README.md).
// `sql` is the Durable Object's SQLite: sql.exec(query, ...params).toArray().
// Card numbers are never stored: only the card type and the last 4 digits.
// One of these runs per hotel. Logins live in hotel-dir.js (the directory); every request arrives with `me` already checked.
import * as nc from 'node:crypto';

const now = () => Date.now();
const sha = s => nc.createHash('sha256').update(s).digest('hex');
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const nightsBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const cents = v => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw err(400, 'That amount is not a number.'); return n; };
function err(code, msg) { const e = new Error(msg); e.code = code; return e; }
const PAY_TYPES = ['CASH', 'CRED', 'AREC', 'GFTCRD'];
const ACTIVE = ['reserved', 'inhouse'];
const CODE_TYPES = ['ROOM', 'MISC', 'CASH', 'CRED', 'AREC', 'GFTCRD', 'ADMIN'];
const t12 = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); if (!m) return String(t || ''); const h = +m[1]; return ((h % 12) || 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM'); };
const usd = v => '$' + (v / 100).toFixed(2);
const cityLine = c => [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
export const defaultCancelText = h => 'Please cancel at least ' + h + ' hours before your arrival to avoid a charge for the first night.';
/* The hotel's policies as plain sentences (only the ones that are filled in). */
export function policyLines(c) {
  const p = c.policies; if (!p) return [];
  const L = [(p.cancelText || defaultCancelText(p.cancelHours))]; if (p.deposit > 0) L.push('A deposit of ' + usd(p.deposit) + ' is taken when you book.'); if (p.hold > 0) L.push('A card hold of ' + usd(p.hold) + ' per stay is placed for incidentals.');
  L.push(p.pets === 'yes' ? 'Pets are allowed' + (p.petFee > 0 ? ' for a fee of ' + usd(p.petFee) + ' per night.' : '.') : 'Pets are not allowed.'); if (p.smokingFee > 0) L.push('A smoking fee of ' + usd(p.smokingFee) + ' applies to a room that was smoked in.'); if (p.other) L.push(p.other); return L;
}

/* The starter setup: rooms, room types, taxes and posting codes. Everything can be changed in Setup. */
function starterConfig(template) {
  const blank = template !== 'ky55';
  let types = [['NK', 'King', 8000], ['NK1', 'King (1st floor)', 8000], ['NQ', 'Queen', 8000], ['NQQ', 'Two Queens', 8500], ['HNK', 'Accessible King', 8000], ['HNQ', 'Accessible Queen', 8000],
    ['SNK', 'King Suite', 10500], ['SNK1', 'King Suite (1st floor)', 10500], ['SNQQ', 'Two Queens Suite', 10500]].map(([code, name, rate]) => ({ code, name, rate }));
  const R = 'SNK1 101,NK 102,NQQ 103,SNQQ 104,NQQ 105,SNQQ 106,NK 107,HNK 109,NQQ 111,NK 128,NK1 129,HNK 130,NK 131,NQQ 132,NQQ 133,NK 134,HNQ 135,SNK 136,NQQ 137,SNK 138,SNK1 139,NK 140,' +
    'SNK1 201,NK 202,NK 203,SNK 204,NK 205,SNQQ 206,NQQ 207,NQQ 208,NQQ 209,NQ 210,NK 211,NQQ 212,NK 213,NK 214,NK 218,NQQ 219,NQQ 220,NQQ 221,NQQ 222,NK 223,NQQ 224,NK1 225,NQQ 226,NQQ 227,NK 228,NQQ 229,NK 230,NK 231,SNK 232,NK 233,SNK 234,SNK1 235,NK 236';
  let rooms = R.split(',').map(x => { const [type, no] = x.split(' '); return { no, type, floor: no[0], nosmoke: false, accessible: /^H/.test(type), rentLast: false }; });
  let taxes = [{ code: 'T1', name: 'State Tax', pct: 6.24 }, { code: 'T2', name: 'City / County Tax', pct: 3 }, { code: 'T3', name: 'Occupancy Tax', pct: 1 }];
  // A new hotel starts blank: three sample room types, no rooms, and taxes at 0% for the owner to fill in.
  if (blank) { types = [['K', 'King', 9000], ['QQ', 'Two Queens', 9500], ['STE', 'Suite', 12000]].map(([code, name, rate]) => ({ code, name, rate })); rooms = []; taxes = taxes.map(t => ({ ...t, pct: 0 })); }
  const all = ['T1', 'T2', 'T3'];
  const C = (code, name, type, tax) => ({ code, name, type, tax: tax || [] });
  const codes = [C('RM', 'Room Charge', 'ROOM', all), C('NS', 'No Show Charge', 'ROOM', all), C('CXL', 'Cancellation / Early Check-out', 'ROOM', all), C('RL', 'Rollaway Charge', 'ROOM', all),
    C('PET', 'Pet Charge', 'MISC', all), C('DAMG', 'Damages / Missing items', 'MISC'), C('MS', 'Miscellaneous', 'MISC', ['T1']), C('MR', 'Meeting Room', 'MISC', ['T1']), C('LV', 'Valet / Laundry', 'MISC', ['T1']),
    C('LD', 'Phone Charge', 'MISC', ['T1']), C('FX', 'Fax Charge', 'MISC', ['T1']),
    C('CA', 'Cash', 'CASH'), C('CK', 'Check', 'CASH'), C('VI', 'Visa', 'CRED'), C('MC', 'Master Card', 'CRED'), C('AX', 'American Express', 'CRED'), C('DS', 'Discover', 'CRED'),
    C('DB', 'Direct Bill', 'AREC'), C('GC', 'Gift Card', 'GFTCRD'), C('GR', 'Guest Refund', 'CASH'), C('PO', 'Cash Paid Out', 'CASH'), C('WO', 'Write-off', 'ADMIN'), C('ADM', 'Admin.', 'ADMIN')];
  return { name: 'My Hotel', address: '', phone: '', bdate: '', types, rooms, taxes, codes, housekeepers: [], nextConf: 10001, checkoutTime: '11:00', checkinTime: '15:00', regText: 'I agree to pay all charges for this stay. The hotel is not responsible for valuables left in the room.' };
}

/* The guest rewards program each hotel runs for its own guests (config key `rewards`). Off until the owner turns it on in Setup. */
function defaultRewards() {
  return { enabled: false, name: 'Guest Rewards', earn: 'nights', perNight: 100, perDollar: 10, pointValue: 1, minRedeem: 1000, tiers: [
    { name: 'Member', min: 0, message: 'Welcome back. Thank you for being a member.', amenity: '' },
    { name: 'Silver', min: 2000, message: 'Silver member. Thank the guest for staying with us again.', amenity: 'Bottled water' },
    { name: 'Gold', min: 6000, message: 'Gold member. Greet the guest by name and offer a late check-out if we can.', amenity: 'Snack basket' },
    { name: 'Platinum', min: 15000, message: 'Platinum member. Our most loyal guest: offer a room upgrade if one is free.', amenity: 'Fruit and a handwritten note' }] };
}
const NUMKEYS = [['perNight', 'Points per night'], ['perDollar', 'Points per dollar'], ['pointValue', 'Point value (cents)'], ['minRedeem', 'Minimum points to redeem']];
const digitsOnly = x => String(x || '').replace(/\D/g, '');
const idNorm = x => String(x || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const nameNorm = x => String(x || '').trim().toLowerCase();

export class HotelCore {
  constructor(sql) {
    this.sql = sql;
    for (const q of ['CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)',
      'CREATE TABLE IF NOT EXISTS res(id INTEGER PRIMARY KEY, status TEXT, arrive TEXT, depart TEXT, room TEXT, name TEXT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS lines(id INTEGER PRIMARY KEY AUTOINCREMENT, res INTEGER NOT NULL, bdate TEXT, at INTEGER, code TEXT, descr TEXT, comment TEXT, amount INTEGER NOT NULL, user TEXT)',
      'CREATE INDEX IF NOT EXISTS lines_res ON lines(res)', 'CREATE INDEX IF NOT EXISTS lines_bdate ON lines(bdate)',
      'CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, start TEXT, end TEXT, reason TEXT)',
      'CREATE TABLE IF NOT EXISTS audits(bdate TEXT PRIMARY KEY, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS companies(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS ar(id INTEGER PRIMARY KEY AUTOINCREMENT, company INTEGER NOT NULL, res INTEGER, bdate TEXT, at INTEGER, kind TEXT, descr TEXT, amount INTEGER NOT NULL, user TEXT)',
      'CREATE TABLE IF NOT EXISTS grps(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, open_at INTEGER, close_at INTEGER, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS dnr(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, user TEXT, line TEXT)']) this.sql.exec(q);
  }
  rows(q, ...p) { return this.sql.exec(q, ...p).toArray(); }
  one(q, ...p) { const r = this.rows(q, ...p); return r.length ? r[0] : null; }
  kv(k, d) { const r = this.one('SELECT v FROM kv WHERE k=?', k); return r ? JSON.parse(r.v) : d; }
  setKv(k, v) { this.sql.exec('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)', k, JSON.stringify(v)); }
  cfg() { const c = this.kv('config', null) || starterConfig(); c.packages = c.packages || []; c.rateRules = c.rateRules || []; c.rewards = { ...defaultRewards(), ...(c.rewards || {}) }; return c; }
  log(user, line) { this.sql.exec('INSERT INTO log(at,user,line) VALUES(?,?,?)', now(), user || '', String(line).slice(0, 300)); this.sql.exec('DELETE FROM log WHERE id < (SELECT MAX(id) - 20000 FROM log)'); }

  /* ---------- companies, groups, rates ---------- */
  company(id) { const r = this.one('SELECT id, data FROM companies WHERE id=?', Number(id) || 0); return r ? { ...JSON.parse(r.data), id: r.id } : null; }
  companies() { return this.rows('SELECT id, data FROM companies').map(r => ({ ...JSON.parse(r.data), id: r.id })); }
  group(id) { const r = this.one('SELECT id, data FROM grps WHERE id=?', Number(id) || 0); return r ? { ...JSON.parse(r.data), id: r.id } : null; }
  groups() { return this.rows('SELECT id, data FROM grps').map(r => ({ ...JSON.parse(r.data), id: r.id })); }
  arBalance(id) { return this.one('SELECT COALESCE(SUM(amount),0) n FROM ar WHERE company=?', id).n; }
  // The standard rate for a room type on a date: the type's rate, unless a "rates by date" line covers that day (the last matching line wins).
  rateFor(c, type, d) {
    const t = c.types.find(x => x.code === type); let v = t ? t.rate : 0; const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    for (const r of c.rateRules) if (r.from <= d && d <= r.to && (r.type === '*' || r.type === type) && (!r.days || !r.days.length || r.days.includes(dow))) v = r.rate;
    return v;
  }
  // Has this group let go of its unsold rooms for the night `d`? Rolling (cutoffDays): each night goes back on sale cutoffDays before it
  // (business date > night - cutoffDays). Otherwise the fixed cut-off date: released once the business date is past it.
  groupReleased(c, g, d) { if (g.cutoffDays != null) return c.bdate > addDays(d, -g.cutoffDays); return !!g.cutoff && g.cutoff < c.bdate; }
  // Rooms of a type that groups are still holding on a night (blocks not picked up yet, until the cut-off date passes).
  groupHold(c, type, d, exceptGroup, act, grps) {
    let n = 0;
    for (const g of grps) { if (g.id === exceptGroup || g.status === 'cancelled' || !(g.arrive <= d && d < g.depart) || this.groupReleased(c, g, d)) continue; const blk = (g.blocks || {})[type] || 0; if (!blk) continue; n += Math.max(0, blk - act.filter(r => r.groupId === g.id && r.type === type && r.arrive <= d && d < r.depart).length); }
    return n;
  }

  /* ---------- guest rewards program ---------- */
  member(id) { const r = this.one('SELECT id, data FROM members WHERE id=?', Number(id) || 0); return r ? { ...JSON.parse(r.data), id: r.id } : null; }
  members() { return this.rows('SELECT id, data FROM members ORDER BY id').map(r => ({ ...JSON.parse(r.data), id: r.id })); }
  putMember(m) { const { id, ...d } = m; this.sql.exec('UPDATE members SET data=? WHERE id=?', JSON.stringify(d), id); }
  tierOf(rw, earned) { let t = rw.tiers[0]; for (const x of rw.tiers) if (x.min <= earned && x.min >= t.min) t = x; return t; }
  rwOn(c) { return !!(c.rewards && c.rewards.enabled); }
  rwNeedOn(c) { if (!this.rwOn(c)) throw err(400, 'The rewards program is not turned on. Turn it on in Setup > Rewards.'); }
  slimMember(m, rw) { return { id: m.id, number: m.number, last: m.last, first: m.first, phone: m.phone, guestId: m.guestId, points: m.points, earned: m.earned, tier: this.tierOf(rw, m.earned).name, nights: m.nights, stays: m.stays, revenue: m.revenue, joined: m.joined }; }
  memberLog(m, me, c, what, points, res) { m.log.push({ at: now(), bdate: c.bdate, by: me.username, what: clip(what, 200), points, ...(res ? { res } : {}) }); m.log = m.log.slice(-100); }
  // A member found by the same guest ID, the same last + first name, or the same phone (7 or more digits).
  memberFind(g, exceptId) {
    const id = idNorm(g.guestId), last = nameNorm(g.last), first = nameNorm(g.first), ph = digitsOnly(g.phone);
    return this.members().find(m => m.id !== exceptId && ((id && idNorm(m.guestId) === id) || (last && first && nameNorm(m.last) === last && nameNorm(m.first) === first) || (ph.length >= 7 && digitsOnly(m.phone).slice(-10) === ph.slice(-10)))) || null;
  }
  memberSave(a, me, c) {
    this.rwNeedOn(c); const m = a.id ? this.member(a.id) : { number: '', joined: c.bdate, points: 0, earned: 0, nights: 0, revenue: 0, stays: 0, log: [] };
    if (a.id && !m) throw err(404, 'That member was not found.');
    for (const [k, n] of [['last', 60], ['first', 60], ['phone', 30], ['email', 100], ['guestId', 40]]) if (k in a || !a.id) m[k] = clip(a[k], n);
    if (!m.last) throw err(400, 'Type the member\'s last name.');
    const gid = idNorm(m.guestId), ph = digitsOnly(m.phone);
    const dup = this.members().find(x => x.id !== m.id && ((gid && idNorm(x.guestId) === gid) || (nameNorm(x.last) === nameNorm(m.last) && nameNorm(x.first) === nameNorm(m.first) && digitsOnly(x.phone) === ph)));
    if (dup) throw err(409, 'That guest is already a member: ' + dup.number + ' ' + dup.last + (dup.first ? ', ' + dup.first : '') + '. Search for them instead (a different person with the same name needs a phone number or guest ID).');
    if (!a.id) { const n = this.kv('memberNext', 100001); m.number = 'R' + n; this.setKv('memberNext', n + 1); this.memberLog(m, me, c, 'Enrolled', 0); this.sql.exec('INSERT INTO members(data) VALUES(?)', JSON.stringify(m)); m.id = this.one('SELECT MAX(id) n FROM members').n; this.log(me.username, 'rewards enroll ' + m.number); }
    else { this.putMember(m); this.log(me.username, 'rewards member changed ' + m.number); }
    return m;
  }
  memberAdjust(a, me, c) {
    this.rwNeedOn(c); const m = this.member(a.id); if (!m) throw err(404, 'That member was not found.');
    const pts = Number(a.points), why = clip(a.reason, 200); if (!Number.isInteger(pts) || pts === 0 || Math.abs(pts) > 1e7) throw err(400, 'Type the points to add or take off, a whole number (for example 500 or -200).');
    if (!why) throw err(400, 'Type the reason for the adjustment.'); if (m.points + pts < 0) throw err(400, 'The balance cannot go below 0. ' + m.number + ' has ' + m.points + ' points.');
    m.points += pts; this.memberLog(m, me, c, 'Adjustment: ' + why, pts); this.putMember(m); this.log(me.username, 'rewards adjust ' + m.number + ' ' + pts); return m;
  }
  linkMember(r, mid, me, c) {   // sets or clears the member on a reservation (the caller saves it)
    if (!mid) { if (r.memberId) r.history.push({ at: now(), by: me.username, what: 'Removed from rewards (' + r.memberNo + ')' }); delete r.memberId; delete r.memberNo; return; }
    if (Number(mid) === r.memberId) return; this.rwNeedOn(c); const m = this.member(mid); if (!m) throw err(404, 'That rewards member was not found.');
    r.memberId = m.id; r.memberNo = m.number; r.history.push({ at: now(), by: me.username, what: 'Rewards member ' + m.number + ' linked' });
  }
  // Check-out: points for the nights (or the room revenue) on the folio. A night counts when its room charges net above zero.
  rwEarn(r, me, c) {
    const rw = c.rewards; if (!rw.enabled || !r.memberId || r.rwEarned) return; const m = this.member(r.memberId); if (!m) return;
    const byDay = {}; for (const l of this.rows("SELECT bdate, SUM(amount) n FROM lines WHERE res=? AND code='RM' GROUP BY bdate", r.id)) byDay[l.bdate] = l.n;
    const nights = Object.values(byDay).filter(n => n > 0).length, revenue = Math.max(0, Object.values(byDay).reduce((a, b) => a + b, 0));
    const points = rw.earn === 'revenue' ? Math.floor(revenue / 100) * rw.perDollar : nights * rw.perNight;
    m.points += points; m.earned += points; m.nights += nights; m.revenue += revenue; m.stays += 1; r.rwEarned = { points, nights, revenue };
    this.memberLog(m, me, c, 'Stay ' + r.conf + ': +' + points + ' points', points, r.id); this.putMember(m);
    r.history.push({ at: now(), by: me.username, what: 'Rewards: +' + points + ' points to ' + m.number });
  }
  rwUndo(r, me, c) {
    const e = r.rwEarned; if (!e) return; const m = this.member(r.memberId); delete r.rwEarned; if (!m) return;
    const take = Math.min(m.points, e.points); m.points -= take; m.earned = Math.max(0, m.earned - e.points); m.nights = Math.max(0, m.nights - e.nights); m.revenue = Math.max(0, m.revenue - e.revenue); m.stays = Math.max(0, m.stays - 1);
    this.memberLog(m, me, c, 'Check-out undone: −' + take + ' points', -take, r.id); this.putMember(m);
  }
  redeem(a, me, c, r, k) {
    this.rwNeedOn(c); const rw = c.rewards; if (a.kind !== 'payment') throw err(400, 'Rewards Redemption is a payment. Use Post Payment.');
    if (!r.memberId) throw err(400, 'This reservation has no rewards member. Add the guest to the program first.'); const m = this.member(r.memberId); if (!m) throw err(404, 'That rewards member was not found.');
    const pts = Number(a.points); if (!Number.isInteger(pts) || pts <= 0) throw err(400, 'Type the points to redeem, a whole number.');
    if (rw.pointValue < 1) throw err(400, 'Points are not worth anything yet. Set the point value in Setup > Rewards.');
    if (pts < rw.minRedeem) throw err(400, 'The least that can be redeemed is ' + rw.minRedeem + ' points.'); if (pts > m.points) throw err(400, m.number + ' has only ' + m.points + ' points.');
    const value = pts * rw.pointValue, bal = this.balance(r.id); if (value > bal) throw err(400, 'That is worth ' + (value / 100).toFixed(2) + ', more than the folio balance of ' + (bal / 100).toFixed(2) + '.');
    this.addLine(r.id, c, k.code, -value, pts + ' points, member ' + m.number, me.username); m.points -= pts; this.memberLog(m, me, c, 'Redeemed ' + pts + ' points on ' + r.conf, -pts, r.id); this.putMember(m);
    this.log(me.username, 'rewards redeem ' + m.number + ' ' + pts); return { balance: this.balance(r.id), points: m.points, value };
  }
  // Setup > Rewards: checks the typed settings and returns the clean object.
  cleanRewards(n, old) {
    const o = { ...old }; if (!n || typeof n !== 'object') throw err(400, 'The rewards settings must be an object.');
    if ('enabled' in n) o.enabled = !!n.enabled; if ('name' in n) o.name = clip(n.name, 40) || 'Guest Rewards';
    if ('earn' in n) { if (!['nights', 'revenue'].includes(n.earn)) throw err(400, 'Earn points by nights or by revenue.'); o.earn = n.earn; }
    for (const [k, label] of NUMKEYS) if (k in n) { const v = typeof n[k] === 'string' && n[k].trim() === '' ? NaN : Number(n[k]); if (!Number.isInteger(v) || v < 0 || v > 1e7) throw err(400, label + ' must be a whole number, 0 or more.'); o[k] = v; }
    if ('tiers' in n) {
      if (!Array.isArray(n.tiers) || !n.tiers.length) throw err(400, 'Keep at least one tier.'); if (n.tiers.length > 6) throw err(400, 'At most 6 tiers.');
      const tiers = n.tiers.map(t => { const min = typeof t.min === 'string' && t.min.trim() === '' ? NaN : Number(t.min); if (!Number.isInteger(min) || min < 0 || min > 1e8) throw err(400, 'Each tier\'s minimum points must be a whole number, 0 or more.'); return { name: clip(t && t.name, 30), min, message: clip(t.message, 200), amenity: clip(t.amenity, 80) }; }).sort((a, b) => a.min - b.min);
      if (tiers.some(t => !t.name)) throw err(400, 'Every tier needs a name.'); if (new Set(tiers.map(t => t.name.toLowerCase())).size !== tiers.length) throw err(400, 'Tier names must be different.');
      if (new Set(tiers.map(t => t.min)).size !== tiers.length) throw err(400, 'Tier minimums must be different.'); if (tiers[0].min !== 0) throw err(400, 'The first tier must start at 0 points.'); o.tiers = tiers;
    }
    return o;
  }
  rewardsReport(c) {
    const rw = c.rewards, ms = this.members().sort((a, b) => b.earned - a.earned || a.number.localeCompare(b.number)), tiers = rw.tiers.map(t => ({ name: t.name, min: t.min, members: 0, points: 0, earned: 0, nights: 0, revenue: 0 }));
    const rows = ms.map(m => { const tn = this.tierOf(rw, m.earned).name, t = tiers.find(x => x.name === tn); t.members++; t.points += m.points; t.earned += m.earned; t.nights += m.nights; t.revenue += m.revenue; return { number: m.number, name: m.last + (m.first ? ', ' + m.first : ''), tier: tn, points: m.points, earned: m.earned, nights: m.nights, stays: m.stays, revenue: m.revenue, joined: m.joined }; });
    const sum = k => rows.reduce((s, x) => s + x[k], 0);
    return { rows, tiers, totals: { members: rows.length, points: sum('points'), earned: sum('earned'), nights: sum('nights'), stays: sum('stays'), revenue: sum('revenue') }, pointValue: rw.pointValue, outstandingValue: sum('points') * rw.pointValue };
  }

  /* ---------- Do Not Rent list ---------- */
  dnrList() { return this.rows('SELECT id, data FROM dnr ORDER BY id').map(r => ({ ...JSON.parse(r.data), id: r.id })); }
  // The first list entry that fits this guest: same guest ID (letters and digits only, any case), or the same last AND first name.
  dnrMatch(r) {
    const idn = x => String(x || '').replace(/[^a-z0-9]/gi, '').toLowerCase(), nm = x => String(x || '').trim().toLowerCase();
    return this.dnrList().find(e => (idn(e.guestId) && idn(e.guestId) === idn(r.guestId)) || (nm(e.last) && nm(e.first) && nm(e.last) === nm(r.last) && nm(e.first) === nm(r.first))) || null;
  }
  // Throws 428 when the guest is listed and the desk has not said "continue anyway" (dnrOk). Returns true when the warning was accepted.
  dnrCheck(r, a) {
    const e = this.dnrMatch(r); if (!e) return false; if (a && a.dnrOk) return true;
    const d = e.bdate || new Date(e.at).toISOString().slice(0, 10), [y, m, dd] = d.split('-').map(Number), who = e.last ? (e.last + (e.first ? ', ' + e.first : '')).toUpperCase() : 'GUEST ID ' + e.guestId;
    throw err(428, 'DO NOT RENT: ' + who + '. Reason: ' + e.reason + '. Added by ' + e.by + ' on ' + m + '/' + dd + '/' + y + '. Continue anyway?');
  }

  /* ---------- reservations ---------- */
  getRes(id) { const r = this.one('SELECT data FROM res WHERE id=?', Number(id) || 0); if (!r) throw err(404, 'That reservation was not found.'); return JSON.parse(r.data); }
  putRes(r) { this.sql.exec('INSERT OR REPLACE INTO res(id,status,arrive,depart,room,name,data) VALUES(?,?,?,?,?,?,?)', r.id, r.status, r.arrive, r.depart, r.room || '', (r.last + ', ' + r.first).toUpperCase(), JSON.stringify(r)); }
  activeRes() { return this.rows("SELECT data FROM res WHERE status IN ('reserved','inhouse')").map(x => JSON.parse(x.data)); }
  blocks() { return this.rows('SELECT * FROM blocks'); }
  // Rooms of a type left to sell for every night of a stay (the lowest night counts).
  availOfType(c, type, from, to, exceptId, act, blks, forGroup) {
    act = act || this.activeRes(); blks = blks || this.blocks(); const grps = this.groups();
    const roomsOfType = c.rooms.filter(r => r.type === type).map(r => r.no); let min = roomsOfType.length;
    for (let d = from; d < to; d = addDays(d, 1)) {
      const sold = act.filter(r => r.id !== exceptId && r.type === type && r.arrive <= d && d < r.depart).length;
      const ooo = roomsOfType.filter(no => blks.some(b => b.room === no && b.start <= d && d <= b.end)).length;
      min = Math.min(min, roomsOfType.length - sold - ooo - this.groupHold(c, type, d, forGroup || 0, act, grps));
    }
    return min;
  }
  roomProblem(c, room, from, to, exceptId) {
    if (!c.rooms.some(r => r.no === room)) return 'Room ' + room + ' does not exist.';
    const clash = this.activeRes().find(r => r.id !== exceptId && r.room === room && r.arrive < to && from < r.depart);
    if (clash) return 'Room ' + room + ' is taken by ' + clash.last + ', ' + clash.first + ' (' + clash.arrive + ' to ' + clash.depart + ').';
    const b = this.blocks().find(b => b.room === room && b.start < to && from <= b.end);
    if (b) return 'Room ' + room + ' is out of order ' + b.start + ' to ' + b.end + (b.reason ? ' (' + b.reason + ')' : '') + '.';
    return '';
  }
  nightRate(r, d) { return r.rates && r.rates[d] != null ? r.rates[d] : (r.rate || 0); }
  balance(id) { return this.one('SELECT COALESCE(SUM(amount),0) n FROM lines WHERE res=?', id).n; }
  resSave(a, me, c) {
    const isNew = !a.id; const r = isNew ? { id: 0, status: 'reserved', created: now(), createdBy: me.username, history: [] } : this.getRes(a.id);
    if (!isNew && !ACTIVE.includes(r.status)) throw err(400, 'This reservation is ' + r.status + ' and cannot be changed. Reinstate it first.');
    const before = JSON.stringify([r.arrive, r.depart, r.type, r.room, r.rate]), was = { arrive: r.arrive, depart: r.depart, type: r.type, groupId: r.groupId || 0, companyId: r.companyId || 0 };
    for (const [k, n] of [['first', 60], ['last', 60], ['addr1', 100], ['addr2', 100], ['city', 60], ['state', 30], ['zip', 15], ['country', 40], ['phone', 30], ['email', 100], ['guestId', 40], ['vehicle', 40],
      ['company', 80], ['notes', 1000], ['requests', 300], ['market', 30], ['source', 30], ['guarantee', 20], ['payType', 10], ['cardType', 10]]) if (k in a) r[k] = clip(a[k], n);
    if ('cardLast4' in a) r.cardLast4 = String(a.cardLast4 || '').replace(/\D/g, '').slice(-4);
    for (const k of ['vip', 'taxExempt', 'noPost', 'crib', 'rollaway', 'suppressRate']) if (k in a) r[k] = !!a[k];
    if (!r.last) throw err(400, 'Type the guest\'s last name.');
    if ('arrive' in a) r.arrive = a.arrive; if ('depart' in a) r.depart = a.depart;
    if (!isDate(r.arrive) || !isDate(r.depart) || r.depart <= r.arrive) throw err(400, 'Check the arrival and departure dates.');
    if (nightsBetween(r.arrive, r.depart) > 365) throw err(400, 'A stay can be at most 365 nights.');
    if (isNew && r.arrive < c.bdate) throw err(400, 'The arrival date is before today\'s business date (' + c.bdate + ').');
    if (r.status === 'inhouse' && 'arrive' in a && JSON.parse(before)[0] !== r.arrive) throw err(400, 'The guest is already checked in, so the arrival date cannot change.');
    if ('type' in a) r.type = a.type; const t = c.types.find(t => t.code === r.type); if (!t) throw err(400, 'Pick a room type.');
    if ('adults' in a) r.adults = Math.max(1, Math.min(20, Number(a.adults) || 1)); if ('children' in a) r.children = Math.max(0, Math.min(20, Number(a.children) || 0));
    r.adults = r.adults || 1; r.children = r.children || 0;
    if ('groupId' in a) { r.groupId = Number(a.groupId) || 0; if (r.groupId) { const g = this.group(r.groupId); if (!g || g.status === 'cancelled') throw err(400, 'That group was not found.'); if (r.arrive < g.arrive || r.depart > g.depart) throw err(400, 'The stay must be inside the group\'s dates (' + g.arrive + ' to ' + g.depart + ').'); r.groupName = g.name; if (g.companyId && !('companyId' in a)) a.companyId = g.companyId; } else r.groupName = ''; }
    if ('companyId' in a) { r.companyId = Number(a.companyId) || 0; if (r.companyId) { const co = this.company(r.companyId); if (!co) throw err(400, 'That company was not found.'); r.company = co.name; } else if (was.companyId) r.company = ''; }
    if ('pkg' in a) { r.pkg = clip(a.pkg, 8).toUpperCase(); if (r.pkg && !c.packages.some(x => x.code === r.pkg)) throw err(400, 'That package was not found.'); }
    if ('room' in a) r.room = clip(a.room, 10);
    if (r.room) {
      const rm = c.rooms.find(x => x.no === r.room); if (!rm) throw err(400, 'Room ' + r.room + ' does not exist.');
      const from = r.status === 'inhouse' ? (c.bdate > r.arrive ? c.bdate : r.arrive) : r.arrive;
      const p = from < r.depart ? this.roomProblem(c, r.room, from, r.depart, r.id) : ''; if (p) throw err(409, p);
      if (rm.type !== r.type) r.type = rm.type;   // the room decides the type
    } else if (!a.oversell && this.availOfType(c, r.type, r.arrive > c.bdate ? r.arrive : c.bdate, r.depart, r.id, null, null, r.groupId) < 1) throw err(409, 'No ' + r.type + ' rooms are left for those dates. Pick another room type or dates.');
    if (r.status === 'inhouse' && !r.room) throw err(400, 'A checked-in guest needs a room.');
    // The rate: typed by hand (one rate for every night), or worked out night by night from the group, the company or the rates by date.
    if (a.rateManual !== false && a.rate !== '' && a.rate != null) { r.rate = cents(a.rate); r.rateManual = true; r.rates = null; }
    else if (a.rateManual === false || isNew || !r.rateManual && (r.rate == null || was.arrive !== r.arrive || was.depart !== r.depart || was.type !== r.type || was.groupId !== (r.groupId || 0) || was.companyId !== (r.companyId || 0))) {
      const g = r.groupId ? this.group(r.groupId) : null, co = r.companyId ? this.company(r.companyId) : null, old = r.rates || {}, rates = {};
      for (let d = r.arrive; d < r.depart; d = addDays(d, 1)) rates[d] = r.status === 'inhouse' && d < c.bdate && old[d] != null ? old[d] : g && g.rates && g.rates[r.type] > 0 ? g.rates[r.type] : co && co.rate > 0 ? co.rate : this.rateFor(c, r.type, d);
      r.rates = rates; r.rateManual = false; r.rate = rates[r.arrive > c.bdate || rates[c.bdate] == null ? r.arrive : c.bdate];
    }
    if (r.rate == null) r.rate = t.rate; if (r.rate < 0) throw err(400, 'The rate cannot be negative.');
    if ('memberId' in a) this.linkMember(r, Number(a.memberId) || 0, me, c);
    const dnrSeen = isNew && this.dnrCheck(r, a);
    if (isNew) { r.id = (this.one('SELECT COALESCE(MAX(id),0) n FROM res').n) + 1; r.conf = String(c.nextConf++); this.setKv('config', c); }
    const after = JSON.stringify([r.arrive, r.depart, r.type, r.room, r.rate]);
    if (isNew) { r.history.push({ at: now(), by: me.username, what: 'Created' }); if (dnrSeen) r.history.push({ at: now(), by: me.username, what: 'Do Not Rent warning accepted' }); } else if (before !== after) r.history.push({ at: now(), by: me.username, what: 'Changed stay: ' + before + ' → ' + after });
    r.history = r.history.slice(-60);
    this.putRes(r); this.log(me.username, (isNew ? 'new reservation ' : 'changed reservation ') + r.conf);
    return r;
  }
  roomState() { return this.kv('roomstate', {}); }
  setCond(rooms, patch) { const s = this.roomState(); for (const no of rooms) s[no] = { cond: 'R', ...(s[no] || {}), ...patch }; this.setKv('roomstate', s); }
  checkIn(r, me, c, a) {
    if (r.status !== 'reserved') throw err(400, 'This reservation is ' + r.status + '.');
    const dnrSeen = !a.dnrDone && this.dnrCheck(r, a);
    if (r.arrive > c.bdate) throw err(400, 'This guest arrives ' + r.arrive + '. Today\'s business date is ' + c.bdate + '. Change the arrival date first.');
    if (r.depart <= c.bdate) throw err(400, 'The departure date has passed. Change the stay first.');
    if (!r.room) throw err(400, 'Pick a room first.');
    const other = this.activeRes().find(x => x.status === 'inhouse' && x.room === r.room && x.id !== r.id);
    if (other) throw err(409, 'Room ' + r.room + ' still has ' + other.last + ', ' + other.first + ' checked in.');
    const p = this.roomProblem(c, r.room, c.bdate, r.depart, r.id); if (p) throw err(409, p);
    const cond = (this.roomState()[r.room] || {}).cond || 'R';
    if (cond === 'D' && !a.dirtyOk) throw err(412, 'Room ' + r.room + ' is dirty. Check in anyway?');
    if (dnrSeen) r.history.push({ at: now(), by: me.username, what: 'Do Not Rent warning accepted' });
    r.status = 'inhouse'; r.ciAt = now(); r.ciBy = me.username; r.history.push({ at: now(), by: me.username, what: 'Checked in to ' + r.room });
    if (a.amenityGiven) { const m = r.memberId && this.member(r.memberId), am = m ? this.tierOf(c.rewards, m.earned).amenity : ''; r.amenityGiven = true; r.history.push({ at: now(), by: me.username, what: 'Welcome amenity given' + (am ? ': ' + am : '') }); }
    this.putRes(r); this.log(me.username, 'check in ' + r.conf + ' room ' + r.room); return r;
  }

  /* ---------- cashier shifts ---------- */
  openShift(me) { const r = this.one('SELECT * FROM shifts WHERE user=? AND close_at IS NULL ORDER BY id DESC LIMIT 1', me.username); return r ? { id: r.id, user: r.user, openAt: r.open_at, ...JSON.parse(r.data) } : null; }
  shiftTotals(c, sh, until) {   // what this person took in since the shift opened, by payment type
    const pay = c.codes.filter(k => PAY_TYPES.includes(k.type)), rows = this.rows('SELECT code, COUNT(*) cnt, SUM(amount) total FROM lines WHERE user=? AND at>=? AND at<=? GROUP BY code', sh.user, sh.openAt, until || now())
      .concat(this.rows("SELECT descr code, COUNT(*) cnt, SUM(amount) total FROM ar WHERE user=? AND at>=? AND at<=? AND kind='payment' GROUP BY descr", sh.user, sh.openAt, until || now()).map(x => ({ ...x, ar: true })));
    const by = []; let cash = 0;
    for (const x of rows) { const code = x.ar ? String(x.code).split(' ')[0] : x.code, k = pay.find(p => p.code === code); if (!k) continue; by.push({ code, name: k.name + (x.ar ? ' (company payment)' : ''), cnt: x.cnt, total: -x.total }); if (k.type === 'CASH') cash += -x.total; }
    return { by, cashIn: cash, expected: (sh.openCash || 0) + cash };
  }

  /* ---------- folio ---------- */
  addLine(resId, c, code, amount, comment, user, descr) {
    const k = c.codes.find(x => x.code === code) || c.taxes.find(x => x.code === code);
    this.sql.exec('INSERT INTO lines(res,bdate,at,code,descr,comment,amount,user) VALUES(?,?,?,?,?,?,?,?)', resId, c.bdate, now(), code, descr || (k ? k.name : code), clip(comment, 200), amount, user);
  }
  postCharge(r, c, code, amount, comment, user) {   // a charge (or a negative adjustment) plus its taxes
    const k = c.codes.find(x => x.code === code); if (!k) throw err(400, 'Pick what to post.');
    this.addLine(r.id, c, code, amount, comment, user);
    if (!r.taxExempt) for (const tc of k.tax || []) { const t = c.taxes.find(x => x.code === tc); const amt = t ? Math.round(amount * t.pct / 100) : 0; if (amt) this.addLine(r.id, c, t.code, amt, '', user); }
  }
  post(a, me, c) {
    const r = this.getRes(a.res); const k = c.codes.find(x => x.code === a.code); if (!k) throw err(400, 'Pick what to post.');
    if (k.code === 'RW') return this.redeem(a, me, c, r, k);
    const amt = cents(a.amount); if (!(amt > 0)) throw err(400, 'Type an amount above zero.'); if (amt > 5000000) throw err(400, 'That amount is too large.');
    const pay = PAY_TYPES.includes(k.type) || k.type === 'ADMIN', boss = ['owner', 'manager'].includes(me.role);
    if (r.status === 'cancelled' || r.status === 'noshow') { if (!pay && !['NS', 'CXL'].includes(k.code)) throw err(400, 'Only a no-show or cancellation charge, or a payment, can be posted here.'); }
    if (a.kind === 'payment' && c.requireShift && !boss && !this.openShift(me)) throw err(400, 'Open your cashier shift first (the Shift button at the top).');
    if (a.kind === 'payment' && k.type === 'AREC') {   // direct bill: the amount moves from the guest's folio to the company's account
      const co = r.companyId ? this.company(r.companyId) : null; if (!co || !co.directBill || co.inactive) throw err(400, 'Direct bill needs a company with a direct-bill account on this reservation. Pick the company in the reservation first.');
      if (co.limit > 0 && this.arBalance(co.id) + amt > co.limit && !boss) throw err(409, co.name + ' would go over its credit limit of ' + (co.limit / 100).toFixed(2) + '. A manager can post it.');
      this.sql.exec('INSERT INTO ar(company,res,bdate,at,kind,descr,amount,user) VALUES(?,?,?,?,?,?,?,?)', co.id, r.id, c.bdate, now(), 'invoice', (r.last + ', ' + r.first).toUpperCase() + ' · conf ' + r.conf + ' · ' + r.arrive + ' to ' + r.depart, amt, me.username);
    }
    if (a.kind === 'payment') { if (!pay) throw err(400, 'That is not a payment type.'); const refund = !!a.refund || k.code === 'GR' || k.code === 'PO'; this.addLine(r.id, c, k.code, refund ? amt : -amt, (a.last4 ? '…' + String(a.last4).replace(/\D/g, '').slice(-4) + ' ' : '') + clip(a.comment, 150), me.username, refund && k.code !== 'GR' && k.code !== 'PO' ? k.name + ' refund' : ''); }
    else if (a.kind === 'adjust') { if (pay) throw err(400, 'Pick the charge to adjust.'); if (!boss && amt > 20000) throw err(403, 'An adjustment above $200 needs a manager.'); if (!clip(a.comment, 150)) throw err(400, 'Type the reason for the adjustment.'); this.postCharge(r, c, k.code, -amt, 'ADJ: ' + clip(a.comment, 150), me.username); }
    else { if (pay) throw err(400, 'Use Post Payment for payments.'); this.postCharge(r, c, k.code, amt, a.comment, me.username); }
    this.log(me.username, 'post ' + a.kind + ' ' + k.code + ' ' + amt + ' on ' + r.conf);
    return { balance: this.balance(r.id) };
  }

  /* ---------- numbers for the home screen and reports ---------- */
  stats(c, act, blks) {
    act = act || this.activeRes(); blks = blks || this.blocks(); const d = c.bdate;
    const inh = act.filter(r => r.status === 'inhouse'), ooo = c.rooms.filter(rm => blks.some(b => b.room === rm.no && b.start <= d && d <= b.end)).length;
    const arrivals = act.filter(r => r.status === 'reserved' && r.arrive <= d), total = c.rooms.length;
    const rev = inh.reduce((s, r) => s + this.nightRate(r, d), 0), sold = inh.length, sellable = total - ooo;
    return { total, ooo, sold, vacant: total - sold - ooo, arrivalsLeft: arrivals.length, checkedIn: inh.filter(r => r.arrive === d).length, dueOut: inh.filter(r => r.depart <= d).length,
      stayovers: inh.filter(r => r.depart > d).length, adults: inh.reduce((s, r) => s + (r.adults || 0), 0), children: inh.reduce((s, r) => s + (r.children || 0), 0),
      occ: sellable ? Math.round(sold / sellable * 10000) / 100 : 0, occAll: total ? Math.round(sold / total * 10000) / 100 : 0, roomRev: rev, adr: sold ? Math.round(rev / sold) : 0, revpar: total ? Math.round(rev / total) : 0 };
  }
  state(me) {
    const c = this.cfg(), act = this.activeRes(), blks = this.blocks();
    const recent = this.rows("SELECT data FROM res WHERE status NOT IN ('reserved','inhouse') AND depart>=? ORDER BY id DESC LIMIT 400", addDays(c.bdate || '2000-01-01', -3)).map(x => JSON.parse(x.data));
    const bal = {}; for (const x of this.rows("SELECT res, SUM(amount) n FROM lines WHERE res IN (SELECT id FROM res WHERE status IN ('reserved','inhouse') OR depart>=?) GROUP BY res", addDays(c.bdate || '2000-01-01', -3))) bal[x.res] = x.n;
    const slim = r => { const { history, ...x } = r; return x; };
    const arBal = {}; for (const x of this.rows('SELECT company, SUM(amount) n FROM ar GROUP BY company')) arBal[x.company] = x.n;
    const hk = me.role === 'hk', rwShow = !hk && c.rewards.enabled;
    return { rewards: c.rewards, ...(rwShow ? { members: this.members().slice(-2000).map(m => this.slimMember(m, c.rewards)) } : { members: [] }), me: { email: me.email, name: me.name, role: me.role, master: !!me.master }, companies: hk ? [] : this.companies(), arBal: hk ? {} : arBal, groups: hk ? [] : this.groups().filter(g => g.depart >= addDays(c.bdate || '2000-01-01', -3)), shift: hk ? null : this.openShift({ username: clip(me.name || me.email, 60) }), config: c, roomstate: this.roomState(), res: act.concat(recent).map(slim), blocks: blks, bal, ...(hk ? {} : { dnr: this.dnrList() }), stats: c.bdate ? this.stats(c, act, blks) : null, at: now() };
  }
  /* ---------- recurring charges (a reservation's own list and its group's list) ---------- */
  // Checks a list of {code, amount, comment, from, to}. A charge code is a posting code of type ROOM or MISC. Dates are optional; `def` supplies the defaults.
  cleanRecur(list, c, def) {
    if (!Array.isArray(list)) throw err(400, 'The recurring charges must be a list.'); if (list.length > 10) throw err(400, 'At most 10 recurring charges.');
    return list.map(x => {
      const k = c.codes.find(z => z.code === String(x && x.code || '').toUpperCase()); if (!k || !['ROOM', 'MISC'].includes(k.type)) throw err(400, 'Pick a charge code for the recurring charge (payments cannot repeat).');
      const amount = cents(x.amount); if (!(amount > 0)) throw err(400, 'Type an amount above zero for the recurring charge.'); if (amount > 5000000) throw err(400, 'That amount is too large.');
      const from = x.from ? x.from : def.from, to = x.to ? x.to : def.to; if (!isDate(from) || !isDate(to)) throw err(400, 'Check the dates of the recurring charge.'); if (to < from) throw err(400, 'The recurring charge ends before it starts.');
      return { code: k.code, amount, comment: clip(x.comment, 100), from, to };
    });
  }
  /* ---------- guests who stayed before ---------- */
  // Past reservations of the same guest: same guest ID, or same last and first name, or the same phone (7 or more digits). Newest first.
  guestHistory(q) {
    const idn = x => String(x || '').replace(/[^a-z0-9]/gi, '').toLowerCase(), nm = x => String(x || '').trim().toLowerCase(), dg = x => String(x || '').replace(/\D/g, '');
    const id = idn(q.guestId), last = nm(q.last), first = nm(q.first), ph = dg(q.phone), except = Number(q.except) || 0;
    const same = (a, b) => a === b || (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10));
    if (!id && !(last && first) && ph.length < 7) return { stays: [], count: 0, nights: 0, total: 0, lastNote: '', last: null };
    const all = this.rows('SELECT data FROM res').map(x => JSON.parse(x.data)).filter(r => r.id !== except && ((id && idn(r.guestId) === id) || (last && first && nm(r.last) === last && nm(r.first) === first) || (ph.length >= 7 && dg(r.phone).length >= 7 && same(dg(r.phone), ph))))
      .sort((a, b) => b.arrive.localeCompare(a.arrive) || b.id - a.id);
    const real = all.filter(r => r.status === 'out' || r.status === 'inhouse');   // stays that happened (or are happening); cancelled, no show and future bookings are listed but not counted
    const l = real[0] || null, note = r => [r.notes, r.requests].filter(Boolean).join(' / ');
    return { stays: all.slice(0, 20).map(r => ({ id: r.id, conf: r.conf, arrive: r.arrive, depart: r.depart, room: r.room || '', type: r.type, rate: r.rate, status: r.status, notes: r.notes || '', requests: r.requests || '', balance: this.balance(r.id) })),
      count: real.length, nights: real.reduce((s, r) => s + nightsBetween(r.arrive, r.depart), 0), total: all.length, lastNote: l ? note(l) : '', last: l ? { arrive: l.arrive, depart: l.depart, room: l.room || '', conf: l.conf } : null };
  }
  /* ---------- room assignment optimizer ---------- */
  // Proposes a room for every reserved, unassigned arrival on `date`: Ready before Clean before Dirty, then the room used least (fewest past stays), then the one empty longest. Nothing out of order, nothing overlapping.
  cleanPolicies(x) {
    x = x && typeof x === 'object' ? x : {}; const money = (v, what) => { if (v == null || v === '') return 0; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 0) throw err(400, 'Check the ' + what + '. It must be an amount of zero or more.'); return n; };
    const h = x.cancelHours == null || x.cancelHours === '' ? 24 : Math.round(Number(x.cancelHours)); if (!Number.isFinite(h) || h < 0 || h > 720) throw err(400, 'Guests can cancel free up to a number of hours from 0 to 720.');
    return { cancelHours: h, cancelText: clip(x.cancelText, 1500), deposit: money(x.deposit, 'deposit'), hold: money(x.hold, 'card hold'), pets: x.pets === 'yes' ? 'yes' : 'no', petFee: money(x.petFee, 'pet fee'), smokingFee: money(x.smokingFee, 'smoking fee'), other: clip(x.other, 1500) };
  }
  optimizePlan(c, date) {
    const act = this.activeRes(), blks = this.blocks(), all = this.rows('SELECT data FROM res').map(x => JSON.parse(x.data)), rs = this.roomState();
    const used = {}, lastOut = {}; for (const r of all) if (r.room && (r.status === 'out' || r.status === 'inhouse')) { used[r.room] = (used[r.room] || 0) + 1; if (r.depart > (lastOut[r.room] || '')) lastOut[r.room] = r.depart; }
    const taken = act.filter(r => r.room).map(r => ({ room: r.room, arrive: r.arrive, depart: r.depart })), RANK = { R: 0, C: 1, D: 2 }, plan = [];
    const todo = act.filter(r => r.status === 'reserved' && !r.room && r.arrive === date).sort((a, b) => a.id - b.id);
    for (const r of todo) {
      const cands = c.rooms.filter(rm => rm.type === r.type && !taken.some(t => t.room === rm.no && t.arrive < r.depart && r.arrive < t.depart) && !blks.some(b => b.room === rm.no && b.start < r.depart && r.arrive <= b.end))
          .sort((a, b) => ((a.rentLast ? 1 : 0) - (b.rentLast ? 1 : 0)) || (RANK[(rs[a.no] || {}).cond || 'R'] - RANK[(rs[b.no] || {}).cond || 'R']) || ((used[a.no] || 0) - (used[b.no] || 0)) || (lastOut[a.no] || '').localeCompare(lastOut[b.no] || '') || (a.no < b.no ? -1 : a.no > b.no ? 1 : 0));
      const name = (r.last + (r.first ? ', ' + r.first : '')), pick = cands[0];
      if (!pick) { plan.push({ id: r.id, name, type: r.type, room: null, reason: 'No ' + r.type + ' room is free for ' + r.arrive + ' to ' + r.depart + '.' }); continue; }
      const cd = ({ R: 'Ready', C: 'Clean', D: 'Dirty' })[(rs[pick.no] || {}).cond || 'R'], n = used[pick.no] || 0;
      taken.push({ room: pick.no, arrive: r.arrive, depart: r.depart }); used[pick.no] = n + 1;
      plan.push({ id: r.id, name, type: r.type, room: pick.no, reason: cd + ', ' + (n ? 'used ' + n + (n === 1 ? ' time' : ' times') : 'not used yet') });
    }
    return plan;
  }
  nightAudit(me, c) {
    const d = c.bdate, act = this.activeRes(), out = { date: d, posted: 0, noShows: [], extended: [], revenue: 0 };
    const snap = this.stats(c, act), grps = {}; for (const g of this.groups()) grps[g.id] = g; out.recurring = 0;
    for (const r of act.filter(r => r.status === 'inhouse')) {
      if (r.depart <= d) { r.depart = addDays(d, 1); r.history.push({ at: now(), by: 'night audit', what: 'Not checked out: stay extended to ' + r.depart }); out.extended.push(r.room + ' ' + r.last); this.putRes(r); }
      if (!r.noPost) { const amt = this.nightRate(r, d); this.postCharge(r, c, 'RM', amt, '#' + r.room + ' ' + (r.last + ', ' + r.first).toUpperCase(), 'night audit'); out.posted++; out.revenue += amt; }
      const pk = r.pkg && c.packages.find(x => x.code === r.pkg); if (pk && pk.price > 0) { this.postCharge(r, c, c.codes.some(k => k.code === pk.charge) ? pk.charge : 'MS', pk.price, 'Package: ' + pk.name, 'night audit'); out.packages = (out.packages || 0) + 1; }
      const g = r.groupId && grps[r.groupId] && grps[r.groupId].status !== 'cancelled' ? grps[r.groupId] : null;   // the guest's own recurring charges, then the group's
      for (const x of (r.recur || []).concat(g ? g.recur || [] : [])) if ((!x.from || x.from <= d) && (!x.to || d <= x.to) && c.codes.some(k => k.code === x.code)) { const nm = (c.codes.find(k => k.code === x.code) || {}).name || x.code; this.postCharge(r, c, x.code, x.amount, 'Recurring: ' + (x.comment || nm), 'night audit'); out.recurring++; }
    }
    for (const r of act.filter(r => r.status === 'reserved' && r.arrive <= d)) { r.status = 'noshow'; r.history.push({ at: now(), by: 'night audit', what: 'No show' }); this.putRes(r); out.noShows.push(r.last + ', ' + r.first + ' (' + r.conf + ')'); }
    this.setCond(this.activeRes().filter(r => r.status === 'inhouse').map(r => r.room), { cond: 'D' });
    const tot = this.rows('SELECT code, SUM(amount) n FROM lines WHERE bdate=? GROUP BY code', d);
    this.sql.exec('INSERT OR REPLACE INTO audits(bdate,data) VALUES(?,?)', d, JSON.stringify({ ...snap, roomRev: out.revenue, adr: out.posted ? Math.round(out.revenue / out.posted) : 0, revpar: snap.total ? Math.round(out.revenue / snap.total) : 0, noShows: out.noShows.length, totals: tot, by: me.username, at: now() }));
    this.sql.exec('DELETE FROM blocks WHERE end<?', d);
    c.bdate = addDays(d, 1); this.setKv('config', c); this.log(me.username, 'night audit for ' + d); out.newDate = c.bdate; return out;
  }
  report(q, c) {
    const from = isDate(q.from) ? q.from : c.bdate, to = isDate(q.to) && q.to >= from ? q.to : from;
    if (q.name === 'closeout') return { from, to, rows: this.rows('SELECT code, MAX(descr) descr, COUNT(*) cnt, SUM(amount) total FROM lines WHERE bdate>=? AND bdate<=? GROUP BY code ORDER BY code', from, to) };
    if (q.name === 'shift') return { from, to, rows: this.rows('SELECT user, code, MAX(descr) descr, COUNT(*) cnt, SUM(amount) total FROM lines WHERE bdate>=? AND bdate<=? AND user<>? GROUP BY user, code ORDER BY user, code', from, to, 'night audit') };
    if (q.name === 'stats') { const rows = this.rows('SELECT bdate, data FROM audits WHERE bdate>=? AND bdate<=? ORDER BY bdate', from, to).map(x => ({ date: x.bdate, ...JSON.parse(x.data), totals: undefined })); if (to >= c.bdate && from <= c.bdate) rows.push({ date: c.bdate, live: true, ...this.stats(c) }); return { from, to, rows }; }
    if (q.name === 'journal') return { from, to, rows: this.rows('SELECT l.id, l.bdate, l.at, l.code, l.descr, l.comment, l.amount, l.user, r.name, r.room FROM lines l LEFT JOIN res r ON r.id=l.res WHERE l.bdate>=? AND l.bdate<=? ORDER BY l.id LIMIT 5000', from, to) };
    if (q.name === 'history') { const list = st => this.rows('SELECT data FROM res WHERE status=? AND arrive>=? AND arrive<=? ORDER BY arrive LIMIT 2000', st, from, to).map(x => { const r = JSON.parse(x.data); return { conf: r.conf, name: r.last + ', ' + r.first, arrive: r.arrive, depart: r.depart, type: r.type, room: r.room, rate: r.rate, bal: this.balance(r.id) }; }); return { from, to, noshow: list('noshow'), cancelled: list('cancelled'), out: list('out') }; }
    if (q.name === 'araging') {   // payments pay off the oldest invoices first; what is left is aged from the invoice's date
      const out = [];
      for (const co of this.companies()) { const rows = this.rows('SELECT bdate, amount FROM ar WHERE company=? ORDER BY id', co.id); let credit = -rows.filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0); const b = [0, 0, 0, 0];
        for (const x of rows.filter(x => x.amount > 0)) { const pay = Math.min(credit, x.amount); credit -= pay; const open = x.amount - pay; if (!open) continue; const age = nightsBetween(x.bdate, c.bdate); b[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3] += open; }
        const bal = b[0] + b[1] + b[2] + b[3] - credit; if (bal || rows.length) out.push({ id: co.id, name: co.name, cur: b[0], d30: b[1], d60: b[2], d90: b[3], credit, balance: bal }); }
      return { rows: out };
    }
    if (q.name === 'shifts') return { from, to, rows: this.rows('SELECT * FROM shifts WHERE open_at>=? AND open_at<? ORDER BY id DESC LIMIT 500', Date.parse(from + 'T00:00:00Z') - 864e5, Date.parse(to + 'T00:00:00Z') + 2 * 864e5).map(x => ({ id: x.id, user: x.user, openAt: x.open_at, closeAt: x.close_at, ...JSON.parse(x.data) })) };
    if (q.name === 'grouppickup') { const act = this.rows("SELECT data FROM res WHERE status IN ('reserved','inhouse','out')").map(x => JSON.parse(x.data)); return { rows: this.groups().filter(g => g.depart >= from).map(g => { const blk = Object.values(g.blocks || {}).reduce((s, n) => s + (n || 0), 0), mem = act.filter(r => r.groupId === g.id); return { id: g.id, name: g.name, arrive: g.arrive, depart: g.depart, cutoff: g.cutoff || '', cutoffDays: g.cutoffDays == null ? null : g.cutoffDays, blocked: blk, picked: mem.length, left: Math.max(0, blk - mem.length), revenue: mem.reduce((s, r) => { let t = 0; for (let d = r.arrive; d < r.depart; d = addDays(d, 1)) t += this.nightRate(r, d); return s + t; }, 0), status: g.status || 'active' }; }) }; }
    if (q.name === 'rewards') return this.rewardsReport(c);
    if (q.name === 'closeout2') return this.closeout2(q, c);
    if (q.name === 'shift2') return this.shift2(q, c);
    if (q.name === 'stats2') return this.stats2(q, c);
    if (q.name === 'activity') return this.activity(q, c);
    throw err(404, 'That report was not found.');
  }
  /* ---- helpers for the document-style reports (closeout2, shift2, stats2, activity) ---- */
  kindOf(c) { const m = {}; for (const k of c.codes) m[k.code] = k.type; for (const t of c.taxes || []) m[t.code] = 'TAX'; return m; }
  yearAgo(d) { const y = +d.slice(0, 4) - 1, md = d.slice(5); return (md === '02-29' ? y + '-02-28' : y + '-' + md); }
  // Final Transaction Closeout: per posting code: opening balance (this year, before the date), the day, its adjustments, month to date, year to date.
  closeout2(q, c) {
    const date = isDate(q.date) ? q.date : isDate(q.from) ? q.from : c.bdate, y0 = date.slice(0, 4) + '-01-01', m0 = date.slice(0, 7) + '-01';
    const by = {}; for (const x of this.rows("SELECT code, COUNT(*) cnt, SUM(CASE WHEN bdate<? THEN amount ELSE 0 END) opening, SUM(CASE WHEN bdate=? THEN amount ELSE 0 END) today, SUM(CASE WHEN bdate=? AND substr(comment,1,4)='ADJ:' THEN amount ELSE 0 END) adj, SUM(CASE WHEN bdate>=? THEN amount ELSE 0 END) ptd, SUM(amount) ytd FROM lines WHERE bdate>=? AND bdate<=? GROUP BY code", date, date, date, m0, y0, date)) by[x.code] = x;
    const ORDER = [['AREC', 'ACCOUNTS RECEIVABLE'], ['ADMIN', 'ADMINISTRATION'], ['CASH', 'CASH'], ['CRED', 'CREDIT CARD'], ['GFTCRD', 'GIFT CARD'], ['MISC', 'MISCELLANEOUS'], ['ROOM', 'ROOM'], ['TAX', 'TAX']];
    const known = this.kindOf(c), names = {}; for (const k of c.codes) names[k.code] = k.name; for (const t of c.taxes || []) names[t.code] = t.name;
    const zero = () => ({ opening: 0, today: 0, adj: 0, net: 0, ptd: 0, ytd: 0 }), add = (a, x) => { for (const k of Object.keys(a)) a[k] += x[k] || 0; };
    const grand = zero(), groups = [];
    for (const [type, label] of ORDER) {
      const codes = Object.keys(by).filter(code => (known[code] || 'ADMIN') === type); if (!codes.length) continue;   // a code that was removed from setup is shown under ADMINISTRATION
      const order = Object.keys(known); codes.sort((a, b) => (order.indexOf(a) + 1 || 9999) - (order.indexOf(b) + 1 || 9999) || (a < b ? -1 : 1));
      const total = zero(), rows = codes.map(code => { const x = by[code], r = { code, name: names[code] || code, opening: x.opening, today: x.today, adj: x.adj, net: x.today, ptd: x.ptd, ytd: x.ytd }; add(total, r); return r; });
      add(grand, total); groups.push({ type, label, rows, total });
    }
    return { date, groups, grand };
  }
  // Shift Reconciliation: payments taken on a business date, by posting code, with the lines behind each total.
  shift2(q, c) {
    const date = isDate(q.date) ? q.date : isDate(q.from) ? q.from : c.bdate, user = q.user && q.user !== 'All' ? clip(q.user, 60) : '', kinds = this.kindOf(c);
    const pay = c.codes.filter(k => PAY_TYPES.includes(k.type)), isPay = code => pay.some(k => k.code === code);
    const shifts = this.rows('SELECT id, user, open_at, close_at, data FROM shifts ORDER BY id DESC LIMIT 3000').map(x => ({ id: x.id, user: x.user, openAt: x.open_at, closeAt: x.close_at, ...JSON.parse(x.data) }));
    const shiftOf = (u, at) => { const s = shifts.find(x => x.user === u && x.openAt <= at && (x.closeAt == null || at <= x.closeAt)); return s ? s.id : ''; };
    const all = [];
    for (const l of this.rows("SELECT l.id, l.at, l.code, l.comment, l.amount, l.user, r.room, r.name, json_extract(r.data,'$.conf') conf FROM lines l LEFT JOIN res r ON r.id=l.res WHERE l.bdate=? ORDER BY l.id", date)) if (isPay(l.code)) all.push({ bdate: date, at: l.at, code: l.code, user: l.user, shift: shiftOf(l.user, l.at), room: l.room || '', accType: 'Guest', account: l.conf || '', name: String(l.name || '').replace(/,\s*$/, ''), comment: l.comment || '', amount: l.amount, adj: 0 });
    for (const a of this.rows("SELECT a.at, a.descr, a.amount, a.user, co.data FROM ar a LEFT JOIN companies co ON co.id=a.company WHERE a.kind='payment' AND a.bdate=? ORDER BY a.id", date)) {
      const code = String(a.descr).split(' ')[0]; if (!isPay(code)) continue; const co = a.data ? JSON.parse(a.data) : {};
      all.push({ bdate: date, at: a.at, code, user: a.user, shift: shiftOf(a.user, a.at), room: '', accType: 'Company', account: co.corpId || co.name || '', name: String(co.name || '').toUpperCase(), comment: String(a.descr).split(' ').slice(2).join(' ').replace(/^· /, ''), amount: a.amount, adj: 0 });
    }
    const users = [...new Set(all.map(x => x.user))].sort(), lines = user ? all.filter(x => x.user === user) : all;
    const codes = pay.map(k => ({ code: k.code, name: k.name, rows: lines.filter(x => x.code === k.code) })).filter(g => g.rows.length).map(g => ({ ...g, total: g.rows.reduce((s, x) => s + x.amount, 0) }));
    const grand = codes.reduce((s, g) => s + g.total, 0), cashIn = -codes.filter(g => kinds[g.code] === 'CASH').reduce((s, g) => s + g.total, 0);
    const beginBank = shifts.filter(x => x.bdate === date && (!user || x.user === user)).reduce((s, x) => s + (x.openCash || 0), 0);
    const drawer = q.drawer === undefined || q.drawer === '' ? 0 : Math.round(Number(q.drawer)) || 0;
    return { date, user, users, codes, grand, beginBank, drawer, cashIn, overShort: drawer - beginBank - cashIn };
  }
  // Hotel Statistics: the day (or range), month to date, year to date, and the same periods last year.
  stats2(q, c) {
    const from = isDate(q.from) ? q.from : c.bdate, to = isDate(q.to) && q.to >= from ? q.to : from, kinds = this.kindOf(c);
    const period = (f, t) => {
      let total = 0, ooo = 0, sold = 0, stay = 0, any = false; const add = a => { total += a.total || 0; ooo += a.ooo || 0; sold += a.sold || 0; stay += a.stayovers || 0; any = true; };
      for (const x of this.rows('SELECT data FROM audits WHERE bdate>=? AND bdate<=?', f, t)) add(JSON.parse(x.data));
      if (c.bdate && f <= c.bdate && c.bdate <= t) add(this.stats(c));
      let roomRev = 0, otherRev = 0, tax = 0, payments = 0;
      for (const x of this.rows('SELECT code, SUM(amount) n FROM lines WHERE bdate>=? AND bdate<=? GROUP BY code', f, t)) { const k = kinds[x.code]; if (k === 'ROOM') roomRev += x.n; else if (k === 'MISC') otherRev += x.n; else if (k === 'TAX') tax += x.n; else if (PAY_TYPES.includes(k)) payments += x.n; }
      const avail = total - ooo, pct = (a, b) => b > 0 ? Math.round(a / b * 10000) / 100 : 0;
      return { total, ooo, avail, stay, sold, revRooms: sold, occupied: sold, occAvail: pct(sold, avail), occTotal: pct(sold, total), adr: sold ? Math.round(roomRev / sold) : 0, revpar: total ? Math.round(roomRev / total) : 0, roomRev, otherRev, tax, totalRev: roomRev + otherRev + tax, payments };
    };
    const m0 = to.slice(0, 7) + '-01', y0 = to.slice(0, 4) + '-01-01', ly = d => this.yearAgo(d);
    return { from, to, includesToday: !!c.bdate && from <= c.bdate && c.bdate <= to, cols: { day: period(from, to), ptd: period(m0, to), lyPtd: period(ly(m0), ly(to)), ytd: period(y0, to), lyYtd: period(ly(y0), ly(to)) } };
  }
  // Reservation Activity: reservations made (created) in the dates, any status. `tz` (optional) is the time zone the dates are read in.
  activity(q, c) {
    const from = isDate(q.from) ? q.from : c.bdate, to = isDate(q.to) && q.to >= from ? q.to : from;
    let fmt = null; try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: q.tz || 'UTC' }); } catch (e) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }); }
    const ST = { reserved: 'R', inhouse: 'I', out: 'O', cancelled: 'C', noshow: 'N' }, PAY = { Card: 'CC', Cash: 'CA', Check: 'CK', 'Direct bill': 'DB' };
    let rows = this.rows('SELECT data FROM res').map(x => JSON.parse(x.data)).filter(r => r.created && (d => d >= from && d <= to)(fmt.format(new Date(r.created))) && (!q.type || r.type === q.type));
    const key = { name: (a, b) => (a.last + a.first).localeCompare(b.last + b.first), created: (a, b) => a.created - b.created, arrive: (a, b) => a.arrive.localeCompare(b.arrive) || a.created - b.created }[q.sort] || ((a, b) => a.arrive.localeCompare(b.arrive) || a.created - b.created);
    rows = rows.sort(key).map(r => ({ id: r.id, conf: r.conf, name: r.last + (r.first ? ', ' + r.first : ''), arrive: r.arrive, depart: r.depart, nights: nightsBetween(r.arrive, r.depart), status: ST[r.status] || '', rate: r.rate != null ? r.rate : (Object.values(r.rates || {})[0] || 0), pkg: r.pkg || '', type: r.type, room: r.room || '', source: r.source || '', pay: PAY[r.payType] || '', created: r.created, user: r.createdBy || '' }));
    return { from, to, rows, count: rows.length, roomNights: rows.filter(r => r.status !== 'C' && r.status !== 'N').reduce((s, r) => s + r.nights, 0) };
  }

  /* ---------- every request comes through here ---------- */
  // req: { method, path, query, body, cookie, ledgerAdmin }  →  { status, json, cookie? }
  handle(req) {
    try { return this.route(req); }
    catch (e) { if (e.code) return { status: e.code, json: { error: e.message } }; return { status: 500, json: { error: 'Something went wrong on the server. ' + String(e && e.message || e).slice(0, 200) } }; }
  }
  route(req) {
    const p = req.path, b = req.body || {}, POST = req.method === 'POST';
    const me = req.me; if (!me || !me.role) throw err(401, 'Please sign in.');
    me.username = clip(me.name || me.email, 60);
    if (!this.kv('config', null)) {   // first visit: make the hotel from its starter setup
      const h = req.hotel || {}, c0 = starterConfig(h.template); c0.name = clip(h.name, 80) || 'My Hotel';
      try { c0.bdate = new Intl.DateTimeFormat('en-CA', { timeZone: h.tz || 'America/New_York' }).format(new Date()); } catch (e) { c0.bdate = new Date().toISOString().slice(0, 10); }
      this.setKv('config', c0);
    }
    const c = this.cfg(), boss = ['owner', 'manager'].includes(me.role), mgr = () => { if (!boss) throw err(403, 'Only the owner or a manager can do that.'); };
    const desk = () => { if (me.role === 'hk') throw err(403, 'Housekeeping logins can only use the housekeeping screen.'); };
    if (p === '/state') return { status: 200, json: this.state(me) };
    if (p === '/folio') { desk(); const r = this.getRes(req.query.id); return { status: 200, json: { res: r, lines: this.rows('SELECT * FROM lines WHERE res=? ORDER BY id', r.id), balance: this.balance(r.id) } }; }
    if (p === '/find') {
      desk(); const q = clip(req.query.q, 60).toUpperCase(); if (q.length < 2) return { status: 200, json: { list: [] } };
      const digits = q.replace(/\D/g, ''), words = '%' + q.replace(/[%_]/g, '') + '%';
      const rows = digits.length >= 3 ? this.rows('SELECT data FROM res WHERE name LIKE ? OR data LIKE ? OR data LIKE ? ORDER BY id DESC LIMIT 60', words, '%"conf":"' + digits + '%', '%' + digits + '%') : this.rows('SELECT data FROM res WHERE name LIKE ? ORDER BY id DESC LIMIT 60', words);
      const list = rows.map(x => { const { history, ...r } = JSON.parse(x.data); return r; }).filter(r => digits.length >= 3 && !/[A-Z]/.test(q) ? r.conf.startsWith(digits) || (r.phone || '').replace(/\D/g, '').includes(digits) : true);
      return { status: 200, json: { list } };
    }
    if (p === '/guest') { desk(); return { status: 200, json: this.guestHistory(req.query) }; }
    if (p === '/member') { desk(); const m = this.member(req.query.id); if (!m) throw err(404, 'That member was not found.'); const rw = c.rewards, t = this.tierOf(rw, m.earned), nx = rw.tiers.find(x => x.min > m.earned) || null;
      return { status: 200, json: { member: { ...m, tier: t.name }, tier: t.name, tierInfo: t, next: nx ? { name: nx.name, min: nx.min, need: nx.min - m.earned } : null, log: m.log } }; }
    if (p === '/members') { desk(); const q = clip(req.query.q, 60).toLowerCase(), dg = digitsOnly(q), all = this.members();
      const hit = m => !q || m.number.toLowerCase().includes(q) || (m.last + ' ' + m.first).toLowerCase().includes(q) || (m.first + ' ' + m.last).toLowerCase().includes(q) || (m.last + ', ' + m.first).toLowerCase().includes(q) || (dg.length >= 3 && digitsOnly(m.phone).includes(dg));
      return { status: 200, json: { list: all.filter(hit).sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first)).slice(0, 100).map(m => this.slimMember(m, c.rewards)) } }; }
    if (p === '/company') { desk(); const co = this.company(req.query.id); if (!co) throw err(404, 'That company was not found.'); return { status: 200, json: { company: co, ledger: this.rows('SELECT * FROM ar WHERE company=? ORDER BY id DESC LIMIT 1000', co.id), balance: this.arBalance(co.id) } }; }
    if (p === '/group') { desk(); const g = this.group(req.query.id); if (!g) throw err(404, 'That group was not found.'); return { status: 200, json: { group: g, members: this.rows('SELECT data FROM res').map(x => JSON.parse(x.data)).filter(r => r.groupId === g.id).map(({ history, ...r }) => ({ ...r, bal: this.balance(r.id) })) } }; }
    if (p === '/report') { desk(); return { status: 200, json: this.report(req.query, c) }; }
    if (p !== '/op' || !POST) throw err(404, 'Not found.');
    const a = b.a || {}, ok = x => ({ status: 200, json: { ok: true, ...(x || {}) } });
    switch (b.op) {
      case 'roomCond': { const rooms = (a.rooms || []).filter(no => c.rooms.some(r => r.no === no)); if (!['R', 'C', 'D'].includes(a.cond)) throw err(400, 'Pick Ready, Clean or Dirty.'); this.setCond(rooms, { cond: a.cond }); this.log(me.username, 'rooms ' + rooms.join(',') + ' → ' + a.cond); return ok(); }
      case 'hkSet': { if (!c.rooms.some(r => r.no === a.room)) throw err(400, 'Room not found.'); const patch = {}; if ('dnd' in a) patch.dnd = !!a.dnd; if ('hk' in a) patch.hk = clip(a.hk, 40); if ('note' in a) patch.note = clip(a.note, 200); this.setCond([a.room], patch); return ok(); }
    }
    desk();
    switch (b.op) {
      case 'resSave': { const r = this.resSave(a, me, c); return ok({ id: r.id, conf: r.conf }); }
      case 'walkIn': { a.id = 0; a.arrive = c.bdate; a.source = a.source || 'Walk-In'; if (!a.room) throw err(400, 'Pick a room for the walk-in.'); this.dnrCheck(a, a); const cond = (this.roomState()[a.room] || {}).cond || 'R'; if (cond === 'D' && !a.dirtyOk) throw err(412, 'Room ' + a.room + ' is dirty. Check in anyway?'); const r = this.resSave(a, me, c); this.checkIn(r, me, c, { dirtyOk: true, dnrDone: true }); return ok({ id: r.id, conf: r.conf }); }
      case 'checkIn': { const r = this.getRes(a.id); if (a.room && a.room !== r.room) { this.resSave({ id: r.id, room: a.room }, me, c); Object.assign(r, this.getRes(r.id)); } this.checkIn(r, me, c, a); return ok(); }
      case 'dnrAdd': { const e = { last: clip(a.last, 60), first: clip(a.first, 60), guestId: clip(a.guestId, 40), phone: clip(a.phone, 30), reason: clip(a.reason, 300) }; if (!e.last && !e.guestId) throw err(400, 'Type the last name or the guest ID.'); if (!e.reason) throw err(400, 'Type the reason.'); e.by = me.username; e.at = now(); e.bdate = c.bdate;
        this.sql.exec('INSERT INTO dnr(data) VALUES(?)', JSON.stringify(e)); const id = this.one('SELECT MAX(id) n FROM dnr').n; this.log(me.username, 'do not rent add ' + (e.last || e.guestId)); return ok({ id }); }
      case 'dnrRemove': { mgr(); const id = Number(a.id) || 0; if (!this.one('SELECT 1 x FROM dnr WHERE id=?', id)) throw err(404, 'That entry was not found.'); this.sql.exec('DELETE FROM dnr WHERE id=?', id); this.log(me.username, 'do not rent remove ' + id); return ok(); }
      case 'undoCheckIn': { const r = this.getRes(a.id); if (r.status !== 'inhouse') throw err(400, 'This guest is not checked in.'); if (this.one('SELECT 1 x FROM lines WHERE res=? AND code=?', r.id, 'RM')) throw err(400, 'Room charges were already posted, so the check-in cannot be undone. Check the guest out instead.'); r.status = 'reserved'; r.history.push({ at: now(), by: me.username, what: 'Check-in undone' }); this.putRes(r); return ok(); }
      case 'checkOut': {
        const r = this.getRes(a.id); if (r.status !== 'inhouse') throw err(400, 'This guest is not checked in.'); const bal = this.balance(r.id);
        if (bal !== 0 && !(a.force && boss)) throw err(412, 'The folio balance is ' + (bal / 100).toFixed(2) + '. Post a payment (or a refund) to bring it to zero before checking out.' + (boss ? ' A manager can check out anyway.' : ''));
        r.status = 'out'; r.coAt = now(); r.coBy = me.username; if (r.depart > c.bdate) { r.origDepart = r.depart; r.depart = c.bdate > r.arrive ? c.bdate : addDays(r.arrive, 1); }
        r.history.push({ at: now(), by: me.username, what: 'Checked out, balance ' + (bal / 100).toFixed(2) }); this.rwEarn(r, me, c); this.putRes(r); this.setCond([r.room], { cond: 'D', dnd: false }); this.log(me.username, 'check out ' + r.conf); return ok();
      }
      case 'undoCheckOut': { const r = this.getRes(a.id); if (r.status !== 'out') throw err(400, 'This guest is not checked out.'); if (r.depart < c.bdate) throw err(400, 'This stay ended before today, so it cannot be reopened.'); if (r.depart <= c.bdate) r.depart = addDays(c.bdate, 1); const pr = this.roomProblem(c, r.room, c.bdate, r.depart, r.id); if (pr) throw err(409, pr); r.status = 'inhouse'; r.history.push({ at: now(), by: me.username, what: 'Check-out undone' }); this.rwUndo(r, me, c); this.putRes(r); return ok(); }
      case 'cancel': { const r = this.getRes(a.id); if (r.status !== 'reserved') throw err(400, 'Only a reservation that is not checked in can be cancelled.'); r.status = 'cancelled'; r.cxlAt = now(); r.cxlNo = 'X' + r.conf; r.cxlReason = clip(a.reason, 200); r.history.push({ at: now(), by: me.username, what: 'Cancelled' + (r.cxlReason ? ': ' + r.cxlReason : '') }); this.putRes(r); this.log(me.username, 'cancel ' + r.conf); return ok({ cxlNo: r.cxlNo }); }
      case 'reinstate': { const r = this.getRes(a.id); if (!['cancelled', 'noshow'].includes(r.status)) throw err(400, 'This reservation is not cancelled.'); if (r.depart <= c.bdate) throw err(400, 'The stay dates have passed.'); if (r.arrive < c.bdate) r.arrive = c.bdate; r.status = 'reserved'; if (r.room && this.roomProblem(c, r.room, r.arrive, r.depart, r.id)) r.room = ''; if (!r.room && this.availOfType(c, r.type, r.arrive, r.depart, r.id) < 1) throw err(409, 'No ' + r.type + ' rooms are left for those dates.'); r.history.push({ at: now(), by: me.username, what: 'Reinstated' }); this.putRes(r); return ok(); }
      case 'noShow': { const r = this.getRes(a.id); if (r.status !== 'reserved' || r.arrive > c.bdate) throw err(400, 'Only today\'s arrivals can be marked as a no show.'); r.status = 'noshow'; r.history.push({ at: now(), by: me.username, what: 'No show' }); this.putRes(r); return ok(); }
      case 'post': return ok(this.post(a, me, c));
      case 'memberSave': { const m = this.memberSave(a, me, c); return ok({ id: m.id, number: m.number }); }
      case 'memberAdjust': { mgr(); const m = this.memberAdjust(a, me, c); return ok({ points: m.points }); }
      case 'memberLink': { const r = this.getRes(a.res); if (!ACTIVE.includes(r.status)) throw err(400, 'This reservation is ' + r.status + '.'); if (!Number(a.member)) throw err(400, 'Pick a member.'); this.linkMember(r, Number(a.member), me, c); this.putRes(r); return ok({ memberId: r.memberId, memberNo: r.memberNo }); }
      case 'memberUnlink': { const r = this.getRes(a.res); if (!ACTIVE.includes(r.status)) throw err(400, 'This reservation is ' + r.status + '.'); this.linkMember(r, 0, me, c); this.putRes(r); return ok(); }
      case 'companySave': {
        const co = a.id ? this.company(a.id) : {}; if (a.id && !co) throw err(404, 'That company was not found.');
        for (const [k, n] of [['name', 80], ['contact', 80], ['phone', 30], ['email', 100], ['address', 200], ['corpId', 30], ['notes', 500]]) if (k in a) co[k] = clip(a[k], n);
        if (!co.name) throw err(400, 'Type the company\'s name.');
        if ('directBill' in a || 'limit' in a || 'rate' in a || 'inactive' in a) { if (('directBill' in a && !!a.directBill !== !!co.directBill || 'limit' in a && (Number(a.limit) || 0) !== (co.limit || 0)) && !boss) throw err(403, 'Only the owner or a manager can change a direct-bill account.'); co.directBill = !!a.directBill; co.limit = Math.max(0, cents(a.limit || 0)); co.rate = Math.max(0, cents(a.rate || 0)); co.inactive = !!a.inactive; }
        const { id, ...data } = co; if (a.id) this.sql.exec('UPDATE companies SET data=? WHERE id=?', JSON.stringify(data), a.id); else this.sql.exec('INSERT INTO companies(data) VALUES(?)', JSON.stringify(data));
        return ok({ id: a.id || this.one('SELECT MAX(id) n FROM companies').n });
      }
      case 'arPay': {   // a company pays its account
        const co = this.company(a.company), k = c.codes.find(x => x.code === a.code); if (!co) throw err(404, 'That company was not found.'); if (!k || !['CASH', 'CRED'].includes(k.type) || ['GR', 'PO'].includes(k.code)) throw err(400, 'Pick how they paid.');
        const amt = cents(a.amount); if (!(amt > 0)) throw err(400, 'Type an amount above zero.'); if (c.requireShift && !boss && !this.openShift(me)) throw err(400, 'Open your cashier shift first (the Shift button at the top).');
        this.sql.exec('INSERT INTO ar(company,res,bdate,at,kind,descr,amount,user) VALUES(?,?,?,?,?,?,?,?)', co.id, 0, c.bdate, now(), 'payment', k.code + ' ' + k.name + (a.comment ? ' · ' + clip(a.comment, 120) : ''), -amt, me.username); this.log(me.username, 'company payment ' + co.name + ' ' + amt); return ok({ balance: this.arBalance(co.id) });
      }
      case 'groupSave': {
        const g = a.id ? this.group(a.id) : { status: 'active', created: now() }; if (a.id && !g) throw err(404, 'That group was not found.');
        for (const [k, n] of [['name', 80], ['contact', 80], ['phone', 30], ['email', 100], ['notes', 500]]) if (k in a) g[k] = clip(a[k], n);
        if (!g.name) throw err(400, 'Type the group\'s name.'); if ('arrive' in a) g.arrive = a.arrive; if ('depart' in a) g.depart = a.depart; if (!isDate(g.arrive) || !isDate(g.depart) || g.depart <= g.arrive) throw err(400, 'Check the group\'s dates.');
        const days = a.cutoffDays === '' || a.cutoffDays == null ? null : Number(a.cutoffDays);
        if ('cutoff' in a) { if (a.cutoff && !isDate(a.cutoff)) throw err(400, 'Check the cut-off date.'); if (a.cutoff && days != null) throw err(400, 'Use a fixed cut-off date or a rolling number of days, not both.'); g.cutoff = a.cutoff || ''; if (a.cutoff && !('cutoffDays' in a)) delete g.cutoffDays; }
        if ('cutoffDays' in a) { if (days == null) delete g.cutoffDays; else { if (!Number.isInteger(days) || days < 0 || days > 365) throw err(400, 'The rolling cut-off must be a whole number of days from 0 to 365.'); g.cutoffDays = days; g.cutoff = ''; } }
        if ('recur' in a) g.recur = this.cleanRecur(a.recur || [], c, { from: g.arrive, to: g.depart });
        if ('companyId' in a) g.companyId = this.company(a.companyId) ? Number(a.companyId) : 0; if ('status' in a) g.status = a.status === 'cancelled' ? 'cancelled' : 'active';
        const num = (o, money) => { const out = {}; for (const t of c.types) { const v = o && o[t.code]; if (v !== '' && v != null && Number(v) > 0) out[t.code] = money ? cents(v) : Math.min(500, Math.round(Number(v))); } return out; };
        if ('blocks' in a) g.blocks = num(a.blocks, false); if ('rates' in a) g.rates = num(a.rates, true);
        if (g.status !== 'cancelled') { const act = this.activeRes(), blks = this.blocks(), others = this.groups().filter(x => x.id !== g.id);   // a block cannot hold more rooms than the hotel has free
          for (const [type, n] of Object.entries(g.blocks || {})) { const rooms = c.rooms.filter(r => r.type === type).map(r => r.no); for (let d = g.arrive > c.bdate ? g.arrive : c.bdate; d < g.depart; d = addDays(d, 1)) { const mine = act.filter(r => r.groupId === g.id && r.type === type && r.arrive <= d && d < r.depart).length, sold = act.filter(r => r.groupId !== g.id && r.type === type && r.arrive <= d && d < r.depart).length, ooo = rooms.filter(no => blks.some(b => b.room === no && b.start <= d && d <= b.end)).length; if (Math.max(n, mine) + sold + ooo + this.groupHold(c, type, d, g.id, act, others) > rooms.length && !a.oversell) throw err(409, 'There are not ' + n + ' ' + type + ' rooms free on ' + d + '. Lower the block.'); } } }
        const { id, ...data } = g; if (a.id) this.sql.exec('UPDATE grps SET data=? WHERE id=?', JSON.stringify(data), a.id); else this.sql.exec('INSERT INTO grps(data) VALUES(?)', JSON.stringify(data));
        return ok({ id: a.id || this.one('SELECT MAX(id) n FROM grps').n });
      }
      case 'shiftOpen': { if (this.openShift(me)) throw err(400, 'Your shift is already open.'); const cash = Math.max(0, cents(a.cash || 0)); this.sql.exec('INSERT INTO shifts(user,open_at,close_at,data) VALUES(?,?,NULL,?)', me.username, now(), JSON.stringify({ openCash: cash, bdate: c.bdate })); this.log(me.username, 'opened shift'); return ok(); }
      case 'shiftPeek': { const sh = this.openShift(me); if (!sh) throw err(400, 'You have no open shift.'); return ok({ shift: sh, ...this.shiftTotals(c, sh) }); }
      case 'shiftClose': { const sh = this.openShift(me); if (!sh) throw err(400, 'You have no open shift.'); const counted = cents(a.counted || 0), t = this.shiftTotals(c, sh), data = { openCash: sh.openCash, bdate: sh.bdate, counted, ...t, overShort: counted - t.expected }; this.sql.exec('UPDATE shifts SET close_at=?, data=? WHERE id=?', now(), JSON.stringify(data), sh.id); this.log(me.username, 'closed shift, over/short ' + data.overShort); return ok({ summary: { user: sh.user, openAt: sh.openAt, closeAt: now(), ...data } }); }
      case 'emailConf': case 'emailFolio': {   // the website sends the e-mail (hotel.js); here we only write it
        const r = this.getRes(a.id); const to = clip(a.to || r.email, 100).toLowerCase(); if (!/^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/.test(to)) throw err(400, 'Type the guest\'s e-mail address in the reservation first.');
        const m = v => (v / 100).toFixed(2), tname = (c.types.find(t => t.code === r.type) || {}).name || r.type, foot = '\n' + c.name + (c.address ? '\n' + c.address : '') + (cityLine(c) ? '\n' + cityLine(c) : '') + (c.phone ? '\n' + c.phone : '') + '\n';
        let subject, text;
        if (b.op === 'emailConf') { const cx = r.status === 'cancelled'; subject = (cx ? 'Cancellation' : 'Reservation confirmation') + ' ' + (cx ? r.cxlNo : r.conf) + ' · ' + c.name;
          text = 'Dear ' + (r.first ? r.first + ' ' : '') + r.last + ',\n\n' + (cx ? 'Your reservation at ' + c.name + ' has been cancelled.\n\nCancellation number: ' + r.cxlNo + '\nOriginal confirmation number: ' + r.conf + '\nDates: ' + r.arrive + ' to ' + r.depart + '\n'
            : 'Thank you for choosing ' + c.name + '. Your reservation is confirmed.\n\nConfirmation number: ' + r.conf + '\nArrival: ' + r.arrive + ' (check-in from ' + t12(c.checkinTime) + ')\nDeparture: ' + r.depart + ' (check-out by ' + t12(c.checkoutTime) + ')\nRoom type: ' + tname + '\nGuests: ' + r.adults + ' adults, ' + (r.children || 0) + ' children\nRate: ' + (r.suppressRate ? 'on file' : m(this.nightRate(r, r.arrive)) + ' plus tax, per night' + (r.rates && new Set(Object.values(r.rates)).size > 1 ? ' (the rate changes by night)' : '')) + '\nGuarantee: ' + (r.guarantee || '') + (policyLines(c).length ? '\n\nHotel Policies:\n' + policyLines(c).join('\n') : '') + '\n\nWe look forward to your stay.\n') + foot; }
        else { const lines = this.rows('SELECT * FROM lines WHERE res=? ORDER BY id', r.id), pad = (x, n) => String(x).padEnd(n).slice(0, n); subject = 'Your folio · ' + c.name + ' · ' + r.conf;
          text = 'Dear ' + (r.first ? r.first + ' ' : '') + r.last + ',\n\nHere is your folio for room ' + (r.room || '') + ', ' + r.arrive + ' to ' + r.depart + ' (confirmation ' + r.conf + ').\n\n' + lines.map(l => pad(l.bdate, 12) + pad(l.descr, 28) + m(l.amount).padStart(10)).join('\n') + '\n' + pad('', 12) + pad('Balance', 28) + m(this.balance(r.id)).padStart(10) + '\n\nThank you for staying with us.\n' + foot; }
        r.history.push({ at: now(), by: me.username, what: (b.op === 'emailConf' ? 'E-mailed confirmation to ' : 'E-mailed folio to ') + to }); r.history = r.history.slice(-60); this.putRes(r);
        return { status: 200, json: { ok: true, to }, mail: { to, subject, text, fromName: c.name } };
      }
      case 'history': return ok({ history: this.getRes(a.id).history || [] });
      case 'blockAdd': { if (!c.rooms.some(r => r.no === a.room)) throw err(400, 'Room not found.'); if (!isDate(a.start) || !isDate(a.end) || a.end < a.start) throw err(400, 'Check the dates.'); const clash = this.activeRes().find(r => r.room === a.room && r.arrive <= a.end && a.start < r.depart); if (clash) throw err(409, 'Room ' + a.room + ' has ' + clash.last + ', ' + clash.first + ' in it for those dates. Move the guest first.'); this.sql.exec('INSERT INTO blocks(room,start,end,reason) VALUES(?,?,?,?)', a.room, a.start, a.end, clip(a.reason, 120)); this.log(me.username, 'out of order ' + a.room); return ok(); }
      case 'blockAddMany': {
        const rooms = [...new Set(Array.isArray(a.rooms) ? a.rooms.map(x => String(x)) : [])]; if (!rooms.length) throw err(400, 'Pick at least one room.'); if (rooms.length > 300) throw err(400, 'Too many rooms at once.');
        const bad = rooms.filter(no => !c.rooms.some(r => r.no === no)); if (bad.length) throw err(400, 'Room not found: ' + bad.join(', ') + '.'); if (!isDate(a.start) || !isDate(a.end) || a.end < a.start) throw err(400, 'Check the dates.');
        const act = this.activeRes(), busy = rooms.filter(no => act.some(r => r.room === no && r.arrive <= a.end && a.start < r.depart));
        if (busy.length) return { status: 409, json: { error: 'These rooms have a guest or reservation in those dates, so nothing was blocked: ' + busy.join(', ') + '. Move the guests first.', rooms: busy } };
        for (const no of rooms) this.sql.exec('INSERT INTO blocks(room,start,end,reason) VALUES(?,?,?,?)', no, a.start, a.end, clip(a.reason, 120)); this.log(me.username, 'out of order ' + rooms.length + ' rooms'); return ok({ added: rooms.length });
      }
      case 'recurAdd': {
        const r = this.getRes(a.id); if (!ACTIVE.includes(r.status)) throw err(400, 'This reservation is ' + r.status + '.'); if ((r.recur || []).length >= 10) throw err(400, 'At most 10 recurring charges.');
        r.recur = (r.recur || []).concat(this.cleanRecur([{ code: a.code, amount: a.amount, comment: a.comment, from: a.from, to: a.to }], c, { from: r.arrive, to: r.depart }));
        r.history.push({ at: now(), by: me.username, what: 'Recurring charge added: ' + r.recur.at(-1).code + ' ' + (r.recur.at(-1).amount / 100).toFixed(2) }); this.putRes(r); return ok({ recur: r.recur });
      }
      case 'recurRemove': {
        const r = this.getRes(a.id), i = Number(a.index); if (!Number.isInteger(i) || !(r.recur || [])[i]) throw err(404, 'That recurring charge was not found.'); const x = r.recur.splice(i, 1)[0];
        r.history.push({ at: now(), by: me.username, what: 'Recurring charge removed: ' + x.code + ' ' + (x.amount / 100).toFixed(2) }); this.putRes(r); return ok({ recur: r.recur });
      }
      case 'optimize': {
        const date = isDate(a.date) ? a.date : c.bdate, plan = this.optimizePlan(c, date); let assigned = 0;
        if (a.apply) for (const x of plan) if (x.room) { const r = this.getRes(x.id); if (r.status !== 'reserved' || r.room) continue; r.room = x.room; r.history.push({ at: now(), by: me.username, what: 'Room assigned by optimizer' }); r.history = r.history.slice(-60); this.putRes(r); assigned++; }
        if (a.apply) this.log(me.username, 'optimizer assigned ' + assigned + ' rooms for ' + date);
        return ok({ date, plan, assigned });
      }
      case 'groupImport': {
        const g = this.group(a.id); if (!g) throw err(404, 'That group was not found.'); if (g.status === 'cancelled') throw err(400, 'That group is cancelled.');
        const rows = Array.isArray(a.rows) ? a.rows : []; if (!rows.length) throw err(400, 'There are no lines to import.'); if (rows.length > 200) throw err(400, 'At most 200 lines at a time.');
        const fix = d => { const s = String(d || '').trim(), m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); return m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : s; };
        const firstType = (c.types.find(t => (g.blocks || {})[t.code]) || c.types[0]).code, problems = []; let created = 0; const ids = [];
        rows.forEach((row, i) => {
          const line = Number(row && row.line) || i + 1, name = row ? (clip(row.last, 60) + (row.first ? ', ' + clip(row.first, 60) : '')) : '';
          try {
            if (!row || !clip(row.last, 60)) throw err(400, 'Type the guest\'s last name.');
            const type = clip(row.type, 8).toUpperCase() || firstType; if (!c.types.some(t => t.code === type)) throw err(400, 'Unknown room type ' + type + '.');
            const arrive = row.arrive ? fix(row.arrive) : (g.arrive > c.bdate ? g.arrive : c.bdate), depart = row.depart ? fix(row.depart) : g.depart; if (!isDate(arrive) || !isDate(depart)) throw err(400, 'Check the dates.');
            const r = this.resSave({ last: row.last, first: row.first || '', type, arrive, depart, adults: row.adults || 1, phone: row.phone || '', email: row.email || '', groupId: g.id, source: 'Phone', guarantee: 'Credit card' }, me, c);
            created++; ids.push(r.id);
          } catch (e) { if (!e.code) throw e; problems.push({ line, name, error: e.message }); }
        });
        this.log(me.username, 'group import ' + g.name + ': ' + created + ' created, ' + problems.length + ' problems'); return ok({ created, problems, ids });
      }
      case 'blockRemove': { this.sql.exec('DELETE FROM blocks WHERE id=?', Number(a.id) || 0); return ok(); }
      case 'nightAudit': { mgr(); if (a.date !== c.bdate) throw err(409, 'The business date changed. Reload and try again.'); return ok({ audit: this.nightAudit(me, c) }); }
      case 'configSave': {
        mgr(); const n = a.config || {};
        for (const [k, len] of [['name', 80], ['address', 200], ['phone', 40], ['checkoutTime', 10], ['checkinTime', 10], ['regText', 1500], ['gm', 60], ['city', 60], ['state', 30], ['zip', 15], ['resPhone', 40], ['fax', 40], ['taxId', 30]]) if (k in n) c[k] = clip(n[k], len);
        if (Array.isArray(n.types)) { c.types = n.types.map(t => ({ code: clip(t.code, 8).toUpperCase(), name: clip(t.name, 60), rate: cents(t.rate) })).filter(t => t.code); if (!c.types.length) throw err(400, 'Keep at least one room type.'); }
        if (Array.isArray(n.rooms)) { const seen = new Set(); c.rooms = n.rooms.map(r => { const old = c.rooms.find(x => x.no === clip(r.no, 8)) || {}, fl = k => k in r ? !!r[k] : !!old[k]; return { no: clip(r.no, 8), type: clip(r.type, 8).toUpperCase(), floor: clip(r.floor, 4), nosmoke: fl('nosmoke'), accessible: fl('accessible'), rentLast: fl('rentLast') }; }).filter(r => r.no && !seen.has(r.no) && seen.add(r.no)); for (const r of c.rooms) if (!c.types.some(t => t.code === r.type)) throw err(400, 'Room ' + r.no + ' has an unknown room type (' + r.type + ').'); for (const r of this.activeRes()) if (r.room && !seen.has(r.room)) throw err(409, 'Room ' + r.room + ' has a guest or reservation, so it cannot be removed.'); }
        if (Array.isArray(n.taxes)) c.taxes = n.taxes.map(t => ({ code: clip(t.code, 6).toUpperCase(), name: clip(t.name, 60), pct: Math.max(0, Math.min(50, Number(t.pct) || 0)) })).filter(t => t.code);
        if (Array.isArray(n.codes)) { c.codes = n.codes.map(k => ({ code: clip(k.code, 8).toUpperCase(), name: clip(k.name, 60), type: clip(k.type, 8).toUpperCase(), tax: (k.tax || []).filter(x => c.taxes.some(t => t.code === x)) })).filter(k => k.code); for (const k of c.codes) if (!CODE_TYPES.includes(k.type)) throw err(400, 'The posting code ' + k.code + ' has an unknown type (' + k.type + ').'); if (!c.codes.some(k => k.code === 'RM')) throw err(400, 'Keep the RM (Room Charge) code. The night audit needs it.'); }
        if (Array.isArray(n.packages)) c.packages = n.packages.map(k => ({ code: clip(k.code, 8).toUpperCase(), name: clip(k.name, 60), price: Math.max(0, cents(k.price || 0)), charge: clip(k.charge, 8).toUpperCase() || 'MS' })).filter(k => k.code).slice(0, 50);
        if (Array.isArray(n.rateRules)) { c.rateRules = n.rateRules.map(k => ({ name: clip(k.name, 40), from: k.from, to: k.to, days: (k.days || []).map(Number).filter(x => x >= 0 && x <= 6), type: clip(k.type, 8).toUpperCase() || '*', rate: cents(k.rate) })).slice(0, 300); for (const k of c.rateRules) { if (!isDate(k.from) || !isDate(k.to) || k.to < k.from) throw err(400, 'Check the dates on the rate line "' + k.name + '".'); if (k.type !== '*' && !c.types.some(t => t.code === k.type)) throw err(400, 'The rate line "' + k.name + '" has an unknown room type (' + k.type + ').'); if (!(k.rate >= 0)) throw err(400, 'Check the rate on the line "' + k.name + '".'); } }
        if ('policies' in n) c.policies = this.cleanPolicies(n.policies);
        for (const r of c.rooms) if (!c.types.some(t => t.code === r.type)) throw err(400, 'Room type ' + r.type + ' is still used by room ' + r.no + '. Move or remove those rooms first.');
        if ('requireShift' in n) c.requireShift = !!n.requireShift;
        if ('quickLinks' in n) { if (n.quickLinks == null || (Array.isArray(n.quickLinks) && !n.quickLinks.length)) delete c.quickLinks; else { if (!Array.isArray(n.quickLinks)) throw err(400, 'The quick links must be a list.'); const keys = [...new Set(n.quickLinks.map(x => clip(x, 30)).filter(x => /^[a-z0-9_]+$/i.test(x)))]; if (keys.length > 14) throw err(400, 'At most 14 quick links.'); c.quickLinks = keys; } }
        if (Array.isArray(n.housekeepers)) c.housekeepers = n.housekeepers.map(x => clip(x, 40)).filter(Boolean).slice(0, 40);
        if ('rewards' in n) c.rewards = this.cleanRewards(n.rewards, c.rewards);
        if (c.rewards.enabled && !c.codes.some(k => k.code === 'RW')) c.codes.push({ code: 'RW', name: 'Rewards Redemption', type: 'GFTCRD', tax: [] });
        this.setKv('config', c); this.log(me.username, 'changed setup'); return ok();
      }
    }
    throw err(400, 'Unknown action.');
  }
}
