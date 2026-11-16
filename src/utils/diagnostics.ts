import {Capacitor} from '@capacitor/core';
import {registerPlugin} from '@capacitor/core';
import {redactLog,readOperationLogs} from './operationLog';
const plugin=registerPlugin<{checkpoint(options:{entry:unknown}):Promise<void>;report():Promise<unknown>;pulse(options:{visible:boolean}):Promise<void>}>('GitVaultDiagnostics');
const KEY='gitvault_diagnostics_v1';
type Entry={time:string;kind:string;stage?:string;project?:string;branch?:string;action?:string;status?:string;message?:string;stack?:string;elapsedMs?:number};
let secrets:string[]=[],started=performance.now(),installed=false,lastWrite=0,pending:Entry|undefined,timer:ReturnType<typeof setTimeout>|undefined;
let task:Pick<Entry,'project'|'branch'|'action'>={};
const native=()=>Capacitor.isNativePlatform()&&Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('GitVaultDiagnostics');
export function diagnosticSecrets(values:string[]){secrets=[...new Set(values.filter(value=>value.length>=4))];}
function clean(entry:Entry):Entry{
 const safe:Record<string,unknown>={};
 for(const key of ['time','kind','stage','project','branch','action','status','message','stack'] as const){const value=entry[key];if(typeof value==='string')safe[key]=redactLog(value,secrets,key==='stack'?8000:1200);}
 if(typeof entry.elapsedMs==='number'&&Number.isFinite(entry.elapsedMs))safe.elapsedMs=Math.max(0,entry.elapsedMs);
 return safe as Entry;
}
export function readDiagnostics():Entry[]{try{const parsed=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(parsed)?parsed.filter(row=>row&&typeof row.time==='string'&&typeof row.kind==='string').slice(-80).map(clean):[];}catch{return [];}}
function persist(entry:Entry){
 lastWrite=performance.now();const safe=clean(entry);
 try{localStorage.setItem(KEY,JSON.stringify([...readDiagnostics(),safe].slice(-80)));}catch{}
 if(native())void plugin.checkpoint({entry:safe}).catch(()=>{});
}
export function diagnosticEvent(kind:string,details:Omit<Partial<Entry>,'time'|'kind'>={},immediate=true){
 const entry=clean({time:new Date().toISOString(),kind,...task,...details});
 if(immediate){if(timer)clearTimeout(timer);timer=undefined;pending=undefined;persist(entry);}
 else{pending=entry;if(!timer)timer=setTimeout(()=>{timer=undefined;if(pending){const value=pending;pending=undefined;persist(value);}},Math.max(0,1000-(performance.now()-lastWrite)));}
}
export function diagnosticTask(project:string,branch:string,action:string){const previous=task;task={project,branch,action};diagnosticEvent('task',{stage:'准备任务',status:'running'});return ()=>{task=previous;if(task.action)diagnosticEvent('phase',{stage:'继续项目任务',status:'running'});};}
export function diagnosticPhase(stage:string){diagnosticEvent('phase',{stage,status:'running'});}
export function diagnosticTaskResult(status:string){diagnosticEvent('task-result',{status});task={};}
export function startupStage(stage:string){const label=document.getElementById('boot-stage');if(label)label.textContent=stage;diagnosticEvent('startup',{stage,elapsedMs:Math.round(performance.now()-started)});}
export function appReady(){startupStage('首屏已显示');document.documentElement.dataset.gitvaultReady='true';}
export function installDiagnostics(){
 if(installed)return;installed=true;started=performance.now();startupStage('加载应用模块');
 window.addEventListener('error',event=>{const error=event as ErrorEvent;diagnosticEvent('javascript-error',{message:error.message||'资源加载失败',stack:error.error?.stack||''});});
 window.addEventListener('unhandledrejection',event=>{const reason=(event as PromiseRejectionEvent).reason;diagnosticEvent('unhandled-rejection',{message:reason instanceof Error?reason.message:String(reason).slice(0,1200),stack:reason?.stack||''});});
 window.addEventListener('gitvault-progress',event=>{const message=(event as CustomEvent).detail;if(typeof message==='string'&&task.action)diagnosticEvent('progress',{stage:message},false);});
 const pulse=()=>{if(native())void plugin.pulse({visible:!document.hidden}).catch(()=>{});};
 document.addEventListener('visibilitychange',pulse);pulse();setInterval(pulse,3000);
}
export function redactDiagnosticData(value:unknown,key=''):unknown{
 return typeof value==='string'?redactLog(value,secrets,key==='stack'?8000:key==='trace'?16384:5000):Array.isArray(value)?value.map(item=>redactDiagnosticData(item,key)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([field,item])=>[field,redactDiagnosticData(item,field)])):value;
}
export async function diagnosticReport(){
 let system:unknown={available:false};if(native())try{system=redactDiagnosticData(await plugin.report());}catch(error){system={available:false,message:redactLog((error as Error).message,secrets)};}
 const logs=readOperationLogs().slice(0,200).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,typeof value==='string'?redactLog(value,secrets):value])));
 return {format:'GitVault diagnostic v1',exportedAt:new Date().toISOString(),environment:{userAgent:navigator.userAgent,platform:Capacitor.getPlatform(),native:Capacitor.isNativePlatform()},events:readDiagnostics(),operations:logs,system};
}
