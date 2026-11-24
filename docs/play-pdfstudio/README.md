# PdfStudio on Google Play: owner checklist

Everything prepared is in this folder. Text to paste: `listing.md`. Pictures: `icon-512.png`, `feature-graphic-1024x500.png`, `1-home.png` ... `6-tools.png`.

## Before you start

1. **Review and push** this change to `main` (the website pages go live in about 1 minute through `cloud.yml`).
2. Open both pages in a browser and check they load:
   - https://trivedipos.com/pdfstudio-privacy
   - https://trivedipos.com/delete-account
   Play checks these links; the app must not be submitted before they work.
3. **Create the reviewer test account** in Ledger Desk (see "App access" in `listing.md`). No two-step sign-in on it.
4. Download the app bundle: https://github.com/atrivedi85/storepos-updates/releases/download/pdfstudio-android-latest/PdfStudio.aab
5. Read the "Things to confirm" list at the bottom.

## 1. Create the app (Play Console > Create app)

- App name: `PdfStudio – PDF Edit & Scan` (27 characters; Play's limit is 30)
- Default language: English (United States)
- App (not game), Free
- Tick the declarations (developer program policies, US export laws)

## 2. Set up your app (Dashboard > "Set up your app")

| Section | What to enter |
|---|---|
| Privacy policy | https://trivedipos.com/pdfstudio-privacy |
| App access | "Restricted": paste the instructions and the test account from `listing.md` |
| Ads | No ads |
| Content rating | Start questionnaire, category Utility/Productivity, answers in `listing.md` |
| Target audience | 18 and over only |
| Data safety | Use the table in `listing.md`; account deletion URL https://trivedipos.com/delete-account |
| Government apps, Financial features, Health | No / none |
| News app, COVID-19 | No |
| Advertising ID | The app does not use it: answer No |

## 3. Store listing (Grow users > Store presence > Main store listing)

- App name, short description and full description from `listing.md`
- App icon: `icon-512.png`
- Feature graphic: `feature-graphic-1024x500.png`
- Phone screenshots: upload the 6 files `1-home.png` to `6-tools.png` in that order
- Category: Productivity. Tags: see `listing.md`
- Contact: atrivedi2508@gmail.com, website https://trivedipos.com
- (Tablet screenshots are optional; skip them for now)

## 4. Upload the app and test it (Test and release > Testing > Closed testing)

New personal developer accounts must run a **closed test with at least 12 testers for 14 days in a row** before they can apply for production. (If your account is an organization account this may not apply; Play Console will say so.)

1. Closed testing > Create track (or use the default "Alpha") > Create new release.
2. First upload only: accept **Play App Signing**. Upload `PdfStudio.aab`. (It is signed with the same key as Store POS; Google keeps the final signing key.)
3. Release name e.g. `1.0`; release notes: "First release: edit, sign and scan PDFs."
4. Countries: choose where you want it (for example United States).
5. Testers: create an email list with at least 12 people who have a Google account. Send them the opt-in link from the track page. They must **accept the invitation and install the app**, and keep it installed for the 14 days.
6. Testers also need a Trivedi POS login to get past the sign-in screen: give each one an account (or use the reviewer account for a few).
7. Send for review. Wait for the 14 days to finish.

## 5. Go to production

1. After 14 days with 12 testers: Dashboard > **Apply for production** and answer the short questions about your testing.
2. Production > Create new release: choose "Add from library" the tested version, or upload a newer AAB.
3. Send for review (a few days to a week the first time).

## Updating the app later

Push changes to `main`; `.github/workflows/android-pdfstudio.yml` rebuilds the AAB (version number comes from `pdfstudio/package.json`; Play needs a higher version each upload). Download the new AAB and add it as a new release.

## Things to confirm (facts I could not prove from the code)

- **Email for signing links is OFF**: `RESEND_API_KEY` was removed, so signers get a link you share yourself. The policy says this. If you turn email back on, update the policy (Resend, signers' emails) and the Data safety answer.
- **Deleting an account does not yet remove "send for signature" records** in the server code (`purgeUserFiles` in `pdfstudio/worker/files.js` removes cloud files, and the admin delete removes the account and sessions, but not the `esign_*` tables, saved signatures, contacts or profile). The delete-account page promises these are deleted within 30 days, so either have Claude add that to the admin delete, or remove them by hand when a request arrives.
- Deleting a Ledger Desk user (name, hash, email) is done from the Ledger Desk Logins screen / by you; there is no self-service button.
- The policy says Cloudflare encrypts stored data at rest and that backups/logs expire "normally within 30 days". That is Cloudflare's behavior, not something in our code.
- Ledger Desk keeps the browser kind and IP address for each sign-in session (30 days); PdfStudio keeps IP only in failed-attempt records for 15 minutes and in signing records.
