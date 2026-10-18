package com.gitvault.app;

import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import android.graphics.Bitmap;
import android.media.ExifInterface;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.documentfile.provider.DocumentFile;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.json.*;

/** Actual ExternalStorageProvider on shared storage, not a filesystem-backed
 * DocumentFile double. Only an isolated test-created directory is touched. */
@RunWith(AndroidJUnit4.class)
public class ManagedMediaInputTest {
    private static final String AUTHORITY="com.android.externalstorage.documents";
    private static String hash(byte[] body)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+body.length+"\0").getBytes(java.nio.charset.StandardCharsets.UTF_8));digest.update(body);return ObjectId.fromRaw(digest.digest()).name();}
    private static void remove(File file){File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);file.delete();}
    private static DocumentFile find(DocumentFile root,String path){DocumentFile doc=root;for(String part:path.split("/")){doc=doc.findFile(part);assertNotNull("Missing test document: "+path,doc);}return doc;}
    private static byte[] reportedPhoto()throws Exception{
        String path="%E8%B5%84%E6%BA%90/Js%E6%8F%92%E4%BB%B6/%E9%9D%A2%E6%9D%BF%E6%8C%89%E9%92%AE%E5%88%86%E9%A1%B5/IMG_20260824_092655.jpg";
        HttpURLConnection connection=(HttpURLConnection)new URL("https://raw.githubusercontent.com/xiaolongbao0709/ai-virtual-phone-share/616f16f29011673299cab0e586682c048c86ac3b/"+path).openConnection();connection.setConnectTimeout(60000);connection.setReadTimeout(60000);
        try(InputStream input=connection.getInputStream()) {byte[] bytes=input.readAllBytes();assertEquals(238293,bytes.length);assertEquals("9d901d1fbc202bc2788f8d1d588333b492d665a0",hash(bytes));return bytes;}finally{connection.disconnect();}
    }
    private static boolean hasText(AccessibilityNodeInfo node,String text){
        if(node==null)return false;if(node.getText()!=null&&node.getText().toString().contains(text)||node.getContentDescription()!=null&&node.getContentDescription().toString().contains(text))return true;
        for(int i=0;i<node.getChildCount();i++)if(hasText(node.getChild(i),text))return true;return false;
    }
    private static boolean clickText(AccessibilityNodeInfo node,String text){
        if(node==null)return false;
        if(node.getText()!=null&&node.getText().toString().equalsIgnoreCase(text)){
            AccessibilityNodeInfo target=node;for(int i=0;i<4&&target!=null;i++,target=target.getParent())if(target.isEnabled()&&target.isClickable())return target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        for(int i=0;i<node.getChildCount();i++)if(clickText(node.getChild(i),text))return true;return false;
    }
    private static Uri authorizeTestDirectory(Context context,UiAutomation automation,ActivityScenario<MainActivity> scenario,String name)throws Exception{
        try(InputStream output=new android.os.ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand("mkdir -p /sdcard/Download/"+name))){output.readAllBytes();}
        String documentId="primary:Download/"+name;
        Uri tree=DocumentsContract.buildTreeDocumentUri(AUTHORITY,documentId),initial=DocumentsContract.buildDocumentUri(AUTHORITY,documentId);
        scenario.onActivity(activity->{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,initial);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);activity.startActivityForResult(intent,43212);});
        boolean selected=false;int flags=Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        for(int attempt=0;attempt<150;attempt++){
            if(context.checkUriPermission(tree,android.os.Process.myPid(),android.os.Process.myUid(),flags)==PackageManager.PERMISSION_GRANTED){context.getContentResolver().takePersistableUriPermission(tree,flags);return tree;}
            AccessibilityNodeInfo window=automation.getRootInActiveWindow();
            if(!selected&&hasText(window,name))selected=clickText(window,"Use this folder");
            else if(selected)clickText(window,"Allow");
            Thread.sleep(200);
        }
        throw new IOException("System directory picker did not grant the isolated test folder");
    }
    @Test public void originalDescriptorIsRestrictedToManagedSystemMediaUris(){
        assertTrue(ManagedDocumentInput.needsOriginalDescriptor(Uri.parse("content://"+AUTHORITY+"/document/primary%3ADownload%2Fphoto.JPG")));
        assertTrue(ManagedDocumentInput.needsOriginalDescriptor(Uri.parse("content://"+AUTHORITY+"/document/primary%3ADownload%2Fvideo.mp4")));
        assertFalse(ManagedDocumentInput.needsOriginalDescriptor(Uri.parse("content://"+AUTHORITY+"/document/primary%3ADownload%2Fsource.txt")));
        assertFalse(ManagedDocumentInput.needsOriginalDescriptor(Uri.parse("content://another.provider/document/photo.jpg")));
        assertFalse(ManagedDocumentInput.needsOriginalDescriptor(Uri.parse("file:///tmp/photo.jpg")));
    }
    @Test @SdkSuppress(minSdkVersion=29) public void reportedJpegAndSyntheticExifRoundTripThroughActualSharedStorageAndGit()throws Exception{
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        UiAutomation automation=InstrumentationRegistry.getInstrumentation().getUiAutomation();
        File home=Files.createTempDirectory(context.getCacheDir().toPath(),"media-integrity-").toFile();DocumentFile selected=null;Uri granted=null;ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class);
        // Follow the same system directory picker and persistent URI grant as
        // the user; do not adopt broad storage or media-location permissions.
        try {
            granted=authorizeTestDirectory(context,automation,scenario,"GV-media-"+UUID.randomUUID().toString().substring(0,8));
            selected=DocumentFile.fromTreeUri(context,granted);assertNotNull(selected);assertTrue(selected.canRead());assertTrue(selected.canWrite());
            File synthetic=new File(home,"with-location.jpg");Bitmap bitmap=Bitmap.createBitmap(16,16,Bitmap.Config.ARGB_8888);
            try(OutputStream output=new FileOutputStream(synthetic)){assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG,95,output));}finally{bitmap.recycle();}
            ExifInterface exif=new ExifInterface(synthetic.getAbsolutePath());exif.setAttribute(ExifInterface.TAG_GPS_LATITUDE,"1/1,2/1,3/1");exif.setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF,"N");exif.setAttribute(ExifInterface.TAG_GPS_LONGITUDE,"4/1,5/1,6/1");exif.setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF,"E");exif.saveAttributes();
            Map<String,byte[]> bodies=new LinkedHashMap<>();bodies.put("资源/Js插件/面板按钮分页/IMG_20260824_092655.jpg",reportedPhoto());bodies.put("synthetic/with-location.JPG",Files.readAllBytes(synthetic.toPath()));
            JSArray expected=new JSArray();for(Map.Entry<String,byte[]> file:bodies.entrySet()){JSObject entry=new JSObject();entry.put("path",file.getKey());entry.put("sha",hash(file.getValue()));entry.put("mode","100644");entry.put("size",file.getValue().length);expected.put(entry);}
            ManagedFolderStore store=new ManagedFolderStore(context,selected,new File(home,"index"));String id=store.begin(selected.getUri().toString(),"[77,\"main\"]","616f16f29011673299cab0e586682c048c86ac3b","media",expected,false).getString("id");
            for(Map.Entry<String,byte[]> file:bodies.entrySet())store.write(id,file.getKey(),file.getValue().length,hash(file.getValue()),"100644",new ByteArrayInputStream(file.getValue()),null);
            int redactedReads=0;String location=store.describe(id,false,null).getString("location");
            for(Map.Entry<String,byte[]> file:bodies.entrySet()){
                DocumentFile doc=find(selected,location+"/"+file.getKey());
                try(InputStream legacy=context.getContentResolver().openInputStream(doc.getUri())){assertNotNull(legacy);if(!Arrays.equals(file.getValue(),legacy.readAllBytes()))redactedReads++;}
                try(InputStream original=store.open(id,file.getKey())){assertArrayEquals(file.getValue(),original.readAllBytes());}
            }
            store.finish(id);assertFalse(store.describe(id,true,null).getBoolean("dirty"));
            JSArray handles=new JSArray(store.describe(id,false,null).getJSONArray("files").toString());File gitDir=new File(home,"objects");
            try(Git git=Git.init().setBare(true).setDirectory(gitDir).call();GitSnapshotStore objects=new GitSnapshotStore(git.getRepository(),gitDir,new AtomicBoolean());ManagedFolderStore.ReadBatch reader=store.readBatch()){
                objects.appendDocuments(handles,reader,message->{});assertNotNull(objects.writeTree(expected));for(byte[] bytes:bodies.values())assertArrayEquals(bytes,git.getRepository().open(ObjectId.fromString(hash(bytes))).getBytes());
            }
            // Repeat reads and scans must never truncate or modify the source.
            for(Map.Entry<String,byte[]> file:bodies.entrySet())try(InputStream input=store.open(id,file.getKey())){assertArrayEquals(file.getValue(),input.readAllBytes());}
            store.attach(id,"test","616f16f29011673299cab0e586682c048c86ac3b",false);store.clear("test","616f16f29011673299cab0e586682c048c86ac3b",false);assertTrue(store.describe(id,false,null).getBoolean("missing"));
            GitObjectCacheTest.benchmark("GITVAULT_MEDIA_INTEGRITY provider="+AUTHORITY+" files=2 legacyDifferent="+redactedReads+" originalByteExact=true gitRoundTrip=true");
        }finally{try{if(selected!=null)assertTrue("Test directory must be removed",selected.delete());}finally{if(granted!=null)context.getContentResolver().releasePersistableUriPermission(granted,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);remove(home);scenario.close();}}
    }
}
