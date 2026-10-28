# Store POS program (`source/`)

## Files in `app/`
- `index.html` — every screen and all register logic (sell, pay, inventory, receive invoices, reports, accounting, settings).
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
