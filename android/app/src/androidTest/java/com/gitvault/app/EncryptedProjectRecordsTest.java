package com.gitvault.app;
import android.content.Context;
import android.database.Cursor;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.*;
import org.junit.runner.RunWith;
import org.json.*;
import javax.crypto.*;
import java.util.*;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class EncryptedProjectRecordsTest {
 private Context context;private String name;private EncryptedProjectRecords store;
 @Before public void setup()throws Exception{context=ApplicationProvider.getApplicationContext();name="record-test-"+UUID.randomUUID()+".db";KeyGenerator generator=KeyGenerator.getInstance("AES");generator.init(256);store=new EncryptedProjectRecords(context,generator.generateKey(),name);}
 @After public void cleanup(){store.close();context.deleteDatabase(name);}
 private JSONObject row(String id,String remark)throws Exception{return new JSONObject().put("id",id).put("json",new JSONObject().put("id",id).put("remark",remark).put("uploadTarget",new JSONObject().put("id",77).put("branch","dev").put("token","ghp_hiddenToken123")).put("backups",new JSONArray().put(new JSONObject().put("commitSha","history"))).toString());}
 @Test public void onlyChangedRowsAreEncryptedAgainAndLargeRowsReadInBoundedPages()throws Exception{
  char[] text=new char[1024*1024];Arrays.fill(text,'x');String large=new String(text);JSONArray order=new JSONArray().put("a").put("b").put("c");
  store.commit(0,order,new JSONArray().put(row("a",large)).put(row("b","old")).put(row("c","old")),new JSONArray());
  java.util.Map<String,byte[]> before=new java.util.HashMap<>();try(Cursor cursor=store.getReadableDatabase().rawQuery("SELECT id,data FROM records",null)){while(cursor.moveToNext()){byte[] data=cursor.getBlob(1);before.put(cursor.getString(0),data);assertFalse(new String(data,java.nio.charset.StandardCharsets.UTF_8).contains("hiddenToken123"));}}
  JSONObject first=store.read(1,0);assertEquals(1,first.getInt("next"));assertEquals(1,first.getJSONArray("rows").length());assertEquals(large,new JSONObject(first.getJSONArray("rows").getJSONObject(0).getString("json")).getString("remark"));
  store.commit(1,order,new JSONArray().put(row("b","edited")),new JSONArray());assertEquals(2,store.index().getLong("revision"));int changed=0;try(Cursor cursor=store.getReadableDatabase().rawQuery("SELECT id,data FROM records",null)){while(cursor.moveToNext())if(!java.util.Arrays.equals(before.get(cursor.getString(0)),cursor.getBlob(1)))changed++;}assertEquals("Unchanged encrypted rows must not be rewritten",1,changed);
  assertEquals("dev",new JSONObject(store.read(2,1).getJSONArray("rows").getJSONObject(0).getString("json")).getJSONObject("uploadTarget").getString("branch"));
  store.close();
 }
 @Test public void staleRevisionAndIncompleteIndexRollBackWithoutDeletingOldHistory()throws Exception{
  store.commit(0,new JSONArray().put("a"),new JSONArray().put(row("a","original")),new JSONArray());
  try{store.commit(0,new JSONArray(),new JSONArray(),new JSONArray().put("a"));fail("stale write accepted");}catch(java.io.IOException expected){}
  try{store.commit(1,new JSONArray().put("a").put("missing"),new JSONArray().put(row("a","wrong")),new JSONArray());fail("incomplete index accepted");}catch(java.io.IOException expected){}
  assertEquals(1,store.index().getLong("revision"));assertEquals("original",new JSONObject(store.read(1,0).getJSONArray("rows").getJSONObject(0).getString("json")).getString("remark"));
 }
 @Test public void corruptedEncryptedRowsFailAuthenticationInsteadOfReturningEmptyRecords()throws Exception{
  store.commit(0,new JSONArray().put("a"),new JSONArray().put(row("a","original")),new JSONArray());store.getWritableDatabase().execSQL("UPDATE records SET data=zeroblob(32)");
  try{store.read(1,0);fail("corrupt ciphertext accepted");}catch(Exception expected){assertEquals(1,store.index().getLong("revision"));}
 }
 @Test public void interruptedMigrationDoesNotPublishPartialRowsAndACompetingLeaseCannotFinish()throws Exception{
  String first=store.beginMigration().getString("id");store.stageMigration(first,new JSONArray().put(row("a","old")));assertEquals(0,store.index().getLong("revision"));assertEquals(0,store.read(0,0).getJSONArray("rows").length());
  String second=store.beginMigration().getString("id");store.stageMigration(second,new JSONArray().put(row("b","new")));
  try{store.finishMigration(first,new JSONArray().put("a"));fail("stale migration accepted");}catch(java.io.IOException expected){}
  store.finishMigration(second,new JSONArray().put("b"));assertEquals(1,store.index().getLong("revision"));assertEquals("b",store.read(1,0).getJSONArray("rows").getJSONObject(0).getString("id"));
 }
 @Test public void identicalMigrationBackupIsArchivedOnlyOnceAndNeverInPlaintext()throws Exception{
  store.archive("sensitive-old-backup");store.archive("sensitive-old-backup");try(Cursor row=store.getReadableDatabase().rawQuery("SELECT data FROM backups",null)){assertTrue(row.moveToFirst());assertFalse(new String(row.getBlob(0),java.nio.charset.StandardCharsets.UTF_8).contains("sensitive-old-backup"));assertFalse(row.moveToNext());}
 }
}
