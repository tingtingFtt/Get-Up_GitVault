import './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendOperationLog, readOperationLogs, clearOperationLogs, redactLog } from '../src/utils/operationLog';
test('persistent failure logs retain the reason, stage, HTTP code and batch ID while redacting credentials', () => {
  clearOperationLogs();
  appendOperationLog({action:'批量上传',status:'error',project:'owner/repo',branch:'feature/x',stage:'保存分支',httpStatus:422,batchId:'batch-1',message:'Update is not a fast forward. Bearer custom-secret https://x/?token=query-secret ghp_abc123 github_pat_example'},['custom-secret']);
  const log = readOperationLogs()[0];
  assert.equal(log.httpStatus,422); assert.equal(log.stage,'保存分支'); assert.equal(log.batchId,'batch-1');
  assert.ok(log.message.includes('Update is not a fast forward'));
  for (const secret of ['custom-secret','query-secret','ghp_abc123','github_pat_example']) assert.ok(!JSON.stringify(log).includes(secret));
  clearOperationLogs(); assert.deepEqual(readOperationLogs(),[]);
});
test('logs are bounded, preserve cancelled outcomes and tolerate corrupt stored JSON', () => {
  localStorage.setItem('gitvault_operation_logs_v1','invalid'); assert.deepEqual(readOperationLogs(),[]);
  const records = Array.from({length:1000},(_,i)=>({id:String(i),time:'now',message:'old',status:'success'}));
  localStorage.setItem('gitvault_operation_logs_v1',JSON.stringify(records));
  appendOperationLog({action:'同步',status:'cancelled',message:'已取消，已完成的提交保留'});
  assert.equal(readOperationLogs().length,1000); assert.equal(readOperationLogs()[0].status,'cancelled');
  assert.ok(!redactLog('https://user:password@example.com/path').includes('password'));
});
