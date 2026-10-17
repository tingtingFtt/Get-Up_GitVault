import {Capacitor} from '@capacitor/core';
import {androidPlugin} from './androidPlugin';
import {appDialog} from './appDialog';
import {gitBlobSha} from './gitFiles';
import type {CachedFile} from './localCache';
export const folderBridge={
 discard:(value:any)=>androidPlugin.folderDiscard(value),export:(value:any)=>androidPlugin.folderExport(value),file:(value:any)=>androidPlugin.folderFile(value),status:(value:any)=>androidPlugin.folderStatus(value),begin:(value:any)=>androidPlugin.folderBegin(value),list:(value:any)=>androidPlugin.folderList(value),read:(value:any)=>androidPlugin.folderRead(value),put:(value:any)=>androidPlugin.folderPut(value),copy:(value:any)=>androidPlugin.folderCopy(value),finish:(value:any)=>androidPlugin.folderFinish(value),attach:(value:any)=>androidPlugin.folderAttach(value),clear:(value:any)=>androidPlugin.folderClear(value),cleanTemporary:(value:any)=>androidPlugin.folderCleanTemporary(value),archive:(value:any)=>androidPlugin.folderArchive(value),
};
export const folderRoot=()=>typeof localStorage==='undefined'?'':localStorage.getItem('gitvault_apk_download_dir')||'';
export const hasFolderApi=()=>Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('GitVaultNative');
export const usesNativeFolder=()=>hasFolderApi()&&folderRoot().startsWith('content://');
export type FolderFiles=CachedFile[]&{nativeSnapshot?:{version:string;dirty:boolean;location?:string}};
export async function withFolderConfirmation<T>(run:(force:boolean)=>Promise<T>,message:string):Promise<T>{
 try{return await run(false);}catch(error){if((error as {code?:string}).code!=='LOCAL_CHANGES')throw error;if(!await appDialog.confirm(`${message}\n${(error as Error).message}\n确认后继续；取消会保留现有文件。`))throw new DOMException('目录操作已取消','AbortError');return run(true);}
}
export async function beginFolder(key:string,ref:string,label:string,files:Array<{path:string;sha:string;mode:string;size?:number}>){
 return withFolderConfirmation(force=>folderBridge.begin({root:folderRoot(),key,ref,label,files,allowChanged:force}),'指定目录中检测到本地变动，是否允许拉取远端版本？');
}
const CHUNK=384*1024;
function encode(bytes:Uint8Array){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
export async function putFolderFile(version:string,file:CachedFile,signal?:AbortSignal):Promise<CachedFile>{
 const bytes=!file.nativeRef?(file.isBase64?Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0)):new TextEncoder().encode(file.content)):undefined;
 const sha=file.sha||await gitBlobSha(bytes!);const size=file.size??bytes?.length;if(size===undefined)throw new Error('目录文件缺少大小');
 if(file.nativeRef){await folderBridge.copy({version,nativeRef:file.nativeRef,path:file.path,sha,mode:file.mode||'100644',size});}
 else if(file.isBase64){const text=file.content.replace(/\s/g,''),step=CHUNK/3*4;let offset=0;for(let at=0;at<text.length||at===0;at+=step){signal?.throwIfAborted();const data=text.slice(at,at+step);await folderBridge.put({version,path:file.path,sha,mode:file.mode||'100644',offset,data,done:at+step>=text.length});offset+=data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);}}
 else{const bytes=new TextEncoder().encode(file.content);for(let offset=0;offset<bytes.length||offset===0;offset+=CHUNK){signal?.throwIfAborted();await folderBridge.put({version,path:file.path,sha,mode:file.mode||'100644',offset,data:encode(bytes.subarray(offset,offset+CHUNK)),done:offset+CHUNK>=bytes.length});}}
 return {...file,sha,size,content:'',isBase64:true,nativeRef:{version,path:file.path}};
}
export async function folderFiles(version:string,scan=true):Promise<FolderFiles>{
 const state=await folderBridge.list({version,scan});const files=(state.files||[]) as FolderFiles;if(!state.missing)files.nativeSnapshot={version,dirty:!!state.dirty,location:state.location};return files;
}
export async function hydrateFile(file:CachedFile,maxBytes=Number.POSITIVE_INFINITY):Promise<CachedFile>{
 if(!file.nativeRef)return file;if((file.size||0)>maxBytes)throw new Error('文件超过预览范围，请从项目主存储目录打开或使用文件下载');
 const parts:string[]=[];let offset=0;
 for(;;){const chunk=await folderBridge.read({...file.nativeRef,offset});if(!Number.isSafeInteger(chunk.bytes)||chunk.bytes<0||chunk.bytes>CHUNK)throw new Error('目录读取结果无效');parts.push(chunk.data);offset+=chunk.bytes;if(offset>maxBytes)throw new Error('文件超过预览范围');if(chunk.done)break;if(offset>maxBytes)throw new Error('文件超过预览范围');}
 const content=parts.join('');const bytes=Uint8Array.from(atob(content),c=>c.charCodeAt(0));
 if(file.sha&&await gitBlobSha(bytes)!==file.sha)throw new Error('目录文件在读取期间变化，请刷新后重试：'+file.path);
 try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(!text.includes('\0'))return {...file,content:text,isBase64:false};}catch{}
 return {...file,content,isBase64:true};
}
export const hasLocalFolderChanges=(files:CachedFile[])=>!!(files as FolderFiles).nativeSnapshot?.dirty||files.some(file=>file.nativeRef?.dirty);
export async function confirmFolderUpload(files:CachedFile[]){if(hasLocalFolderChanges(files)&&!await appDialog.confirm('指定目录文件已被修改。本次将上传目录中当前实际文件（包括新增和删除），并保留目标提交历史。是否继续？'))throw new DOMException('目录上传已取消','AbortError');}
export async function saveFolderArchive(files:CachedFile[],name:string){const {id}=await folderBridge.archive({files:files.map(({path,sha,size,mode,nativeRef,content,isBase64})=>({path,sha,size,mode,nativeRef,...(!nativeRef?{content,isBase64}:{})})),name});await androidPlugin.finishDownload({id});}
