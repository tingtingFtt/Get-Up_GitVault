package com.gitvault.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.File;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
import com.getcapacitor.*;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.transport.RefSpec;

@RunWith(AndroidJUnit4.class)
public class GitTransferTest {
    @Test public void repositoryIdsSurviveRealJsonAndCapacitorPluginCall()throws Exception {
        for(long id:new long[]{42L,2147483647L,2147483648L,9007199254740991L}){
            JSObject data=new JSObject("{\"expectedRepoId\":"+id+"}");
            PluginCall call=new PluginCall(null,"GitVaultGit","test","transfer",data);
            if(id<=Integer.MAX_VALUE){assertTrue(data.opt("expectedRepoId") instanceof Integer);assertEquals(Long.valueOf(0L),call.getLong("expectedRepoId",0L));}
            assertEquals(id,GitVaultGitPlugin.readRepositoryId(call));
        }
        for(String json:new String[]{"{}","{\"expectedRepoId\":null}","{\"expectedRepoId\":\"42\"}","{\"expectedRepoId\":0}","{\"expectedRepoId\":-1}","{\"expectedRepoId\":1.5}","{\"expectedRepoId\":9007199254740992}"}){
            try{GitVaultGitPlugin.readRepositoryId(new PluginCall(null,"GitVaultGit","test","transfer",new JSObject(json)));fail("Invalid repository ID must be rejected");}
            catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("仓库 ID"));}
        }
    }
    private JSObject file(String path,String content,String mode){JSObject file=new JSObject();file.put("path",path);file.put("content",content);file.put("mode",mode);return file;}
    @Test public void diskBackedSnapshotExceeds100MiBWithBoundedChunks()throws Exception{
        File folder=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),"git-large-test-"+System.nanoTime());
        AtomicBoolean stop=new AtomicBoolean();long total=0;
        try(Git git=Git.init().setBare(true).setDirectory(folder).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),folder,stop)){
            byte[] bytes=new byte[1024*1024+1];Arrays.fill(bytes,(byte)173);JSArray expected=new JSArray();
            for(int i=0;i<101;i++){
                bytes[0]=(byte)i;String sha;try(ObjectInserter insert=git.getRepository().newObjectInserter()){sha=insert.idFor(Constants.OBJ_BLOB,bytes).name();}
                String path="资源/file-"+i+".bin";JSObject metadata=new JSObject();metadata.put("path",path);metadata.put("sha",sha);metadata.put("mode","100644");expected.put(metadata);
                for(int offset=0;offset<bytes.length;offset+=GitSnapshotStore.CHUNK_BYTES){
                    JSObject chunk=new JSObject(metadata.toString());chunk.put("offset",offset);chunk.put("done",offset+GitSnapshotStore.CHUNK_BYTES>=bytes.length);chunk.put("content",android.util.Base64.encodeToString(Arrays.copyOfRange(bytes,offset,Math.min(bytes.length,offset+GitSnapshotStore.CHUNK_BYTES)),android.util.Base64.NO_WRAP));store.append(chunk);
                }
            }
            ObjectId tree=store.writeTree(expected),commitId;
            try(ObjectInserter insert=git.getRepository().newObjectInserter()){
                CommitBuilder commit=new CommitBuilder();PersonIdent author=new PersonIdent("GitVault","gitvault@example.invalid");commit.setAuthor(author);commit.setCommitter(author);commit.setTreeId(tree);commit.setMessage("large snapshot");commitId=insert.insert(commit);insert.flush();
            }
            JSObject manifest=store.describe(commitId.name());assertEquals(101,manifest.getJSONArray("files").length());
            for(int i=0;i<101;i++){
                org.json.JSONObject entry=manifest.getJSONArray("files").getJSONObject(i);assertFalse(entry.has("content"));long offset=0;
                java.security.MessageDigest hash=java.security.MessageDigest.getInstance("SHA-1");hash.update(("blob "+entry.getLong("size")+"\0").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                do{JSObject chunk=store.readChunk(entry.getString("path"),offset);byte[] part=android.util.Base64.decode(chunk.getString("content"),android.util.Base64.DEFAULT);assertTrue(part.length<=GitSnapshotStore.CHUNK_BYTES);hash.update(part);offset+=part.length;}while(offset<entry.getLong("size"));
                StringBuilder actual=new StringBuilder();for(byte value:hash.digest())actual.append(String.format("%02x",value&255));assertEquals(entry.getString("sha"),actual.toString());total+=offset;
            }
            assertTrue(total>100L*1024*1024);stop.set(true);
            try{store.readChunk(manifest.getJSONArray("files").getJSONObject(0).getString("path"),0);fail("Cancellation must stop chunk reads");}catch(java.io.IOException expectedError){assertTrue(expectedError.getMessage().contains("取消"));}
        }finally{remove(folder);}
    }
    @Test public void incompleteOrCorruptStagingCannotPublishATree()throws Exception{
        File folder=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),"git-invalid-test-"+System.nanoTime());
        try(Git git=Git.init().setBare(true).setDirectory(folder).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),folder,new AtomicBoolean())){
            JSObject chunk=new JSObject();chunk.put("path","a.bin");chunk.put("mode","100644");chunk.put("sha","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");chunk.put("offset",0);chunk.put("content","dGVzdA==");chunk.put("done",false);store.append(chunk);
            try{store.writeTree(new JSArray());fail("Incomplete chunks must never publish a tree");}catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("未全部落盘"));}
            chunk.put("offset",4);chunk.put("content","");chunk.put("done",true);
            try{store.append(chunk);fail("Wrong object hash must never be accepted");}catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("哈希不一致"));}
        }finally{remove(folder);}
    }
    @Test public void nativeGitPreservesBytesModesBranchAndHistory()throws Exception{
        File folder=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),"git-test-"+System.nanoTime());
        File destination=new File(folder,"remote"),source=new File(folder,"source");
        try(Git remote=Git.init().setBare(true).setDirectory(destination).call();Git git=Git.init().setBare(true).setDirectory(source).call()){
            AtomicBoolean stop=new AtomicBoolean();JSArray files=new JSArray();files.put(file("目录/a.txt","hello\n","100644"));files.put(file("run.sh","echo hi\n","100755"));JSObject binary=file("binary.bin","AP8BAg==","100644");binary.put("isBase64",true);files.put(binary);
            ObjectId tree=GitVaultGitPlugin.writeSnapshot(git.getRepository(),files,stop);ObjectId first;
            try(ObjectInserter insert=git.getRepository().newObjectInserter()) {CommitBuilder commit=new CommitBuilder();PersonIdent author=new PersonIdent("GitVault","gitvault@example.invalid");commit.setAuthor(author);commit.setCommitter(author);commit.setTreeId(tree);commit.setMessage("first");first=insert.insert(commit);insert.flush();}
            git.push().setRemote(destination.toURI().toString()).setRefSpecs(new RefSpec(first.name()+":refs/heads/dev")).call();
            assertTrue(GitVaultGitPlugin.hasCommitTree(git.getRepository(),first.name()));
            assertFalse(GitVaultGitPlugin.hasCommitTree(git.getRepository(),"ffffffffffffffffffffffffffffffffffffffff"));
            assertNull(remote.getRepository().exactRef("refs/heads/main"));assertEquals(first,remote.getRepository().exactRef("refs/heads/dev").getObjectId());
            JSObject snapshot=GitVaultGitPlugin.readSnapshot(git.getRepository(),first.name(),stop);assertEquals(3,snapshot.getJSONArray("files").length());assertEquals(tree.name(),snapshot.getString("treeSha"));
            JSArray next=new JSArray();next.put(file("new.txt","new","100644"));ObjectId nextTree=GitVaultGitPlugin.writeSnapshot(git.getRepository(),next,stop);ObjectId second;
            try(ObjectInserter insert=git.getRepository().newObjectInserter()){CommitBuilder commit=new CommitBuilder();PersonIdent author=new PersonIdent("GitVault","gitvault@example.invalid");commit.setAuthor(author);commit.setCommitter(author);commit.setParentId(first);commit.setTreeId(nextTree);commit.setMessage("second");second=insert.insert(commit);insert.flush();}
            git.push().setRemote(destination.toURI().toString()).setRefSpecs(new RefSpec(second.name()+":refs/heads/dev")).call();
            assertEquals(second,remote.getRepository().exactRef("refs/heads/dev").getObjectId());assertEquals(1,GitVaultGitPlugin.readSnapshot(git.getRepository(),second.name(),stop).getJSONArray("files").length());assertTrue(git.getRepository().hasObject(first));
            stop.set(true);try{GitVaultGitPlugin.writeSnapshot(git.getRepository(),files,stop);fail("Cancellation must stop native Git");}catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("取消"));}
        }finally{remove(folder);}
    }
    @Test public void nativeGitFetchesPinnedPublicGitHubCommitOverHttps()throws Exception{
        File folder=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),"git-https-test-"+System.nanoTime());
        try(Git git=Git.init().setBare(true).setDirectory(folder).call()){
            String commit="b9ad1a1688992240e27b84e90be514c6ee866110";
            AtomicBoolean stop=new AtomicBoolean();
            try(GitNetwork network=new GitNetwork(stop,message->{})){
                new GitTransferRecovery(stop,message->{},milliseconds->{}).read("public HTTPS",timeout->git.fetch().setRemote("https://github.com/tingtingFtt/Get-Up_GitVault.git").setTimeout(timeout).setTransportConfigCallback(network::configure).setDepth(1).setTagOpt(org.eclipse.jgit.transport.TagOpt.NO_TAGS).setProgressMonitor(network).setRefSpecs(new RefSpec(commit+":refs/gitvault/source")).call());
            }
            JSObject snapshot=GitVaultGitPlugin.readSnapshot(git.getRepository(),commit,new AtomicBoolean());
            assertEquals(commit,snapshot.getString("commitSha"));assertTrue(snapshot.getJSONArray("files").length()>90);
        }finally{remove(folder);}
    }
    @Test public void updaterAcceptsOnlyThisProjectsHttpsReleaseApks(){
        assertTrue(AppUpdaterPlugin.allowedDownload("https://github.com/tingtingFtt/Get-Up_GitVault/releases/download/android-v1.0.7/GitVault-debug.apk"));
        for(String url:new String[]{"http://github.com/tingtingFtt/Get-Up_GitVault/releases/download/x/a.apk","https://evil.test/a.apk","https://github.com/other/repo/releases/download/x/a.apk","https://github.com/tingtingFtt/Get-Up_GitVault/releases/download/x/a.apk?token=secret","https://me:secret@github.com/tingtingFtt/Get-Up_GitVault/releases/download/x/a.apk"})assertFalse(url,AppUpdaterPlugin.allowedDownload(url));
    }
    private static void remove(File folder){File[] children=folder.listFiles();if(children!=null)for(File child:children)remove(child);folder.delete();}
}
