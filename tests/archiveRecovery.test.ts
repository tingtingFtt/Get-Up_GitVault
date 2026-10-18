import './dom';
import {test, beforeEach, afterEach, mock} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync} from 'fflate';
import {githubClient, beginGithubOperation} from '../src/utils/githubClient';
import {gitBlobSha} from '../src/utils/gitFiles';
import {localCache, transferCache} from '../src/utils/localCache';
import {readOperationLogs, clearOperationLogs} from '../src/utils/operationLog';
import {immediateTransport} from './transportFixture';

const originalFetch=globalThis.fetch;
const files=await Promise.all(Array.from({length:32},async(_,i)=>({path:`${i}.txt`,content:`recovery-${i}`,isBase64:false,sha:await gitBlobSha(new TextEncoder().encode(`recovery-${i}`)),mode:'100644',size:`recovery-${i}`.length})));
let calls:string[], failBlobs:boolean, commit:string;
const json=(value:unknown)=>new Response(JSON.stringify(value));
beforeEach(async()=>{
  localStorage.clear();clearOperationLogs();immediateTransport();beginGithubOperation();calls=[];failBlobs=true;commit='pinned-a';
  await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase('GitVault_Storage_v1');r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});
  globalThis.fetch=async(url)=>{
    const path=String(url);calls.push(path);
    if(path.endsWith('/repos/source/project'))return json({id:42,default_branch:'main'});
    if(path.includes('/commits/'))return json({sha:commit,commit:{tree:{sha:'tree'},message:'source',author:{}}});
    if(path.includes('/git/trees/'))return json({tree:files.map(file=>({...file,type:'blob'}))});
    if(path.includes('/zipball/'))return new Response(zipSync({'root/0.txt':new TextEncoder().encode(files[0].content)}));
    if(path.includes('/git/blobs/')){
      if(failBlobs)throw new TypeError('offline');
      const file=files.find(file=>path.endsWith(file.sha));assert.ok(file);return json({content:Buffer.from(file.content).toString('base64')});
    }
    assert.fail('Unexpected request '+path);
  };
});
afterEach(()=>{globalThis.fetch=originalFetch;mock.restoreAll();});

test('reload after partial ZIP plus network failure requests only missing blobs and preserves the published snapshot',async()=>{
  await localCache.saveProjectFiles('project',[files[0]],'old');
  await assert.rejects(githubClient.fetchRepo('source/project',undefined,'test-token'),/offline/);
  assert.equal((await transferCache.load('source/project@pinned-a')).length,1);
  assert.equal(await transferCache.archiveRecovery('source/project@pinned-a'),'archive');
  assert.equal((await localCache.getProjectFiles('project'))[0].sha,files[0].sha);
  calls=[];failBlobs=false;beginGithubOperation();
  const result=await githubClient.fetchRepo('source/project',undefined,'test-token');
  assert.deepEqual(result.files.map(file=>file.sha),files.map(file=>file.sha));
  assert.equal(calls.filter(path=>path.includes('/git/blobs/')).length,31);
  assert.ok(!calls.some(path=>path.includes('zipball')||path.endsWith('/git/blobs/'+files[0].sha)));
  await localCache.saveProjectFiles('project',result.files,result.latestCommitSha);
  assert.equal(await transferCache.archiveRecovery('source/project@pinned-a'),undefined);
  assert.equal((await localCache.getProjectFiles('project','old')).length,1);
});
test('cancelled ZIP persists completed files; retry never re-fetches them and a different commit gets a fresh plan',async()=>{
  const controller=new AbortController(), save=transferCache.saveBatch;
  mock.method(transferCache,'saveBatch',async(...args:Parameters<typeof save>)=>{await save(...args);controller.abort();});
  await assert.rejects(githubClient.fetchRepo('source/project',undefined,'test-token',{signal:controller.signal}),{name:'AbortError'});
  assert.equal(await transferCache.archiveRecovery('source/project@pinned-a'),'cancelled');
  assert.equal((await transferCache.load('source/project@pinned-a')).length,1);
  assert.match(readOperationLogs()[0].message,/失败分类：用户取消/);
  failBlobs=false;calls=[];await githubClient.fetchRepo('source/project',undefined,'test-token');
  assert.ok(!calls.some(path=>path.includes('/zipball/')));
  commit='pinned-b';calls=[];await githubClient.fetchRepo('source/project',undefined,'test-token');
  assert.ok(calls.some(path=>path.endsWith('/zipball/pinned-b')));
});
test('temporary cleanup clears recovery decisions as well as file checkpoints without touching snapshots',async()=>{
  await localCache.saveProjectFiles('project',[files[0]],'old');
  await transferCache.save('source/project@pinned-a','pinned-a',files[0]);
  await transferCache.noteArchiveRecovery('source/project@pinned-a','pinned-a','network');
  await transferCache.clearAll();
  assert.equal(await transferCache.archiveRecovery('source/project@pinned-a'),undefined);
  assert.deepEqual(await transferCache.load('source/project@pinned-a'),[]);
  assert.equal((await localCache.getProjectFiles('project','old')).length,1);
});
