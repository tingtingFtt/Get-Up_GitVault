package com.gitvault.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.*;
import java.net.*;
import java.util.concurrent.atomic.*;
import org.eclipse.jgit.transport.http.HttpConnection;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class GitTlsRecoveryIntegrationTest {
    @Test public void realAndroidHandshakeEofRetriesTwiceThenReleasesConnections()throws Exception {
        AtomicInteger accepted=new AtomicInteger(),attempts=new AtomicInteger();AtomicBoolean peerStop=new AtomicBoolean();AtomicReference<Throwable> serverError=new AtomicReference<>();
        try(ServerSocket server=new ServerSocket(0,4,InetAddress.getByName("127.0.0.1"));
            GitNetwork network=new GitNetwork(new AtomicBoolean(),message->{})) {
            server.setSoTimeout(1000);
            Thread peer=new Thread(()->{
                try{
                    // Android may perform its own TLS fallback inside one HTTP
                    // request; bound our three recovery attempts independently.
                    while(!peerStop.get()&&accepted.get()<12)try(Socket socket=server.accept()){
                        accepted.incrementAndGet();socket.setSoTimeout(5000);DataInputStream input=new DataInputStream(socket.getInputStream());
                        // Consume ClientHello, then close before sending ServerHello.
                        // This produces the real Conscrypt SSLHandshakeException -> EOF chain.
                        byte[] header=new byte[5];input.readFully(header);int size=((header[3]&255)<<8)|(header[4]&255);assertTrue(size>0&&size<=65535);input.readFully(new byte[size]);
                        socket.shutdownOutput();socket.setSoTimeout(200);
                        try{while(input.read()!=-1){}}catch(SocketTimeoutException|SocketException ignored){}
                    }catch(SocketTimeoutException ignored){}
                }catch(Throwable error){if(!peerStop.get())serverError.set(error);}
            },"gitvault-tls-eof-fixture");peer.setDaemon(true);peer.start();
            try{
                new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{}).read("TLS fixture",timeout->{
                    attempts.incrementAndGet();network.disconnect();HttpConnection connection=network.create(new URL("https://127.0.0.1:"+server.getLocalPort()+"/"));connection.setConnectTimeout(5000);connection.setReadTimeout(5000);return connection.getResponseCode();
                });fail("Handshake EOF must never be accepted as a successful request");
            }catch(IOException expected){assertEquals("GIT_TLS_NETWORK",GitTransferRecovery.failureCode(expected));}
            finally{network.disconnect();peerStop.set(true);server.close();peer.join(6000);}
            assertFalse("TLS peer did not stop",peer.isAlive());assertNull(serverError.get());assertTrue(accepted.get()>=3);assertEquals(3,attempts.get());
            // The failed task must not poison a subsequent verified GitHub HTTPS connection.
            int status=new GitTransferRecovery(new AtomicBoolean(),message->{},milliseconds->{}).read("verified GitHub",timeout->{
                network.disconnect();HttpConnection connection=network.create(new URL("https://github.com/tingtingFtt/Get-Up_GitVault.git/info/refs?service=git-upload-pack"));connection.setConnectTimeout(15000);connection.setReadTimeout(timeout*1000);int code=connection.getResponseCode();try(InputStream input=connection.getInputStream()){input.read();}return code;
            });assertEquals(200,status);
        }
    }
}
