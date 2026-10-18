package com.gitvault.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.transport.*;

/** Disk source + production staging/cache + real JGit pushes to a local bare
 * repository. This measures device I/O, not GitHub network throughput. */
@RunWith(AndroidJUnit4.class)
public class NativeSyncBenchmarkTest {
    private static void remove(File file){File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);file.delete();}
    private static ObjectId commit(Repository repo,ObjectId tree,ObjectId parent)throws Exception{
        CommitBuilder builder=new CommitBuilder();builder.setTreeId(tree);if(parent!=null)builder.setParentId(parent);
        PersonIdent author=new PersonIdent("GitVault benchmark","benchmark@example.invalid");builder.setAuthor(author);builder.setCommitter(author);builder.setMessage("Local performance verification");
        try(ObjectInserter insert=repo.newObjectInserter()){ObjectId id=insert.insert(builder);insert.flush();return id;}
    }
    @Test public void firstUnchangedSmallAndInterruptedUploadsPreserveHistoryAndReuseObjects()throws Exception{
        File home=Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir().toPath(),"sync-benchmark-").toFile();
        try{
            File sources=new File(home,"source"),remote=new File(home,"target.git");assertTrue(sources.mkdir());
            byte[][] bodies=new byte[128][];Random random=new Random(77);
            for(int i=0;i<bodies.length;i++){bodies[i]=new byte[65536];random.nextBytes(bodies[i]);Files.write(new File(sources,String.valueOf(i)).toPath(),bodies[i]);}
            GitObjectCache cache=new GitObjectCache(home);ObjectId previous=null,main;
            try(Git target=Git.init().setBare(true).setDirectory(remote).call()){
                ObjectId empty;try(ObjectInserter insert=target.getRepository().newObjectInserter()){empty=insert.insert(Constants.OBJ_TREE,new byte[0]);insert.flush();}
                main=commit(target.getRepository(),empty,null);RefUpdate seed=target.getRepository().updateRef("refs/heads/main");seed.setNewObjectId(main);seed.update();
            }
            for(String scenario:new String[]{"first-upload","unchanged-update","small-update","interrupted-upload","resume-upload"}){
                if(scenario.equals("small-update")||scenario.equals("interrupted-upload")){
                    int first=scenario.equals("small-update")?0:4;
                    for(int i=first;i<first+4;i++){bodies[i][0]^=1;Files.write(new File(sources,String.valueOf(i)).toPath(),bodies[i]);}
                }
                JSArray manifest=new JSArray();String[] hashes=new String[bodies.length];
                for(int i=0;i<bodies.length;i++){
                    MessageDigest hash=MessageDigest.getInstance("SHA-1");hash.update(("blob "+bodies[i].length+"\0").getBytes(java.nio.charset.StandardCharsets.UTF_8));hash.update(bodies[i]);hashes[i]=ObjectId.fromRaw(hash.digest()).name();
                    JSObject entry=new JSObject();entry.put("path","files/"+i);entry.put("sha",hashes[i]);entry.put("mode","100644");manifest.put(entry);
                }
                GitObjectCache.Lease lease=cache.acquire(77,true);AtomicBoolean stop=new AtomicBoolean();long started=android.os.SystemClock.elapsedRealtime(),staged=0,read=0,newObjects=0,reused=0;boolean pushed=false;ObjectId next=previous;
                try(Git git=Git.init().setBare(true).setDirectory(lease.folder).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),lease.folder,stop)){
                    boolean interrupted=scenario.equals("interrupted-upload");
                    for(int i=0;i<bodies.length;i++){
                        if(interrupted&&i==64){stop.set(true);try(InputStream input=new FileInputStream(new File(sources,String.valueOf(i)))){store.appendStream("files/"+i,hashes[i],"100644",bodies[i].length,input);fail("Cancellation must stop staging");}catch(IOException expected){assertTrue(expected.getMessage().contains("取消"));}break;}
                        try(InputStream input=new FileInputStream(new File(sources,String.valueOf(i)))){store.appendStream("files/"+i,hashes[i],"100644",bodies[i].length,input);}
                    }
                    staged=android.os.SystemClock.elapsedRealtime()-started;read=store.sourceBytes;newObjects=store.newObjects;reused=store.reusedObjects;
                    assertEquals((interrupted?64L:128L)*65536,read);
                    assertEquals(scenario.equals("first-upload")?128:scenario.equals("small-update")||interrupted?4:0,newObjects);
                    if(!interrupted){
                        ObjectId tree=store.writeTree(manifest);boolean unchanged=false;
                        if(previous!=null)try(RevWalk walk=new RevWalk(git.getRepository())){unchanged=walk.parseCommit(previous).getTree().equals(tree);}
                        if(!unchanged){
                            next=commit(git.getRepository(),tree,previous);
                            for(PushResult result:git.push().setRemote(remote.getAbsolutePath()).setRefSpecs(new RefSpec(next.name()+":refs/heads/release")).call())for(RemoteRefUpdate update:result.getRemoteUpdates())assertEquals(RemoteRefUpdate.Status.OK,update.getStatus());
                            pushed=true;
                        }
                        GitVaultGitPlugin.pinInternalRef(git.getRepository(),"refs/gitvault/target",next);
                        try(Git target=Git.open(remote);RevWalk walk=new RevWalk(target.getRepository())){
                            assertEquals(next,target.getRepository().resolve("refs/heads/release"));assertEquals(tree,walk.parseCommit(next).getTree().getId());
                            if(pushed&&previous!=null)assertEquals(previous,walk.parseCommit(next).getParent(0).getId());
                        }
                    }
                    try(Git target=Git.open(remote)){assertEquals(main,target.getRepository().resolve("refs/heads/main"));if(interrupted)assertEquals(previous,target.getRepository().resolve("refs/heads/release"));}
                }finally{cache.release(lease);}
                long elapsed=android.os.SystemClock.elapsedRealtime()-started;
                GitObjectCacheTest.benchmark("GITVAULT_SYNC_BENCHMARK scenario="+scenario+" files=128 bytes=8388608 stageMs="+staged+" totalMs="+elapsed+" sourceBytes="+read+" newObjects="+newObjects+" reusedObjects="+reused+" pushed="+pushed);
                previous=next;
            }
            cache.clear();assertEquals(0,cache.bytes());
        }finally{remove(home);}
    }
}
