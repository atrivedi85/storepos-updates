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

## iOS look (Nov 2026)

Every screen except Home looks like iOS: `<main class="ios">` (Home gets no class) plus the pop-up windows (`#modal`). All of it is the last block of `app/style.css`,
and every rule there starts with `main.ios` or `#modal`, so the dark top bar, its menus, Home and print are untouched. Yes/no checkboxes are drawn as switches by CSS
(the code still reads the same checkboxes; tax and weekday boxes stay real checkboxes), Full/Light/None and Open/Done/All are segmented controls, Setup home is a Settings-style list
(icons are CSS `::before` per `data-tab`), and on screens up to 820px wide windows slide up as bottom sheets. Add a new Setup page: give its link an icon in the `.setcol a[data-tab=...]::before` list.

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
  - **Setup home** ("Hotel Configuration", Nov 2026) is a page of links in four columns: Hotel Settings (Property, Policies, Room Types and Rates, Rooms, Rates by Date, Packages, Rewards),
    Money (Taxes, Posting Codes), Housekeeping (Housekeepers, Out of Order Rooms), People (Logins). Each sub-page has "‹ Back to Setup". Tab keys are unchanged
    (`data-act="setupGo" data-tab=...` still deep-links). No more comma-separated textareas: types, rooms, taxes, posting codes, rates by date, packages and housekeepers are tables
    (`SD = {page, rows}` in `app.js`; `sdRead()` copies the typed values, Add/Remove redraw without losing edits, **Save** sends the whole list with `configSave`). The server's error shows beside Save (`#setupErr`).
    An empty Code is made from the name ("Two Queens" gives TQ). A room type that still has rooms cannot be removed (client and server). Posting code types the server accepts: ROOM, MISC, CASH, CRED, AREC, GFTCRD, ADMIN.
  - **Rooms** carry `nosmoke`, `accessible`, `rentLast` (all default false). Rent Last rooms sort to the end of room pickers and of the optimizer's choices; accessible rooms show a wheelchair mark in pickers. "Add Many Rooms" skips numbers that already exist.
  - **Property** adds `gm`, `city`, `state`, `zip`, `resPhone`, `fax`, `taxId`; check-in / check-out are half-hour drop-downs (still stored as `"15:00"`, shown as 3:00 PM on prints and e-mails). The letterhead and e-mail footer include city, state and ZIP.
  - **Policies** (`config.policies = {cancelHours, cancelText, deposit, hold, pets, petFee, smokingFee, other}`, cents for money; `regText` is edited here too). Printed as "Hotel Policies" on the registration card,
    the confirmation and the e-mailed confirmation. Nothing is charged automatically. An empty `cancelText` means the standard sentence built from `cancelHours`.

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
- **Scan ID**: in the reservation wizard and window (see below). Any 2D barcode scanner in keyboard mode reads the PDF417 on the back of a US/Canadian
  license (AAMVA); `parseLicense` fills name, address and license number. The birth date is not kept.
- **Not built: key encoder.** It needs the lock brand's own PMS interface, so it waits on knowing the lock system.

## Reservation wizard, Scan ID, Crib / Rollaway / Suppress Rate, Do Not Rent (added Nov 16, 2026)

- **Reservation wizard** (Create › Reservation, Create › Walk-In, a tape chart click, and "+ Reservation in this group"): four steps in the full-page
  box, one state object `ED = {mode, r, step}` (`mode` is `new` or `walkin`). The existing `r_...` field ids keep their meaning; values survive moving between steps
  and typing never redraws the page (so a click on the next button is never lost). The server is not called until the last button.
  1. **Stay Information**: *Arrival (fixed to the business date for a walk-in), *Nights, *Departure, *Rooms (always 1), *Adults, Children, Company, Pickup Group
     (groups that cover the dates), Rate Plan (BAR, or a package). **SEARCH AVAILABILITY** (needs a departure after the arrival). On the right, **Guest Search**:
     Name or Phone, FIND GUEST (the `/find` API, up to 8 past guests); a click copies name, address, phone, e-mail, guest ID, vehicle and company, never the dates.
  2. **Room & Rate**: every room type with rooms available for the dates (respecting the group's block), first-night rate ("varies" when it changes), estimated total
     (nights × nightly rates + package, plus tax) and SELECT (off at 0 available). Click a row to see its free rooms in **Assigned Room**; **Rate / night** keeps the
     typed-rate override and "Use the standard rate". A room or group preset highlights its row and shows CONTINUE.
  3. **Guest Information**: guest fields (only Last Name is required), "Notes and Special Requests" (Crib, Rollaway, Suppress Rate, No room charge, requests, notes, SCAN ID).
  4. **Payment Information**: guarantee, pays with, card type and last 4, source; **BOOK RESERVATION** (or **CHECK IN NOW** for a walk-in). A walk-in needs a room.
  The right panel lists "1 Stay Info", "2 Room & Rate Info", "3 Guest Info" with EDIT buttons that jump back. Messages go in `#r_err`.
  The server may answer 412 (room is dirty) or 428 (Do Not Rent); OK sends the same request again with `dirtyOk` / `dnrOk`, Cancel stays on the form.
- **Scan ID** (on the guest step and on the existing-reservation page): a light-blue "SCANNING PLEASE WAIT…" box with a moving stripe. An invisible focused textarea
  catches the scanner's keys; 400 ms after the last character `parseLicense()` runs. A last name fills the guest fields (never the stay) and closes the box; anything
  else shows "That did not read as an ID barcode…" and keeps waiting. "Cancel" closes it; "Type or paste instead" shows the textarea and a "Fill in the guest" button.
- **Crib, Rollaway, Suppress Rate**: booleans on the reservation (`resSave`). With Suppress Rate on, the registration card, the confirmation letter and the e-mailed
  confirmation say "Rate: on file" instead of the amount. The Housekeeping screen (and its check-off list) shows "Crib" / "Rollaway" in front of the Notes text of a room whose
  in-house guest has them (read-only).
- **Do Not Rent list** (`dnr` table; Manage › Do Not Rent List): name, guest ID, phone, reason, who and when. Owner, manager and front desk add (a reason and a last name or
  guest ID are needed); only owner and manager remove; housekeeping gets no list at all. **A match** is the same guest ID (letters and digits only, any case, both not empty)
  or the same last name AND first name (trimmed, any case, both not empty). Making a new reservation, a walk-in or a check-in for a match answers **428** with
  "DO NOT RENT: LAST, FIRST. Reason: … Added by … on M/D/YYYY. Continue anyway?"; the same request with `dnrOk: true` goes through and adds the history line
  "Do Not Rent warning accepted". The wizard's guest step and the existing-reservation page show a red "DO NOT RENT: reason" banner while the typed or saved name / guest ID
  matches. The reservation page has "Add to Do Not Rent List" (asks for the reason) and, for owner and manager, "Remove from Do Not Rent List". The list screen has Quick Search,
  "+ Add" and "Export .CSV".

## Recurring charges, rooming lists, quick links and more (added Nov 16, 2026)

1. **Recurring charges.** A reservation has `recur: [{code, amount, comment, from, to}]` (at most 10); a group has the same list, saved with `groupSave` (field `recur`),
   and it applies to every reservation in the group (not when the group is cancelled). The code must be a posting code of type ROOM or MISC; the amount is above zero (cents);
   `from` / `to` default to the stay (arrival to departure date). The night audit posts, for every in-house reservation, each charge (its own first, then its group's) whose
   `from <= business date <= to`, through `postCharge` (taxes follow the code), comment "Recurring: <comment or code name>", and counts them in the audit result as `recurring`.
   Ops: `recurAdd` {id, code, amount, comment, from?, to?}, `recurRemove` {id, index}. Screen: "Recurring Charges" in Actions (reservation page and folio, window with an add row);
   the group window has the same small list (saved with Save). The night-audit message ends with "Recurring charges posted: n".
2. **Room Blocking (bulk out of order).** Op `blockAddMany` {rooms, start, end, reason}: validates like `blockAdd`; if any room has a guest or reservation in those dates nothing is
   blocked and the answer is 409 with `rooms` listing them. The window has From room / To room (hotel room order), an "Only floor" filter with "Select all on this floor",
   From / Through, Reason, and under it the current blocks: "Put back in order" per row and "Put ALL back in order" for rows with the same reason and dates (`blockRemove` for each).
3. **Room assignment optimizer.** Op `optimize` {date, apply}. Takes reserved reservations with no room that arrive on `date` (default the business date), oldest first, and proposes a free room
   of the same type for the whole stay: Ready before Clean before Dirty, then the room with the fewest past stays (`out` or `inhouse`), then the one vacated longest ago, then room number.
   Never a room with an out-of-order block or an overlapping reservation (rooms proposed earlier in the same plan count). Returns `plan: [{id, name, type, room|null, reason}]`; `apply: true`
   saves the rooms (history "Room assigned by optimizer") and returns `assigned`. Screen: Tape Chart side panel "Optimize Room Assignments?" (Start Date, RUN) opens the plan; ASSIGN ROOMS applies it.
4. **Quick links on Home.** `configSave` takes `quickLinks`: a list of link keys (at most 14; an empty list goes back to the default). `TILES` in `app.js` is the catalogue (the 14 default tiles plus
   Night Audit, Future Availability, Do Not Rent List, Find Reservation, Hotel Configuration, Manage Rates, Packages, Logins, Cancellation List, Arrival List Report); manager-only tiles are hidden for
   desk logins. Owner / manager see a blue EDIT button on the dark band: Shown (up, down, Remove) and Available (Add), Save, Reset to default.
5. **Returning guests.** `GET /guest?last=&first=&phone=&guestId=&except=` (front desk roles): up to 20 past reservations of the same guest (same guest ID letters/digits, or same last + first name,
   or same phone digits when 7 or more), any status, newest first, each {conf, arrive, depart, room, type, rate, status, notes, requests, balance}. `count` and `nights` count only stays that happened
   (out or in house); `total` counts every match; `lastNote` is the newest stay's notes and requests; `last` is that stay. The wizard (guest step, after the names are left or a guest is picked / scanned)
   and the reservation page show a blue banner "Returning guest: n stays, n nights. Last stay <date>, room <no>." with View history and the quoted note. Checking in a reservation that has notes or
   special requests first opens a "Guest notes" window ("Continue check-in" or Cancel).
6. **Rolling cut-off.** A group may have `cutoffDays` (0 to 365) instead of the fixed `cutoff` date (sending one clears the other). Each night is released once the business date is later than
   night minus `cutoffDays` (`groupReleased` in the server, `grpGone` in `app.js`). The group window has the choice (Fixed date / Rolling); the Groups list and the pickup report show "Rolling, 14 days".
7. **Import a rooming list.** Group window, "Import Rooming List": one guest per line, `Last, First, Room type, Arrival, Departure, Adults, Phone, E-mail` (commas or tabs, heading line allowed; only Last is needed;
   no type = the group's first blocked type; no dates = the group's dates, or today when the group has started; dates as YYYY-MM-DD or M/D/YYYY). "Check" shows each line as OK or its problem (checked on the
   screen against what the hotel has); "Create n reservations" sends the good lines. Op `groupImport` {id, rows, up to 200} books each line through `resSave` (group rate, availability and block rules, Do Not Rent
   is reported, not booked) and answers `created` and `problems: [{line, name, error}]`; good lines are booked even when others fail.
8. **Housekeeping on a phone.** Under 700px wide the Housekeeping screen shows a card for each room (big room number, type, Occupied / Vacant, service, Ready / Clean / Dirty buttons at least 48px tall,
   Do not disturb switch, notes) with a sticky filter row (floor, "Dirty only"); the housekeeping login's header is one bar (hotel name, date, Logout). Home tiles, lists, tape chart and the wizard fit a
   390px screen (tables scroll inside their own box).

## Cleaning schedules and work orders (added Nov 23, 2026)

- **Cleaning Schedules** (Setup › Housekeeping): `config.cleanSchedules = [{id, name, days: ['F'|'L'|'N', ...]}]` (Full / Light / None; 7 days, "Show more days" gives 14; the pattern repeats).
  Every hotel starts with "Traditional" (all Full), added on load when missing. Each room has `sched` (a schedule id; missing or unknown = the first schedule). Setup › Rooms and the Add Room / Add Many Rooms windows
  have a "Cleaning Schedule" column. A schedule that rooms still use, or the last one, cannot be deleted (screen and `configSave` both say which rooms). `service(no)` in `app.js`: an in-house room not due out shows
  "Stay Over – Full / Light / No service" using nights stayed so far (business date minus arrival): night 1 is the first day of the pattern; the arrival day itself is "No service". Used by the housekeeping board, phone cards, check-off list and report.
- **Work orders**: `config.woReasons = [{name, active}]` (Setup › Housekeeping › Work Order Reasons; 11 starters). Table `work_orders` (id, room, reason, notes, status open/done, created_at, created_by, created_bdate, done_at, done_by, ooo_block_id).
  Ops `woAdd` {room, reason, notes, ooo?: {start, end}} and `woDone` {id, putBack} work for every login including housekeeping; only desk/managers may send `ooo` (makes the usual out-of-order block, reason "Work order: ...") or `putBack`.
  `state().workorders` = all open plus the last 300 done. Screens: "Work Order" button on each housekeeping row/card, Work Orders page (Manage menu, Home tile, button on the housekeeping screen; Open / Done / All, Mark done),
  a wrench mark next to the room on the tape chart, housekeeping board and room pickers. Report "Maintenance Report" (`/report?name=maintenance&from&to&all`) under Housekeeping Reports.

## Rewards program (added Nov 16, 2026)

A guest rewards program each hotel runs for its own guests. Off until the owner or a manager turns it on in **Setup › Rewards**. While it is off, none of its
rows, columns, menu items or reports show, and the server refuses enrolling, linking, adjusting and redeeming.

- **Settings** (config key `rewards`, saved with `configSave`, owner/manager only): `enabled`, `name` (default "Guest Rewards"), `earn` (`nights` or `revenue`),
  `perNight` (100), `perDollar` (10), `pointValue` (cents per point when redeemed, 1), `minRedeem` (1000), `tiers` (1 to 6 of `{name, min, message <= 200, amenity <= 80}`; default Member 0,
  Silver 2000, Gold 6000, Platinum 15000). Checks: the numbers are whole and 0 or more, tier names are different and not empty, tier minimums are different, the first tier starts at 0
  (tiers are sorted by `min`). Longer messages are cut, not refused. Turning it on (or saving posting codes while it is on) adds the posting code `RW` "Rewards Redemption" (type GFTCRD) if it is missing.
  The Setup tab has simple fields and one line per tier: `name, minimum points, welcome amenity, message` (the message may contain commas).
- **Members** (table `members`): `number` (`R` + 6 digits, from R100001), `last`, `first`, `phone`, `email`, `guestId`, `joined` (business date), `points` (balance), `earned` (lifetime),
  `nights`, `revenue` (cents), `stays`, `log` (last 100 `{at, bdate, by, what, points, res?}`). Tier = the highest tier whose `min` is at most `earned`.
- **Ops**: `memberSave` {id?, last, first, phone, email, guestId} (last name needed; refused when another member has the same guest ID, or the same last + first + phone digits);
  `memberAdjust` {id, points (+/-), reason} (owner/manager; reason needed; the balance cannot go below 0; changes `points` only, not `earned`, so it never changes the tier);
  `memberLink` {res, member} and `memberUnlink` {res} set or clear `memberId` / `memberNo` on a reservation (`resSave` also takes `memberId`; 0 clears it). `checkIn` takes `amenityGiven: true`
  (stored on the reservation with a history line). `GET /member?id=` gives `{member (with tier), tier, tierInfo, next, log}`; `GET /members?q=` searches number, name, phone (up to 100).
  `state()` carries `rewards` and, for owner, manager and desk (not housekeeping) while the program is on, `members`: `[{id, number, last, first, phone, guestId, points, earned, tier, nights, stays, revenue, joined}]` (newest 2000).
  `GET /report?name=rewards` gives all members (best lifetime points first), per-tier totals and the value of all outstanding points.
- **Earning** (at `checkOut`, once per reservation): a night counts when the net Room Charge (RM) lines of that business date are above zero; revenue is the net sum of RM lines (never below 0).
  `nights` mode: nights x `perNight`. `revenue` mode: whole dollars of revenue x `perDollar`. Adds to `points` and `earned`, `nights`, `revenue`, `stays` + 1, logs "Stay <conf>: +N points" and keeps
  `rwEarned {points, nights, revenue}` on the reservation. `undoCheckOut` takes exactly that back (never below 0, log "Check-out undone: −N points") and clears `rwEarned`.
- **Redeeming**: Folio › Post Payment › "Rewards Redemption" (listed only when the guest's member has at least `minRedeem` points and the balance can take at least that many). `post` with code `RW`,
  `kind: 'payment'` and `points`: needs the reservation's member, `points` at least `minRedeem`, at most the member's points, and `points x pointValue` at most the folio balance. It posts a payment of
  `points x pointValue` cents (comment "<points> points, member <number>"), subtracts the points and logs "Redeemed N points on <conf>". Redeemed points do not earn (only RM lines earn).
- **Screens**: "Rewards Program:" row on wizard step 3 and the reservation page (matching member by guest ID, name or phone, "Use this member", or "Select Program / Enroll" with search and "Enroll <name>");
  Actions "Rewards Member" and "Remove from Rewards"; tier, message and "Welcome amenity given" box in the check-in "Guest notes" window; "Rewards" column on Arrivals, In House and the In House List report;
  Manage › Rewards Members (`data-nav="members"`) with the member window and, for owner and manager, "Adjust points"; reports "Rewards Program Members" and "Rewards Program Statistics" (Front Desk Reports).
- **Worked example** (defaults, `earn: nights`): Ann is a member (R100001, 0 points). She stays 2 nights at 80.00 and checks out: 2 nights x 100 = **200 points** (Member). Later stays bring her lifetime points to 2,010: she is **Silver**.
  The manager adds 1,500 points for a service mistake (balance 3,510). On a new stay her folio balance is 88.19: she redeems 3,000 points (`pointValue` 1) = a payment of **30.00**, balance 58.19, points left 510.
  With `earn: revenue`, a night of 81.00 net room revenue earns floor(8100 / 100) = 81 dollars x 10 = **810 points**. An adjustment of 10.00 on the same date makes it 71 x 10 = 710.

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
