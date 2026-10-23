# Store POS — source

Program code only. **No store data lives here.** Items, sales history and settings are on the store PC
(`%APPDATA%\Store POS\data\pos.db`), in its backups, and on the NAS.

- `app/` — the Electron app: `main.js` (desktop engine: SQLite, printing, drawer, scanners, backups, updater),
  `preload.js` (bridge), `index.html` (all screens and register logic).
- `installer/` — Windows install / uninstall scripts and the NAS rejoin script.
- `tools/build_update.py` — makes a `.posupdate` file + `latest.json` from `app/`.

The full installer also bundles Electron 37.6.0 for Windows and the first-run data files
(`first-run-data.json`, `first-run-history.jsonl.gz`) made from the Exatouch backup. Those data files
are NOT in this repository; they are inside the installer on the NAS (`Y:\Vape & Smoke Studio POS\Installer`).

## Releasing an update
1. Change files in `app/`, bump `version` in `app/package.json`.
2. `python3 tools/build_update.py app ../updates "what changed"` (never use `--with-data` here).
3. Point `latest.json` at `updates/StorePOS-Update-<version>.posupdate` (version, url, sha256, notes).
4. Commit and push. POS computers pick it up within 6 hours or on Check online.
