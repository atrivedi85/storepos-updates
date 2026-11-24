# PdfStudio – Google Play listing text

Copy each block into Play Console. Counts are checked (limits: name 30, short 80, full 4000).

## App details

| Field | Value |
|---|---|
| App name (27/30) | `PdfStudio – PDF Edit & Scan` |
| Default language | English (United States) |
| App or game | App |
| Free or paid | Free |
| Category | Productivity |
| Tags (pick up to 5 that Play offers) | PDF editor, Document scanner, Productivity, Office, Digital signature (use the closest ones in the list) |
| Package name | `com.trivedipos.pdfstudio` |
| Contact email | atrivedi2508@gmail.com |
| Website | https://trivedipos.com |
| Phone | (optional; leave blank) |
| Privacy policy URL | https://trivedipos.com/pdfstudio-privacy |
| Account deletion URL | https://trivedipos.com/delete-account |
| Developer | Indo American LLC (brand: Trivedi POS) |

Note: the name you first suggested, "PdfStudio – PDF Editor & Scanner", is 32 characters. Play allows 30, so use the 27-character name above. Alternatives: `PdfStudio – PDF Editor` (22), `PdfStudio: PDF Scan & Sign` (26).

## Short description (69/80)

```
Edit, sign, fill and scan PDFs. Saved signatures follow your account.
```

## Full description (2401/4000)

```
PdfStudio is a PDF editor, signer and scanner for your phone. Open a PDF, change it, sign it and send it on, all in one app.

EDIT AND MARK UP
• Edit text directly on the page
• Highlight, underline and strike through text
• Add text boxes, notes, shapes, drawings and images
• Erase or cover content you do not want

SIGN IN SECONDS
• Draw, type or upload your signature and initials once
• Your saved signatures follow your account, so they are ready on your phone, on the web and on Windows
• Place a signature or initials anywhere and resize it with your finger
• Fill in forms and add the date

SEND FOR SIGNATURE
• Place signing boxes for one or more people and send each person a private link
• Signers do not need an account or an app
• Follow who has opened and signed, send reminders, and get the finished PDF with a certificate page that records the signing steps
• Saved contacts make it quick to send again

SCAN WITH YOUR CAMERA
• Turn paper into a clean PDF with the camera scanner
• Automatic edge detection finds the page for you; drag the corners to adjust
• Choose Color, Grayscale or Black & White to make text sharp
• Scan several pages into one PDF
• Photos and scans are processed on your device until you decide to save or share them

ORGANIZE YOUR PDFS
• Reorder, rotate, delete and extract pages
• Merge several PDFs into one
• Create a PDF from photos, or start a new blank PDF

OPEN, SHARE AND KEEP YOUR FILES
• Open with PdfStudio from your files, email or other apps
• Share PDFs and photos to PdfStudio from other apps
• Save and share finished files with the usual Android screens
• Recent files open again even without internet
• Optional cloud files: keep PDFs in your private online storage and reach them from your phone, the web and Windows

YOUR ACCOUNT AND PRIVACY
PdfStudio requires a Trivedi POS account (the same login used for Ledger Desk). Accounts are created by invitation. To get one, email atrivedi2508@gmail.com. The app needs an internet connection to sign in.

There are no ads. We do not sell your information. The camera is used only for scanning. You can delete your cloud files, saved signatures and contacts in the app, or ask us to delete your whole account at any time: https://trivedipos.com/delete-account

Privacy policy: https://trivedipos.com/pdfstudio-privacy

PdfStudio is made by Indo American LLC (Trivedi POS), https://trivedipos.com
```

## Graphics (in this folder)

| Play Console slot | File | Size |
|---|---|---|
| App icon | `icon-512.png` | 512 x 512, 32-bit PNG, full square (Play rounds it) |
| Feature graphic | `feature-graphic-1024x500.png` | 1024 x 500 |
| Phone screenshots (upload all 6, in this order) | `1-home.png`, `2-edit-and-sign.png`, `3-saved-signatures.png`, `4-scan-crop.png`, `5-scan-black-and-white.png`, `6-tools.png` | 1080 x 1920 (9:16) |

The screenshots were made from the real app with sample documents (made-up names and a made-up receipt). No real personal data.

## App access (reviewers need to sign in)

Play reviewers cannot use the app without logging in, so you MUST give them a login. No credentials are written in this repo.

1. In **Ledger Desk** (https://trivedipos.com/books/) create a normal user called something like `playreview` with a strong password. Invite it from the Logins screen, accept the invite, and set a password.
2. Make sure that user does NOT have two-step sign-in switched on, and that Ledger Desk is not set to "require two-step for everyone" at review time, otherwise the reviewer cannot receive the code.
3. Play Console > Policy and programs > **App content > App access** > "All or some functionality is restricted" > Add instructions. Paste:

```
Sign-in is required. Use the test account below.
Username: <the username you created>
Password: <the password you created>
Steps: open the app, enter the username and password, tap Sign in. You land on the Home screen.
Try: Scan (allow the camera), Open PDF, Fill & Sign, Tools.
Accounts are created by invitation only; this test account is for review.
```

4. Delete or disable this test account after Play approves the app (or leave it, but change its password).

## Target audience and content

| Question | Answer |
|---|---|
| Target age group | 18 and over only (do not select any child age group) |
| Appeals to children? | No |
| Ads | No, the app contains no ads |
| Government app | No |
| Financial features | No |
| Health features | No |
| News app | No |

## Content rating (IARC questionnaire)

Category: **Utility, Productivity, Communication or Other** (not a game, not social).

| Question | Answer |
|---|---|
| Violence, blood, scary content | No |
| Sexual content or nudity | No |
| Profanity or crude humor | No |
| Controlled substances (drugs, alcohol, tobacco) | No |
| Gambling or simulated gambling | No |
| Does the app share the user's location with other users? | No |
| Do users interact or exchange content with other users? | Only privately: a user can send a document to people they choose by a private link, and those people can sign it. There is no public sharing, no chat, no feed. If the form forces a Yes/No, answer **Yes** to "users can exchange content" but **No** to "unrestricted/public". |
| Unrestricted web access | No (only trivedipos.com opens inside the app; other links open in the browser) |
| Digital purchases | No |

Expected result: Everyone / PEGI 3 / ESRB Everyone. Re-check the final rating screen; if it shows "Users Interact", that is expected for the private signing feature.

## Data safety answers

These match the privacy policy at https://trivedipos.com/pdfstudio-privacy. Answer the same way in Play Console > App content > Data safety.

**Top-level questions**

| Question | Answer |
|---|---|
| Does the app collect or share any of the required user data types? | Yes (collects) |
| Is all of the user data collected by your app encrypted in transit? | Yes (HTTPS only; the app blocks plain HTTP) |
| Do you provide a way for users to request that their data is deleted? | Yes |
| Account creation method | Username and password (invitation only) |
| Account deletion URL | https://trivedipos.com/delete-account |
| Data deletion without deleting account | Yes (users can delete cloud files, saved signatures and contacts in the app; other data on request) |
| Independent security review | No |
| Follows Play Families policy | Not applicable (18+) |

**Data types.** "Shared" = No for every row: data goes only to our own servers, hosted by Cloudflare as our service provider (Play does not count that as sharing), and to the signers the user chooses (a transfer the user starts themselves).

| Data type | Collected? | Shared? | Required or optional | Purposes | Notes |
|---|---|---|---|---|---|
| Personal info > Name | Yes | No | Required | App functionality, Account management | Display name on the account; signer names typed by the user |
| Personal info > Email address | Yes | No | Optional (account email is used for two-step codes; signers' emails are typed by the user) | App functionality, Account management | |
| Personal info > User IDs | Yes | No | Required | App functionality, Account management | Username |
| Files and docs > Files and docs | Yes | No | Optional (only if the user saves to Cloud or sends for signature) | App functionality | PDFs, signature pictures, signed copies |
| Photos and videos > Photos | Yes | No | Optional | App functionality | Declared to be safe: scanned pages or photos become part of PDFs the user chooses to upload. Nothing is uploaded unless the user saves to cloud or sends it |
| Messages > Other in-app messages | Yes | No | Optional | App functionality | The optional note a sender writes to signers |
| App activity > Other actions | Yes | No | Required for the signing feature | App functionality | Signing history (opened, signed, declined, with times) kept as the audit trail. No analytics |
| Device or other IDs | Yes | No | Required | App functionality, Fraud prevention and security | IP address and browser/device description at sign-in and signing. We do NOT collect advertising ID, IMEI or Android ID. Declaring this is the safe reading of Play's wording for IP addresses |
| Location (approximate or precise) | No | | | | IP address is not used to work out location |
| Contacts | No | | | | The app's "saved contacts" are names and emails the user typed into PdfStudio, not the phone's contact book. The app never reads the phone contacts |
| Financial info, Health and fitness, Calendar, Audio, Web browsing, Installed apps | No | | | | |
| App info and performance (crashes, diagnostics) | No | | | | No crash reporter or analytics |

Optional vs required: when Play asks "Is this data collection required or can users choose?", pick "Required" only for Name, User IDs, Device or other IDs and App activity; "Optional" for the rest.

Camera permission: not a Data safety item by itself. Images from the camera stay on the device until the user saves or sends them. Mention this in the permission explanation if Play asks.

## Things Play may ask on the Permissions page

- CAMERA: "Used only for the document scanner. Frames are processed on the device."
- INTERNET and ACCESS_NETWORK_STATE: needed to sign in and use cloud files.
