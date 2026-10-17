package com.gitvault.app;

import com.getcapacitor.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.eclipse.jgit.dircache.*;

/** Disk-backed staging. Source bytes cross the WebView bridge in bounded chunks. */
final class GitSnapshotStore implements Closeable {
    static final int CHUNK_BYTES=384*1024; // Divisible by three for exact Base64 concatenation.
    private final Repository repository;
    private final File folder;
    private final AtomicBoolean stop;
    private final Map<String,JSONObject> manifest=new LinkedHashMap<>();
    private final Map<String,DirCacheEntry> uploaded=new LinkedHashMap<>();
    private InputStream input;
    private String reading="",writing="";
    private long readOffset,writeOffset;
    private File part;
    private JSONObject current;
    GitSnapshotStore(Repository repository,File folder,AtomicBoolean stop){this.repository=repository;this.folder=folder;this.stop=stop;}
    private void check()throws IOException{if(stop.get()||Thread.currentThread().isInterrupted())throw new IOException("Git 任务已取消，本地文件保留");}
    void ensureSpace(long additional)throws IOException{
        check();long reserve=64L*1024*1024;if(additional<0||additional>Long.MAX_VALUE-reserve||folder.getUsableSpace()<additional+reserve)throw new IOException("设备可用存储空间不足，请释放空间后重试；已有项目保留");
    }
    JSObject describe(String ref)throws Exception{
        JSObject result=new JSObject();JSArray files=new JSArray();manifest.clear();
        try(RevWalk walk=new RevWalk(repository);TreeWalk tree=new TreeWalk(repository)){
            org.eclipse.jgit.revwalk.RevCommit commit=walk.parseCommit(ObjectId.fromString(ref));tree.addTree(commit.getTree());tree.setRecursive(true);
            while(tree.next()){
                check();if(tree.getFileMode(0)==FileMode.GITLINK)throw new IOException("项目包含暂不支持的子模块");
                ObjectLoader loader=repository.open(tree.getObjectId(0));
                try(InputStream stream=loader.openStream()){
                    byte[] prefix=new byte[50];int n=0,count;while(n<prefix.length&&(count=stream.read(prefix,n,prefix.length-n))>0)n+=count;
                    if(n>0&&new String(prefix,0,n,StandardCharsets.UTF_8).startsWith("version https://git-lfs.github.com/spec/v1"))throw new IOException("项目包含未下载的 LFS 大文件");
                }
                JSObject file=new JSObject();file.put("path",tree.getPathString());file.put("sha",tree.getObjectId(0).name());file.put("mode",Integer.toOctalString(tree.getFileMode(0).getBits()));file.put("size",loader.getSize());file.put("encoding","base64");
                manifest.put(tree.getPathString(),file);files.put(file);
            }
            result.put("commitSha",commit.name());result.put("treeSha",commit.getTree().name());result.put("files",files);result.put("chunked",true);return result;
        }
    }
    JSObject readChunk(String path,long offset)throws Exception{
        check();JSONObject file=manifest.get(path);if(file==null||offset<0||offset>file.getLong("size"))throw new IOException("读取文件不在已验证快照中");
        if(!reading.equals(path)){
            if(offset!=0)throw new IOException("文件分块偏移无效");
            if(input!=null)input.close();input=repository.open(ObjectId.fromString(file.getString("sha"))).openStream();reading=path;readOffset=0;
        }
        if(offset!=readOffset)throw new IOException("文件分块顺序不一致");
        byte[] bytes=new byte[(int)Math.min(CHUNK_BYTES,file.getLong("size")-offset)];int done=0;
        while(done<bytes.length){check();int n=input.read(bytes,done,bytes.length-done);if(n<0)throw new IOException("Git 文件分块不完整");done+=n;}
        readOffset+=done;JSObject result=new JSObject();result.put("offset",offset);result.put("bytes",done);result.put("done",readOffset==file.getLong("size"));result.put("content",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));return result;
    }
    void append(JSONObject chunk)throws Exception{
        check();String path=chunk.getString("path");ExportPath.validate(path);for(String segment:path.split("/"))if(segment.equalsIgnoreCase(".git"))throw new IOException("不能写入 Git 内部路径");
        long offset=chunk.getLong("offset");if(offset<0)throw new IOException("上传分块偏移无效");
        if(writing.isEmpty()){
            if(offset!=0||uploaded.containsKey(path)||!chunk.getString("sha").matches("[a-f0-9]{40}"))throw new IOException("上传文件重复、偏移或哈希无效");
            int mode=Integer.parseInt(chunk.getString("mode"),8);if(mode!=0100644&&mode!=0100755&&mode!=0120000)throw new IOException("不支持的文件模式");
            part=File.createTempFile("upload-",".part",folder);writing=path;writeOffset=0;current=new JSONObject(chunk.toString());current.remove("content");
        }
        if(!writing.equals(path)||offset!=writeOffset||!current.getString("sha").equals(chunk.getString("sha"))||!current.getString("mode").equals(chunk.getString("mode")))throw new IOException("上传文件分块顺序或身份不一致");
        String encoded=chunk.getString("content");if(encoded.length()>((CHUNK_BYTES+2)/3)*4)throw new IOException("上传分块超过大小限制");
        byte[] bytes=android.util.Base64.decode(encoded,android.util.Base64.DEFAULT);if(bytes.length>CHUNK_BYTES)throw new IOException("上传分块超过大小限制");ensureSpace(bytes.length);
        try(OutputStream output=new FileOutputStream(part,true)){output.write(bytes);}writeOffset+=bytes.length;
        if(chunk.getBoolean("done")){
            ObjectId blob;try(ObjectInserter insert=repository.newObjectInserter();InputStream stream=new FileInputStream(part)){blob=insert.insert(Constants.OBJ_BLOB,part.length(),stream);insert.flush();}
            if(!blob.name().equals(current.getString("sha")))throw new IOException("上传文件哈希不一致，未推送远端");
            DirCacheEntry entry=new DirCacheEntry(path);entry.setFileMode(FileMode.fromBits(Integer.parseInt(current.getString("mode"),8)));entry.setObjectId(blob);uploaded.put(path,entry);
            if(!part.delete())throw new IOException("上传临时文件清理失败");part=null;writing="";current=null;
        }
    }
    ObjectId writeTree(JSArray expected)throws Exception{
        check();if(!writing.isEmpty()||expected.length()!=uploaded.size())throw new IOException("上传文件未全部落盘，未写入目标分支");
        Set<String> paths=new HashSet<>();List<DirCacheEntry> entries=new ArrayList<>();
        for(int i=0;i<expected.length();i++){
            JSONObject file=expected.getJSONObject(i);String path=file.getString("path");DirCacheEntry entry=uploaded.get(path);
            if(!paths.add(path)||entry==null||!entry.getObjectId().name().equals(file.getString("sha"))||!Integer.toOctalString(entry.getFileMode().getBits()).equals(file.getString("mode")))throw new IOException("上传快照文件清单不一致");entries.add(entry);
        }
        return writeTree(repository,entries);
    }
    void appendStream(String path,String sha,String mode,long size,InputStream input)throws Exception{
        check();ExportPath.validate(path);if(uploaded.containsKey(path))throw new IOException("上传文件重复");
        for(String segment:path.split("/"))if(segment.equalsIgnoreCase(".git"))throw new IOException("不能上传 Git 内部路径");
        int bits=Integer.parseInt(mode,8);if(bits!=0100644&&bits!=0100755&&bits!=0120000)throw new IOException("文件模式无效");
        ObjectId blob;try(ObjectInserter insert=repository.newObjectInserter()){blob=insert.insert(Constants.OBJ_BLOB,size,new FilterInputStream(input){@Override public int read(byte[] bytes,int offset,int length)throws IOException{check();return super.read(bytes,offset,length);}});insert.flush();}
        if(input.read()!=-1)throw new IOException("目录文件大小在上传期间变化，未推送："+path);
        if(!blob.name().equals(sha))throw new IOException("目录文件在上传期间变化，未推送："+path);
        DirCacheEntry entry=new DirCacheEntry(path);entry.setFileMode(FileMode.fromBits(bits));entry.setObjectId(blob);uploaded.put(path,entry);
    }
    static ObjectId writeTree(Repository repository,List<DirCacheEntry> entries)throws IOException{
        entries.sort((a,b)->{byte[] x=a.getRawPath(),y=b.getRawPath();for(int i=0;i<Math.min(x.length,y.length);i++)if(x[i]!=y[i])return (x[i]&255)-(y[i]&255);return x.length-y.length;});
        DirCache cache=DirCache.newInCore();DirCacheBuilder builder=cache.builder();for(DirCacheEntry entry:entries)builder.add(entry);builder.finish();
        try(ObjectInserter insert=repository.newObjectInserter()){ObjectId tree=cache.writeTree(insert);insert.flush();return tree;}
    }
    public void close()throws IOException{if(input!=null)input.close();if(part!=null)part.delete();}
}
