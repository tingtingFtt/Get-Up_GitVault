package com.gitvault.app;

import java.io.*;
import java.net.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import javax.net.ssl.*;
import org.eclipse.jgit.lib.ProgressMonitor;
import org.eclipse.jgit.transport.*;
import org.eclipse.jgit.transport.http.*;

/** Per-task HTTP connections: cancellation never changes JGit's global factory. */
final class GitNetwork implements HttpConnectionFactory,ProgressMonitor,AutoCloseable {
    private final AtomicBoolean stop;
    private final Set<HttpURLConnection> connections=ConcurrentHashMap.newKeySet();
    private final Consumer<String> report;
    private String title="正在连接 GitHub";
    private long completed,total,started=System.nanoTime(),lastReport;
    private final ScheduledExecutorService heartbeat=Executors.newSingleThreadScheduledExecutor();
    private boolean closed;
    GitNetwork(AtomicBoolean stop,Consumer<String> report){
        this.stop=stop;this.report=report;
        heartbeat.scheduleAtFixedRate(()->{synchronized(this){if(!closed&&!stop.get())publish();}},2,2,TimeUnit.SECONDS);
    }
    void configure(Transport transport){if(transport instanceof TransportHttp)((TransportHttp)transport).setHttpConnectionFactory(this);}
    HttpURLConnection track(HttpURLConnection connection)throws IOException{
        check();connections.add(connection);
        if(stop.get()){connections.remove(connection);connection.disconnect();check();}return connection;
    }
    void forget(HttpURLConnection connection){connections.remove(connection);connection.disconnect();}
    void disconnect(){for(HttpURLConnection connection:connections)connection.disconnect();connections.clear();}
    private void check()throws IOException{if(stop.get()||Thread.currentThread().isInterrupted())throw new IOException("Git 任务已取消，本地文件保留");}
    public HttpConnection create(URL url)throws IOException{return create(url,Proxy.NO_PROXY);}
    public HttpConnection create(URL url,Proxy proxy)throws IOException{return new Connection(track((HttpURLConnection)url.openConnection(proxy==null?Proxy.NO_PROXY:proxy)));}
    public void start(int tasks){}
    public synchronized void beginTask(String name,int work){title=name;total=work;completed=0;started=System.nanoTime();publish();}
    public synchronized void update(int count){completed+=count;if(System.nanoTime()-lastReport>=200000000L)publish();}
    public synchronized void endTask(){publish();}
    public boolean isCancelled(){return stop.get();}
    public void showDuration(boolean enabled){}
    private void publish(){
        if(closed)return;lastReport=System.nanoTime();long seconds=TimeUnit.NANOSECONDS.toSeconds(lastReport-started);
        report.accept(title+(total>0?" "+completed+"/"+total:completed>0?" · 已处理 "+completed:"")+" · "+seconds+" 秒（可取消）");
    }
    @Override public void close(){synchronized(this){closed=true;}heartbeat.shutdownNow();disconnect();}

    /** The platform HTTPS trust store and hostname validation remain enabled. */
    private final class Connection implements HttpConnection {
        private final HttpURLConnection http;
        Connection(HttpURLConnection http){this.http=http;}
        public int getResponseCode()throws IOException{check();return http.getResponseCode();}
        public URL getURL(){return http.getURL();}
        public String getResponseMessage()throws IOException{check();return http.getResponseMessage();}
        public Map<String,List<String>> getHeaderFields(){return http.getHeaderFields();}
        public void setRequestProperty(String key,String value){http.setRequestProperty(key,value);}
        public void setRequestMethod(String method)throws ProtocolException{http.setRequestMethod(method);}
        public void setUseCaches(boolean use){http.setUseCaches(use);}
        public void setConnectTimeout(int timeout){http.setConnectTimeout(Math.min(timeout,15000));}
        public void setReadTimeout(int timeout){http.setReadTimeout(timeout);}
        public String getContentType(){return http.getContentType();}
        public InputStream getInputStream()throws IOException{check();return new FilterInputStream(http.getInputStream()){
            @Override public int read()throws IOException{check();return super.read();}
            @Override public int read(byte[] bytes,int offset,int length)throws IOException{check();return in.read(bytes,offset,length);}
            @Override public void close()throws IOException{try{super.close();}finally{forget(http);}}
        };}
        public String getHeaderField(String name){return http.getHeaderField(name);}
        public List<String> getHeaderFields(String name){List<String> result=new ArrayList<>();for(Map.Entry<String,List<String>> entry:http.getHeaderFields().entrySet())if(name.equalsIgnoreCase(entry.getKey())&&entry.getValue()!=null)result.addAll(entry.getValue());return result;}
        public int getContentLength(){return http.getContentLength();}
        public void setInstanceFollowRedirects(boolean follow){http.setInstanceFollowRedirects(follow);}
        public void setDoOutput(boolean output){http.setDoOutput(output);}
        public void setFixedLengthStreamingMode(int length){http.setFixedLengthStreamingMode(length);}
        public OutputStream getOutputStream()throws IOException{check();return new FilterOutputStream(http.getOutputStream()){
            @Override public void write(byte[] bytes,int offset,int length)throws IOException{check();out.write(bytes,offset,length);}
            @Override public void write(int value)throws IOException{check();out.write(value);}
        };}
        public void setChunkedStreamingMode(int length){http.setChunkedStreamingMode(length);}
        public String getRequestMethod(){return http.getRequestMethod();}
        public boolean usingProxy(){return http.usingProxy();}
        public void connect()throws IOException{check();http.connect();}
        public void configure(KeyManager[] keys,TrustManager[] trust,SecureRandom random)throws NoSuchAlgorithmException,KeyManagementException{
            SSLContext context=SSLContext.getInstance("TLS");context.init(keys,trust,random);((HttpsURLConnection)http).setSSLSocketFactory(context.getSocketFactory());
        }
        public void setHostnameVerifier(HostnameVerifier verifier){((HttpsURLConnection)http).setHostnameVerifier(verifier);}
    }
}
