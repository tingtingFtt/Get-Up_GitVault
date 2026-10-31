package com.gitvault.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.*;
import java.util.concurrent.atomic.*;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.transport.RefSpec;

@RunWith(AndroidJUnit4.class)
public class GitRecoveryIntegrationTest {
    @Test public void interruptedNativePushReusesTheSameCommitAndPreservesMappedBranchHistory()throws Exception{
        File folder=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),"git-recovery-"+System.nanoTime());
        try(Git source=Git.init().setBare(true).setDirectory(new File(folder,"source")).call();Git remote=Git.init().setBare(true).setDirectory(new File(folder,"remote")).call()){
            String url=new File(folder,"remote").toURI().toString();ObjectId first=commit(source,null,"first");
            source.push().setRemote(url).setRefSpecs(new RefSpec(first.name()+":refs/heads/dev"),new RefSpec(first.name()+":refs/heads/main")).call();
            ObjectId parent=first;
            for(boolean responseLost:new boolean[]{true,false}){
                ObjectId next=commit(source,parent,responseLost?"lost response":"lost connection");AtomicInteger sends=new AtomicInteger();
                String result=new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{}).push(next.name(),parent.name(),timeout->remote.getRepository().exactRef("refs/heads/dev").getObjectId().name(),timeout->{
                    int attempt=sends.incrementAndGet();
                    if(!responseLost&&attempt==1)throw new EOFException("unexpected end of stream");
                    source.push().setRemote(url).setRefSpecs(new RefSpec(next.name()+":refs/heads/dev")).call();
                    if(responseLost)throw new EOFException("response lost");return null;
                });
                assertEquals(next.name(),result);assertEquals(responseLost?1:2,sends.get());
                assertEquals(first,remote.getRepository().exactRef("refs/heads/main").getObjectId());
                try(RevWalk walk=new RevWalk(remote.getRepository())){assertEquals(parent,walk.parseCommit(next).getParent(0));}
                parent=next;
            }
        }finally{remove(folder);}
    }
    private ObjectId commit(Git git,ObjectId parent,String text)throws Exception{
        try(ObjectInserter insert=git.getRepository().newObjectInserter()){
            TreeFormatter tree=new TreeFormatter();tree.append("content.txt",FileMode.REGULAR_FILE,insert.insert(Constants.OBJ_BLOB,text.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            CommitBuilder commit=new CommitBuilder();PersonIdent author=new PersonIdent("GitVault","gitvault@example.invalid");commit.setAuthor(author);commit.setCommitter(author);commit.setTreeId(insert.insert(tree));if(parent!=null)commit.setParentId(parent);commit.setMessage(text);ObjectId id=insert.insert(commit);insert.flush();return id;
        }
    }
    private static void remove(File file){File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);file.delete();}
}
