# Notes for Claude (any Claude working in this folder)

Read `README.md` first — it has the map of what is where and the "How to make a change" checklist.
Then read the README in the folder you are changing (`source/`, `ledger/`, `hotel/`, `cloud/`, `pdfstudio/`).

## The owner works from more than one place

Changes come from Claude in the claude.ai app (cloud) and from Claude in VS Code on the owner's PCs.
They all share this GitHub repo, so:

1. **Always `git pull` before starting** a change.
2. **Commit and push to `main` when done** — that is what publishes:
   `cloud.yml` (website, Ledger Desk, Hotel Desk, ~1 min), `pdfstudio.yml` (PdfStudio web), `windows.yml` (installer), `android.yml` (tablet app).
3. Store POS change? Follow README step 3 (raise the version in `source/app/package.json`,
   run `python source/tools/build_update.py source/app updates "what changed"`,
   then put the new entry in the top-level `latest.json` with `url` = `updates/<file>`
   and `"cloudUrl": "https://trivedipos.com"`, and delete `updates/latest.json`).
   Registers only see the update once `latest.json` is pushed.
4. Write release notes and replies in plain words — the owner is not a programmer.

## Never put in this repo

Store data, sales, customers, card numbers, PINs, passwords, license keys, company books,
the Android keystore, PdfStudio `keys/private.pem`, the Resend email key, Cloudflare tokens, or the Ledger Desk AI key. Secrets live in
GitHub → Settings → Secrets, and private files only in the NAS `(PRIVATE - do not share)` folders.

## NAS master copy (when the NAS drive Y: is available on this PC)

After a change, copy the changed files into `Y:\Vape & Smoke Studio POS\POS and LedgerDesk\Code (same as GitHub)\`
at the same paths, and copy a new `.posupdate` into the NAS `Updates\` folder
(plus a "NEWEST UPDATE - …" copy at the top). Update the READ ME there if something big changed.

## PdfStudio

PdfStudio now lives in `pdfstudio/` here. The old folder `C:\Users\virus\Documents\PdfStudio\P editor`
on the trivedi-ai PC is no longer the master copy: work in `pdfstudio/` and push. Its `keys/` folder stays on that PC only.

## Things that changed on 2026-11-21 (read this if you worked on PdfStudio before)

- PdfStudio moved into this repo (`pdfstudio/`). There is no separate PdfStudio repo any more; the old public one that held a key was deleted.
- The Cloudflare key was replaced. The new one lives only in GitHub → Settings → Secrets (`CLOUDFLARE_API_TOKEN`). Never paste a Cloudflare key into a file, a chat or a terminal on a PC. Publish by pushing to `main`; do not run `wrangler deploy` by hand.
- PdfStudio desktop updates: raise `version` in `pdfstudio/package.json`, push, then run the GitHub Action "pdfstudio-publish" (no Windows PC needed).
- PdfStudio sign-in uses Ledger Desk accounts. Turn people on or off only in Ledger Desk.
- The home page is edited only in `cloud/site/index.html`.
- The old Resend email key was deleted; PdfStudio does not send emails now.
