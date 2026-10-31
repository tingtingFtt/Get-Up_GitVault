package com.gitvault.app;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.eclipse.jgit.transport.http.HttpConnection;

public class GitNetworkTest {
    @Test public void cancellingTaskDisconnectsItsBlockedRequestWithoutWaitingForTheReadDeadline()throws Exception{
        AtomicBoolean stop=new AtomicBoolean();CountDownLatch reading=new CountDownLatch(1),disconnected=new CountDownLatch(1);
        HttpURLConnection blocked=new HttpURLConnection(new URL("https://github.com")){
            public int getResponseCode()throws IOException{reading.countDown();try{if(!disconnected.await(5,TimeUnit.SECONDS))throw new SocketTimeoutException();}catch(InterruptedException error){throw new IOException(error);}throw new SocketException("disconnected");}
            public void disconnect(){disconnected.countDown();}public boolean usingProxy(){return false;}public void connect(){}
        };
        URL url=new URL(null,"https://github.com/repo",new URLStreamHandler(){protected URLConnection openConnection(URL value){return blocked;}protected URLConnection openConnection(URL value,Proxy proxy){return blocked;}});
        ExecutorService reader=Executors.newSingleThreadExecutor();
        try(GitNetwork network=new GitNetwork(stop,message->{})){
            HttpConnection connection=network.create(url);connection.setReadTimeout(180000);connection.setConnectTimeout(180000);assertEquals(15000,blocked.getConnectTimeout());
            Future<Integer> pending=reader.submit(connection::getResponseCode);assertTrue(reading.await(2,TimeUnit.SECONDS));stop.set(true);network.disconnect();
            try{pending.get(1,TimeUnit.SECONDS);fail();}catch(ExecutionException expected){assertTrue(expected.getCause() instanceof SocketException);}
            try{network.create(url);fail();}catch(IOException expected){assertTrue(expected.getMessage().contains("取消"));}
        }finally{reader.shutdownNow();}
    }
    @Test public void progressIncludesObjectCountsAndCancellationState(){
        AtomicBoolean stop=new AtomicBoolean();List<String> messages=new ArrayList<>();
        try(GitNetwork network=new GitNetwork(stop,messages::add)){
            network.beginTask("Receiving objects",10);network.update(4);network.endTask();
            assertTrue(messages.stream().anyMatch(message->message.contains("4/10")&&message.contains("秒")&&message.contains("可取消")));
            stop.set(true);assertTrue(network.isCancelled());
        }
    }
    @Test public void completedResponsesRemainEligibleForPlatformConnectionPooling()throws Exception{
        java.util.concurrent.atomic.AtomicInteger disconnected=new java.util.concurrent.atomic.AtomicInteger();
        HttpURLConnection response=new HttpURLConnection(new URL("https://github.com")){
            public InputStream getInputStream(){return new ByteArrayInputStream(new byte[]{1,2,3});}
            public void disconnect(){disconnected.incrementAndGet();}public boolean usingProxy(){return false;}public void connect(){}
        };
        URL url=new URL(null,"https://github.com/repo",new URLStreamHandler(){protected URLConnection openConnection(URL value){return response;}protected URLConnection openConnection(URL value,Proxy proxy){return response;}});
        try(GitNetwork network=new GitNetwork(new AtomicBoolean(),message->{});InputStream input=network.create(url).getInputStream()){assertEquals(3,input.readAllBytes().length);}
        assertEquals("Closing a completed task must not force another TLS handshake",0,disconnected.get());
    }
}
