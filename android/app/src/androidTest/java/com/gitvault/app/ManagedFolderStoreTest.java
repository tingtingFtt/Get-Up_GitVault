package com.gitvault.app;

import android.content.Context;
import androidx.documentfile.provider.DocumentFile;
import androidx.documentfile.provider.FoldingDocumentFile;
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
        final File home,root,index;
        final ManagedFolderStore store;
        Fixture(){this(false,false);}
        Fixture(boolean folded,boolean external){this(folded,external,false);}
        Fixture(boolean folded,boolean external,boolean zeroSize){home=new File(external?context.getExternalFilesDir(null):context.getCacheDir(),"folder-test-"+System.nanoTime());root=new File(home,"selected");index=new File(home,"index");root.mkdirs();DocumentFile provider=DocumentFile.fromFile(root);store=new ManagedFolderStore(context,folded?new FoldingDocumentFile(provider,zeroSize):provider,index);}
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
    @Test public void foldedStoragePreservesBothSourceDirectoriesThroughScanStageExportAndCleanup()throws Exception{
        try(Fixture f=new Fixture(true,true)){
            byte[] upper="upper".getBytes(StandardCharsets.UTF_8),lower="lower".getBytes(StandardCharsets.UTF_8);JSArray expected=new JSArray();expected.put(entry("资源/应用/Bubble/.author",upper));expected.put(entry("资源/应用/bubble/.author",lower));
            String id=f.begin("case",expected).getString("id");f.store.write(id,"资源/应用/Bubble/.author",upper.length,hash(upper),"100644",new ByteArrayInputStream(upper),null);f.store.write(id,"资源/应用/bubble/.author",lower.length,hash(lower),"100644",new ByteArrayInputStream(lower),null);f.store.finish(id);f.store.attach(id,"case","case",false);
            JSObject scanned=f.store.describe(id,true,null);assertFalse(scanned.getBoolean("dirty"));assertEquals(2,scanned.getJSONObject("pathMappings").length());
            try(InputStream input=f.store.open(id,"资源/应用/Bubble/.author")){assertArrayEquals(upper,input.readAllBytes());}try(InputStream input=f.store.open(id,"资源/应用/bubble/.author")){assertArrayEquals(lower,input.readAllBytes());}
            File metadata=new File(f.index,id+".json");assertEquals(2,new JSONObject(new String(Files.readAllBytes(metadata.toPath()),StandardCharsets.UTF_8)).getJSONObject("pathMappings").length());
            JSArray handles=new JSArray(scanned.getJSONArray("files").toString());File gitDir=new File(f.home,"case-git");try(Git git=Git.init().setBare(true).setDirectory(gitDir).call();GitSnapshotStore objects=new GitSnapshotStore(git.getRepository(),gitDir,new AtomicBoolean());ManagedFolderStore.ReadBatch reader=f.store.readBatch()){objects.appendDocuments(handles,reader,message->{});assertNotNull(objects.writeTree(expected));assertArrayEquals(upper,git.getRepository().open(ObjectId.fromString(hash(upper))).getBytes());assertArrayEquals(lower,git.getRepository().open(ObjectId.fromString(hash(lower))).getBytes());}
            f.store.exportFiles("content://test/tree/root","exports/case",handles,new JSONObject());JSONObject exported=new JSONObject(new String(Files.readAllBytes(new File(f.root,"exports/case/.gitvault-export.json").toPath()),StandardCharsets.UTF_8));assertEquals(2,exported.getJSONObject("pathMappings").length());f.store.clear("case","case",false);assertTrue(new File(f.root,"exports/case/.gitvault-export.json").exists());
        }
    }
    @Test public void verificationReportsMissingModifiedAndExtraWithoutDeletingAnything()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] original="old".getBytes(StandardCharsets.UTF_8);JSArray expected=new JSArray();expected.put(entry("a",original));expected.put(entry("missing",original));String id=f.begin("diagnostics",expected).getString("id");f.store.write(id,"a",original.length,hash(original),"100644",new ByteArrayInputStream(original),null);Files.write(f.content(id,"a").toPath(),new byte[]{1});Files.write(f.content(id,"extra").toPath(),original);
            try{f.store.finish(id);fail("Mismatched directory must not publish");}catch(ManagedFolderStore.Verification error){assertFalse(error.repairable);assertEquals(1,error.details.getJSONObject("counts").getInt("missing"));assertEquals(1,error.details.getJSONObject("counts").getInt("modified"));assertEquals(1,error.details.getJSONObject("counts").getInt("extra"));assertTrue(error.getMessage().contains("缺失：missing"));assertTrue(error.getMessage().contains("内容不同：a"));assertTrue(error.getMessage().contains("额外文件：extra"));}
            assertTrue(f.content(id,"extra").exists());File marker=new File(f.content(id,"a").getParentFile().getParentFile(),".gitvault-diagnostic.json");assertTrue(marker.exists());assertEquals(3,new JSONObject(new String(Files.readAllBytes(marker.toPath()),StandardCharsets.UTF_8)).getJSONArray("differences").length());
        }
    }
    @Test public void uncheckpointedCompleteFilesAreRecoveredAndOldIncompatibleCandidatesRemainUntouched()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] body="data".getBytes(StandardCharsets.UTF_8);JSArray expected=new JSArray();expected.put(entry("a",body));String id=f.begin("resume-orphan",expected).getString("id");Files.write(f.content(id,"a").toPath(),body);assertEquals(1,f.begin("resume-orphan",expected).getJSONArray("files").length());f.store.finish(id);
            expected=new JSArray();expected.put(entry("Bubble/a",body));expected.put(entry("bubble/a",body));String previous=f.begin("legacy",expected).getString("id");File meta=new File(f.index,previous+".json");JSONObject saved=new JSONObject(new String(Files.readAllBytes(meta.toPath()),StandardCharsets.UTF_8));saved.remove("pathMappings");Files.write(meta.toPath(),saved.toString().getBytes(StandardCharsets.UTF_8));java.lang.reflect.Field cache=ManagedFolderStore.class.getDeclaredField("memoryIndex");cache.setAccessible(true);((Map<?,?>)cache.get(null)).remove(previous);
            String fresh=f.begin("legacy",expected).getString("id");assertNotEquals(previous,fresh);assertTrue(meta.exists());
        }
    }
    @Test public void gitFetchRepairsTransientMissingAndCorruptFilesOnceThenVerifiesAgain()throws Exception{
        try(Fixture f=new Fixture()){
            File gitDir=new File(f.home,"repair-git");try(Git git=Git.init().setBare(true).setDirectory(gitDir).call()){
                JSArray source=new JSArray();for(String path:Arrays.asList("a","b")){JSObject file=new JSObject();file.put("path",path);file.put("content","source-"+path);file.put("mode","100644");source.put(file);}ObjectId tree=GitVaultGitPlugin.writeSnapshot(git.getRepository(),source,new AtomicBoolean()),commit;
                try(ObjectInserter insert=git.getRepository().newObjectInserter()){CommitBuilder builder=new CommitBuilder();PersonIdent author=new PersonIdent("test","test@example.invalid");builder.setAuthor(author);builder.setCommitter(author);builder.setTreeId(tree);builder.setMessage("repair");commit=insert.insert(builder);insert.flush();}
                try(GitSnapshotStore objects=new GitSnapshotStore(git.getRepository(),gitDir,new AtomicBoolean())){
                    JSArray expected=new JSArray(objects.describe(commit.name()).getJSONArray("files").toString());String id=f.begin(commit.name(),expected).getString("id");int[] validations={0};JSObject result=f.store.fetch(id,git.getRepository(),expected,new AtomicBoolean(),message->{if(message.contains("完整快照")&&validations[0]++==0)try{Files.write(f.content(id,"a").toPath(),new byte[]{1});assertTrue(f.content(id,"b").delete());}catch(Exception error){throw new RuntimeException(error);}});assertEquals(2,result.getInt("repairedFiles"));assertEquals(2,validations[0]);assertFalse(f.store.describe(id,true,null).getBoolean("dirty"));
                }
            }
        }
    }
    @Test(timeout=600000) public void floatMainFullSnapshotRoundTripsOnFoldedInternalStorage()throws Exception{
        final String commit="10b575d509609add902d9ea4bf943f8674583ba3",expectedTree="ee2d5e570ada4b19cedd901e081ec3f13cc567f1";
        try(Fixture f=new Fixture(true,true)){
            File sourceDir=new File(f.home,"float-source"),targetDir=new File(f.home,"float-staged");try(Git source=Git.init().setBare(true).setDirectory(sourceDir).call()){
                source.fetch().setRemote("https://github.com/xiaolongbao0709/ai-virtual-phone-share.git").setTimeout(180).setDepth(1).setRefSpecs(new org.eclipse.jgit.transport.RefSpec(commit+":refs/gitvault/source")).call();
                try(GitSnapshotStore objects=new GitSnapshotStore(source.getRepository(),sourceDir,new AtomicBoolean())){
                    JSObject manifest=objects.describe(commit);assertEquals(expectedTree,manifest.getString("treeSha"));JSArray entries=new JSArray(manifest.getJSONArray("files").toString());assertEquals(2952,entries.length());long total=0;for(int i=0;i<entries.length();i++)total+=entries.getJSONObject(i).getLong("size");assertEquals(478289170L,total);
                    String id=f.begin(commit,entries).getString("id");JSObject saved=f.store.fetch(id,source.getRepository(),entries,new AtomicBoolean(),message->{});assertEquals(2952,saved.getJSONArray("files").length());assertEquals(2,saved.getJSONObject("pathMappings").length());JSArray handles=new JSArray(saved.getJSONArray("files").toString());
                    try(Git target=Git.init().setBare(true).setDirectory(targetDir).call();GitSnapshotStore staged=new GitSnapshotStore(target.getRepository(),targetDir,new AtomicBoolean());ManagedFolderStore.ReadBatch reader=f.store.readBatch()){
                        for(int offset=0;offset<handles.length();offset+=256){JSArray batch=new JSArray();for(int i=offset;i<Math.min(handles.length(),offset+256);i++)batch.put(handles.getJSONObject(i));staged.appendDocuments(batch,reader,message->{});}assertEquals(expectedTree,staged.writeTree(entries).name());
                    }
                    System.out.println("FLOAT_MAIN_VERIFIED commit="+commit+" files="+entries.length()+" bytes="+total+" tree="+expectedTree);
                }
            }
        }
    }

    @Test public void staleProviderLengthDoesNotMasqueradeAsCorruptFileContent()throws Exception{
        try(Fixture f=new Fixture(true,true,true)){
            byte[] bytes="actual bytes".getBytes(StandardCharsets.UTF_8);JSArray expected=new JSArray();expected.put(entry("a",bytes));String id=f.begin("provider-length",expected).getString("id");f.store.write(id,"a",bytes.length,hash(bytes),"100644",new ByteArrayInputStream(bytes),null);f.store.finish(id);JSObject file=f.store.describeFile(id,"a");assertEquals(bytes.length,file.getLong("size"));assertEquals(hash(bytes),file.getString("sha"));assertFalse(f.store.describe(id,true,null).getBoolean("dirty"));
        }
    }

}
