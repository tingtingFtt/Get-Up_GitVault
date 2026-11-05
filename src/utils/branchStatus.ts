import {githubTransport} from './githubTransport';

export interface BranchHead {sha:string;checkedAt:string;cached:boolean}
interface Entry {sha:string;etag?:string;at:number;failed?:boolean}
interface Pending {controller:AbortController;promise:Promise<Entry>;users:number}
/** Read-only metadata, never project bytes or a source for a write lease. */
export function createBranchStatusReader(transport=githubTransport, now=Date.now) {
  const cache=new Map<string,Entry>(),pending=new Map<string,Pending>();
  const keyOf=(owner:string,repo:string,branch:string,token?:string)=>JSON.stringify([owner.toLowerCase(),repo.toLowerCase(),branch,token||'']);
  const trim=()=>{while(cache.size>256)cache.delete(cache.keys().next().value!);};
  const subscribe=(work:Pending,signal:AbortSignal)=>new Promise<Entry>((resolve,reject)=>{
    if(signal.aborted){if(!work.users)work.controller.abort();reject(signal.reason);return;}work.users++;let finished=false;
    const finish=(error:unknown,value?:Entry)=>{
      if(finished)return;finished=true;signal.removeEventListener('abort',abort);work.users--;
      if(!work.users)work.controller.abort();
      if(error)reject(error);else resolve(value!);
    };
    const abort=()=>finish(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    work.promise.then(value=>finish(undefined,value),error=>finish(error));
    if(signal.aborted)abort();
  });
  return {
    invalidate(owner?:string,repo?:string,branch?:string){
      for(const key of new Set([...cache.keys(),...pending.keys()])){
        const [o,r,b]=JSON.parse(key);
        if((!owner||o===owner.toLowerCase())&&(!repo||r===repo.toLowerCase())&&(!branch||b===branch)){
          cache.delete(key);
          const work=pending.get(key);if(work){work.controller.abort(new DOMException('分支版本已变化，请重新检测','AbortError'));pending.delete(key);}
        }
      }
    },
    async read(owner:string,repo:string,branch:string,token:string|undefined,signal:AbortSignal,force=false):Promise<BranchHead>{
      signal.throwIfAborted();
      const key=keyOf(owner,repo,branch,token),old=cache.get(key);
      if(!force&&old&&!old.failed&&now()-old.at>=0&&now()-old.at<30000)return {sha:old.sha,checkedAt:new Date(old.at).toISOString(),cached:true};
      let work=pending.get(key);
      if(work?.controller.signal.aborted){pending.delete(key);work=undefined;}
      if(!work){
        const controller=new AbortController();
        const promise=(async()=>{
          const url=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
          const headers:Record<string,string>={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:`Bearer ${token}`}:{})};
          if(old?.etag)headers['If-None-Match']=old.etag;
          const response=await transport.request(url,{headers,cache:'no-store'},controller.signal,15000,{notModified:true,readRetries:0});
          controller.signal.throwIfAborted();
          let value:Entry;
          if(response.status===304){if(!old)throw new Error('检测缓存缺失，请强制刷新');value={...old,at:now(),failed:false};}
          else {
            const data=await response.json();controller.signal.throwIfAborted();
            if(typeof data.object?.sha!=='string'||!data.object.sha||data.object.type&&data.object.type!=='commit'||data.ref&&data.ref!==`refs/heads/${branch}`)throw new Error('分支检测响应无效，未修改已有更新状态');
            value={sha:data.object.sha,etag:response.headers.get('etag')||undefined,at:now()};
          }
          if(pending.get(key)?.controller===controller){cache.delete(key);cache.set(key,value);trim();}return value;
        })();
        work={controller,promise,users:0};pending.set(key,work);
        const current=work;void promise.then(()=>{if(pending.get(key)===current)pending.delete(key);},()=>{if(pending.get(key)===current){pending.delete(key);const last=cache.get(key);if(last&&!controller.signal.aborted)cache.set(key,{...last,failed:true});}});
      }
      const value=await subscribe(work,signal);signal.throwIfAborted();
      return {sha:value.sha,checkedAt:new Date(value.at).toISOString(),cached:false};
    },
  };
}
export const branchStatus=createBranchStatusReader();
