/* Ledger Desk core: QBO/OFX parsing and double-entry math. No DOM here. */
(function (root) {
  'use strict';

  // ---------- QBO / OFX parsing (works for OFX 1.x SGML and OFX 2.x XML) ----------
  function leaf(block, tag) {
    const m = new RegExp('<' + tag + '>\\s*([^<\\r\\n]*)', 'i').exec(block);
    return m ? decodeEntities(m[1].trim()) : '';
  }
  function blocks(text, tag) {
    const out = [];
    const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'gi');
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
    // SGML files sometimes omit closing tags on STMTTRN; fall back to splitting.
    if (!out.length && new RegExp('<' + tag + '>', 'i').test(text)) {
      const parts = text.split(new RegExp('<' + tag + '>', 'i')).slice(1);
      parts.forEach(p => out.push(p.split(/<\/?(BANKTRANLIST|STMTTRN)>/i)[0]));
    }
    return out;
  }
  function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  }
  function ofxDate(s) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(s || '');
    return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
  }
  function ofxAmount(s) {
    s = (s || '').replace(/\s/g, '');
    if (s.indexOf(',') > -1 && s.indexOf('.') === -1) s = s.replace(',', '.');
    s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
  }

  function parseOFX(text) {
    const start = text.search(/<OFX>/i);
    if (start < 0) throw new Error('This file is not a QBO/OFX statement (no <OFX> section found).');
    const body = text.slice(start);
    const org = leaf(body, 'ORG') || leaf(body, 'INTU.BID') || '';
    const statements = [];
    const stmtBlocks = blocks(body, 'CCSTMTRS').map(b => ({ b, kind: 'credit' }))
      .concat(blocks(body, 'STMTRS').map(b => ({ b, kind: 'bank' })));
    stmtBlocks.forEach(({ b, kind }) => {
      const from = kind === 'credit' ? (blocks(b, 'CCACCTFROM')[0] || b) : (blocks(b, 'BANKACCTFROM')[0] || b);
      const acctId = leaf(from, 'ACCTID');
      const acctType = kind === 'credit' ? 'CREDITCARD' : (leaf(from, 'ACCTTYPE') || 'CHECKING').toUpperCase();
      const ledger = blocks(b, 'LEDGERBAL')[0];
      const txns = blocks(b, 'STMTTRN').map(t => {
        const name = leaf(t, 'NAME');
        const memo = leaf(t, 'MEMO');
        return {
          type: leaf(t, 'TRNTYPE').toUpperCase(),
          date: ofxDate(leaf(t, 'DTPOSTED') || leaf(t, 'DTUSER')),
          amount: ofxAmount(leaf(t, 'TRNAMT')),
          fitid: leaf(t, 'FITID'),
          payee: (name || memo || 'Unknown').replace(/\s+/g, ' ').trim(),
          memo: memo && memo !== name ? memo.replace(/\s+/g, ' ').trim() : '',
          checkNum: leaf(t, 'CHECKNUM'),
          sic: leaf(t, 'SIC') || leaf(t, 'MCC')
        };
      }).filter(t => t.date);
      statements.push({
        kind, acctId, acctType, org,
        currency: leaf(b, 'CURDEF') || 'USD',
        ledgerBalance: ledger ? ofxAmount(leaf(ledger, 'BALAMT')) : null,
        ledgerDate: ledger ? ofxDate(leaf(ledger, 'DTASOF')) : '',
        start: ofxDate(leaf(b, 'DTSTART')),
        end: ofxDate(leaf(b, 'DTEND')),
        txns
      });
    });
    if (!statements.length) throw new Error('No bank or credit card statement was found in this file.');
    return statements;
  }

  // ---------- Double-entry ledger ----------
  // A register transaction with amount `a` on account A and category C posts:
  //   Debit A by a, Credit C by a   (a > 0 = money into A / payment toward a card)
  const DEBIT_NORMAL = { asset: true, expense: true };
  function debits(txns, opts) {
    opts = opts || {};
    const d = {};
    txns.forEach(t => {
      if (opts.from && t.date < opts.from) return;
      if (opts.to && t.date > opts.to) return;
      d[t.accountId] = (d[t.accountId] || 0) + t.amount;
      d[t.categoryId] = (d[t.categoryId] || 0) - t.amount;
    });
    return d;
  }
  function natural(acc, debit) {
    const v = DEBIT_NORMAL[acc.type] ? debit : -debit;
    return Math.round((v || 0) * 100) / 100;
  }
  // Amount as seen from a category's side (e.g. an expense row shows a charge as +)
  function categoryAmount(cat, t) { return natural(cat, -t.amount); }

  function matchRule(rules, t) {
    const hay = (t.payee + ' ' + (t.memo || '')).toLowerCase();
    for (const r of rules) {
      if (!r.match) continue;
      const m = r.match.toLowerCase();
      if (r.sign === 'out' && t.amount >= 0) continue;
      if (r.sign === 'in' && t.amount < 0) continue;
      if (hay.indexOf(m) > -1) return r;
    }
    return null;
  }

  // Merchant key: first two words of the payee, without store numbers, locations or payment-processor prefixes
  function normPayee(p) {
    let s = (p || '').toLowerCase().replace(/[’']/g, '');
    s = s.replace(/^(sq|tst|sp|pp|paypal|in|py|dd|pos|ach|debit|purchase|checkcard|chk card|recurring)\s*\*\s*/, '');
    const words = s.split(/[^a-z&]+/).filter(w => w.length > 1);
    return words.slice(0, 2).join(' ');
  }

  root.LedgerCore = { parseOFX, debits, natural, categoryAmount, matchRule, normPayee, ofxDate, ofxAmount };
})(typeof window !== 'undefined' ? window : globalThis);
