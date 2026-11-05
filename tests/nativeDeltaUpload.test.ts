import './dom';
import {test,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Capacitor} from '@capacitor/core';
import {githubClient,beginGithubOperation} from '../src/utils/githubClient';
import {folderBridge,folderFiles,hasCurrentNativeScan} from '../src/utils/nativeFolder';
import {nativeGitBridge} from '../src/utils/nativeGit';
import {saveGitServiceConfig} from '../src/utils/gitService';
import {gitTreeSha} from '../src/utils/gitFiles';
import {immediateTransport} from './transportFixture';
import type {CachedFile} from '../src/utils/localCache';
const originalFetch=globalThis.fetch;
const sha=(value:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const big=sha('simulated native large resource'),old=sha('old'),changed=sha('new');
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
let files:CachedFile[],target:Array<any>,calls:Array<{path:string;method:string;body:any}>,reads:string[],scans:number,current:string,badSource:boolean;
beforeEach(async()=>{
 immediateTransport();beginGithubOperation();localStorage.clear();calls=[];reads=[];scans=0;current='parent';badSource=false;
 await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase('GitVault_Storage_v1');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
 mock.method(Capacitor,'isNativePlatform',()=>true);mock.method(Capacitor,'getPlatform',()=> 'android');mock.method(Capacitor,'isPluginAvailable',()=>true);saveGitServiceConfig({mode:'native',url:''});
 files=[{path:'large.bin',sha:big,size:2*1024*1024*1024,mode:'100644',content:'',isBase64:true,nativeRef:{version:'current',path:'large.bin'}},{path:'small.txt',sha:changed,size:3,mode:'100644',content:'',isBase64:true,nativeRef:{version:'current',path:'small.txt'}}];
 target=files.map(file=>({path:file.path,sha:file.path==='small.txt'?old:big,mode:'100644',type:'blob',size:file.size}));
 mock.method(folderBridge,'listen',async()=>({remove:async()=>{}}));
 mock.method(folderBridge,'list',async()=>{scans++;return {files:files.map(file=>({...file,sha:badSource&&file.path==='large.bin'?sha('changed on disk'):file.sha,nativeRef:{...file.nativeRef!}})),dirty:false};});
 mock.method(folderBridge,'read',async(value:any)=>{reads.push(value.path);assert.equal(value.path,'small.txt','An unchanged multi-GiB resource must not cross the WebView bridge');return {data:Buffer.from('new').toString('base64'),bytes:3,done:true};});
 mock.method(nativeGitBridge,'transfer',async()=>assert.fail('A small update must not fetch or send another Git pack'));
 globalThis.fetch=async(input,init={})=>{
  const path=String(input).replace('https://api.github.com',''),method=init.method||'GET',body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,method,body});
  if(path==='/repos/me/project')return reply({id:77,owner:{login:'me'},name:'project',default_branch:'main'});
  if(path.endsWith('/git/ref/heads/dev'))return reply({object:{sha:current}});
  if(path.endsWith('/git/commits/parent'))return reply({tree:{sha:await gitTreeSha(target)}});
  if(path.includes('/git/trees/')&&method==='GET')return reply({tree:target});
  if(path.endsWith('/git/blobs')&&method==='POST')return reply({sha:sha(body.encoding==='base64'?Buffer.from(body.content,'base64').toString():body.content)});
  if(path.endsWith('/git/trees')&&method==='POST')return reply({sha:await gitTreeSha(files.map(file=>({path:file.path,sha:file.sha!,mode:file.mode!})))});
  if(path.endsWith('/git/commits')&&method==='POST')return reply({sha:'published'});
  if(path.endsWith('/git/refs/heads/dev')&&method==='PATCH'){assert.equal(body.force,false);current='published';return reply({object:{sha:current}});}
  if(path.endsWith('/git/commits/published'))return reply({tree:{sha:await gitTreeSha(files.map(file=>({path:file.path,sha:file.sha!,mode:file.mode!})))}});
  throw new Error('Unexpected HTTP '+method+' '+path);
 };
});
afterEach(()=>{mock.restoreAll();globalThis.fetch=originalFetch;localStorage.clear();});
test('native small updates verify the current directory once and transfer only the changed body',async()=>{
 const result=await githubClient.push('me','project','dev','token',files,'small update');
 assert.ok(result.verified);assert.equal(scans,1);assert.deepEqual(reads,['small.txt']);
 assert.equal(calls.filter(call=>call.path.endsWith('/git/blobs')&&call.method==='POST').length,1);
 assert.deepEqual(calls.find(call=>call.path.endsWith('/git/commits')&&call.method==='POST')!.body.parents,['parent']);
 assert.ok(calls.every(call=>!call.path.includes('/heads/main')));
});
test('unchanged native uploads verify current bytes but write no object, tree, commit or ref',async()=>{
 target=files.map(file=>({path:file.path,sha:file.sha,mode:file.mode,type:'blob',size:file.size}));
 const result=await githubClient.push('me','project','dev','token',files,'no change');
 assert.ok('unchanged' in result&&result.unchanged);assert.equal(scans,1);assert.equal(reads.length,0);assert.ok(calls.every(call=>call.method==='GET'));
});
test('persistent handles cannot bypass source verification and changed files stop before any remote write',async()=>{
 badSource=true;await assert.rejects(githubClient.push('me','project','dev','token',files,'must fail'),/上传准备期间变化/);
 assert.equal(scans,1);assert.ok(calls.every(call=>call.method==='GET'));assert.equal(reads.length,0);
});
test('a native scan proof is scoped to the operation and invalidated by metadata changes',async()=>{
 const {operationSignal}=await import('../src/utils/operation');
 const signal=operationSignal(),scanned=await folderFiles('current',true,signal);
 assert.ok(hasCurrentNativeScan(scanned[0],signal));assert.equal(hasCurrentNativeScan({...scanned[0]},signal),false);
 scanned[0].sha=old;assert.equal(hasCurrentNativeScan(scanned[0],signal),false);
 assert.equal(hasCurrentNativeScan(scanned[1],new AbortController().signal),false);
});
