package com.gitvault.app;

import android.app.*;
import android.content.*;
import android.os.*;
import android.util.AtomicFile;
import androidx.core.content.FileProvider;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Bounded app-private diagnostic data. No HTTP headers, credentials or source payloads. */
final class CrashDiagnostics {
    static final ExecutorService IO=Executors.newSingleThreadExecutor();
    private static Context context;private static File directory;private static long boot=SystemClock.elapsedRealtime();
    private static volatile boolean foreground,webVisible;private static volatile long mainBeat=boot,webBeat=boot,lastMainWarning,lastWebWarning;
    private static final AtomicBoolean pendingBeat=new AtomicBoolean();
    private static final Handler MAIN=new Handler(Looper.getMainLooper());
    private static ScheduledExecutorService monitor;
    static synchronized void install(Application app){
        if(context!=null)return;context=app.getApplicationContext();directory=new File(context.getFilesDir(),"diagnostics");directory.mkdirs();
        Thread.UncaughtExceptionHandler previous=Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread,error)->{try{JSONObject value=new JSONObject().put("thread",thread.getName()).put("message",safe(String.valueOf(error),1200)).put("stack",stack(error));synchronized(CrashDiagnostics.class){write("crash.json",value);eventNow("native-crash",value);}}catch(Throwable ignored){}finally{if(previous!=null)previous.uncaughtException(thread,error);else{android.os.Process.killProcess(android.os.Process.myPid());System.exit(10);}}});
        IO.execute(()->{try{JSONObject previousTask=read("task.json");if(previousTask!=null)write("previous-task.json",previousTask);eventNow("native-startup",new JSONObject().put("stage","Application.onCreate"));capturePreviousExit();}catch(Exception ignored){}});
        app.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks(){
            public void onActivityResumed(Activity activity){foreground=true;mainBeat=webBeat=SystemClock.elapsedRealtime();}
            public void onActivityPaused(Activity activity){foreground=false;}
            public void onActivityCreated(Activity a,Bundle b){}public void onActivityStarted(Activity a){}public void onActivityStopped(Activity a){}public void onActivitySaveInstanceState(Activity a,Bundle b){}public void onActivityDestroyed(Activity a){}
        });
        monitor=Executors.newSingleThreadScheduledExecutor();monitor.scheduleAtFixedRate(()->{
            long now=SystemClock.elapsedRealtime();if(!foreground)return;
            if(pendingBeat.compareAndSet(false,true))MAIN.post(()->{mainBeat=SystemClock.elapsedRealtime();pendingBeat.set(false);});
            if(now-mainBeat>15000&&now-lastMainWarning>60000){lastMainWarning=now;JSONObject value=new JSONObject();try{value.put("idleMs",now-mainBeat);StringBuilder trace=new StringBuilder();for(StackTraceElement line:Looper.getMainLooper().getThread().getStackTrace())if(trace.length()<7000)trace.append(line).append('\n');value.put("stack",trace.toString());}catch(Exception ignored){}event("main-thread-unresponsive",value);}
            if(webVisible&&now-webBeat>15000&&now-lastWebWarning>60000){lastWebWarning=now;event("webview-unresponsive",new JSONObject());}
        },5,5,TimeUnit.SECONDS);
    }
    private static void capturePreviousExit()throws Exception{
        JSONArray rows=new JSONArray();if(Build.VERSION.SDK_INT>=30)try{ActivityManager manager=(ActivityManager)context.getSystemService(Context.ACTIVITY_SERVICE);for(ApplicationExitInfo exit:manager.getHistoricalProcessExitReasons(context.getPackageName(),0,8))rows.put(new JSONObject().put("time",exit.getTimestamp()).put("reason",exit.getReason()).put("status",exit.getStatus()).put("description",safe(exit.getDescription(),1200)).put("process",exit.getProcessName()).put("pssKiB",exit.getPss()).put("rssKiB",exit.getRss()));}catch(Exception ignored){}
        write("exits.json",new JSONObject().put("capturedAt",System.currentTimeMillis()).put("exits",rows));
    }
    static void pulse(boolean visible){webBeat=SystemClock.elapsedRealtime();webVisible=visible;}
    static String safe(String text,int maximum){if(text==null)return "";String result=text.replaceAll("(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+","[已隐藏凭证]").replaceAll("(?i)(Bearer\\s+)[^\\s,;\"']+","$1[已隐藏凭证]").replaceAll("(?i)([?&](?:access_token|token|auth)=)[^&\\s]+","$1[已隐藏凭证]").replaceAll("https?://[^/@\\s]+:[^/@\\s]+@","https://[已隐藏凭证]@");return result.substring(0,Math.min(maximum,result.length()));}
    private static String stack(Throwable error){return stack(error,"");}
    private static String stack(Throwable error,String token){StringBuilder trace=new StringBuilder(4096);Set<Throwable> seen=Collections.newSetFromMap(new IdentityHashMap<>());appendStack(trace,error,"",token,seen);return safe(trace.toString(),8000);}
    private static void appendStack(StringBuilder trace,Throwable error,String relation,String token,Set<Throwable> seen){
        if(error==null||seen.size()>=8||trace.length()>=7000||!seen.add(error))return;
        String message=String.valueOf(error.getMessage());if(!token.isEmpty())message=message.replace(token,"[已隐藏凭证]");
        trace.append(relation).append(error.getClass().getName()).append(':').append(safe(message,1000)).append('\n');
        StackTraceElement[] frames=error.getStackTrace();for(int i=0;i<Math.min(frames.length,24)&&trace.length()<7000;i++)trace.append(frames[i]).append('\n');
        appendStack(trace,error.getCause(),"Caused by: ",token,seen);
        Throwable[] suppressed=error.getSuppressed();for(int i=0;i<Math.min(3,suppressed.length);i++)appendStack(trace,suppressed[i],"Suppressed: ",token,seen);
    }
    static void gitFailure(String id,String stage,String project,String branch,Throwable error,String token){
        if(directory==null)return;
        try{String message=String.valueOf(error.getMessage());if(!token.isEmpty())message=message.replace(token,"[已隐藏凭证]");JSONObject value=new JSONObject().put("taskId",safe(id,100)).put("stage",safe(stage,200)).put("project",safe(project,300)).put("branch",safe(branch,200)).put("message",safe(message,1200)).put("stack",stack(error,token));IO.execute(()->{try{synchronized(CrashDiagnostics.class){write("git-failure.json",value);eventNow("native-git-error",value);}}catch(Exception ignored){}});}catch(Exception ignored){}
    }
    static void event(String kind,JSONObject data){if(directory==null)return;IO.execute(()->{try{eventNow(kind,data);}catch(Exception ignored){}});}
    static synchronized void checkpoint(JSONObject incoming)throws Exception{
        JSONObject entry=new JSONObject();for(String key:new String[]{"time","kind","stage","project","branch","action","status","message","stack"})if(incoming.has(key))entry.put(key,safe(incoming.optString(key),key.equals("stack")?5000:1200));if(incoming.has("elapsedMs"))entry.put("elapsedMs",Math.max(0,incoming.optDouble("elapsedMs")));
        String kind=entry.optString("kind");eventNow(kind,entry);
        if(Arrays.asList("task","phase","progress","task-result").contains(kind))write("task.json",entry);
    }
    private static synchronized void eventNow(String kind,JSONObject value)throws Exception{
        if(directory==null)return;JSONObject entry=new JSONObject(value.toString());entry.put("kind",safe(kind,80)).put("recordedAt",System.currentTimeMillis()).put("nativeElapsedMs",SystemClock.elapsedRealtime()-boot);
        Runtime runtime=Runtime.getRuntime();entry.put("javaUsedBytes",runtime.totalMemory()-runtime.freeMemory()).put("javaMaxBytes",runtime.maxMemory()).put("nativeHeapBytes",Debug.getNativeHeapAllocatedSize());
        File log=new File(directory,"events.jsonl");if(log.length()>256*1024){File old=new File(directory,"events.previous.jsonl");old.delete();log.renameTo(old);}try(FileOutputStream output=new FileOutputStream(log,true)){output.write((entry.toString()+"\n").getBytes(StandardCharsets.UTF_8));}
    }
    private static void write(String name,JSONObject value)throws Exception{AtomicFile file=new AtomicFile(new File(directory,name));FileOutputStream output=null;try{output=file.startWrite();output.write(value.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(output);}catch(Exception error){if(output!=null)file.failWrite(output);throw error;}}
    private static synchronized JSONObject read(String name)throws Exception{File file=new File(directory,name);if(!file.exists())return null;try(InputStream input=new AtomicFile(file).openRead()){return new JSONObject(text(input,32768));}}
    private static String text(InputStream input,int limit)throws IOException{ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[2048];int n;while(output.size()<limit&&(n=input.read(buffer,0,Math.min(buffer.length,limit-output.size())))>0)output.write(buffer,0,n);return safe(output.toString("UTF-8"),limit);}
    static JSONObject report()throws Exception{
        JSONObject result=new JSONObject().put("packageId",context.getPackageName()).put("android",Build.VERSION.RELEASE).put("sdk",Build.VERSION.SDK_INT).put("manufacturer",Build.MANUFACTURER).put("model",Build.MODEL);
        android.content.pm.PackageInfo info=context.getPackageManager().getPackageInfo(context.getPackageName(),0);result.put("versionName",info.versionName).put("versionCode",Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode);
        if(Build.VERSION.SDK_INT>=26){android.content.pm.PackageInfo web=android.webkit.WebView.getCurrentWebViewPackage();if(web!=null)result.put("webViewVersion",web.versionName);}
        result.put("startupExitInfo",read("exits.json"));result.put("lastCrash",read("crash.json")).put("lastTask",read("task.json")).put("previousTask",read("previous-task.json")).put("lastGitFailure",read("git-failure.json"));
        ArrayDeque<JSONObject> history=new ArrayDeque<>();for(String name:new String[]{"events.previous.jsonl","events.jsonl"}){File file=new File(directory,name);if(file.exists())try(BufferedReader input=new BufferedReader(new InputStreamReader(new FileInputStream(file),StandardCharsets.UTF_8))){String line;while((line=input.readLine())!=null){try{history.add(new JSONObject(line));if(history.size()>100)history.removeFirst();}catch(Exception ignored){}}}catch(IOException ignored){}}
        result.put("events",new JSONArray(history));JSONArray exits=new JSONArray();
        if(Build.VERSION.SDK_INT>=30)try{ActivityManager manager=(ActivityManager)context.getSystemService(Context.ACTIVITY_SERVICE);for(ApplicationExitInfo exit:manager.getHistoricalProcessExitReasons(context.getPackageName(),0,8)){JSONObject value=new JSONObject().put("time",exit.getTimestamp()).put("reason",exit.getReason()).put("status",exit.getStatus()).put("description",safe(exit.getDescription(),1200)).put("process",exit.getProcessName()).put("pssKiB",exit.getPss()).put("rssKiB",exit.getRss());try(InputStream trace=exit.getTraceInputStream()){if(trace!=null)value.put("trace",text(trace,16384));}catch(Exception ignored){}exits.put(value);}}catch(Exception error){result.put("exitInfoError",safe(error.getMessage(),500));}
        result.put("exitInfo",exits);ActivityManager.MemoryInfo memory=new ActivityManager.MemoryInfo();((ActivityManager)context.getSystemService(Context.ACTIVITY_SERVICE)).getMemoryInfo(memory);result.put("availableMemoryBytes",memory.availMem).put("lowMemory",memory.lowMemory);return result;
    }
    static void share(Activity activity){IO.execute(()->{try{File folder=new File(activity.getCacheDir(),"exports");folder.mkdirs();File file=new File(folder,"gitvault-diagnostics-"+System.currentTimeMillis()+".json");try(FileOutputStream output=new FileOutputStream(file)){output.write(report().toString(2).getBytes(StandardCharsets.UTF_8));}android.net.Uri uri=FileProvider.getUriForFile(activity,activity.getPackageName()+".fileprovider",file);Intent share=new Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);activity.runOnUiThread(()->activity.startActivity(Intent.createChooser(share,"导出诊断报告")));}catch(Exception error){activity.runOnUiThread(()->android.widget.Toast.makeText(activity,"诊断导出失败，请重新打开后重试",android.widget.Toast.LENGTH_LONG).show());}});}
}
