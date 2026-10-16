import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import './dom';
import { createGitRouter } from '../server/gitRouter';
import type { createGitEngine } from '../server/gitEngine';
import { gitServiceConfig, saveGitServiceConfig, testGitService, gitServiceTransfer } from '../src/utils/gitService';
import { githubClient, beginGithubOperation } from '../src/utils/githubClient';
import { immediateTransport } from './transportFixture';
import { localCache } from '../src/utils/localCache';
const originalFetch = globalThis.fetch;
const source = '1'.repeat(40), commit = '2'.repeat(40), tree = '3'.repeat(40);
const sha = (value: string) => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const bytes = '中文\n', file = {path:'source.txt',content:bytes,isBase64:false,mode:'100644',sha:sha(bytes)};
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value),{status});
let server: Server, endpoint: string;
let pushed: boolean, pushCalls: number, credential: string, id: number, enabled: boolean;
let apiCalls: Array<{path:string;method:string}>, headers: Array<{path:string;authorization?:string}>;
type Engine = ReturnType<typeof createGitEngine>;
let onPush: Engine['push'], onFetch: Engine['fetch'];
beforeEach(async()=>{
  localStorage.clear();beginGithubOperation();immediateTransport();pushed=false;pushCalls=0;credential='';id=77;enabled=true;apiCalls=[];headers=[];
  await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase('GitVault_Storage_v1');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
  onPush=async(identity,branch,token)=>{pushed=true;pushCalls++;credential=token;return{verified:true,repoId:identity.id,branch,commitSha:commit,treeSha:tree};};
  onFetch=async(_identity,ref,token)=>{credential=token;return{commitSha:ref,treeSha:tree,files:[{path:file.path,mode:file.mode,sha:file.sha,encoding:'base64',content:Buffer.from(bytes).toString('base64')}]};};
  const app=express();app.use((req,_res,next)=>{headers.push({path:req.path,authorization:req.get('authorization')});next();});
  const router=createGitRouter({enabled:true,allowedOrigins:['https://tingtingftt.github.io'],identity:async()=>({id,owner:'me',repo:'project'}),engine:{push:(...args)=>onPush(...args),fetch:(...args)=>onFetch(...args)}});
  app.use('/api/git',(req,res,next)=>enabled?router(req,res,next):res.status(503).json({error:'service unavailable'}));
  server=await new Promise<Server>((resolve,reject)=>{const service=app.listen(0,'127.0.0.1',()=>resolve(service));service.on('error',reject);});
  endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);
    if(!url.startsWith('https://api.github.com'))return originalFetch(input,init);
    const path=url.slice('https://api.github.com'.length);apiCalls.push({path,method:init.method||'GET'});
    if(path==='/repos/me/project')return reply({id:77,name:'project',owner:{login:'me'},default_branch:'main',private:true,html_url:'https://github.com/me/project'});
    if(path==='/repos/me/project/commits/main')return reply({sha:source,commit:{tree:{sha:tree},message:'source',author:{name:'author'}}});
    if(path.includes('/git/ref/heads/dev'))return pushed?reply({object:{sha:commit}}):reply({message:'Not Found'},404);
    if(path.includes('/git/commits/'+commit))return reply({tree:{sha:tree}});
    if(path.includes('/git/trees/'+tree))return reply({tree:[{path:file.path,type:'blob',mode:file.mode,sha:file.sha}]});
    throw new Error('Unexpected GitHub request: '+path);
  };
});
afterEach(async()=>{globalThis.fetch=originalFetch;mock.restoreAll();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
const configured=()=>saveGitServiceConfig({mode:'git',url:endpoint});
test('configured Git push uses one service transfer, verifies GitHub objects and never writes blobs through REST',async()=>{
  configured();const result=await githubClient.push('me','project','dev','fake-token',[file],'sync',undefined,undefined,undefined,{expectedRepoId:77,rebaseOnConflict:true});
  assert.equal(result.verified,true);assert.equal(result.commitSha,commit);assert.equal(result.branch,'dev');
  assert.equal(pushCalls,1);assert.equal(credential,'fake-token');
  assert.ok(apiCalls.every(call=>call.method==='GET'));assert.ok(!apiCalls.some(call=>call.path.includes('/heads/main')));
  assert.ok(!JSON.stringify({...localStorage}).includes('fake-token'));
});
test('configured Git fetch validates pinned manifests and bytes before completing the existing cache flow',async()=>{
  configured();const result=await githubClient.fetchRepo('me/project','main','fake-token');
  assert.equal(result.latestCommitSha,source);assert.equal(result.files[0].content,bytes);assert.equal(result.files[0].sha,file.sha);
  assert.ok(!apiCalls.some(call=>call.path.includes('/git/blobs/')||call.path.includes('/zipball/')));
});
test('a corrupt Git fetch fails without REST fallback or replacing previously saved source',async()=>{
  await localCache.saveProjectFiles('existing',[{...file,content:'old',sha:sha('old')}],'old');configured();
  onFetch=async(_identity,ref)=>({commitSha:ref,treeSha:tree,files:[{path:file.path,mode:file.mode,sha:file.sha,encoding:'base64',content:Buffer.from('wrong').toString('base64')}]});
  await assert.rejects(githubClient.fetchRepo('me/project','main','fake-token'),/校验失败/);
  assert.equal((await localCache.getProjectFiles('existing'))[0].content,'old');
  assert.ok(apiCalls.every(call=>call.method==='GET'));assert.ok(!apiCalls.some(call=>call.path.includes('/git/blobs/')));
});
test('an unavailable Git service stops before pushing and never silently falls back to REST',async()=>{
  configured();enabled=false;
  await assert.rejects(githubClient.push('me','project','dev','fake-token',[file],'sync'),/Git 服务 \(503\)/);
  assert.equal(pushCalls,0);assert.ok(apiCalls.every(call=>call.method==='GET'));
});
test('service health checks contain no GitHub credential and CORS only permits configured origins',async()=>{
  await testGitService(endpoint);assert.ok(headers.every(item=>!item.authorization));
  const allowed=await originalFetch(endpoint+'/api/git/health',{headers:{Origin:'https://tingtingftt.github.io'}});
  assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),'https://tingtingftt.github.io');
  const denied=await originalFetch(endpoint+'/api/git/health',{headers:{Origin:'https://untrusted.example'}});
  assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
});
test('repository ID replacement is rejected before any Git transfer',async()=>{
  configured();id=88;
  await assert.rejects(gitServiceTransfer('push',{owner:'me',repo:'project',expectedRepoId:77,branch:'dev',files:[file]},'fake-token',new AbortController().signal),/ID 已变化/);
  assert.equal(pushCalls,0);
});
test('cancelling a browser transfer aborts the server job',async()=>{
  configured();let started=false,aborted=false;
  onPush=async(_identity,_branch,_token,_files,_message,signal)=>{
    started=true;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
  };
  const controller=new AbortController();const pending=gitServiceTransfer('push',{owner:'me',repo:'project',expectedRepoId:77,branch:'dev',files:[file]},'fake-token',controller.signal);
  while(!started)await new Promise(resolve=>setTimeout(resolve,5));
  controller.abort();await assert.rejects(pending,{name:'AbortError'});
  for(let attempt=0;attempt<100&&!aborted;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(aborted,true);
});
test('transport selection validates URLs, stores no credentials and defaults to REST',()=>{
  assert.equal(gitServiceConfig().mode,'rest');
  for(const url of ['http://public.example','https://user:secret@example.com','https://example.com/?token=secret'])assert.throws(()=>saveGitServiceConfig({mode:'git',url}));
  configured();assert.deepEqual(gitServiceConfig(),{mode:'git',url:endpoint});
  saveGitServiceConfig({mode:'rest',url:endpoint});assert.equal(gitServiceConfig().mode,'rest');
});
