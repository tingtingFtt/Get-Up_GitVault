package com.gitvault.app;

import com.gitvault.compat.BorrowedInflaterInputStream;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.*;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.transport.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Run unchanged on the JVM AND Android, whose InflaterInputStream.close differs. */
public class JgitInflaterRegressionTest {
    private byte[] compressed(byte[] bytes) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (DeflaterOutputStream stream = new DeflaterOutputStream(output)) { stream.write(bytes); }
        return output.toByteArray();
    }
    @Test public void borrowedInflaterRemainsUsableAndInputClosesExactlyOnce() throws Exception {
        Inflater inflater = new Inflater(); int[] closes = {0};
        InputStream input = new ByteArrayInputStream(compressed(new byte[]{1,2,3})) {
            @Override public void close() { closes[0]++; }
        };
        BorrowedInflaterInputStream stream = new BorrowedInflaterInputStream(input, inflater);
        assertArrayEquals(new byte[]{1,2,3}, stream.readAllBytes()); stream.close(); stream.close();
        try { stream.read(); fail("Closed stream must reject further reads"); } catch (IOException expected) {}
        assertEquals(1, closes[0]); inflater.reset(); inflater.end();
    }
    @Test public void defaultInflaterIsOwnedButReadFailureDoesNotCloseBorrowedInflater() throws Exception {
        class Owned extends BorrowedInflaterInputStream {
            Owned(InputStream input) { super(input); }
            Inflater inflater() { return inf; }
        }
        Owned owned = new Owned(new ByteArrayInputStream(compressed(new byte[]{4})));
        owned.close();
        try { owned.inflater().reset(); fail("Owned inflater leaked"); } catch (IllegalStateException | NullPointerException expected) {}
        Inflater borrowed = new Inflater();
        try (InputStream stream = new BorrowedInflaterInputStream(new ByteArrayInputStream(new byte[]{0,0,0}), borrowed)) {
            try { stream.readAllBytes(); fail("Corrupt zlib input accepted"); } catch (IOException expected) {}
        }
        borrowed.reset(); borrowed.end();
    }
    @Test public void actualJgitLooseStreamsUseTheCompatibilitySuperclass() throws Exception {
        assertTrue(BorrowedInflaterInputStream.class.isAssignableFrom(
                Class.forName("org.eclipse.jgit.internal.storage.file.UnpackedObject$1")));
    }
    @Test public void batchThenStandaloneUpdatesAndUploadsKeepWorkingInTheSameProcess() throws Exception {
        GitMemoryBudget.install(); File root = Files.createTempDirectory("gitvault-inflater-").toFile();
        byte[] bytes = new byte[1024*1024+257]; new Random(42).nextBytes(bytes);
        try (Git source = Git.init().setBare(true).setDirectory(new File(root,"source")).call();
             Git remote = Git.init().setBare(true).setDirectory(new File(root,"target")).call()) {
            ObjectId upstream = commit(source, null, bytes, "upstream");
            source.push().setRemote(new File(root,"target").toURI().toString())
                    .setRefSpecs(new RefSpec(upstream.name()+":refs/heads/main"), new RefSpec(upstream.name()+":refs/heads/dev")).call();
            ObjectId originalMain = upstream, target = upstream;
            // Closing a loose large-object stream used to return then end a pooled inflater on Android.
            verifyObject(source, upstream, bytes, false);
            // Three batch items followed by standalone update and standalone upload.
            for (int round=0; round<5; round++) {
                bytes[bytes.length-1] = (byte)round;
                upstream = commit(source, upstream, bytes, "update-"+round);
                try (Git work = Git.init().setBare(true).setDirectory(new File(root,"task-"+round)).call()) {
                    GitMemoryBudget.configure(work.getRepository().getConfig());
                    work.fetch().setRemote(new File(root,"source").toURI().toString())
                            .setRefSpecs(new RefSpec(upstream.name()+":refs/gitvault/source")).call();
                    // Real packed objects, early prefix close, full read and repeated close.
                    verifyObject(work, upstream, bytes, true);
                    work.fetch().setRemote(new File(root,"target").toURI().toString())
                            .setRefSpecs(new RefSpec("refs/heads/dev:refs/gitvault/target")).call();
                    ObjectId next = commit(work, target, bytes, "sync-"+round);
                    work.push().setRemote(new File(root,"target").toURI().toString())
                            .setRefSpecs(new RefSpec(next.name()+":refs/heads/dev")).call();
                    try (RevWalk walk = new RevWalk(remote.getRepository())) {
                        assertEquals(target, walk.parseCommit(next).getParent(0));
                    }
                    assertEquals(originalMain, remote.getRepository().exactRef("refs/heads/main").getObjectId());
                    assertEquals(next, remote.getRepository().exactRef("refs/heads/dev").getObjectId()); target=next;
                }
            }
        } finally { remove(root); }
    }
    @Test public void cancelledOrTruncatedFetchCannotPoisonTheNextTransfer() throws Exception {
        GitMemoryBudget.install(); File root = Files.createTempDirectory("gitvault-inflater-retry-").toFile();
        byte[] bytes = new byte[1024*1024+31]; new Random(43).nextBytes(bytes);
        try (Git source = Git.init().setBare(true).setDirectory(new File(root,"source")).call()) {
            ObjectId ref = commit(source, null, bytes, "fixture");
            try (Git cancelled = Git.init().setBare(true).setDirectory(new File(root,"cancelled")).call()) {
                AtomicBoolean stop = new AtomicBoolean();
                ProgressMonitor monitor = new ProgressMonitor() {
                    public void start(int tasks) {} public void beginTask(String name,int total) {}
                    public void update(int count) { if(count>0) stop.set(true); } public void endTask() {}
                    public boolean isCancelled() { return stop.get(); } public void showDuration(boolean enabled) {}
                };
                try { cancelled.fetch().setRemote(new File(root,"source").toURI().toString())
                        .setRefSpecs(new RefSpec(ref.name()+":refs/gitvault/source")).setProgressMonitor(monitor).call();
                    fail("Cancelled fetch must stop"); } catch (org.eclipse.jgit.api.errors.GitAPIException expected) { assertTrue(stop.get()); }
            }
            try (Git broken = Git.init().setBare(true).setDirectory(new File(root,"broken")).call();
                 ObjectInserter insert = broken.getRepository().newObjectInserter()) {
                byte[] incomplete = {'P','A','C','K',0,0,0,2,0,0,0,1};
                try { insert.newPackParser(new ByteArrayInputStream(incomplete)).parse(NullProgressMonitor.INSTANCE); fail("Truncated pack accepted"); }
                catch (IOException expected) {}
            }
            for (int round=0; round<2; round++) {
                try (Git work = Git.init().setBare(true).setDirectory(new File(root,"retry-"+round)).call()) {
                    new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{}).read("retry", timeout -> {
                        return work.fetch().setRemote(new File(root,"source").toURI().toString())
                                .setRefSpecs(new RefSpec(ref.name()+":refs/gitvault/source")).call();
                    });
                    verifyObject(work, ref, bytes, true);
                }
            }
        } finally { remove(root); }
    }
    private static ObjectId commit(Git git, ObjectId parent, byte[] bytes, String message) throws Exception {
        try (ObjectInserter insert = git.getRepository().newObjectInserter()) {
            TreeFormatter tree = new TreeFormatter(); tree.append("large.bin",FileMode.REGULAR_FILE,insert.insert(Constants.OBJ_BLOB,bytes));
            CommitBuilder commit = new CommitBuilder(); PersonIdent author = new PersonIdent("GitVault","gitvault@example.invalid");
            commit.setAuthor(author); commit.setCommitter(author); commit.setTreeId(insert.insert(tree));
            if(parent!=null) commit.setParentId(parent); commit.setMessage(message); ObjectId ref = insert.insert(commit); insert.flush();
            RefUpdate update = git.getRepository().updateRef("refs/heads/main"); update.setNewObjectId(ref); update.forceUpdate(); return ref;
        }
    }
    private static void verifyObject(Git git, ObjectId ref, byte[] expected, boolean packed) throws Exception {
        try (RevWalk walk = new RevWalk(git.getRepository()); org.eclipse.jgit.treewalk.TreeWalk tree =
                org.eclipse.jgit.treewalk.TreeWalk.forPath(git.getRepository(),"large.bin",walk.parseCommit(ref).getTree())) {
            ObjectLoader loader = git.getRepository().open(tree.getObjectId(0));
            assertTrue("Exercise large-object streaming path",loader.isLarge());
            if(packed) assertTrue("Fetch must exercise a real packed object",loader.getClass().getName().contains("LargePacked"));
            InputStream prefix = loader.openStream(); assertEquals(expected[0]&255,prefix.read()); prefix.close(); prefix.close();
            try (InputStream input = loader.openStream()) { assertArrayEquals(expected,input.readAllBytes()); }
        }
    }
    private static void remove(File file) { File[] children=file.listFiles(); if(children!=null)for(File child:children)remove(child); file.delete(); }
}
