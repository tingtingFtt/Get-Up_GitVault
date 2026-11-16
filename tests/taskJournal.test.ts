import './dom';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, readTasks, interruptedTask, hasUnfinished, forgetTask } from '../src/utils/taskJournal';
beforeEach(() => localStorage.clear());
test('interrupted queues retain successful entries and mark uncertain entries for manual retry', () => {
  checkpoint({ kind: 'projects', action: 'sync', items: [{ id: 'done', status: 'success' }, { id: 'uncertain', status: 'running' }, { id: 'next', status: 'pending' }] });
  const restored = interruptedTask(readTasks()[0]);
  assert.deepEqual(restored.items.map(item => item.status), ['success','cancelled','cancelled']);
  assert.equal(readTasks()[0].items[1].status, 'running'); assert.ok(hasUnfinished(restored));
});
test('only safe queue fields survive, never Token or transient request details', () => {
  checkpoint({ kind: 'upload', purge: false, token: 'secret', items: [{ id: 'one', status: 'uploading', name: 'fixed-target', branch: 'release', targetId: 7, token: 'secret', error: 'Bearer secret', input: 'credential-url', payload: { token: 'secret' } }] } as any);
  const stored = localStorage.getItem('gitvault_tasks_v1')!;
  assert.ok(!stored.includes('secret')); assert.ok(!stored.includes('credential-url'));
  assert.equal(readTasks()[0].items[0].targetId, 7);
});
test('completed queue slots do not erase another unfinished task', () => {
  checkpoint({ kind: 'import', items: [{ url: 'https://github.com/a/b', status: 'downloading' }] });
  checkpoint({ kind: 'upload', items: [{ id: 'done', status: 'success' }] });
  assert.equal(readTasks().filter(hasUnfinished).length, 1);
  forgetTask('upload'); assert.equal(readTasks()[0].kind, 'import');
});
test('interrupted imports retain cancellations for retry without counting them as failures',()=>{
  checkpoint({kind:'import',items:[{url:'https://github.com/a/b',status:'success'},{url:'https://github.com/a/c',status:'downloading'},{url:'https://github.com/a/d',status:'pending'}]});
  const restored=interruptedTask(readTasks()[0]);
  assert.deepEqual(restored.items.map(item=>item.status),['success','cancelled','cancelled']);
  assert.ok(hasUnfinished(restored));
});
test('invalid journal data is not silently replaced by an empty task', () => {
  localStorage.setItem('gitvault_tasks_v1', '{broken');
  assert.throws(readTasks);
  assert.throws(() => checkpoint({ kind: 'upload', items: [] }));
  assert.equal(localStorage.getItem('gitvault_tasks_v1'), '{broken');
});
test('progress-only checkpoints do not rewrite the recoverable queue or change its timestamp',()=>{
 const task={kind:'projects' as const,action:'update' as const,items:[{id:'p',status:'running',label:'source/repo'}]};checkpoint(task);const before=localStorage.getItem('gitvault_tasks_v1');let events=0;const listener=()=>events++;window.addEventListener('gitvault-tasks-changed',listener);
 try{for(let i=0;i<30;i++)checkpoint({...task,items:task.items.map(item=>({...item,message:'progress '+i}))});assert.equal(localStorage.getItem('gitvault_tasks_v1'),before);assert.equal(events,0);checkpoint({...task,items:[{...task.items[0],status:'success'}]});assert.equal(events,1);}finally{window.removeEventListener('gitvault-tasks-changed',listener);}
});
