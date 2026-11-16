package com.gitvault.app;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.storage.file.WindowCacheConfig;
/** Runtime work buffers, independent of the optional on-disk Git cache budget. */
final class GitMemoryBudget {
 static final int MIB=1024*1024;
 private static boolean installed;
 static WindowCacheConfig window(long heap){WindowCacheConfig config=new WindowCacheConfig();config.setPackedGitLimit(Math.max(2L*MIB,Math.min(16L*MIB,heap/16)));config.setPackedGitWindowSize(MIB);config.setPackedGitOpenFiles(16);config.setPackedGitMMAP(false);config.setDeltaBaseCacheLimit(2*MIB);config.setStreamFileThreshold(MIB);return config;}
 static synchronized void install(){if(installed)return;window(Runtime.getRuntime().maxMemory()).install();installed=true;}
 static void configure(Config config){config.setInt("pack",null,"threads",1);config.setLong("pack",null,"windowMemory",8L*MIB);config.setLong("pack",null,"deltaCacheSize",8L*MIB);config.setInt("core",null,"bigFileThreshold",4*MIB);}
}
