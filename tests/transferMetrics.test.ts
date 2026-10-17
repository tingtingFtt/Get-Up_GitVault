import './dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureTransfer } from '../src/utils/transferMetrics';
import { clearOperationLogs, readOperationLogs } from '../src/utils/operationLog';
test('transfer diagnostics record stages and native sub-timings without bodies or credentials', async () => {
  clearOperationLogs();
  const value = await measureTransfer({ action: '上传', project: 'a/b', mode: 'native', signal: new AbortController().signal }, async trace => {
    trace.branch('feature/x');trace.phase('暂存');trace.native({ preparationMs: 1250, token: 'must-not-log', body: 'must-not-log', pushMs: 2000 });return 42;
  });
  assert.equal(value, 42);const log = readOperationLogs()[0];assert.equal(log.status, 'success');assert.equal(log.branch, 'feature/x');assert.match(log.message, /暂存/);assert.match(log.message, /1.25 秒/);assert.ok(!JSON.stringify(log).includes('must-not-log'));
});
test('cancelled and failed transfers log the interrupted phase without changing the thrown error', async () => {
  for (const cancelled of [false, true]) {
    clearOperationLogs();const signal = new AbortController().signal,error = cancelled ? new DOMException('cancelled', 'AbortError') : new Error('failed');
    await assert.rejects(measureTransfer({ action: '拉取', project: 'a/b', mode: 'rest', signal }, async trace => { trace.phase('目录写入');throw error; }), candidate => candidate === error);
    assert.equal(readOperationLogs()[0].status, cancelled ? 'cancelled' : 'error');assert.equal(readOperationLogs()[0].stage, '目录写入');
  }
});
