import './dom';
import {test,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {Capacitor} from '@capacitor/core';
import {nativeGitCacheEnabled,saveNativeGitCache,nativeGitCacheBridge} from '../src/utils/nativeGitCache';
import {localCache} from '../src/utils/localCache';

afterEach(()=>{mock.restoreAll();localStorage.clear();});
const enable=()=>{mock.method(Capacitor,'isNativePlatform',()=>true);mock.method(Capacitor,'getPlatform',()=> 'android');mock.method(Capacitor,'isPluginAvailable',(name:string)=>name==='GitVaultGit');};
test('Git acceleration is opt-in and disabling waits for successful native cleanup',async()=>{
 enable();assert.equal(nativeGitCacheEnabled(),false);await saveNativeGitCache(true);assert.equal(nativeGitCacheEnabled(),true);
 mock.method(nativeGitCacheBridge,'clear',async()=>{throw new Error('busy');});await assert.rejects(saveNativeGitCache(false),/busy/);assert.equal(nativeGitCacheEnabled(),true);
 mock.method(nativeGitCacheBridge,'clear',async()=>({bytes:123}));await saveNativeGitCache(false);assert.equal(nativeGitCacheEnabled(),false);
});
test('source purge clears Git objects before removing snapshot references and keeps references on cleanup failure',async()=>{
 enable();await localCache.saveProjectFiles('cache-test',[{path:'a',content:'source',isBase64:false}],'v1');
 mock.method(nativeGitCacheBridge,'clear',async()=>{throw new Error('not cleared');});await assert.rejects(localCache.deleteProjectFiles('cache-test','v1'),/not cleared/);assert.equal((await localCache.getProjectFiles('cache-test','v1')).length,1);
 mock.method(nativeGitCacheBridge,'clear',async()=>({bytes:123}));await localCache.deleteProjectFiles('cache-test','v1');assert.equal((await localCache.getProjectFiles('cache-test','v1')).length,0);
});
