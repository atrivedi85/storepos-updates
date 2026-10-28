# Store POS updates (`updates/` and `latest.json`)

Every released Store POS version as a `.posupdate` file (a gzip'd list of program files with SHA-256 checks).
`../latest.json` names the newest one; every register checks it automatically and on "Check online".
Updates never change a store's data.
