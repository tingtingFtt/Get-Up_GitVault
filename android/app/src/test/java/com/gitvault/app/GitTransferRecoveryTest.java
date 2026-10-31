package com.gitvault.app;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.atomic.*;
import javax.net.ssl.SSLHandshakeException;

public class GitTransferRecoveryTest {
    private GitTransferRecovery recovery(AtomicBoolean stop){return new GitTransferRecovery(stop,message->{},milliseconds->{});}
    @Test public void readsReconnectWithLongerIdleDeadlinesAndBoundedAttempts()throws Exception{
        List<Integer> timeouts=new ArrayList<>();GitTransferRecovery recovery=recovery(new AtomicBoolean());
        assertEquals("ready",recovery.read("fetch",timeout->{timeouts.add(timeout);if(timeouts.size()<3)throw new EOFException("unexpected end of stream");return "ready";}));
        assertEquals(Arrays.asList(90,135,180),timeouts);timeouts.clear();
        try{recovery.read("fetch",timeout->{timeouts.add(timeout);throw new SocketTimeoutException("timeout");});fail();}catch(SocketTimeoutException expected){assertEquals(3,timeouts.size());}
    }
    @Test public void permissionValidationAndCertificateErrorsAreNotRetried()throws Exception{
        for(Exception error:new Exception[]{new IOException("GitHub (403): Forbidden"),new IOException("Git 推送拒绝：REJECTED_NONFASTFORWARD"),new SSLHandshakeException("certificate rejected"),new IOException("仓库 ID 已变化"),new IOException("文件哈希不一致")}){
            AtomicInteger calls=new AtomicInteger();try{recovery(new AtomicBoolean()).read("read",timeout->{calls.incrementAndGet();throw error;});fail();}catch(Exception expected){assertSame(error,expected);assertEquals(1,calls.get());}
        }
        assertTrue(GitTransferRecovery.transientFailure(new IOException("wrapped",new EOFException())));
        assertFalse(GitTransferRecovery.transientFailure(new SSLHandshakeException("connection reset")));
    }
    @Test public void lostSuccessfulPushDoesNotPublishAgain()throws Exception{
        AtomicInteger sends=new AtomicInteger();
        assertEquals("commit",recovery(new AtomicBoolean()).push("commit","parent",timeout->"commit",timeout->{sends.incrementAndGet();throw new EOFException();}));
        assertEquals(1,sends.get());
    }
    @Test public void failedPushRetriesOnlyAfterRecheckingTheSameParent()throws Exception{
        List<String> events=new ArrayList<>();AtomicInteger sends=new AtomicInteger();
        String result=recovery(new AtomicBoolean()).push("commit","parent",timeout->{events.add("head");return sends.get()<2?"parent":"commit";},timeout->{events.add("send");if(sends.incrementAndGet()==1)throw new EOFException();return null;});
        assertEquals("commit",result);assertEquals(Arrays.asList("send","head","send","head"),events);
    }
    @Test public void anotherWriterOrUnknownResultNeverReplaysAStalePush()throws Exception{
        AtomicInteger sends=new AtomicInteger();GitTransferRecovery recovery=recovery(new AtomicBoolean());
        assertEquals("other",recovery.push("commit","parent",timeout->"other",timeout->{sends.incrementAndGet();throw new EOFException();}));assertEquals(1,sends.get());
        sends.set(0);try{recovery.push("commit","parent",timeout->{throw new SocketTimeoutException();},timeout->{sends.incrementAndGet();throw new EOFException();});fail();}catch(SocketTimeoutException expected){assertEquals(1,sends.get());}
    }
    @Test public void forbiddenPushIsNotRetriedEvenWhenAnotherWriterMovedTheHead()throws Exception{
        AtomicInteger sends=new AtomicInteger();
        try{recovery(new AtomicBoolean()).push("commit","parent",timeout->"other",timeout->{sends.incrementAndGet();throw new IOException("GitHub (403): Forbidden");});fail();}
        catch(IOException expected){assertTrue(expected.getMessage().contains("403"));assertEquals(1,sends.get());}
    }
    @Test public void cancellationInterruptsRetryWaitWithoutAnotherRequest()throws Exception{
        AtomicBoolean stop=new AtomicBoolean();AtomicInteger sends=new AtomicInteger();
        GitTransferRecovery recovery=new GitTransferRecovery(stop,message->{},milliseconds->stop.set(true));
        try{recovery.read("fetch",timeout->{sends.incrementAndGet();throw new EOFException();});fail();}catch(IOException expected){assertTrue(expected.getMessage().contains("取消"));assertEquals(1,sends.get());}
    }
}
