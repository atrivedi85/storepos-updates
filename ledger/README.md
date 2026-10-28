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
