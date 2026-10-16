package com.gitvault.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only app-owned staging and explicitly granted document URIs are accessible. */
@CapacitorPlugin(name = "GitVaultNative")
public class GitVaultNativePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private static final String KEY = "gitvault.credentials.v1";
    private final Map<String, File> downloads = new ConcurrentHashMap<>();
    private final Map<String, String> names = new ConcurrentHashMap<>();
    private final Map<String, String> mimes = new ConcurrentHashMap<>();

    @Override public void load() {
        File folder = new File(getContext().getCacheDir(), "exports");
        File[] stale = folder.listFiles();
        if (stale != null) for (File file : stale) file.delete();
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    @PluginMethod public void readVault(PluginCall call) {
        io.execute(() -> {
            try {
                SharedPreferences preferences = getContext().getSharedPreferences("gitvault_secure", 0);
                String encrypted = preferences.getString("data", "");
                String value = "";
                if (!encrypted.isEmpty()) {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(preferences.getString("iv", ""), Base64.NO_WRAP)));
                    value = new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
                }
                JSObject result = new JSObject(); result.put("value", value); call.resolve(result);
            } catch (Exception exception) { call.reject("无法读取安全存储；原数据未清除", exception); }
        });
    }
    @PluginMethod public void writeVault(PluginCall call) {
        String value = call.getString("value");
        if (value == null) { call.reject("缺少安全存储内容"); return; }
        io.execute(() -> {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
                byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
                boolean saved = getContext().getSharedPreferences("gitvault_secure", 0).edit()
                    .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                    .putString("data", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit();
                if (!saved) throw new Exception("磁盘写入未完成");
                call.resolve();
            } catch (Exception exception) { call.reject("无法保存安全存储", exception); }
        });
    }
    @PluginMethod public void chooseDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "directoryChosen");
    }
    @ActivityCallback private void directoryChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("已取消选择目录", "CANCELLED"); return; }
        try {
            Uri uri = result.getData().getData();
            int required = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            if ((result.getData().getFlags() & required) != required) throw new SecurityException("所选目录未授予读写权限");
            getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            JSObject value = new JSObject(); value.put("uri", uri.toString()); call.resolve(value);
        } catch (Exception exception) { call.reject("无法保留目录授权，请重新选择", exception); }
    }
    @PluginMethod public void writeDocument(PluginCall call) {
        String directory = call.getString("directory", ""), path = call.getString("path", ""), data = call.getString("data", "");
        io.execute(() -> {
            try {
                ExportPath.validate(path);
                if (!directory.startsWith("content://")) throw new Exception("请通过系统选择器授权目录");
                DocumentFile folder = DocumentFile.fromTreeUri(getContext(), Uri.parse(directory));
                if (folder == null || !folder.canWrite()) throw new Exception("目录授权已失效，请重新选择");
                String[] segments = path.split("/");
                for (int i = 0; i < segments.length - 1; i++) {
                    DocumentFile next = folder.findFile(segments[i]);
                    if (next == null) next = folder.createDirectory(segments[i]);
                    if (next == null || !next.isDirectory()) throw new Exception("无法创建项目子目录");
                    folder = next;
                }
                DocumentFile file = folder.findFile(segments[segments.length - 1]);
                if (file == null) file = folder.createFile("application/octet-stream", segments[segments.length - 1]);
                if (file == null || !file.isFile()) throw new Exception("无法创建项目文件");
                try (OutputStream stream = getContext().getContentResolver().openOutputStream(file.getUri(), "wt")) {
                    if (stream == null) throw new Exception("无法打开文件");
                    stream.write(Base64.decode(data, Base64.DEFAULT));
                }
                call.resolve();
            } catch (Exception exception) { call.reject("导出文件未完成：" + exception.getMessage(), exception); }
        });
    }
    @PluginMethod public void beginDownload(PluginCall call) {
        try {
            String name = call.getString("name", "export.bin"); ExportPath.validate(name);
            if (name.contains("/")) throw new Exception("文件名不能包含目录");
            if (downloads.size() >= 4) throw new Exception("请先完成当前导出");
            File folder = new File(getContext().getCacheDir(), "exports");
            if (!folder.exists() && !folder.mkdirs()) throw new Exception("无法创建临时目录");
            String id = UUID.randomUUID().toString(); File file = new File(folder, id);
            if (!file.createNewFile()) throw new Exception("无法创建临时文件");
            downloads.put(id, file); names.put(id, name); mimes.put(id, call.getString("mime", "application/octet-stream"));
            JSObject value = new JSObject(); value.put("id", id); call.resolve(value);
        } catch (Exception exception) { call.reject("无法准备导出", exception); }
    }
    @PluginMethod public void appendDownload(PluginCall call) {
        File file = downloads.get(call.getString("id", ""));
        if (file == null) { call.reject("导出任务已失效，请重试"); return; }
        String data = call.getString("data", "");
        if (data.length() > 400000) { call.reject("导出分块过大"); return; }
        io.execute(() -> {
            try (FileOutputStream stream = new FileOutputStream(file, true)) { stream.write(Base64.decode(data, Base64.DEFAULT)); call.resolve(); }
            catch (Exception exception) { call.reject("临时文件写入失败", exception); }
        });
    }
    @PluginMethod public void finishDownload(PluginCall call) {
        String id = call.getString("id", "");
        if (!downloads.containsKey(id)) { call.reject("导出任务已失效"); return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimes.get(id)); intent.putExtra(Intent.EXTRA_TITLE, names.get(id));
        startActivityForResult(call, intent, "downloadChosen");
    }
    @ActivityCallback private void downloadChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        String id = call.getString("id", ""); File file = downloads.get(id);
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { discard(id); call.reject("已取消文件导出", "CANCELLED"); return; }
        Uri destination = result.getData().getData();
        io.execute(() -> {
            try {
                if (file == null) throw new Exception("临时文件已失效，请重新导出");
                try (InputStream input = new java.io.FileInputStream(file); OutputStream output = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new Exception("无法打开目标文件");
                    byte[] buffer = new byte[65536]; int read; while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                }
                call.resolve();
            } catch (Exception exception) {
                try { android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(), destination); } catch (Exception ignored) { }
                call.reject("导出未完成", exception);
            } finally { discard(id); }
        });
    }
    @PluginMethod public void abortDownload(PluginCall call) { discard(call.getString("id", "")); call.resolve(); }
    @Override protected void handleOnDestroy() { io.shutdown(); }
    private void discard(String id) { File file = downloads.remove(id); if (file != null) file.delete(); names.remove(id); mimes.remove(id); }
}
