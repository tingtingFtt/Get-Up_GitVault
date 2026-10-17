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
    private final Map<String, File> folderParts = new ConcurrentHashMap<>();
    private final Map<String, File> downloads = new ConcurrentHashMap<>();
    private final Map<String, String> names = new ConcurrentHashMap<>();
    private final Map<String, String> mimes = new ConcurrentHashMap<>();

    @Override public void load() {
        File partial = new File(getContext().getCacheDir(), "folder-parts");File[] parts=partial.listFiles();if(parts!=null)for(File file:parts)file.delete();
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
    private interface FolderTask { JSObject run(ManagedFolderStore store)throws Exception; }
    private void folderTask(PluginCall call,FolderTask task){io.execute(()->{try{call.resolve(task.run(new ManagedFolderStore(getContext())));}catch(Exception error){call.reject(error.getMessage(),error instanceof ManagedFolderStore.Changed?"LOCAL_CHANGES":"FOLDER_STORAGE");}});}
    @PluginMethod public void folderStatus(PluginCall call){folderTask(call,store->store.status(call.getString("root","")));}
    @PluginMethod public void folderBegin(PluginCall call){folderTask(call,store->store.begin(call.getString("root",""),call.getString("key",""),call.getString("ref",""),call.getString("label","project"),call.getArray("files",new com.getcapacitor.JSArray()),call.getBoolean("allowChanged",false)));}
    @PluginMethod public void folderList(PluginCall call){folderTask(call,store->store.describe(call.getString("version",""),call.getBoolean("scan",false),null));}
    @PluginMethod public void folderFile(PluginCall call){folderTask(call,store->store.describeFile(call.getString("version",""),call.getString("path","")));}
    @PluginMethod public void folderRead(PluginCall call){folderTask(call,store->store.readChunk(call.getString("version",""),call.getString("path",""),call.getData().getLong("offset")));}
    @PluginMethod public void folderFinish(PluginCall call){folderTask(call,store->store.finish(call.getString("version","")));}
    @PluginMethod public void folderAttach(PluginCall call){folderTask(call,store->store.attach(call.getString("version",""),call.getString("owner",""),call.getString("ref",""),call.getBoolean("history",false)));}
    private JSObject cleanParts(JSObject result)throws Exception{org.json.JSONArray ids=result.getJSONArray("ids");for(String key:new java.util.ArrayList<>(folderParts.keySet()))for(int i=0;i<ids.length();i++)if(key.startsWith(ids.getString(i)+":")){File part=folderParts.remove(key);if(part!=null&&!part.delete()&&part.exists())throw new java.io.IOException("临时分块清理失败");}return result;}
    @PluginMethod public void folderClear(PluginCall call){folderTask(call,store->cleanParts(store.clear(call.getString("owner",""),call.getString("ref",""),call.getBoolean("force",false),call.getArray("verifiedFiles"))));}
    @PluginMethod public void folderDiscard(PluginCall call){folderTask(call,store->cleanParts(store.discard(call.getString("version",""))));}
    @PluginMethod public void folderCleanTemporary(PluginCall call){folderTask(call,store->cleanParts(store.cleanTemporary(call.getBoolean("force",false))));}
    @PluginMethod public void folderPut(PluginCall call){folderTask(call,store->{
        String version=call.getString("version",""),path=call.getString("path",""),key=version+":"+path;long offset=call.getData().getLong("offset");String encoded=call.getString("data","");
        if(encoded.length()>524288)throw new java.io.IOException("文件分块过大");byte[] bytes=Base64.decode(encoded,Base64.DEFAULT);if(bytes.length>ManagedFolderStore.CHUNK)throw new java.io.IOException("文件分块过大");
        File part=folderParts.get(key);if(offset==0){if(part!=null)part.delete();File dir=new File(getContext().getCacheDir(),"folder-parts");dir.mkdirs();part=File.createTempFile("part-",".bin",dir);folderParts.put(key,part);}
        if(part==null||part.length()!=offset)throw new java.io.IOException("文件分块顺序无效");try(OutputStream output=new FileOutputStream(part,true)){output.write(bytes);}
        if(call.getBoolean("done",false)){try(InputStream input=new java.io.FileInputStream(part)){store.write(version,path,part.length(),call.getString("sha",""),call.getString("mode","100644"),input,null);}finally{part.delete();folderParts.remove(key);}}
        return new JSObject();
    });}
    @PluginMethod public void folderCopy(PluginCall call){folderTask(call,store->{org.json.JSONObject source=call.getObject("nativeRef");if(source==null)throw new java.io.IOException("文件引用缺失");try(InputStream input=store.open(source.getString("version"),source.getString("path"))){store.write(call.getString("version",""),call.getString("path",""),call.getData().getLong("size"),call.getString("sha",""),call.getString("mode","100644"),input,null);}return new JSObject();});}
    @PluginMethod public void folderExport(PluginCall call){folderTask(call,store->store.exportFiles(call.getString("directory",""),call.getString("prefix",""),call.getArray("files",new com.getcapacitor.JSArray()),call.getObject("project",new JSObject())));}
    @PluginMethod public void folderArchive(PluginCall call){io.execute(()->{String id=UUID.randomUUID().toString();File archive=null;try{
        String name=call.getString("name","project.zip");ExportPath.validate(name);if(name.contains("/"))throw new java.io.IOException("导出名称无效");File dir=new File(getContext().getCacheDir(),"exports");dir.mkdirs();archive=new File(dir,id);ManagedFolderStore store=new ManagedFolderStore(getContext());com.getcapacitor.JSArray files=call.getArray("files",new com.getcapacitor.JSArray());
        try(java.util.zip.ZipOutputStream zip=new java.util.zip.ZipOutputStream(new FileOutputStream(archive))){for(int i=0;i<files.length();i++){
            org.json.JSONObject item=files.getJSONObject(i),ref=item.optJSONObject("nativeRef");String path=item.getString("path");ExportPath.validate(path);zip.putNextEntry(new java.util.zip.ZipEntry(path));
            if(ref!=null){long size=item.getLong("size"),count=0;java.security.MessageDigest hash=java.security.MessageDigest.getInstance("SHA-1");hash.update(("blob "+size+"\0").getBytes(StandardCharsets.UTF_8));try(InputStream input=store.open(ref.getString("version"),ref.getString("path"))){byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1){zip.write(buffer,0,n);hash.update(buffer,0,n);count+=n;}}StringBuilder digest=new StringBuilder();for(byte value:hash.digest())digest.append(String.format(java.util.Locale.ROOT,"%02x",value&255));if(count!=size||!digest.toString().equals(item.getString("sha")))throw new java.io.IOException("目录文件在归档期间变化："+path);
            }else{String text=item.getString("content");if(text.length()>1024*1024)throw new java.io.IOException("归档附加说明过大");zip.write(item.optBoolean("isBase64")?Base64.decode(text,Base64.DEFAULT):text.getBytes(StandardCharsets.UTF_8));}
            zip.closeEntry();}}
        downloads.put(id,archive);names.put(id,name);mimes.put(id,"application/zip");JSObject result=new JSObject();result.put("id",id);call.resolve(result);
    }catch(Exception error){if(archive!=null)archive.delete();call.reject("目录归档失败："+error.getMessage());}});}
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
