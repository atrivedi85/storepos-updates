package com.storeposapp.pos;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteProgram;
import android.database.sqlite.SQLiteStatement;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * Store POS for Android.
 * The POS screens are the same web app the Windows version runs (index.html), served from
 * https://app.storepos/ inside a full-screen WebView. This class gives it a SQLite database,
 * receipt printing (network / Bluetooth / Android printing), backups, and online updates from
 * the same update channel as Windows (latest.json + .posupdate files).
 */
public class MainActivity extends Activity {
    static final String HOST = "app.storepos";
    static final String ORIGIN = "https://" + HOST + "/";
    static final String UPDATE_URL = "https://raw.githubusercontent.com/atrivedi85/storepos-updates/main/latest.json";
    static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    static final int REQ_RESTORE = 41, REQ_BT = 42;

    WebView web;
    SQLiteDatabase db;
    SharedPreferences prefs;
    Handler ui;
    final ExecutorService pool = Executors.newCachedThreadPool();
    final Map<String, SQLiteStatement> stmts = new HashMap<>();
    volatile boolean useCurrent = false;
    JSONObject lastManifest = null;
    WebView printView;
    int restoreCb = -1;

    // ---------- lifecycle ----------
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        ui = new Handler(Looper.getMainLooper());
        prefs = getSharedPreferences("storepos", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        openDb();
        pickWebRoot();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.addJavascriptInterface(new Bridge(), "AndroidPOS");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return serve(u.getPath());
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        setContentView(web);
        hideBars();
        web.loadUrl(ORIGIN + "index.html");
        ui.postDelayed(updateCheck, 60_000);
    }

    final Runnable updateCheck = new Runnable() {
        @Override public void run() {
            pool.submit(() -> {
                try {
                    JSONObject r = checkUpdate();
                    if (r.optJSONObject("available") != null) {
                        String j = r.getJSONObject("available").toString();
                        ui.post(() -> web.evaluateJavascript("window.__posUpd&&window.__posUpd(" + JSONObject.quote(j) + ")", null));
                    }
                } catch (Exception ignored) { }
            });
            ui.postDelayed(this, 6 * 3600_000L);
        }
    };

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideBars();
    }

    @SuppressWarnings("deprecation")
    void hideBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {   // Back closes pop-ups instead of leaving the POS
            web.evaluateJavascript("(function(){var b=document.querySelector('.mback');if(b&&typeof closeModal==='function')closeModal();})()", null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ---------- database ----------
    void openDb() {
        db = openOrCreateDatabase("pos.db", MODE_PRIVATE, null);
        db.enableWriteAheadLogging();
    }

    void bind(SQLiteProgram p, JSONArray a) throws Exception {
        if (a == null) return;
        for (int i = 0; i < a.length(); i++) {
            Object v = a.get(i);
            int k = i + 1;
            if (v == null || v == JSONObject.NULL) p.bindNull(k);
            else if (v instanceof Integer || v instanceof Long) p.bindLong(k, ((Number) v).longValue());
            else if (v instanceof Number) p.bindDouble(k, ((Number) v).doubleValue());
            else if (v instanceof Boolean) p.bindLong(k, ((Boolean) v) ? 1 : 0);
            else p.bindString(k, v.toString());
        }
    }

    String query(String sql, String params) {
        try {
            final JSONArray a = new JSONArray(params == null || params.isEmpty() ? "[]" : params);
            Cursor c = db.rawQueryWithFactory((d, driver, table, q) -> {
                try { bind(q, a); } catch (Exception e) { throw new RuntimeException(e); }
                return new SQLiteCursor(driver, table, q);
            }, sql, null, null);
            JSONArray rows = new JSONArray();
            try {
                int n = c.getColumnCount();
                while (c.moveToNext()) {
                    JSONObject r = new JSONObject();
                    for (int i = 0; i < n; i++) {
                        String col = c.getColumnName(i);
                        switch (c.getType(i)) {
                            case Cursor.FIELD_TYPE_NULL: r.put(col, JSONObject.NULL); break;
                            case Cursor.FIELD_TYPE_INTEGER: r.put(col, c.getLong(i)); break;
                            case Cursor.FIELD_TYPE_FLOAT: r.put(col, c.getDouble(i)); break;
                            case Cursor.FIELD_TYPE_BLOB: r.put(col, Base64.encodeToString(c.getBlob(i), Base64.NO_WRAP)); break;
                            default: r.put(col, c.getString(i));
                        }
                    }
                    rows.put(r);
                }
            } finally { c.close(); }
            return new JSONObject().put("rows", rows).toString();
        } catch (Exception e) { return err(e); }
    }

    SQLiteStatement stmt(String sql) {
        SQLiteStatement s = stmts.get(sql);
        if (s == null) { s = db.compileStatement(sql); stmts.put(sql, s); }
        return s;
    }

    synchronized String execOne(String sql, String params) {
        try {
            SQLiteStatement s = stmt(sql);
            s.clearBindings();
            bind(s, new JSONArray(params == null || params.isEmpty() ? "[]" : params));
            s.execute();
            return "{\"ok\":true}";
        } catch (Exception e) { return err(e); }
    }

    synchronized String execBatch(String json) {
        try {
            JSONArray list = new JSONArray(json);
            db.beginTransaction();
            try {
                for (int i = 0; i < list.length(); i++) {
                    JSONArray it = list.getJSONArray(i);
                    SQLiteStatement s = stmt(it.getString(0));
                    s.clearBindings();
                    bind(s, it.optJSONArray(1));
                    s.execute();
                }
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return "{\"ok\":true}";
        } catch (Exception e) { return err(e); }
    }

    static String err(Exception e) {
        try { return new JSONObject().put("ok", false).put("error", String.valueOf(e.getMessage() != null ? e.getMessage() : e.toString())).toString(); }
        catch (Exception x) { return "{\"ok\":false,\"error\":\"error\"}"; }
    }

    // ---------- serving the web app ----------
    File wwwDir() { return new File(getFilesDir(), "www"); }
    File curDir() { return new File(wwwDir(), "current"); }
    File prevDir() { return new File(wwwDir(), "previous"); }

    String bundledVersion() {
        try (InputStream in = getAssets().open("www/package.json")) { return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)).optString("version", "0"); }
        catch (Exception e) { return "0"; }
    }
    static String dirVersion(File d) {
        try (InputStream in = new FileInputStream(new File(d, "package.json"))) { return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)).optString("version", "0"); }
        catch (Exception e) { return "0"; }
    }
    void pickWebRoot() {
        File c = curDir();
        useCurrent = new File(c, "index.html").exists() && verGt(dirVersion(c), bundledVersion());
    }
    String webVersion() { return useCurrent ? dirVersion(curDir()) : bundledVersion(); }

    WebResourceResponse serve(String path) {
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        String p = path.startsWith("/") ? path.substring(1) : path;
        if (p.contains("..")) return notFound();
        String mime = mimeOf(p);
        try {
            InputStream in = null;
            if (useCurrent) { File f = new File(curDir(), p); if (f.isFile()) in = new FileInputStream(f); }
            if (in == null) in = getAssets().open("www/" + p);
            WebResourceResponse r = new WebResourceResponse(mime, mime.startsWith("text") || mime.contains("javascript") || mime.contains("json") ? "utf-8" : null, in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception e) { return notFound(); }
    }
    static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }
    static String mimeOf(String p) {
        String l = p.toLowerCase(Locale.US);
        if (l.endsWith(".html")) return "text/html";
        if (l.endsWith(".js") || l.endsWith(".mjs")) return "application/javascript";
        if (l.endsWith(".css")) return "text/css";
        if (l.endsWith(".json")) return "application/json";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".svg")) return "image/svg+xml";
        if (l.endsWith(".ico")) return "image/x-icon";
        if (l.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    // ---------- updates (same files as Windows) ----------
    static boolean verGt(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? parseInt(x[i]) : 0, q = i < y.length ? parseInt(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }
    static int parseInt(String s) { try { return Integer.parseInt(s.replaceAll("[^0-9]", "")); } catch (Exception e) { return 0; } }

    static byte[] httpGet(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(60000); c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache");
        int code = c.getResponseCode();
        if (code != 200) throw new Exception("HTTP " + code);
        try (InputStream in = c.getInputStream()) { return readAll(in); } finally { c.disconnect(); }
    }
    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] buf = new byte[65536]; int n;
        while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        return o.toByteArray();
    }
    static String sha256(byte[] b) throws Exception {
        byte[] h = MessageDigest.getInstance("SHA-256").digest(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : h) sb.append(String.format("%02x", x));
        return sb.toString();
    }
    String updateUrl() { String u = prefs.getString("updateUrl", ""); return u.startsWith("https://") ? u : UPDATE_URL; }

    JSONObject checkUpdate() throws Exception {
        String base = updateUrl();
        JSONObject m = new JSONObject(new String(httpGet(base + "?t=" + System.currentTimeMillis()), StandardCharsets.UTF_8));
        if (!m.has("version") || !m.has("url")) throw new Exception("not a Store POS update list");
        m.put("base", base);
        JSONObject r = new JSONObject().put("ok", true);
        if (verGt(m.getString("version"), webVersion())) { lastManifest = m; r.put("available", m); } else r.put("available", JSONObject.NULL);
        return r;
    }

    JSONObject downloadUpdate() throws Exception {
        if (lastManifest == null) { JSONObject c = checkUpdate(); if (lastManifest == null) return new JSONObject().put("ok", false).put("error", "You already have the latest version"); }
        JSONObject m = lastManifest;
        String url = new URL(new URL(m.getString("base")), m.getString("url")).toString();
        byte[] raw = httpGet(url + "?t=" + System.currentTimeMillis());
        String want = m.optString("sha256", "");
        if (!want.isEmpty() && !want.equalsIgnoreCase(sha256(raw))) throw new Exception("Download was damaged — try again");
        JSONObject u;
        try (InputStream in = new GZIPInputStream(new ByteArrayInputStream(raw))) { u = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)); }
        if (!"storepos-update".equals(u.optString("format")) || !u.has("files")) throw new Exception("That is not a Store POS update file");
        if (!verGt(u.getString("version"), webVersion())) throw new Exception("You already have version " + webVersion());
        JSONObject files = u.getJSONObject("files");
        if (!files.has("index.html")) throw new Exception("The update file is incomplete");
        File next = new File(wwwDir(), "next");
        deleteTree(next); next.mkdirs();
        Iterator<String> it = files.keys();
        while (it.hasNext()) {
            String name = it.next();
            if (name.contains("..") || name.startsWith("/")) throw new Exception("Bad file name in update");
            if (name.equals("main.js") || name.equals("preload.js") || name.endsWith(".ico") || name.startsWith("first-run")) continue; // Windows-only files
            JSONObject f = files.getJSONObject(name);
            byte[] b = Base64.decode(f.getString("b64"), Base64.DEFAULT);
            if (!f.optString("sha256", "").equalsIgnoreCase(sha256(b))) throw new Exception("The update file is damaged (" + name + ")");
            File out = new File(next, name);
            out.getParentFile().mkdirs();
            try (OutputStream o = new FileOutputStream(out)) { o.write(b); }
        }
        // the update replaces only program files; anything the update doesn't include (e.g. lib/) comes from the version in use
        copyMissing(useCurrent ? curDir() : null, next);
        backupDb("before-update");
        deleteTree(prevDir());
        if (curDir().exists()) curDir().renameTo(prevDir());
        next.renameTo(curDir());
        pickWebRoot();
        ui.postDelayed(() -> web.reload(), 900);
        return new JSONObject().put("ok", true).put("version", u.getString("version"));
    }

    void copyMissing(File from, File to) throws Exception {
        String[] need = {"lib/pdf.js", "lib/pdf.worker.js", "android-shim.js", "icon.png"};
        for (String n : need) {
            File t = new File(to, n);
            if (t.exists()) continue;
            t.getParentFile().mkdirs();
            InputStream in = null;
            if (from != null && new File(from, n).isFile()) in = new FileInputStream(new File(from, n));
            else { try { in = getAssets().open("www/" + n); } catch (Exception ignored) { } }
            if (in == null) continue;
            try (InputStream i2 = in; OutputStream o = new FileOutputStream(t)) { o.write(readAll(i2)); }
        }
    }

    JSONObject undoUpdate() throws Exception {
        File cur = curDir(), prev = prevDir();
        File gone = new File(wwwDir(), "removed");
        deleteTree(gone);
        if (cur.exists()) cur.renameTo(gone);
        if (prev.exists()) prev.renameTo(cur);
        pickWebRoot();
        ui.postDelayed(() -> web.reload(), 600);
        return new JSONObject().put("ok", true);
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    // ---------- printing ----------
    JSONObject tcpPrint(String host, int port, byte[] data) throws Exception {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), 7000);
            s.setSoTimeout(7000);
            OutputStream o = s.getOutputStream();
            o.write(data); o.flush();
            Thread.sleep(250);
        }
        return new JSONObject().put("ok", true);
    }

    boolean btAllowed() {
        if (Build.VERSION.SDK_INT < 31) return true;
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) return true;
        ui.post(() -> requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQ_BT));
        return false;
    }

    @SuppressWarnings("MissingPermission")
    JSONObject btDevices() throws Exception {
        if (!btAllowed()) return new JSONObject().put("ok", false).put("error", "Allow Store POS to use Bluetooth (tap Allow), then tap Refresh list.");
        BluetoothAdapter a = BluetoothAdapter.getDefaultAdapter();
        if (a == null) return new JSONObject().put("ok", false).put("error", "This tablet has no Bluetooth.");
        if (!a.isEnabled()) return new JSONObject().put("ok", false).put("error", "Bluetooth is off. Turn it on in Android settings.");
        JSONArray list = new JSONArray();
        Set<BluetoothDevice> bonded = a.getBondedDevices();
        if (bonded != null) for (BluetoothDevice d : bonded) list.put(new JSONObject().put("name", d.getName() == null ? "" : d.getName()).put("address", d.getAddress()));
        return new JSONObject().put("ok", true).put("devices", list);
    }

    @SuppressWarnings("MissingPermission")
    JSONObject btPrint(String addr, byte[] data) throws Exception {
        if (!btAllowed()) return new JSONObject().put("ok", false).put("error", "Allow Store POS to use Bluetooth, then print again.");
        BluetoothAdapter a = BluetoothAdapter.getDefaultAdapter();
        if (a == null || !a.isEnabled()) return new JSONObject().put("ok", false).put("error", "Bluetooth is off");
        BluetoothDevice d = a.getRemoteDevice(addr);
        try { a.cancelDiscovery(); } catch (Exception ignored) { }
        BluetoothSocket s = null;
        try {
            try { s = d.createRfcommSocketToServiceRecord(SPP); s.connect(); }
            catch (Exception first) { try { if (s != null) s.close(); } catch (Exception ignored) { } s = d.createInsecureRfcommSocketToServiceRecord(SPP); s.connect(); }
            OutputStream o = s.getOutputStream();
            for (int i = 0; i < data.length; i += 512) { o.write(data, i, Math.min(512, data.length - i)); o.flush(); Thread.sleep(15); }
            Thread.sleep(400);
        } finally { try { if (s != null) s.close(); } catch (Exception ignored) { } }
        return new JSONObject().put("ok", true);
    }

    void printHtml(String html, String title) {
        ui.post(() -> {
            WebView pw = new WebView(this);
            printView = pw;
            pw.getSettings().setJavaScriptEnabled(false);
            pw.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView v, String url) {
                    PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
                    PrintDocumentAdapter ad = v.createPrintDocumentAdapter(title);
                    pm.print(title, ad, new PrintAttributes.Builder().build());
                }
            });
            pw.loadDataWithBaseURL(ORIGIN, html, "text/html", "utf-8", null);
        });
    }

    // ---------- files & backups ----------
    String saveToDownloads(String name, byte[] data, String mime) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.MIME_TYPE, mime);
            v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/StorePOS");
            ContentResolver cr = getContentResolver();
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("Could not create the file");
            try (OutputStream o = cr.openOutputStream(uri)) { o.write(data); }
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "StorePOS");
            dir.mkdirs();
            try (OutputStream o = new FileOutputStream(new File(dir, name))) { o.write(data); }
        }
        return "Download/StorePOS/" + name;
    }

    synchronized byte[] dbBytes() throws Exception {
        Cursor c = db.rawQuery("PRAGMA wal_checkpoint(FULL)", null);
        c.moveToFirst(); c.close();
        try (InputStream in = new FileInputStream(getDatabasePath("pos.db"))) { return readAll(in); }
    }

    JSONObject backupDb(String tag) {
        try {
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
            File dir = new File(getFilesDir(), "backups"); dir.mkdirs();
            byte[] b = dbBytes();
            try (OutputStream o = new FileOutputStream(new File(dir, "pos-" + tag + "-" + stamp + ".db"))) { o.write(b); }
            File[] all = dir.listFiles();
            if (all != null && all.length > 10) { java.util.Arrays.sort(all); for (int i = 0; i < all.length - 10; i++) all[i].delete(); }
            return new JSONObject().put("ok", true);
        } catch (Exception e) { try { return new JSONObject().put("ok", false).put("error", e.getMessage()); } catch (Exception x) { return new JSONObject(); } }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_RESTORE) return;
        final int cb = restoreCb; restoreCb = -1;
        if (res != RESULT_OK || data == null || data.getData() == null) { reply(cb, "{\"ok\":false,\"canceled\":true}"); return; }
        final Uri uri = data.getData();
        pool.submit(() -> {
            try {
                byte[] b;
                try (InputStream in = getContentResolver().openInputStream(uri)) { b = readAll(in); }
                if (b.length < 100 || !new String(b, 0, 15, StandardCharsets.US_ASCII).equals("SQLite format 3")) { reply(cb, "{\"ok\":false,\"error\":\"That is not a Store POS backup (.db) file\"}"); return; }
                backupDb("before-restore");
                synchronized (this) {
                    for (SQLiteStatement s : stmts.values()) s.close();
                    stmts.clear();
                    db.close();
                    File f = getDatabasePath("pos.db");
                    new File(f.getPath() + "-wal").delete();
                    new File(f.getPath() + "-shm").delete();
                    try (OutputStream o = new FileOutputStream(f)) { o.write(b); }
                    openDb();
                }
                reply(cb, "{\"ok\":true}");
                ui.postDelayed(() -> web.reload(), 800);
            } catch (Exception e) { reply(cb, err(e)); }
        });
    }

    // ---------- bridge for the web app ----------
    void reply(int id, String json) {
        if (id < 0) return;
        ui.post(() -> web.evaluateJavascript("window.__posCb&&window.__posCb(" + id + "," + JSONObject.quote(json) + ")", null));
    }

    JSONObject dispatch(int id, String m, JSONObject a) throws Exception {
        switch (m) {
            case "tcp": return tcpPrint(a.getString("host"), a.optInt("port", 9100), Base64.decode(a.getString("b64"), Base64.DEFAULT));
            case "bt": return btPrint(a.getString("addr"), Base64.decode(a.getString("b64"), Base64.DEFAULT));
            case "btDevices": return btDevices();
            case "openBtSettings": ui.post(() -> { try { startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); } catch (Exception ignored) { } }); return new JSONObject().put("ok", true);
            case "printHtml": printHtml(a.getString("html"), a.optString("title", "Store POS")); return new JSONObject().put("ok", true);
            case "saveFile": return new JSONObject().put("ok", true).put("path", saveToDownloads(a.getString("name").replaceAll("[\\\\/:*?\"<>|]", "_"), Base64.decode(a.getString("b64"), Base64.DEFAULT), a.optString("mime", "application/octet-stream")));
            case "saveInternal": {
                File dir = new File(getFilesDir(), a.optString("dir", "files").replaceAll("[^a-zA-Z0-9_-]", ""));
                dir.mkdirs();
                File f = new File(dir, System.currentTimeMillis() + "-" + a.getString("name").replaceAll("[^\\w. -]", "_"));
                try (OutputStream o = new FileOutputStream(f)) { o.write(Base64.decode(a.getString("b64"), Base64.DEFAULT)); }
                return new JSONObject().put("ok", true).put("path", f.getAbsolutePath());
            }
            case "backup": {
                String stamp = new SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US).format(new Date());
                String path = saveToDownloads("pos-backup-" + stamp + ".db", dbBytes(), "application/octet-stream");
                return new JSONObject().put("ok", true).put("path", path);
            }
            case "restore": {
                restoreCb = id;
                ui.post(() -> {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    startActivityForResult(i, REQ_RESTORE);
                });
                return null; // answered later
            }
            case "checkUpdate": return checkUpdate();
            case "downloadUpdate": return downloadUpdate();
            case "undoUpdate": return undoUpdate();
        }
        return new JSONObject().put("ok", false).put("error", "Unknown action " + m);
    }

    class Bridge {
        @JavascriptInterface public String sql(String q, String p) { return query(q, p); }
        @JavascriptInterface public String exec(String q, String p) { return execOne(q, p); }
        @JavascriptInterface public String execBatch(String json) { return MainActivity.this.execBatch(json); }
        @JavascriptInterface public String getPref(String k) { return prefs.getString("p_" + k, ""); }
        @JavascriptInterface public void setPref(String k, String v) { prefs.edit().putString("p_" + k, v).apply(); }
        @JavascriptInterface public String deviceId() { String s = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID); return s == null ? "unknown" : s; }
        @JavascriptInterface public String shellVersion() { try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; } }
        @JavascriptInterface public String webVersion() { return MainActivity.this.webVersion(); }
        @JavascriptInterface public String bundledVersion() { return MainActivity.this.bundledVersion(); }
        @JavascriptInterface public boolean hasPrevious() { return prevDir().exists() || useCurrent; }
        @JavascriptInterface public void exit() { ui.post(() -> finishAndRemoveTask()); }
        @JavascriptInterface public void call(final int id, final String method, final String args) {
            pool.submit(() -> {
                String out;
                try {
                    JSONObject r = dispatch(id, method, new JSONObject(args == null || args.isEmpty() ? "{}" : args));
                    if (r == null) return;
                    out = r.toString();
                } catch (Exception e) { out = err(e); }
                reply(id, out);
            });
        }
    }
}
