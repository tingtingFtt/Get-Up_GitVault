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
    private final ConcurrentHashMap<String,AtomicBoolean> cancelled = new ConcurrentHashMap<>();
    private final Map<String,Staged> sessions=new HashMap<>();
    private static final class Staged {
        final File folder;final Git git;final GitSnapshotStore store;
        Staged(File folder,AtomicBoolean stop)throws Exception{this.folder=folder;git=Git.init().setBare(true).setDirectory(folder).call();store=new GitSnapshotStore(git.getRepository(),folder,stop);git.getRepository().getConfig().setString("gc",null,"auto","0");}
    }
    private Staged createSession(String id,PluginCall call)throws Exception{
        File folder=new File(getContext().getCacheDir(),"gitvault-session-"+UUID.randomUUID());
        Staged staged=null;
        try{staged=new Staged(folder,cancelled.get(id));long total=call.getData().optLong("totalBytes",0);if(total<0||total>Long.MAX_VALUE/3)throw new IOException("项目大小无效");staged.store.ensureSpace(total*3);sessions.put(id,staged);return staged;}
        catch(Exception error){if(staged!=null){staged.git.close();}remove(folder);throw error;}
    }
    private void releaseSession(String id){Staged staged=sessions.remove(id);if(staged!=null){try{staged.store.close();}catch(Exception ignored){}staged.git.close();remove(staged.folder);}cancelled.remove(id);}
    @Override public void load(){File[] leftovers=getContext().getCacheDir().listFiles((dir,name)->name.startsWith("gitvault-session-"));if(leftovers!=null)for(File file:leftovers)remove(file);}
    @Override protected void handleOnDestroy(){for(AtomicBoolean stop:cancelled.values())stop.set(true);io.execute(()->{for(String id:new ArrayList<>(sessions.keySet()))releaseSession(id);});io.shutdown();}
    @PluginMethod public void prepareUpload(PluginCall call){String id=call.getString("id","");if(id.isEmpty()||cancelled.putIfAbsent(id,new AtomicBoolean())!=null){call.reject("Git 任务 ID 无效");return;}io.execute(()->{try{createSession(id,call);call.resolve();}catch(Exception error){releaseSession(id);call.reject(error.getMessage());}});}
    @PluginMethod public void readChunk(PluginCall call){chunkCall(call,false);}
    @PluginMethod public void appendChunk(PluginCall call){chunkCall(call,true);}
    private void chunkCall(PluginCall call,boolean upload){String id=call.getString("id","");io.execute(()->{try{Staged staged=sessions.get(id);if(staged==null)throw new IOException("Git 临时任务已结束，请重试");if(upload){staged.store.append(call.getData());call.resolve();}else call.resolve(staged.store.readChunk(call.getString("path",""),call.getData().getLong("offset")));}catch(Exception error){call.reject(error.getMessage(),cancelled.get(id)!=null&&cancelled.get(id).get()?"CANCELLED":"GIT_TRANSFER");}});}
    @PluginMethod public void release(PluginCall call){String id=call.getString("id","");io.execute(()->{releaseSession(id);call.resolve();});}
    @PluginMethod public void cancel(PluginCall call) { String id=call.getString("id","");if(!id.isEmpty())cancelled.computeIfAbsent(id,key->new AtomicBoolean()).set(true);call.resolve(); }
    @PluginMethod public void transfer(PluginCall call) {
        String id=call.getString("id","");boolean fetching="fetch".equals(call.getString("action",""));if(id.isEmpty()||(fetching?cancelled.putIfAbsent(id,new AtomicBoolean())!=null:!cancelled.containsKey(id))){call.reject("Git 任务 ID 无效");return;}
        io.execute(()->{boolean retain=false;String token=call.getString("token","");
            try {
                String owner=call.getString("owner",""),name=call.getString("repo",""),action=call.getString("action","");
                if(!owner.matches("[A-Za-z0-9_.-]+")||!name.matches("[A-Za-z0-9_.-]+")||!Arrays.asList("fetch","push").contains(action))throw new IOException("Git 仓库参数无效");
                AtomicBoolean stop=cancelled.get(id); check(stop);
                long expectedRepoId=readRepositoryId(call);
                verifyIdentity(owner,name,expectedRepoId,token,stop);
                Staged staged=fetching?createSession(id,call):sessions.get(id);if(staged==null)throw new IOException("Git 上传暂存已结束，请重试");
                { Git git=staged.git;
                    String remote="https://github.com/"+owner+"/"+name+".git";
                    CredentialsProvider credentials=new UsernamePasswordCredentialsProvider("x-access-token",token);
                    ProgressMonitor monitor=new ProgressMonitor(){
                        public void start(int totalTasks){} public void beginTask(String title,int totalWork){progress(id,title);} public void update(int completed){} public void endTask(){} public boolean isCancelled(){return stop.get();} public void showDuration(boolean enabled){}
                    };
                    JSObject result;
                    if(action.equals("fetch")) {
                        String ref=call.getString("ref","");if(!ref.matches("[a-f0-9]{40}"))throw new IOException("拉取必须固定完整提交 SHA");
                        git.fetch().setRemote(remote).setCredentialsProvider(credentials).setTimeout(60).setDepth(1).setRefSpecs(new RefSpec(ref+":refs/gitvault/source")).setProgressMonitor(monitor).call();
                        check(stop);result=staged.store.describe(ref);retain=true;
                    } else {
                        String branch=call.getString("branch","");if(!Repository.isValidRefName("refs/heads/"+branch))throw new IOException("Git 分支名称无效");
                        ObjectId tree=staged.store.writeTree(call.getArray("files",new JSArray()));
                        result=null;
                        for(int attempt=0;attempt<3;attempt++) {
                            check(stop);String head=remoteHead(remote,branch,credentials);
                            ObjectId parent=null;
                            if(!head.isEmpty()) {
                                git.fetch().setRemote(remote).setCredentialsProvider(credentials).setTimeout(60).setDepth(1).setRefSpecs(new RefSpec("refs/heads/"+branch+":refs/gitvault/target")).setProgressMonitor(monitor).call();
                                parent=git.getRepository().resolve("refs/gitvault/target");
                            }
                            ObjectId commit;
                            try(RevWalk walk=new RevWalk(git.getRepository());ObjectInserter insert=git.getRepository().newObjectInserter()) {
                                if(parent!=null&&walk.parseCommit(parent).getTree().equals(tree))commit=parent;
                                else { CommitBuilder builder=new CommitBuilder();builder.setTreeId(tree);if(parent!=null)builder.setParentId(parent);PersonIdent author=new PersonIdent("GitVault","gitvault@users.noreply.github.com");builder.setAuthor(author);builder.setCommitter(author);builder.setMessage(call.getString("message","Sync project snapshot via GitVault"));commit=insert.insert(builder);insert.flush(); }
                            }
                            verifyIdentity(owner,name,expectedRepoId,token,stop);check(stop);
                            Exception failure=null;
                            if(!commit.equals(parent)) try {
                                Iterable<PushResult> pushed=git.push().setRemote(remote).setCredentialsProvider(credentials).setTimeout(60).setRefSpecs(new RefSpec(commit.name()+":refs/heads/"+branch)).setProgressMonitor(monitor).call();
                                for(PushResult pushedResult:pushed)for(RemoteRefUpdate update:pushedResult.getRemoteUpdates())if(update.getStatus()!=RemoteRefUpdate.Status.OK&&update.getStatus()!=RemoteRefUpdate.Status.UP_TO_DATE)throw new IOException("Git 推送拒绝："+update.getStatus());
                            }catch(Exception exception){failure=exception;}
                            String actual=remoteHead(remote,branch,credentials);check(stop);
                            if(actual.equals(commit.name())) {result=new JSObject();result.put("commitSha",commit.name());result.put("treeSha",tree.name());result.put("branch",branch);result.put("repoId",expectedRepoId);result.put("verified",true);break;}
                            if(call.getBoolean("rebaseOnConflict",false)&&!actual.equals(parent==null?"":parent.name())&&attempt<2)continue;
                            if(failure!=null)throw failure;throw new IOException("目标分支在推送期间变化；本地文件保留，不会强推");
                        }
                        if(result==null)throw new IOException("目标分支持续变化，请稍后重试");
                    }
                    check(stop);call.resolve(result);
                }
            }catch(Exception exception){String message=exception.getMessage()==null?"原生 Git 传输失败":exception.getMessage();if(!token.isEmpty())message=message.replace(token,"[redacted]");call.reject(message,cancelled.get(id)!=null&&cancelled.get(id).get()?"CANCELLED":"GIT_TRANSFER");}
            finally {if(!retain)releaseSession(id);}
        });
    }
    private void progress(String id,String message){JSObject value=new JSObject();value.put("id",id);value.put("message","原生 Git："+message);notifyListeners("progress",value);}
    private static void check(AtomicBoolean stop)throws IOException{if(stop.get()||Thread.currentThread().isInterrupted())throw new IOException("Git 任务已取消，本地文件保留");}
    static long readRepositoryId(PluginCall call)throws IOException {
        // Capacitor getLong only accepts Long; JSON also represents valid IDs as Integer.
        Object value=call.getData().opt("expectedRepoId");
        if(value instanceof Number){
            double number=((Number)value).doubleValue();
            if(Double.isFinite(number)&&number>0&&number<=9007199254740991d&&number==Math.rint(number))return ((Number)value).longValue();
        }
        throw new IOException("仓库 ID 缺失或无效，请重新获取仓库信息");
    }
    private void verifyIdentity(String owner,String name,long expected,String token,AtomicBoolean stop)throws Exception {
        if(expected<=0)throw new IOException("仓库 ID 无效，请重新获取仓库信息");
        for(int attempt=0;;attempt++){
            check(stop);HttpURLConnection connection=(HttpURLConnection)new URL("https://api.github.com/repos/"+owner+"/"+name).openConnection();connection.setConnectTimeout(15000);connection.setReadTimeout(15000);connection.setInstanceFollowRedirects(false);connection.setRequestProperty("Accept","application/vnd.github+json");if(!token.isEmpty())connection.setRequestProperty("Authorization","Bearer "+token);
            try {int status=connection.getResponseCode();String text=readText(status<400?connection.getInputStream():connection.getErrorStream(),1024*1024);
                if(status==200){if(new JSONObject(text).getLong("id")!=expected)throw new IOException("仓库 ID 已变化，未执行 Git 传输");return;}
                if((status==403||status==429)&&(text.toLowerCase(Locale.ROOT).contains("rate limit")||connection.getHeaderField("Retry-After")!=null)){
                    long seconds=60L*(1L<<Math.min(attempt,4));try{seconds=Math.max(seconds,Long.parseLong(connection.getHeaderField("Retry-After")));}catch(Exception ignored){}
                    if("0".equals(connection.getHeaderField("X-RateLimit-Remaining")))try{seconds=Math.max(seconds,Long.parseLong(connection.getHeaderField("X-RateLimit-Reset"))-System.currentTimeMillis()/1000);}catch(Exception ignored){}
                    connection.disconnect();for(long remaining=seconds;remaining>0;remaining--){check(stop);progress("", "GitHub 限流，等待 "+remaining+" 秒；可取消");Thread.sleep(1000);}continue;
                }
                throw new IOException("GitHub ("+status+")：无法核对固定仓库，请检查权限和仓库地址");
            }finally{connection.disconnect();}
        }
    }
    static String readText(InputStream input,int maximum)throws IOException{if(input==null)return "";try(InputStream stream=input;ByteArrayOutputStream output=new ByteArrayOutputStream()){byte[] buffer=new byte[8192];int n;while((n=stream.read(buffer))!=-1){if(output.size()+n>maximum)throw new IOException("响应超过大小限制");output.write(buffer,0,n);}return output.toString("UTF-8");}}
    private static String remoteHead(String remote,String branch,CredentialsProvider credentials)throws Exception {
        for(Ref ref:Git.lsRemoteRepository().setRemote(remote).setCredentialsProvider(credentials).setTimeout(60).setHeads(true).call())if(ref.getName().equals("refs/heads/"+branch))return ref.getObjectId().name();return "";
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
