import type { githubApi } from './githubClient';
import { GitHubError } from './githubTransport';
import { readMetadataSource } from './projectProvenance';

const DB='GitVault_Discovery_v1';
export interface DiscoveryRow {
  key:string; account:string; repo:any; parent?:{id?:number;full_name?:string};
  branches?:string[]; nextBranch:number; sources:Array<{owner:string;repo:string;branch:string}>; complete:boolean;
}
interface ScanState {account:string; page:number; listed:boolean; updatedAt:number}
const requestValue=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
async function database(){return new Promise<IDBDatabase>((resolve,reject)=>{
  const r=indexedDB.open(DB,1);let expired=false;
  const timer=setTimeout(()=>{expired=true;reject(new Error('发现缓存被其他页面占用，请关闭旧页面后重试'));},10000);
  r.onupgradeneeded=()=>{r.result.createObjectStore('state',{keyPath:'account'});r.result.createObjectStore('repos',{keyPath:'key'}).createIndex('account','account');};
  r.onerror=()=>{clearTimeout(timer);reject(r.error);};r.onsuccess=()=>{clearTimeout(timer);if(expired){r.result.close();return;}r.result.onversionchange=()=>r.result.close();resolve(r.result);};
});}
async function transact<T>(mode:IDBTransactionMode,work:(tx:IDBTransaction)=>Promise<T>|T){
  const db=await database();try{const tx=db.transaction(['state','repos'],mode);const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('发现进度保存中断'));tx.onerror=()=>{};});
    try{const result=await work(tx);await done;return result;}catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
  }finally{db.close();}
}
export const discoveryStore={
  async load(account:string){return transact('readonly',async tx=>{const [state,rows]=await Promise.all([requestValue(tx.objectStore('state').get(account)),requestValue(tx.objectStore('repos').index('account').getAll(account))]);return {state:state as ScanState|undefined,rows:rows as DiscoveryRow[]};});},
  async save(state:ScanState,rows:DiscoveryRow[]){await transact('readwrite',tx=>{tx.objectStore('state').put(state);for(const row of rows)tx.objectStore('repos').put(row);});},
  async clear(account:string){await transact('readwrite',async tx=>{const keys=await requestValue(tx.objectStore('repos').index('account').getAllKeys(account));for(const key of keys)tx.objectStore('repos').delete(key);tx.objectStore('state').delete(account);});},
};
const missing=(e:unknown)=>e instanceof GitHubError&&e.status===404;
const activeScans=new Map<string,Promise<DiscoveryRow[]>>();
/** Explicit, resumable discovery only. Stored rows contain identities/provenance, never tokens or source bytes. */
export async function scanAccountDiscovery(login:string,token:string,api:typeof githubApi,signal:AbortSignal,report:(message:string)=>void,refresh=false):Promise<DiscoveryRow[]>{
  const account=login.toLowerCase();
  // A second tab must not reset or advance the same durable scan concurrently.
  const run=async()=>{
    signal.throwIfAborted();if(refresh)await discoveryStore.clear(account);
    const saved=await discoveryStore.load(account);
    const state=saved.state||{account,page:1,listed:false,updatedAt:Date.now()};
    const rows=new Map(saved.rows.map(row=>[row.key,row]));
    while(!state.listed){
      signal.throwIfAborted();report(`发现已有项目：读取仓库第 ${state.page} 页（已保存 ${rows.size} 个）…`);
      const list=await api(`/user/repos?affiliation=owner&per_page=100&page=${state.page}`,token,{cache:'no-store'},signal);
      if(!Array.isArray(list))throw new Error('账号仓库列表读取失败，扫描进度保留');
      const added:DiscoveryRow[]=[];
      for(const repo of list)if(repo.owner?.login?.toLowerCase()===account&&repo.name!=='.gitvault-state'){
        if(!Number.isSafeInteger(repo.id)||repo.id<=0)throw new Error('仓库列表缺少可信 ID，扫描进度保留');
        const key=`${account}:${repo.id}`;if(!rows.has(key)){const row={key,account,repo:{id:repo.id,name:repo.name,owner:{login:repo.owner.login},fork:!!repo.fork,private:!!repo.private},nextBranch:0,sources:[],complete:false};rows.set(key,row);added.push(row);}
      }
      state.listed=list.length<100;if(!state.listed&&state.page>=50)throw new Error('仓库列表超过单次发现范围，请使用关键词定位');
      state.page++;state.updatedAt=Date.now();await discoveryStore.save(state,added);
    }
    let completed=[...rows.values()].filter(row=>row.complete).length;
    for(const row of rows.values()){
      signal.throwIfAborted();if(row.complete)continue;
      report(`发现已有项目：核对 ${completed+1}/${rows.size} · ${row.repo.name}（可取消并继续）…`);
      const root=`/repos/${row.repo.owner.login}/${row.repo.name}`;
      if(row.repo.fork){const meta=await api(root,token,{cache:'no-store'},signal);row.parent=meta.parent?{id:meta.parent.id,full_name:meta.parent.full_name}:undefined;}
      else{
        if(!row.branches){
          const branches:string[]=[];
          for(let page=1;page<=50;page++){signal.throwIfAborted();const list=await api(`${root}/branches?per_page=100&page=${page}`,token,{},signal);if(!Array.isArray(list))throw new Error('仓库分支读取失败，扫描进度保留');branches.push(...list.map(item=>item.name));if(list.length<100)break;if(page===50)throw new Error('分支列表未完整遍历，请缩小查找范围');}
          row.branches=branches;await discoveryStore.save(state,[row]);
        }
        while(row.nextBranch<row.branches.length){
          signal.throwIfAborted();const branch=row.branches[row.nextBranch];
          try{const file=await api(`${root}/contents/GITVAULT_METADATA.md?ref=${encodeURIComponent(branch)}`,token,{},signal);
            if(file.encoding==='base64'&&file.size<=64000){const source=readMetadataSource(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0))));if(source)row.sources.push({...source,branch});}
          }catch(error){if(!missing(error))throw error;}
          row.nextBranch++;state.updatedAt=Date.now();await discoveryStore.save(state,[row]);
        }
      }
      signal.throwIfAborted();row.complete=true;completed++;state.updatedAt=Date.now();await discoveryStore.save(state,[row]);
    }
    report(`发现完成：已核对 ${completed} 个仓库；可刷新后重新扫描。`);return [...rows.values()];
  };
  let started=false;
  const queued=(activeScans.get(account)||Promise.resolve()).catch(()=>{}).then(async()=>{signal.throwIfAborted();started=true;if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request(`gitvault-discovery:${account}`,{mode:'exclusive',signal},run);return run();});
  activeScans.set(account,queued);void queued.then(()=>{if(activeScans.get(account)===queued)activeScans.delete(account);},()=>{if(activeScans.get(account)===queued)activeScans.delete(account);});
  // Cancellation of a queued scan must not wait for another tab/task to finish.
  return new Promise((resolve,reject)=>{const abort=()=>{if(!started)reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});queued.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
}
