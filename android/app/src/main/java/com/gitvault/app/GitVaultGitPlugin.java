package com.gitvault.app;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.eclipse.jgit.dircache.*;
import org.eclipse.jgit.transport.*;

/** Git objects stay in app-private staging; only github.com HTTPS is accepted. */
@CapacitorPlugin(name="GitVaultGit")
public class GitVaultGitPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService cancelIo = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String,GitNetwork> networkTasks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String,AtomicBoolean> cancelled = new ConcurrentHashMap<>();
    private final Map<String,Staged> sessions=new HashMap<>();
    private final Map<String,Long> lastProgress=new HashMap<>();
    private static final class Staged {
        final File folder;final GitObjectCache.Lease lease;final Git git;final GitSnapshotStore store;final ManagedFolderStore.ReadBatch reader;long preparationMs;boolean invalidCache;
        Staged(GitObjectCache.Lease lease,AtomicBoolean stop,android.content.Context context)throws Exception{this.lease=lease;folder=lease.folder;git=Git.init().setBare(true).setDirectory(folder).call();store=new GitSnapshotStore(git.getRepository(),folder,stop);reader=new ManagedFolderStore(context).readBatch();git.getRepository().getConfig().setString("gc",null,"auto","0");}
    }
    private Staged createSession(String id,PluginCall call)throws Exception{
        GitObjectCache cache=new GitObjectCache(getContext().getCacheDir());
        GitObjectCache.Lease lease;
        try{lease=cache.acquire(readRepositoryId(call),call.getBoolean("retainObjects",false));}
        catch(IOException failure){lease=cache.acquire(readRepositoryId(call),false);progress(id,"Git 加速缓存暂不可用，本次使用临时对象");}
        File folder=lease.folder;
        Staged staged=null;
        try{staged=new Staged(lease,cancelled.get(id),getContext());long total=call.getData().optLong("totalBytes",0);if(total<0||total>Long.MAX_VALUE/3)throw new IOException("项目大小无效");staged.store.ensureSpace(total*3);sessions.put(id,staged);return staged;}
        catch(Exception error){if(staged!=null){staged.git.close();}remove(folder);throw error;}
    }
    private void releaseSession(String id){Staged staged=sessions.remove(id);if(staged!=null){try{staged.store.close();staged.reader.close();}catch(Exception ignored){}staged.git.close();try{new GitObjectCache(getContext().getCacheDir()).release(staged.invalidCache?new GitObjectCache.Lease(staged.folder,staged.lease.repositoryId,false,false):staged.lease);}catch(IOException ignored){remove(staged.folder);}}cancelled.remove(id);lastProgress.remove(id);}
    @Override public void load(){File[] leftovers=getContext().getCacheDir().listFiles((dir,name)->name.startsWith("gitvault-session-"));if(leftovers!=null)for(File file:leftovers)remove(file);}
    @Override protected void handleOnDestroy(){for(AtomicBoolean stop:cancelled.values())stop.set(true);io.execute(()->{for(String id:new ArrayList<>(sessions.keySet()))releaseSession(id);});for(GitNetwork network:networkTasks.values())cancelIo.execute(network::disconnect);io.shutdown();cancelIo.shutdown();}
    @PluginMethod public void prepareUpload(PluginCall call){
        String id=call.getString("id","");if(id.isEmpty()||cancelled.putIfAbsent(id,new AtomicBoolean())!=null){call.reject("Git 任务 ID 无效");return;}
        io.execute(()->{try{
            AtomicBoolean stop=cancelled.get(id);
            if(call.getBoolean("retainObjects",false)){
                GitNetwork network=new GitNetwork(stop,message->progress(id,message));networkTasks.put(id,network);
                try{verifyIdentity(call.getString("owner",""),call.getString("repo",""),readRepositoryId(call),call.getString("token",""),stop,network,id);}
                finally{networkTasks.remove(id,network);network.close();}
            }
            createSession(id,call);call.resolve();
        }catch(Exception error){releaseSession(id);String token=call.getString("token","");call.reject(token.isEmpty()?error.getMessage():String.valueOf(error.getMessage()).replace(token,"[redacted]"));}});
    }
    @PluginMethod public void clearObjectCache(PluginCall call){io.execute(()->{try{if(!sessions.isEmpty())throw new IOException("Git 传输正在进行，请结束后清理缓存");GitObjectCache cache=new GitObjectCache(getContext().getCacheDir());long bytes=cache.bytes();cache.clear();JSObject result=new JSObject();result.put("bytes",bytes);call.resolve(result);}catch(Exception error){call.reject(error.getMessage(),"GIT_CACHE");}});}
    @PluginMethod public void readChunk(PluginCall call){chunkCall(call,false);}
    @PluginMethod public void appendChunk(PluginCall call){chunkCall(call,true);}
    @PluginMethod public void appendDocument(PluginCall call){String id=call.getString("id","");io.execute(()->{try{Staged staged=sessions.get(id);if(staged==null)throw new IOException("Git 上传任务已结束");org.json.JSONObject ref=call.getObject("nativeRef");if(ref==null)throw new IOException("目录引用缺失");try(InputStream input=new ManagedFolderStore(getContext()).open(ref.getString("version"),ref.getString("path"))){staged.store.appendStream(call.getString("path",""),call.getString("sha",""),call.getString("mode","100644"),call.getData().getLong("size"),input);}call.resolve();}catch(Exception error){call.reject(error.getMessage(),"GIT_TRANSFER");}});}
    @PluginMethod public void appendDocuments(PluginCall call){String id=call.getString("id","");io.execute(()->{long start=android.os.SystemClock.elapsedRealtime();Staged staged=sessions.get(id);try{if(staged==null)throw new IOException("Git 上传任务已结束");staged.store.appendDocuments(call.getArray("files",new JSArray()),staged.reader,message->pacedProgress(id,message));call.resolve();}catch(Exception error){call.reject(error.getMessage(),cancelled.get(id)!=null&&cancelled.get(id).get()?"CANCELLED":"GIT_TRANSFER");}finally{if(staged!=null)staged.preparationMs+=android.os.SystemClock.elapsedRealtime()-start;}});}
    private void chunkCall(PluginCall call,boolean upload){String id=call.getString("id","");io.execute(()->{long start=android.os.SystemClock.elapsedRealtime();Staged staged=sessions.get(id);try{if(staged==null)throw new IOException("Git 临时任务已结束，请重试");if(upload){staged.store.append(call.getData());call.resolve();}else call.resolve(staged.store.readChunk(call.getString("path",""),call.getData().getLong("offset")));}catch(Exception error){call.reject(error.getMessage(),cancelled.get(id)!=null&&cancelled.get(id).get()?"CANCELLED":"GIT_TRANSFER");}finally{if(upload&&staged!=null)staged.preparationMs+=android.os.SystemClock.elapsedRealtime()-start;}});}
    @PluginMethod public void release(PluginCall call){String id=call.getString("id","");io.execute(()->{releaseSession(id);call.resolve();});}
    @PluginMethod public void cancel(PluginCall call) { String id=call.getString("id","");if(!id.isEmpty()){cancelled.computeIfAbsent(id,key->new AtomicBoolean()).set(true);GitNetwork network=networkTasks.get(id);if(network!=null)cancelIo.execute(network::disconnect);}call.resolve(); }
    @PluginMethod public void transfer(PluginCall call) {
        String id=call.getString("id","");boolean fetching="fetch".equals(call.getString("action",""));if(id.isEmpty()||(fetching?cancelled.putIfAbsent(id,new AtomicBoolean())!=null:!cancelled.containsKey(id))){call.reject("Git 任务 ID 无效");return;}
        io.execute(()->{boolean retain=false;String token=call.getString("token","");
            try {
                String owner=call.getString("owner",""),name=call.getString("repo",""),action=call.getString("action","");
                if(!owner.matches("[A-Za-z0-9_.-]+")||!name.matches("[A-Za-z0-9_.-]+")||!Arrays.asList("fetch","push").contains(action))throw new IOException("Git 仓库参数无效");
                AtomicBoolean stop=cancelled.get(id); check(stop);
                long expectedRepoId=readRepositoryId(call);
                GitNetwork network=new GitNetwork(stop,message->progress(id,message));networkTasks.put(id,network);
                GitTransferRecovery recovery=new GitTransferRecovery(stop,message->network.beginTask(message,0));
                verifyIdentity(owner,name,expectedRepoId,token,stop,network,id);
                Staged staged=fetching?createSession(id,call):sessions.get(id);if(staged==null)throw new IOException("Git 上传暂存已结束，请重试");
                { Git git=staged.git;
                    String remote="https://github.com/"+owner+"/"+name+".git";
                    CredentialsProvider credentials=new UsernamePasswordCredentialsProvider("x-access-token",token);
                    ProgressMonitor monitor=network;
                    JSObject result;JSObject timings=new JSObject();timings.put("preparationMs",staged.preparationMs);long phaseStart=android.os.SystemClock.elapsedRealtime();
                    if(action.equals("fetch")) {
                        String ref=call.getString("ref","");if(!ref.matches("[a-f0-9]{40}"))throw new IOException("拉取必须固定完整提交 SHA");
                        recovery.read("获取固定版本",timeout->{network.disconnect();return git.fetch().setRemote(remote).setCredentialsProvider(credentials).setTimeout(timeout).setTransportConfigCallback(network::configure).setDepth(1).setTagOpt(TagOpt.NO_TAGS).setRefSpecs(new RefSpec("+"+ref+":refs/gitvault/source")).setProgressMonitor(monitor).call();});
                        timings.put("fetchMs",android.os.SystemClock.elapsedRealtime()-phaseStart);phaseStart=android.os.SystemClock.elapsedRealtime();
                        check(stop);result=staged.store.describe(ref);pinForCache(staged,id,"refs/gitvault/source",ObjectId.fromString(ref));
                        String folderVersion=call.getString("folderVersion","");
                        if(!folderVersion.isEmpty()){
                            JSObject stored=new ManagedFolderStore(getContext()).fetch(folderVersion,git.getRepository(),new JSArray(result.getJSONArray("files").toString()),stop,message->pacedProgress(id,message));
                            result.put("files",stored.getJSONArray("files"));result.put("folder",true);result.put("folderVersion",folderVersion);result.put("streamed",true);
                            result.put("repairedFiles",stored.optInt("repairedFiles",0));
                            timings.put("folderMs",android.os.SystemClock.elapsedRealtime()-phaseStart);
                        }else retain=true;
                    } else {
                        String branch=call.getString("branch","");if(!Repository.isValidRefName("refs/heads/"+branch))throw new IOException("Git 分支名称无效");
                        ObjectId tree=staged.store.writeTree(call.getArray("files",new JSArray()));
                        result=null;
                        for(int attempt=0;attempt<3;attempt++) {
                            check(stop);String head=recovery.read("读取目标分支",timeout->remoteHead(remote,branch,credentials,timeout,network));
                            ObjectId parent=null;
                            if(!head.isEmpty()) {
                                if(!hasCommitTree(git.getRepository(),head)){
                                    FetchResult fetched=recovery.read("获取目标分支",timeout->{network.disconnect();return git.fetch().setRemote(remote).setCredentialsProvider(credentials).setTimeout(timeout).setTransportConfigCallback(network::configure).setDepth(1).setTagOpt(TagOpt.NO_TAGS).setRefSpecs(new RefSpec("+refs/heads/"+branch+":refs/gitvault/target")).setProgressMonitor(monitor).call();});
                                    Ref advertised=fetched.getAdvertisedRef("refs/heads/"+branch);
                                    if(advertised==null||!hasCommitTree(git.getRepository(),advertised.getObjectId().name()))throw new IOException("目标分支获取结果不完整，未创建提交");
                                    parent=advertised.getObjectId();
                                }else{parent=ObjectId.fromString(head);progress(id,"目标提交已在当前对象库，跳过重复获取");}
                                pinForCache(staged,id,"refs/gitvault/target",parent);
                            }
                            ObjectId commit;
                            try(RevWalk walk=new RevWalk(git.getRepository());ObjectInserter insert=git.getRepository().newObjectInserter()) {
                                if(parent!=null&&walk.parseCommit(parent).getTree().equals(tree))commit=parent;
                                else { CommitBuilder builder=new CommitBuilder();builder.setTreeId(tree);if(parent!=null)builder.setParentId(parent);PersonIdent author=new PersonIdent("GitVault","gitvault@users.noreply.github.com");builder.setAuthor(author);builder.setCommitter(author);builder.setMessage(call.getString("message","Sync project snapshot via GitVault"));commit=insert.insert(builder);insert.flush(); }
                            }
                            verifyIdentity(owner,name,expectedRepoId,token,stop,network,id);check(stop);
                            final ObjectId pendingCommit=commit;
                            String actual;
                            if(commit.equals(parent))actual=recovery.read("核对目标分支",timeout->remoteHead(remote,branch,credentials,timeout,network));
                            else actual=recovery.push(commit.name(),parent==null?"":parent.name(),timeout->remoteHead(remote,branch,credentials,timeout,network),timeout->{
                                if(timeout>GitTransferRecovery.timeout(0))verifyIdentity(owner,name,expectedRepoId,token,stop,network,id);
                                network.beginTask("推送目标分支",0);network.disconnect();
                                Iterable<PushResult> pushed=git.push().setRemote(remote).setCredentialsProvider(credentials).setTimeout(timeout).setTransportConfigCallback(network::configure).setRefSpecs(new RefSpec(pendingCommit.name()+":refs/heads/"+branch)).setProgressMonitor(monitor).call();
                                for(PushResult pushedResult:pushed)for(RemoteRefUpdate update:pushedResult.getRemoteUpdates())if(update.getStatus()!=RemoteRefUpdate.Status.OK&&update.getStatus()!=RemoteRefUpdate.Status.UP_TO_DATE)throw new IOException("Git 推送拒绝："+update.getStatus());
                                return null;
                            });check(stop);
                            if(actual.equals(commit.name())) {verifyIdentity(owner,name,expectedRepoId,token,stop,network,id);pinForCache(staged,id,"refs/gitvault/target",commit);result=new JSObject();result.put("commitSha",commit.name());result.put("treeSha",tree.name());result.put("branch",branch);result.put("repoId",expectedRepoId);result.put("verified",true);break;}
                            if(call.getBoolean("rebaseOnConflict",false)&&!actual.equals(parent==null?"":parent.name())&&attempt<2)continue;
                            throw new IOException("目标分支在推送期间变化；本地文件保留，不会强推");
                        }
                        if(result==null)throw new IOException("目标分支持续变化，请稍后重试");
                        timings.put("pushMs",android.os.SystemClock.elapsedRealtime()-phaseStart);
                    }
                    timings.put("cacheHit",staged.lease.reused);if(action.equals("push")){timings.put("newObjects",staged.store.newObjects);timings.put("reusedObjects",staged.store.reusedObjects);timings.put("sourceBytes",staged.store.sourceBytes);}
                    result.put("timings",timings);
                    check(stop);call.resolve(result);
                }
            }catch(Exception exception){Staged active=sessions.get(id);for(Throwable cause=exception;cause!=null;cause=cause.getCause())if(active!=null&&(cause instanceof org.eclipse.jgit.errors.CorruptObjectException||cause instanceof org.eclipse.jgit.errors.MissingObjectException))active.invalidCache=true;String message=exception.getMessage()==null?"原生 Git 传输失败":exception.getMessage();if(!token.isEmpty())message=message.replace(token,"[redacted]");if(exception instanceof ManagedFolderStore.Verification)call.reject(message,"FOLDER_STORAGE",((ManagedFolderStore.Verification)exception).details);else call.reject(message,cancelled.get(id)!=null&&cancelled.get(id).get()?"CANCELLED":GitTransferRecovery.transientFailure(exception)?"GIT_NETWORK":"GIT_TRANSFER");}
            finally {GitNetwork network=networkTasks.remove(id);if(network!=null)network.close();if(!retain)releaseSession(id);}
        });
    }
    private void progress(String id,String message){JSObject value=new JSObject();value.put("id",id);value.put("message","原生 Git："+message);notifyListeners("progress",value);}
    private void pacedProgress(String id,String message){long now=android.os.SystemClock.elapsedRealtime(),previous=lastProgress.containsKey(id)?lastProgress.get(id):0;if(now-previous>=200){lastProgress.put(id,now);progress(id,message);}}
    private static void check(AtomicBoolean stop)throws IOException{if(stop.get()||Thread.currentThread().isInterrupted())throw new IOException("Git 任务已取消，本地文件保留");}
    private void verifyIdentity(String owner,String name,long expected,String token,AtomicBoolean stop,GitNetwork network,String id)throws Exception {
        if(expected<=0)throw new IOException("仓库 ID 无效，请重新获取仓库信息");
        new GitTransferRecovery(stop,message->network.beginTask(message,0)).read("核对固定仓库",timeout->{
            for(int attempt=0;;attempt++){
                check(stop);HttpURLConnection connection=network.track((HttpURLConnection)new URL("https://api.github.com/repos/"+owner+"/"+name).openConnection());connection.setConnectTimeout(15000);connection.setReadTimeout(timeout*1000);connection.setInstanceFollowRedirects(false);connection.setRequestProperty("Accept","application/vnd.github+json");if(!token.isEmpty())connection.setRequestProperty("Authorization","Bearer "+token);
                try {int status=connection.getResponseCode();String text=readText(status<400?connection.getInputStream():connection.getErrorStream(),1024*1024);
                    if(status==200){if(new JSONObject(text).getLong("id")!=expected)throw new IOException("仓库 ID 已变化，未执行 Git 传输");return null;}
                    if((status==403||status==429)&&(text.toLowerCase(Locale.ROOT).contains("rate limit")||connection.getHeaderField("Retry-After")!=null)){
                        long seconds=60L*(1L<<Math.min(attempt,4));try{seconds=Math.max(seconds,Long.parseLong(connection.getHeaderField("Retry-After")));}catch(Exception ignored){}
                        if("0".equals(connection.getHeaderField("X-RateLimit-Remaining")))try{seconds=Math.max(seconds,Long.parseLong(connection.getHeaderField("X-RateLimit-Reset"))-System.currentTimeMillis()/1000);}catch(Exception ignored){}
                        network.forget(connection);for(long remaining=seconds;remaining>0;remaining--){check(stop);network.beginTask("GitHub 限流，等待 "+remaining+" 秒；可取消",0);Thread.sleep(1000);}continue;
                    }
                    throw new IOException("GitHub ("+status+")：无法核对固定仓库，请检查权限和仓库地址");
                }finally{network.forget(connection);}
            }
        });
    }
    static long readRepositoryId(PluginCall call)throws IOException {
        Object value=call.getData().opt("expectedRepoId");
        if(value instanceof Number){double number=((Number)value).doubleValue();if(Double.isFinite(number)&&number>0&&number<=9007199254740991d&&number==Math.rint(number))return ((Number)value).longValue();}
        throw new IOException("仓库 ID 缺失或无效，请重新获取仓库信息");
    }
    static String readText(InputStream input,int maximum)throws IOException{if(input==null)return "";try(InputStream stream=input;ByteArrayOutputStream output=new ByteArrayOutputStream()){byte[] buffer=new byte[8192];int n;while((n=stream.read(buffer))!=-1){if(output.size()+n>maximum)throw new IOException("响应超过大小限制");output.write(buffer,0,n);}return output.toString("UTF-8");}}
    private static String remoteHead(String remote,String branch,CredentialsProvider credentials,int timeout,GitNetwork network)throws Exception {
        network.disconnect();
        for(Ref ref:Git.lsRemoteRepository().setRemote(remote).setCredentialsProvider(credentials).setTimeout(timeout).setTransportConfigCallback(network::configure).setHeads(true).call())if(ref.getName().equals("refs/heads/"+branch))return ref.getObjectId().name();return "";
    }
    static boolean hasCommitTree(Repository repository,String head)throws IOException{
        if(!repository.hasObject(ObjectId.fromString(head)))return false;
        try(RevWalk walk=new RevWalk(repository)){return repository.hasObject(walk.parseCommit(ObjectId.fromString(head)).getTree());}
    }
    private void pinForCache(Staged staged,String id,String name,ObjectId commit){
        if(!staged.lease.retain||staged.invalidCache)return;
        try{pinInternalRef(staged.git.getRepository(),name,commit);}catch(IOException failure){staged.invalidCache=true;progress(id,"Git 加速缓存暂不可写，本次传输继续；任务结束后回收临时对象");}
    }
    static void pinInternalRef(Repository repository,String name,ObjectId commit)throws IOException {
        if(!Arrays.asList("refs/gitvault/source","refs/gitvault/target").contains(name))throw new IOException("Git 内部引用无效");
        RefUpdate update=repository.updateRef(name);update.setNewObjectId(commit);
        RefUpdate.Result result=update.forceUpdate();
        if(result!=RefUpdate.Result.NEW&&result!=RefUpdate.Result.FORCED&&result!=RefUpdate.Result.FAST_FORWARD&&result!=RefUpdate.Result.NO_CHANGE)throw new IOException("无法固定 Git 缓存提交："+result);
    }
    static JSObject readSnapshot(Repository repository,String ref,AtomicBoolean stop)throws Exception {
        JSObject result=new JSObject();JSArray files=new JSArray();long total=0;
        try(RevWalk walk=new RevWalk(repository);TreeWalk tree=new TreeWalk(repository)) {
            org.eclipse.jgit.revwalk.RevCommit commit=walk.parseCommit(ObjectId.fromString(ref));tree.addTree(commit.getTree());tree.setRecursive(true);
            while(tree.next()){check(stop);if(tree.getFileMode(0)==FileMode.GITLINK)throw new IOException("项目包含暂不支持的子模块");ObjectLoader loader=repository.open(tree.getObjectId(0));total+=loader.getSize();byte[] bytes=loader.getBytes();if(new String(bytes,0,Math.min(bytes.length,50),StandardCharsets.UTF_8).startsWith("version https://git-lfs.github.com/spec/v1"))throw new IOException("项目包含未下载的 LFS 大文件");JSObject file=new JSObject();file.put("path",tree.getPathString());file.put("sha",tree.getObjectId(0).name());file.put("mode",Integer.toOctalString(tree.getFileMode(0).getBits()));file.put("encoding","base64");file.put("content",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));files.put(file);}
            result.put("commitSha",commit.name());result.put("treeSha",commit.getTree().name());result.put("files",files);return result;
        }
    }
    static ObjectId writeSnapshot(Repository repository,JSArray files,AtomicBoolean stop)throws Exception {
        List<DirCacheEntry> entries=new ArrayList<>();Set<String> paths=new HashSet<>();long total=0;
        try(ObjectInserter insert=repository.newObjectInserter()) {
            for(int i=0;i<files.length();i++){check(stop);JSONObject file=files.getJSONObject(i);String path=file.getString("path");ExportPath.validate(path);for(String segment:path.split("/"))if(segment.equalsIgnoreCase(".git"))throw new IOException("不能写入 Git 内部路径");if(!paths.add(path))throw new IOException("重复的文件路径");int mode=Integer.parseInt(file.optString("mode","100644"),8);if(mode!=0100644&&mode!=0100755&&mode!=0120000)throw new IOException("不支持的文件模式");byte[] bytes=file.optBoolean("isBase64",false)?android.util.Base64.decode(file.getString("content"),android.util.Base64.DEFAULT):file.getString("content").getBytes(StandardCharsets.UTF_8);total+=bytes.length;ObjectId blob=insert.insert(Constants.OBJ_BLOB,bytes);if(file.has("sha")&&!file.getString("sha").equals(blob.name()))throw new IOException("本地文件哈希不一致");DirCacheEntry entry=new DirCacheEntry(path);entry.setFileMode(FileMode.fromBits(mode));entry.setObjectId(blob);entries.add(entry);}
            entries.sort((a,b)->{byte[] x=a.getRawPath(),y=b.getRawPath();for(int i=0;i<Math.min(x.length,y.length);i++)if(x[i]!=y[i])return (x[i]&255)-(y[i]&255);return x.length-y.length;});DirCache cache=DirCache.newInCore();DirCacheBuilder builder=cache.builder();for(DirCacheEntry entry:entries)builder.add(entry);builder.finish();ObjectId tree=cache.writeTree(insert);insert.flush();return tree;
        }
    }
    private static void remove(File file){File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);file.delete();}
}
