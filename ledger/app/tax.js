/* Ledger Desk: Taxes. Maps each category to the line it goes on (Form 1065, 1120-S, Schedule C or 1120), totals the year
   for the accountant, flags things that matter at tax time, and lists ways to save. The AI gets the same tax guide,
   so it sorts with taxes in mind and can answer tax questions. It's guidance for talking with your tax preparer,
   not tax advice. Figures checked October 2026. */
(function () {
  'use strict';
  const L = window.ledgerDeskApp, SV = window.ledgerServer;
  if (!L) return;
  const { C, views, acts, afterRender, esc, money, toast, acc } = L;
  const S = () => L.S, $ = s => document.querySelector(s);
  const VS = L.viewState.taxes = { year: String(new Date().getFullYear()), tab: 'lines', ai: null, aiBusy: false };

  // ---------------- tax lines ----------------
  const FORMS = { '1065': 'Form 1065 (partnership: LLC with 2+ owners)', '1120S': 'Form 1120-S (S corporation)', 'SchC': 'Schedule C (single owner)', '1120': 'Form 1120 (C corporation)' };
  // bucket: [Schedule C, 1065, 1120-S, 1120]  ('' = falls under Other deductions / Other expenses)
  const B = {
    income: ['Gross receipts or sales', 'Gross receipts or sales', 'Gross receipts or sales', 'Gross receipts or sales'],
    otherincome: ['Other income', 'Other income', 'Other income', 'Other income'],
    cogs: ['Cost of goods sold', 'Cost of goods sold', 'Cost of goods sold', 'Cost of goods sold'],
    wages: ['Wages', 'Salaries and wages', 'Salaries and wages', 'Salaries and wages'],
    officers: ['Wages', 'Guaranteed payments to partners', 'Compensation of officers', 'Compensation of officers'],
    repairs: ['Repairs and maintenance', 'Repairs and maintenance', 'Repairs and maintenance', 'Repairs and maintenance'],
    baddebt: ['Other expenses', 'Bad debts', 'Bad debts', 'Bad debts'],
    rent: ['Rent: other business property', 'Rent', 'Rents', 'Rents'],
    taxes: ['Taxes and licenses', 'Taxes and licenses', 'Taxes and licenses', 'Taxes and licenses'],
    interest: ['Interest (other)', 'Interest', 'Interest', 'Interest'],
    depreciation: ['Depreciation', 'Depreciation', 'Depreciation', 'Depreciation'],
    retirement: ['Pension and profit-sharing plans', 'Retirement plans', 'Pension, profit-sharing plans', 'Pension, profit-sharing plans'],
    benefits: ['Employee benefit programs', 'Employee benefit programs', 'Employee benefit programs', 'Employee benefit programs'],
    advertising: ['Advertising', '', 'Advertising', 'Advertising'],
    auto: ['Car and truck expenses', '', '', ''],
    commissions: ['Commissions and fees', '', '', ''],
    contract: ['Contract labor', '', '', ''],
    insurance: ['Insurance (other than health)', '', '', ''],
    legal: ['Legal and professional services', '', '', ''],
    office: ['Office expense', '', '', ''],
    supplies: ['Supplies', '', '', ''],
    travel: ['Travel', '', '', ''],
    meals50: ['Deductible meals (50%)', '', '', ''],
    meals0: ['Not deductible', 'Not deductible', 'Not deductible', 'Not deductible'],
    utilities: ['Utilities', '', '', ''],
    otherexp: ['Other expenses', '', '', ''],
    nondeduct: ['Not deductible', 'Not deductible', 'Not deductible', 'Not deductible'],
    charity: ['Not on Schedule C (personal return)', 'Separately stated (Schedule K)', 'Separately stated (Schedule K)', 'Charitable contributions'],
    draw: ['Owner draws (not an expense)', 'Partner distributions (not an expense)', 'Shareholder distributions (not an expense)', 'Dividends (not an expense)'],
    asset: ['Fixed assets (depreciate)', 'Fixed assets (depreciate)', 'Fixed assets (depreciate)', 'Fixed assets (depreciate)'],
    none: ['Not on the tax return', 'Not on the tax return', 'Not on the tax return', 'Not on the tax return']
  };
  const BNAME = { income: 'Sales / room revenue', otherincome: 'Other income', cogs: 'Cost of goods sold', wages: 'Wages (employees)', officers: 'Owner pay (guaranteed payments / officers)', repairs: 'Repairs and maintenance', baddebt: 'Bad debts', rent: 'Rent', taxes: 'Taxes and licenses', interest: 'Interest', depreciation: 'Depreciation', retirement: 'Retirement plans', benefits: 'Employee benefits', advertising: 'Advertising', auto: 'Car and truck', commissions: 'Commissions and fees', contract: 'Contract labor', insurance: 'Insurance', legal: 'Legal and professional', office: 'Office expense', supplies: 'Supplies', travel: 'Travel', meals50: 'Meals (50% deductible)', meals0: 'Employee meals (not deductible from 2026)', utilities: 'Utilities', otherexp: 'Other expenses', nondeduct: 'Not deductible (fines, entertainment, personal)', charity: 'Donations', draw: 'Owner draws / distributions', asset: 'Fixed assets (furniture, equipment, improvements)', none: 'Not a tax item (transfers, loans, balance sheet)' };
  const FI = { SchC: 0, '1065': 1, '1120S': 2, '1120': 3 };
  const lineFor = (form, b, catName) => { const l = (B[b] || B.otherexp)[FI[form] || 0]; return l || (form === 'SchC' ? 'Other expenses: ' : 'Other deductions: ') + (BNAME[b] || catName); };

  // first guess from the category's name
  const GUESS = [
    [/employee meal|staff meal|crew meal/i, 'meals0'], [/meal|restaurant|dining|food & entertain/i, 'meals50'], [/entertain|golf|tickets|fine|penalt|political|lobby/i, 'nondeduct'],
    [/donat|charit/i, 'charity'], [/draw|distribution|personal|owner.?s? (pay|contribution)|partner pay/i, 'draw'], [/guaranteed|officer/i, 'officers'],
    [/payroll tax|property tax|real estate tax|lodging tax|occupancy tax|license|permit|\btaxes?\b/i, 'taxes'], [/payroll|wage|salar/i, 'wages'],
    [/repair|maint|pest|plumb|hvac/i, 'repairs'], [/linen|towel|amenit|housekeep|suppl|toiletr/i, 'supplies'], [/breakfast|cost of goods|cogs|food cost|resale|inventory/i, 'cogs'],
    [/utilit|electric|\bgas\b|water|sewer|trash|waste|cable|internet|spectrum|phone|telephone|cell/i, 'utilities'], [/insur/i, 'insurance'], [/interest/i, 'interest'],
    [/advert|marketing|promot/i, 'advertising'], [/commission|\bota\b|expedia|booking\.com|travel agent/i, 'commissions'], [/card fee|merchant|processing|bank (fee|charge)|service charge|bank & card/i, 'commissions'],
    [/franchise|royalt/i, 'otherexp'], [/legal|professional|accounting|\bcpa\b|attorney|bookkeep/i, 'legal'], [/contract|labor|cleaning service|laundry service/i, 'contract'],
    [/\brent\b|lease/i, 'rent'], [/travel|airfare|lodging|hotel stay/i, 'travel'], [/auto|fuel|vehicle|mileage|car |truck/i, 'auto'], [/software|subscription|office/i, 'office'],
    [/depreciation|amortiz/i, 'depreciation'], [/retire|401|\bsep\b|simple ira/i, 'retirement'], [/benefit|health ins/i, 'benefits'], [/bad debt|write.?off/i, 'baddebt'],
    [/furniture|fixture|equipment|improvement|renovat|building|vehicle purchase|computer/i, 'asset'], [/clean|laundry/i, 'otherexp']
  ];
  function guess(a) {
    if (a.sys === 'uncatIn' || a.sys === 'uncatOut') return '';
    if (a.type === 'income') return /other income|interest income|misc/i.test(a.name) ? 'otherincome' : 'income';
    if (a.type === 'asset' || a.type === 'liability') return /furniture|fixture|equipment|improvement|building|vehicle|computer/i.test(a.name) && a.type === 'asset' && a.detail !== 'bank' ? 'asset' : 'none';
    if (a.type === 'equity') return /draw|distribution|personal/i.test(a.name) ? 'draw' : 'none';
    for (const [re, b] of GUESS) if (re.test(a.name)) return b;
    return 'otherexp';
  }
  const tx = () => S().tax || (S().tax = { form: '', state: 'IN', map: {} });
  const formOf = () => tx().form || '1065';
  const bucketOf = a => (tx().map || {})[a.id] || guess(a);
  const taxAccounts = () => L.sortAccs(S().accounts.filter(a => !a.archived && !a.sample && a.sys !== 'uncatOut' && a.sys !== 'uncatIn' && (a.type === 'income' || a.type === 'expense' || (a.type === 'equity' && a.sys !== 'obe' && a.sys !== 'uncatIn'))));

  // ---------------- the numbers for one year ----------------
  const NODED = ['meals0', 'nondeduct', 'draw', 'asset', 'none', 'charity'];
  const dedOf = (b, v) => b === 'meals50' ? v * 0.5 : NODED.includes(b) ? 0 : v;
  function yearFigures(y) {
    const from = y + '-01-01', to = y + '-12-31', live = L.live(), d = C.debits(live, { from, to }), form = formOf();
    const rows = taxAccounts().map(a => ({ a, b: bucketOf(a), v: C.natural(a, d[a.id]) })).filter(r => Math.abs(r.v) >= 0.005);
    const lines = {};
    rows.forEach(r => {
      const line = lineFor(form, r.b, r.a.name), k = r.b + '|' + line;
      const x = lines[k] || (lines[k] = { b: r.b, line, v: 0, ded: 0, cats: [] });
      x.v += r.v; x.cats.push(r);
      x.ded += dedOf(r.b, r.v);
    });
    const L2 = Object.values(lines);
    const inc = L2.filter(x => x.b === 'income' || x.b === 'otherincome').reduce((s, x) => s + x.v, 0);
    const ded = rows.filter(r => r.a.type === 'expense').reduce((s, r) => s + dedOf(r.b, r.v), 0);
    const uncat = live.filter(t => t.date >= from && t.date <= to && L.isUncat(t)), uncatOut = uncat.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0);
    return { y, form, rows, lines: L2, inc, ded, net: inc - ded, uncat: uncat.length, uncatOut };
  }

  // ---------------- things to check, and ways to save ----------------
  const bankAcc = t => { const a = acc(t.accountId) || {}; return a.type === 'asset' && a.detail === 'bank'; };
  const CORP = /\b(inc|corp|corporation|incorporated|co|company|ltd|plc|bank|n\.?a\.?|credit union|irs|treasury|department|dept|city of|county|state of|usps|ups|fedex|walmart|amazon|costco|sam'?s|menards|lowe'?s|home depot|spectrum|at&t|verizon|vectren|centerpoint|duke energy)\b/i;
  function checks(y) {
    const from = y + '-01-01', to = y + '-12-31', live = L.live().filter(t => t.date >= from && t.date <= to);
    const out = { assets: [], v1099: [], subs: [], meals: 0, meals0: 0, auto: 0, retire: 0, propTax: 0, mortInt: 0, wages: 0 };
    const bk = t => { const c = acc(t.categoryId); return c ? bucketOf(c) : ''; };
    live.forEach(t => {
      const b = bk(t), amt = -t.amount;
      if (amt >= 2500 && ['repairs', 'supplies', 'otherexp', 'office', 'cogs'].includes(b)) out.assets.push(t);
      if (b === 'meals50') out.meals += amt; if (b === 'meals0') out.meals0 += amt; if (b === 'auto') out.auto += amt; if (b === 'retirement') out.retire += amt; if (b === 'wages') out.wages += amt;
      if (b === 'taxes' && /property|real estate/i.test((acc(t.categoryId) || {}).name + ' ' + t.payee)) out.propTax += amt;
      if (b === 'interest') out.mortInt += amt;
    });
    // 1099-NEC: services paid by check/ACH (card payments are reported by the card company), not to corporations
    const thr = Number(y) >= 2026 ? 2000 : 600, g = {};
    live.filter(t => t.amount < 0 && bankAcc(t) && ['repairs', 'contract', 'legal', 'commissions', 'otherexp', 'advertising', 'rent'].includes(bk(t))).forEach(t => {
      const name = t.payee.replace(/^check\s*#?\d+\s*/i, '').trim(); if (!name || /^check\b/i.test(t.payee) && name === '') return;
      if ((/\d{3,}|#|\.com\b|\bpos\b|purchase|best buy|target|staples|office depot|ebay|paypal|square|stripe|chase|citi|amex|american express|discover|capital one|walgreens|cvs|kroger|meijer|aldi/i.test(name) || CORP.test(name)) && !/attorney|law|legal/i.test(name + ' ' + (acc(t.categoryId) || {}).name)) return;
      const k = C.normPayee(name) || name.toLowerCase(); const x = g[k] || (g[k] = { name, total: 0, n: 0, legal: /attorney|law|legal/i.test(name + ' ' + (acc(t.categoryId) || {}).name) }); x.total -= t.amount; x.n++;
    });
    out.v1099 = Object.values(g).filter(x => x.total >= (x.legal ? 600 : thr)).sort((a, b) => b.total - a.total); out.thr = thr;
    // repeating charges (subscriptions and services), last 6 months
    const since = new Date(); since.setMonth(since.getMonth() - 6); const s6 = since.toISOString().slice(0, 10), by = {};
    L.live().filter(t => t.amount < 0 && t.date >= s6 && !L.isUncat(t) && !['none', 'draw', 'taxes', 'interest', 'wages'].includes(bk(t))).forEach(t => { const k = C.normPayee(t.payee); (by[k] = by[k] || []).push(t); });
    out.subs = Object.values(by).map(ts => { const months = new Set(ts.map(t => t.date.slice(0, 7))), avg = ts.reduce((s, t) => s - t.amount, 0) / ts.length, spread = Math.max(...ts.map(t => -t.amount)) - Math.min(...ts.map(t => -t.amount));
      return { t: ts[0], n: months.size, avg, yearly: avg * 12 * (ts.length / months.size) }; }).filter(x => x.n >= 3 && x.avg >= 10).sort((a, b) => b.yearly - a.yearly).slice(0, 12);
    return out;
  }
  function savings(y) {
    const f = yearFigures(y), k = checks(y), form = f.form, out = [];
    const passThru = form === '1065' || form === '1120S';
    if (f.uncat) out.push({ icon: '🧾', t: `${f.uncat} transaction${f.uncat === 1 ? '' : 's'} (${money(f.uncatOut)} spent) still have no category`, d: 'Anything without a category won\'t be deducted. Sort them in the AI Bookkeeper before giving numbers to your accountant.' });
    if (k.assets.length) out.push({ icon: '🛠️', t: `${k.assets.length} charge${k.assets.length === 1 ? '' : 's'} of $2,500 or more in repairs/supplies`, d: 'If any of these is one item over $2,500 (furniture, TVs, appliances, HVAC, a roof), it is usually a fixed asset. Under current law it can still be written off this year with 100% bonus depreciation (or Section 179, up to $2,560,000 in 2026), but your accountant has to know about it. Items of $2,500 or less per invoice can be expensed under the de minimis safe harbor if your accountant makes that election on the return.', list: k.assets.slice(0, 10).map(t => `${L.usDate(t.date)} · ${t.payee} · ${money(-t.amount)} · ${(acc(t.categoryId) || {}).name}`) });
    if (k.propTax > 0 || k.mortInt > 5000) out.push({ icon: '🏨', t: 'Ask about a cost segregation study', d: 'Hotels and motels often qualify. A study splits the building into parts with shorter lives (furniture, fixtures, carpet, parking lots), which can then use 100% bonus depreciation. It often means a large deduction in the first year, especially for a property bought or renovated recently.' });
    if (passThru && (tx().state || 'IN') === 'IN') out.push({ icon: '🏛️', t: 'Indiana pass-through entity tax (PTET) election', d: 'The LLC can elect to pay the Indiana income tax itself. That payment is deductible on the federal return, which lowers the income on each partner\'s K-1, and the partners get a credit on their Indiana returns. It must be elected every year, by the return due date (extensions count). Ask your accountant whether it saves you money this year.' });
    out.push({ icon: '📊', t: 'Qualified business income (QBI) deduction', d: `Owners of pass-through businesses can usually deduct up to 20% of their business income on their personal returns. It is now permanent. Above the income threshold ($403,500 married filing jointly, $201,750 others, for 2026) the W-2 wages paid and the property owned by the business affect how much you get.${k.wages ? ' This company paid ' + money(k.wages) + ' in wages this year, which helps.' : ''}` });
    if (f.net > 40000 && !k.retire) out.push({ icon: '🏦', t: 'No retirement plan contributions this year', d: 'A SEP-IRA, SIMPLE or 401(k) lets owners put money away before tax. 2026 limits: 401(k) $24,500 per person ($32,500 at age 50+, $35,750 at 60–63), SIMPLE $17,000, IRA $7,500. A SEP can be opened and funded up to the tax filing deadline.' });
    if (k.meals || k.meals0) out.push({ icon: '🍽️', t: `Meals: ${money(k.meals + k.meals0)} this year`, d: 'Business meals with clients or while traveling are 50% deductible. Starting in 2026, meals the business provides to employees for its own convenience (staff meals, meals during meetings) are 0% deductible. Breakfast served to hotel guests is a cost of the business (100%), so keep it in its own category, separate from meals.' });
    out.push({ icon: '🚗', t: k.auto ? `Car and truck: ${money(k.auto)} this year` : 'Driving for the business?', d: 'You can deduct either actual costs (fuel, repairs, insurance, depreciation) or 72.5¢ per business mile in 2026. Keep a mileage log (date, where, why, miles). The IRS asks for it, and the mileage rate is often the bigger deduction.' });
    if (k.v1099.length) out.push({ icon: '📮', t: `${k.v1099.length} vendor${k.v1099.length === 1 ? '' : 's'} may need a 1099-NEC for ${y}`, d: `People and LLCs (not corporations) you paid ${money(k.thr)} or more for services by check or bank transfer (${Number(y) >= 2026 ? 'new $2,000 threshold for payments made in 2026; it was $600 before' : 'threshold $600 for ' + y}). Attorneys need one from $600 even if incorporated. Payments by credit card don't need one. Get a W-9 from each now; 1099-NEC forms are due January 31. Missing them can mean penalties.`, list: k.v1099.slice(0, 12).map(x => `${x.name} · ${money(x.total)} (${x.n} payment${x.n === 1 ? '' : 's'})`) });
    if (k.subs.length) out.push({ icon: '🔁', t: `Repeating charges: about ${money(k.subs.reduce((s, x) => s + x.yearly, 0))} a year`, d: 'Not a tax item. These are the services you pay for every month. Cancel the ones you don\'t use, and call the big ones to ask for a better rate.', list: k.subs.map(x => `${x.t.payee} · about ${money(x.avg)} each time · ~${money(x.yearly)}/year`) });
    return { f, k, items: out };
  }

  // ---------------- what the AI is told ----------------
  const GUIDE = `US TAX GUIDE FOR THIS BUSINESS (checked Oct 2026; general guidance, the owner's tax preparer decides):
- Hotel/motel LLCs with two or more owners file Form 1065; each partner gets a K-1. Single-owner LLCs file Schedule C unless they elected S-corp (1120-S).
- Bank deposits are not income in these books; income is recorded separately. Lodging/occupancy tax collected from guests and paid to the state is not income or expense.
- Deductible: ordinary and necessary business costs: wages, payroll taxes, property taxes, repairs, supplies, utilities, insurance, interest (not loan principal), franchise fees and royalties, OTA commissions, card processing fees, advertising, legal and accounting.
- Meals with clients or while traveling: 50%. From 2026, meals given to employees for the employer's convenience: 0%. Food served to hotel guests (breakfast): 100%, cost of the business. Entertainment, fines, penalties, political donations: 0%.
- Items over $2,500 each (furniture, TVs, appliances, HVAC, roofs, renovations) are fixed assets; 100% bonus depreciation (property acquired after Jan 19, 2025) or Section 179 (limit $2,560,000 in 2026, phase-out $4,090,000) can still write them off in year one. Items $2,500 or less per invoice can be expensed under the de minimis safe harbor election.
- Hotels often benefit from cost segregation studies (faster depreciation of building parts).
- Owner draws/distributions and loan principal are not expenses. Partners' guaranteed payments are deductible by the partnership.
- 1099-NEC: payments for services to non-corporations by check/ACH of $2,000+ in 2026 ($600 for 2025 and earlier); attorneys from $600; card payments excluded. Due Jan 31.
- QBI deduction (20% of qualified business income) is permanent; 2026 thresholds $403,500 married joint / $201,750 others.
- Retirement 2026: 401(k) deferral $24,500 (+$8,000 age 50+, +$11,250 at 60-63), SIMPLE $17,000, IRA $7,500.
- Business mileage 2026: 72.5 cents per mile.
- Indiana: partnerships and S corps can elect the pass-through entity tax (PTET) each year to deduct state tax at the entity level.`;
  ST_hint();
  function ST_hint() {
    const ai = L.viewState.ai; if (!ai) return;
    ai.taxHint = () => {
      const cats = taxAccounts().filter(a => a.type === 'expense'), find = (b, pref) => ((pref && cats.find(a => bucketOf(a) === b && pref.test(a.name))) || cats.find(a => bucketOf(a) === b) || {}).name;
      const bits = ['TAX-AWARE SORTING: pick the category that puts the cost on the right tax line.'];
      if (find('meals50')) bits.push('Client/travel meals → ' + find('meals50') + '.'); if (find('cogs')) bits.push('Food for guests (breakfast) → ' + find('cogs') + '.');
      if (find('repairs')) bits.push('Fixing existing things → ' + find('repairs') + '.'); if (find('supplies')) bits.push('Linens, towels, toiletries, cleaning supplies → ' + find('supplies', /hotel|room|housekeep|linen|amenit/i) + '.');
      const draw = taxAccounts().find(a => bucketOf(a) === 'draw'); if (draw) bits.push('Personal spending by an owner → ' + draw.name + ' (not an expense).');
      bits.push('A payment to a credit card ("PAYMENT THANK YOU" on the card, or "AMEX EPAYMENT" from the bank) is money moved between the business\'s own accounts: use the bank or card account, never Owner\'s Draw, income or an expense. Loan payments: only interest is an expense. Lodging tax paid to the state is not an expense of the hotel if it was collected from guests.');
      return bits.join(' ');
    };
    ai.ctxExtra = (ai.ctxExtra || []).filter(f => !f.isTax);
    const f = q => {
      const y = String(new Date().getFullYear()), cur = yearFigures(y), prev = yearFigures(String(Number(y) - 1)), k = checks(y);
      const fmt = fig => fig.lines.sort((a, b) => b.v - a.v).map(x => `${x.line} | ${x.v.toFixed(2)}${x.ded !== x.v ? ' | deductible ' + x.ded.toFixed(2) : ''}`).join('\n');
      return `\n${GUIDE}\n\nTHIS COMPANY FILES: ${FORMS[formOf()]}${tx().form ? '' : ' (not confirmed by the owner)'}.\nTAX LINES ${y} (so far):\n${fmt(cur)}\nEstimated net business income ${y}: ${cur.net.toFixed(2)} (before depreciation and accountant adjustments).\nTAX LINES ${prev.y}:\n${fmt(prev)}\nCHARGES OF $2,500+ IN REPAIRS/SUPPLIES ${y}: ${k.assets.length}. POSSIBLE 1099 VENDORS ${y}: ${k.v1099.map(x => x.name + ' ' + x.total.toFixed(2)).join('; ') || 'none'}.\nWhen answering tax questions: use the guide and these figures, be specific, and say to confirm with the tax preparer.`;
    };
    f.isTax = true; ai.ctxExtra.push(f);
  }

  // ---------------- screen ----------------
  const nav = $('#nav'), rep = nav.querySelector('[data-view="reports"]');
  const nb = document.createElement('button'); nb.dataset.view = 'taxes'; nb.textContent = 'Taxes';
  rep.insertAdjacentElement('afterend', nb);
  const years = () => { const ys = new Set(L.live().map(t => t.date.slice(0, 4))); ys.add(String(new Date().getFullYear())); return Array.from(ys).sort().reverse().slice(0, 6); };
  views.taxes = () => {
    const y = VS.year, f = yearFigures(y), form = formOf();
    const head = `<div class="page-head"><div><h1>Taxes</h1><p class="sub">Where each category goes on the tax return, a year-end package for your accountant, and ways to save. Guidance to talk over with your tax preparer, not tax advice.</p></div>
      <div class="toolbar" style="margin:0"><label class="field" style="flex-direction:row;align-items:center;gap:6px">Year <select data-tx="year">${years().map(v => `<option${v === y ? ' selected' : ''}>${v}</option>`).join('')}</select></label><button class="btn" data-act="txExport">Download for accountant (CSV)</button></div></div>
      ${tx().form ? '' : `<div class="notice" style="margin-bottom:12px"><b>Which tax return does ${esc(S().company)} file?</b> <select data-tx="form">${Object.entries(FORMS).map(([k, n]) => `<option value="${k}"${k === form ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select> <button class="btn sm primary" data-act="txFormOk">That's right</button> <span class="small muted">LLCs owned by you and a partner usually file Form 1065. Ask your accountant if unsure.</span></div>`}
      <div class="tabs">${[['lines', 'Tax lines'], ['save', 'Ways to save'], ['map', 'Category setup']].map(([k, n]) => `<button data-act="txTab" data-tab="${k}" class="${VS.tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    if (VS.tab === 'map') return head + `<div class="panel"><p class="small muted" style="margin-top:0">Ledger Desk guessed these from the category names. Fix any that are wrong. The AI also uses this when it sorts.</p>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px;margin-bottom:10px">Tax return <select data-tx="form">${Object.entries(FORMS).map(([k, n]) => `<option value="${k}"${k === form ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <div class="table-wrap"><table><thead><tr><th>Category</th><th>Kind</th><th>Tax treatment</th><th>Goes on</th></tr></thead><tbody>
      ${taxAccounts().map(a => { const b = bucketOf(a); return `<tr><td>${esc(a.name)}</td><td class="small muted">${a.type}</td><td><select data-txmap="${a.id}">${Object.keys(BNAME).map(k => `<option value="${k}"${k === b ? ' selected' : ''}>${esc(BNAME[k])}</option>`).join('')}</select>${(tx().map || {})[a.id] ? '' : ' <span class="chip">guessed</span>'}</td><td class="small">${esc(lineFor(form, b, a.name))}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
    if (VS.tab === 'save') {
      const s = savings(y);
      return head + `<div class="panel"><div class="page-head" style="margin:0 0 8px"><div><h2 style="margin:0">Ways to save for ${y}</h2><p class="sub small">Worked out from your books. Bring this list to your accountant.</p></div>
        ${SV ? `<button class="btn primary" data-act="txAI"${VS.aiBusy ? ' disabled' : ''}>${VS.aiBusy ? '<span class="spin"></span>AI is reviewing…' : 'Ask the AI for more ideas'}</button>` : ''}</div>
        ${VS.ai ? `<div style="background:var(--accent-soft);border-radius:8px;padding:12px 14px;margin-bottom:12px;white-space:pre-wrap">${esc(VS.ai)}</div>` : ''}
        <div style="display:grid;gap:10px">${s.items.map(x => `<div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px"><div><span style="font-size:18px">${x.icon}</span> <b>${esc(x.t)}</b></div><div class="small" style="margin-top:4px">${esc(x.d)}</div>${x.list ? `<ul class="small muted" style="margin:6px 0 0;padding-left:18px">${x.list.map(l => '<li>' + esc(l) + '</li>').join('')}</ul>` : ''}</div>`).join('')}</div>
        <p class="small muted" style="margin:12px 0 0">Tax figures checked October 2026 (IRS 2026 mileage rate, 2026 inflation adjustments, the 2025 tax law changes). Your accountant has the final say.</p></div>`;
    }
    const order = ['income', 'otherincome', 'cogs'];
    const ls = f.lines.slice().sort((a, b) => (order.indexOf(a.b) + 1 || 9) - (order.indexOf(b.b) + 1 || 9) || b.v - a.v);
    const inc = ls.filter(x => order.includes(x.b) || x.b === 'otherincome'), exp = ls.filter(x => !['income', 'otherincome', 'cogs', 'draw', 'asset', 'none', 'nondeduct', 'meals0', 'charity'].includes(x.b)), other = ls.filter(x => ['draw', 'asset', 'none', 'nondeduct', 'meals0', 'charity'].includes(x.b));
    const tbl = (title, list) => list.length ? `<h3 style="font-size:13px;margin:16px 0 6px">${title}</h3><div class="table-wrap"><table><thead><tr><th>${esc(FORMS[form].split(' (')[0])} line</th><th>Categories</th><th class="num">Total</th><th class="num">Deductible</th></tr></thead><tbody>
      ${list.map(x => `<tr><td><b>${esc(x.line)}</b></td><td class="small muted">${x.cats.map(r => esc(r.a.name) + ' ' + money(r.v)).join(' · ')}</td><td class="num">${money(x.v)}</td><td class="num">${['income', 'otherincome'].includes(x.b) ? '' : money(x.ded)}</td></tr>`).join('')}</tbody></table></div>` : '';
    return head + `<div class="panel"><div class="grid kpis"><div class="panel kpi"><div class="lbl">Income ${y}</div><div class="val">${money(f.inc)}</div></div><div class="panel kpi"><div class="lbl">Deductible expenses</div><div class="val">${money(f.ded)}</div></div><div class="panel kpi"><div class="lbl">Estimated net</div><div class="val ${f.net < 0 ? 'neg' : 'pos'}">${money(f.net)}</div><div class="small muted">before depreciation</div></div></div>
      ${f.uncat ? `<p class="small" style="background:var(--warn-soft);padding:8px 10px;border-radius:6px">${f.uncat} transaction${f.uncat === 1 ? '' : 's'} in ${y} still need a category (${money(f.uncatOut)} spent). They're not in these totals.</p>` : ''}
      ${tbl('Income', inc)}${tbl('Deductions', exp)}${tbl('Not deductible or not on the return', other)}
      ${!ls.length ? '<p class="muted">Nothing recorded for this year yet.</p>' : ''}</div>`;
  };
  acts.txTab = b => { VS.tab = b.dataset.tab; L.render(); };
  acts.txFormOk = () => { const s = $('[data-tx=form]'); tx().form = s ? s.value : formOf(); L.save(); L.render(); toast('Saved'); };
  acts.txExport = () => {
    const f = yearFigures(VS.year), rows = [['Tax line', 'Category', 'Total', 'Deductible']];
    f.lines.forEach(x => x.cats.forEach(r => rows.push([x.line, r.a.name, r.v.toFixed(2), r.a.type === 'expense' ? dedOf(x.b, r.v).toFixed(2) : ''])));
    const k = checks(VS.year); rows.push([]); rows.push(['Possible 1099-NEC vendors', '', 'Paid', '']); k.v1099.forEach(x => rows.push(['', x.name, x.total.toFixed(2), '']));
    rows.push([]); rows.push(['Charges of $2,500+ in repairs/supplies (fixed asset?)', '', '', '']); k.assets.forEach(t => rows.push([t.date, t.payee, (-t.amount).toFixed(2), (acc(t.categoryId) || {}).name]));
    const csv = rows.map(r => r.map(v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = (S().company || 'company').replace(/[^\w ]+/g, '') + ' tax lines ' + VS.year + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  };
  acts.txAI = async () => {
    if (!SV) return; VS.aiBusy = true; VS.ai = null; L.render();
    const s = savings(VS.year), f = s.f, ctx = L.viewState.ai && L.viewState.ai.ctxExtra ? L.viewState.ai.ctxExtra.map(fn => fn('')).join('\n') : GUIDE;
    try {
      const r = await SV.post('/api/ai/ask', { question: `Look at ${S().company}'s ${VS.year} tax lines. Give the owner up to 6 specific, practical ideas to legally lower taxes or costs, based only on the TAX GUIDE and these figures. For each: one line on what to do and why, mentioning the actual amounts from the books. Don't repeat generic advice that doesn't fit these numbers. End with one line: confirm with your tax preparer.`, context: `Company: ${S().company}\n${ctx}\nIdeas the app already listed: ${s.items.map(x => x.t).join('; ')}`, history: [] });
      VS.ai = r.answer || '';
    } catch (e) { toast('AI: ' + e.message); }
    VS.aiBusy = false; L.render();
  };
  afterRender.taxes = () => {
    document.querySelectorAll('[data-tx=year]').forEach(s => s.addEventListener('change', e => { e.stopPropagation(); VS.year = s.value; VS.ai = null; L.render(); }));
    document.querySelectorAll('[data-tx=form]').forEach(s => s.addEventListener('change', e => { e.stopPropagation(); if (VS.tab === 'map') { tx().form = s.value; L.save(); L.render(); } }));
    document.querySelectorAll('[data-txmap]').forEach(s => s.addEventListener('change', e => { e.stopPropagation(); tx().map = tx().map || {}; tx().map[s.dataset.txmap] = s.value; L.save(); L.render(); }));
  };
  window.ledgerTax = { yearFigures, checks, savings, guess, GUIDE }; // for tests
})();
