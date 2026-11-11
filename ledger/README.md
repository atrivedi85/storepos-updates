# Ledger Desk (`ledger/`)

Free bookkeeping for our customers and friends, at **https://trivedipos.com/books** (invite only).

- `app/` — the Ledger Desk screens. `index.html` + `app.js` (books, transactions, reports), `bridge.js` (talks to the server),
  `vault.js` (locks the books in the browser with a key made from the password), `login.js`/`login.html` (sign in, invites,
  recovery codes), `server-ui.js` (Logins, two-step sign-in), `ai.js`/`aichat.js` (AI Assistant), `qbimport.js`, `statements.js`,
  `pdfstmt.js`, `checks.js`, `tax.js`, `xlsx.js`, `merchants.js`, `vendor/` (pdf.js).
- The server for the website is `cloud/src/ledger.js` (see `cloud/README.md`).
- `server-pc/` — the old "Ledger Desk Server 2.0.0" that ran on the golf sim PC (kept for reference and for moving old books).

Books are locked in each person's browser; the server only stores locked files.
The AI runs on the owner's own AI PC ("Ledger Desk AI", still to be built), which connects out to the website.

## Stores (one company, several stores — like QuickBooks Locations)

- Company & Backup › Stores adds them (`S.stores = [{id, name}]`). Companies without stores see nothing new.
- A bank/card account's home store is `a.store` (Chart of Accounts › Rename). A transaction counts for `t.store` if set
  (Transactions › Store column, bulk "Set store", the edit window, Record income, or a Bank Rule's `r.store`), otherwise for its
  account's home store (`storeOf(t)` in `app.js`). Nothing is copied onto old transactions, so changing an account's store re-files its history.
- Reports › store picker: All stores, Each store in its own column (P&L and Balance Sheet), one store, or No store.
  Balance Sheet by store: bank/card/loan accounts go to their home store; owner's equity and draws are company-wide (TOTAL);
  each store's "Store equity & transfers between stores" is what's left, so every column balances.
- Monthly Trend and Spending/Account Detail follow the store picked.
- AI Bookkeeper (`aichat.js`): for transactions with no store (shared cards), the question card has a Store choice, pre-set to the
  store most used before for that payee (`storeGuess`); sure-of sorts fill that store too. A Bank Rule made there keeps the store.

## AI Assistant › Chat (`aitasks.js`) and "+ New category…"

- The sidebar's AI Assistant opens on **Chat** (first tab). Questions go to the AI as before. Commands are read in the browser
  (`LedgerTasks.parse`, no AI needed): delete / ignore / restore / move to a category / set store / rename, filtered by text
  ("that say …", quoted text, "all VECTREN"), a month or year, and "on <account>". It lists the matches with totals and warnings
  (statement balances, matched transfers, income on deposits) and changes nothing until the button is clicked. Delete/Ignore
  go through `deleteTxns`/`ignoreTxns` (Undo). Category/store changes offer a Bank Rule.
- Every category list (from `catOptions`) starts with **+ New category…**: a small box (`#ncBox`, works over other dialogs) makes the
  account and selects it, then fires the select's normal change. Bulk categorize and Bank Rules refuse an empty choice.
- Transactions › "Uncategorized only" shows **similar transactions grouped** (`similarKey`: payee without store/check numbers,
  dates and long reference codes; money in and out apart; bare CHECK/DEPOSIT/ATM… never grouped). One category or store
  choice applies to the whole group (skipping income on deposits), with an offer to make a Bank Rule. "Group similar" can be turned off.

## Grouped uncategorized transactions

- Transactions › "Uncategorized only" shows **similar transactions as one row** ("Group similar", on by default). `similarKey(t)`:
  the payee in capitals without dates, `#store numbers`, plain numbers and long reference codes, first 6 words, plus money in/out.
  Bare generic payees (CHECK, DEPOSIT, ATM, TRANSFER, …) are never grouped. One category (or store) choice applies to the whole
  group (deposits never become income), with a Bank Rule offer; a group can be opened to sort single items, and its checkbox
  selects all of it for the bulk bar. "Also do N more" after a single change uses the same `similarKey`.

## Ledger Desk AI model (Nov 1, 2026)

- Tested on 110 already-categorized transactions with no Bank Rule (4 companies): qwen2.5:7b 55% right (high-confidence 56%),
  **qwen3.5:9b 72% (high-confidence 78%)**, qwen3:8b 58%. qwen3.5:9b is ~3× slower (81% on the 8 GB GPU) but now the text model.
  Qwen 3.x is called with `think: false`. Vision stays qwen2.5vl:7b. The AI PC connector restarts itself when its file or config changes
  (`run-ai.vbs` loops), so later updates need no one at the PC.

## PDF statements (Nov 11, 2026)
Import › **Upload PDF statement** (next to the .QBO button) reads a bank or card PDF in the browser with `pdfstmt.js` (no AI needed),
shows the same review card as a .QBO file, and checks the transactions against the statement's beginning and ending balance.
After the import, if the PDF has checks and the AI PC is on, `window.LedgerAfterPdfImport` (aichat.js) reads the check pictures and asks who each check was paid to.
Scanned PDFs (pictures only, no text) can't be read.
