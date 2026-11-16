# Hotel Desk (`hotel/`)

The hotel front-desk system (PMS) at **https://trivedipos.com/hotel**. Our own program, built to do the same daily jobs
the hotel's old system did, in the Store POS look.

- `app/` — the screens: `index.html`, `app.js`, `style.css`.
- The server is `cloud/src/hotel.js` (the `Hotel` Durable Object) and `cloud/src/hotel-core.js` (all rules and storage).
- `test/` — `api.test.mjs` (rules), `ui.test.mjs` (clicks through every screen in Chrome), `server.mjs` (local test server).

## What it does

- **Home**: occupancy, ADR, RevPAR, arrivals/departures left, rooms available tonight by type.
- **Tape Chart**: rooms down, 14 days across. Click an empty day to book that room, a bar to open the guest. R/C/D sets Ready/Clean/Dirty.
- **Arrivals, In House, Departures**, and the Find box (last name, phone or confirmation number).
- **Reservation window**: stay, guest, payment and notes; Check In, Check Out, Undo, Cancel, Reinstate, No Show, registration card,
  confirmation letter, View Changes. **Walk-In** books and checks in at once.
- **Guest Folio**: Post Charge (taxes added by the code's tax list), Post Payment, Post Adjustment, Print. Check-out needs a zero balance
  (a manager can override).
- **Housekeeping**: condition, service (Stay Over / Check Out), housekeeper, do not disturb, notes, range edit, check-off list.
- **Reports**: arrival, departure, in-house, vacant, housekeeping check-off, guest ledger, future availability, hotel statistics,
  final transaction closeout, shift reconciliation, hotel journal, no-show/cancellation/departed lists.
- **Night Audit** (manager): posts room + tax to every in-house room, marks arrivals that never came as no shows, extends guests who
  were due out but not checked out, sets occupied rooms Dirty, saves the day's statistics and moves the business date forward.
- **Setup** (manager): property, room types and rates, rooms, taxes, posting codes, housekeepers, logins, out-of-order rooms.

## Selling it to many hotels: master account, logins, kill switch

- `cloud/src/hotel-dir.js` is the **directory**: every hotel, every login, and the **master account** (the seller).
  Each hotel's data is in its own Durable Object (`h:<hotel id>`), so hotels never see each other.
- **Master account**: made once at `/hotel` by the website owner while signed in to Ledger Desk as the owner.
  Its screen lists the hotels: Add a hotel (name, owner's name and e-mail, blank or "my hotel's 55 rooms", time zone),
  **Turn off / Turn on** (the kill switch: signs everyone at that hotel out at once and blocks sign-in and password reset;
  data is kept), Edit (paid-through date and a note, for the seller's records), Open (go in as the owner), Owner link, E-mail settings.
- **Roles**: master → owner → manager (GM) → desk, hk. The owner makes manager, desk and hk logins; a manager makes desk and hk.
- **Sign-in is by e-mail address.** A new login gets a "choose your password" link (7 days, one use), e-mailed and also shown to copy.
  "Forgot your password?" e-mails a link (60 minutes, one use, at most 3 an hour). One e-mail address = one login, in one hotel.
- **E-mail** goes out through the SMTP account the master types into E-mail settings (Gmail + app password), using Ledger Desk's `sendMail`.
- Session cookie `hd_s`, Path=/hotel, 14 days. `index.js` strips every `x-hd-*` header from browsers and adds its own.

## Rules worth knowing

- Money is kept in cents. Each tax is `round(amount × percent)`, per line.
- Inside a hotel: owner and manager can do everything; `desk` has no setup, no night audit, adjustments up to $200; `hk` only housekeeping.
- **Card numbers are never stored**: only the card type and last 4 digits. Cards are run on the card terminal.
- A new hotel starts from `starterConfig()` (hotel-core.js): blank (3 sample room types, no rooms, taxes at 0%) or the 55-room template.

## Test before pushing

```
node --no-warnings hotel/test/api.test.mjs "$PWD"
OWNER=1 node --no-warnings hotel/test/server.mjs "$PWD" 8791 &   then   node hotel/test/ui.test.mjs
```
