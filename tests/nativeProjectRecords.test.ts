import './dom';
import {test,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {Capacitor} from '@capacitor/core';
import {nativeBridge} from '../src/utils/nativePlatform';
import {nativeRecordsBridge,createNativeProjectRecords} from '../src/utils/nativeProjectRecords';
import {prepareRecords} from '../src/utils/projectRecordStore';
import {initializeCredentials,readProjectRecords,writeProjectRecords,flushCredentials} from '../src/utils/credentialStorage';
const originals={...nativeRecordsBridge},vaultOriginal={...nativeBridge},platform={isNativePlatform:Capacitor.isNativePlatform,getPlatform:Capacitor.getPlatform};
let revision:number,order:string[],rows:Map<string,string>,commits:any[],vault:string,writes:number,fail:boolean;
const project=(id:string,extra={})=>({id,tree:[],backups:[],...extra});
beforeEach(async()=>{
 await flushCredentials().catch(()=>{});localStorage.clear();revision=0;order=[];rows=new Map();commits=[];writes=0;fail=false;vault='{}';
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';
 nativeBridge.readVault=async()=>({value:vault,recordStorage:1});nativeBridge.writeVault=async({value})=>{if(fail)throw new Error('vault full');vault=value;writes++;};
 let staging:any[]=[];
 nativeRecordsBridge.begin=async()=>{staging=[];return {id:'migration'};};nativeRecordsBridge.stage=async({rows})=>{assert.ok(rows.length<=32);staging.push(...rows);};nativeRecordsBridge.finish=async({order})=>nativeRecordsBridge.commit({revision:0,order,rows:staging,removed:[]});
 nativeRecordsBridge.index=async()=>({revision,order:[...order]});nativeRecordsBridge.archive=async()=>{};
 nativeRecordsBridge.read=async request=>{if(request.revision!==revision)throw new Error('revision changed');const ids=order.slice(request.offset,request.offset+8);return {revision,next:request.offset+ids.length,rows:ids.map(id=>({id,json:rows.get(id)!}))};};
 nativeRecordsBridge.commit=async request=>{if(request.revision!==revision)throw new Error('stale revision');commits.push(structuredClone(request));for(const row of request.rows)rows.set(row.id,row.json);for(const id of request.removed)rows.delete(id);order=[...request.order];return {revision:++revision};};
});
afterEach(async()=>{await flushCredentials().catch(()=>{});Object.assign(nativeRecordsBridge,originals);Object.assign(nativeBridge,vaultOriginal);Object.assign(Capacitor,platform);mock.restoreAll();});
test('verified migration retains fixed branches, history and credentials; subsequent starts perform zero writes',async()=>{
 const projects=Array.from({length:20},(_,i)=>project('p'+i,{uploadTarget:{id:77,branch:'dev',token:'private-token'},backups:[{tree:[{path:'old',sha:'exact'}]}]}));
 vault=JSON.stringify({gitvault_global_token:'secret',gitvault_repos_v8:JSON.stringify(projects)});await initializeCredentials();
 assert.deepEqual(readProjectRecords(),projects);assert.equal(commits.length,1);assert.equal(writes,1);assert.ok(!vault.includes('gitvault_repos'));assert.equal(JSON.parse(rows.get('p0')!).uploadTarget.token,'private-token');
 await initializeCredentials();assert.equal(commits.length,1);assert.equal(writes,1);assert.deepEqual(readProjectRecords(),projects);
});
test('editing one project sends one encrypted row and does not rewrite unchanged history or credential vault',async()=>{
 vault=JSON.stringify({gitvault_repos_v8:JSON.stringify([project('first',{retained:'x'.repeat(6*1024*1024)}),project('second')])});await initializeCredentials();commits=[];writes=0;
 const all=readProjectRecords();const updated={...all[1],remark:'edited'};writeProjectRecords([all[0],updated]);await flushCredentials();
 assert.equal(commits.length,1);assert.deepEqual(commits[0].rows.map((row:any)=>row.id),['second']);assert.equal(writes,0);
 await initializeCredentials();assert.equal((readProjectRecords()[1] as any).remark,'edited');assert.equal(commits.length,1);
});
test('an authoritative empty native index never resurrects legacy mirrors',async()=>{
 await initializeCredentials();localStorage.setItem('gitvault_repos_v8',JSON.stringify([project('stale')]));await initializeCredentials();assert.deepEqual(readProjectRecords(),[]);assert.equal(localStorage.getItem('gitvault_repos_v8'),null);
});
test('a failed migration leaves the encrypted original untouched and retry uses the already committed rows',async()=>{
 const legacy=JSON.stringify({gitvault_repos_v8:JSON.stringify([project('old',{token:'secret'})])});vault=legacy;fail=true;
 await assert.rejects(initializeCredentials,/vault full/);assert.equal(vault,legacy);assert.equal(commits.length,1);
 fail=false;await initializeCredentials();assert.equal(commits.length,1);assert.deepEqual(readProjectRecords(),[project('old',{token:'secret'})]);
});
test('mixed revision pages and mismatched identities are rejected instead of silently importing incomplete projects',async()=>{
 revision=1;order=['p'];rows.set('p',JSON.stringify(project('p')));const store=createNativeProjectRecords();
 nativeRecordsBridge.read=async()=>({revision:2,next:1,rows:[{id:'p',json:rows.get('p')!}]});await assert.rejects(store.load(),/记录已变化/);
 nativeRecordsBridge.read=async()=>({revision:1,next:1,rows:[{id:'p',json:JSON.stringify(project('other'))}]});await assert.rejects(store.load(),/身份不一致/);
});
test('a concurrent record revision prevents a later overwrite or source cleanup acknowledgement',async()=>{
 const store=createNativeProjectRecords();await store.initialize(()=>[project('p')]);revision++;
 await assert.rejects(store.save(prepareRecords([project('p',{remark:'stale'})])),/stale revision/);assert.equal(JSON.parse(rows.get('p')!).remark,undefined);
});
test('a failing native index read never offers a fabricated empty project recovery backup',async()=>{
 nativeRecordsBridge.index=async()=>{throw new Error('encrypted index unavailable');};
 await assert.rejects(initializeCredentials,/index unavailable/);const {readProjectRecoveryBackup}=await import('../src/utils/credentialStorage');assert.equal(readProjectRecoveryBackup(),undefined);
});
test('migration sends bounded batches instead of one complete account payload',async()=>{
 const many=Array.from({length:101},(_,i)=>project('p'+i,{metadata:'x'.repeat(16000)}));vault=JSON.stringify({gitvault_repos_v8:JSON.stringify(many)});const calls:any[]=[];const stage=nativeRecordsBridge.stage;nativeRecordsBridge.stage=async value=>{calls.push(value);return stage(value);};await initializeCredentials();assert.ok(calls.length>4);assert.ok(calls.every(call=>call.rows.length<=32&&call.rows.reduce((sum:number,row:any)=>sum+row.json.length*2,0)<=512*1024));assert.equal(readProjectRecords().length,101);
});
