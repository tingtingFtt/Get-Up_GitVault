package com.gitvault.app;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.UUID;

/** Optional, bounded, app-private Git acceleration. Active repositories are
 * moved out of the idle pool, so pruning never removes an active object's pack.
 * All access is on GitVaultGit's worker. No credentials or working trees live here. */
final class GitObjectCache {
    static final long LIMIT=512L*1024*1024, MAX_AGE=7L*24*60*60*1000;
    private final File parent, pool;
    private final long limit;
    static final class Lease {
        final File folder;final long repositoryId;final boolean retain,reused;
        Lease(File folder,long repositoryId,boolean retain,boolean reused){this.folder=folder;this.repositoryId=repositoryId;this.retain=retain;this.reused=reused;}
    }
    GitObjectCache(File parent){this(parent,LIMIT);}
    GitObjectCache(File parent,long limit){this.parent=parent;this.pool=new File(parent,"gitvault-objects-v1");this.limit=limit;}
    Lease acquire(long repositoryId,boolean retain)throws IOException {
        if(repositoryId<=0)throw new IOException("Git 缓存仓库身份无效");
        if(retain)prune();File folder=new File(parent,"gitvault-session-"+UUID.randomUUID());
        File saved=new File(pool,"repo-"+repositoryId);
        boolean reused=retain&&saved.isDirectory()&&saved.renameTo(folder);
        if(!folder.isDirectory()&&!folder.mkdirs())throw new IOException("无法创建 Git 临时目录");
        return new Lease(folder,repositoryId,retain,reused);
    }
    void release(Lease lease)throws IOException {
        if(!lease.retain){remove(lease.folder);return;}
        if(!pool.isDirectory()&&!pool.mkdirs()){remove(lease.folder);return;}
        File saved=new File(pool,"repo-"+lease.repositoryId);
        // Two paused sessions can refer to the same repository. Either complete
        // object set is safe; retain the most recently finished session.
        remove(saved);
        if(!lease.folder.renameTo(saved)){remove(lease.folder);return;}
        saved.setLastModified(System.currentTimeMillis());prune();
    }
    long bytes(){return size(pool);}
    void clear()throws IOException {remove(pool);}
    private void prune()throws IOException {
        File[] entries=pool.listFiles();if(entries==null)return;
        Arrays.sort(entries,Comparator.comparingLong(File::lastModified));
        long total=size(pool),now=System.currentTimeMillis();
        for(File entry:entries)if(total>limit||now-entry.lastModified()>MAX_AGE){long count=size(entry);remove(entry);total=Math.max(0,total-count);}
    }
    private static long size(File file){if(!file.exists())return 0;if(file.isFile())return file.length();long total=0;File[] children=file.listFiles();if(children!=null)for(File child:children){long count=size(child);if(Long.MAX_VALUE-total<count)return Long.MAX_VALUE;total+=count;}return total;}
    private static void remove(File file)throws IOException {if(!file.exists())return;File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);if(!file.delete()&&file.exists())throw new IOException("Git 加速缓存未完全清理，请重试");}
}
