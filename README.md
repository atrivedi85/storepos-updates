# Trivedi POS — Store POS, Ledger Desk and trivedipos.com

Everything we built lives here: the **Store POS** cash register (Windows, Android tablet, web back office),
**Ledger Desk** accounting, and the **trivedipos.com** website and server.
Program code only — never store data, sales, customers, card numbers, PINs, passwords or private keys.

The same files are copied to the NAS master folder `Y:\Vape & Smoke Studio POS\POS and LedgerDesk\`
after every change, so the NAS always has the complete, current set.

## Map — what is where

| Folder | What it is | Read |
|---|---|---|
| `source/app/` | **Store POS** program: `index.html` (all screens), `main.js` (Windows engine: database, printing, Cloud Sync), `preload.js`, `android-shim.js` (tablet bridge), `web-shim.js` (web back office bridge), `lib/` (PDF reader) | `source/README.md` |
| `source/tools/` | `build_update.py` — makes a `.posupdate` file | `source/README.md` |
| `source/installer/` | the old zip installer scripts (still used for the Vape edition on the NAS) | |
| `installer/` | settings for the new one-file Windows installer `StorePOS-Setup.exe` | `installer/README.md` |
| `android/` | Android tablet app (Google Play: "Store POS - Retail Register") | `android/README.md` |
| `cloud/` | **trivedipos.com**: home page, download page, Cloud Sync server, Ledger Desk server | `cloud/README.md` |
| `ledger/app/` | **Ledger Desk** screens (website version, served at trivedipos.com/books) | `ledger/README.md` |
| `ledger/server-pc/` | the old Ledger Desk Server from the golf sim PC (kept for reference) | `ledger/README.md` |
| `updates/` + `latest.json` | every released Store POS update; registers check `latest.json` automatically | `updates/README.md` |
| `docs/` | Google Play pictures and the privacy policy page (GitHub Pages) | |
| `.github/workflows/` | automatic builds: `cloud.yml` (website), `windows.yml` (installer), `android.yml` (tablet app) | below |

## Live addresses

- https://trivedipos.com — home page
- https://trivedipos.com/download — Store POS for Windows (needs an owner code = license key)
- https://trivedipos.com/pos — Store POS back office (connect with the Cloud code from the store PC)
- https://trivedipos.com/books — Ledger Desk (invite only)
- Updates for registers: `https://raw.githubusercontent.com/atrivedi85/storepos-updates/main/latest.json`

## How to make a change (checklist)

1. Change the files (Store POS in `source/app/`, Ledger Desk in `ledger/app/`, website/server in `cloud/`).
2. Test it (see the test tools in the NAS backup, `4 - Test and build tools.zip`).
3. Store POS change? Raise the version in `source/app/package.json`, then
   `python3 source/tools/build_update.py source/app updates "what changed"`,
   move `updates/latest.json` to the top (url `updates/<file>`, keep `"cloudUrl": "https://trivedipos.com"`).
4. Commit and push to GitHub. The automatic builds then:
   - publish the website (`cloud.yml`) — about 1 minute,
   - build `StorePOS-Setup.exe` for the download page (`windows.yml`) — about 3 minutes,
   - build the Android app (`android.yml`).
5. Copy the new `.posupdate` to the NAS `Updates\` folder (and a "NEWEST UPDATE - …" copy at the top).
6. Refresh the NAS master folder (`POS and LedgerDesk`) and the project notes.

## Secrets (stored in GitHub → Settings → Secrets → Actions, never in files)

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASS`.
Private keys live only on the NAS in the `(PRIVATE - do not share)` folders.
