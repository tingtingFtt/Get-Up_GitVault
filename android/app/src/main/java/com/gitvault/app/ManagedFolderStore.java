package com.gitvault.app;

import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.eclipse.jgit.lib.*;

/** Registry lives privately; document paths are always resolved below an app-created version directory. */
final class ManagedFolderStore {
    static final Object LOCK=new Object();
    private static final Map<String,JSONObject> memoryIndex=new HashMap<>();
    static final int CHUNK=384*1024;
    static final class Changed extends IOException { Changed(String message){super(message);} }
    interface Progress { void update(String message); }
    private final Context context;
    private final File registry;
    private final DocumentFile testRoot;
    ManagedFolderStore(Context context,DocumentFile testRoot,File testRegistry){this.context=context;this.testRoot=testRoot;registry=testRegistry;registry.mkdirs();}
    ManagedFolderStore(Context context){this.context=context;this.testRoot=null;registry=new File(context.getFilesDir(),"folder-index-v1");registry.mkdirs();}
    private File meta(String id)throws IOException{if(!id.matches("[a-f0-9]{32}"))throw new IOException("目录快照标识无效");return new File(registry,id+".json");}
    private JSONObject load(String id)throws Exception{
        if(memoryIndex.containsKey(id)&&meta(id).exists())return memoryIndex.get(id);
        File file=meta(id);if(!file.exists())return null;
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream input=new FileInputStream(file)){byte[] buffer=new byte[8192];int n;while((n=input.read(buffer))!=-1){if(bytes.size()+n>16*1024*1024)throw new IOException("目录索引过大");bytes.write(buffer,0,n);}}
        JSONObject value=new JSONObject(bytes.toString("UTF-8"));
        File journal=new File(registry,id+".journal");
        if(journal.exists())try(BufferedReader reader=new BufferedReader(new InputStreamReader(new FileInputStream(journal),StandardCharsets.UTF_8))){String line;while((line=reader.readLine())!=null)try{JSONObject entry=new JSONObject(line);value.getJSONObject("files").put(entry.getString("path"),entry);}catch(JSONException ignored){/* A torn final checkpoint is revalidated on resume. */}}
        memoryIndex.put(id,value);return value;
    }
    private void save(JSONObject value)throws Exception{
        AtomicFile file=new AtomicFile(meta(value.getString("id")));FileOutputStream output=null;
        try{output=file.startWrite();output.write(value.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(output);}catch(Exception error){if(output!=null)file.failWrite(output);throw error;}
        new File(registry,value.getString("id")+".journal").delete();memoryIndex.put(value.getString("id"),value);
    }
    private List<JSONObject> all()throws Exception{List<JSONObject> values=new ArrayList<>();File[] files=registry.listFiles((dir,name)->name.endsWith(".json"));if(files!=null)for(File file:files){JSONObject value=load(file.getName().replace(".json",""));if(value!=null)values.add(value);}return values;}
    private String instance(){android.content.SharedPreferences prefs=context.getSharedPreferences("folder-store",0);String id=prefs.getString("instance","");if(id.isEmpty()){id=UUID.randomUUID().toString().replace("-","");prefs.edit().putString("instance",id).commit();}return id;}
    private DocumentFile root(String uri)throws IOException{
        if(testRoot!=null)return testRoot;
        if(!uri.startsWith("content://"))throw new IOException("请通过系统选择器授权项目主存储目录");
        DocumentFile doc=DocumentFile.fromTreeUri(context,Uri.parse(uri));if(doc==null||!doc.exists()||!doc.canRead()||!doc.canWrite())throw new IOException("项目目录授权已失效，请重新选择原目录；原文件和记录保留");return doc;
    }
    private DocumentFile walk(DocumentFile doc,String path,boolean create)throws Exception{
        ExportPath.validate(path);for(String segment:path.split("/")){DocumentFile next=doc.findFile(segment);if(next==null&&create)next=doc.createDirectory(segment);if(next==null)return null;if(!next.isDirectory())throw new IOException("目录被同名文件占用："+segment);doc=next;}return doc;
    }
    private DocumentFile versionDir(JSONObject value,boolean create)throws Exception{return walk(root(value.getString("root")),value.getString("relative"),create);}
    private DocumentFile filesDir(JSONObject value,boolean create)throws Exception{DocumentFile version=versionDir(value,create);return version==null?null:walk(version,"files",create);}
    private DocumentFile file(JSONObject value,String path,boolean create)throws Exception{
        ExportPath.validate(path);DocumentFile folder=filesDir(value,create);if(folder==null)return null;
        int slash=path.lastIndexOf('/');if(slash>=0){folder=walk(folder,path.substring(0,slash),create);if(folder==null)return null;}
        String name=path.substring(slash+1);DocumentFile doc=folder.findFile(name);if(doc==null&&create)doc=folder.createFile("application/octet-stream",name);if(doc!=null&&!doc.isFile())throw new IOException("文件路径被目录占用："+path);return doc;
    }
    private InputStream input(DocumentFile doc)throws IOException{InputStream stream=context.getContentResolver().openInputStream(doc.getUri());if(stream==null)throw new IOException("无法读取项目文件");return stream;}
    private OutputStream output(DocumentFile doc)throws IOException{OutputStream stream=context.getContentResolver().openOutputStream(doc.getUri(),"wt");if(stream==null)throw new IOException("无法写入项目文件");return stream;}
    private static void check(AtomicBoolean stop)throws IOException{if(stop!=null&&(stop.get()||Thread.currentThread().isInterrupted()))throw new IOException("目录任务已取消，已完成的文件保留");}
    private static String hex(byte[] bytes){StringBuilder text=new StringBuilder();for(byte value:bytes)text.append(String.format(Locale.ROOT,"%02x",value&255));return text.toString();}
    private String hash(DocumentFile doc,AtomicBoolean stop)throws Exception{long size=doc.length();MessageDigest hash=MessageDigest.getInstance("SHA-1");hash.update(("blob "+size+"\0").getBytes(StandardCharsets.UTF_8));try(InputStream stream=input(doc)){byte[] buffer=new byte[65536];int n;long count=0;while((n=stream.read(buffer))!=-1){check(stop);hash.update(buffer,0,n);count+=n;}if(count!=size)throw new IOException("文件在读取期间变化，请重试");}return hex(hash.digest());}
    private void enumerate(DocumentFile dir,String prefix,Map<String,DocumentFile> files)throws Exception{if(dir==null)return;for(DocumentFile doc:dir.listFiles()){String name=doc.getName();if(name==null)throw new IOException("无法读取文件名");String path=prefix+name;ExportPath.validate(path);if(doc.isDirectory())enumerate(doc,path+"/",files);else if(doc.isFile())files.put(path,doc);}}
    private JSObject reference(JSONObject value,JSONObject entry,boolean dirty)throws Exception{JSObject file=new JSObject(entry.toString());file.remove("uri");file.put("content","");file.put("isBase64",true);file.put("encoding","base64");JSObject ref=new JSObject();ref.put("version",value.getString("id"));ref.put("path",entry.getString("path"));ref.put("dirty",dirty);ref.put("added",entry.optBoolean("added"));file.put("nativeRef",ref);return file;}
    JSObject describe(String id,boolean scan,AtomicBoolean stop)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);JSObject result=new JSObject();if(value==null){result.put("missing",true);result.put("files",new JSArray());return result;}
            Map<String,DocumentFile> actual=new LinkedHashMap<>();DocumentFile dir=filesDir(value,false);if(dir==null){result.put("missing",true);result.put("files",new JSArray());return result;}
            JSONObject known=value.getJSONObject("files");JSArray files=new JSArray();List<JSONObject> entries=new ArrayList<>();JSONArray changes=new JSONArray();
            if(scan){enumerate(dir,"",actual);for(String path:actual.keySet()){check(stop);DocumentFile doc=actual.get(path);JSONObject previous=known.optJSONObject(path);String sha=hash(doc,stop);JSONObject entry=new JSONObject();entry.put("path",path);entry.put("sha",sha);entry.put("size",doc.length());entry.put("added",previous==null);entry.put("mode",previous==null?"100644":previous.getString("mode"));if(previous==null||!sha.equals(previous.getString("sha")))changes.put(path);entries.add(entry);}for(Iterator<String> it=known.keys();it.hasNext();){String path=it.next();if(!actual.containsKey(path))changes.put("缺失："+path);}}
            else for(Iterator<String> it=known.keys();it.hasNext();)entries.add(known.getJSONObject(it.next()));
            boolean dirty=changes.length()>0;for(JSONObject entry:entries)files.put(reference(value,entry,dirty));
            result.put("id",id);result.put("files",files);result.put("dirty",dirty);result.put("changes",changes);result.put("state",value.getString("state"));result.put("root",value.getString("root"));result.put("location",value.getString("relative")+"/files");return result;
        }
    }
    JSObject begin(String root,String key,String ref,String label,JSArray expected,boolean allowChanged)throws Exception{
        synchronized(LOCK){root(root);for(JSONObject old:all())if(old.getString("root").equals(root)&&old.getString("key").equals(key)&&old.getString("state").equals("ready")&&old.getJSONObject("owners").length()>0){JSObject state=describe(old.getString("id"),true,null);if(state.optBoolean("dirty")&&!allowChanged)throw new Changed("项目目录有本地修改／新增／缺失文件："+state.getJSONArray("changes").toString()+"。是否允许以远端快照替换？");}
            for(JSONObject value:all())if(value.getString("root").equals(root)&&value.getString("key").equals(key)&&value.getString("ref").equals(ref)&&value.getString("state").equals("staging")&&value.getJSONArray("expected").toString().equals(expected.toString())){
                JSONObject valid=new JSONObject(),known=value.getJSONObject("files");for(Iterator<String> it=known.keys();it.hasNext();){String path=it.next();DocumentFile doc=file(value,path,false);JSONObject entry=known.getJSONObject(path);if(doc!=null&&doc.exists()&&hash(doc,null).equals(entry.getString("sha")))valid.put(path,entry);}
                value.put("files",valid);save(value);return describe(value.getString("id"),false,null);
            }
            String id=UUID.randomUUID().toString().replace("-","");JSONObject value=new JSONObject();value.put("id",id);value.put("root",root);value.put("key",key);value.put("ref",ref);value.put("state","staging");value.put("files",new JSONObject());value.put("owners",new JSONObject());value.put("expected",expected);value.put("allowChanged",allowChanged);value.put("createdAt",System.currentTimeMillis());
            String safe=label.replaceAll("[^A-Za-z0-9_.-]","_");if(safe.length()>48)safe=safe.substring(0,48);String group=hex(MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8))).substring(0,12);
            value.put("relative","GitVault-"+instance().substring(0,12)+"/"+safe+"-"+group+"/"+ref.substring(0,Math.min(12,ref.length()))+"-"+id.substring(0,8));filesDir(value,true);save(value);return describe(id,false,null);
        }
    }
    private void checkpoint(JSONObject value,JSONObject entry)throws Exception{try(FileOutputStream stream=new FileOutputStream(new File(registry,value.getString("id")+".journal"),true)){stream.write((entry.toString()+"\n").getBytes(StandardCharsets.UTF_8));}value.getJSONObject("files").put(entry.getString("path"),entry);}
    void write(String id,String path,long size,String sha,String mode,InputStream stream,AtomicBoolean stop)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);if(value==null||!value.getString("state").equals("staging"))throw new IOException("目录下载任务已结束");DocumentFile target=file(value,path,true);if(target==null)throw new IOException("无法创建项目文件："+path);
            MessageDigest digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+size+"\0").getBytes(StandardCharsets.UTF_8));long count=0;
            try(OutputStream output=output(target)){byte[] buffer=new byte[65536];int n;while((n=stream.read(buffer))!=-1){check(stop);output.write(buffer,0,n);digest.update(buffer,0,n);count+=n;}}
            if(count!=size||!hex(digest.digest()).equals(sha)){target.delete();throw new IOException("项目文件校验失败："+path);}
            JSONObject entry=new JSONObject();entry.put("path",path);entry.put("sha",sha);entry.put("mode",mode);entry.put("size",size);checkpoint(value,entry);
        }
    }
    JSObject finish(String id)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);if(value==null)throw new IOException("目录任务不存在");JSONObject files=value.getJSONObject("files");JSONArray expected=value.getJSONArray("expected");if(files.length()!=expected.length())throw new IOException("项目文件尚未完整写入，未发布新快照");for(int i=0;i<expected.length();i++){JSONObject entry=expected.getJSONObject(i),actual=files.optJSONObject(entry.getString("path"));if(actual==null||!actual.getString("sha").equals(entry.getString("sha"))||!actual.getString("mode").equals(entry.getString("mode")))throw new IOException("目录快照清单不一致");}
            JSObject checked=describe(id,true,null);if(checked.optBoolean("dirty")||checked.optBoolean("missing"))throw new IOException("目录文件已变化或缺失，未发布新快照");
            DocumentFile version=versionDir(value,false);DocumentFile marker=version.findFile(".gitvault-snapshot.json");if(marker==null)marker=version.createFile("application/json",".gitvault-snapshot.json");if(marker==null)throw new IOException("无法写入目录快照标识");try(OutputStream output=output(marker)){JSONObject publicMeta=new JSONObject();publicMeta.put("app","GitVault");publicMeta.put("version",id);publicMeta.put("ref",value.getString("ref"));publicMeta.put("files",expected);output.write(publicMeta.toString().getBytes(StandardCharsets.UTF_8));}value.put("state","ready");save(value);return describe(id,false,null);
        }
    }
    JSObject fetch(String id,Repository repository,JSArray expected,AtomicBoolean stop,Progress progress)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);JSONObject done=value.getJSONObject("files");int completed=0;
            for(int i=0;i<expected.length();i++){check(stop);JSONObject entry=expected.getJSONObject(i);String path=entry.getString("path");DocumentFile existing=file(value,path,false);JSONObject previous=done.optJSONObject(path);
                if(previous==null||existing==null||!existing.exists()||!hash(existing,stop).equals(entry.getString("sha"))){ObjectLoader loader=repository.open(ObjectId.fromString(entry.getString("sha")));try(InputStream stream=loader.openStream()){write(id,path,loader.getSize(),entry.getString("sha"),entry.getString("mode"),stream,stop);}}
                progress.update("目录写入并校验 "+(++completed)+"/"+expected.length()+"："+path);
            }return finish(id);
        }
    }
    InputStream open(String id,String path)throws Exception{synchronized(LOCK){JSONObject value=load(id);if(value==null)throw new IOException("目录快照已清理");DocumentFile doc=file(value,path,false);if(doc==null||!doc.exists())throw new IOException("本地文件已移动或删除："+path);return input(doc);}}
    JSObject describeFile(String id,String path)throws Exception{synchronized(LOCK){JSONObject value=load(id);if(value==null)throw new IOException("目录快照已清理");DocumentFile doc=file(value,path,false);if(doc==null||!doc.exists())throw new IOException("目录文件已移动或删除："+path);JSONObject old=value.getJSONObject("files").optJSONObject(path),entry=new JSONObject();entry.put("path",path);entry.put("sha",hash(doc,null));entry.put("size",doc.length());entry.put("mode",old==null?"100644":old.getString("mode"));entry.put("added",old==null);return reference(value,entry,old==null||!old.getString("sha").equals(entry.getString("sha")));}}
    JSObject readChunk(String id,String path,long offset)throws Exception{synchronized(LOCK){if(offset<0)throw new IOException("读取偏移无效");try(InputStream input=open(id,path)){long left=offset;while(left>0){long n=input.skip(left);if(n<=0)throw new IOException("文件在读取期间变化");left-=n;}byte[] buffer=new byte[CHUNK];int count=0,n;while(count<buffer.length&&(n=input.read(buffer,count,buffer.length-count))>0)count+=n;JSObject result=new JSObject();result.put("data",android.util.Base64.encodeToString(Arrays.copyOf(buffer,count),android.util.Base64.NO_WRAP));result.put("bytes",count);result.put("done",count<CHUNK);return result;}}}
    private boolean sameBranch(String a,String b){try{return new JSONArray(a).getString(1).equals(new JSONArray(b).getString(1));}catch(Exception ignored){return a.equals(b);}}
    JSObject attach(String id,String owner,String ref,boolean history)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);if(value==null||!value.getString("state").equals("ready"))throw new IOException("目录文件尚未就绪，原缓存保留");JSONObject binding=new JSONObject();binding.put("ref",ref);binding.put("history",history);value.getJSONObject("owners").put(owner,binding);save(value);JSONArray retained=new JSONArray();
            if(!history)for(JSONObject old:all())if(!old.getString("id").equals(id)&&sameBranch(old.getString("key"),value.getString("key"))){JSONObject previous=old.getJSONObject("owners").optJSONObject(owner);if(previous!=null&&!previous.optBoolean("history")){old.getJSONObject("owners").remove(owner);if(old.getJSONObject("owners").length()==0){try{erase(old,false);}catch(Exception error){old.getJSONObject("owners").put(owner,previous);save(old);retained.put(error.getMessage());}}else save(old);}}
            JSObject result=new JSObject();result.put("retained",retained);return result;
        }
    }
    private void deleteTree(DocumentFile doc,List<String> failures){if(doc==null)return;if(doc.isDirectory())for(DocumentFile child:doc.listFiles())deleteTree(child,failures);if(!doc.delete())failures.add(String.valueOf(doc.getName()));}
    private void erase(JSONObject value,boolean force)throws Exception{
        JSObject state=describe(value.getString("id"),true,null);if(state.optBoolean("dirty")&&!force)throw new Changed("检测到本地修改或额外文件："+state.getJSONArray("changes").toString());
        List<String> failures=new ArrayList<>();DocumentFile directory=versionDir(value,false);if(directory!=null){deleteTree(directory.findFile("files"),failures);DocumentFile marker=directory.findFile(".gitvault-snapshot.json");if(marker!=null&&!marker.delete())failures.add(".gitvault-snapshot.json");if(directory.listFiles().length==0&&!directory.delete())failures.add("版本目录");}
        if(!failures.isEmpty())throw new IOException("部分文件清理失败，尚未标记清理完成："+failures.toString());meta(value.getString("id")).delete();new File(registry,value.getString("id")+".journal").delete();memoryIndex.remove(value.getString("id"));
    }
    JSObject clear(String owner,String ref,boolean force)throws Exception{return clear(owner,ref,force,null);}
    private boolean matches(JSObject state,JSONArray expected)throws Exception{
        JSONArray files=state.getJSONArray("files");if(expected==null||files.length()!=expected.length())return false;Map<String,JSONObject> byPath=new HashMap<>();for(int i=0;i<expected.length();i++){JSONObject entry=expected.getJSONObject(i);byPath.put(entry.getString("path"),entry);}if(byPath.size()!=expected.length())return false;
        for(int i=0;i<files.length();i++){JSONObject file=files.getJSONObject(i),entry=byPath.get(file.getString("path"));if(entry==null||!entry.getString("sha").equals(file.getString("sha"))||!entry.optString("mode","100644").equals(file.getString("mode")))return false;}return true;
    }
    JSObject clear(String owner,String ref,boolean force,JSONArray verified)throws Exception{
        synchronized(LOCK){List<JSONObject> targets=new ArrayList<>();Set<String> approved=new HashSet<>();Set<String> keys=new HashSet<>();for(JSONObject value:all()){JSONObject binding=value.getJSONObject("owners").optJSONObject(owner);if(binding!=null&&(ref.isEmpty()||ref.equals(binding.getString("ref")))){if(value.getJSONObject("owners").length()==1&&!force){JSObject state=describe(value.getString("id"),true,null);if(state.optBoolean("dirty")){if(!ref.isEmpty()&&matches(state,verified))approved.add(value.getString("id"));else throw new Changed("清理将包含本地修改或额外文件："+state.getJSONArray("changes").toString());}}targets.add(value);keys.add(value.getString("key"));}}
            for(JSONObject value:all())if(value.getJSONObject("owners").length()==0&&keys.contains(value.getString("key"))&&(ref.isEmpty()||ref.equals(value.getString("ref"))))targets.add(value);
            JSONArray ids=new JSONArray();for(JSONObject value:targets)ids.put(value.getString("id"));
            for(JSONObject value:targets){if(value.getJSONObject("owners").length()<=1)erase(value,force||approved.contains(value.getString("id")));else{value.getJSONObject("owners").remove(owner);save(value);}}JSObject result=new JSObject();result.put("versions",targets.size());result.put("ids",ids);return result;
        }
    }
    JSObject cleanTemporary(boolean force)throws Exception{synchronized(LOCK){int count=0;JSONArray ids=new JSONArray();for(JSONObject value:all())if(value.getJSONObject("owners").length()==0){erase(value,force);ids.put(value.getString("id"));count++;}JSObject result=new JSObject();result.put("versions",count);result.put("ids",ids);return result;}}
    JSObject exportFiles(String uri,String prefix,JSArray entries,JSONObject project)throws Exception{
        synchronized(LOCK){DocumentFile destination=walk(root(uri),prefix,true);for(int i=0;i<entries.length();i++){
            JSONObject entry=entries.getJSONObject(i),ref=entry.getJSONObject("nativeRef");String path=entry.getString("path");ExportPath.validate(path);DocumentFile folder=walk(destination,"files",true);int slash=path.lastIndexOf('/');if(slash>=0)folder=walk(folder,path.substring(0,slash),true);DocumentFile target=folder.createFile("application/octet-stream",path.substring(slash+1));if(target==null)throw new IOException("无法创建导出文件："+path);
            long size=entry.getLong("size"),count=0;MessageDigest hash=MessageDigest.getInstance("SHA-1");hash.update(("blob "+size+"\0").getBytes(StandardCharsets.UTF_8));try(InputStream input=open(ref.getString("version"),ref.getString("path"));OutputStream output=output(target)){byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1){output.write(bytes,0,n);hash.update(bytes,0,n);count+=n;}}
            if(count!=size||!hex(hash.digest()).equals(entry.getString("sha")))throw new IOException("目录文件在导出期间变化："+path);
        }DocumentFile marker=destination.createFile("application/json",".gitvault-export.json");if(marker==null)throw new IOException("无法写入导出完成标识");JSONObject receipt=new JSONObject(project.toString());receipt.put("files",entries);receipt.put("completedAt",System.currentTimeMillis());try(OutputStream output=output(marker)){output.write(receipt.toString().getBytes(StandardCharsets.UTF_8));}JSObject result=new JSObject();result.put("location",prefix);return result;}
    }
    JSObject status(String root)throws Exception{synchronized(LOCK){root(root);JSObject result=new JSObject();result.put("root",root);result.put("versions",all().size());result.put("availableBytes",new android.os.StatFs(android.os.Environment.getDataDirectory().getAbsolutePath()).getAvailableBytes());return result;}}
}
