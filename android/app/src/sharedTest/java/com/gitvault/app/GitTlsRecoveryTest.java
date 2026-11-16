package com.gitvault.app;

import java.io.*;
import java.net.*;
import java.security.cert.*;
import java.util.*;
import java.util.concurrent.atomic.*;
import javax.net.ssl.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** The reported Conscrypt cause chain, exercised on both JVM and Android. */
public class GitTlsRecoveryTest {
    static IOException disconnected() {
        SSLHandshakeException handshake=new SSLHandshakeException("connection closed");
        handshake.initCause(new EOFException("connection closed"));
        return new IOException("JGit: Secure connection could not be established because of SSL problems",handshake);
    }
    @Test public void reportedHandshakeEofRecoversWithBoundedAttempts()throws Exception {
        AtomicInteger calls=new AtomicInteger();List<Integer> deadlines=new ArrayList<>();
        GitTransferRecovery recovery=new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{});
        assertEquals("ok",recovery.read("fetch",timeout->{deadlines.add(timeout);if(calls.incrementAndGet()<3)throw disconnected();return "ok";}));
        assertEquals(Arrays.asList(90,135,180),deadlines);assertEquals("GIT_TLS_NETWORK",GitTransferRecovery.failureCode(disconnected()));
        calls.set(0);try{recovery.read("fetch",timeout->{calls.incrementAndGet();throw disconnected();});fail();}
        catch(IOException expected){assertEquals(3,calls.get());}
    }
    @Test public void certificateFailuresWinOverNetworkSymptomsAnywhereInTheChain()throws Exception {
        for(Exception certificate:new Exception[]{new CertificateExpiredException(),new CertPathValidatorException("Trust anchor not found"),new CertPathBuilderException()}){
            EOFException eof=new EOFException("connection closed");eof.initCause(certificate);
            SSLHandshakeException handshake=new SSLHandshakeException("connection reset");handshake.initCause(eof);
            assertFalse(GitTransferRecovery.transientFailure(handshake));assertEquals("GIT_TLS_CERTIFICATE",GitTransferRecovery.failureCode(handshake));
            AtomicInteger calls=new AtomicInteger();
            try{new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{}).read("verify",timeout->{calls.incrementAndGet();throw handshake;});fail();}
            catch(SSLHandshakeException expected){assertEquals(1,calls.get());}
        }
        assertEquals("GIT_TLS_CERTIFICATE",GitTransferRecovery.failureCode(new SSLPeerUnverifiedException("Hostname mismatch")));
    }
    @Test public void unknownTlsProtocolAndPermissionFailuresNeverBecomeRetryable() {
        for(SSLException error:new SSLException[]{new SSLProtocolException("connection closed"),new SSLKeyException("connection reset"),new SSLHandshakeException("Received fatal alert: handshake_failure")}){
            error.initCause(new EOFException("connection closed"));
            assertFalse(GitTransferRecovery.transientFailure(error));assertEquals("GIT_TLS_ERROR",GitTransferRecovery.failureCode(error));
        }
        assertFalse(GitTransferRecovery.transientFailure(new SSLHandshakeException("unknown TLS failure")));
        IOException denied=new IOException("GitHub (403): Forbidden",disconnected());assertFalse(GitTransferRecovery.transientFailure(denied));
        assertEquals("GIT_NETWORK",GitTransferRecovery.failureCode(new SocketTimeoutException("timeout")));
    }
    @Test public void lostTlsPushResponseDoesNotSendTheCommitAgain()throws Exception {
        AtomicInteger sends=new AtomicInteger(),checks=new AtomicInteger();
        String result=new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{}).push("commit","parent",timeout->{if(checks.incrementAndGet()==1)throw disconnected();return "commit";},timeout->{sends.incrementAndGet();throw disconnected();});
        assertEquals("commit",result);assertEquals(1,sends.get());assertEquals(2,checks.get());
    }
    @Test public void tlsPushRetriesOnlyTheSameCommitAfterItsParentIsConfirmed()throws Exception {
        AtomicInteger sends=new AtomicInteger();List<String> order=new ArrayList<>();
        String result=new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{}).push("commit","parent",timeout->{order.add("head");return sends.get()<2?"parent":"commit";},timeout->{order.add("send");if(sends.incrementAndGet()==1)throw disconnected();return null;});
        assertEquals("commit",result);assertEquals(Arrays.asList("send","head","send","head"),order);
        sends.set(0);assertEquals("other",new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{}).push("commit","parent",timeout->"other",timeout->{sends.incrementAndGet();throw disconnected();}));assertEquals(1,sends.get());
    }
    @Test public void cancellationStopsTlsRecoveryBeforeAnotherRequest()throws Exception {
        AtomicBoolean stop=new AtomicBoolean();AtomicInteger sends=new AtomicInteger();
        try{new GitTransferRecovery(stop,message->{},milliseconds->stop.set(true)).read("fetch",timeout->{sends.incrementAndGet();throw disconnected();});fail();}
        catch(IOException expected){assertTrue(expected.getMessage().contains("取消"));assertEquals(1,sends.get());}
    }
}
