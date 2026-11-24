package com.trivedipos.pdfstudio;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * Minimal replacement for AndroidX FileProvider. Serves files that live under the app's cache folder
 * (cache/shared/... and cache/camera/...) as content://com.trivedipos.pdfstudio.files/<folder>/<file>.
 */
public class ShareProvider extends ContentProvider {
    public static final String AUTHORITY = "com.trivedipos.pdfstudio.files";

    private File resolve(Uri uri) throws FileNotFoundException {
        try {
            File root = getContext().getCacheDir().getCanonicalFile();
            String rel = uri.getPath();
            if (rel == null) throw new FileNotFoundException("no path");
            File f = new File(root, rel).getCanonicalFile();
            if (!f.getPath().startsWith(root.getPath() + File.separator)) throw new FileNotFoundException("outside cache");
            String top = f.getParentFile() == null ? "" : f.getParentFile().getName();
            if (!top.equals("shared") && !top.equals("camera")) throw new FileNotFoundException("not allowed");
            return f;
        } catch (IOException e) {
            throw new FileNotFoundException(String.valueOf(e.getMessage()));
        }
    }

    @Override public boolean onCreate() { return true; }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            File f = resolve(uri);
            String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
            MatrixCursor c = new MatrixCursor(cols, 1);
            Object[] row = new Object[cols.length];
            for (int i = 0; i < cols.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
                else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
            }
            c.addRow(row);
            return c;
        } catch (FileNotFoundException e) {
            return null;
        }
    }

    @Override public String getType(Uri uri) {
        String p = String.valueOf(uri.getPath()).toLowerCase();
        if (p.endsWith(".pdf")) return "application/pdf";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        if (mode != null && mode.contains("w") && f.getParentFile() != null) f.getParentFile().mkdirs();
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode));
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
