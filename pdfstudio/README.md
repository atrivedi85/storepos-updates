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

## Send for signature (added 2026-11-22)

Sign menu → **Send for others to sign…** / **Signing requests…**. Code: `src/renderer/esign.ts` (owner side, builds the signed PDF
with a certificate page), `src/signer/` (public signing page at `/pdfstudio/s/<link>`), `worker/esign.js` (API, D1 tables `esign_*`
created on first use, files in the FILES bucket under `esign/<id>/`). Emails go through Resend: the key is the GitHub secret
`RESEND_API_KEY`, which `pdfstudio.yml` hands to the Worker on every deploy. Sender address: `SIGN_FROM` in `worker/wrangler.toml`.

## Never put in this repo

- `keys/private.pem` (signs licence keys) and `keys/issued.log` — they stay on the PC and in the NAS private folder.
- The Resend email key (it is a Worker secret: `npx wrangler secret put RESEND_API_KEY`).
- `worker/seed-admin.sql` (contains a one-time invite).

## Who may use it

Anyone who can sign in to Ledger Desk. Ledger Desk is the only on/off switch (PdfStudio's own Disable button was removed 2026-11-21; old `disabled` flags in the database are ignored).

## Known open items

- Home page: edited in ONE place, `cloud/site/index.html` (the PdfStudio tile is there). The old override route `trivedipos.com/` was removed on 2026-11-21.
