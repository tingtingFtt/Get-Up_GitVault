import './dom';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRecordStore, prepareRecords, recordsJSON, PROJECT_RECORD_DB } from '../src/utils/projectRecordStore';
import { initializeCredentials, readProjectRecords, writeProjectRecords, flushCredentials, retryCredentialWrites, hasUnflushedCredentials, readProjectRecoveryBackup } from '../src/utils/credentialStorage';
import { Capacitor } from '@capacitor/core';
import { nativeBridge } from '../src/utils/nativePlatform';
const platform = { isNativePlatform: Capacitor.isNativePlatform, getPlatform: Capacitor.getPlatform, isPluginAvailable: Capacitor.isPluginAvailable };
const native = { ...nativeBridge };
const small = (id = 'project', extra = {}) => ({ id, owner: 'source', repo: 'project', branch: 'main', tree: [{path:'a.txt',sha:'a'}], backups: [], ...extra });
const list = (value: unknown) => JSON.stringify(value);
async function removeDatabase() {
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(PROJECT_RECORD_DB); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('test connection leaked')); });
}
beforeEach(async () => {
  await flushCredentials().catch(() => {}); mock.restoreAll();
  Capacitor.isNativePlatform = () => false;
  localStorage.clear(); await removeDatabase();
});
afterEach(async () => { await flushCredentials().catch(() => {}); mock.restoreAll(); Object.assign(Capacitor, platform); Object.assign(nativeBridge, native); });

test('legacy v8 migrates with fixed destinations, branch mappings, receipts and every historical manifest intact', async () => {
  const target = { id:77, owner:'me', repo:'fixed', branch:'release', token:'target-secret' };
  const project = small('project', { token:'source-secret', uploadTarget:target, branchTargets:{main:target,dev:{...target,branch:'dev'}}, backups:[{id:'old',tree:[{path:'old.txt',sha:'old'}],remoteSnapshot:{repoId:77,branch:'dev',commitSha:'history'}}], remoteSnapshot:{repoId:77,branch:'release',commitSha:'latest'}, detachedTargets:[{id:12,owner:'me',repo:'old'}] });
  localStorage.setItem('gitvault_repos_v8', list([project]));
  localStorage.setItem('gitvault_repos_v7', list([small('obsolete')]));
  await initializeCredentials();
  assert.equal(localStorage.getItem('gitvault_repos_v8'), null);
  assert.equal(localStorage.getItem('gitvault_repos_v7'), null);
  assert.deepEqual(readProjectRecords(), [project]);
  await initializeCredentials();
  assert.deepEqual(readProjectRecords(), [project]);
  const restored = await createProjectRecordStore().initialize({});
  assert.deepEqual(restored.projects, [project]);
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request=indexedDB.open(PROJECT_RECORD_DB); request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error); });
  const backups = await new Promise<any[]>((resolve, reject) => { const transaction=db.transaction('migration');const request=transaction.objectStore('migration').getAll();transaction.oncomplete=()=>resolve(request.result);transaction.onabort=()=>reject(transaction.error); });
  db.close();
  assert.equal(backups.find(backup=>backup.key==='gitvault_repos_v8').json,list([project]));
});

test('v7-only records migrate, but an authoritative empty database never resurrects old projects', async () => {
  localStorage.setItem('gitvault_repos_v7',list([small()])); await initializeCredentials();
  assert.equal(readProjectRecords().length,1);
  writeProjectRecords([]); await flushCredentials();
  localStorage.setItem('gitvault_repos_v8',list([small('stale-tab')]));
  await initializeCredentials();
  assert.deepEqual(readProjectRecords(),[]);
});

test('records larger than 5 MiB save and reload while localStorage rejects every project write', async () => {
  await initializeCredentials();
  const original = Object.getPrototypeOf(localStorage).setItem;
  mock.method(Object.getPrototypeOf(localStorage),'setItem',function(this:Storage,key:string,value:string) {
    if (key.startsWith('gitvault_repos')) throw new DOMException('quota','QuotaExceededError');
    return original.call(this,key,value);
  });
  const tree = Array.from({length:18000},(_,i)=>({path:`资源/${i}/`+'long-file-name-'.repeat(8)+'.jpg',sha:'a'.repeat(40),size:1234,mode:'100644',type:'blob'}));
  const project = small('large',{tree,backups:[{id:'old',tree}],uploadTarget:{id:77,owner:'me',repo:'fixed',branch:'main'}});
  assert.ok(list([project]).length>5*1024*1024);
  writeProjectRecords([project]); await flushCredentials(); await initializeCredentials();
  assert.deepEqual(readProjectRecords(),[project]);
  assert.equal(localStorage.getItem('gitvault_repos_v8'),null);
});

test('failed migration keeps the old local record and can be retried after an atomic transaction abort', async () => {
  const legacy=list([small()]);localStorage.setItem('gitvault_repos_v8',legacy);
  const failing=mock.method(IDBObjectStore.prototype,'put',function(){throw new DOMException('disk full','QuotaExceededError');});
  await assert.rejects(initializeCredentials,/disk full/);
  assert.equal(localStorage.getItem('gitvault_repos_v8'),legacy);
  failing.mock.restore(); await initializeCredentials();
  assert.deepEqual(readProjectRecords(),[small()]);
});

test('quota failure preserves the previous committed target and blocks cleanup until retry persists the current record', async () => {
  await initializeCredentials(); const previous=small();writeProjectRecords([previous]);await flushCredentials();
  const updated=small('project',{uploadTarget:{id:77,owner:'me',repo:'fixed',branch:'dev'},remoteSnapshot:{commitSha:'uploaded'}});
  const failing=mock.method(IDBObjectStore.prototype,'put',function(){throw new DOMException('disk full','QuotaExceededError');});
  writeProjectRecords([updated]);
  let cleared=false;await assert.rejects(async()=>{await flushCredentials();cleared=true;},/项目记录保存未完成/);
  assert.equal(cleared,false);assert.equal(hasUnflushedCredentials(),true);
  assert.deepEqual(readProjectRecords(),[updated]); // available for export, despite persistence failing
  const reopened=await createProjectRecordStore().initialize({});assert.deepEqual(reopened.projects,[previous]);
  failing.mock.restore();await retryCredentialWrites();assert.equal(hasUnflushedCredentials(),false);
  await initializeCredentials();assert.deepEqual(readProjectRecords(),[updated]);
});

test('changing one project writes no unchanged project rows; deletion and list order commit together', async () => {
  const store=createProjectRecordStore();await store.initialize({});
  const a=small('a'),b=small('b');await store.save(prepareRecords([a,b]));
  const puts:string[]=[];const original=IDBObjectStore.prototype.put;
  mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,value:any,key?:IDBValidKey){if(this.name==='projects')puts.push(value.id);return original.call(this,value,key!);});
  const next={...b,remark:'changed'};await store.save(prepareRecords([next,a]));assert.deepEqual(puts,['b']);
  puts.length=0;await store.save(prepareRecords([next]));assert.deepEqual(puts,[]);
  assert.deepEqual((await createProjectRecordStore().initialize({})).projects,[next]);
});

test('another tab cannot overwrite a newer revision with stale local records', async () => {
  const first=createProjectRecordStore();await first.initialize({});
  const second=createProjectRecordStore();await second.initialize({});
  await first.save(prepareRecords([small('newer')]));
  await assert.rejects(()=>second.save(prepareRecords([small('stale')])),/其他页面已修改/);
  assert.deepEqual((await createProjectRecordStore().initialize({})).projects,[small('newer')]);
});

test('corrupt and duplicate legacy rows stop migration instead of replacing data with an empty account', async () => {
  for (const raw of ['not-json','{}',list([small(),small()])]) {
    await removeDatabase();localStorage.setItem('gitvault_repos_v8',raw);
    await assert.rejects(initializeCredentials);
    assert.equal(localStorage.getItem('gitvault_repos_v8'),raw);
  }
});

test('queued writes retain the latest snapshot even when another edit arrives at commit completion', async () => {
  await initializeCredentials();
  const failing=mock.method(IDBObjectStore.prototype,'put',function(){throw new DOMException('disk full','QuotaExceededError');});
  writeProjectRecords([small('first')]);await assert.rejects(flushCredentials);failing.mock.restore();
  let edited=false;
  const later=()=>{if(!edited){edited=true;writeProjectRecords([small('latest')]);}};
  window.addEventListener('gitvault-storage-saved',later);
  try {await retryCredentialWrites();}finally{window.removeEventListener('gitvault-storage-saved',later);}
  assert.equal(hasUnflushedCredentials(),false);
  assert.deepEqual((await createProjectRecordStore().initialize({})).projects,[small('latest')]);
});

test('Android imports large encrypted records without a WebView mirror and retains nested credentials on reload', async () => {
  Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
  const project=small('large',{description:'x'.repeat(6*1024*1024),uploadTarget:{id:77,token:'private-token'}});
  let vault=list({gitvault_repos_v8:list([project]),gitvault_global_token:'secret'});
  nativeBridge.readVault=async()=>({value:vault});nativeBridge.writeVault=async({value})=>{vault=value;};
  const original=Object.getPrototypeOf(localStorage).setItem;
  mock.method(Object.getPrototypeOf(localStorage),'setItem',function(this:Storage,key:string,value:string){if(key.startsWith('gitvault_repos'))throw new DOMException('quota','QuotaExceededError');return original.call(this,key,value);});
  await initializeCredentials();assert.deepEqual(readProjectRecords(),[project]);
  const next={...project,remark:'edited'};writeProjectRecords([next]);await flushCredentials();
  await initializeCredentials();assert.deepEqual(readProjectRecords(),[next]);
  assert.equal(localStorage.getItem('gitvault_repos_v8'),null);assert.equal(localStorage.getItem('gitvault_global_token'),null);
  assert.ok(recordsJSON(prepareRecords(readProjectRecords())).includes('private-token'));
});

test('failed startup migration exposes a complete backup without nested credentials',async()=>{
 const original=[small('first',{token:'source-secret',uploadTarget:{id:77,token:'target-secret'},backups:[{tree:[{path:'original.txt',sha:'exact'}]}]})];
 localStorage.setItem('gitvault_repos_v8',list(original));
 mock.method(IDBObjectStore.prototype,'put',function(){throw new DOMException('disk full','QuotaExceededError');});
 await assert.rejects(initializeCredentials);
 const raw=readProjectRecoveryBackup()!;assert.ok(raw);const backup=JSON.parse(raw);
 assert.equal(backup.projects[0].id,'first');assert.equal(backup.projects[0].backups[0].tree[0].sha,'exact');assert.equal(backup.projects[0].uploadTarget.id,77);
 assert.ok(!raw.includes('source-secret')&&!raw.includes('target-secret'));assert.equal(localStorage.getItem('gitvault_repos_v8'),list(original));
});
test('failed native encryption migration exposes the original project metadata for recovery',async()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
 const original=[small('native',{token:'secret',forkTarget:{id:77,token:'fork-secret'}})];
 nativeBridge.readVault=async()=>({value:list({gitvault_repos_v8:list(original)})});nativeBridge.writeVault=async()=>{throw new Error('disk full');};
 await assert.rejects(initializeCredentials,/disk full/);const raw=readProjectRecoveryBackup()!;
 assert.equal(JSON.parse(raw).projects[0].forkTarget.id,77);assert.ok(!raw.includes('secret'));
});
