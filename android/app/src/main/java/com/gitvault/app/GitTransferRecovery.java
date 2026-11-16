package com.gitvault.app;

import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import javax.net.ssl.*;

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
    private enum Failure {
        OTHER("GIT_TRANSFER",false),NETWORK("GIT_NETWORK",true),TLS_NETWORK("GIT_TLS_NETWORK",true),
        TLS_CERTIFICATE("GIT_TLS_CERTIFICATE",false),TLS_ERROR("GIT_TLS_ERROR",false);
        final String code;final boolean retryable;
        Failure(String code,boolean retryable){this.code=code;this.retryable=retryable;}
    }
    static boolean transientFailure(Throwable error){return classify(error).retryable;}
    static String failureCode(Throwable error){return classify(error).code;}
    static String failureMessage(Throwable error){
        Failure kind=classify(error);String message=error.getMessage()==null?"原生 Git 传输失败":error.getMessage();
        if(kind==Failure.TLS_NETWORK)return "TLS 连接中断或超时；"+message;
        if(kind==Failure.TLS_CERTIFICATE)return "TLS 证书或身份校验失败；"+message;
        if(kind==Failure.TLS_ERROR)return "TLS 安全连接失败；"+message;
        return message;
    }
    private static Failure classify(Throwable error){
        Set<Throwable> visited=Collections.newSetFromMap(new IdentityHashMap<>());
        boolean temporary=false,tls=false,certificate=false,permanent=false,unsupportedTls=false;
        for(Throwable cause=error;cause!=null&&visited.add(cause);cause=cause.getCause()){
            String text=String.valueOf(cause.getMessage()).toLowerCase(Locale.ROOT);
            if(cause instanceof SSLException){
                tls=true;
                certificate|=cause instanceof SSLPeerUnverifiedException||text.matches("(?s).*(certificate|certpath|certification path|trust anchor|pkix|hostname|host name|subject alternative|peer not authenticated|unknown_ca|unknown ca).*");
                // Only handshake/base SSL wrappers with positive network evidence
                // are retryable. Protocol/key failures must remain fail-closed.
                unsupportedTls|=!(cause instanceof SSLHandshakeException)&&cause.getClass()!=SSLException.class;
                unsupportedTls|=text.matches("(?s).*(fatal alert|handshake_failure|protocol_version|no (appropriate protocol|cipher)|cipher suites in common|bad record|record.*(decrypt|overflow)|wrong version|unsupported protocol).*");
            }
            certificate|=cause instanceof java.security.cert.CertificateException||cause instanceof java.security.cert.CertPathValidatorException||cause instanceof java.security.cert.CertPathBuilderException;
            permanent|=cause instanceof java.security.GeneralSecurityException||cause instanceof org.eclipse.jgit.errors.CorruptObjectException||cause instanceof org.eclipse.jgit.errors.MissingObjectException||text.matches("(?s).*(not authorized|authentication|permission denied|forbidden|not found|non.fast.forward|推送拒绝|仓库 id|取消).*")||text.matches("(?s).*\\b(401|403|404|422)\\b.*");
            if(cause instanceof SocketTimeoutException||cause instanceof SocketException||cause instanceof EOFException||cause instanceof UnknownHostException||cause instanceof InterruptedIOException||cause instanceof IOException&&text.matches("(?s).*(unexpected end of (stream|file)|premature eof|connection (reset|closed|abort)|broken pipe|timed? out|\\b(408|500|502|503|504)\\b).*") )temporary=true;
        }
        // Inspect the complete cause chain before allowing a retry: an EOF/socket
        // wrapper must never hide a certificate or permission failure deeper down.
        if(tls&&certificate)return Failure.TLS_CERTIFICATE;
        if(permanent)return tls?Failure.TLS_ERROR:Failure.OTHER;
        if(tls)return temporary&&!unsupportedTls?Failure.TLS_NETWORK:Failure.TLS_ERROR;
        return temporary?Failure.NETWORK:Failure.OTHER;
    }
}
