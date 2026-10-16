import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { CachedFile } from './localCache';
interface NativeGit {
 transfer(options: Record<string, unknown>): Promise<any>;
 cancel(options: {id:string}): Promise<void>;
 addListener(name:'progress',listener:(event:{id:string;message:string})=>void):Promise<PluginListenerHandle>;
}
const plugin=registerPlugin<NativeGit>('GitVaultGit');
export const nativeGitBridge: NativeGit={transfer:options=>plugin.transfer(options),cancel:options=>plugin.cancel(options),addListener:(name,listener)=>plugin.addListener(name,listener)};
export const hasNativeGit=()=>Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('GitVaultGit');
export async function nativeGitTransfer(action:'fetch'|'push',payload:{owner:string;repo:string;expectedRepoId:number;ref?:string;branch?:string;files?:CachedFile[];message?:string;rebaseOnConflict?:boolean},token:string,signal:AbortSignal){
 if(!hasNativeGit())throw new Error('当前安装包不含原生 Git，请更新 APK 或选择 REST');
 signal.throwIfAborted();const id=crypto.randomUUID();
 let rejectAbort!: (reason: unknown)=>void;
 const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
 const abort=()=>{void nativeGitBridge.cancel({id}).catch(()=>{});rejectAbort(signal.reason);};
 const listener=await nativeGitBridge.addListener('progress',event=>{if(event.id===id||!event.id)window.dispatchEvent(new CustomEvent('gitvault-progress',{detail:event.message}));});
 signal.addEventListener('abort',abort,{once:true});
 try {signal.throwIfAborted();const result=await Promise.race([nativeGitBridge.transfer({...payload,action,id,token}),aborted]);signal.throwIfAborted();return result;}
 finally {signal.removeEventListener('abort',abort);await listener.remove().catch(()=>{});}
}
