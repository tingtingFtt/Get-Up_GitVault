import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { CachedFile } from './localCache';
export interface NativeGitFile { path: string; sha: string; mode: string; size?: number; encoding: 'base64'; content: string }
export interface NativeFetchOptions { onFile?: (file: NativeGitFile) => Promise<void>; paths?: string[] }
interface NativeGit {
 transfer(options: Record<string, unknown>): Promise<any>;
 prepareUpload(options: Record<string, unknown>): Promise<void>;
 appendChunk(options: Record<string, unknown>): Promise<void>;
 readChunk(options: Record<string, unknown>): Promise<{offset:number;bytes:number;done:boolean;content:string}>;
 release(options: {id:string}): Promise<void>;
 cancel(options: {id:string}): Promise<void>;
 addListener(name:'progress',listener:(event:{id:string;message:string})=>void):Promise<PluginListenerHandle>;
}
const plugin=registerPlugin<NativeGit>('GitVaultGit');
export const nativeGitBridge: NativeGit={
 transfer:options=>plugin.transfer(options),prepareUpload:options=>plugin.prepareUpload(options),
 appendChunk:options=>plugin.appendChunk(options),readChunk:options=>plugin.readChunk(options),release:options=>plugin.release(options),
 cancel:options=>plugin.cancel(options),addListener:(name,listener)=>plugin.addListener(name,listener)
};
export const hasNativeGit=()=>Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('GitVaultGit');
export const NATIVE_CHUNK_BYTES=384*1024;
const encodedChunkSize=NATIVE_CHUNK_BYTES/3*4;
const base64Size=(text:string)=>text.length/4*3-(text.endsWith('==')?2:text.endsWith('=')?1:0);
function encode(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
const report=(message:string)=>window.dispatchEvent(new CustomEvent('gitvault-progress',{detail:message}));
export async function nativeGitTransfer(action:'fetch'|'push',payload:{owner:string;repo:string;expectedRepoId:number;ref?:string;branch?:string;files?:CachedFile[];message?:string;rebaseOnConflict?:boolean;totalBytes?:number},token:string,signal:AbortSignal,options:NativeFetchOptions={}){
 if(!hasNativeGit())throw new Error('当前安装包不含原生 Git，请更新 APK 或选择 REST');
 signal.throwIfAborted();const id=crypto.randomUUID();
 let rejectAbort!: (reason: unknown)=>void;
 const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
 const abort=()=>{void nativeGitBridge.cancel({id}).catch(()=>{});rejectAbort(signal.reason);};
 const listener=await nativeGitBridge.addListener('progress',event=>{if(event.id===id||!event.id)report(event.message);});
 signal.addEventListener('abort',abort,{once:true});
 const work=async()=>{
  signal.throwIfAborted();
  const {files:sourceFiles,...identity}=payload;
  if(action==='push'){
   const files=sourceFiles||[];let completed=0;
   const totalBytes=files.reduce((sum,file)=>sum+(file.size??(file.isBase64?base64Size(file.content.replace(/\s/g,'')):new TextEncoder().encode(file.content).length)),0);
   await nativeGitBridge.prepareUpload({id,totalBytes});signal.throwIfAborted();
   for(const file of files){
    const metadata={id,path:file.path,sha:file.sha,mode:file.mode||'100644'};
    if(file.isBase64){
     const text=file.content.replace(/\s/g,'');let offset=0;
     for(let at=0;at<text.length||at===0;at+=encodedChunkSize){
      signal.throwIfAborted();const content=text.slice(at,at+encodedChunkSize);
      await nativeGitBridge.appendChunk({...metadata,offset,content,done:at+encodedChunkSize>=text.length});offset+=base64Size(content);
     }
    }else{
     const bytes=new TextEncoder().encode(file.content);
     for(let offset=0;offset<bytes.length||offset===0;offset+=NATIVE_CHUNK_BYTES){
      signal.throwIfAborted();await nativeGitBridge.appendChunk({...metadata,offset,content:encode(bytes.subarray(offset,offset+NATIVE_CHUNK_BYTES)),done:offset+NATIVE_CHUNK_BYTES>=bytes.length});
     }
    }
    report(`原生 Git：已分块暂存 ${++completed}/${files.length}：${file.path}`);
   }
   signal.throwIfAborted();return nativeGitBridge.transfer({...identity,action,id,token,files:files.map(file=>({path:file.path,sha:file.sha,mode:file.mode||'100644'}))});
  }
  const result=await nativeGitBridge.transfer({...identity,action,id,token});signal.throwIfAborted();
  if(!result.chunked||!Array.isArray(result.files))throw new Error('原生 Git 分块协议不匹配，请更新 APK');
  const wanted=options.paths?new Set(options.paths):undefined,received:NativeGitFile[]=[];
  let completed=0;
  for(const file of result.files as NativeGitFile[]){
   if(wanted&&!wanted.has(file.path))continue;
   if(!Number.isSafeInteger(file.size)||file.size!<0)throw new Error('原生 Git 文件大小无效');
   const chunks:string[]=[];let offset=0;
   do{
    signal.throwIfAborted();const chunk=await nativeGitBridge.readChunk({id,path:file.path,offset});
    if(chunk.offset!==offset||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<0||chunk.bytes>NATIVE_CHUNK_BYTES||base64Size(chunk.content)!==chunk.bytes||offset+chunk.bytes>file.size!||chunk.done!==(offset+chunk.bytes===file.size!)||(!chunk.done&&(chunk.bytes===0||chunk.bytes%3!==0)))throw new Error('原生 Git 文件分块校验失败');
    chunks.push(chunk.content);offset+=chunk.bytes;
   }while(offset<file.size!);
   const value={...file,content:chunks.join('')};
   if(options.onFile)await options.onFile(value);else received.push(value);
   report(`原生 Git：已校验 ${++completed}/${wanted?.size??result.files.length}：${file.path}`);
  }
  return options.onFile?{...result,streamed:true}:{...result,files:received};
 };
 try {const result=await Promise.race([work(),aborted]);signal.throwIfAborted();return result;}
 finally {signal.removeEventListener('abort',abort);void nativeGitBridge.release({id}).catch(()=>{});await listener.remove().catch(()=>{});}
}
