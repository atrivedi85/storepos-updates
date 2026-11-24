# PdfStudio for Android (`android-pdfstudio/`)

A small Android app (plain Java, no extra libraries) that shows the online PdfStudio web app
(`https://trivedipos.com/pdfstudio/app/`) full screen, and adds phone features the web page cannot do alone:
save/share a file, "Open with PdfStudio", photos shared in, camera scanning, file picker, back button.

- Package: `com.trivedipos.pdfstudio`, name "PdfStudio". Separate from the Store POS app in `android/`.
- Built by `.github/workflows/android-pdfstudio.yml` on every change here, version number from `pdfstudio/package.json`
  -> GitHub release `pdfstudio-android-latest` (`PdfStudio.apk` to install, `PdfStudio.aab` for Google Play).
- Signed with the same key as the Store POS app (GitHub secrets `ANDROID_KEYSTORE_B64` / `ANDROID_KEYSTORE_PASS`, alias `storepos`).
  Without those secrets the build is signed with a debug key.
- The app needs internet (sign-in). If the page cannot load it shows `assets/offline.html` with a Try again button.
- Only `https://trivedipos.com` (and its subdomains) opens inside the app; every other link opens in the phone's browser.
- Launcher icons are made from `pdfstudio/build/icon.png` by `gen_icons.py` (needs Python + Pillow). Only re-run if the icon changes.
- Sharing PDFs/photos uses a tiny built-in provider (`ShareProvider.java`), so no AndroidX is needed.

## Contract for the web app (JavaScript)

The app adds an object `window.PdfAndroid` (only exists inside the app) and the browser's user agent ends with
` PdfStudioAndroid/<version>`. Test with `typeof window.PdfAndroid !== 'undefined'`.

Calls the web page can make (strings only; `base64` = plain base64 of the file, no line breaks, `data:` prefix tolerated):

| Call | What it does |
| --- | --- |
| `PdfAndroid.saveFile(name, base64)` | Opens Android's "Save as" screen with `name` suggested, writes the file. Then calls `window.pdfAndroidSaved(ok, message)`. `ok` is true/false; message is the file name, or "Cancelled", or an error. |
| `PdfAndroid.shareFile(name, base64)` | Opens the Android share sheet with the file. No callback. |
| `PdfAndroid.takeOpenedFile()` | Returns `""` if nothing is waiting, otherwise a JSON string `{"name":"x.pdf","mime":"application/pdf","b64":"..."}` and forgets it. `mime` is `application/pdf` or `image/*` (a photo shared in; the web app should turn it into a PDF). |
| `PdfAndroid.getVersion()` | App version text. |

Functions the web page can define (the app calls them if they exist):

- `window.pdfAndroidSaved(ok, message)` - result of `saveFile`.
- `window.pdfAndroidOpen()` - **no arguments.** The app received a new file while already running; the page must then call `PdfAndroid.takeOpenedFile()` to get it. (Big files are not pushed through JavaScript, so 20 MB PDFs work.)
- `window.pdfAndroidBack()` - called when the Back button is pressed. Return `true` if the page handled it (closed a dialog, went to a previous screen); return `false`/nothing and the app goes back in history, and closes at the first page.

The web app must also call `PdfAndroid.takeOpenedFile()` once on startup (the app may have been launched by "Open with").
It is synchronous and may take a moment for a large file.

Other notes:
- `blob:` downloads (`<a download href="blob:...">`) cannot be saved by the app. Use `PdfAndroid.saveFile` instead. Normal `http(s)` downloads go through Android's download manager.
- `<input type="file" accept="application/pdf,image/*" multiple>` works; add `capture` to offer the camera too.
- `getUserMedia({video:true})` works (the app asks for camera permission). Only video is granted, not the microphone.
- The app keeps the status/navigation bars dark (#1f2233) and pads the page below/above them itself, so `env(safe-area-inset-*)` will be 0.
