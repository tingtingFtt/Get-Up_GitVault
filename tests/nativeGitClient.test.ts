import './dom';
import {test,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Capacitor} from '@capacitor/core';
import {nativeGitBridge,NATIVE_CHUNK_BYTES} from '../src/utils/nativeGit';
import {saveGitServiceConfig} from '../src/utils/gitService';
import {githubClient,beginGithubOperation} from '../src/utils/githubClient';
import {localCache,transferCache} from '../src/utils/localCache';
import {immediateTransport} from './transportFixture';
const originalFetch=globalThis.fetch,commit='a'.repeat(40),tree='b'.repeat(40),head='c'.repeat(40);
const bytes=new Map([['资源/large.bin',Buffer.alloc(NATIVE_CHUNK_BYTES+9,241)],['empty.txt',Buffer.alloc(0)]]);
const entries=[...bytes].map(([path,value])=>({path,sha:createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex'),size:value.length,type:'blob',mode:'100644',encoding:'base64' as const}));
let paths:string[],apiCalls:string[],headExists:boolean,released:number;
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
beforeEach(async()=>{
 localStorage.clear();immediateTransport();beginGithubOperation();paths=[];apiCalls=[];headExists=false;released=0;
 await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase('GitVault_Storage_v1');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
 mock.method(Capacitor,'isNativePlatform',()=>true);mock.method(Capacitor,'getPlatform',()=> 'android');mock.method(Capacitor,'isPluginAvailable',()=>true);saveGitServiceConfig({mode:'native',url:''});
 mock.method(nativeGitBridge,'addListener',async()=>({remove:async()=>{}}));mock.method(nativeGitBridge,'release',async()=>{released++;});
 mock.method(nativeGitBridge,'transfer',async(value:Record<string,unknown>)=>value.action==='fetch'?{chunked:true,commitSha:commit,treeSha:tree,files:entries}:{verified:true,repoId:77,branch:'dev',commitSha:head,treeSha:tree});
 mock.method(nativeGitBridge,'readChunk',async(value:Record<string,unknown>)=>{const path=String(value.path),offset=Number(value.offset),data=bytes.get(path)!;paths.push(path);const part=data.subarray(offset,offset+NATIVE_CHUNK_BYTES);return {offset,bytes:part.length,done:offset+part.length===data.length,content:part.toString('base64')};});
 globalThis.fetch=async(url,init={})=>{
  const path=String(url).replace('https://api.github.com','');apiCalls.push(path);assert.ok(!init.method||init.method==='GET');
  if(path==='/repos/source/project')return reply({id:77,owner:{login:'source'},name:'project',default_branch:'main'});
  if(path.includes('/git/ref/heads/dev'))return headExists?reply({object:{sha:head}}):reply({message:'Not Found'},404);
  if(path.includes('/git/commits/'+head))return reply({tree:{sha:tree}});
  if(path.includes('/commits/'))return reply({sha:commit,commit:{tree:{sha:tree},message:'source',author:{}}});
  if(path.includes('/git/trees/'))return reply({tree:entries});
  throw new Error('Unexpected REST '+path);
 };
});
afterEach(()=>{globalThis.fetch=originalFetch;mock.restoreAll();localStorage.clear();});
test('native client checkpoints verified files and resumes without reading them again',async()=>{
 const read=nativeGitBridge.readChunk;let failed=false;
 mock.method(nativeGitBridge,'readChunk',async(value:Record<string,unknown>)=>{if(value.path==='empty.txt'&&!failed){failed=true;throw new Error('interrupted');}return read(value);});
 await assert.rejects(githubClient.fetchRepo('source/project'),/interrupted/);
 assert.equal((await transferCache.load(`source/project@${commit}`)).length,1);const firstReads=paths.filter(path=>path==='资源/large.bin').length;
 const result=await githubClient.fetchRepo('source/project');assert.equal(result.files.length,2);assert.equal(paths.filter(path=>path==='资源/large.bin').length,firstReads);
 await localCache.saveProjectFiles('saved',result.files,result.latestCommitSha);
 assert.equal((await localCache.getProjectFiles('saved'))[0].sha,entries[0].sha);assert.equal((await transferCache.load(`source/project@${commit}`)).length,0);
 assert.ok(!apiCalls.some(path=>path.includes('/git/blobs/')||path.includes('/zipball/')));assert.equal(released,2);
});
test('native push stages file chunks before a metadata-only transfer and verifies the matching branch',async()=>{
 let chunks=0;mock.method(nativeGitBridge,'prepareUpload',async()=>{});mock.method(nativeGitBridge,'appendChunk',async(value:Record<string,unknown>)=>{assert.ok(Buffer.from(String(value.content),'base64').length<=NATIVE_CHUNK_BYTES);chunks++;});
 mock.method(nativeGitBridge,'transfer',async(value:Record<string,unknown>)=>{assert.equal(value.branch,'dev');assert.ok((value.files as any[]).every(file=>file.content===undefined));headExists=true;return {verified:true,repoId:77,branch:'dev',commitSha:head,treeSha:tree};});
 const result=await githubClient.push('source','project','dev','test-token',entries.map(entry=>({...entry,content:bytes.get(entry.path)!.toString('base64'),isBase64:true})),'upload');
 assert.ok(result.verified);assert.equal(chunks,3);assert.ok(!apiCalls.some(path=>path.includes('/heads/main')));assert.equal(released,1);
});
