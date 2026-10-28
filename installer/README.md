# Windows installer (`installer/`)

`builder.json` tells electron-builder how to make **StorePOS-Setup.exe** (one click, installs for the current user,
desktop + Start menu shortcuts, opens `.posupdate` files). Built by `.github/workflows/windows.yml` on every Store POS change
and published to the GitHub release `pos-windows-latest`; trivedipos.com/download hands it out to people with an owner code.
It is the blank edition (no store data). Windows shows "More info → Run anyway" because it is not code-signed yet.
