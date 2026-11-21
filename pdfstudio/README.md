# PdfStudio

PDF editor: a Windows desktop app (Electron) and the same editor on the web at
https://trivedipos.com/pdfstudio/app/ — people sign in with their **Ledger Desk** username and password.

Moved here from `C:\Users\virus\Documents\PdfStudio\P editor` on the trivedi-ai PC on 2026-11-21,
so all the software (Store POS, Ledger Desk, Hotel Desk, PdfStudio, website) lives in one GitHub project.
`HANDOFF.md`, `LICENSING.md` and `PUBLISHING.md` are the original notes.

## What is where

| Path | What it is |
|---|---|
| `src/main/` | desktop app engine (Electron main process, licence check, Ledger sign-in) |
| `src/renderer/` | the editor screens (shared by the desktop app and the web version) |
| `src/web/` | web-version bridge (replaces the desktop file system with cloud storage) |
| `src/shared/` | code used by both |
| `worker/` | the Cloudflare Worker behind trivedipos.com/pdfstudio: download page, update files, sign-in API, admin page, per-user file storage, the Apps button script (`apps-switcher.txt`) |
| `build.mjs` | builds `dist/` (desktop) and `dist-web/app/` (web) |
| `scripts/` | licence key maker, sample makers, old test scripts |

## Publishing

- **Web version + Worker:** push changes under `pdfstudio/` to `main`. `.github/workflows/pdfstudio.yml`
  builds the web editor and runs `wrangler deploy` with the `CLOUDFLARE_API_TOKEN` secret (~1–2 min).
- **Desktop installer:** still built on a Windows PC: `npm install`, bump `version` in `package.json`,
  `npm run dist`, `npm run prepare-upload`, then upload to the R2 bucket as in `HANDOFF.md`. Only when the owner asks.

## Never put in this repo

- `keys/private.pem` (signs licence keys) and `keys/issued.log` — they stay on the PC and in the NAS private folder.
- The Resend email key (it is a Worker secret: `npx wrangler secret put RESEND_API_KEY`).
- `worker/seed-admin.sql` (contains a one-time invite).

## Known open items

- The Worker also answers `trivedipos.com/` and serves its own copy of the home page (`worker/home.html`),
  so edits to the home page in `cloud/` do not show until that route is removed and the PdfStudio tile
  is added to the real home page.
- Desktop app 1.0.6 still uses activation keys; the Ledger sign-in is in the code but not in an installer yet.
