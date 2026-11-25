# Store POS program (`source/`)

## Files in `app/`
- `index.html` — every screen and all register logic (sell, pay, Home screen, inventory, purchase orders, receive invoices, reports, accounting, settings).
  Purchase orders are stored in the `porders` list (owner + managers only); Receive on a PO makes a Receive Invoice draft, and receiving it fills in the PO's received quantities.
  It talks to the computer through `window.posAPI`.
- `main.js` — the Windows engine (Electron 37.6.0): SQLite database `%APPDATA%\Store POS\data\pos.db`, receipts and drawer,
  barcode scanners, backups, updates, license keys, the store-Wi-Fi link for tablets (port 8765) and **Cloud Sync** with trivedipos.com.
- `preload.js` — gives `index.html` the `posAPI` functions from `main.js`.
- `android-shim.js` — the same `posAPI` on the Android tablet (SQLite and printing through the Android app).
- `web-shim.js` — the same `posAPI` in a normal web browser (trivedipos.com/pos): a copy of the store in the browser, synced through Cloud Sync.
- `lib/` — pdf.js, used to read PDF invoices.
- `package.json` — the version number (raise it for every release).

## Two editions, one program
- **Blank edition** (new stores): exactly these files. First start shows the new-store setup screen.
- **Vape & Smoke Studio edition**: the same files plus `first-run-data.json` and `first-run-history.jsonl.gz`
  (store data — kept only on the NAS, never on GitHub).

## Make an update file
`python3 source/tools/build_update.py source/app updates "what changed"` → `updates/StorePOS-Update-x.y.z.posupdate`.
Registers install it from Settings → Import / Backup (Check online, or open the file). Store data is never touched.

## Deleting transactions (owner only, 1.18)
Transactions → **🗑 Delete** tab (only for the Owner role, only on the Windows store PC, not on tablets, the web back office or a linked PC).
`ordersFind` / `ordersDelete` in main.js search and remove rows from `orders` + `order_lines` in one database transaction and record each
removal in the change log, so linked registers, tablets and the web copy remove them too. Stock is never touched. A summary
(who, when, how many, total) is kept in kv `dellog`. Backups made before the delete still contain the transactions.

## Trivedi account link (Windows store PC and web back office)

- `acct.js` (new, shipped with updates): signs the owner in to trivedipos.com, registers the store under the account and keeps only a **device token** (never the password). The store key is locked with the owner's public key before it is sent.
- Store PC: Settings → Tablets → **Trivedi account** → "Link to my Trivedi account" (user name + password, then the two-step code if asked). Shows "Linked to …" with **Unlink**. The cloud-code pairing stays as "Connect a tablet or PC with a code". Every 3 minutes the PC hands waiting members their locked key, reports its devices and forgets devices of people who were removed (`acctTick` in `main.js`).
- A browser or device signed in through an account gets a device entry marked `acct`; it only works while the relay says the same person is asking. Role "Reports only" cannot send changes.
- Web back office (`web-shim.js`): the sign-in gate uses the shared Trivedi sign-in, lists "My stores", unlocks the store key in the browser (kept in memory only, never in browser storage) and connects. "Connect with a code instead" still works. Settings → **Members (accounts)** (owners only) invites people, changes roles and removes them. Roles: Owner = full, Manager = Manager preset, Cashier = Cashier preset, Reports only = reports and transaction look-up. The account signs in to the register without a PIN.
- `build_update.py` and `windows.yml` now include `acct.js`.


## Card terminal (PAX A35, `terminal.js`) — not released yet
Windows app only. Settings are **per PC** (Settings → Card terminal → saved in that PC's `config.json`, never synced).
When it is switched on, the Credit, Debit, EBT Food and EBT Cash buttons send the amount to the terminal over the store Wi-Fi instead of asking for the card's last 4.
A "Waiting for card on terminal" box with a big Cancel button shows until the terminal answers. The old last-4 way stays available through the "Enter card manually (terminal not working)" links, and when the switch is off nothing changes.

How it is built: `terminal.js` has one driver per terminal program, all with the same calls (`test, sale, refund, void, settle, ebtBalance, status, cancel`) and the same answer shape, so the screens never change when a driver is added.
- `valor` — Valor semi-integration: the terminal is a TCP server (its IP, port 5000, cancel on port 5001), JSON text wrapped in STX/ETX (Settings → Advanced can switch to plain JSON). Amounts are in cents. One connection per request.
  If the answer never comes or the link drops after the request was sent, the POS sends Cancel, asks the terminal for the transaction status, and then shows "check the terminal screen". It **never sends the sale again**, so a card cannot be charged twice.
- `demo` — a pretend terminal inside the app for training: approves after 2 s; an amount ending **.13** is declined, **.51** is half approved, **.99** shows the "check the terminal" screen.
- `poslink` — PAX BroadPOS / POSLink ("Interface Between ECR and Terminal"). The terminal is a TCP server (its IP, port **10009**); an option switches to HTTP. Each request is `STX, fields split by FS, ETX, LRC`, then ACK, the answer, ACK, EOT (a bad checksum gets a NAK and the packet is sent again). Commands: Initialize A00 (Test connection: shows model, serial, firmware), Do Credit T00, Do Debit T02, Do EBT T04 (sale, return, void, balance), Batch Close B00, Cancel A14, Local Detail Report R02 (looks a payment up by the ECR reference we send).
  A card payment is **never sent twice**: if the answer does not come or the link drops, the POS sends Cancel, asks the terminal for the record of that reference, and otherwise shows "check the terminal". The surcharge is decided by the terminal (the POS never sends one) and comes back in the answer. The PAX spec is PAX's licensed document and is not kept in this repo.
  Settings → Card terminal → Advanced: connection (TCP/HTTP), protocol version (1.28), whether the terminal prints receipts, wait time (300 s).

What is saved on a card payment: brand, last 4 only, auth code, entry mode (tap/chip/swipe), RRN, tran/batch/STAN numbers, AID, and the surcharge if the terminal added one. Never a full card number.
**Surcharge:** the terminal decides it. It is saved on the payment (`surcharge`) and on the order (`surcharge`), printed on the receipt as "Card surcharge" and "Total charged to card", but the sale total, tax and reports are not changed (the sale is still paid by `amount`). Do not use the POS "Card Fee" button together with a terminal surcharge (the POS warns if both are present).
Refunds of a terminal card payment offer Void on terminal (same batch), Refund to card, or Already refunded / by hand.

Test it without a terminal:
1. `node source/tools/mock-valor-terminal.js` (pretend terminal on this PC, ports 5000/5001; `--surcharge 3`, `--framing raw`, `--delay 3000` available; amounts ending .13 decline, .51 partial, .77 drop the line, .88 never answer).
2. In Store POS: Settings → Card terminal → switch on, Valor, IP `127.0.0.1`, Test connection.
3. `node source/tools/test-terminal.js` runs the automatic checks of the Valor/demo drivers against the mock (approve, decline, partial, cancel, drop/hang, void, refund, settle, EBT balance, both message formats).
PAX: `node source/tools/mock-pax-terminal.js` (port 10009; amounts ending .13 decline, .51 partial, .66 customer cancels, .77/.78 line drops, .88/.89 no answer, .97 bad checksum answer, .98 damaged request; `--surcharge 3`, `--split 40`) and `node source/tools/test-terminal-pax.js` runs the automatic PAX checks.
`build_update.py` includes `terminal.js` in the update file.
