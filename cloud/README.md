# Store POS Cloud Sync server

A tiny relay on Cloudflare Workers (free plan). One Durable Object per store.

- The store PC connects as the **host**; home PCs and tablets connect as **clients** (WebSocket `/v1/store/<storeId>/ws`).
- Everything is sealed with AES-256-GCM on the registers using the store's own key. The relay never has the key — it only forwards sealed messages, and keeps queued changes (`inbox`) while the store PC is off.
- Pairing: the store PC uploads a sealed offer to `/v1/pair/<hash of code>` (locked with the 8-letter code via PBKDF2, expires in 15 minutes).
- Access to a store's hub needs `HMAC(storeKey, "storepos-relay-auth")`; the hub only stores its SHA-256.

Deployed by `.github/workflows/cloud.yml` when `cloud/**` changes (needs repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).
The registers learn the server address from `cloudUrl` in `latest.json`.

## Hotel Desk (`/hotel`)

`src/hotel.js` is the `Hotel` Durable Object (one object, "main") and `src/hotel-core.js` holds all the rules and storage
(rooms, reservations, folios, housekeeping, night audit, reports, logins). `/hotel/api/*` goes to it; the screens are `hotel/app/`.
The first manager login can only be made by the website owner: `index.js` asks Ledger Desk (`/api/me`) whether the browser is
signed in there as the owner and only then lets `/hotel/api/setup` through. See `hotel/README.md`.
