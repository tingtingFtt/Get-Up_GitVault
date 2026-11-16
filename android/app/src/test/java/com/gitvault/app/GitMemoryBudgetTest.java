package com.gitvault.app;
import org.junit.Test;
import static org.junit.Assert.*;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.storage.pack.PackConfig;
import org.eclipse.jgit.storage.file.WindowCacheConfig;
public class GitMemoryBudgetTest {
 @Test public void smallHeapsAndLargeDevicesBothUseBoundedWorkBuffers(){WindowCacheConfig small=GitMemoryBudget.window(64L*1024*1024),large=GitMemoryBudget.window(2L*1024*1024*1024);assertEquals(4L*1024*1024,small.getPackedGitLimit());assertEquals(16L*1024*1024,large.getPackedGitLimit());assertEquals(1024*1024,large.getStreamFileThreshold());assertFalse(large.isPackedGitMMAP());}
 @Test public void packingUsesOneWorkerAndRetainsIncrementalObjectReuse(){Config config=new Config();GitMemoryBudget.configure(config);PackConfig pack=new PackConfig(config);assertEquals(1,pack.getThreads());assertEquals(8L*1024*1024,pack.getDeltaSearchMemoryLimit());assertEquals(8L*1024*1024,pack.getDeltaCacheSize());assertEquals(4*1024*1024,pack.getBigFileThreshold());assertTrue(pack.isReuseDeltas());assertTrue(pack.isReuseObjects());}
}
