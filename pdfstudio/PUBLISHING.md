# Publishing PdfStudio (website + auto-update)

Customers download from, and the app auto-updates from: https://trivedipos.com/pdfstudio/

## First release
1. `npm run dist`            builds release\PdfStudio-Setup-<version>.exe
2. `npm run prepare-upload`  copies the 4 files to upload\ (installer, .blockmap, latest.yml, index.html)
3. Upload everything in `upload\` to the `pdfstudio` folder on trivedipos.com (FTP / cPanel File Manager),
   so https://trivedipos.com/pdfstudio/ shows the download page.

## Pushing a new version
1. Change "version" in package.json (e.g. 1.0.1 - must be higher than the last one).
2. Repeat steps 1-3 above. Overwrite latest.yml and index.html; keep or delete older installers.
Installed copies check on start-up (and every 4 hours), download in the background, and show
"Restart to update" in the status bar. A "Check for updates" button is also in the status bar.

Important: upload latest.yml LAST, after the installer is fully uploaded, so no one gets a half-uploaded update.
Auto-update only works from the first build that contains it, so give customers THIS installer once.
