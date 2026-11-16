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

## Rules worth knowing

- Money is kept in cents. Each tax is `round(amount × percent)`, per line.
- Roles: `manager` (everything), `desk` (no setup, no night audit, adjustments up to $200), `hk` (housekeeping screen only).
- **Card numbers are never stored**: only the card type and last 4 digits. Cards are run on the card terminal.
- The first manager login is made at `/hotel` by the website owner while signed in to Ledger Desk as the owner. Managers make all other logins.
- A new hotel starts with the starter rooms, types, taxes and codes in `starterConfig()` (hotel-core.js); change them in Setup.
- Not built yet: company profiles and direct-bill accounts, group blocks, packages, rate plans by date, online booking, card terminal link.

## Test before pushing

```
node --no-warnings hotel/test/api.test.mjs "$PWD"
OWNER=1 node --no-warnings hotel/test/server.mjs "$PWD" 8791 &   then   node hotel/test/ui.test.mjs
```
