import './dom';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Capacitor} from '@capacitor/core';
import {nativeGitBridge,nativeGitTransfer,NATIVE_CHUNK_BYTES} from '../src/utils/nativeGit';
import {createHash} from 'node:crypto';
import {gitServiceConfig,saveGitServiceConfig} from '../src/utils/gitService';
const bridge={...nativeGitBridge},platform={isNativePlatform:Capacitor.isNativePlatform,getPlatform:Capacitor.getPlatform,isPluginAvailable:Capacitor.isPluginAvailable};
afterEach(()=>{Object.assign(nativeGitBridge,bridge);Object.assign(Capacitor,platform);localStorage.clear();});
test('new APKs default to direct native Git and retain an explicit REST preference',()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
 assert.equal(gitServiceConfig().mode,'native');saveGitServiceConfig({mode:'rest',url:''});assert.equal(gitServiceConfig().mode,'rest');
});
test('native downloads checkpoint one bounded file at a time and skip already cached files',async()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
 const bytes=Buffer.alloc(NATIVE_CHUNK_BYTES*2+7,241),sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 const file={path:'large.bin',sha,mode:'100644',size:bytes.length,encoding:'base64'};
 let released=false,reads=0,accepted=0;
 nativeGitBridge.addListener=async()=>({remove:async()=>{}});nativeGitBridge.release=async()=>{released=true;};
 nativeGitBridge.transfer=async()=>({chunked:true,files:[file,{...file,path:'cached.bin'}],commitSha:'a'.repeat(40),treeSha:'b'.repeat(40)});
 nativeGitBridge.readChunk=async value=>{assert.equal(value.path,'large.bin');reads++;const offset=Number(value.offset),part=bytes.subarray(offset,offset+NATIVE_CHUNK_BYTES);return {offset,bytes:part.length,done:offset+part.length===bytes.length,content:part.toString('base64')};};
 const result=await nativeGitTransfer('fetch',{owner:'source',repo:'repo',expectedRepoId:1},'',new AbortController().signal,{paths:['large.bin'],onFile:async value=>{accepted++;assert.deepEqual(Buffer.from(value.content,'base64'),bytes);}});
 assert.equal(reads,3);assert.equal(accepted,1);assert.equal(result.streamed,true);assert.equal(result.files[0].content,undefined);assert.ok(released);
});
test('native uploads over 100 MiB never send an entire project or file through the bridge',async()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
 const bytes=Buffer.alloc(1024*1024+1,243),sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 const content=bytes.toString('base64');
 const files=Array.from({length:101},(_,i)=>({path:`file-${i}.bin`,sha,content,isBase64:true,size:bytes.length,mode:'100644'}));
 let uploaded=0,committed=false,released=false,offset=0,hash=createHash('sha1');
 nativeGitBridge.addListener=async()=>({remove:async()=>{}});nativeGitBridge.prepareUpload=async value=>{assert.ok(Number(value.totalBytes)>100*1024*1024);};nativeGitBridge.release=async()=>{released=true;};
 nativeGitBridge.appendChunk=async value=>{const part=Buffer.from(String(value.content),'base64');assert.ok(part.length<=NATIVE_CHUNK_BYTES);assert.equal(value.offset,offset);if(offset===0)hash=createHash('sha1').update(`blob ${bytes.length}\0`);hash.update(part);offset+=part.length;if(value.done){assert.equal(hash.digest('hex'),sha);uploaded+=offset;offset=0;}};
 nativeGitBridge.transfer=async value=>{assert.ok((value.files as any[]).every(file=>!('content' in file)));committed=true;return {verified:true};};
 await nativeGitTransfer('push',{owner:'me',repo:'repo',expectedRepoId:1,branch:'dev',files},'test-token',new AbortController().signal);
 assert.equal(uploaded,files.length*bytes.length);assert.ok(committed&&released);
});
test('corrupt native chunks fail before accepting a file and still release staging',async()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
 let released=false;nativeGitBridge.addListener=async()=>({remove:async()=>{}});nativeGitBridge.release=async()=>{released=true;};
 nativeGitBridge.transfer=async()=>({chunked:true,files:[{path:'a',sha:'a'.repeat(40),mode:'100644',size:4,encoding:'base64'}]});
 nativeGitBridge.readChunk=async()=>({offset:1,bytes:4,done:true,content:'dGVzdA=='});
 await assert.rejects(nativeGitTransfer('fetch',{owner:'a',repo:'b',expectedRepoId:1},'',new AbortController().signal,{onFile:async()=>{assert.fail('Corrupt chunks must not be accepted');}}),/分块校验失败/);assert.ok(released);
});
test('native Git cancellation returns immediately, tells the plugin to stop, and removes progress listeners',async()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
 let started=false,id='',cancelled='',removed=false,finish!:(value:unknown)=>void;
 nativeGitBridge.addListener=async()=>({remove:async()=>{removed=true;}});nativeGitBridge.transfer=options=>{started=true;id=String(options.id);assert.equal(options.token,'temporary-token');return new Promise(resolve=>{finish=resolve;});};nativeGitBridge.cancel=async options=>{cancelled=options.id;};
 const controller=new AbortController(),pending=nativeGitTransfer('fetch',{owner:'source',repo:'repo',expectedRepoId:1,ref:'a'.repeat(40)},'temporary-token',controller.signal);
 while(!started)await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,id);assert.equal(removed,true);assert.ok(!JSON.stringify({...localStorage}).includes('temporary-token'));finish({});
});
