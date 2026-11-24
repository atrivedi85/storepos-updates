# Store POS Cloud Sync server

A tiny relay on Cloudflare Workers (free plan). One Durable Object per store.

- The store PC connects as the **host**; home PCs and tablets connect as **clients** (WebSocket `/v1/store/<storeId>/ws`).
- Everything is sealed with AES-256-GCM on the registers using the store's own key. The relay never has the key — it only forwards sealed messages, and keeps queued changes (`inbox`) while the store PC is off.
- Pairing: the store PC uploads a sealed offer to `/v1/pair/<hash of code>` (locked with the 8-letter code via PBKDF2, expires in 15 minutes).
- Access to a store's hub needs `HMAC(storeKey, "storepos-relay-auth")`; the hub only stores its SHA-256.

Deployed by `.github/workflows/cloud.yml` when `cloud/**` changes (needs repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).
The Cloudflare key ("Edit Cloudflare Workers" token) was rolled on 2026-11-21 after the old one was found in a public repo; if it is ever rolled again, paste the new one into the `CLOUDFLARE_API_TOKEN` secret.
The registers learn the server address from `cloudUrl` in `latest.json`.

## Hotel Desk (`/hotel`)

`src/hotel.js` is the `Hotel` Durable Object (one object, "main") and `src/hotel-core.js` holds all the rules and storage
(rooms, reservations, folios, housekeeping, night audit, reports, logins). `/hotel/api/*` goes to it; the screens are `hotel/app/`.
The first manager login can only be made by the website owner: `index.js` asks Ledger Desk (`/api/me`) whether the browser is
signed in there as the owner and only then lets `/hotel/api/setup` through. See `hotel/README.md`.

## Trivedi accounts for Store POS (one account for everything)

People sign in to the Store POS back office (`/pos`) with the **same Trivedi account** as Ledger Desk and PdfStudio. No Cloud code needed.

- **Who is a member:** `cloud/src/pos.js` (runs inside the Ledger Desk object, so it uses the same logins and sessions). Tables `stores` and `store_members` (role: owner, manager, cashier, reports). Endpoints are under `/api/pos/*`; the account page uses `/api/sessions`.
- **The server never sees a store key.** Each member has a locked copy of the store key, made with that person's own Ledger Desk key pair (the same keys Ledger Desk uses to share companies). Only their browser, unlocked with their password, can open it. A person added before they have keys is "waiting"; the store PC (every few minutes) or an owner's browser then makes their locked copy.
- **Cutting someone off:** a web browser can only join a store's relay with a valid account session AND current membership (`index.js` asks Ledger Desk first). Removing a member, changing a role, signing out, signing a device out or turning a login off closes their connections at once (`posKick`); the relay also re-checks every minute. The store PC only answers a device made for an account while the relay vouches (on that very request) for the same person, so keeping the store key or an old device token gets a removed person nothing. The relay password (HMAC) and the Cloud-code pairing (`/v1/pair/…`) are unchanged.
- **Store PC** links with `/api/pos/store/link` (signed in once, then only a device token is kept; it proves it controls the store by the relay password).
- `/api/pos/internal/*` and `/v1/store/<id>/internal/*` are for the servers talking to each other and are refused from the internet.
- **Invites:** a store owner can invite by email. If the person has no account yet an ordinary Ledger Desk invite is made (7 days, with `inv.pos`), emailed if the site's invite email is set up, otherwise shown as a link to copy. Those accounts are marked `posOnly` (they cannot make Ledger Desk companies until the site owner calls `/api/admin/pos-only` with `value:false`).
- **Website pages:** `site/index.html`, `download.html`, `account.html` + `account.js`, `site.css`, `account-bar.js` (the account button, top-right on every page; `build-public.sh` adds it to `/pos` and `/books`; PdfStudio adds it in `pdfstudio/build.mjs` and its Worker pages). The sign-in page takes `?next=/path` and returns there.
- **Tests:** `node --import ./cloud/test/hooks.mjs --test cloud/test/accounts.test.mjs` runs the real Worker code in Node. `cloud/test/browser.mjs` drives Chromium (see the file header).
