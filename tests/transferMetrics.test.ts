import './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureTransfer } from '../src/utils/transferMetrics';
import { clearOperationLogs, readOperationLogs } from '../src/utils/operationLog';
import {createGithubTransport} from '../src/utils/githubTransport';
import {markTransferFailure} from '../src/utils/transferFailure';
test('transfer diagnostics record stages and native sub-timings without bodies or credentials', async () => {
  clearOperationLogs();
  const value = await measureTransfer({ action: '上传', project: 'a/b', mode: 'native', signal: new AbortController().signal }, async trace => {
    trace.branch('feature/x');trace.phase('暂存');trace.native({ preparationMs: 1250, token: 'must-not-log', body: 'must-not-log', pushMs: 2000 });return 42;
  });
  assert.equal(value, 42);const log = readOperationLogs()[0];assert.equal(log.status, 'success');assert.equal(log.branch, 'feature/x');assert.match(log.message, /暂存/);assert.match(log.message, /1.25 秒/);assert.ok(!JSON.stringify(log).includes('must-not-log'));
});
test('request diagnostics distinguish queue waits, response processing and rate responses for the matching operation',async()=>{
 const original=globalThis.fetch;let now=0,calls=0;const signal=new AbortController().signal;
 const transport=createGithubTransport({shareAcrossTabs:false,requestInterval:0,clock:{now:()=>now,sleep:async(ms)=>{now+=ms;}},onWait:()=>{}});
 globalThis.fetch=async()=>{now+=25;return ++calls===1?new Response(JSON.stringify({message:'secondary rate limit'}),{status:403,headers:{'retry-after':'2'}}):new Response('{}');};
 clearOperationLogs();try{await measureTransfer({action:'拉取',project:'a/b',mode:'rest',signal},async trace=>{
   window.dispatchEvent(new CustomEvent('gitvault-transport-metric',{detail:{signal:new AbortController().signal,attempts:999,waitMs:999999}}));
   trace.count('复用文件',12);await transport.request('https://api.github.com/repos/a/b',{headers:{Authorization:'Bearer do-not-log'}},signal);
 });const log=readOperationLogs()[0];assert.match(log.message,/API 请求 2 次；限流响应 1 次/);assert.match(log.message,/等待累计 2.00 秒/);assert.match(log.message,/响应处理累计 0.05 秒/);assert.match(log.message,/复用文件：12/);assert.ok(!log.message.includes('do-not-log'));}finally{globalThis.fetch=original;}
});
test('cancelled and failed transfers log the interrupted phase without changing the thrown error', async () => {
  for (const cancelled of [false, true]) {
    clearOperationLogs();const signal = new AbortController().signal,error = cancelled ? new DOMException('cancelled', 'AbortError') : new Error('failed');
    await assert.rejects(measureTransfer({ action: '拉取', project: 'a/b', mode: 'rest', signal }, async trace => { trace.phase('目录写入');throw error; }), candidate => candidate === error);
    assert.equal(readOperationLogs()[0].status, cancelled ? 'cancelled' : 'error');assert.equal(readOperationLogs()[0].stage, '目录写入');
  }
});
test('a successful archive fallback retains its classified cause and final storage errors stay separate',async()=>{
  clearOperationLogs();const context={action:'拉取',project:'a/b',mode:'rest',signal:new AbortController().signal};
  await measureTransfer(context,async trace=>{trace.recovery(markTransferFailure(new Error('must-not-log-response'),'network'));});
  assert.match(readOperationLogs()[0].message,/压缩包恢复原因：网络失败或超时 1 次/);
  assert.ok(!readOperationLogs()[0].message.includes('must-not-log-response'));
  await assert.rejects(measureTransfer(context,async()=>{throw new DOMException('full','QuotaExceededError');}));
  assert.match(readOperationLogs()[0].message,/失败分类：存储空间或配额不足/);
});
