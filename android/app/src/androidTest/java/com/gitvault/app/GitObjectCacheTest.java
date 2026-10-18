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

@RunWith(AndroidJUnit4.class)
public class GitObjectCacheTest {
    private File home()throws IOException{return Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir().toPath(),"cache-test-").toFile();}
    private static void remove(File file){File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);file.delete();}
    private static void put(File folder,String name,int bytes)throws IOException{Files.write(new File(folder,name).toPath(),new byte[bytes]);}
    private static void benchmark(String line)throws IOException{
        File report=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir(),"gitvault-transfer-benchmark.txt");
        try(FileOutputStream output=new FileOutputStream(report,true)){output.write((line+"\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));}
        System.out.println(line);
    }
    @Test public void retentionIsExplicitIdentityScopedAndClearable()throws Exception{
        File home=home();try{
            GitObjectCache cache=new GitObjectCache(home);GitObjectCache.Lease first=cache.acquire(77,true);put(first.folder,"data",4);cache.release(first);assertEquals(4,cache.bytes());
            GitObjectCache.Lease different=cache.acquire(78,true);assertFalse(different.reused);cache.release(different);
            GitObjectCache.Lease resumed=cache.acquire(77,true);assertTrue(resumed.reused);assertTrue(new File(resumed.folder,"data").exists());cache.clear();assertTrue(new File(resumed.folder,"data").exists());cache.release(resumed);cache.clear();assertEquals(0,cache.bytes());
            GitObjectCache.Lease disabled=cache.acquire(77,false);put(disabled.folder,"data",4);cache.release(disabled);assertFalse(disabled.folder.exists());assertEquals(0,cache.bytes());
        }finally{remove(home);}
    }
    @Test public void evictionHonorsBudgetAgeAndActiveLeases()throws Exception{
        File home=home();try{
            GitObjectCache cache=new GitObjectCache(home,7);GitObjectCache.Lease a=cache.acquire(1,true);put(a.folder,"data",4);cache.release(a);GitObjectCache.Lease active=cache.acquire(1,true);
            GitObjectCache.Lease b=cache.acquire(2,true);put(b.folder,"data",8);cache.release(b);assertTrue(cache.bytes()<=7);assertTrue(new File(active.folder,"data").exists());cache.release(active);
            File saved=new File(home,"gitvault-objects-v1/repo-1");assertTrue(saved.setLastModified(System.currentTimeMillis()-GitObjectCache.MAX_AGE-1000));GitObjectCache.Lease expired=cache.acquire(1,true);assertFalse(expired.reused);cache.release(expired);
        }finally{remove(home);}
    }
    @Test public void warmStagingAvoidsCompressionAndWritesButStillValidatesEverySourceByte()throws Exception{
        File home=home();try{
            GitObjectCache cache=new GitObjectCache(home);byte[][] bodies=new byte[128][];String[] hashes=new String[bodies.length];Random random=new Random(77);JSArray entries=new JSArray();
            for(int i=0;i<bodies.length;i++){bodies[i]=new byte[65536];random.nextBytes(bodies[i]);MessageDigest hash=MessageDigest.getInstance("SHA-1");hash.update(("blob "+bodies[i].length+"\0").getBytes(java.nio.charset.StandardCharsets.UTF_8));hash.update(bodies[i]);hashes[i]=ObjectId.fromRaw(hash.digest()).name();JSObject entry=new JSObject();entry.put("path","files/"+i);entry.put("sha",hashes[i]);entry.put("mode","100644");entries.put(entry);}
            String tree="";long coldMs=0,warmMs=0;
            for(int run=0;run<2;run++){
                GitObjectCache.Lease lease=cache.acquire(77,true);assertEquals(run==1,lease.reused);long start=android.os.SystemClock.elapsedRealtime();
                try(Git git=Git.init().setBare(true).setDirectory(lease.folder).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),lease.folder,new AtomicBoolean())){
                    for(int i=0;i<bodies.length;i++)store.appendStream("files/"+i,hashes[i],"100644",bodies[i].length,new ByteArrayInputStream(bodies[i]));
                    String actual=store.writeTree(entries).name();if(run==0)tree=actual;else assertEquals(tree,actual);
                    assertEquals(8388608L,store.sourceBytes);assertEquals(run==0?128:0,store.newObjects);assertEquals(run==0?0:128,store.reusedObjects);
                    byte[] corrupt=Arrays.copyOf(bodies[0],bodies[0].length);corrupt[0]^=1;
                    try{store.appendStream("changed",hashes[0],"100644",corrupt.length,new ByteArrayInputStream(corrupt));fail("A cached object must not hide changed source bytes");}catch(IOException expected){assertTrue(expected.getMessage().contains("变化"));}
                }
                long elapsed=android.os.SystemClock.elapsedRealtime()-start;if(run==0)coldMs=elapsed;else warmMs=elapsed;cache.release(lease);
            }
            benchmark("GITVAULT_BENCHMARK files=128 bytes=8388608 coldStageMs="+coldMs+" warmStageMs="+warmMs+" coldNewObjects=128 warmNewObjects=0 warmReusedObjects=128 tree="+tree);
            cache.clear();assertEquals(0,cache.bytes());
        }finally{remove(home);}
    }
    @Test public void cachedShallowRepositoriesCanFetchThePinnedCommitAgain()throws Exception{
        File home=home();try{
            GitObjectCache cache=new GitObjectCache(home);String commit="20bcc4da49f82080513540befc663799fd707fa4";
            for(int run=0;run<3;run++){
                if(run==2)commit="a1d9c81b89f4564266b7a3ccf4b284a5671b474e";
                GitObjectCache.Lease lease=cache.acquire(77,true);long start=android.os.SystemClock.elapsedRealtime();
                try(Git git=Git.init().setBare(true).setDirectory(lease.folder).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),lease.folder,new AtomicBoolean())){
                    if(run<2)assertEquals(run==1,git.getRepository().hasObject(ObjectId.fromString(commit)));
                    git.fetch().setRemote("https://github.com/tingtingFtt/Get-Up_GitVault.git").setDepth(1).setTimeout(180).setRefSpecs(new org.eclipse.jgit.transport.RefSpec("+"+commit+":refs/gitvault/source")).call();
                    assertEquals(run==2?"0eac81e38a73452529108ba3654317062d12be3c":"93654ba0fcbc4533e6c68803976ca279978dc4ff",store.describe(commit).getString("treeSha"));
                    GitVaultGitPlugin.pinInternalRef(git.getRepository(),"refs/gitvault/source",ObjectId.fromString(commit));
                    assertEquals(commit,git.getRepository().resolve("refs/gitvault/source").name());
                    benchmark("GITVAULT_FETCH_BENCHMARK cacheHit="+lease.reused+" fetchMs="+(android.os.SystemClock.elapsedRealtime()-start));
                }cache.release(lease);
            }
        }finally{remove(home);}
    }
    @Test public void objectReuseWithinATaskStillHonorsCancellation()throws Exception{
        File home=home();try(Git git=Git.init().setBare(true).setDirectory(home).call()){
            byte[] bytes={1,2,3};AtomicBoolean stop=new AtomicBoolean();String sha;
            try(ObjectInserter hash=git.getRepository().newObjectInserter()){sha=hash.idFor(Constants.OBJ_BLOB,bytes).name();}
            try(GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),home,stop)){
                store.appendStream("first",sha,"100644",bytes.length,new ByteArrayInputStream(bytes));store.appendStream("alias",sha,"100644",bytes.length,new ByteArrayInputStream(bytes));assertEquals(1,store.newObjects);assertEquals(1,store.reusedObjects);
                stop.set(true);try{store.appendStream("cancelled",sha,"100644",bytes.length,new ByteArrayInputStream(bytes));fail("Cached objects must not bypass cancellation");}catch(IOException expected){assertTrue(expected.getMessage().contains("取消"));}
            }
        }finally{remove(home);}
    }
    @Test public void chunkedAndDirectoryUploadsShareValidatedObjectReuse()throws Exception{
        File home=home();try(Git git=Git.init().setBare(true).setDirectory(home).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),home,new AtomicBoolean())){
            byte[] bytes={1,2,3};String sha;try(ObjectInserter hash=git.getRepository().newObjectInserter()){sha=hash.idFor(Constants.OBJ_BLOB,bytes).name();}
            store.appendStream("directory",sha,"100644",bytes.length,new ByteArrayInputStream(bytes));
            JSObject chunk=new JSObject();chunk.put("path","chunked");chunk.put("sha",sha);chunk.put("mode","100644");chunk.put("offset",0);chunk.put("done",true);chunk.put("content",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));store.append(chunk);
            assertEquals(1,store.newObjects);assertEquals(1,store.reusedObjects);assertEquals(6,store.sourceBytes);
            chunk.put("path","corrupt");chunk.put("content","BAUG");try{store.append(chunk);fail("Chunked cache hits must verify the new bytes");}catch(IOException expected){assertTrue(expected.getMessage().contains("哈希不一致"));}
        }finally{remove(home);}
    }
}
