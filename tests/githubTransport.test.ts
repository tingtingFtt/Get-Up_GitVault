import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './dom';
import { createGithubTransport, GitHubError } from '../src/utils/githubTransport';

const originalFetch = globalThis.fetch;
const origin = Date.UTC(2026, 9, 16, 16);
const ok = (data: unknown = {}, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
beforeEach(() => { localStorage.clear(); });
afterEach(() => { globalThis.fetch = originalFetch; delete (navigator as any).locks; });
function fixture(options: Parameters<typeof createGithubTransport>[0] = {}) {
  let now = origin;
  const waits: string[] = [], sleeps: number[] = [], calls: Array<{ at: number; init: RequestInit }> = [];
  const clock = { now: () => now, sleep: async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); sleeps.push(ms); now += ms; } };
  let handler = async (_init: RequestInit): Promise<Response> => ok();
  globalThis.fetch = async (_url, init = {}) => { calls.push({ at: now, init }); return handler(init); };
  const transport = createGithubTransport({ clock, shareAcrossTabs: false, onWait: message => waits.push(message), ...options });
  const request = (method = 'GET', signal = new AbortController().signal) => transport.request('https://api.github.com/repos/me/project', { method }, signal);
  return { transport, clock, request, calls, waits, sleeps, handle: (value: typeof handler) => { handler = value; } };
}

test('streamed downloads share rate-limit cooldown and do not consume rejected response bodies as archives', async () => {
  const f = fixture();let calls = 0, consumers = 0;
  f.handle(async () => ++calls === 1 ? ok({ message: 'secondary rate limit' }, 403, { 'retry-after': '2' }) : new Response(new Uint8Array([1, 2, 3])));
  const result = await f.transport.stream('https://api.github.com/archive', {}, new AbortController().signal, async response => { consumers++; return [...new Uint8Array(await response.arrayBuffer())]; });
  assert.deepEqual(result, [1, 2, 3]);assert.equal(consumers, 1);assert.equal(f.calls[1].at - f.calls[0].at, 2000);
});
test('streamed downloads retain read slots until their consumers finish', async () => {
  const f = fixture({ requestInterval: 0 });let started = 0;const finish: Array<() => void> = [];
  const first = Array.from({ length: 3 }, () => f.transport.stream('https://api.github.com/archive', {}, new AbortController().signal, async () => { started++; await new Promise<void>(resolve => finish.push(resolve)); }));
  while (started < 3) await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController(), queued = f.transport.stream('https://api.github.com/archive', {}, controller.signal, async () => assert.fail('Cancelled queued download must never start'));
  controller.abort();await assert.rejects(queued, { name: 'AbortError' });assert.equal(f.calls.length, 3);
  finish.forEach(resolve => resolve());await Promise.all(first);
});
test('stream idle deadlines reset on activity and abort stalled consumers with a timeout reason', async () => {
  const f = fixture({ requestInterval: 0 });let controlled: AbortSignal | undefined;
  const result = await f.transport.stream('https://api.github.com/archive', {}, new AbortController().signal, async (_response, touch, signal) => {
    controlled = signal;for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 70));touch(); }return 'complete';
  }, 200);
  assert.equal(result, 'complete');assert.equal(controlled?.aborted, false);
  await assert.rejects(f.transport.stream('https://api.github.com/archive', {}, new AbortController().signal, async (_response, _touch, signal) => { controlled = signal; return new Promise(() => {}); }, 30), { name: 'TimeoutError' });
  assert.equal(controlled?.aborted, true);
});

test('all mutation types share one queue with at least 1.1 seconds between completed writes', async () => {
  const f = fixture(); let active = 0, maximum = 0;
  f.handle(async () => { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return ok(); });
  await Promise.all(['POST', 'PATCH', 'PUT', 'DELETE'].map(method => f.request(method)));
  assert.equal(maximum, 1);
  assert.deepEqual(f.calls.map(call => call.init.method), ['POST', 'PATCH', 'PUT', 'DELETE']);
  for (let i = 1; i < f.calls.length; i++) assert.ok(f.calls[i].at - f.calls[i - 1].at >= 1100);
});
test('read concurrency is bounded and a cancelled queued read never reaches the network', async () => {
  const f = fixture({ requestInterval: 0 }); let started = 0;
  const releases: Array<() => void> = [];
  f.handle(async () => { started++; await new Promise<void>(resolve => releases.push(resolve)); return ok(); });
  const first = Array.from({ length: 3 }, () => f.request());
  while (started < 3) await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController(), queued = f.request('GET', controller.signal);
  controller.abort(); await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(started, 3);
  releases.forEach(release => release()); await Promise.all(first);
});
test('secondary Retry-After pauses the queue without mistaking the hourly reset for its deadline', async () => {
  const f = fixture(); let count = 0;
  f.handle(async () => ++count === 1 ? ok({ message: 'You have exceeded a secondary rate limit' }, 403, {
    'retry-after': '2', 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': String((origin + 3600000) / 1000),
  }) : ok());
  await f.request('POST');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].at - f.calls[0].at, 2000);
  assert.ok(f.waits.some(message => message.includes('剩余 2 秒') && message.includes('可取消')));
});
test('missing Retry-After waits at least one minute and grows the delay after another secondary rejection', async () => {
  const f = fixture(); let count = 0;
  f.handle(async () => ++count < 3 ? ok({ message: 'secondary rate limit' }, 403) : ok());
  await f.request();
  assert.deepEqual(f.calls.map(call => call.at - origin), [0, 60000, 180000]);
});
test('primary exhaustion honors the later reset and Retry-After also accepts an HTTP date', async () => {
  const cases: Array<Record<string, string>> = [
    { 'retry-after': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((origin + 90000) / 1000) },
    { 'retry-after': new Date(origin + 90000).toUTCString() },
  ];
  for (const headers of cases) {
    const f = fixture(); let count = 0;
    f.handle(async () => ++count === 1 ? ok({ message: 'rate limit exceeded' }, 429, headers) : ok());
    await f.request(); assert.equal(f.calls[1].at - origin, 90000);
  }
});
test('bounded rate retries leave the cooldown in force for subsequent operations', async () => {
  const f = fixture({ retries: 2 });
  f.handle(async () => ok({ message: 'secondary rate limit' }, 403));
  await assert.rejects(f.request(), error => error instanceof GitHubError && error.rateLimited && error.retryAt === origin + 420000);
  assert.equal(f.calls.length, 3);
  f.handle(async () => ok()); await f.request();
  assert.equal(f.calls[3].at, origin + 420000);
});
test('permission failures, validation failures, gateway errors and uncertain writes are not blindly replayed', async () => {
  for (const status of [401, 403, 422, 503]) {
    const f = fixture(); f.handle(async () => ok({ message: 'Resource not accessible' }, status));
    await assert.rejects(f.request('POST'), error => error instanceof GitHubError && error.status === status && !error.rateLimited);
    assert.equal(f.calls.length, 1); assert.equal(f.waits.length, 0);
  }
  const f = fixture(); f.handle(async () => { throw new TypeError('write response lost'); });
  await assert.rejects(f.request('POST'), /response lost/); assert.equal(f.calls.length, 1);
});
test('cancelling a cooldown makes no further request and a new operation still respects the pause', async () => {
  const f = fixture(), controller = new AbortController(); let count = 0;
  f.handle(async () => ++count === 1 ? ok({ message: 'secondary rate limit' }, 403, { 'retry-after': '2' }) : ok());
  const advance = f.clock.sleep;
  f.clock.sleep = async (_ms, signal) => { controller.abort(); signal.throwIfAborted(); };
  await assert.rejects(f.request('POST', controller.signal), { name: 'AbortError' });
  assert.equal(f.calls.length, 1);
  f.clock.sleep = advance; await f.request();
  assert.equal(f.calls[1].at, origin + 2000);
});
test('a page reload or second tab restores the shared cooldown without storing credentials', async () => {
  const f = fixture({ shareAcrossTabs: true, retries: 0 });
  f.handle(async () => ok({ message: 'secondary rate limit' }, 403, { 'retry-after': '3' }));
  await assert.rejects(f.request());
  const other = createGithubTransport({ clock: f.clock, shareAcrossTabs: true });
  f.handle(async () => ok()); await other.request('https://api.github.com/user', { headers: { Authorization: 'Bearer private-token' } }, new AbortController().signal);
  assert.equal(f.calls[1].at, origin + 3000);
  assert.ok(!JSON.stringify({ ...localStorage }).includes('private-token'));
});
test('the rolling write budget waits before another content-generating request', async () => {
  const f = fixture({ hourlyWrites: 2, writeInterval: 0, requestInterval: 0 });
  await f.request('POST'); await f.request('POST'); await f.request('POST');
  assert.deepEqual(f.calls.map(call => call.at - origin), [0, 0, 3600000]);
  assert.ok(f.waits.some(message => message.includes('3600 秒')));
});
test('Web Locks serialize writers across tabs and share their write spacing', async () => {
  let tail = Promise.resolve(); const names: string[] = [];
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, options: any, task: () => Promise<any>) => {
    names.push(name); const result = tail.then(() => { options.signal.throwIfAborted(); return task(); });
    tail = result.then(() => {}, () => {}); return result;
  } } });
  const f = fixture({ shareAcrossTabs: true });
  const other = createGithubTransport({ clock: f.clock, shareAcrossTabs: true });
  await Promise.all([f.request('PUT'), other.request('https://api.github.com/user/repos', { method: 'POST' }, new AbortController().signal)]);
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1].at - f.calls[0].at >= 1100);
  assert.deepEqual(names, ['gitvault-github-writes', 'gitvault-github-writes']);
});
test('invalid persisted deadlines cannot trap the queue indefinitely', async () => {
  localStorage.setItem('gitvault_github_cooldown_v1', 'Infinity');
  localStorage.setItem('gitvault_github_last_write_v1', 'invalid');
  const f = fixture({ shareAcrossTabs: true }); await f.request('PUT');
  assert.equal(f.calls.length, 1); assert.equal(f.sleeps.length, 0);
});

test('production policy survives more than two rate rejections and resumes the same operation', async()=>{
 const f=fixture();let count=0;
 f.handle(async()=>++count<=5?ok({message:'secondary rate limit'},403):ok({saved:true}));
 const response=await f.request('POST');assert.equal(response.status,200);assert.equal(f.calls.length,6);
 assert.deepEqual(f.calls.map(call=>call.at-origin),[0,60000,180000,420000,900000,1860000]);
});
