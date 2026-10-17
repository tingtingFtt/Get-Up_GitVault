import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { readArchive } from '../src/utils/archiveDownload';
import { gitBlobSha } from '../src/utils/gitFiles';

async function fixture(files: Record<string, Uint8Array>) {
  const entries = await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, sha: await gitBlobSha(bytes), mode: '100644', size: bytes.length })));
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([path, bytes]) => ['root/' + path, bytes])), { level: 1 });
  return { entries, zip };
}
function stream(bytes: Uint8Array, size = 31) {
  let offset = 0, cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { if (offset === bytes.length) { controller.close(); return; } const end = Math.min(bytes.length, offset + size); controller.enqueue(bytes.slice(offset, end)); offset = end; },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  Object.defineProperty(response, 'arrayBuffer', { value: () => assert.fail('Archive must remain streamed') });
  return { response, offset: () => offset, cancelled: () => cancelled };
}
test('streamed archives preserve binary, empty, Unicode paths and apply storage backpressure', async () => {
  const files = { '目录/空.txt': new Uint8Array(), 'binary.bin': Uint8Array.from([0, 255, 128, 1]), 'text.txt': new TextEncoder().encode('\ufeff中文\n') };
  const { entries, zip } = await fixture(files), input = stream(zip), saved: string[] = [];
  await readArchive(input.response, entries, new AbortController().signal, async (entry, bytes) => {
    assert.deepEqual(bytes, files[entry.path as keyof typeof files]); assert.equal(await gitBlobSha(bytes), entry.sha);
    const before = input.offset(); await new Promise(resolve => setImmediate(resolve)); assert.equal(input.offset(), before);
    if (!saved.length) assert.ok(before < zip.length); saved.push(entry.path);
  });
  assert.equal(saved.length, 3);
});
test('interrupted archives keep only completed files and expose missing entries for retry', async () => {
  const { entries, zip } = await fixture({ a: new TextEncoder().encode('first'), b: new Uint8Array(10000).fill(255) });
  let saved = 0; const controller = new AbortController(), input = stream(zip);
  await assert.rejects(readArchive(input.response, entries, controller.signal, async () => { saved++; controller.abort(); }), { name: 'AbortError' });
  assert.equal(saved, 1); assert.ok(input.cancelled());
});
test('archive size mismatches and unsafe paths stop before accepting bytes', async () => {
  const { entries, zip } = await fixture({ a: new Uint8Array(4096).fill(1) });
  await assert.rejects(readArchive(stream(zip).response, [{ ...entries[0], size: 1 }], new AbortController().signal, async () => assert.fail()), /大小/);
  const unsafe = zipSync({ 'root/../evil': new Uint8Array([1]) });
  await assert.rejects(readArchive(stream(unsafe).response, entries, new AbortController().signal, async () => assert.fail()), /路径/);
});
test('an archive missing a manifest path never claims a complete snapshot', async () => {
  const { entries, zip } = await fixture({ a: new Uint8Array([1]) }); let saved = 0;
  await assert.rejects(readArchive(stream(zip).response, [...entries, { ...entries[0], path: 'missing' }], new AbortController().signal, async () => { saved++; }), /缺少/);
  assert.equal(saved, 1);
});
test('resume skips unwanted archive entries through a discard stream and saves only missing paths', async () => {
  const { entries, zip } = await fixture({ alreadyCached: new Uint8Array(4 * 1024 * 1024).fill(173), missing: new TextEncoder().encode('new') });
  const input = stream(zip, 107);const saved: string[] = [];
  await readArchive(input.response, entries.filter(entry => entry.path === 'missing'), new AbortController().signal, async entry => { saved.push(entry.path); });
  assert.deepEqual(saved, ['missing']);
});
