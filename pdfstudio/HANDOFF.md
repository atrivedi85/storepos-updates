# PdfStudio handoff (read this first on a new PC or a new chat)

Project: Windows PDF editor, Electron + TypeScript + pdf.js + pdf-lib. Latest published: v1.0.6.
Owner's site: trivedipos.com (Cloudflare). Installer/updates live in R2 bucket `pdfstudio-downloads`, served by the Worker in `worker/` at https://trivedipos.com/pdfstudio/.

Set up on a new PC:
1. Install Node.js LTS (winget install OpenJS.NodeJS.LTS), then in this folder: `npm install`
2. `npm run build` then `npm start` to run from source. `npm run dist` builds the installer into release\.
3. Licensing: keys\private.pem signs license keys (KEEP SECRET, back it up). Make keys with
   `node scripts/keygen.mjs issue --name "X" [--machine ID] [--days N]` or run scripts\make-license.ps1 (or "Make License Key.bat").
   A license key is locked to one PC: on a new PC the app shows a new Computer ID, so issue a new key for it.
   Do NOT run `keygen.mjs init` again - it would replace the signing key and invalidate every key already issued.
4. Uploading releases needs Cloudflare: run `npx wrangler login` once (browser Allow). Steps are in PUBLISHING.md.
5. To rebuild the portable KeyMaker kit: one folder with scripts\keygen.mjs, scripts\make-license.ps1, keys\private.pem, "Make License Key.bat" and node\node.exe.

Release workflow: bump version + build.releaseInfo.releaseNotes in package.json -> npm run dist -> npm run prepare-upload (run from the project root)
-> upload the 4 files to R2 with `wrangler r2 object put pdfstudio-downloads/<file> --file <path> --remote` (latest.yml LAST) -> verify https://trivedipos.com/pdfstudio/latest.yml.
Only publish when the owner asks. Auto-update and the "Update available" popup are built in.

Open items: (1) DONE 2026-11-21: the PdfStudio tile is now in the real home page (cloud/site/index.html) and the `trivedipos.com/` route is gone.
(2) Installer is unsigned (SmartScreen). (3) Erase tool covers/removes annotations but is not secure redaction. (4) Keep keys\private.pem backed up.
Note: in Claude Code the env var ELECTRON_RUN_AS_NODE may be set and must be removed before launching electron.
