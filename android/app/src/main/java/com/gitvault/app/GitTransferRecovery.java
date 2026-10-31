package com.gitvault.app;

import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import javax.net.ssl.SSLException;

/** Retry within the same staged repository; never re-read or re-stage source files. */
final class GitTransferRecovery {
    interface Attempt<T> { T run(int timeoutSeconds) throws Exception; }
    interface Pause { void sleep(long milliseconds) throws InterruptedException; }
    private final AtomicBoolean stop;
    private final Consumer<String> progress;
    private final Pause pause;
    GitTransferRecovery(AtomicBoolean stop,Consumer<String> progress){this(stop,progress,Thread::sleep);}
    GitTransferRecovery(AtomicBoolean stop,Consumer<String> progress,Pause pause){this.stop=stop;this.progress=progress;this.pause=pause;}
    void check()throws IOException{if(stop.get()||Thread.currentThread().isInterrupted())throw new IOException("Git 任务已取消，本地文件保留");}
    void waitBeforeRetry(String stage,int retry)throws Exception{
        progress.accept(stage+"：连接中断，"+(1L<<retry)+" 秒后恢复（"+(retry+1)+"/2）；复用已暂存对象，可取消");
        for(long remaining=1000L<<retry;remaining>0;remaining-=100){check();pause.sleep(Math.min(100,remaining));}check();
    }
    <T>T read(String stage,Attempt<T> action)throws Exception{
        for(int attempt=0;;attempt++){
            check();progress.accept(stage+(attempt==0?"":"（恢复 "+attempt+"/2）"));
            try{T value=action.run(timeout(attempt));check();return value;}
            catch(Exception error){check();if(attempt>=2||!transientFailure(error))throw error;waitBeforeRetry(stage,attempt);}
        }
    }
    /** A lost push response is reconciled before retrying the exact same commit. */
    String push(String commit,String parent,Attempt<String> head,Attempt<Void> send)throws Exception{
        for(int attempt=0;;attempt++){
            check();Exception failure=null;
            try{send.run(timeout(attempt));}catch(Exception error){check();failure=error;}
            String actual=read("核对推送结果",head);
            if(actual.equals(commit))return actual;
            if(failure!=null&&!transientFailure(failure)&&!String.valueOf(failure.getMessage()).contains("REJECTED_NONFASTFORWARD"))throw failure;
            // Another writer moved the branch. The caller owns the explicit
            // history-preserving conflict policy; never retry a stale push.
            if(!actual.equals(parent))return actual;
            if(failure==null)throw new IOException("目标分支未确认更新，本地文件保留");
            if(attempt>=2||!transientFailure(failure))throw failure;
            waitBeforeRetry("推送同一提交",attempt);
        }
    }
    static int timeout(int attempt){return Math.min(180,90+45*attempt);}
    static boolean transientFailure(Throwable error){
        Set<Throwable> visited=Collections.newSetFromMap(new IdentityHashMap<>());
        boolean temporary=false;
        for(Throwable cause=error;cause!=null&&visited.add(cause);cause=cause.getCause()){
            // Certificate, permission, corruption and missing-object failures
            // cannot be repaired by retrying a connection.
            String text=String.valueOf(cause.getMessage()).toLowerCase(Locale.ROOT);
            if(cause instanceof SSLException||cause instanceof java.security.GeneralSecurityException||cause instanceof org.eclipse.jgit.errors.CorruptObjectException||cause instanceof org.eclipse.jgit.errors.MissingObjectException||text.matches("(?s).*(not authorized|authentication|permission denied|forbidden|not found|non.fast.forward|推送拒绝|仓库 id|取消).*")||text.matches("(?s).*\\b(401|403|404|422)\\b.*"))return false;
            if(cause instanceof SocketTimeoutException||cause instanceof SocketException||cause instanceof EOFException||cause instanceof UnknownHostException||cause instanceof InterruptedIOException||cause instanceof IOException&&text.matches("(?s).*(unexpected end of (stream|file)|premature eof|connection (reset|closed|abort)|broken pipe|timed? out|\\b(408|500|502|503|504)\\b).*") )temporary=true;
        }
        return temporary;
    }
}
