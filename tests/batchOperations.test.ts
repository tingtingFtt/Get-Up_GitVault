import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProjectBatch, type ProjectBatchItem } from '../src/utils/batchOperations';

const items = (): ProjectBatchItem[] => ['one', 'two', 'three'].map(id => ({ id, label: id, name: id, status: 'pending' }));
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
