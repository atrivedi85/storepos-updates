# Store POS for Android (`android/`)

A small Android app (Java, WebView) that runs the same Store POS screens from `source/app/` on a tablet.
Google Play: "Store POS - Retail Register", package `com.storeposapp.pos`.

- `app/src/main/java/com/storeposapp/pos/MainActivity.java` — the tablet side: SQLite, printing (network/Bluetooth), updates, backups.
- Built by `.github/workflows/android.yml` on every change → GitHub release `android-latest` (`StorePOS.apk` for tablets, `StorePOS.aab` for Google Play).
- Signed with the key in the NAS folder `Android Signing Key (PRIVATE - do not share)` (via GitHub secrets). Never lose that key.
