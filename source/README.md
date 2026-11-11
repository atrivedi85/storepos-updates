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

