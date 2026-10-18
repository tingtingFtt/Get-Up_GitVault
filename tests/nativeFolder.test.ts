import './dom';
import {test,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Capacitor} from '@capacitor/core';
import {folderBridge,hydrateFile,saveFolderArchive,finishFolder} from '../src/utils/nativeFolder';
import {exportProjectDirectory} from '../src/utils/nativePlatform';
import {nativeGitBridge,nativeGitTransfer} from '../src/utils/nativeGit';
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
