/* Ledger Desk AI Assistant › Chat: ask questions OR tell it what to do with transactions.
   "delete all transactions that say TRANSFER FROM A S HOTEL", "move all VECTREN to Utilities", "ignore everything from BANK OF AMERICA",
   "set store for STAPLES to Store 2", "rename SQ *JOES COFFEE to Joe's Coffee", "restore the ignored ones that say ...".
   The request is read here in the browser (exact, no guessing), the matching transactions are listed first,
   and nothing changes until the owner clicks the button. Delete and Ignore can be undone right after. */
(function () {
  'use strict';
  const L = window.ledgerDeskApp;
  if (!L || !L.viewState.ai) return;
  const { acts, esc, money, usDate, acc } = L;
  const ST = L.viewState.ai, S = () => L.S;
  const TASKS = ST.tasks = {};
  const norm = s => String(s || '').toUpperCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const pad = n => String(n).padStart(2, '0');
  const lastDay = (y, m) => new Date(y, m, 0).getDate();

  // ---------------- reading the request ----------------
  const ACTIONS = [
    ['rename', /^(rename|change the (payee )?name of|call)\b/i],
    ['delete', /^(delete|remove|erase|get rid of|take out|wipe)\b/i],
    ['restore', /^(restore|unignore|un-ignore|bring back|unhide|un-hide)\b/i],
    ['ignore', /^(ignore|hide|exclude|skip)\b/i],
    ['store', /^(set|change|put|move|assign|tag)\b.*\bstore\b/i],
    ['cat', /^(move|categori[sz]e|re-?categori[sz]e|recategori[sz]e|change|put|set|mark|classify|book|switch|reclassify|assign)\b/i]
  ];
  function clean(q) {
    let t = String(q || '').trim().replace(/[?.!]+$/, '');
    for (let i = 0; i < 3; i++) t = t.replace(/^(hey|ok|okay|so|please|pls|can you|could you|would you|will you|can u|i want you to|i want to|i need you to|i need to|i'd like you to|i would like you to|go ahead and|you can|let's|lets)\b[ ,]*/i, '').trim();
    return t;
  }
  const isQuestion = t => /^(how|what|when|why|which|who|whom|whose|is|are|was|were|do|does|did|show me how|tell me)\b/i.test(t) && !/^(what|which) (ones|transactions)\b.*\b(delete|remove)/i.test(t);
  function findCategory(name) {
    const n = norm(name).replace(/^(THE|A|AN) /, '').replace(/ (CATEGORY|ACCOUNT)$/, '');
    if (!n) return null;
    const list = S().accounts.filter(a => !a.archived);
    const exact = list.find(a => norm(a.name) === n); if (exact) return exact;
    const starts = list.filter(a => norm(a.name).startsWith(n)); if (starts.length === 1) return starts[0];
    const inside = list.filter(a => norm(a.name).includes(n) || (n.length > 5 && n.includes(norm(a.name)))); if (inside.length === 1) return inside[0];
    const words = n.split(' ').filter(w => w.length > 2), scored = list.map(a => ({ a, s: words.filter(w => norm(a.name).includes(w)).length })).filter(x => x.s).sort((x, y) => y.s - x.s);
    return scored.length && scored[0].s === words.length && (scored.length === 1 || scored[1].s < scored[0].s) ? scored[0].a : null;
  }
  function findStore(name) {
    const n = norm(name).replace(/^(THE) /, ''); const list = L.stores ? L.stores() : [];
    return list.find(s => norm(s.name) === n) || (list.filter(s => norm(s.name).includes(n)).length === 1 ? list.find(s => norm(s.name).includes(n)) : null) || list.find(s => n.includes(norm(s.name))) || null;
  }
  // dates: "in september", "for 2026", "last month", "this year"
  function takeDates(t) {
    let from = '', to = '', label = '';
    const now = new Date(), Y = now.getFullYear();
    const re = /\b(in|for|during|from)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)(\s+(20\d\d))?\b/i;
    let m = re.exec(t);
    if (m) { const mi = MONTHS.indexOf(m[2].toLowerCase()), y = m[4] ? +m[4] : (mi <= now.getMonth() ? Y : Y - 1); from = `${y}-${pad(mi + 1)}-01`; to = `${y}-${pad(mi + 1)}-${lastDay(y, mi + 1)}`; label = m[2] + ' ' + y; t = t.replace(m[0], ' '); }
    else if ((m = /\b(in|for|during)\s+(20\d\d)\b/i.exec(t))) { from = m[2] + '-01-01'; to = m[2] + '-12-31'; label = m[2]; t = t.replace(m[0], ' '); }
    else if ((m = /\b(last|this) (month|year)\b/i.exec(t))) {
      const last = m[1].toLowerCase() === 'last';
      if (m[2].toLowerCase() === 'month') { const d = new Date(Y, now.getMonth() - (last ? 1 : 0), 1); from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; to = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${lastDay(d.getFullYear(), d.getMonth() + 1)}`; }
      else { const y = last ? Y - 1 : Y; from = y + '-01-01'; to = y + '-12-31'; }
      label = m[0]; t = t.replace(m[0], ' ');
    }
    return { t: t.replace(/\s+/g, ' ').trim(), from, to, label };
  }
  // account: "on Amex", "in Field & Main Checking", "from the 0053 account"
  function takeAccount(t) {
    const regs = S().accounts.filter(a => (a.type === 'asset' || a.type === 'liability') && !a.archived);
    const m = /\s+(?:on|in|from|at)\s+(?:the|my|our)?\s*([^,]+?)(?:\s+(?:account|card|bank))?$/i.exec(t);
    if (!m) return { t, account: null };
    const want = norm(m[1]), digits = (want.match(/\d{4}/) || [])[0];
    const hit = regs.filter(a => norm(a.name) === want || norm(a.name).includes(want) || (digits && a.name.includes(digits)));
    return hit.length === 1 ? { t: t.slice(0, m.index).trim(), account: hit[0] } : { t, account: null };
  }
  // exact = the words the owner quoted or said ("that says ..."): used as typed, nothing trimmed off the front
  function filterText(t) {
    let m = /["“”]([^"“”]{2,})["“”]/.exec(t) || /(?:^|\s)'([^']{2,})'(?:\s|$)/.exec(t);
    if (m) return { text: m[1], exact: true };
    m = /\b(?:that|which|where (?:the )?(?:payee|memo|description))?\s*(?:say|says|said|show|shows|contain|contains|containing|has|have|read|reads|match|matches|matching|with|called|named|labeled|labelled|like)\s+(.+)$/i.exec(t);
    if (m) return { text: m[1], exact: true };
    m = /\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+(?:transactions?|trasn?actions?|trasctions?|transcations?|charges?|payments?|deposits?|entries|items|ones|lines))?$/i.exec(t);
    if (m) return { text: m[1] };
    m = /\b(?:from|for|to|by)\s+(.+)$/i.exec(t);
    return { text: m ? m[1] : t };
  }
  function stripNoise(s) {
    return String(s || '').replace(/^(the|all|every|each|of|my|our)\s+/ig, '').replace(/^(transactions?|trasn?actions?|trasctions?|transcations?|charges?|payments?|deposits?|entries|ones)\s+/i, '')
      .replace(/\s+(transactions?|trasn?actions?|trasctions?|transcations?|charges?|payments?|deposits?|entries|ones)$/i, '').replace(/^(that|which)\s+(say|says|contain|contains)\s+/i, '').replace(/^["“”']|["“”']$/g, '').trim();
  }
  function parse(q) {
    let t = clean(q);
    if (!t || isQuestion(t)) return null;
    let act = ACTIONS.find(([, re]) => re.test(t)); if (!act) return null;
    // "move X to Store 2" is a store change only when the end really is a store
    if (act[0] === 'store' && !(L.stores && L.stores().some(s => norm(t).includes(norm(s.name)))) && !/\bno store\b/i.test(t)) act = ACTIONS.find(a => a[0] === 'cat');
    const action = act[0];
    t = t.replace(action === 'store' ? /^(set|change|put|move|assign|tag)\b/i : act[1], '').trim();
    const d = takeDates(t); t = d.t;
    let target = null, targetText = '';
    if (action === 'cat' || action === 'store' || action === 'rename') {
      // the LAST " to | as | under | into " whose remainder is a category / store / new name
      const re = /\s(?:to|as|under|into|in)\s+(?:the\s+)?/gi; let m, best = null;
      while ((m = re.exec(t))) {
        const rest = t.slice(m.index + m[0].length).replace(/\s+(category|account|store)$/i, '').trim();
        const found = action === 'cat' ? findCategory(rest) : action === 'store' ? (/^no store$/i.test(rest) ? { id: '', name: 'no store' } : findStore(rest)) : rest ? { name: rest } : null;
        if (found) best = { at: m.index, found, rest };
      }
      if (!best) return { action, error: action === 'cat' ? 'which category to use' : action === 'store' ? 'which store to use' : 'the new name' };
      target = best.found; targetText = best.rest; t = t.slice(0, best.at).trim();
      if (action === 'store') t = t.replace(/\b(the\s+)?store\s+(for|of)\s+/i, '').replace(/\bstore\b/i, '').trim();
    }
    const a = takeAccount(t); t = a.t;
    const ft = filterText(t), text = ft.exact ? ft.text.replace(/^["“”']|["“”']$/g, '').trim() : stripNoise(ft.text);
    if (!text || /^(everything|all|them|these|those|it)$/i.test(text)) return { action, error: 'which transactions (for example: that say "VECTREN")' };
    return { action, text, target, targetText, from: d.from, to: d.to, dateLabel: d.label, account: a.account };
  }

  // ---------------- finding the transactions ----------------
  function matches(p) {
    const needle = norm(p.text), words = needle.split(' ').filter(w => w.length > 1);
    const pool = S().txns.filter(t => (p.action === 'restore' ? t.ignored : !t.ignored) && (!p.from || t.date >= p.from) && (!p.to || t.date <= p.to) && (!p.account || t.accountId === p.account.id || t.categoryId === p.account.id));
    const hay = t => norm(t.payee + ' ' + (t.memo || '') + ' ' + (t.origPayee || ''));
    let hits = pool.filter(t => hay(t).includes(needle)), loose = false;
    if (!hits.length && words.length > 1) { hits = pool.filter(t => words.every(w => hay(t).includes(w))); loose = hits.length > 0; }
    return { hits: hits.sort((x, y) => y.date.localeCompare(x.date)), loose };
  }
  const WHAT = { delete: 'Delete', ignore: 'Ignore', restore: 'Restore', cat: 'Change the category', store: 'Set the store', rename: 'Rename' };
  function describe(p) {
    const f = `that say <b>${esc(p.text)}</b>${p.account ? ' on <b>' + esc(p.account.name) + '</b>' : ''}${p.dateLabel ? ' in <b>' + esc(p.dateLabel) + '</b>' : ''}`;
    if (p.action === 'cat') return { ask: `Move them to <b>${esc(p.target.name)}</b>?`, btn: 'Move ' + '{n}' + ' to ' + p.target.name, f };
    if (p.action === 'store') return { ask: p.target.id ? `Set their store to <b>${esc(p.target.name)}</b>?` : 'Take them out of any store (back to the account\'s store)?', btn: 'Set store for {n}', f };
    if (p.action === 'rename') return { ask: `Rename the payee to <b>${esc(p.target.name)}</b>?`, btn: 'Rename {n}', f };
    if (p.action === 'delete') return { ask: 'Delete them?', btn: 'Delete {n}', f };
    if (p.action === 'ignore') return { ask: 'Ignore them? They stay on file but are left out of balances and reports.', btn: 'Ignore {n}', f };
    return { ask: 'Bring them back into balances and reports?', btn: 'Restore {n}', f };
  }
  function card(p, hits, loose) {
    const id = 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ids = hits.map(t => t.id), out = hits.filter(t => t.amount < 0).reduce((a, t) => a - t.amount, 0), inn = hits.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0);
    TASKS[id] = { p, ids, done: false };
    const d = describe(p), accts = Array.from(new Set(hits.map(t => (acc(t.accountId) || {}).name).filter(Boolean)));
    const fromStmt = hits.filter(t => t.source === 'qbo' || t.source === 'pdf');
    const matched = hits.filter(t => t.transferWith || t.matchOf);
    let warn = '';
    if ((p.action === 'delete' || p.action === 'ignore') && fromStmt.length) warn = `⚠️ ${fromStmt.length + ' of these'} came from your bank or card statements (${esc(accts.join(', '))}). ${p.action === 'delete' ? 'Deleting' : 'Ignoring'} them makes those account balances stop matching the statements. ${hits.every(t => { const c = acc(t.categoryId); return c && (c.type === 'equity' || c.type === 'asset' || c.type === 'liability'); }) ? ' They\'re already off the Profit &amp; Loss (they\'re under ' + esc(Array.from(new Set(hits.map(t => acc(t.categoryId).name))).join(', ')) + ').' : ' If you only want them off the Profit &amp; Loss, move them to a transfers or owner\'s draw category instead.'}`;
    if (p.action === 'cat') { const blocked = hits.filter(t => !L.allowedCat(t, p.target.id)); if (blocked.length) warn = `${blocked.length + ' of these'} can't go under ${esc(p.target.name)} (money coming into a bank or card is never income) and will be skipped.`; }
    if (matched.length && p.action !== 'delete' && p.action !== 'restore') warn += (warn ? '<br>' : '') + `${matched.length + ' of these'} ${matched.length === 1 ? 'is a matched card payment or transfer' : 'are matched card payments or transfers'}; changing them unmatches them.`;
    const list = hits.slice(0, 8).map(t => `<tr><td class="num small">${usDate(t.date)}</td><td>${esc(t.payee)}${t.memo && norm(t.memo) !== norm(t.payee) ? `<div class="memo">${esc(t.memo.slice(0, 70))}</div>` : ''}</td><td class="small">${esc((acc(t.accountId) || {}).name || '')}</td><td class="small">${esc(L.isUncat(t) ? 'Uncategorized' : (acc(t.categoryId) || {}).name || '')}</td><td class="num">${money(t.amount)}</td></tr>`).join('');
    const html = `I found <b>${plural(hits.length, 'transaction')}</b> ${d.f}${loose ? ' (they have all those words, not the exact phrase)' : ''}: ${money(out)} out, ${money(inn)} in${hits.length ? ', ' + usDate(hits[hits.length - 1].date) + ' – ' + usDate(hits[0].date) : ''}.
      <div class="table-wrap" style="margin:8px 0;max-height:260px;overflow:auto"><table><tbody>${list}</tbody></table></div>${hits.length > 8 ? `<div class="small muted">…and ${hits.length - 8} more. <button class="link" data-act="taskShow" data-k="${id}">See them all on Transactions</button></div>` : ''}
      ${warn ? `<div class="small" style="background:var(--warn-soft);padding:6px 8px;border-radius:6px;margin:6px 0">${warn}</div>` : ''}
      <div style="margin-top:6px">${d.ask}</div>
      <div class="bk-btns" data-k="${id}"><button class="btn sm ${p.action === 'delete' ? 'danger' : 'primary'}" data-act="taskGo" data-k="${id}">${esc(d.btn.replace('{n}', plural(hits.length, 'transaction')))}</button><button class="btn sm" data-act="taskNo" data-k="${id}">Cancel</button></div>`;
    return { id, html, text: `Found ${hits.length} transactions that say ${p.text}. ${WHAT[p.action]}?` };
  }
  function say(html, text, err) { ST.chat.push({ role: 'assistant', html, text: text || html.replace(/<[^>]+>/g, ''), err: !!err }); }
  function scrollChat() { setTimeout(() => { const c = document.querySelector('#chat'); if (c) c.scrollTop = c.scrollHeight; }, 30); }

  function handle(q) {
    const p = parse(q); if (!p) return false;
    ST.chat.push({ role: 'user', text: q });
    if (p.error) {
      say(`I can do that, but I couldn't tell ${esc(p.error)}. Try it like this:<br>• <i>delete all transactions that say "TRANSFER FROM A S HOTEL"</i><br>• <i>move all that say VECTREN to Utilities</i><br>• <i>ignore everything that says BANK OF AMERICA in September</i><br>• <i>set the store for STAPLES to Store 2</i>`);
    } else {
      const { hits, loose } = matches(p);
      if (!hits.length) say(`I didn't find any ${p.action === 'restore' ? 'ignored ' : ''}transactions that say <b>${esc(p.text)}</b>${p.account ? ' on ' + esc(p.account.name) : ''}${p.dateLabel ? ' in ' + esc(p.dateLabel) : ''} in ${esc(S().company)}. Check the spelling, or search for it on Transactions.`);
      else { const c = card(p, hits, loose); ST.chat.push({ role: 'assistant', html: c.html, text: c.text, task: c.id }); }
    }
    L.render(); scrollChat();
    return true;
  }
  // ---------------- doing it (only after the owner clicks) ----------------
  // once answered, the buttons on that card go away
  function closeCard(id) { const m = ST.chat.find(x => x.task === id); if (m) m.html = m.html.replace(new RegExp('<div class="bk-btns" data-k="' + id + '">[\\s\\S]*?</div>'), ''); }
  acts.taskNo = b => { const k = TASKS[b.dataset.k]; if (!k || k.done) return; k.done = true; closeCard(b.dataset.k); say('OK, nothing was changed.'); L.render(); scrollChat(); };
  acts.taskShow = b => { const k = TASKS[b.dataset.k]; if (!k) return; Object.assign(L.viewState.register, { acct: 'all', q: k.p.text, range: 'all', from: '', to: '', uncat: false, showIgn: k.p.action === 'restore' }); L.go('register'); };
  acts.taskGo = b => {
    const k = TASKS[b.dataset.k]; if (!k || k.done) return; k.done = true; closeCard(b.dataset.k);
    const p = k.p, set = new Set(k.ids), txns = S().txns.filter(t => set.has(t.id));
    let n = 0, skipped = 0, extra = '';
    if (p.action === 'delete') { n = txns.length; L.deleteTxns(k.ids); extra = ' Use <b>Undo</b> on the message at the bottom of the screen if that was a mistake.'; }
    else if (p.action === 'ignore') { n = txns.length; L.ignoreTxns(k.ids, true); extra = ' They\'re still on file: tick "Show ignored" on Transactions to see them, or tell me "restore the ones that say ' + esc(p.text) + '".'; }
    else if (p.action === 'restore') { n = txns.length; L.ignoreTxns(k.ids, false); }
    else {
      txns.forEach(t => {
        if (p.action === 'cat') {
          if (!L.allowedCat(t, p.target.id)) { skipped++; return; }
          if (t.transferWith) { const h = S().txns.find(x => x.id === t.transferWith); if (h) { delete h.matchOf; h.ignored = false; } delete t.transferWith; }
          t.categoryId = p.target.id; t.why = 'You told the AI Assistant'; n++;
        } else if (p.action === 'store') { if (p.target.id) t.store = p.target.id; else delete t.store; n++; }
        else if (p.action === 'rename') { if (!t.origPayee) t.origPayee = t.payee; t.payee = p.target.name.slice(0, 120); n++; }
      });
      L.save(); L.updateBadge();
      if (p.action === 'cat' || p.action === 'store') extra = ` <button class="link" data-act="taskRule" data-k="${b.dataset.k}">Do this automatically for new ones too (make a Bank Rule)</button>`;
    }
    say(`Done: ${plural(n, 'transaction')} ${{ delete: 'deleted', ignore: 'ignored', restore: 'restored', cat: 'moved to ' + esc((p.target || {}).name), store: p.target && p.target.id ? 'set to ' + esc(p.target.name) : 'set back to their account\'s store', rename: 'renamed to ' + esc((p.target || {}).name) }[p.action]}.${skipped ? ' ' + skipped + (skipped === 1 ? ' was' : ' were') + ' skipped.' : ''}${extra}`);
    L.render(); scrollChat();
  };
  acts.taskRule = b => {
    const k = TASKS[b.dataset.k]; if (!k || k.ruled) return; k.ruled = true;
    const p = k.p, match = p.text.slice(0, 60);
    const r = { id: L.uid(), match, sign: 'any', categoryId: p.action === 'cat' ? p.target.id : '', rename: '' };
    if (p.action === 'store') { const t = S().txns.find(x => x.id === k.ids[0]); r.categoryId = t ? t.categoryId : ''; if (p.target.id) r.store = p.target.id; }
    if (!r.categoryId) { say('I couldn\'t make that rule: a Bank Rule needs a category. Make it under Bank Rules.'); L.render(); return; }
    S().rules.push(r); L.save();
    say(`Bank Rule made: transactions that say <b>${esc(match)}</b> → <b>${esc((acc(r.categoryId) || {}).name || '')}</b>${r.store ? ' · store ' + esc(L.storeName(r.store)) : ''}. It runs on every import.`);
    L.render(); scrollChat();
  };

  // ---------------- hook into the chat ----------------
  const baseAsk = acts.aiAsk, baseEx = acts.aiEx;
  acts.aiAsk = () => { const el = document.querySelector('#askQ'); const q = el ? el.value : ''; if (handle(q)) { if (el) el.value = ''; return; } baseAsk(); };
  acts.aiEx = b => { if (!handle(b.textContent)) baseEx(b); };
  window.LedgerTasks = { parse };   // for tests
})();
