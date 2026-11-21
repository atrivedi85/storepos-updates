# PdfStudio licensing (vendor notes)

PdfStudio will not open or save any file until a valid license key is entered.

## Issue a key
    node scripts/keygen.mjs issue --name "Jane Roe"                         # works on any PC, never expires
    node scripts/keygen.mjs issue --name "Jane Roe" --machine 9D87-7EF2-9C1D-EA22   # locked to one PC (recommended)
    node scripts/keygen.mjs issue --name "Jane Roe" --days 365              # expires after a year
Options combine. Every issued key is logged to `keys/issued.log`.

Locked keys: the customer installs the app, copies the "Computer ID" shown on the activation screen,
sends it to you, and you reply with a key made with `--machine <that ID>`. Such a key does nothing on any other PC.

## Keep secret
`keys/private.pem` signs the keys. Never ship it or share it. Back it up: if it is lost you cannot issue
keys that existing installs accept. (`keys/` is git-ignored and is not packaged into the installer.)
`node scripts/keygen.mjs init` refuses to overwrite it; replacing it would invalidate every key already issued.

## Ship
`npm run dist` -> `release/PdfStudio-Setup-1.0.0.exe`. Give customers the installer + their key.
