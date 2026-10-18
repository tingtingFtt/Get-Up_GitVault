package com.gitvault.app;

import android.content.ContentResolver;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.webkit.MimeTypeMap;
import java.io.*;
import java.util.Locale;

/** Byte-exact reads of files already resolved inside an authorized managed
 * project directory. No arbitrary URI or media-library access is exposed. */
final class ManagedDocumentInput {
    static boolean needsOriginalDescriptor(Uri uri) {
        if(!"content".equals(uri.getScheme())||!"com.android.externalstorage.documents".equals(uri.getAuthority()))return false;
        String path=uri.getLastPathSegment();if(path==null)return false;int dot=path.lastIndexOf('.');if(dot<0)return false;
        String mime=MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.substring(dot+1).toLowerCase(Locale.ROOT));
        return mime!=null&&(mime.startsWith("image/")||mime.startsWith("video/")||mime.startsWith("audio/"));
    }
    static InputStream open(ContentResolver resolver,Uri uri)throws IOException {
        Exception originalFailure=null;
        if(needsOriginalDescriptor(uri)) {
            try {
                // FileSystemProvider routes read-only media through MediaStore,
                // which can redact EXIF or transcode. Our SAF tree already has
                // read/write authorization. "rw" opens the existing source
                // descriptor without truncating it; we only read and close it.
                // Never use "w", "wt" or "rwt" for source reads.
                ParcelFileDescriptor descriptor=resolver.openFileDescriptor(uri,"rw");
                if(descriptor!=null)return new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
            }catch(FileNotFoundException|SecurityException|UnsupportedOperationException error){originalFailure=error;}
        }
        try {
            InputStream stream=resolver.openInputStream(uri);
            if(stream==null)throw new IOException("无法读取项目文件");return stream;
        }catch(IOException|SecurityException error){if(originalFailure!=null)error.addSuppressed(originalFailure);throw error;}
    }
}
