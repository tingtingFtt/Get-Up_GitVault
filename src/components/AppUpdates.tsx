import React,{useEffect,useState} from 'react';
import {registerPlugin} from '@capacitor/core';
import {isNativeAndroid} from '../utils/nativePlatform';
interface Update {packageId:string;versionCode:number;versionName:string;url:string;sha256:string;size:number}
interface Status {state:'idle'|'downloading'|'waiting'|'ready'|'error';downloaded?:number;total?:number;message?:string;canInstall?:boolean}
interface Check {available:boolean;currentVersion:string;currentCode:number;message?:string;update?:Update}
interface Updater {check():Promise<Check>;download(options:{update:Update}):Promise<Status>;getStatus():Promise<Status>;cancel():Promise<void>;install():Promise<{permissionRequired:boolean}>}
const plugin=registerPlugin<Updater>('GitVaultUpdater');
export const updaterBridge: Updater={check:()=>plugin.check(),download:options=>plugin.download(options),getStatus:()=>plugin.getStatus(),cancel:()=>plugin.cancel(),install:()=>plugin.install()};
export const openAppUpdater=()=>window.dispatchEvent(new CustomEvent('gitvault-open-updater'));
export default function AppUpdates(){
 const [open,setOpen]=useState(false),[checking,setChecking]=useState(false),[info,setInfo]=useState<Check>(),[status,setStatus]=useState<Status>({state:'idle'}),[error,setError]=useState('');
 const [automatic,setAutomatic]=useState(()=>localStorage.getItem('gitvault_auto_update_check')!=='false');
 const [downloadAuto,setDownloadAuto]=useState(()=>localStorage.getItem('gitvault_auto_update_download')==='true');
 const native=isNativeAndroid();
 const check=async(quiet=false)=>{setChecking(true);if(!quiet)setError('');try{const value=await updaterBridge.check();setInfo(value);if(value.available&&value.update&&localStorage.getItem('gitvault_auto_update_download')==='true')setStatus(await updaterBridge.download({update:value.update}));}catch(e){if(!quiet)setError((e as Error).message);}finally{setChecking(false);}};
 useEffect(()=>{if(!native)return;const show=()=>setOpen(true);window.addEventListener('gitvault-open-updater',show);if(automatic)void check(true);void updaterBridge.getStatus().then(setStatus).catch(()=>{});return()=>window.removeEventListener('gitvault-open-updater',show);},[]);
 useEffect(()=>{if(!native||!['downloading','waiting'].includes(status.state))return;let active=true;const timer=setInterval(()=>{void updaterBridge.getStatus().then(value=>{if(active)setStatus(value);}).catch(e=>{if(active)setError(e.message);});},1500);return()=>{active=false;clearInterval(timer);};},[native,status.state]);
 if(!native)return null;
 const progress=status.total&&status.total>0?Math.min(100,Math.floor((status.downloaded||0)*100/status.total)):0;
 return <>
 {(info?.available||status.state==='ready')&&<div role="status" className="px-3 py-2 bg-[#8E9F8B]/15 text-[#4D5E4A] text-xs flex items-center justify-between gap-2"><span>{status.state==='ready'?'新版安装包已校验，可覆盖更新':`发现 GitVault ${info?.update?.versionName||'新版本'}`}</span><button type="button" onClick={()=>setOpen(true)} className="px-2 py-1 border border-[#8E9F8B]/40 rounded-lg">查看更新</button></div>}
 {open&&<div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4"><div role="dialog" aria-modal="true" aria-label="应用更新" className="bg-white border border-[#DFD8CE] rounded-2xl p-4 w-full max-w-md flex flex-col gap-3 text-xs">
 <div className="flex justify-between items-center gap-2"><h2 className="font-bold text-[#2B2723]">应用更新{info?` · 当前 ${info.currentVersion}`:''}</h2><button aria-label="关闭应用更新" onClick={()=>setOpen(false)} className="px-2 py-1">关闭</button></div>
 <label className="flex gap-2 items-center"><input type="checkbox" checked={automatic} onChange={e=>{setAutomatic(e.target.checked);localStorage.setItem('gitvault_auto_update_check',String(e.target.checked));}}/>启动时自动检查更新</label>
 <label className="flex gap-2 items-center"><input type="checkbox" checked={downloadAuto} onChange={e=>{setDownloadAuto(e.target.checked);localStorage.setItem('gitvault_auto_update_download',String(e.target.checked));}}/>发现新版自动下载安装包</label>
 <p className="text-[#7A7367]">下载可在后台继续；安装前会核对包名、版本和签名。覆盖更新保留应用数据，安装时需要在 Android 界面确认。</p>
 {info&&<p>{info.available?`可更新至 ${info.update?.versionName}（${((info.update?.size||0)/1024/1024).toFixed(1)} MiB）`:info.message||'当前已是最新版本'}</p>}
 {['downloading','waiting'].includes(status.state)&&<p role="status">{status.state==='waiting'?'下载等待网络恢复':'正在下载安装包'} · {progress}%</p>}
 {status.state==='ready'&&<p role="status">安装包已验证，可覆盖安装。</p>}
 {(error||status.message)&&<p role="alert" className="text-[#8C5D54]">{error||status.message}</p>}
 <div className="flex flex-wrap gap-2 justify-end">
 <button disabled={checking} onClick={()=>void check()} className="px-3 py-2 border border-[#DFD8CE] rounded-xl">{checking?'正在检查…':'检查更新'}</button>
 {info?.available&&info.update&&!['downloading','waiting','ready'].includes(status.state)&&<button onClick={async()=>{try{setError('');setStatus(await updaterBridge.download({update:info.update!}));}catch(e){setError((e as Error).message);}}} className="px-3 py-2 rounded-xl bg-[#8E9F8B] text-white">下载新版</button>}
 {['downloading','waiting','error'].includes(status.state)&&<button onClick={async()=>{await updaterBridge.cancel();setStatus({state:'idle'});setError('');}} className="px-3 py-2 border border-[#DFD8CE] rounded-xl">取消下载</button>}
 {status.state==='ready'&&<button onClick={async()=>{try{setError('');const result=await updaterBridge.install();if(result.permissionRequired)setError('请允许安装此来源的应用，返回后再次点击“安装更新”。');}catch(e){setError((e as Error).message);}}} className="px-3 py-2 rounded-xl bg-[#8E9F8B] text-white">安装更新</button>}
 </div></div></div>}
 </>;
}
