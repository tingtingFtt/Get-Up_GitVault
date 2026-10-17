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
}
