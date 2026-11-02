# Ledger Desk AI (`ledger/ai-pc/`)

The AI for trivedipos.com/books runs on the owner's AI PC (the golf sim PC, RTX 4060, Ollama with qwen2.5:7b and qwen2.5vl:7b).
`ledger-desk-ai.js` connects OUT to `wss://trivedipos.com/api/ai-pc?key=…` (no open ports), receives jobs
`{t:'job', id, path, body}` for /api/ai/categorize, ask, check, explain, review and document, runs them one at a time on Ollama,
and answers `{t:'done', id, result|error}`. It sends `{t:'status'}` every 2 minutes and `{t:'ping'}` every 30 s, and reconnects by itself.
The jobs are the same functions as Ledger Desk Server 2.0 (`server-pc/server.js`), Ollama only.

Installed on the AI PC in `%LOCALAPPDATA%\Programs\Ledger Desk Server\ledger-ai\` and run with that folder's Electron runtime
(`ELECTRON_RUN_AS_NODE=1`, via `run-ai.vbs`). `Start Ledger Desk AI.cmd` (run once) adds a Startup shortcut and starts it.
`config.json` (never in git) holds the AI PC key. The website only stores its SHA-256; make a new key with
`POST /api/admin/ai-key` as the owner (this disconnects the old one). Log: `ledger-desk-ai.log` next to the script.
