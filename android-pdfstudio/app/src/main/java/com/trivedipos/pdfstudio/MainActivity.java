package com.trivedipos.pdfstudio;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.app.DownloadManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * PdfStudio for Android: a full-screen WebView around https://trivedipos.com/pdfstudio/app/
 * plus a few native helpers (save, share, open-with, camera, file picker, downloads).
 * The JavaScript side is described in android-pdfstudio/README.md.
 */
public class MainActivity extends Activity {
    static final String APP_URL = "https://trivedipos.com/pdfstudio/app/";
    static final String OFFLINE_URL = "file:///android_asset/offline.html";
    static final String BASE_HOST = "trivedipos.com";
    static final int REQ_SAVE = 1, REQ_FILE = 2, REQ_CAM_WEB = 3, REQ_CAM_CHOOSER = 4;
    static final int BG = 0xFF1F2233;

    private WebView web;
    private Handler ui;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // file handed to the app by "Open with" / "Share" (kept until the web page asks for it)
    private final Object openLock = new Object();
    private String openName, openB64, openMime;
    private volatile Future<?> openTask;

    // save dialog
    private byte[] saveBytes;
    private String saveName;

    // web file chooser
    private ValueCallback<Uri[]> fileCb;
    private File cameraFile;
    private WebChromeClient.FileChooserParams pendingParams;

    // web camera permission
    private PermissionRequest pendingPerm;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        ui = new Handler(Looper.getMainLooper());
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public WindowInsets onApplyWindowInsets(View v, WindowInsets in) {
                int l, t, r, bt;
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets i = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                    l = i.left; t = i.top; r = i.right; bt = i.bottom;
                } else {
                    l = in.getSystemWindowInsetLeft(); t = in.getSystemWindowInsetTop();
                    r = in.getSystemWindowInsetRight(); bt = in.getSystemWindowInsetBottom();
                }
                v.setPadding(l, t, r, bt);
                return in;
            }
        });

        web = new WebView(this);
        web.setBackgroundColor(BG);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " PdfStudioAndroid/" + versionName());

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "PdfAndroid");
        web.setDownloadListener(new DownloadListener() {
            @Override public void onDownloadStart(String url, String ua, String cd, String mime, long len) { startDownload(url, ua, cd, mime); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(final PermissionRequest req) { handleWebPermission(req); }
            @Override public void onPermissionRequestCanceled(PermissionRequest req) { if (pendingPerm == req) pendingPerm = null; }
            @Override public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams p) { return showChooser(cb, p); }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String sc = u.getScheme() == null ? "" : u.getScheme();
                if (sc.equals("about") || sc.equals("blob") || sc.equals("data")) return false;
                if (sc.equals("file")) return !OFFLINE_URL.equals(u.toString());
                if (sc.equals("https") && isOurHost(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) view.loadUrl(OFFLINE_URL);
            }
            @Override public void onPageFinished(WebView view, String url) { CookieManager.getInstance().flush(); }
        });

        if (b == null) handleIntent(getIntent(), false);
        web.loadUrl(APP_URL);
    }

    static boolean isOurHost(String h) {
        return h != null && (h.equals(BASE_HOST) || h.endsWith("." + BASE_HOST));
    }

    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "1.0"; }
    }

    // ---------------------------------------------------------------- lifecycle

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handleIntent(i, true);
    }

    @Override protected void onPause() {
        CookieManager.getInstance().flush();
        web.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override protected void onDestroy() {
        io.shutdown();
        try { web.destroy(); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(function(){try{return window.pdfAndroidBack ? !!window.pdfAndroidBack() : false;}catch(e){return false;}})()", new ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                if ("true".equals(v)) return;
                if (web.canGoBack()) web.goBack(); else finish();
            }
        });
    }

    // ---------------------------------------------------------------- files handed to the app

    private void handleIntent(Intent in, final boolean notify) {
        if (in == null) return;
        String act = in.getAction();
        Uri uri = null;
        String mime = in.getType();
        if (Intent.ACTION_VIEW.equals(act)) {
            uri = in.getData();
        } else if (Intent.ACTION_SEND.equals(act)) {
            uri = streamExtra(in);
        }
        if (uri == null) return;
        final Uri u = uri;
        final String m = mime;
        synchronized (openLock) { openName = null; openB64 = null; openMime = null; }
        openTask = io.submit(new Runnable() {
            @Override public void run() {
                try {
                    ContentResolver cr = getContentResolver();
                    String name = displayName(cr, u);
                    String mm = m;
                    String t = cr.getType(u);
                    if (t != null && !t.equals("application/octet-stream")) mm = t;
                    if (mm == null || mm.equals("*/*") || mm.equals("application/octet-stream")) mm = "application/pdf";
                    byte[] bytes = readAll(cr.openInputStream(u));
                    String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                    synchronized (openLock) { openName = name; openB64 = b64; openMime = mm; }
                    if (notify) ui.post(new Runnable() { @Override public void run() {
                        web.evaluateJavascript("window.pdfAndroidOpen && window.pdfAndroidOpen()", null);
                    } });
                } catch (Throwable e) {
                    ui.post(new Runnable() { @Override public void run() {
                        Toast.makeText(MainActivity.this, "Could not open that file.", Toast.LENGTH_LONG).show();
                    } });
                }
            }
        });
    }

    @SuppressWarnings("deprecation")
    private Uri streamExtra(Intent in) {
        try { return (Uri) in.getParcelableExtra(Intent.EXTRA_STREAM); } catch (Exception e) { return null; }
    }

    static byte[] readAll(InputStream is) throws Exception {
        if (is == null) throw new Exception("no data");
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream(1 << 16);
            byte[] buf = new byte[65536];
            int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        } finally { try { is.close(); } catch (Exception ignored) { } }
    }

    static String displayName(ContentResolver cr, Uri u) {
        String name = null;
        if ("content".equals(u.getScheme())) {
            Cursor c = null;
            try {
                c = cr.query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
            } finally { if (c != null) c.close(); }
        }
        if (name == null || name.length() == 0) name = u.getLastPathSegment();
        if (name == null || name.length() == 0) name = "document.pdf";
        int slash = name.lastIndexOf('/');
        if (slash >= 0 && slash < name.length() - 1) name = name.substring(slash + 1);
        return name;
    }

    static String safeName(String n, String fallback) {
        if (n == null) n = "";
        n = n.replaceAll("[^A-Za-z0-9._ -]", "_").trim();
        if (n.length() == 0 || n.equals(".") || n.equals("..")) n = fallback;
        return n;
    }

    // ---------------------------------------------------------------- JavaScript bridge

    private void jsSaved(final boolean ok, String msg) {
        final String js = "window.pdfAndroidSaved && window.pdfAndroidSaved(" + ok + "," + JSONObject.quote(msg == null ? "" : msg) + ")";
        ui.post(new Runnable() { @Override public void run() { web.evaluateJavascript(js, null); } });
    }

    static byte[] decode(String b64) {
        if (b64 == null) return new byte[0];
        if (b64.startsWith("data:")) { int c = b64.indexOf(','); if (c >= 0) b64 = b64.substring(c + 1); }
        return Base64.decode(b64, Base64.DEFAULT);
    }

    static String guessMime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".txt")) return "text/plain";
        return "application/pdf";
    }

    public class Bridge {
        @JavascriptInterface
        public void saveFile(String name, String base64) {
            try {
                final String nm = safeName(name, "document.pdf");
                saveBytes = decode(base64);
                saveName = nm;
                ui.post(new Runnable() { @Override public void run() {
                    try {
                        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType(guessMime(nm));
                        i.putExtra(Intent.EXTRA_TITLE, nm);
                        startActivityForResult(i, REQ_SAVE);
                    } catch (Exception e) {
                        saveBytes = null;
                        jsSaved(false, "Could not open the save dialog.");
                    }
                } });
            } catch (Throwable e) {
                saveBytes = null;
                jsSaved(false, "Could not save: " + e.getMessage());
            }
        }

        @JavascriptInterface
        public void shareFile(final String name, final String base64) {
            final String nm = safeName(name, "document.pdf");
            io.submit(new Runnable() { @Override public void run() {
                try {
                    byte[] bytes = decode(base64);
                    File dir = new File(getCacheDir(), "shared");
                    dir.mkdirs();
                    File f = new File(dir, nm);
                    FileOutputStream fo = new FileOutputStream(f);
                    try { fo.write(bytes); } finally { fo.close(); }
                    final Uri uri = new Uri.Builder().scheme("content").authority(ShareProvider.AUTHORITY).path("/shared/" + nm).build();
                    final String mime = guessMime(nm);
                    ui.post(new Runnable() { @Override public void run() {
                        try {
                            Intent send = new Intent(Intent.ACTION_SEND);
                            send.setType(mime);
                            send.putExtra(Intent.EXTRA_STREAM, uri);
                            send.setClipData(ClipData.newRawUri(nm, uri));
                            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivity(Intent.createChooser(send, "Share"));
                        } catch (Exception e) {
                            Toast.makeText(MainActivity.this, "Could not share.", Toast.LENGTH_LONG).show();
                        }
                    } });
                } catch (Throwable e) {
                    ui.post(new Runnable() { @Override public void run() {
                        Toast.makeText(MainActivity.this, "Could not share.", Toast.LENGTH_LONG).show();
                    } });
                }
            } });
        }

        /** Returns {"name","b64","mime"} for the file the app was opened with (then forgets it), or "". */
        @JavascriptInterface
        public String takeOpenedFile() {
            Future<?> f = openTask;
            if (f != null) { try { f.get(60, TimeUnit.SECONDS); } catch (Exception ignored) { } }
            synchronized (openLock) {
                if (openB64 == null) return "";
                StringBuilder sb = new StringBuilder(openB64.length() + 256);
                sb.append("{\"name\":").append(JSONObject.quote(openName))
                  .append(",\"mime\":").append(JSONObject.quote(openMime))
                  .append(",\"b64\":\"").append(openB64).append("\"}");
                openName = null; openB64 = null; openMime = null;
                return sb.toString();
            }
        }

        @JavascriptInterface
        public String getVersion() { return versionName(); }
    }

    // ---------------------------------------------------------------- downloads

    private void startDownload(String url, String ua, String cd, String mime) {
        if (url == null || !url.startsWith("http")) {
            Toast.makeText(this, "This download is handled inside PdfStudio.", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String fn = URLUtil.guessFileName(url, cd, mime);
            r.setMimeType(mime);
            String ck = CookieManager.getInstance().getCookie(url);
            if (ck != null) r.addRequestHeader("Cookie", ck);
            if (ua != null) r.addRequestHeader("User-Agent", ua);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fn);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
            Toast.makeText(this, "Downloading " + fn, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Download failed.", Toast.LENGTH_LONG).show();
        }
    }

    // ---------------------------------------------------------------- camera permission for the web scanner

    private void handleWebPermission(PermissionRequest req) {
        boolean video = false;
        for (String r : req.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) video = true;
        if (!video || !isOurHost(req.getOrigin().getHost())) { req.deny(); return; }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            req.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            if (pendingPerm != null) pendingPerm.deny();
            pendingPerm = req;
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM_WEB);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == REQ_CAM_WEB) {
            PermissionRequest r = pendingPerm;
            pendingPerm = null;
            if (r != null) {
                try {
                    if (ok) r.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE}); else r.deny();
                } catch (Exception ignored) { }
            }
        } else if (code == REQ_CAM_CHOOSER) {
            WebChromeClient.FileChooserParams p = pendingParams;
            pendingParams = null;
            if (p != null) launchChooser(p, ok);
        }
    }

    // ---------------------------------------------------------------- file chooser (<input type=file>)

    private boolean showChooser(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams p) {
        if (fileCb != null) { fileCb.onReceiveValue(null); fileCb = null; }
        fileCb = cb;
        boolean wantCamera = p.isCaptureEnabled() && acceptsImages(p.getAcceptTypes());
        if (wantCamera && getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                launchChooser(p, true);
            } else {
                pendingParams = p;
                requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM_CHOOSER);
            }
        } else {
            launchChooser(p, false);
        }
        return true;
    }

    private static boolean acceptsImages(String[] acc) {
        if (acc == null) return false;
        for (String a : acc) {
            if (a == null) continue;
            String x = a.trim().toLowerCase(Locale.ROOT);
            if (x.startsWith("image/") || x.equals(".jpg") || x.equals(".jpeg") || x.equals(".png")) return true;
        }
        return false;
    }

    private static String toMime(String a) {
        String x = a.trim().toLowerCase(Locale.ROOT);
        if (x.length() == 0) return null;
        if (x.indexOf('/') > 0) return x;
        switch (x) {
            case ".pdf": return "application/pdf";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".png": return "image/png";
            case ".webp": return "image/webp";
            case ".gif": return "image/gif";
            case ".txt": return "text/plain";
            default: return null;
        }
    }

    private void launchChooser(WebChromeClient.FileChooserParams p, boolean withCamera) {
        try {
            ArrayList<String> mimes = new ArrayList<String>();
            String[] acc = p.getAcceptTypes();
            if (acc != null) {
                for (String a : acc) {
                    if (a == null) continue;
                    for (String part : a.split(",")) {
                        String m = toMime(part);
                        if (m != null && !mimes.contains(m)) mimes.add(m);
                    }
                }
            }
            Intent content = new Intent(Intent.ACTION_GET_CONTENT);
            content.addCategory(Intent.CATEGORY_OPENABLE);
            if (mimes.size() == 1) {
                content.setType(mimes.get(0));
            } else {
                content.setType("*/*");
                if (mimes.size() > 1) content.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
            }
            if (p.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) content.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

            Intent chooser = Intent.createChooser(content, "Choose file");
            cameraFile = null;
            if (withCamera) {
                File dir = new File(getCacheDir(), "camera");
                dir.mkdirs();
                cameraFile = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
                Uri out = new Uri.Builder().scheme("content").authority(ShareProvider.AUTHORITY).path("/camera/" + cameraFile.getName()).build();
                Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                cam.putExtra(MediaStore.EXTRA_OUTPUT, out);
                cam.setClipData(ClipData.newRawUri("photo", out));
                cam.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
            }
            startActivityForResult(chooser, REQ_FILE);
        } catch (Exception e) {
            if (fileCb != null) { fileCb.onReceiveValue(null); fileCb = null; }
        }
    }

    // ---------------------------------------------------------------- results

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE) {
            ValueCallback<Uri[]> cb = fileCb;
            fileCb = null;
            if (cb == null) return;
            Uri[] out = null;
            if (res == RESULT_OK) {
                if (data != null) out = WebChromeClient.FileChooserParams.parseResult(res, data);
                if (out == null && cameraFile != null && cameraFile.length() > 0) out = new Uri[]{Uri.fromFile(cameraFile)};
            }
            cb.onReceiveValue(out);
        } else if (req == REQ_SAVE) {
            final byte[] bytes = saveBytes;
            final String nm = saveName;
            saveBytes = null;
            if (res == RESULT_OK && data != null && data.getData() != null && bytes != null) {
                final Uri uri = data.getData();
                io.submit(new Runnable() { @Override public void run() {
                    try {
                        OutputStream o = getContentResolver().openOutputStream(uri, "wt");
                        if (o == null) throw new Exception("cannot write there");
                        try { o.write(bytes); } finally { o.close(); }
                        jsSaved(true, nm);
                    } catch (Throwable e) {
                        jsSaved(false, "Could not save: " + e.getMessage());
                    }
                } });
            } else {
                jsSaved(false, "Cancelled");
            }
        }
    }
}
