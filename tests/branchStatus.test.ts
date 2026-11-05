import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBranchStatusReader} from '../src/utils/branchStatus';
import {githubTransport,GitHubError} from '../src/utils/githubTransport';
import {runStatusChecks} from '../src/utils/statusChecks';
const first='a'.repeat(40),second='b'.repeat(40);
const response=(sha=first,etag='one')=>new Response(JSON.stringify({object:{type:'commit',sha}}),{headers:{etag}});
test('branch status coalesces duplicate reads, caches briefly, and revalidates ETags on forced checks',async()=>{
 let now=100000,calls=0;
 const reader=createBranchStatusReader({...githubTransport,request:async(_url,init,_signal,timeout,policy)=>{
  assert.equal(timeout,15000);assert.equal(policy?.readRetries,0);assert.ok(policy?.notModified);calls++;
  return (init.headers as any)['If-None-Match']==='one'?new Response(null,{status:304}):response();
 }},()=>now);
 const signal=new AbortController().signal;
 const results=await Promise.all(Array.from({length:30},()=>reader.read('Owner','Repo','feature/a','token',signal)));
 assert.equal(calls,1);assert.ok(results.every(value=>value.sha===first));
 assert.equal((await reader.read('owner','repo','feature/a','token',signal)).cached,true);assert.equal(calls,1);
 now+=1000;assert.equal((await reader.read('owner','repo','feature/a','token',signal,true)).checkedAt,new Date(now).toISOString());assert.equal(calls,2);
 now+=31000;await reader.read('owner','repo','feature/a','token',signal);assert.equal(calls,3);
});
test('branch cache separates credentials, repositories and branches and never converts errors into latest',async()=>{
 let calls=0,fail=false,now=100000;
 const reader=createBranchStatusReader({...githubTransport,request:async()=>{calls++;if(fail)throw new GitHubError('Not Found',404);return response();}},()=>now);
 const signal=new AbortController().signal;
 for(const [owner,repo,branch,token] of [['a','b','main','one'],['a','b','dev','one'],['a','other','main','one'],['a','b','main','two']])await reader.read(owner,repo,branch,token,signal);
 assert.equal(calls,4);fail=true;now+=31000;
 await assert.rejects(reader.read('a','b','main','one',signal),{status:404});
 fail=false;await reader.read('a','b','main','one',signal);assert.equal(calls,6);
});
test('cancelling one consumer leaves a shared check alive for the remaining consumer',async()=>{
 let finish!:(value:Response)=>void,network!:AbortSignal;
 const reader=createBranchStatusReader({...githubTransport,request:async(_url,_init,signal)=>{network=signal;return new Promise(resolve=>finish=resolve);}});
 const a=new AbortController(),b=new AbortController();
 const one=reader.read('a','b','main','token',a.signal),two=reader.read('a','b','main','token',b.signal);
 a.abort();await assert.rejects(one,{name:'AbortError'});assert.equal(network.aborted,false);
 finish(response());assert.equal((await two).sha,first);
});
test('a failed force refresh cannot be hidden by a still-fresh older cached result',async()=>{
 let calls=0,fail=false;
 const reader=createBranchStatusReader({...githubTransport,request:async()=>{calls++;if(fail)throw new Error('network failed');return response(second);}},()=>1000);
 const signal=new AbortController().signal;await reader.read('a','b','main','token',signal);
 fail=true;await assert.rejects(reader.read('a','b','main','token',signal,true),/network failed/);
 await assert.rejects(reader.read('a','b','main','token',signal),/network failed/);assert.equal(calls,3);
 fail=false;assert.equal((await reader.read('a','b','main','token',signal)).cached,false);
});
test('cancelling all consumers aborts the network and a late result cannot populate the cache',async()=>{
 let finish!:(value:Response)=>void,calls=0,network!:AbortSignal;
 const reader=createBranchStatusReader({...githubTransport,request:async(_url,_init,signal)=>{network=signal;return ++calls===1?new Promise(resolve=>finish=resolve):response(second);}});
 const controller=new AbortController(),pending=reader.read('a','b','main','token',controller.signal);controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.ok(network.aborted);finish(response());
 await new Promise(resolve=>setImmediate(resolve));assert.equal((await reader.read('a','b','main','token',new AbortController().signal)).sha,second);assert.equal(calls,2);
});
test('invalidating a branch prevents in-flight stale cache publication and validates the selected ref',async()=>{
 let finish!:(value:Response)=>void,calls=0;
 const reader=createBranchStatusReader({...githubTransport,request:async()=>++calls===1?new Promise(resolve=>finish=resolve):response(second)});
 const signal=new AbortController().signal,pending=reader.read('a','b','main','token',signal);
 reader.invalidate('a','b','main');finish(response());await assert.rejects(pending,{name:'AbortError'});
 assert.equal((await reader.read('a','b','main','token',signal)).sha,second);
 const bad=createBranchStatusReader({...githubTransport,request:async()=>new Response(JSON.stringify({ref:'refs/heads/other',object:{sha:first,type:'commit'}}))});
 await assert.rejects(bad.read('a','b','main','token',signal),/响应无效/);
});
test('status scheduling bounds concurrency and a slow first repository does not block later results',async()=>{
 let active=0,maximum=0,release!:()=>void;const finished:number[]=[];
 const pending=runStatusChecks([0,1,2,3,4],{signal:new AbortController().signal,run:async item=>{maximum=Math.max(maximum,++active);if(!item)await new Promise<void>(resolve=>release=resolve);else await new Promise(resolve=>setImmediate(resolve));finished.push(item);active--;}});
 while(finished.length<4)await new Promise(resolve=>setImmediate(resolve));assert.ok(!finished.includes(0));assert.equal(maximum,3);release();assert.equal((await pending).done,5);
});
test('status cancellation waits for active checks and does not start queued repositories',async()=>{
 const controller=new AbortController();const started:number[]=[],finish:Array<()=>void>=[];
 const pending=runStatusChecks([0,1,2,3,4],{signal:controller.signal,run:async item=>{started.push(item);await new Promise<void>(resolve=>finish.push(resolve));}});
 while(started.length<3)await new Promise(resolve=>setImmediate(resolve));controller.abort();let settled=false;void pending.then(()=>settled=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);finish.forEach(resolve=>resolve());const result=await pending;
 assert.deepEqual(started,[0,1,2]);assert.equal(result.done,3);assert.equal(result.cancelled,true);
});
