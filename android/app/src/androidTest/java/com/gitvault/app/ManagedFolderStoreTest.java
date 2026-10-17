package com.gitvault.app;

import android.content.Context;
import androidx.documentfile.provider.DocumentFile;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.json.*;

@RunWith(AndroidJUnit4.class)
public class ManagedFolderStoreTest {
    private static String hash(byte[] bytes)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+bytes.length+"\0").getBytes(StandardCharsets.UTF_8));digest.update(bytes);return hex(digest.digest());}
    private static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte value:bytes)out.append(String.format(Locale.ROOT,"%02x",value&255));return out.toString();}
    private JSObject entry(String path,byte[] bytes)throws Exception{JSObject value=new JSObject();value.put("path",path);value.put("sha",hash(bytes));value.put("mode","100644");value.put("size",bytes.length);return value;}
    private static void remove(File file){if(file.isDirectory()){File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);}file.delete();}
    private static final class Fixture implements AutoCloseable {
        final Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        final File home=new File(context.getCacheDir(),"folder-test-"+System.nanoTime()),root=new File(home,"selected"),index=new File(home,"index");
        final ManagedFolderStore store;
        Fixture(){root.mkdirs();store=new ManagedFolderStore(context,DocumentFile.fromFile(root),index);}
        JSObject begin(String ref,JSArray expected)throws Exception{return store.begin("content://test/tree/root","[77,\"dev\"]",ref,"project",expected,false);}
        File content(String id,String path)throws Exception{return new File(root,store.describe(id,false,null).getString("location")+"/"+path);}
        public void close(){remove(home);}
    }
    @Test public void candidatesVerifyBeforeSwitchAndCleanupNeverTouchesUnmanagedSiblings()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] first="old".getBytes(StandardCharsets.UTF_8),second="new".getBytes(StandardCharsets.UTF_8);JSArray expected=new JSArray();expected.put(entry("目录/a",first));
            String old=f.begin("old",expected).getString("id");f.store.write(old,"目录/a",first.length,hash(first),"100644",new ByteArrayInputStream(first),null);f.store.finish(old);f.store.attach(old,"owner","old",false);
            File unrelated=new File(f.root,"unrelated.txt");Files.write(unrelated.toPath(),first);
            expected=new JSArray();expected.put(entry("b",second));String next=f.begin("new",expected).getString("id");
            try{f.store.finish(next);fail("Incomplete candidate must not publish");}catch(IOException correct){assertTrue(f.content(old,"目录/a").exists());}
            f.store.write(next,"b",second.length,hash(second),"100644",new ByteArrayInputStream(second),null);f.store.finish(next);f.store.attach(next,"owner","new",false);
            assertTrue(f.store.describe(old,false,null).getBoolean("missing"));assertTrue(f.content(next,"b").exists());f.store.exportFiles("content://test/tree/root","exports/copy",new JSArray(f.store.describe(next,false,null).getJSONArray("files").toString()),new JSONObject());f.store.clear("owner","new",false);assertTrue(new File(f.root,"exports/copy/files/b").exists());assertTrue(f.store.describe(next,false,null).getBoolean("missing"));assertTrue(unrelated.exists());
        }
    }
    @Test public void changedFilesRequireExplicitChoiceAndAutoCleanupOnlyAcceptsVerifiedUploadBytes()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] original="old".getBytes(StandardCharsets.UTF_8),changed="edited".getBytes(StandardCharsets.UTF_8);JSArray manifest=new JSArray();manifest.put(entry("a",original));
            String id=f.begin("old",manifest).getString("id");f.store.write(id,"a",original.length,hash(original),"100644",new ByteArrayInputStream(original),null);f.store.finish(id);f.store.attach(id,"owner","old",false);
            Files.write(f.content(id,"a").toPath(),changed);Files.write(f.content(id,"extra").toPath(),original);
            assertTrue(f.store.describe(id,true,null).getBoolean("dirty"));assertEquals(hash(changed),f.store.describeFile(id,"a").getString("sha"));
            try{f.begin("next",manifest);fail("Remote pull must not replace edited files silently");}catch(ManagedFolderStore.Changed correct){}
            try{f.store.clear("owner","old",false);fail("Auto purge must preserve edits");}catch(ManagedFolderStore.Changed correct){}
            JSArray receipt=new JSArray();receipt.put(entry("a",changed));receipt.put(entry("extra",original));
            f.store.clear("owner","old",false,receipt);assertTrue(f.store.describe(id,false,null).getBoolean("missing"));
        }
    }
    @Test public void resumeRevalidatesCheckpointsAndCancelledCandidatesCanBeSafelyDiscarded()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] bytes="original".getBytes(StandardCharsets.UTF_8);JSArray manifest=new JSArray();manifest.put(entry("a",bytes));String id=f.begin("old",manifest).getString("id");
            f.store.write(id,"a",bytes.length,hash(bytes),"100644",new ByteArrayInputStream(bytes),null);Files.write(f.content(id,"a").toPath(),new byte[]{1});
            assertEquals(0,f.begin("old",manifest).getJSONArray("files").length());
            AtomicBoolean stop=new AtomicBoolean(true);try{f.store.write(id,"a",bytes.length,hash(bytes),"100644",new ByteArrayInputStream(bytes),stop);fail("Cancellation must keep task incomplete");}catch(IOException correct){}
            assertEquals(1,f.store.cleanTemporary(true).getInt("versions"));assertTrue(f.store.describe(id,false,null).getBoolean("missing"));
        }
    }
    @Test public void sharedVersionsAndHistoryHaveIndependentCleanupScopes()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] bytes={1,2,3};JSArray manifest=new JSArray();manifest.put(entry("a",bytes));String id=f.begin("old",manifest).getString("id");f.store.write(id,"a",bytes.length,hash(bytes),"100644",new ByteArrayInputStream(bytes),null);f.store.finish(id);f.store.attach(id,"one","old",true);f.store.attach(id,"two","old",false);
            assertEquals(0,f.store.discard(id).getInt("versions"));f.store.clear("one","old",false);assertTrue(f.content(id,"a").exists());assertEquals(0,f.store.cleanTemporary(false).getInt("versions"));f.store.clear("two","old",false);assertTrue(f.store.describe(id,false,null).getBoolean("missing"));
        }
    }
    @Test public void nativeDocumentStreamsExceed100MiBWithoutMaterializingTheFile()throws Exception{
        try(Fixture f=new Fixture()){
            final long size=101L*1024*1024+7;byte[] block=new byte[65536];Arrays.fill(block,(byte)241);MessageDigest digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+size+"\0").getBytes(StandardCharsets.UTF_8));for(long offset=0;offset<size;offset+=block.length)digest.update(block,0,(int)Math.min(block.length,size-offset));String sha=hex(digest.digest());
            JSObject file=new JSObject();file.put("path","large.bin");file.put("mode","100644");file.put("sha",sha);file.put("size",size);JSArray expected=new JSArray();expected.put(file);String id=f.begin("large",expected).getString("id");
            InputStream generated=new InputStream(){long left=size;public int read(){if(left==0)return -1;left--;return 241;}public int read(byte[] bytes,int offset,int length){if(left==0)return -1;int n=(int)Math.min(length,left);Arrays.fill(bytes,offset,offset+n,(byte)241);left-=n;return n;}};
            f.store.write(id,"large.bin",size,sha,"100644",generated,null);f.store.finish(id);f.store.attach(id,"large","large",false);
            JSONObject metadata=f.store.describe(id,false,null).getJSONArray("files").getJSONObject(0);assertEquals("",metadata.getString("content"));assertEquals(size,f.content(id,"large.bin").length());
            File gitDir=new File(f.home,"git");try(Git git=Git.init().setBare(true).setDirectory(gitDir).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),gitDir,new AtomicBoolean());InputStream input=f.store.open(id,"large.bin")){
                store.appendStream("large.bin",sha,"100644",size,input);assertNotNull(store.writeTree(expected));assertEquals(size,git.getRepository().open(ObjectId.fromString(sha)).getSize());
            }
            f.store.clear("large","large",false);assertTrue(f.store.describe(id,false,null).getBoolean("missing"));
        }
    }
    @Test public void batchDocumentStagingPreservesBytesNamesAndModesAcrossSharedDirectories()throws Exception{
        try(Fixture f=new Fixture()){
            JSArray expected=new JSArray();Map<String,byte[]> bytes=new LinkedHashMap<>();
            for(int i=0;i<150;i++){String path="目录/group-"+(i%3)+"/file-"+i+(i%2==0?".bin":"");byte[] body=i==0?new byte[0]:("源码-"+i+"\n").getBytes(StandardCharsets.UTF_8);bytes.put(path,body);JSObject file=entry(path,body);file.put("mode",i==1?"100755":"100644");expected.put(file);}
            String id=f.begin("batch",expected).getString("id");for(int i=0;i<expected.length();i++){JSONObject file=expected.getJSONObject(i);byte[] body=bytes.get(file.getString("path"));f.store.write(id,file.getString("path"),body.length,file.getString("sha"),file.getString("mode"),new ByteArrayInputStream(body),null);}f.store.finish(id);
            JSArray handles=new JSArray(f.store.describe(id,false,null).getJSONArray("files").toString());File gitDir=new File(f.home,"batch-git");
            try(Git git=Git.init().setBare(true).setDirectory(gitDir).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),gitDir,new AtomicBoolean());ManagedFolderStore.ReadBatch reader=f.store.readBatch()){
                store.appendDocuments(handles,reader,message->{});ObjectId tree=store.writeTree(expected);
                try(org.eclipse.jgit.treewalk.TreeWalk walk=new org.eclipse.jgit.treewalk.TreeWalk(git.getRepository())){walk.addTree(tree);walk.setRecursive(true);int count=0;while(walk.next()){String path=walk.getPathString();assertArrayEquals(bytes.get(path),git.getRepository().open(walk.getObjectId(0)).getBytes());assertEquals(path.endsWith("file-1")?FileMode.EXECUTABLE_FILE:FileMode.REGULAR_FILE,walk.getFileMode(0));count++;}assertEquals(bytes.size(),count);}
            }
        }
    }
    @Test public void failedOrCancelledDocumentBatchesCannotPublishTheExpectedTree()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] body="original".getBytes(StandardCharsets.UTF_8);JSArray expected=new JSArray();expected.put(entry("a",body));String id=f.begin("changed",expected).getString("id");f.store.write(id,"a",body.length,hash(body),"100644",new ByteArrayInputStream(body),null);f.store.finish(id);JSArray handles=new JSArray(f.store.describe(id,false,null).getJSONArray("files").toString());
            Files.write(f.content(id,"a").toPath(),"modified".getBytes(StandardCharsets.UTF_8));AtomicBoolean stop=new AtomicBoolean();File gitDir=new File(f.home,"failed-git");
            try(Git git=Git.init().setBare(true).setDirectory(gitDir).call();GitSnapshotStore store=new GitSnapshotStore(git.getRepository(),gitDir,stop);ManagedFolderStore.ReadBatch reader=f.store.readBatch()){
                try{store.appendDocuments(handles,reader,message->{});fail("Changed source must stop before push");}catch(IOException correct){assertTrue(correct.getMessage().contains("变化"));}
                try{store.writeTree(expected);fail("Failed batch must not publish");}catch(IOException correct){}
                stop.set(true);try{store.appendDocuments(handles,reader,message->{});fail("Cancelled batch must stop");}catch(IOException correct){assertTrue(correct.getMessage().contains("取消"));}
            }
        }
    }
    @Test public void indexedGitFetchStillDetectsChangesBeforePublishingItsFolder()throws Exception{
        try(Fixture f=new Fixture()){
            File gitDir=new File(f.home,"fetch-git");try(Git git=Git.init().setBare(true).setDirectory(gitDir).call()){
                JSArray source=new JSArray();for(int i=0;i<20;i++){JSObject file=new JSObject();file.put("path","shared/f"+i+".txt");file.put("content","text-"+i);file.put("mode","100644");source.put(file);}
                ObjectId tree=GitVaultGitPlugin.writeSnapshot(git.getRepository(),source,new AtomicBoolean()),commit;
                try(ObjectInserter insert=git.getRepository().newObjectInserter()){CommitBuilder builder=new CommitBuilder();PersonIdent author=new PersonIdent("test","test@example.invalid");builder.setAuthor(author);builder.setCommitter(author);builder.setTreeId(tree);builder.setMessage("source");commit=insert.insert(builder);insert.flush();}
                try(GitSnapshotStore objects=new GitSnapshotStore(git.getRepository(),gitDir,new AtomicBoolean())){
                    JSArray expected=new JSArray(objects.describe(commit.name()).getJSONArray("files").toString());String id=f.begin(commit.name(),expected).getString("id");
                    try{f.store.fetch(id,git.getRepository(),expected,new AtomicBoolean(),message->{if(message.contains("完整快照"))try{Files.write(f.content(id,"shared/f0.txt").toPath(),new byte[]{1});}catch(Exception error){throw new RuntimeException(error);}});fail("Final disk verification must detect external changes");}catch(IOException correct){assertTrue(correct.getMessage().contains("变化"));}
                    assertEquals("staging",f.store.describe(id,false,null).getString("state"));
                }
            }
        }
    }
}
