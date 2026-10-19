import './dom';
import {test,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifiedBlobSha} from '../src/utils/verifiedFiles';
import {planFileChanges} from '../src/utils/transferPlan';
import {folderTask,folderBridge,folderFiles} from '../src/utils/nativeFolder';
import {runProjectBatch} from '../src/utils/batchOperations';
import {appDialog} from '../src/utils/appDialog';
import {localCache} from '../src/utils/localCache';
import {beginGithubOperation,cancelGithubOperation,operationSignal} from '../src/utils/operation';
const hash=(text:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
afterEach(()=>{mock.restoreAll();localStorage.clear();beginGithubOperation();});
test('content validation is reused until bytes or encoding change; a supplied SHA never grants trust',async()=>{
 const digest=crypto.subtle.digest.bind(crypto.subtle);let count=0;
 mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{count++;return digest(...args);});
 const file={path:'a',content:'first',isBase64:false,sha:hash('first'),size:5};
 await verifiedBlobSha(file);await verifiedBlobSha(file);assert.equal(count,1);
 file.content='other';await assert.rejects(verifiedBlobSha(file),/版本不一致/);assert.equal(count,2);
 file.sha=hash('other');await verifiedBlobSha(file);assert.equal(count,2);
 file.isBase64=true;file.content=Buffer.from('other').toString('base64');await verifiedBlobSha(file);assert.equal(count,3);
 file.size=4;await assert.rejects(verifiedBlobSha(file),/大小/);
 await assert.rejects(verifiedBlobSha({...file,nativeRef:{version:'v',path:'a'}}),/当前内容/);
});
test('the pinned delta includes deletions and mode changes, and never counts tree entries as source files',()=>{
 const old=[{path:'same',sha:'a'},{path:'mode',sha:'b',mode:'100644'},{path:'changed',sha:'c'},{path:'gone',sha:'d'},{path:'dir',type:'tree',sha:'tree'}];
 const next=[{path:'same',sha:'a'},{path:'mode',sha:'b',mode:'100755'},{path:'changed',sha:'new'},{path:'new',sha:'e'}];
 assert.deepEqual(planFileChanges(old,next),{added:['new'],modified:['mode','changed'],removed:['gone'],unchanged:['same']});
});
test('native folder cancellation reaches the worker immediately and waits for actual stop acknowledgement',async()=>{
 const controller=new AbortController();let started=false,finish!:(value:any)=>void,cancelled='',id='',settled=false,removed=false;
 mock.method(folderBridge,'listen',async (callback:any)=>{return{remove:async()=>{removed=true;}};});
 mock.method(folderBridge,'cancel',async (value:any)=>{cancelled=value.taskId;});
 const pending=folderTask(value=>{started=true;id=value.taskId;return new Promise(resolve=>{finish=resolve;});},{version:'v'},controller.signal,true);
 void pending.then(()=>{settled=true;},()=>{settled=true;});
 while(!started)await new Promise(resolve=>setImmediate(resolve));controller.abort();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cancelled,id);assert.equal(settled,false);finish({files:[]});await assert.rejects(pending,{name:'AbortError'});assert.equal(removed,true);
});
test('an aborted native scan never publishes folder references or starts the next batch project',async()=>{
 const controller=new AbortController();const calls:string[]=[];
 mock.method(folderBridge,'listen',async()=>({remove:async()=>{}}));mock.method(folderBridge,'cancel',async()=>{});
 mock.method(folderBridge,'list',async()=>{controller.abort();return{files:[],id:'v',dirty:false};});
 const result=await runProjectBatch(['a','b'].map(id=>({id,label:id,name:id,status:'pending' as const})),{signal:controller.signal,onChange:()=>{},run:async item=>{calls.push(item.id);await folderFiles('v',true,controller.signal);return{message:'must not publish'};}});
 assert.deepEqual(calls,['a']);assert.deepEqual(result.map(item=>item.status),['cancelled','cancelled']);
});
test('native progress reaches the active batch row without overwriting completed entries',async()=>{
 const events:any[]=[];const result=await runProjectBatch([{id:'done',label:'done',name:'done',status:'success'},{id:'next',label:'next',name:'next',status:'pending'}],{signal:new AbortController().signal,onChange:queue=>events.push(queue),run:async()=>{window.dispatchEvent(new CustomEvent('gitvault-progress',{detail:'正在校验 17/100'}));return{message:'verified'};}});
 assert.ok(events.some(queue=>queue[1].message.includes('正在校验 17/100')));assert.ok(events.every(queue=>queue[0].status==='success'));assert.equal(result[1].message,'verified');
});
test('unchanged IndexedDB bodies are shared rather than rewritten for every new snapshot',async()=>{
 const first=crypto.randomUUID(),files=[{path:'a',content:'shared-'+first,isBase64:false}];
 await localCache.saveProjectFiles(first,files,'one');
 const put=IDBObjectStore.prototype.put;let writes=0;
 mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,...args:Parameters<typeof put>){if(this.name==='file_contents')writes++;return put.apply(this,args);});
 await localCache.saveProjectFiles(first,files,'two');assert.equal(writes,0);
 await localCache.saveProjectFiles(first,[...files,{path:'b',content:'new-'+first,isBase64:false}],'three');assert.equal(writes,1);
 assert.equal((await localCache.getProjectFiles(first,'one')).length,1);assert.equal((await localCache.getProjectFiles(first,'three')).length,2);
});
test('cancelling during body preparation preserves the old current snapshot',async()=>{
 const id=crypto.randomUUID();await localCache.saveProjectFiles(id,[{path:'old',content:'old',isBase64:false}],'old');
 const controller=new AbortController();controller.abort();
 await assert.rejects(localCache.saveProjectFiles(id,[{path:'new',content:'new',isBase64:false}],'new',{signal:controller.signal}),{name:'AbortError'});
 assert.deepEqual((await localCache.getProjectFiles(id)).map(file=>file.path),['old']);
});
test('cancel is idempotent, publishes waiting state, and a fresh operation gets a new signal',()=>{
 beginGithubOperation();const signal=operationSignal();let events=0;
 const listener=()=>events++;window.addEventListener('gitvault-operation',listener);
 try{cancelGithubOperation();cancelGithubOperation();assert.equal(signal.aborted,true);assert.equal(events,1);beginGithubOperation();assert.notEqual(operationSignal(),signal);assert.equal(operationSignal().aborted,false);}finally{window.removeEventListener('gitvault-operation',listener);}
});

test('task cancellation removes only its own confirmation and leaves unrelated queued dialogs intact',async()=>{
 const first=appDialog.confirm('unrelated');const controller=new AbortController();
 const pending=appDialog.confirm('task conflict',{signal:controller.signal});controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(appDialog.snapshot().active?.message,'unrelated');
 appDialog.answer(true);assert.equal(await first,true);assert.equal(appDialog.snapshot().active,null);
});

test('immutable task reads are reused while repository identity and mutable heads remain live',async()=>{
 const {githubApi,githubClient}=await import('../src/utils/githubClient');
 const {immediateTransport}=await import('./transportFixture');immediateTransport();beginGithubOperation();
 const calls:string[]=[];const commit='a'.repeat(40),tree='b'.repeat(40);
 mock.method(globalThis,'fetch',async(input:any)=>{const path=new URL(String(input)).pathname;calls.push(path);return new Response(JSON.stringify(path.endsWith('/user')?{login:'me'}:path.endsWith('/repos/source/project')?{id:42}:path.includes('/commits/')?{sha:commit,commit:{tree:{sha:tree},author:{}}}:{tree:[]}));});
 await githubClient.checkUpdate('source','project','main','old','token');
 const first=await githubApi(`/repos/source/project/commits/${commit}`,'token');first.commit.tree.sha='tampered';
 assert.equal((await githubApi(`/repos/source/project/commits/${commit}`,'token')).commit.tree.sha,tree);
 await githubClient.checkUpdate('source','project','main','old','token');
 await githubClient.repository('source','project','token',42);await githubClient.repository('source','project','token',42);
 await githubApi('/user','token');await githubApi('/user','token');await githubApi('/user','another-token');
 assert.equal(calls.filter(path=>path.endsWith('/commits/main')).length,2);assert.equal(calls.filter(path=>path.endsWith('/commits/'+commit)).length,0);
 assert.equal(calls.filter(path=>path.endsWith('/repos/source/project')).length,2);assert.equal(calls.filter(path=>path==='/user').length,2);
 beginGithubOperation();await githubApi('/user','token');assert.equal(calls.filter(path=>path==='/user').length,3);
});
