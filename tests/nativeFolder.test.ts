import './dom';
import {test,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Capacitor} from '@capacitor/core';
import {folderBridge,hydrateFile,saveFolderArchive} from '../src/utils/nativeFolder';
import {androidPlugin} from '../src/utils/androidPlugin';
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
 let streamed=0;mock.method(nativeGitBridge,'appendDocument',async(value:any)=>{assert.equal(value.size,file.size);assert.deepEqual(value.nativeRef,file.nativeRef);streamed++;});
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
