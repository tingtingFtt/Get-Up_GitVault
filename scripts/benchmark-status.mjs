import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {githubClient,beginGithubOperation} from '../src/utils/githubClient.ts';
import {githubTransport,createGithubTransport} from '../src/utils/githubTransport.ts';
import {branchStatus} from '../src/utils/branchStatus.ts';
import {runStatusChecks} from '../src/utils/statusChecks.ts';

/** Production status client against a local HTTP peer; no external writes. */
export async function benchmarkStatus(){
 const originalFetch=globalThis.fetch,saved={...githubTransport};let stats,active=0;
 const sha='a'.repeat(40),items=Array.from({length:30},(_,i)=>({owner:'source',repo:'project-'+i,branch:'main'}));
 const server=createServer(async(req,res)=>{
  stats.requests++;stats.maximum=Math.max(stats.maximum,++active);
  try{
   await new Promise(resolve=>setTimeout(resolve,15));
   if(req.url.includes('/git/ref/heads/')){
    res.setHeader('ETag','"head-one"');if(req.headers['if-none-match']==='"head-one"'){stats.notModified++;res.writeHead(304);res.end();return;}
    const body=JSON.stringify({object:{type:'commit',sha}});stats.bytes+=Buffer.byteLength(body);res.end(body);return;
   }
   const body=JSON.stringify(req.url.includes('/commits/')?{sha,commit:{message:'synthetic commit',tree:{sha:'b'.repeat(40)}},files:[{patch:'x'.repeat(65536)}]}:{id:77});
   stats.bytes+=Buffer.byteLength(body);res.end(body);
  }finally{active--;}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=`http://127.0.0.1:${server.address().port}`;
 globalThis.fetch=(url,init)=>{const parsed=new URL(String(url));assert.equal(parsed.hostname,'api.github.com');return originalFetch(address+parsed.pathname,init);};
 Object.assign(githubTransport,createGithubTransport({writeInterval:0,requestInterval:0,shareAcrossTabs:false,readRetries:0,retries:0}));branchStatus.invalidate();
 const results=[];
 const measure=async(scenario,run)=>{stats={requests:0,bytes:0,notModified:0,maximum:0};const start=performance.now();await run();results.push({scenario,...stats,totalMs:Math.round((performance.now()-start)*100)/100});};
 const check=async(list,force=false)=>{const controller=new AbortController();await runStatusChecks(list,{signal:controller.signal,run:async item=>{const value=await githubClient.checkUpdate(item.owner,item.repo,item.branch,'old','benchmark-placeholder',{signal:controller.signal,force});assert.equal(value.latestSha,sha);}});};
 try{
  await measure('previous-serial-target-and-commit',async()=>{for(const item of items){await(await fetch('https://api.github.com/repos/me/'+item.repo)).json();await(await fetch(`https://api.github.com/repos/${item.owner}/${item.repo}/commits/main`)).json();}});assert.equal(stats.requests,60);
  await measure('lightweight-30-branches',()=>check(items));assert.equal(stats.requests,30);assert.ok(stats.maximum<=3);
  await measure('repeat-within-30-seconds',()=>check(items));assert.equal(stats.requests,0);
  await measure('force-conditional-refresh',()=>check(items,true));assert.equal(stats.requests,30);assert.equal(stats.notModified,30);
  branchStatus.invalidate();await measure('30-records-sharing-10-branches',()=>check(items.map((item,i)=>({...item,repo:'project-'+i%10}))));assert.equal(stats.requests,10);
  return {note:'30 records, localhost HTTP 15 ms per response, pacing disabled, synthetic 64 KiB legacy commit diff. Request counts and correctness are asserted; elapsed time is not a GitHub or phone speed promise.',results};
 }finally{branchStatus.invalidate();Object.assign(githubTransport,saved);globalThis.fetch=originalFetch;server.close();server.closeAllConnections();}
}
