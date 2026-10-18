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
    private static final Map<String,Map<String,JSONObject>> manifestIndex=new HashMap<>();
    static final int CHUNK=384*1024;
    static final class Changed extends IOException { Changed(String message){super(message);} }
    static final class Verification extends IOException {
        final JSObject details;final boolean repairable;
        Verification(String message,JSObject details,boolean repairable){super(message);this.details=details;this.repairable=repairable;}
    }
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
        ExportPath.validate(path);for(String segment:path.split("/")){DocumentFile next=doc.findFile(segment);if(next==null&&create)next=doc.createDirectory(segment);if(next==null)return null;if(!next.isDirectory())throw new IOException("目录被同名文件占用："+segment);if(!segment.equals(next.getName()))throw new IOException("目录提供者改变了目录名："+segment+" → "+next.getName());doc=next;}return doc;
    }
    private DocumentFile versionDir(JSONObject value,boolean create)throws Exception{return walk(root(value.getString("root")),value.getString("relative"),create);}
    private DocumentFile filesDir(JSONObject value,boolean create)throws Exception{DocumentFile version=versionDir(value,create);return version==null?null:walk(version,"files",create);}
    private DocumentFile createFile(DocumentFile directory,String name)throws IOException{
        // A registered MIME type can append an extension (including another .bin).
        DocumentFile file=directory.createFile("application/x-gitvault-source",name);
        if(file==null)throw new IOException("无法创建项目文件："+name);
        if(!name.equals(file.getName())&&(!file.renameTo(name)||!name.equals(file.getName())))throw new IOException("目录提供者未保留原始文件名："+name);
        return file;
    }
    private DocumentFile file(JSONObject value,String path,boolean create)throws Exception{
        return physicalFile(value,layout(value).physical(path),create);
    }
    private DocumentFile physicalFile(JSONObject value,String path,boolean create)throws Exception{
        ExportPath.validate(path);DocumentFile folder=filesDir(value,create);if(folder==null)return null;
        int slash=path.lastIndexOf('/');if(slash>=0){folder=walk(folder,path.substring(0,slash),create);if(folder==null)return null;}
        String name=path.substring(slash+1);DocumentFile doc=folder.findFile(name);if(doc==null&&create)doc=createFile(folder,name);if(doc!=null&&!doc.isFile())throw new IOException("文件路径被目录占用："+path);return doc;
    }
    private FolderPathLayout layout(JSONObject value)throws Exception{
        Map<String,String> aliases=new LinkedHashMap<>();JSONObject saved=value.optJSONObject("pathMappings");if(saved!=null)for(Iterator<String> it=saved.keys();it.hasNext();){String key=it.next();aliases.put(key,saved.getString(key));}return new FolderPathLayout(aliases);
    }
    private Map<String,JSONObject> expected(JSONObject value)throws Exception{
        String id=value.getString("id");Map<String,JSONObject> entries=manifestIndex.get(id);if(entries!=null)return entries;
        entries=new LinkedHashMap<>();JSONArray files=value.getJSONArray("expected");for(int i=0;i<files.length();i++){JSONObject entry=files.getJSONObject(i);String path=entry.getString("path");ExportPath.validate(path);if(!entry.getString("sha").matches("[a-f0-9]{40}")||!Arrays.asList("100644","100755","120000").contains(entry.getString("mode"))||entries.put(path,entry)!=null)throw new IOException("项目快照清单无效："+path);}if(meta(id).exists())manifestIndex.put(id,entries);return entries;
    }
    /** Per-task directory listings: never retain provider handles across tasks. */
    private final class FolderAccess {
        final DocumentFile directory;
        final FolderPathLayout names;
        final Map<String,Map<String,DocumentFile>> children=new HashMap<>();
        FolderAccess(JSONObject value,boolean create)throws Exception{names=layout(value);directory=filesDir(value,create);if(directory==null)throw new IOException("项目目录已移动或删除");}
        Map<String,DocumentFile> children(DocumentFile dir)throws IOException{
            String key=dir.getUri().toString();Map<String,DocumentFile> found=children.get(key);
            if(found==null){found=new HashMap<>();for(DocumentFile child:dir.listFiles()){String name=child.getName();if(name==null||found.put(name,child)!=null)throw new IOException("目录提供者返回重复或无效文件名");}children.put(key,found);}return found;
        }
        DocumentFile file(String path,boolean create)throws Exception{
            ExportPath.validate(path);String[] segments=names.physical(path).split("/");DocumentFile dir=directory;
            for(int i=0;i<segments.length;i++){
                String name=segments[i];Map<String,DocumentFile> entries=children(dir);DocumentFile next=entries.get(name);boolean last=i==segments.length-1;
                if(next==null&&create){next=last?createFile(dir,name):dir.createDirectory(name);if(next==null)throw new IOException("无法创建目录："+name);if(!name.equals(next.getName()))throw new IOException("目录提供者改变了名称："+path+" → "+next.getName());entries.put(name,next);}
                if(next==null)return null;if(last){if(!next.isFile())throw new IOException("文件路径被目录占用："+path);return next;}
                if(!next.isDirectory())throw new IOException("目录被同名文件占用："+name);dir=next;
            }return null;
        }
    }
    final class ReadBatch implements Closeable {
        private final Map<String,FolderAccess> versions=new HashMap<>();
        InputStream open(JSONObject ref)throws Exception{synchronized(LOCK){String id=ref.getString("version");FolderAccess access=versions.get(id);if(access==null){JSONObject value=load(id);if(value==null)throw new IOException("目录快照已清理");access=new FolderAccess(value,false);versions.put(id,access);}DocumentFile doc=access.file(ref.getString("path"),false);if(doc==null)throw new IOException("本地文件已移动或删除："+ref.getString("path"));return input(doc);}}
        public void close(){versions.clear();}
    }
    ReadBatch readBatch(){return new ReadBatch();}
    private InputStream input(DocumentFile doc)throws IOException{InputStream stream=context.getContentResolver().openInputStream(doc.getUri());if(stream==null)throw new IOException("无法读取项目文件");return stream;}
    private OutputStream output(DocumentFile doc)throws IOException{OutputStream stream=context.getContentResolver().openOutputStream(doc.getUri(),"wt");if(stream==null)throw new IOException("无法写入项目文件");return stream;}
    private static void check(AtomicBoolean stop)throws IOException{if(stop!=null&&(stop.get()||Thread.currentThread().isInterrupted()))throw new IOException("目录任务已取消，已完成的文件保留");}
    private static String hex(byte[] bytes){StringBuilder text=new StringBuilder();for(byte value:bytes)text.append(String.format(Locale.ROOT,"%02x",value&255));return text.toString();}
    private static final class ContentDigest {final String sha;final long size;ContentDigest(String sha,long size){this.sha=sha;this.size=size;}}
    private ContentDigest digest(DocumentFile doc,long hint,AtomicBoolean stop)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+hint+"\0").getBytes(StandardCharsets.UTF_8));long count=0;
        try(InputStream stream=input(doc)){byte[] buffer=new byte[65536];int n;while((n=stream.read(buffer))!=-1){check(stop);digest.update(buffer,0,n);count+=n;}}
        if(count!=hint){long actual=count;digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+actual+"\0").getBytes(StandardCharsets.UTF_8));count=0;try(InputStream stream=input(doc)){byte[] buffer=new byte[65536];int n;while((n=stream.read(buffer))!=-1){check(stop);digest.update(buffer,0,n);count+=n;}}if(count!=actual)throw new IOException("文件在读取期间变化，请重试");}
        return new ContentDigest(hex(digest.digest()),count);
    }
    private String hash(DocumentFile doc,AtomicBoolean stop)throws Exception{return digest(doc,doc.length(),stop).sha;}
    private void enumerate(DocumentFile dir,String prefix,Map<String,DocumentFile> files)throws Exception{if(dir==null)return;for(DocumentFile doc:dir.listFiles()){String name=doc.getName();if(name==null)throw new IOException("无法读取文件名");String path=prefix+name;ExportPath.validate(path);if(doc.isDirectory())enumerate(doc,path+"/",files);else if(doc.isFile())files.put(path,doc);}}
    private JSObject reference(JSONObject value,JSONObject entry,boolean dirty)throws Exception{JSObject file=new JSObject(entry.toString());file.remove("uri");file.put("content","");file.put("isBase64",true);file.put("encoding","base64");JSObject ref=new JSObject();ref.put("version",value.getString("id"));ref.put("path",entry.getString("path"));ref.put("dirty",dirty);ref.put("added",entry.optBoolean("added"));file.put("nativeRef",ref);return file;}
    private Map<String,JSONObject> registered(JSONObject value)throws Exception{Map<String,JSONObject> result=new LinkedHashMap<>();JSONObject files=value.getJSONObject("files");for(Iterator<String> it=files.keys();it.hasNext();){String path=it.next();result.put(path,files.getJSONObject(path));}return result;}
    private JSObject inspect(JSONObject value,Map<String,JSONObject> baseline,boolean includeExtras,AtomicBoolean stop)throws Exception{
        JSObject result=new JSObject();JSArray references=new JSArray();JSONArray differences=new JSONArray(),repairs=new JSONArray();Map<String,DocumentFile> physical=new LinkedHashMap<>();DocumentFile dir=filesDir(value,false);FolderPathLayout names=layout(value);
        if(dir==null){result.put("missing",true);for(String path:baseline.keySet()){differences.put(new JSONObject().put("path",path).put("type","missing"));repairs.put(path);}}
        else{
            enumerate(dir,"",physical);Set<String> found=new HashSet<>();List<JSONObject> entries=new ArrayList<>();
            for(Map.Entry<String,DocumentFile> item:physical.entrySet()){
                check(stop);String path=names.logical(item.getKey());if(!found.add(path))throw new IOException("目录映射发生冲突，原文件保留："+path+"（磁盘路径："+item.getKey()+"）");
                JSONObject previous=baseline.get(path);DocumentFile doc=item.getValue();
                if(previous==null){differences.put(new JSONObject().put("path",path).put("physicalPath",item.getKey()).put("type","extra"));if(!includeExtras)continue;}
                ContentDigest actual;try{actual=digest(doc,previous!=null&&previous.has("size")?previous.getLong("size"):doc.length(),stop);}catch(IOException error){check(stop);if(includeExtras)throw new IOException("无法校验目录文件："+path+"；"+error.getMessage(),error);differences.put(new JSONObject().put("path",path).put("physicalPath",item.getKey()).put("type","unreadable").put("reason",String.valueOf(error.getMessage())));continue;}
                JSONObject entry=new JSONObject();entry.put("path",path);entry.put("sha",actual.sha);entry.put("size",actual.size);entry.put("added",previous==null);entry.put("mode",previous==null?"100644":previous.getString("mode"));
                if(previous!=null&&(!actual.sha.equals(previous.getString("sha"))||previous.has("size")&&previous.getLong("size")!=actual.size)){differences.put(new JSONObject().put("path",path).put("physicalPath",item.getKey()).put("type","modified").put("expectedSha",previous.getString("sha")).put("actualSha",actual.sha));repairs.put(path);}
                entries.add(entry);
            }
            for(String path:baseline.keySet())if(!found.contains(path)){differences.put(new JSONObject().put("path",path).put("physicalPath",names.physical(path)).put("type","missing"));repairs.put(path);}
            for(JSONObject entry:entries)references.put(reference(value,entry,differences.length()>0));
        }
        JSONArray changes=new JSONArray();JSONObject counts=new JSONObject();for(String type:Arrays.asList("missing","modified","extra","unreadable"))counts.put(type,0);
        for(int i=0;i<differences.length();i++){JSONObject entry=differences.getJSONObject(i);String type=entry.getString("type");counts.put(type,counts.getInt(type)+1);changes.put((type.equals("missing")?"缺失：":type.equals("extra")?"额外文件：":type.equals("unreadable")?"读取失败：":"内容不同：")+entry.getString("path"));}
        result.put("id",value.getString("id"));result.put("files",references);result.put("dirty",differences.length()>0);result.put("changes",changes);result.put("differences",differences);result.put("counts",counts);result.put("repairPaths",repairs);result.put("state",value.getString("state"));result.put("root",value.getString("root"));result.put("location",value.getString("relative")+"/files");result.put("pathMappings",new JSONObject(names.aliases()));return result;
    }
    JSObject describe(String id,boolean scan,AtomicBoolean stop)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);JSObject result=new JSObject();if(value==null){result.put("missing",true);result.put("files",new JSArray());return result;}
            if(scan)return inspect(value,registered(value),true,stop);
            JSArray files=new JSArray();for(JSONObject entry:registered(value).values())files.put(reference(value,entry,false));result.put("id",id);result.put("files",files);result.put("dirty",false);result.put("changes",new JSONArray());result.put("state",value.getString("state"));result.put("root",value.getString("root"));result.put("location",value.getString("relative")+"/files");result.put("pathMappings",new JSONObject(layout(value).aliases()));if(filesDir(value,false)==null)result.put("missing",true);return result;
        }
    }
    JSObject begin(String root,String key,String ref,String label,JSArray expected,boolean allowChanged)throws Exception{
        synchronized(LOCK){root(root);List<String> paths=new ArrayList<>();for(int i=0;i<expected.length();i++)paths.add(expected.getJSONObject(i).getString("path"));FolderPathLayout planned=FolderPathLayout.plan(paths);for(JSONObject old:all())if(old.getString("root").equals(root)&&old.getString("key").equals(key)&&old.getString("state").equals("ready")&&old.getJSONObject("owners").length()>0){JSObject state=describe(old.getString("id"),true,null);if(state.optBoolean("dirty")&&!allowChanged)throw new Changed("项目目录有本地修改／新增／缺失文件："+state.getJSONArray("changes").toString()+"。是否允许以远端快照替换？");}
            for(JSONObject value:all())if(value.getString("root").equals(root)&&value.getString("key").equals(key)&&value.getString("ref").equals(ref)&&value.getString("state").equals("staging")&&value.getJSONArray("expected").toString().equals(expected.toString())&&layout(value).aliases().equals(planned.aliases())){
                JSONObject valid=new JSONObject();FolderAccess access=new FolderAccess(value,true);for(int i=0;i<expected.length();i++){JSONObject entry=expected.getJSONObject(i);String path=entry.getString("path");DocumentFile doc=access.file(path,false);if(doc!=null&&doc.exists()){ContentDigest actual=digest(doc,entry.optLong("size",doc.length()),null);if(actual.sha.equals(entry.getString("sha")))valid.put(path,new JSONObject(entry.toString()).put("size",actual.size));}}
                value.put("files",valid);save(value);return describe(value.getString("id"),false,null);
            }
            String id=UUID.randomUUID().toString().replace("-","");JSONObject value=new JSONObject();value.put("id",id);value.put("root",root);value.put("key",key);value.put("ref",ref);value.put("state","staging");value.put("files",new JSONObject());value.put("owners",new JSONObject());value.put("expected",expected);value.put("allowChanged",allowChanged);value.put("pathMappings",new JSONObject(planned.aliases()));value.put("layoutVersion",2);value.put("createdAt",System.currentTimeMillis());
            String safe=label.replaceAll("[^A-Za-z0-9_.-]","_");if(safe.length()>48)safe=safe.substring(0,48);String group=hex(MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8))).substring(0,12);
            value.put("relative","GitVault-"+instance().substring(0,12)+"/"+safe+"-"+group+"/"+ref.substring(0,Math.min(12,ref.length()))+"-"+id.substring(0,8));expected(value);filesDir(value,true);save(value);return describe(id,false,null);
        }
    }
    private void checkpoint(JSONObject value,JSONObject entry)throws Exception{try(FileOutputStream stream=new FileOutputStream(new File(registry,value.getString("id")+".journal"),true)){stream.write((entry.toString()+"\n").getBytes(StandardCharsets.UTF_8));}value.getJSONObject("files").put(entry.getString("path"),entry);}
    void write(String id,String path,long size,String sha,String mode,InputStream stream,AtomicBoolean stop)throws Exception{
        write(id,path,size,sha,mode,stream,stop,null);
    }
    private void write(String id,String path,long size,String sha,String mode,InputStream stream,AtomicBoolean stop,FolderAccess access)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);if(value==null||!value.getString("state").equals("staging"))throw new IOException("目录下载任务已结束");JSONObject trusted=expected(value).get(path);if(trusted==null||!trusted.getString("sha").equals(sha)||!trusted.getString("mode").equals(mode)||trusted.has("size")&&trusted.getLong("size")!=size)throw new IOException("写入文件与固定快照不一致："+path);DocumentFile target=access==null?file(value,path,true):access.file(path,true);if(target==null)throw new IOException("无法创建项目文件："+path);
            MessageDigest digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+size+"\0").getBytes(StandardCharsets.UTF_8));long count=0;
            try(OutputStream output=output(target)){byte[] buffer=new byte[65536];int n;while((n=stream.read(buffer))!=-1){check(stop);output.write(buffer,0,n);digest.update(buffer,0,n);count+=n;}}
            if(count!=size||!hex(digest.digest()).equals(sha)){target.delete();throw new IOException("项目文件校验失败："+path);}
            JSONObject entry=new JSONObject();entry.put("path",path);entry.put("sha",sha);entry.put("mode",mode);entry.put("size",size);checkpoint(value,entry);
        }
    }
    JSObject finish(String id)throws Exception{
        return finish(id,null);
    }
    private JSObject finish(String id,AtomicBoolean stop)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);if(value==null)throw new IOException("目录任务不存在");check(stop);JSObject checked=inspect(value,expected(value),false,stop);
            if(checked.optBoolean("dirty")||checked.optBoolean("missing"))throw verification(value,checked);check(stop);
            JSONObject files=new JSONObject();for(int i=0;i<checked.getJSONArray("files").length();i++){JSONObject entry=checked.getJSONArray("files").getJSONObject(i);JSONObject record=new JSONObject();for(String key:Arrays.asList("path","sha","mode","size"))record.put(key,entry.get(key));files.put(record.getString("path"),record);}value.put("files",files);
            DocumentFile version=versionDir(value,false);DocumentFile marker=version.findFile(".gitvault-snapshot.json");if(marker==null)marker=createFile(version,".gitvault-snapshot.json");try(OutputStream output=output(marker)){JSONObject publicMeta=new JSONObject();publicMeta.put("app","GitVault");publicMeta.put("version",id);publicMeta.put("ref",value.getString("ref"));publicMeta.put("files",value.getJSONArray("expected"));publicMeta.put("pathMappings",value.optJSONObject("pathMappings"));publicMeta.put("layoutVersion",value.optInt("layoutVersion",1));output.write(publicMeta.toString().getBytes(StandardCharsets.UTF_8));}
            DocumentFile diagnostic=version.findFile(".gitvault-diagnostic.json");if(diagnostic!=null)diagnostic.delete();value.remove("validation");value.put("state","ready");save(value);return describe(id,false,null);
        }
    }
    private Verification verification(JSONObject value,JSObject checked)throws Exception{
        JSONObject counts=checked.getJSONObject("counts");JSONArray differences=checked.getJSONArray("differences");JSObject details=new JSObject();details.put("version",value.getString("id"));details.put("counts",counts);details.put("repairPaths",checked.getJSONArray("repairPaths"));details.put("differences",differences);details.put("pathMappings",value.optJSONObject("pathMappings"));
        boolean repairable=value.getString("state").equals("staging")&&value.getJSONObject("owners").length()==0&&counts.getInt("extra")==0&&counts.getInt("unreadable")==0&&checked.getJSONArray("repairPaths").length()>0;
        StringBuilder message=new StringBuilder("目录文件已变化或缺失，未发布新快照。缺失 "+counts.getInt("missing")+" · 内容不同 "+counts.getInt("modified")+" · 额外文件 "+counts.getInt("extra")+" · 读取失败 "+counts.getInt("unreadable"));
        for(int i=0;i<Math.min(20,differences.length());i++){JSONObject entry=differences.getJSONObject(i);String type=entry.getString("type");message.append("\n").append(type.equals("missing")?"缺失：":type.equals("extra")?"额外文件：":type.equals("unreadable")?"读取失败：":"内容不同：").append(entry.getString("path"));if(entry.has("reason"))message.append("；").append(entry.getString("reason"));}
        if(counts.getInt("extra")>0)message.append("\n额外文件未删除，请将它们移出本次 files 目录后重试。");
        message.append("\n完整差异记录：").append(value.getString("relative")).append("/.gitvault-diagnostic.json");
        value.put("validation",details);try{save(value);DocumentFile version=versionDir(value,false);if(version!=null){DocumentFile target=version.findFile(".gitvault-diagnostic.json");if(target==null)target=createFile(version,".gitvault-diagnostic.json");try(OutputStream output=output(target)){output.write(details.toString().getBytes(StandardCharsets.UTF_8));}}}catch(Exception ignored){/* Keep the original verification reason even if diagnostics cannot be stored. */}
        return new Verification(message.toString(),details,repairable);
    }
    JSObject fetch(String id,Repository repository,JSArray expected,AtomicBoolean stop,Progress progress)throws Exception{
        synchronized(LOCK){JSONObject value=load(id);if(value==null)throw new IOException("目录任务不存在");JSONObject done=value.getJSONObject("files");FolderAccess access=new FolderAccess(value,true);int completed=0;
            for(int i=0;i<expected.length();i++){check(stop);JSONObject entry=expected.getJSONObject(i);String path=entry.getString("path");DocumentFile existing=access.file(path,false);JSONObject previous=done.optJSONObject(path);
                // Resume entries were verified by begin(); finish() still verifies
                // every on-disk file before publishing this candidate.
                if(previous==null||existing==null||!previous.getString("sha").equals(entry.getString("sha"))||!previous.getString("mode").equals(entry.getString("mode"))){ObjectLoader loader=repository.open(ObjectId.fromString(entry.getString("sha")));try(InputStream stream=loader.openStream()){write(id,path,loader.getSize(),entry.getString("sha"),entry.getString("mode"),stream,stop,access);}}
                progress.update("目录写入并校验 "+(++completed)+"/"+expected.length()+"："+path);
            }
            int repaired=0;for(int attempt=0;attempt<2;attempt++){
                progress.update("正在验证目录中的完整快照…");try{JSObject result=finish(id,stop);result.put("repairedFiles",repaired);return result;}catch(Verification error){if(attempt!=0||!error.repairable)throw error;JSONArray paths=error.details.getJSONArray("repairPaths");progress.update("正在从已下载 Git 对象修复 "+paths.length()+" 个缺失／损坏文件…");access=new FolderAccess(value,true);for(int i=0;i<paths.length();i++){check(stop);String path=paths.getString(i);JSONObject entry=expected(value).get(path);ObjectLoader loader=repository.open(ObjectId.fromString(entry.getString("sha")));try(InputStream stream=loader.openStream()){write(id,path,loader.getSize(),entry.getString("sha"),entry.getString("mode"),stream,stop,access);}repaired++;}}
            }throw new IOException("目录修复后仍无法完成校验，已停止重试");
        }
    }
    InputStream open(String id,String path)throws Exception{synchronized(LOCK){JSONObject value=load(id);if(value==null)throw new IOException("目录快照已清理");DocumentFile doc=file(value,path,false);if(doc==null||!doc.exists())throw new IOException("本地文件已移动或删除："+path);return input(doc);}}
    JSObject describeFile(String id,String path)throws Exception{synchronized(LOCK){JSONObject value=load(id);if(value==null)throw new IOException("目录快照已清理");DocumentFile doc=file(value,path,false);if(doc==null||!doc.exists())throw new IOException("目录文件已移动或删除："+path);JSONObject old=value.getJSONObject("files").optJSONObject(path),entry=new JSONObject();entry.put("path",path);ContentDigest actual=digest(doc,old==null?doc.length():old.optLong("size",doc.length()),null);entry.put("sha",actual.sha);entry.put("size",actual.size);entry.put("mode",old==null?"100644":old.getString("mode"));entry.put("added",old==null);return reference(value,entry,old==null||!old.getString("sha").equals(entry.getString("sha")));}}
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
        if(!force){JSObject state=describe(value.getString("id"),true,null);if(state.optBoolean("dirty"))throw new Changed("检测到本地修改或额外文件："+state.getJSONArray("changes").toString());}
        List<String> failures=new ArrayList<>();DocumentFile directory=versionDir(value,false);if(directory!=null){deleteTree(directory.findFile("files"),failures);for(String markerName:Arrays.asList(".gitvault-snapshot.json",".gitvault-diagnostic.json")){DocumentFile marker=directory.findFile(markerName);if(marker!=null&&!marker.delete())failures.add(markerName);}if(directory.listFiles().length==0&&!directory.delete())failures.add("版本目录");}
        if(!failures.isEmpty())throw new IOException("部分文件清理失败，尚未标记清理完成："+failures.toString());meta(value.getString("id")).delete();new File(registry,value.getString("id")+".journal").delete();memoryIndex.remove(value.getString("id"));manifestIndex.remove(value.getString("id"));
    }
    JSObject clear(String owner,String ref,boolean force)throws Exception{return clear(owner,ref,force,null);}
    private boolean matches(JSObject state,JSONArray expected)throws Exception{
        JSONArray files=state.getJSONArray("files");if(expected==null||files.length()!=expected.length())return false;Map<String,JSONObject> byPath=new HashMap<>();for(int i=0;i<expected.length();i++){JSONObject entry=expected.getJSONObject(i);byPath.put(entry.getString("path"),entry);}if(byPath.size()!=expected.length())return false;
        for(int i=0;i<files.length();i++){JSONObject file=files.getJSONObject(i),entry=byPath.get(file.getString("path"));if(entry==null||!entry.getString("sha").equals(file.getString("sha"))||!entry.optString("mode","100644").equals(file.getString("mode")))return false;}return true;
    }
    JSObject clear(String owner,String ref,boolean force,JSONArray verified)throws Exception{
        synchronized(LOCK){List<JSONObject> targets=new ArrayList<>();Set<String> approved=new HashSet<>();Set<String> keys=new HashSet<>();for(JSONObject value:all()){JSONObject binding=value.getJSONObject("owners").optJSONObject(owner);if(binding!=null&&(ref.isEmpty()||ref.equals(binding.getString("ref")))){if(value.getJSONObject("owners").length()==1&&!force){JSObject state=describe(value.getString("id"),true,null);if(state.optBoolean("dirty")){if(!ref.isEmpty()&&matches(state,verified))approved.add(value.getString("id"));else throw new Changed("清理将包含本地修改或额外文件："+state.getJSONArray("changes").toString());}else approved.add(value.getString("id"));}targets.add(value);keys.add(value.getString("key"));}}
            for(JSONObject value:all())if(value.getJSONObject("owners").length()==0&&keys.contains(value.getString("key"))&&(ref.isEmpty()||ref.equals(value.getString("ref"))))targets.add(value);
            // A legacy failed candidate can contain merged/corrupt paths. Check
            // every candidate before deleting the current, verified directory.
            if(!force)for(JSONObject value:targets)if(value.getJSONObject("owners").length()==0){JSObject state=describe(value.getString("id"),true,null);if(state.optBoolean("dirty")){if(!ref.isEmpty()&&matches(state,verified))approved.add(value.getString("id"));else throw new Changed("旧临时下载目录有变化，尚未开始清理项目文件；可先使用清理临时缓存："+state.getJSONArray("changes").toString());}else approved.add(value.getString("id"));}
            JSONArray ids=new JSONArray();for(JSONObject value:targets)ids.put(value.getString("id"));
            for(JSONObject value:targets){if(value.getJSONObject("owners").length()<=1)erase(value,force||approved.contains(value.getString("id")));else{value.getJSONObject("owners").remove(owner);save(value);}}JSObject result=new JSObject();result.put("versions",targets.size());result.put("ids",ids);return result;
        }
    }
    JSObject discard(String id)throws Exception{synchronized(LOCK){JSONObject value=load(id);JSObject result=new JSObject();JSONArray ids=new JSONArray();if(value!=null&&value.getJSONObject("owners").length()==0){erase(value,false);ids.put(id);}result.put("versions",ids.length());result.put("ids",ids);return result;}}
    JSObject cleanTemporary(boolean force)throws Exception{synchronized(LOCK){int count=0;JSONArray ids=new JSONArray();for(JSONObject value:all())if(value.getJSONObject("owners").length()==0){erase(value,force);ids.put(value.getString("id"));count++;}JSObject result=new JSObject();result.put("versions",count);result.put("ids",ids);return result;}}
    JSObject exportFiles(String uri,String prefix,JSArray entries,JSONObject project)throws Exception{
        synchronized(LOCK){DocumentFile destination=walk(root(uri),prefix,true);List<String> paths=new ArrayList<>();for(int i=0;i<entries.length();i++)paths.add(entries.getJSONObject(i).getString("path"));FolderPathLayout exportLayout=FolderPathLayout.plan(paths);for(int i=0;i<entries.length();i++){
            JSONObject entry=entries.getJSONObject(i),ref=entry.getJSONObject("nativeRef");String path=exportLayout.physical(entry.getString("path"));ExportPath.validate(path);DocumentFile folder=walk(destination,"files",true);int slash=path.lastIndexOf('/');if(slash>=0)folder=walk(folder,path.substring(0,slash),true);DocumentFile target=createFile(folder,path.substring(slash+1));if(target==null)throw new IOException("无法创建导出文件："+path);
            long size=entry.getLong("size"),count=0;MessageDigest hash=MessageDigest.getInstance("SHA-1");hash.update(("blob "+size+"\0").getBytes(StandardCharsets.UTF_8));try(InputStream input=open(ref.getString("version"),ref.getString("path"));OutputStream output=output(target)){byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1){output.write(bytes,0,n);hash.update(bytes,0,n);count+=n;}}
            if(count!=size||!hex(hash.digest()).equals(entry.getString("sha")))throw new IOException("目录文件在导出期间变化："+path);
        }DocumentFile marker=createFile(destination,".gitvault-export.json");if(marker==null)throw new IOException("无法写入导出完成标识");JSONObject receipt=new JSONObject(project.toString());receipt.put("files",entries);receipt.put("pathMappings",new JSONObject(exportLayout.aliases()));receipt.put("layoutVersion",2);receipt.put("completedAt",System.currentTimeMillis());try(OutputStream output=output(marker)){output.write(receipt.toString().getBytes(StandardCharsets.UTF_8));}JSObject result=new JSObject();result.put("location",prefix);return result;}
    }
    JSObject status(String root)throws Exception{synchronized(LOCK){root(root);JSObject result=new JSObject();result.put("root",root);result.put("versions",all().size());result.put("availableBytes",new android.os.StatFs(android.os.Environment.getDataDirectory().getAbsolutePath()).getAvailableBytes());return result;}}
}
