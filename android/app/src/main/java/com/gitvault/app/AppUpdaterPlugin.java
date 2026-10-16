package com.gitvault.app;

import android.app.DownloadManager;
import android.content.*;
import android.content.pm.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** APK updates are downloaded by Android, checked, then handed to its installer. */
@CapacitorPlugin(name="GitVaultUpdater")
public class AppUpdaterPlugin extends Plugin {
    private final java.util.concurrent.ExecutorService io=Executors.newSingleThreadExecutor();
    private SharedPreferences state(){return getContext().getSharedPreferences("gitvault_updates",0);}
    private PackageInfo installed()throws Exception{return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(),Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES);}
    private static long version(PackageInfo info){return Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode;}
    private static String hex(byte[] bytes){StringBuilder result=new StringBuilder();for(byte b:bytes)result.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return result.toString();}
    static boolean allowedDownload(String value){try{URI u=new URI(value);return "https".equals(u.getScheme())&&u.getPort()==-1&&u.getUserInfo()==null&&"github.com".equals(u.getHost())&&u.getPath().startsWith("/tingtingFtt/Get-Up_GitVault/releases/download/")&&u.getPath().endsWith(".apk")&&u.getQuery()==null&&u.getFragment()==null;}catch(Exception ignored){return false;}}
    @PluginMethod public void check(PluginCall call){io.execute(()->{HttpURLConnection connection=null;try{
        PackageInfo current=installed();boolean debug=getContext().getPackageName().endsWith(".debug");
        JSObject result=new JSObject();result.put("currentVersion",current.versionName);result.put("currentCode",version(current));result.put("packageId",getContext().getPackageName());
        connection=(HttpURLConnection)new URL("https://tingtingftt.github.io/Get-Up_GitVault/android/latest-"+(debug?"debug":"release")+".json?t="+System.currentTimeMillis()).openConnection();connection.setConnectTimeout(10000);connection.setReadTimeout(10000);connection.setInstanceFollowRedirects(false);int status=connection.getResponseCode();
        if(status==404){result.put("available",false);result.put("message","当前更新渠道尚未发布固定签名安装包");call.resolve(result);return;}
        if(status!=200)throw new IOException("更新信息暂时不可用（HTTP "+status+"）");
        JSONObject manifest=new JSONObject(GitVaultGitPlugin.readText(connection.getInputStream(),65536));
        if(!getContext().getPackageName().equals(manifest.getString("packageId"))||!allowedDownload(manifest.getString("url"))||!manifest.getString("sha256").matches("[a-f0-9]{64}")||manifest.getLong("size")<=0||manifest.getLong("size")>150L*1024*1024||manifest.getLong("versionCode")<=0)throw new IOException("更新清单无效，已停止");
        result.put("available",manifest.getLong("versionCode")>version(current));result.put("update",manifest);call.resolve(result);
    }catch(Exception e){call.reject("检查更新失败："+e.getMessage());}finally{if(connection!=null)connection.disconnect();}});}
    @PluginMethod public void download(PluginCall call){io.execute(()->{try{
        // Restrict the origin; the installed APK certificate is the trust anchor.
        JSONObject manifest=call.getObject("update");if(manifest==null||!getContext().getPackageName().equals(manifest.getString("packageId"))||!allowedDownload(manifest.getString("url"))||!manifest.getString("sha256").matches("[a-f0-9]{64}")||manifest.getLong("versionCode")<=version(installed())||manifest.getLong("size")<=0||manifest.getLong("size")>150L*1024*1024)throw new IOException("更新参数无效");
        DownloadManager manager=(DownloadManager)getContext().getSystemService(Context.DOWNLOAD_SERVICE);long previous=state().getLong("id",-1);String saved=state().getString("manifest","");
        if(previous!=-1&&saved.equals(manifest.toString())){try(Cursor cursor=manager.query(new DownloadManager.Query().setFilterById(previous))){if(cursor.moveToFirst()&&cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))!=DownloadManager.STATUS_FAILED){call.resolve(status());return;}}}
        if(previous!=-1)manager.remove(previous);
        File folder=getContext().getExternalFilesDir("updates");if(folder==null)throw new IOException("安装包下载目录不可用");File[] stale=folder.listFiles();if(stale!=null)for(File file:stale)file.delete();
        String filename="GitVault-"+manifest.getLong("versionCode")+".apk";
        DownloadManager.Request request=new DownloadManager.Request(Uri.parse(manifest.getString("url"))).setTitle("GitVault "+manifest.getString("versionName")).setDescription("下载应用更新，完成后请在应用中确认安装").setMimeType("application/vnd.android.package-archive").setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED).setDestinationInExternalFilesDir(getContext(),"updates",filename).setAllowedOverMetered(true);
        long id=manager.enqueue(request);if(!state().edit().putLong("id",id).putString("manifest",manifest.toString()).putString("path",new File(folder,filename).getAbsolutePath()).remove("verified").commit()){manager.remove(id);throw new IOException("无法保存下载任务");}call.resolve(status());
    }catch(Exception e){call.reject("下载更新失败："+e.getMessage());}});}
    private JSObject status()throws Exception{
        JSObject result=new JSObject();long id=state().getLong("id",-1);result.put("state","idle");if(id==-1)return result;
        DownloadManager manager=(DownloadManager)getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        JSONObject pending=new JSONObject(state().getString("manifest","{}"));
        if(pending.optLong("versionCode",0)<=version(installed())){manager.remove(id);state().edit().clear().apply();return result;}
        try(Cursor cursor=manager.query(new DownloadManager.Query().setFilterById(id))){if(!cursor.moveToFirst())return result;
            int value=cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));long bytes=cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));result.put("downloaded",bytes);result.put("total",cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));
            if(value==DownloadManager.STATUS_FAILED){result.put("state","error");result.put("message","Android 下载失败（"+cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))+"），可重试");}
            else if(value==DownloadManager.STATUS_SUCCESSFUL){verifyPackage();result.put("state","ready");result.put("canInstall",Build.VERSION.SDK_INT<26||getContext().getPackageManager().canRequestPackageInstalls());}
            else {result.put("state",value==DownloadManager.STATUS_PAUSED?"waiting":"downloading");}
        }return result;
    }
    private File verifyPackage()throws Exception{
        File file=new File(state().getString("path",""));JSONObject manifest=new JSONObject(state().getString("manifest","{}"));
        File folder=getContext().getExternalFilesDir("updates");if(folder==null||!file.getCanonicalPath().startsWith(folder.getCanonicalPath()+File.separator)||file.length()!=manifest.getLong("size"))throw new IOException("安装包不完整或路径无效，请重新下载");
        String marker=manifest.getString("sha256")+":"+file.length()+":"+file.lastModified();
        if(!marker.equals(state().getString("verified",""))){MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream stream=new FileInputStream(file)){byte[] buffer=new byte[65536];int n;while((n=stream.read(buffer))!=-1)hash.update(buffer,0,n);}if(!hex(hash.digest()).equals(manifest.getString("sha256")))throw new IOException("安装包 SHA-256 校验失败");}
        PackageInfo archive=getContext().getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(),Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES),current=installed();
        if(archive==null||!getContext().getPackageName().equals(archive.packageName)||version(archive)!=manifest.getLong("versionCode")||version(archive)<=version(current))throw new IOException("安装包名称或版本不匹配");
        Signature[] oldSigners=Build.VERSION.SDK_INT>=28?current.signingInfo.getApkContentsSigners():current.signatures,newSigners=Build.VERSION.SDK_INT>=28?archive.signingInfo.getApkContentsSigners():archive.signatures;
        if(oldSigners==null||newSigners==null||oldSigners.length!=newSigners.length||!new HashSet<>(Arrays.asList(oldSigners)).equals(new HashSet<>(Arrays.asList(newSigners))))throw new IOException("安装包签名与当前版本不同，无法覆盖更新；请勿卸载应用以免丢失数据");
        state().edit().putString("verified",marker).apply();return file;
    }
    @PluginMethod public void getStatus(PluginCall call){io.execute(()->{try{call.resolve(status());}catch(Exception e){JSObject result=new JSObject();result.put("state","error");result.put("message",e.getMessage());call.resolve(result);}});}
    @PluginMethod public void cancel(PluginCall call){io.execute(()->{long id=state().getLong("id",-1);if(id!=-1)((DownloadManager)getContext().getSystemService(Context.DOWNLOAD_SERVICE)).remove(id);state().edit().clear().apply();call.resolve();});}
    @PluginMethod public void install(PluginCall call){io.execute(()->{try{
        File file=verifyPackage();
        if(Build.VERSION.SDK_INT>=26&&!getContext().getPackageManager().canRequestPackageInstalls()){getActivity().runOnUiThread(()->{try{getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getContext().getPackageName())));JSObject result=new JSObject();result.put("permissionRequired",true);call.resolve(result);}catch(Exception e){call.reject("无法打开安装授权设置",e);}});return;}
        Uri uri=FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",file);
        getActivity().runOnUiThread(()->{try{Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_ACTIVITY_NEW_TASK);getActivity().startActivity(intent);JSObject result=new JSObject();result.put("permissionRequired",false);call.resolve(result);}catch(Exception e){call.reject("无法打开系统安装界面",e);}});
    }catch(Exception e){call.reject("安装更新失败："+e.getMessage());}});}
}
