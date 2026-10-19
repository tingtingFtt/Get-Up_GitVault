import {Capacitor} from '@capacitor/core';
import {androidPlugin} from './androidPlugin';
import {appDialog} from './appDialog';
import {gitBlobSha} from './gitFiles';
import {reportProgress, cooperate} from './operation';
import {rememberVerifiedFile} from './verifiedFiles';
import {appendOperationLog} from './operationLog';
import type {CachedFile} from './localCache';
export const folderBridge={
 cancel:(value:any)=>androidPlugin.folderCancel(value),
 listen:(listener:(event:{taskId:string;message:string})=>void)=>(androidPlugin.addListener as any)('folderProgress',listener),
 discard:(value:any)=>androidPlugin.folderDiscard(value),export:(value:any)=>androidPlugin.folderExport(value),file:(value:any)=>androidPlugin.folderFile(value),status:(value:any)=>androidPlugin.folderStatus(value),begin:(value:any)=>androidPlugin.folderBegin(value),list:(value:any)=>androidPlugin.folderList(value),read:(value:any)=>androidPlugin.folderRead(value),put:(value:any)=>androidPlugin.folderPut(value),copy:(value:any)=>androidPlugin.folderCopy(value),finish:(value:any)=>androidPlugin.folderFinish(value),attach:(value:any)=>androidPlugin.folderAttach(value),clear:(value:any)=>androidPlugin.folderClear(value),cleanTemporary:(value:any)=>androidPlugin.folderCleanTemporary(value),archive:(value:any)=>androidPlugin.folderArchive(value),
};
/** Await native acknowledgement before releasing the UI lock. Cancellation is
 * delivered outside the single-threaded I/O queue, including during a scan. */
export async function folderTask<T=any>(run:(options:any)=>Promise<T>,options:any,signal?:AbortSignal,progress=false):Promise<T>{
 signal?.throwIfAborted();if(!signal)return run(options);
 const taskId=crypto.randomUUID();let listener:any;
 if(progress)try{listener=await folderBridge.listen(event=>{if(event.taskId===taskId&&!signal.aborted)reportProgress(event.message);});}catch{}
 const abort=()=>{void folderBridge.cancel({taskId}).catch(()=>{});};
 try{
  signal.throwIfAborted();
  const pending=run({...options,taskId});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  try{const result=await pending;signal.throwIfAborted();return result;}catch(error){signal.throwIfAborted();throw error;}
 }finally{signal.removeEventListener('abort',abort);await listener?.remove().catch(()=>{});}
}
export const folderRoot=()=>typeof localStorage==='undefined'?'':localStorage.getItem('gitvault_apk_download_dir')||'';
export const hasFolderApi=()=>Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('GitVaultNative');
export const usesNativeFolder=()=>hasFolderApi()&&folderRoot().startsWith('content://');
export type FolderFiles=CachedFile[]&{nativeSnapshot?:{version:string;dirty:boolean;location?:string}};
export async function withFolderConfirmation<T>(run:(force:boolean)=>Promise<T>,message:string,signal?:AbortSignal):Promise<T>{
 try{return await run(false);}catch(error){if((error as {code?:string}).code!=='LOCAL_CHANGES')throw error;if(!await appDialog.confirm(`${message}\n${(error as Error).message}\n确认后继续；取消会保留现有文件。`,{signal}))throw new DOMException('目录操作已取消','AbortError');return run(true);}
}
export async function beginFolder(key:string,ref:string,label:string,files:Array<{path:string;sha:string;mode:string;size?:number}>,signal?:AbortSignal,previousVersion?:string){
 const state=await withFolderConfirmation(force=>folderTask(folderBridge.begin,{root:folderRoot(),key,ref,label,files,allowChanged:force,previousVersion},signal,true),'指定目录中检测到本地变动，是否允许拉取远端版本？',signal);
 if(state.pathMappings&&Object.keys(state.pathMappings).length){
  const message='检测到大小写或 Unicode 名称冲突，已使用兼容目录名保存；上传及 ZIP 导出保留原始路径。\n'+Object.entries(state.pathMappings).map(([path,name])=>`${path} → ${name}`).join('\n');
  try{appendOperationLog({action:'目录兼容',status:'success',project:label,stage:'规划本地文件名',message});}catch{}
  window.dispatchEvent(new CustomEvent('gitvault-progress',{detail:'检测到名称冲突，正在使用兼容目录保存，仓库原始名称保留…'}));
 }
 return state;
}
export function noteFolderRepair(version:string,count:number){if(!count)return;try{appendOperationLog({action:'目录修复',status:'success',project:version,stage:'补齐缺失或损坏文件',message:`已修复 ${count} 个文件，完整目录校验通过；原快照和额外文件保留。`});}catch{}}
/** Only an unbound download candidate may request one bounded repair pass. */
export async function finishFolder(version:string,repair?:(paths:string[])=>Promise<void>,signal?:AbortSignal){
 signal?.throwIfAborted();
 try{return await folderTask(folderBridge.finish,{version},signal,true);}catch(error){
  const problem=error as {code?:string;data?:{version?:string;repairPaths?:unknown}};
  if(problem.code!=='FOLDER_REPAIR'||!repair||problem.data?.version!==version||!Array.isArray(problem.data.repairPaths)||!problem.data.repairPaths.length||!problem.data.repairPaths.every(path=>typeof path==='string'))throw error;
  const paths=[...new Set(problem.data.repairPaths as string[])];signal?.throwIfAborted();
  window.dispatchEvent(new CustomEvent('gitvault-progress',{detail:`正在补拉 ${paths.length} 个缺失／损坏文件，已验证的其他文件保留…`}));
  await repair(paths);signal?.throwIfAborted();const result=await folderTask(folderBridge.finish,{version},signal,true);signal?.throwIfAborted();noteFolderRepair(version,paths.length);return result;
 }
}
const CHUNK=384*1024;
function encode(bytes:Uint8Array){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
export async function putFolderFile(version:string,file:CachedFile,signal?:AbortSignal):Promise<CachedFile>{
 const bytes=!file.nativeRef?(file.isBase64?Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0)):new TextEncoder().encode(file.content)):undefined;
 const sha=file.sha||await gitBlobSha(bytes!);const size=file.size??bytes?.length;if(size===undefined)throw new Error('目录文件缺少大小');
 await cooperate(signal);
 if(file.nativeRef){await folderTask(folderBridge.copy,{version,nativeRef:file.nativeRef,path:file.path,sha,mode:file.mode||'100644',size},signal);}
 else if(file.isBase64){const text=file.content.replace(/\s/g,''),step=CHUNK/3*4;let offset=0;for(let at=0;at<text.length||at===0;at+=step){signal?.throwIfAborted();const data=text.slice(at,at+step);await folderTask(folderBridge.put,{version,path:file.path,sha,mode:file.mode||'100644',offset,data,done:at+step>=text.length},signal);offset+=data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);}}
 else{const bytes=new TextEncoder().encode(file.content);for(let offset=0;offset<bytes.length||offset===0;offset+=CHUNK){signal?.throwIfAborted();await folderTask(folderBridge.put,{version,path:file.path,sha,mode:file.mode||'100644',offset,data:encode(bytes.subarray(offset,offset+CHUNK)),done:offset+CHUNK>=bytes.length},signal);}}
 return {...file,sha,size,content:'',isBase64:true,nativeRef:{version,path:file.path}};
}
export async function folderFiles(version:string,scan=true,signal?:AbortSignal):Promise<FolderFiles>{
 const state=await folderTask(folderBridge.list,{version,scan},signal,scan);const files=(state.files||[]) as FolderFiles;if(!state.missing)files.nativeSnapshot={version,dirty:!!state.dirty,location:state.location};return files;
}
export async function hydrateFile(file:CachedFile,maxBytes=Number.POSITIVE_INFINITY,signal?:AbortSignal):Promise<CachedFile>{
 if(!file.nativeRef)return file;if((file.size||0)>maxBytes)throw new Error('文件超过预览范围，请从项目主存储目录打开或使用文件下载');
 const parts:string[]=[];let offset=0;
 for(;;){await cooperate(signal);const chunk=await folderTask(folderBridge.read,{...file.nativeRef,offset},signal);if(!Number.isSafeInteger(chunk.bytes)||chunk.bytes<0||chunk.bytes>CHUNK)throw new Error('目录读取结果无效');parts.push(chunk.data);offset+=chunk.bytes;if(offset>maxBytes)throw new Error('文件超过预览范围');if(chunk.done)break;if(offset>maxBytes)throw new Error('文件超过预览范围');}
 const {nativeRef:_nativeRef,...body}=file;const content=parts.join('');const bytes=Uint8Array.from(atob(content),c=>c.charCodeAt(0));
 if(file.sha&&await gitBlobSha(bytes)!==file.sha)throw new Error('目录文件在读取期间变化，请刷新后重试：'+file.path);
 try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(!text.includes('\0'))return rememberVerifiedFile({...body,content:text,isBase64:false},file.sha||await gitBlobSha(bytes),bytes.length);}catch{}
 return rememberVerifiedFile({...body,content,isBase64:true},file.sha||await gitBlobSha(bytes),bytes.length);
}
export const hasLocalFolderChanges=(files:CachedFile[])=>!!(files as FolderFiles).nativeSnapshot?.dirty||files.some(file=>file.nativeRef?.dirty);
export async function confirmFolderUpload(files:CachedFile[],signal?:AbortSignal){if(hasLocalFolderChanges(files)&&!await appDialog.confirm('指定目录文件已被修改。本次将上传目录中当前实际文件（包括新增和删除），并保留目标提交历史。是否继续？',{signal}))throw new DOMException('目录上传已取消','AbortError');}
export async function saveFolderArchive(files:CachedFile[],name:string,signal?:AbortSignal){const {id}=await folderTask(folderBridge.archive,{files:files.map(({path,sha,size,mode,nativeRef,content,isBase64})=>({path,sha,size,mode,nativeRef,...(!nativeRef?{content,isBase64}:{})})),name},signal,true);signal?.throwIfAborted();await androidPlugin.finishDownload({id});}
