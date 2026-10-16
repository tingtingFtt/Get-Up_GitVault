import './dom';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Capacitor} from '@capacitor/core';
import {nativeGitBridge,nativeGitTransfer} from '../src/utils/nativeGit';
import {gitServiceConfig,saveGitServiceConfig} from '../src/utils/gitService';
const bridge={...nativeGitBridge},platform={isNativePlatform:Capacitor.isNativePlatform,getPlatform:Capacitor.getPlatform,isPluginAvailable:Capacitor.isPluginAvailable};
afterEach(()=>{Object.assign(nativeGitBridge,bridge);Object.assign(Capacitor,platform);localStorage.clear();});
test('new APKs default to direct native Git and retain an explicit REST preference',()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
 assert.equal(gitServiceConfig().mode,'native');saveGitServiceConfig({mode:'rest',url:''});assert.equal(gitServiceConfig().mode,'rest');
});
test('native Git cancellation returns immediately, tells the plugin to stop, and removes progress listeners',async()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';Capacitor.isPluginAvailable=()=>true;
 let started=false,id='',cancelled='',removed=false,finish!:(value:unknown)=>void;
 nativeGitBridge.addListener=async()=>({remove:async()=>{removed=true;}});nativeGitBridge.transfer=options=>{started=true;id=String(options.id);assert.equal(options.token,'temporary-token');return new Promise(resolve=>{finish=resolve;});};nativeGitBridge.cancel=async options=>{cancelled=options.id;};
 const controller=new AbortController(),pending=nativeGitTransfer('fetch',{owner:'source',repo:'repo',expectedRepoId:1,ref:'a'.repeat(40)},'temporary-token',controller.signal);
 while(!started)await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,id);assert.equal(removed,true);assert.ok(!JSON.stringify({...localStorage}).includes('temporary-token'));finish({});
});
