import './dom';
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Capacitor} from '@capacitor/core';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import AppUpdates,{updaterBridge,openAppUpdater} from '../src/components/AppUpdates';
const methods={...updaterBridge},platform={isNativePlatform:Capacitor.isNativePlatform,getPlatform:Capacitor.getPlatform};
afterEach(()=>{Object.assign(updaterBridge,methods);Object.assign(Capacitor,platform);localStorage.clear();});
const update={packageId:'com.gitvault.app.debug',versionCode:8,versionName:'1.0.8',url:'https://github.com/tingtingFtt/Get-Up_GitVault/releases/download/android-v1.0.8/GitVault-debug.apk',sha256:'a'.repeat(64),size:1000};
test('APK checks automatically but downloads and opens the installer only after explicit controls',async()=>{
 Capacitor.isNativePlatform=()=>true;Capacitor.getPlatform=()=> 'android';let checks=0,downloads=0,installs=0;
 updaterBridge.check=async()=>{checks++;return {available:true,currentVersion:'1.0.7',currentCode:7,update};};updaterBridge.getStatus=async()=>({state:'idle'});
 updaterBridge.download=async options=>{assert.equal(options.update.versionCode,8);downloads++;return {state:'ready'};};updaterBridge.install=async()=>{installs++;return {permissionRequired:true};};
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
 const click=async(text:string)=>{const button=[...container.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(button,text);await act(async()=>button.click());};
 try{await act(async()=>root.render(React.createElement(AppUpdates)));assert.equal(checks,1);assert.equal(downloads,0);assert.equal(installs,0);await act(async()=>{openAppUpdater();});await click('下载新版');assert.equal(downloads,1);assert.equal(installs,0);await click('安装更新');assert.equal(installs,1);assert.match(container.textContent!,/允许安装此来源/);}
 finally{await act(async()=>root.unmount());container.remove();}
});
test('web pages do not invoke APK update native methods',async()=>{
 Capacitor.isNativePlatform=()=>false;updaterBridge.check=async()=>{throw new Error('must not call');};const container=document.createElement('div');const root=createRoot(container);try{await act(async()=>root.render(React.createElement(AppUpdates)));assert.equal(container.textContent,'');}finally{await act(async()=>root.unmount());}
});
