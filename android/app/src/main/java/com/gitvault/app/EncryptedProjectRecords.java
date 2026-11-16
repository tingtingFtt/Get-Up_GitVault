package com.gitvault.app;

import android.content.*;
import android.database.Cursor;
import android.database.sqlite.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** App-private encrypted rows with one atomic order/revision/record transaction. */
final class EncryptedProjectRecords extends SQLiteOpenHelper {
    private final javax.crypto.SecretKey key;
    EncryptedProjectRecords(Context context,javax.crypto.SecretKey key){this(context,key,"gitvault-records-v1.db");}
    EncryptedProjectRecords(Context context,javax.crypto.SecretKey key,String name){super(context,name,null,1);this.key=key;setWriteAheadLoggingEnabled(true);}
    @Override public void onCreate(SQLiteDatabase db){db.execSQL("CREATE TABLE records (id TEXT PRIMARY KEY, data BLOB NOT NULL)");db.execSQL("CREATE TABLE state (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");db.execSQL("CREATE TABLE backups (id TEXT PRIMARY KEY, data BLOB NOT NULL)");db.execSQL("CREATE TABLE staged (id TEXT PRIMARY KEY, data BLOB NOT NULL)");db.execSQL("CREATE TABLE migration (id INTEGER PRIMARY KEY, lease TEXT NOT NULL)");}
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){throw new IllegalStateException("Unsupported record version");}
    private byte[] encrypt(String value,String label)throws Exception{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key);cipher.updateAAD(label.getBytes(StandardCharsets.UTF_8));byte[] iv=cipher.getIV(),body=cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));byte[] result=new byte[iv.length+body.length];System.arraycopy(iv,0,result,0,iv.length);System.arraycopy(body,0,result,iv.length,body.length);return result;}
    private String decrypt(byte[] value,String label)throws Exception{if(value.length<28)throw new java.io.IOException("项目密文无效");Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Arrays.copyOf(value,12)));cipher.updateAAD(label.getBytes(StandardCharsets.UTF_8));return new String(cipher.doFinal(value,12,value.length-12),StandardCharsets.UTF_8);}
    private static String hash(String value)throws Exception{byte[] bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder text=new StringBuilder(64);for(byte b:bytes)text.append(String.format(Locale.ROOT,"%02x",b&255));return text.toString();}
    private byte[] encrypted(SQLiteDatabase db,String table,String id)throws Exception{
        long length;try(Cursor size=db.rawQuery("SELECT length(data) FROM "+table+" WHERE id=?",new String[]{id})){if(!size.moveToFirst())return null;length=size.getLong(0);}
        if(length<28||length>Integer.MAX_VALUE)throw new java.io.IOException("项目密文大小无效");byte[] value=new byte[(int)length];int offset=0;
        // A complete metadata row can exceed Android's CursorWindow capacity.
        // Keep each SQL result bounded; authenticate the complete ciphertext after reading.
        while(offset<value.length){int count=Math.min(256*1024,value.length-offset);try(Cursor chunk=db.rawQuery("SELECT substr(data,?,?) FROM "+table+" WHERE id=?",new String[]{String.valueOf(offset+1),String.valueOf(count),id})){if(!chunk.moveToFirst())throw new java.io.IOException("项目密文读取中断");byte[] part=chunk.getBlob(0);if(part.length!=count)throw new java.io.IOException("项目密文读取长度变化");System.arraycopy(part,0,value,offset,count);offset+=count;}}
        return value;
    }
    private JSONObject index(SQLiteDatabase db)throws Exception{byte[] row=encrypted(db,"state","1");return row!=null?new JSONObject(decrypt(row,"state")):new JSONObject().put("revision",0).put("order",new JSONArray());}
    synchronized JSONObject index()throws Exception{SQLiteDatabase db=getReadableDatabase();db.beginTransactionNonExclusive();try{JSONObject state=index(db);db.setTransactionSuccessful();return state;}finally{db.endTransaction();}}
    synchronized JSONObject read(long expected,int offset)throws Exception{
        SQLiteDatabase db=getReadableDatabase();db.beginTransactionNonExclusive();
        try{JSONObject state=index(db);JSONArray order=state.getJSONArray("order"),rows=new JSONArray();if(state.getLong("revision")!=expected||offset<0||offset>order.length())throw new java.io.IOException("项目记录已变化，请重新打开");int bytes=0,next=offset;
            while(next<order.length()&&rows.length()<32&&(bytes<512*1024||rows.length()==0)){
                String id=order.getString(next);byte[] encrypted=encrypted(db,"records",hash(id));if(encrypted==null)throw new java.io.IOException("项目记录缺失，原数据未清除");String json=decrypt(encrypted,hash(id));rows.put(new JSONObject().put("id",id).put("json",json));bytes+=json.length()*2;next++;
            }db.setTransactionSuccessful();return new JSONObject().put("revision",expected).put("rows",rows).put("next",next);
        }finally{db.endTransaction();}
    }
    synchronized JSONObject beginMigration()throws Exception{
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{if(index(db).getLong("revision")!=0)throw new java.io.IOException("项目迁移已完成，请重新读取");String id=UUID.randomUUID().toString();db.delete("staged",null,null);ContentValues row=new ContentValues();row.put("id",1);row.put("lease",id);db.insertWithOnConflict("migration",null,row,SQLiteDatabase.CONFLICT_REPLACE);db.setTransactionSuccessful();return new JSONObject().put("id",id);}finally{db.endTransaction();}
    }
    private void migrationLease(SQLiteDatabase db,String id)throws Exception{try(Cursor row=db.rawQuery("SELECT lease FROM migration WHERE id=1",null)){if(index(db).getLong("revision")!=0||!row.moveToFirst()||!id.equals(row.getString(0)))throw new java.io.IOException("迁移任务已改变，原记录保留，请重新打开");}}
    synchronized void stageMigration(String lease,JSONArray rows)throws Exception{
        if(rows.length()>32)throw new java.io.IOException("迁移批次过大");SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{migrationLease(db,lease);for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String id=row.getString("id"),json=row.getString("json");if(id.isEmpty()||!id.equals(new JSONObject(json).getString("id")))throw new java.io.IOException("迁移项目身份无效");ContentValues value=new ContentValues();value.put("id",hash(id));value.put("data",encrypt(json,hash(id)));db.insertOrThrow("staged",null,value);}db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    synchronized JSONObject finishMigration(String lease,JSONArray order)throws Exception{
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{migrationLease(db,lease);Set<String> ids=new HashSet<>();for(int i=0;i<order.length();i++){String id=order.getString(i);if(id.isEmpty()||!ids.add(id))throw new java.io.IOException("迁移项目索引重复");try(Cursor row=db.rawQuery("SELECT 1 FROM staged WHERE id=?",new String[]{hash(id)})){if(!row.moveToFirst())throw new java.io.IOException("迁移项目缺失，原记录保留");}}
            try(Cursor count=db.rawQuery("SELECT COUNT(*) FROM staged",null)){count.moveToFirst();if(count.getLong(0)!=ids.size())throw new java.io.IOException("迁移记录数不匹配");}
            db.delete("records",null,null);db.execSQL("INSERT INTO records (id,data) SELECT id,data FROM staged");ContentValues value=new ContentValues();value.put("id",1);value.put("data",encrypt(new JSONObject().put("revision",1).put("order",order).toString(),"state"));db.insertOrThrow("state",null,value);db.delete("staged",null,null);db.delete("migration",null,null);db.setTransactionSuccessful();return new JSONObject().put("revision",1);
        }finally{db.endTransaction();}
    }
    synchronized void archive(String value)throws Exception{SQLiteDatabase db=getWritableDatabase();String id=hash(value);try(Cursor found=db.rawQuery("SELECT 1 FROM backups WHERE id=?",new String[]{id})){if(found.moveToFirst())return;}ContentValues row=new ContentValues();row.put("id",id);row.put("data",encrypt(value,id));db.insertOrThrow("backups",null,row);}
    synchronized JSONObject commit(long expected,JSONArray order,JSONArray rows,JSONArray removed)throws Exception{
        if(expected<0||expected>=9007199254740991L)throw new java.io.IOException("项目记录版本无效");Set<String> names=new HashSet<>();for(int i=0;i<order.length();i++)if(order.getString(i).isEmpty()||!names.add(order.getString(i)))throw new java.io.IOException("项目 ID 重复或缺失");
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try{
            if(index(db).getLong("revision")!=expected)throw new java.io.IOException("其他页面已修改项目记录，未覆盖较新版本");
            Set<String> changed=new HashSet<>();for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String id=row.getString("id"),json=row.getString("json");if(!names.contains(id)||!changed.add(id)||!id.equals(new JSONObject(json).getString("id")))throw new java.io.IOException("项目身份无效");ContentValues value=new ContentValues();value.put("id",hash(id));value.put("data",encrypt(json,hash(id)));db.insertWithOnConflict("records",null,value,SQLiteDatabase.CONFLICT_REPLACE);}
            for(int i=0;i<removed.length();i++){String id=removed.getString(i);if(names.contains(id))throw new java.io.IOException("删除范围与项目索引冲突");db.delete("records","id=?",new String[]{hash(id)});}
            for(String id:names)try(Cursor row=db.rawQuery("SELECT 1 FROM records WHERE id=?",new String[]{hash(id)})){if(!row.moveToFirst())throw new java.io.IOException("项目索引不完整");}
            try(Cursor count=db.rawQuery("SELECT COUNT(*) FROM records",null)){count.moveToFirst();if(count.getLong(0)!=names.size())throw new java.io.IOException("项目索引存在额外记录");}
            ContentValues value=new ContentValues();value.put("id",1);value.put("data",encrypt(new JSONObject().put("revision",expected+1).put("order",order).toString(),"state"));db.insertWithOnConflict("state",null,value,SQLiteDatabase.CONFLICT_REPLACE);db.setTransactionSuccessful();return new JSONObject().put("revision",expected+1);
        }finally{db.endTransaction();}
    }
}
