package com.gitvault.compat;

import java.io.*;
import java.util.zip.*;

/**
 * Desktop-Java ownership semantics for JGit only. Android ends even an externally
 * supplied inflater in InflaterInputStream.close(); JGit's cursor/cache owns it.
 * Never skip closing the input or change the behaviour of platform ZIP/HTTP streams.
 */
public class BorrowedInflaterInputStream extends InflaterInputStream {
    private final boolean ownsInflater;
    private boolean streamClosed;

    public BorrowedInflaterInputStream(InputStream input, Inflater inflater, int size) {
        super(input, inflater, size); ownsInflater = false;
    }
    public BorrowedInflaterInputStream(InputStream input, Inflater inflater) {
        this(input, inflater, 512);
    }
    public BorrowedInflaterInputStream(InputStream input) {
        super(input); ownsInflater = true;
    }
    private void checkOpen() throws IOException {
        if (streamClosed) throw new IOException("Stream closed");
    }
    @Override public int read() throws IOException { checkOpen(); return super.read(); }
    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
        checkOpen(); return super.read(bytes, offset, length);
    }
    @Override public long skip(long length) throws IOException { checkOpen(); return super.skip(length); }
    @Override public int available() throws IOException { checkOpen(); return super.available(); }
    @Override protected void fill() throws IOException { checkOpen(); super.fill(); }
    @Override public void close() throws IOException {
        if (streamClosed) return;
        streamClosed = true;
        try { if (ownsInflater) inf.end(); }
        finally { in.close(); }
        // Do not call super.close(): Android would end the borrowed inflater.
        // Its JGit owner releases it after the underlying input has closed.
    }
}
