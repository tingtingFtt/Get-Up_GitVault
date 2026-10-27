import './dom';
import {test,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Capacitor} from '@capacitor/core';
import {folderBridge,hydrateFile,saveFolderArchive,finishFolder} from '../src/utils/nativeFolder';
import {exportProjectDirectory} from '../src/utils/nativePlatform';
import {nativeGitBridge,nativeGitTransfer} from '../src/utils/nativeGit';
import {nativeGitCacheBridge} from '../src/utils/nativeGitCache';
import {appDialog} from '../src/utils/appDialog';
import {localCache,type CachedFile} from '../src/utils/localCache';
import {githubClient,beginGithubOperation} from '../src/utils/githubClient';
import {immediateTransport} from './transportFixture';
const sha=(bytes:Buffer)=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const originalFetch=globalThis.fetch;
let documents:Map<string,Buffer>,entries:CachedFile[],attached:boolean;
const enable=()=>{mock.method(Capacitor,'isNativePlatform',()=>true);mock.method(Capacitor,'getPlatform',()=> 'android');mock.method(Capacitor,'isPluginAvailable',()=>true);localStorage.setItem('gitvault_apk_download_dir','content://test/tree/root');};
const nativeFile=(file:CachedFile)=>({...file,content:'',isBase64:true,nativeRef:{version:'version',path:file.path}});
const db=()=>new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open('GitVault_Storage_v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
async function readStore(name:string){const value=await db();try{return await new Promise<any[]>((resolve,reject)=>{const req=value.transaction(name).objectStore(name).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}finally{value.close();}}
beforeEach(async()=>{
 mock.method(nativeGitCacheBridge,'clear',async()=>({bytes:0}));
 localStorage.clear();documents=new Map();entries=[];attached=false;
 await new Promise<void>((resolve,reject)=>{const req=indexedDB.deleteDatabase('GitVault_Storage_v1');req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);});
 mock.method(folderBridge,'begin',async(value:any)=>{entries=value.files;return{id:'version',files:[]};});
 mock.method(folderBridge,'put',async(value:any)=>{const old=value.offset?documents.get(value.path)||Buffer.alloc(0):Buffer.alloc(0);assert.equal(old.length,value.offset);documents.set(value.path,Buffer.concat([old,Buffer.from(value.data,'base64')]));if(value.done)assert.equal(sha(documents.get(value.path)!),value.sha);});
 mock.method(folderBridge,'finish',async()=>({}));mock.method(folderBridge,'attach',async()=>{attached=true;return{retained:[]};});
 mock.method(folderBridge,'list',async()=>({files:entries.map(nativeFile),dirty:false,location:'managed/files'}));
 mock.method(folderBridge,'read',async(value:any)=>{const data=documents.get(value.path)!.subarray(value.offset,value.offset+384*1024);return{data:data.toString('base64'),bytes:data.length,done:data.length<384*1024};});
 mock.method(folderBridge,'file',async(value:any)=>nativeFile({...entries.find(file=>file.path===value.path)!,sha:sha(documents.get(value.path)!),size:documents.get(value.path)!.length}));
});
afterEach(()=>{mock.restoreAll();localStorage.clear();globalThis.fetch=originalFetch;});
test('migration publishes folder references only after every file verifies, then removes shared internal bodies',async()=>{
 const files=[{path:'unicode.txt',content:'\ufeff中文\n',isBase64:false},{path:'binary.bin',content:Buffer.alloc(900000,255).toString('base64'),isBase64:true}];
 await localCache.saveProjectFiles('project',files,'old');enable();
 await localCache.migrateProject('project','old',JSON.stringify([77,'dev']),'project');
 assert.ok(attached);assert.equal((await readStore('file_contents')).length,0);
 const stored=(await readStore('snapshots'))[0];assert.equal(stored.nativeVersion,'version');assert.ok(stored.files.every((file:any)=>file.content===undefined&&file.nativeRef));
 const handles=await localCache.getProjectFiles('project');assert.equal(handles.nativeSnapshot?.version,'version');assert.ok(handles.every(file=>file.content===''));
 const preview=await localCache.getProjectFile('project','unicode.txt');assert.equal(preview?.content,'\ufeff中文\n');assert.equal(preview?.isBase64,false);
 await assert.rejects(hydrateFile(handles[1],1024),/预览范围/);
});
test('interrupted migration leaves the original IndexedDB bodies and current snapshot intact',async()=>{
 const files=[{path:'a',content:'one',isBase64:false},{path:'b',content:'two',isBase64:false}];await localCache.saveProjectFiles('project',files,'old');enable();
 const put=folderBridge.put;mock.method(folderBridge,'put',async(value:any)=>{if(value.path==='b')throw new Error('空间不足');return put(value);});
 await assert.rejects(localCache.migrateProject('project','old','[77,"main"]','project'),/空间不足/);
 assert.equal(attached,false);assert.equal((await readStore('file_contents')).length,2);assert.equal((await readStore('snapshots'))[0].nativeVersion,undefined);assert.equal((await localCache.getProjectFiles('project','old'))[0].content,'one');
});
test('folder clear failures keep cache references; manual deletion explicitly requests confirmation while auto purge never forces',async()=>{
 enable();const bytes=Buffer.from('one');entries=[{path:'a',sha:sha(bytes),size:bytes.length,mode:'100644',content:'',isBase64:true}];documents.set('a',bytes);
 await localCache.saveProjectFiles('project',entries.map(nativeFile),'old');
 mock.method(folderBridge,'clear',async(value:any)=>{assert.equal(value.force,false);throw Object.assign(new Error('本地新增文件'),{code:'LOCAL_CHANGES'});});
 await assert.rejects(localCache.deleteProjectFiles('project','old'),/本地新增/);assert.equal((await readStore('snapshots')).length,1);assert.equal((await localCache.getProjectFiles('project','old')).length,1);
});
test('directory scans retain new files, deletions and a legitimately empty local version',async()=>{
 enable();entries=[{path:'a',sha:sha(Buffer.from('a')),size:1,mode:'100644',content:'',isBase64:true}];await localCache.saveProjectFiles('project',entries.map(nativeFile),'old');
 mock.method(folderBridge,'list',async()=>({files:[{...nativeFile(entries[0]),path:'new',nativeRef:{version:'version',path:'new',added:true,dirty:true}}],dirty:true}));
 const changed=await localCache.getProjectFiles('project','old');assert.deepEqual(changed.map(file=>file.path),['new']);assert.equal(changed.nativeSnapshot?.dirty,true);
 mock.method(folderBridge,'list',async()=>({files:[],dirty:true}));const empty=await localCache.getProjectFiles('project','old');assert.equal(empty.length,0);assert.equal(empty.nativeSnapshot?.dirty,true);
});
test('native folder fetch and push move metadata through the bridge, never file bodies',async()=>{
 enable();const file=nativeFile({path:'huge.bin',content:'',isBase64:true,sha:'a'.repeat(40),size:512*1024*1024,mode:'100644'});
 mock.method(nativeGitBridge,'addListener',async()=>({remove:async()=>{}}));mock.method(nativeGitBridge,'release',async()=>{});mock.method(nativeGitBridge,'prepareUpload',async()=>{});
 mock.method(nativeGitBridge,'readChunk',async()=>{assert.fail('No body should cross the bridge');});mock.method(nativeGitBridge,'appendChunk',async()=>{assert.fail('Document streams must stay native');});
 let streamed=0;mock.method(nativeGitBridge,'appendDocuments',async(value:any)=>{assert.equal(value.files.length,1);assert.equal(value.files[0].size,file.size);assert.deepEqual(value.files[0].nativeRef,file.nativeRef);streamed++;});
 mock.method(nativeGitBridge,'transfer',async(value:any)=>value.action==='fetch'?{folder:true,chunked:true,files:[file]}:{verified:true});
 let accepted=0;await nativeGitTransfer('fetch',{owner:'a',repo:'b',expectedRepoId:1,folderVersion:'version'},'',new AbortController().signal,{onFile:async value=>{assert.deepEqual(value.nativeRef,file.nativeRef);accepted++;}});
 await nativeGitTransfer('push',{owner:'a',repo:'b',expectedRepoId:1,files:[file]},'',new AbortController().signal);assert.equal(accepted,1);assert.equal(streamed,1);
});
test('GitHub native folder imports publish verified references and never create IndexedDB body checkpoints',async()=>{
 enable();immediateTransport();beginGithubOperation();const data=Buffer.from('hello');const entry={path:'hello.txt',sha:sha(data),size:data.length,type:'blob',mode:'100644'},commit='a'.repeat(40),tree='b'.repeat(40);
 globalThis.fetch=async(url)=>{const path=String(url);const value=path.endsWith('/repos/a/b')?{id:77,default_branch:'dev'}:path.includes('/commits/')?{sha:commit,commit:{tree:{sha:tree},message:'source',author:{}}}:path.includes('/git/trees/')?{tree:[entry]}:assert.fail(path);return new Response(JSON.stringify(value));};
 mock.method(nativeGitBridge,'addListener',async()=>({remove:async()=>{}}));mock.method(nativeGitBridge,'release',async()=>{});
 mock.method(nativeGitBridge,'transfer',async(value:any)=>{assert.equal(value.folderVersion,'version');return{folder:true,chunked:true,streamed:true,commitSha:commit,treeSha:tree,files:[{...nativeFile({...entry,content:'',isBase64:true}),encoding:'base64'}]};});
 mock.method(nativeGitBridge,'readChunk',async()=>assert.fail('Body reads must remain native'));
 const result=await githubClient.fetchRepo('a/b');await localCache.saveProjectFiles('project',result.files,commit);assert.equal(result.branch,'dev');assert.equal(result.files.nativeSnapshot?.version,'version');assert.equal((await readStore('file_contents')).length,0);assert.equal((await readStore('download_parts')).length,0);
});

test('explicit directory exports use native streams without hydrating or transmitting project credentials',async()=>{
 enable();const file=nativeFile({path:'huge.bin',content:'',isBase64:true,sha:'a'.repeat(40),size:512*1024*1024,mode:'100755'});
 let exported=false;mock.method(folderBridge,'export',async(value:any)=>{assert.equal(value.files[0].size,file.size);assert.equal(value.files[0].content,undefined);assert.ok(value.prefix.startsWith('GitVault-exports/'));assert.equal(value.project.token,undefined);exported=true;});
 mock.method(folderBridge,'read',async()=>assert.fail('Export bytes must stay native'));
 await exportProjectDirectory('content://test/tree/root',{owner:'a',repo:'b',branch:'dev',latestCommitSha:'c'.repeat(40),token:'must-not-export'} as any,[file]);assert.ok(exported);
});
test('folder verification repairs only requested paths once and requires a second successful check',async()=>{
 let checks=0,repairs=0;mock.method(folderBridge,'finish',async()=>{if(++checks===1)throw Object.assign(new Error('missing a'),{code:'FOLDER_REPAIR',data:{version:'candidate',repairPaths:['a','b','a']}});return{state:'ready'};});
 const result=await finishFolder('candidate',async paths=>{repairs++;assert.deepEqual(paths,['a','b']);});assert.equal(result.state,'ready');assert.equal(checks,2);assert.equal(repairs,1);
 mock.method(folderBridge,'finish',async()=>{throw Object.assign(new Error('still modified'),{code:'FOLDER_REPAIR',data:{version:'candidate',repairPaths:['a']}});});repairs=0;await assert.rejects(finishFolder('candidate',async()=>{repairs++;}),/still modified/);assert.equal(repairs,1);
});
test('extra files, mismatched candidate IDs and cancellation never trigger unsafe repair or publication',async()=>{
 for(const problem of [{code:'FOLDER_STORAGE',data:{version:'candidate',repairPaths:['a']}},{code:'FOLDER_REPAIR',data:{version:'other',repairPaths:['a']}},{code:'FOLDER_REPAIR',data:{version:'candidate',repairPaths:[1]}}]){
  mock.method(folderBridge,'finish',async()=>{throw Object.assign(new Error('preserve extra files'),problem);});await assert.rejects(finishFolder('candidate',async()=>assert.fail('Unsafe repair')),/preserve extra/);
 }
 let checks=0;const controller=new AbortController();mock.method(folderBridge,'finish',async()=>{checks++;throw Object.assign(new Error('missing'),{code:'FOLDER_REPAIR',data:{version:'candidate',repairPaths:['a']}});});await assert.rejects(finishFolder('candidate',async()=>controller.abort(),controller.signal),{name:'AbortError'});assert.equal(checks,1);
});
test('REST directory imports refetch only damaged files and reject repair paths outside the pinned manifest',async()=>{
 enable();immediateTransport();beginGithubOperation();localStorage.setItem('gitvault_git_service_v1',JSON.stringify({mode:'rest',url:''}));
 const contents=new Map([['a',Buffer.from('first')],['b',Buffer.from('second')]]),manifest=[...contents].map(([path,bytes])=>({path,size:bytes.length,sha:sha(bytes),mode:'100644',type:'blob'}));let blobs:string[]=[],checks=0;
 globalThis.fetch=async input=>{const path=String(input);if(path.endsWith('/repos/source/project'))return new Response(JSON.stringify({id:77,default_branch:'main'}));if(path.includes('/commits/'))return new Response(JSON.stringify({sha:'pinned',commit:{tree:{sha:'tree'},author:{}}}));if(path.includes('/git/trees/'))return new Response(JSON.stringify({tree:manifest}));const entry=manifest.find(entry=>path.endsWith('/git/blobs/'+entry.sha));assert.ok(entry,path);blobs.push(entry.path);return new Response(JSON.stringify({content:contents.get(entry.path)!.toString('base64')}));};
 mock.method(folderBridge,'finish',async()=>{if(++checks===1)throw Object.assign(new Error('missing a'),{code:'FOLDER_REPAIR',data:{version:'version',repairPaths:['a']}});return{};});
 const result=await githubClient.fetchRepo('source/project');assert.equal(result.files.length,2);assert.deepEqual(blobs.sort(),['a','a','b']);assert.equal(checks,2);
 blobs=[];checks=0;mock.method(folderBridge,'finish',async()=>{throw Object.assign(new Error('bad request'),{code:'FOLDER_REPAIR',data:{version:'version',repairPaths:['../outside']}});});
 await assert.rejects(githubClient.fetchRepo('source/project'),/快照外路径/);assert.equal(blobs.length,2);
});
test('verified ready directory references win over older cached handles and still receive final verification',async()=>{
 enable();immediateTransport();beginGithubOperation();const bytes=Buffer.from('verified'),entry={path:'a',sha:sha(bytes),mode:'100644',size:bytes.length,type:'blob'};let checks=0;
 globalThis.fetch=async input=>{const path=String(input);if(path.endsWith('/repos/source/project'))return new Response(JSON.stringify({id:77,default_branch:'main'}));if(path.includes('/commits/'))return new Response(JSON.stringify({sha:'pinned',commit:{tree:{sha:'tree'},author:{}}}));if(path.includes('/git/trees/'))return new Response(JSON.stringify({tree:[entry]}));assert.fail('Ready snapshots must not download file bodies: '+path);};
 mock.method(folderBridge,'begin',async()=>({id:'version',state:'ready',reusedReady:true,files:[nativeFile({...entry,content:'',isBase64:true})]}));
 mock.method(folderBridge,'copy',async()=>assert.fail('Ready snapshots must not rewrite bound project files'));
 mock.method(folderBridge,'put',async()=>assert.fail('Ready snapshots must not rewrite source bodies'));
 mock.method(folderBridge,'finish',async()=>{checks++;return{};});
 const result=await githubClient.fetchRepo('source/project',undefined,undefined,{cachedFiles:[{...entry,content:'',isBase64:true,nativeRef:{version:'old',path:'a'}}]});assert.equal(result.files[0].nativeRef?.version,'version');assert.equal(checks,1);
});

test('native directory small updates fetch only missing pinned blobs without downloading a cold Git pack',async()=>{
 enable();immediateTransport();beginGithubOperation();const unchanged=Buffer.from('already local'),changed=Buffer.from('new content');
 const manifest=[{path:'a',sha:sha(unchanged),size:unchanged.length,type:'blob',mode:'100644'},{path:'b',sha:sha(changed),size:changed.length,type:'blob',mode:'100644'}];const blobs:string[]=[];
 mock.method(folderBridge,'begin',async()=>({id:'version',state:'staging',files:[nativeFile({...manifest[0],content:'',isBase64:true})]}));
 mock.method(folderBridge,'copy',async()=>assert.fail('Old files were already prepared natively'));
 mock.method(nativeGitBridge,'transfer',async()=>assert.fail('Small delta must not fetch a full Git pack'));
 globalThis.fetch=async input=>{const path=String(input);if(path.endsWith('/repos/source/project'))return new Response(JSON.stringify({id:77,default_branch:'main'}));if(path.includes('/commits/'))return new Response(JSON.stringify({sha:'a'.repeat(40),commit:{tree:{sha:'b'.repeat(40)},author:{}}}));if(path.includes('/git/trees/'))return new Response(JSON.stringify({tree:manifest}));assert.ok(path.endsWith('/git/blobs/'+manifest[1].sha),path);blobs.push(path);return new Response(JSON.stringify({content:changed.toString('base64')}));};
 const result=await githubClient.fetchRepo('source/project','main','token',{cachedFiles:manifest.map(file=>({...nativeFile({...file,content:'',isBase64:true}),nativeRef:{version:'old',path:file.path}}))});
 assert.equal(blobs.length,1);assert.deepEqual(documents.get('b'),changed);assert.equal(documents.has('a'),false);assert.equal(result.files.length,2);assert.ok(result.files.every(file=>file.nativeRef?.version==='version'));
});

test('cancelled folder cleanup waits for native acknowledgement and retains the snapshot index',async()=>{
 enable();entries=[{path:'a',sha:sha(Buffer.from('a')),size:1,mode:'100644',content:'',isBase64:true}];await localCache.saveProjectFiles('project',entries.map(nativeFile),'old');
 const controller=new AbortController();let taskId='',cancelled='',ack!:(value:any)=>void,settled=false;
 mock.method(folderBridge,'listen',async()=>({remove:async()=>{}}));
 mock.method(folderBridge,'clear',(value:any)=>{taskId=value.taskId;return new Promise(resolve=>{ack=resolve;});});
 mock.method(folderBridge,'cancel',async(value:any)=>{cancelled=value.taskId;});
 const pending=localCache.deleteProjectFiles('project','old',{signal:controller.signal}).finally(()=>{settled=true;});
 const rejected=assert.rejects(pending,{name:'AbortError'});
 for(let i=0;i<100&&!taskId;i++)await new Promise(resolve=>setTimeout(resolve,1));
 assert.ok(taskId);controller.abort();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(cancelled,taskId);assert.equal(settled,false);assert.equal((await readStore('snapshots')).length,1);
 ack({});await rejected;assert.equal((await readStore('snapshots')).length,1);
});
test('cancel during changed-folder confirmation never forces cleanup or removes cached metadata',async()=>{
 enable();entries=[{path:'a',sha:sha(Buffer.from('a')),size:1,mode:'100644',content:'',isBase64:true}];await localCache.saveProjectFiles('project',entries.map(nativeFile),'old');
 const controller=new AbortController();let asked=false,calls=0;
 mock.method(folderBridge,'listen',async()=>({remove:async()=>{}}));
 mock.method(folderBridge,'clear',async(value:any)=>{calls++;assert.equal(value.force,false);throw Object.assign(new Error('local changes'),{code:'LOCAL_CHANGES'});});
 mock.method(appDialog,'confirm',(_message:string,options?:{signal?:AbortSignal})=>{assert.equal(options?.signal,controller.signal);asked=true;return new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>reject(options!.signal!.reason),{once:true}));});
 const pending=localCache.deleteProjectFiles('project','old',{signal:controller.signal,interactive:true});const rejected=assert.rejects(pending,{name:'AbortError'});
 for(let i=0;i<100&&!asked;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(asked);controller.abort();await rejected;
 assert.equal(calls,1);assert.equal((await readStore('snapshots')).length,1);
});
test('pre-cancelled cleanup does not touch Git objects, documents or snapshot rows',async()=>{
 enable();let clears=0;mock.method(nativeGitCacheBridge,'clear',async()=>{clears++;return{bytes:0};});
 mock.method(folderBridge,'clear',async()=>assert.fail('Native cleanup must not start'));
 const controller=new AbortController();controller.abort();await assert.rejects(localCache.deleteProjectFiles('project',undefined,{signal:controller.signal}),{name:'AbortError'});assert.equal(clears,0);
});

test('cancelling browser cache deletion aborts the metadata transaction instead of removing shared bodies',async()=>{
 const file={path:'a',content:'a',isBase64:false,sha:sha(Buffer.from('a')),mode:'100644'};
 await localCache.saveProjectFiles('project',[file],'old');
 const controller=new AbortController(),original=IDBObjectStore.prototype.getAll;
 mock.method(IDBObjectStore.prototype,'getAll',function(this:IDBObjectStore,...args:any[]){const request=original.apply(this,args as any);if(this.name==='snapshots')queueMicrotask(()=>controller.abort());return request;});
 await assert.rejects(localCache.deleteProjectFiles('project','old',{signal:controller.signal}),{name:'AbortError'});
 mock.restoreAll();assert.equal((await readStore('snapshots')).length,1);assert.equal((await localCache.getProjectFiles('project','old'))[0].content,'a');
});
