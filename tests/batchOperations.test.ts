import './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {operationSignal,operationGroup,reportProgress,beginGithubOperation,withOperationSignal} from '../src/utils/operation';
import { runProjectBatch, type ProjectBatchItem } from '../src/utils/batchOperations';

const items = (): ProjectBatchItem[] => ['one', 'two', 'three'].map(id => ({ id, label: id, name: id, status: 'pending' }));
test('a stalled update waits for stop acknowledgement, keeps its parent live, and continues other projects',async()=>{
  beginGithubOperation();const parent=operationSignal();let stopped=false,nextBeforeStop=false;
  const queue=await runProjectBatch(items(),{signal:parent,stallMs:25,onChange:()=>{},run:async item=>{
    if(item.id!=='one'){if(!stopped)nextBeforeStop=true;return {message:'done'};}
    const child=operationSignal();assert.notEqual(child,parent);assert.equal(operationGroup(child),parent);
    const heartbeat=setInterval(()=>reportProgress('等待远端 · 1 秒',false),5);
    try{await new Promise<void>((_resolve,reject)=>child.addEventListener('abort',()=>setTimeout(()=>{stopped=true;reject(child.reason);},20),{once:true}));}
    finally{clearInterval(heartbeat);}return {message:'must not finish'};
  }});
  assert.deepEqual(queue.map(item=>item.status),['error','success','success']);assert.ok(queue[0].message?.includes('长时间没有有效进展'));assert.equal(nextBeforeStop,false);assert.equal(parent.aborted,false);assert.equal(operationSignal(),parent);
});
test('real transfer activity keeps a long project alive while heartbeat messages do not',async()=>{
  beginGithubOperation();const parent=operationSignal();
  const queue=await runProjectBatch(items().slice(0,1),{signal:parent,stallMs:80,onChange:()=>{},run:async()=>{
    for(let i=0;i<12;i++){reportProgress(`已读取 ${i} MiB`,true);await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(operationSignal().aborted,false);return {message:'done'};
  }});
  assert.equal(queue[0].status,'success');
});
test('nested operation scopes restore their parent after a failed child',async()=>{
  beginGithubOperation();const parent=operationSignal(),child=new AbortController();
  await assert.rejects(withOperationSignal(child.signal,parent,async()=>{assert.equal(operationSignal(),child.signal);throw new Error('failed');}),/failed/);
  assert.equal(operationSignal(),parent);assert.equal(operationGroup(child.signal),parent);
});
test('a failed batch item does not discard successful results or block later projects', async () => {
  const calls: string[] = []; const updates: ProjectBatchItem[][] = [];
  const original = items();
  const result = await runProjectBatch(original, { signal: new AbortController().signal, onChange: queue => updates.push(queue), run: async item => {
    calls.push(item.id); if (item.id === 'two') throw new Error('rate limited'); return { message: 'verified' };
  } });
  assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.deepEqual(result.map(item => item.status), ['success', 'error', 'success']);
  assert.equal(result[1].message, 'rate limited');
  assert.ok(original.every(item => item.status === 'pending'));
  assert.equal(updates[0][0].status, 'running');
});

test('cancellation retains a completed project and marks unstarted projects for retry without starting them', async () => {
  const controller = new AbortController(); const calls: string[] = [];
  const result = await runProjectBatch(items(), { signal: controller.signal, onChange: () => {}, run: async item => {
    calls.push(item.id); controller.abort(); return { message: 'already verified and saved' };
  } });
  assert.deepEqual(calls, ['one']);
  assert.deepEqual(result.map(item => item.status), ['success', 'cancelled', 'cancelled']);
});

test('retries operate only on pending entries and keep the queue fixed when managed projects are created', async () => {
  const queue = items(); queue[0].status = 'success'; queue[2].status = 'skipped'; const calls: string[] = [];
  const result = await runProjectBatch(queue, { signal: new AbortController().signal, onChange: () => {}, run: async item => {
    calls.push(item.id); queue.push({ id: 'managed', label: 'managed', name: 'managed', status: 'pending' }); return { message: 'done' };
  } });
  assert.deepEqual(calls, ['two']); assert.equal(result.length, 3);
  assert.deepEqual(result.map(item => item.status), ['success', 'success', 'skipped']);
});
