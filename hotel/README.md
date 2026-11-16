# Hotel Desk (`hotel/`)

The hotel front-desk system (PMS) at **https://trivedipos.com/hotel**. Our own program, built to do the same daily jobs
the hotel's old system did, in the Store POS look.

- `app/` — the screens: `index.html`, `app.js`, `style.css`.
- The server is `cloud/src/hotel.js` (the `Hotel` Durable Object) and `cloud/src/hotel-core.js` (all rules and storage).
- `test/` — `api.test.mjs` (rules), `ui.test.mjs` (clicks through every screen in Chrome), `server.mjs` (local test server).

## Layout (Nov 16, 2026)

The header is a dark bar: our icon and hotel name, then Home, Find, View, Create, Manage, Run (thin dividers). A menu opens on hover,
click or focus: its title turns into a white tab and the links drop down in a white panel. On the right: the person's name (drop-down with
My password / Logout), the business date, the find box and, for the master, "All hotels". A line under the bar shows the hotel name on every screen.
**Reports** is a searchable page of collapsible categories in 3 columns. Click a report for its options page (description, Start/End Date
when it takes dates), then SUBMIT for the result with BACK and PRINT (`view.repStage` = list / options / result; menu links with `repGo` jump to the result).
Menu items sit in hidden drop-downs, so `ui.test.mjs` clicks them with its `go()` helper and reaches a report with `runRep()` (link, SUBMIT). The name, logo and artwork are our own.

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
  final transaction closeout, shift reconciliation, reservation activity, hotel journal, no-show and cancellation lists (see Reports below).
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

## Companies, groups, packages, rates by date, shifts, e-mail, ID scan (added Nov 16, 2026)

- **Companies** (nav): profile, optional company rate, **direct-bill account** with credit limit (owner/manager only). To bill a stay:
  pick the company in the reservation, then Folio › Post Payment › Direct Bill. That moves the amount to the company's account (`ar` table).
  Receive payment and Print statement are in the company window. Report: Accounts Receivable Aging (payments pay the oldest stays first).
- **Groups** (nav): dates, cut-off, rooms held per type, group rate per type. Held rooms are off sale to everyone else until the cut-off
  date passes or the group is cancelled. A reservation with `groupId` picks up from the block. Rooming list, Group Pickup report.
- **Rates by date** (Setup): lines of name, from, through, days, room type, rate; the last matching line wins. A reservation keeps a
  rate for each night (`r.rates`), in this order: group rate, company rate, rates by date, room type rate. Typing a rate sets
  `rateManual` and charges that one rate every night.
- **Packages** (Setup): code, name, price per night, posting code. The night audit posts it with each room charge.
- **Cashier shift** (Shift button): open with the drawer's cash, close with the counted cash; shows over/short. Setup › Property can
  make the front desk open a shift before taking payments. Report: Cashier Shifts.
- **Guest e-mails**: E-mail Confirmation (also for a cancellation) and E-mail Folio. `hotel-core.js` writes the message, `hotel.js`
  hands it to the directory, which sends it from the master's e-mail account with the hotel's name (300 a day per hotel).
- **Scan ID**: in the reservation window. Any 2D barcode scanner in keyboard mode reads the PDF417 on the back of a US/Canadian
  license (AAMVA); `parseLicense` fills name, address and license number. The birth date is not kept.
- **Not built: key encoder.** It needs the lock brand's own PMS interface, so it waits on knowing the lock system.

## Reports (document layout)

- **Sheet**: every report is drawn by `sheet(title, bodyHtml, opts)` in `app.js` on a white "paper" (max 1000px, Arial 12.5px, black on white, light grey page).
  Title (bold 20px), a header line (`Business Date`, `Property`, `Shift`, `User` = signed-in name) over a 2px rule, the tables (no colours,
  underlined 11.5px headings, numbers right aligned, negative money in parentheses, total rows with a 1px rule over the amounts), and a footer
  (`Date/Time of Printing`, `Page 1 of 1`) above a 2px rule. PRINT prints exactly this sheet (`printHtml(#repOut.innerHTML)`; print CSS is at the end of `style.css`).
  "Page 1 of 1" is fixed text: a very long report simply runs on to more printed pages.
- **Options pages** (`REP_OPTS` in `app.js`): fields, a dashed rule, "Formatting Options:" with "Generate report as .CSV file", then BACK / SUBMIT.
  With the box ticked, SUBMIT saves the report's main table as a `.csv` (Blob + `a[download]`) and stays on the options page.
  Shift Reconciliation (Date, User ID filled from that date's postings, Drawer Total, Transaction Details), Final Transaction Closeout (Date),
  Hotel Statistics (*Start, End), In House List (Sort, Room Type), Vacant Room List (Room Type, Condition, 3 checkboxes), Reservation Activity (Sort, *Start, *End, Room Type),
  Arrival / Departure (Sort). Cancellation List and No Show Report are separate reports (both read server `history`).
- **Server reports** (`report()` in `hotel-core.js`; old `closeout`, `shift`, `stats` are kept):
  - `closeout2` (`date`): per posting code (taxes count as type TAX), grouped AR, ADMIN, CASH, CRED, GFTCRD, MISC, ROOM, TAX.
    Opening = lines before the date in the same year; Today = lines on the date; Adjustments = lines on the date whose comment starts `ADJ:`;
    Net = Today (adjustments are already inside it); PTD = 1st of the month through the date; YTD = Jan 1 through the date. Only codes with a line this year are listed.
  - `shift2` (`date`, `user`, `drawer`): payment codes (CASH, CRED, AREC, GFTCRD) posted on the date, with each line (guests from `lines`, company payments from `ar`).
    Payments are negative as stored. Beginning Bank = openCash of shifts opened on that business date (for that user);
    Over/Short = drawer - beginning bank - cash taken in (minus the sum of CASH lines). Also returns `users` for the User ID box.
  - `stats2` (`from`, `to`): columns day, PTD (month to `to`), Last Year PTD, YTD, Last YTD (same dates one year earlier; zeros when there is no data).
    Rooms are summed from `audits` (plus live `stats()` for the open business date); revenue is summed from `lines` by code type.
    Total Revenue = Room + Other (MISC) + Tax; Total Payments = payment lines (negative); ADR = room revenue / rooms sold; RevPAR = room revenue / total rooms.
  - `activity` (`from`, `to`, `sort`, `type`, `tz`): reservations whose `created` time falls in the dates (read in `tz`, the browser's time zone; UTC if missing), any status.
    Room nights = nights of reservations that are not cancelled or no show.
- **Home**: the rooms bar (check ins remaining, stayovers, vacant, OOO, sized by count, min 34px) replaces the small 2x2 numbers.
  The header has a **Room #** box: Enter opens the in-house guest in that room, or says nobody is checked in.

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
