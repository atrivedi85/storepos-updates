# Store POS — update channel

This repository holds **program updates** for the Vape & Smoke Studio POS (Windows).
It contains program code only — no store data, sales, customers, card digits or PINs.

- `latest.json` — the newest version; the POS checks this automatically.
- `updates/StorePOS-Update-x.y.z.posupdate` — update files. The POS downloads, checks (SHA-256) and installs them, keeping all store data.

POS setting (Settings → Import / Backup → Online update address):

```
https://raw.githubusercontent.com/atrivedi85/storepos-updates/main/latest.json
```
