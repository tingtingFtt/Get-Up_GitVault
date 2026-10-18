package com.gitvault.app;

import android.net.Uri;
import androidx.documentfile.provider.DocumentFile;

/** Android filesystem-backed provider double with case-folded sibling lookup. */
final class FoldingDocumentFile extends DocumentFile {
    private final DocumentFile delegate;
    private final boolean zeroSize;
    FoldingDocumentFile(DocumentFile delegate){this(delegate,false);}
    FoldingDocumentFile(DocumentFile delegate,boolean zeroSize){super(null);this.delegate=delegate;this.zeroSize=zeroSize;}
    private DocumentFile wrap(DocumentFile value){return value==null?null:new FoldingDocumentFile(value,zeroSize);}
    private DocumentFile existing(String name){for(DocumentFile child:delegate.listFiles())if(FolderPathLayout.folded(name).equals(FolderPathLayout.folded(child.getName())))return child;return null;}
    @Override public DocumentFile createFile(String mime,String name){DocumentFile old=existing(name);return wrap(old==null?delegate.createFile(mime,name):old);}
    @Override public DocumentFile createDirectory(String name){DocumentFile old=existing(name);return wrap(old==null?delegate.createDirectory(name):old);}
    @Override public Uri getUri(){return delegate.getUri();}
    @Override public String getName(){return delegate.getName();}
    @Override public String getType(){return delegate.getType();}
    @Override public boolean isDirectory(){return delegate.isDirectory();}
    @Override public boolean isFile(){return delegate.isFile();}
    @Override public boolean isVirtual(){return delegate.isVirtual();}
    @Override public long lastModified(){return delegate.lastModified();}
    @Override public long length(){return zeroSize&&delegate.isFile()?0:delegate.length();}
    @Override public boolean canRead(){return delegate.canRead();}
    @Override public boolean canWrite(){return delegate.canWrite();}
    @Override public boolean delete(){return delegate.delete();}
    @Override public boolean exists(){return delegate.exists();}
    @Override public DocumentFile[] listFiles(){DocumentFile[] children=delegate.listFiles();for(int i=0;i<children.length;i++)children[i]=wrap(children[i]);return children;}
    @Override public boolean renameTo(String name){DocumentFile old=existing(name);return (old==null||old.getUri().equals(delegate.getUri()))&&delegate.renameTo(name);}
}
