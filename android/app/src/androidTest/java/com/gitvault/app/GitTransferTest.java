package com.gitvault.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;
import com.getcapacitor.*;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.transport.RefSpec;

@RunWith(AndroidJUnit4.class)
public class GitTransferTest {
    private JSObject file(String path,String content,String mode){JSObject file=new JSObject();file.put("path",path);file.put("content",content);file.put("mode",mode);return file;}
    @Test public void nativeGitPreservesBytesModesBranchAndHistory()throws Exception{
        File folder=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),"git-test-"+System.nanoTime());
        File destination=new File(folder,"remote"),source=new File(folder,"source");
        try(Git remote=Git.init().setBare(true).setDirectory(destination).call();Git git=Git.init().setBare(true).setDirectory(source).call()){
            AtomicBoolean stop=new AtomicBoolean();JSArray files=new JSArray();files.put(file("目录/a.txt","hello\n","100644"));files.put(file("run.sh","echo hi\n","100755"));JSObject binary=file("binary.bin","AP8BAg==","100644");binary.put("isBase64",true);files.put(binary);
            ObjectId tree=GitVaultGitPlugin.writeSnapshot(git.getRepository(),files,stop);ObjectId first;
            try(ObjectInserter insert=git.getRepository().newObjectInserter()) {CommitBuilder commit=new CommitBuilder();PersonIdent author=new PersonIdent("GitVault","gitvault@example.invalid");commit.setAuthor(author);commit.setCommitter(author);commit.setTreeId(tree);commit.setMessage("first");first=insert.insert(commit);insert.flush();}
            git.push().setRemote(destination.toURI().toString()).setRefSpecs(new RefSpec(first.name()+":refs/heads/dev")).call();
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
            git.fetch().setRemote("https://github.com/tingtingFtt/Get-Up_GitVault.git").setTimeout(60).setDepth(1).setRefSpecs(new RefSpec(commit+":refs/gitvault/source")).call();
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
