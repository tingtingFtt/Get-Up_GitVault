import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { githubClient, beginGithubOperation, cancelGithubOperation, gitBlobSha, parseRepository } from '../src/utils/githubClient';
import { localCache } from '../src/utils/localCache';
import type { CachedFile } from '../src/utils/localCache';

const originalFetch = globalThis.fetch;
const sha = (text: string | Buffer) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const file = (path: string, content: string): CachedFile => ({ path, content, isBase64: false, sha: sha(content), mode: '100644' });
let calls: Array<{ path: string; init: RequestInit }>;
let handler: (path: string, init: RequestInit) => Response | Promise<Response>;
beforeEach(async () => {
  beginGithubOperation(); calls = [];
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('GitVault_Storage_v1'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
  globalThis.fetch = async (url, init = {}) => { const path = String(url).replace('https://api.github.com', ''); calls.push({ path, init }); return handler(path, init); };
});
afterEach(() => { globalThis.fetch = originalFetch; });
function source(files = [file('a.txt', 'hello')], branch = 'develop') {
  handler = (path) => {
    if (path === '/repos/demo/project') return response({ default_branch: branch, html_url: 'https://github.com/demo/project' });
    if (path.startsWith('/repos/demo/project/commits/')) return response({ sha: 'source-a', commit: { tree: { sha: 'source-tree' }, message: 'message', author: { name: 'author', date: '2026-10-15' } } });
    if (path.includes('/git/trees/')) return response({ tree: files.map(f => ({ path: f.path, sha: f.sha, type: 'blob', mode: f.mode, size: Buffer.byteLength(f.content) })) });
    if (path.includes('/git/blobs/')) {
      const f = files.find(f => path.endsWith(f.sha!));
      if (f) return response({ encoding: 'base64', content: Buffer.from(f.content).toString('base64') });
    }
    if (path.includes('/zipball/') || path.includes('codeload.github.com')) throw new TypeError('simulated CORS');
    throw new Error(`Unexpected source request: ${path}`);
  };
}

test('parses repository URLs and rejects unrelated hosts', () => {
  assert.deepEqual(parseRepository('https://github.com/demo/project.git'), { owner: 'demo', repo: 'project', linkedRef: '' });
  assert.equal(parseRepository('demo/project/tree/feature/demo').linkedRef, 'feature/demo');
  assert.throws(() => parseRepository('https://example.com/demo/project'));
});
test('uses actual default branch instead of hardcoded main', async () => {
  source(); const result = await githubClient.fetchRepo('demo/project');
  assert.equal(result.branch, 'develop'); assert.equal(result.files.length, 1);
  assert.ok(calls.some(c => c.path.endsWith('/commits/develop')));
});
test('respects URL branch containing slashes and explicit branch overrides', async () => {
  source(); const linked = await githubClient.fetchRepo('demo/project/tree/feature/demo');
  assert.equal(linked.branch, 'feature/demo');
  const selected = await githubClient.fetchRepo('demo/project/tree/feature/demo', 'release');
  assert.equal(selected.branch, 'release');
});
test('pins the tree and contents to resolved commit and reuses unchanged files', async () => {
  const files = [file('a.txt', 'same'), file('b.txt', 'new')]; source(files);
  const result = await githubClient.fetchRepo('demo/project', 'develop', undefined, { cachedFiles: [files[0]] });
  assert.equal(result.latestCommitSha, 'source-a');
  assert.equal(calls.filter(c => c.path.includes('/git/blobs/')).length, 1);
  assert.equal(result.files.length, 2);
});
test('archive exceptions try the alternate channel then verified blob fallback', async () => {
  source(Array.from({ length: 13 }, (_, i) => file(`${i}.txt`, `content-${i}`)));
  const result = await githubClient.fetchRepo('demo/project');
  assert.equal(result.files.length, 13);
  assert.ok(calls.some(c => c.path.includes('/zipball/source-a')));
  assert.ok(calls.some(c => c.path.includes('codeload.github.com')));
});
test('a corrupt blob never marks a project fully cached', async () => {
  source(); const base = handler;
  handler = (path, init) => path.includes('/git/blobs/') ? response({ content: Buffer.from('wrong bytes').toString('base64') }) : base(path, init);
  await assert.rejects(() => githubClient.fetchRepo('demo/project'), /校验失败/);
});
test('rate limit errors retain their actionable cause', async () => {
  handler = () => response({ message: 'API rate limit exceeded' }, 403);
  await assert.rejects(() => githubClient.fetchRepo('demo/project'), /403.*API rate limit/);
});
test('cancel aborts an active fetch and no completion is reported', async () => {
  handler = (_path, init) => new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); });
  const pending = githubClient.fetchRepo('demo/project');
  cancelGithubOperation(); await assert.rejects(pending, { name: 'AbortError' });
});
test('cache stores independent versions and retains old contents after update', async () => {
  await localCache.saveProjectFiles('project', [file('a.txt', 'old')], 'v1');
  await localCache.saveProjectFiles('project', [file('a.txt', 'new')], 'v2');
  assert.equal((await localCache.getProjectFile('project', 'a.txt', 'v1'))?.content, 'old');
  assert.equal((await localCache.getProjectFile('project', 'a.txt', 'v2'))?.content, 'new');
});
test('deleting one version does not remove shared content or another project', async () => {
  const shared = file('a.txt', 'shared');
  await localCache.saveProjectFiles('one', [shared], 'v1');
  await localCache.saveProjectFiles('one', [shared], 'v2');
  await localCache.saveProjectFiles('two', [shared], 'v1');
  await localCache.deleteProjectFiles('one', 'v1');
  assert.equal((await localCache.getProjectFiles('one', 'v1')).length, 0);
  assert.equal((await localCache.getProjectFiles('one', 'v2')).length, 1);
  await localCache.deleteProjectFiles('one');
  assert.equal((await localCache.getProjectFiles('two', 'v1'))[0].content, 'shared');
});
test('bad cache writes do not replace the previous saved version', async () => {
  await localCache.saveProjectFiles('project', [file('a.txt', 'old')], 'v1');
  await assert.rejects(() => localCache.saveProjectFiles('project', [{ ...file('a.txt', 'new'), sha: sha('wrong') }], 'v2'));
  assert.equal((await localCache.getProjectFiles('project'))[0].content, 'old');
});
test('cache failure cannot be reported as durable memory-only success', async () => {
  const original = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
  try { await assert.rejects(() => localCache.saveProjectFiles('project', [file('a', 'data')], 'v1'), /持久缓存/); }
  finally { Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true }); }
});

function destination(options: { race?: boolean; badVerification?: boolean; failPatch?: boolean; sameTree?: boolean } = {}) {
  let reads = 0;
  handler = (path, init) => {
    if (path === '/repos/me/backup') return response({ default_branch: 'main' });
    if (path === '/repos/me/backup/git/ref/heads/release') {
      reads++;
      return response({ object: { sha: reads === 1 ? 'parent' : reads === 2 ? options.race ? 'raced' : 'parent' : options.badVerification ? 'wrong' : options.sameTree ? 'parent' : 'new-commit' } });
    }
    if (path.endsWith('/git/commits/parent')) return response({ tree: { sha: options.sameTree ? 'new-tree' : 'old-tree' } });
    if (path.includes('/git/trees/old-tree') || path.includes('/git/trees/new-tree')) return response({ tree: [{ path: 'removed.txt', type: 'blob', sha: sha('old'), mode: '100644' }] });
    if (path.endsWith('/git/blobs')) { const p = JSON.parse(init.body as string); return response({ sha: sha(p.encoding === 'base64' ? Buffer.from(p.content, 'base64') : p.content) }); }
    if (path.endsWith('/git/trees')) return response({ sha: 'new-tree' });
    if (path.endsWith('/git/commits')) return response({ sha: 'new-commit' });
    if (path.endsWith('/git/refs/heads/release')) return options.failPatch ? response({ message: 'protected' }, 403) : response({ object: { sha: 'new-commit' } });
    if (path.endsWith('/git/commits/new-commit')) return response({ tree: { sha: 'new-tree' } });
    throw new Error(`Unexpected destination request: ${path}`);
  };
}
test('uploads exact snapshot to the selected branch without force and verifies it', async () => {
  destination();
  const result = await githubClient.push('me', 'backup', 'release', 'token', [file('a.txt', 'new')], 'sync');
  assert.equal(result.branch, 'release'); assert.equal(result.verified, true);
  assert.ok(!calls.some(c => c.path.includes('/heads/main')));
  const tree = JSON.parse(calls.find(c => c.path.endsWith('/git/trees'))!.init.body as string);
  assert.equal(tree.base_tree, undefined); assert.deepEqual(tree.tree.map((f: any) => f.path), ['a.txt']);
  assert.equal(JSON.parse(calls.find(c => c.init.method === 'PATCH')!.init.body as string).force, false);
});
test('target branch race stops the upload instead of overwriting concurrent work', async () => {
  destination({ race: true });
  await assert.rejects(() => githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync'), /已变化/);
  assert.ok(!calls.some(c => c.init.method === 'PATCH'));
});
test('failed reference update and failed verification cannot return success', async () => {
  destination({ failPatch: true });
  await assert.rejects(() => githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync'), /403/);
  destination({ badVerification: true });
  await assert.rejects(() => githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync'), /验证未通过/);
});
test('unchanged target tree reuses the existing commit on retry', async () => {
  destination({ sameTree: true });
  const result = await githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync');
  assert.equal(result.commitSha, 'parent');
  assert.ok(!calls.some(c => c.path.endsWith('/git/commits') && c.init.method === 'POST'));
});
test('release uses the selected commit and rejects an existing mismatched tag', async () => {
  handler = (path, init) => path.includes('/git/ref/tags/') ? response({ message: 'not found' }, 404) : response({ html_url: 'release-url', tag_name: 'v1' });
  await githubClient.release('me', 'backup', 'v1', 'version', 'notes', 'token', 'saved-commit');
  assert.equal(JSON.parse(calls.find(c => c.path.endsWith('/releases'))!.init.body as string).target_commitish, 'saved-commit');
  handler = () => response({ object: { type: 'commit', sha: 'wrong' } });
  await assert.rejects(() => githubClient.release('me', 'backup', 'v1', 'version', '', 'token', 'saved-commit'), /其他版本/);
});
test('blob hash is byte accurate for Unicode and binary files', async () => {
  for (const bytes of [Buffer.from('中文源码'), Buffer.from([0, 255, 128, 1])]) assert.equal(await gitBlobSha(bytes), sha(bytes));
});

test('interrupted browser downloads persist verified parts and reuse them on retry', async () => {
  await import('./dom');
  const files = Array.from({ length: 8 }, (_, i) => file(`${i}.txt`, `bytes-${i}`));
  source(files); const base = handler;
  handler = async (path, init) => {
    if (path.endsWith(files[6].sha!)) { await new Promise(r => setTimeout(r, 30)); throw new TypeError('network interrupted'); }
    return base(path, init);
  };
  await assert.rejects(() => githubClient.fetchRepo('demo/project'));
  const { transferCache } = await import('../src/utils/localCache');
  const saved = await transferCache.load('demo/project@source-a');
  assert.ok(saved.length > 0 && saved.length < files.length);
  calls = []; source(files);
  const result = await githubClient.fetchRepo('demo/project');
  assert.equal(result.files.length, files.length);
  assert.equal(calls.filter(c => c.path.includes('/git/blobs/')).length, files.length - saved.length);
  await localCache.saveProjectFiles('downloaded', result.files, result.latestCommitSha);
  assert.equal((await transferCache.load('demo/project@source-a')).length, 0);
});

test('truncated recursive trees are walked completely', async () => {
  source(); const base = handler;
  handler = (path, init) => {
    if (path.endsWith('/git/trees/source-tree?recursive=1')) return response({ truncated: true, tree: [] });
    if (path.endsWith('/git/trees/source-tree')) return response({ tree: [{ path: 'folder', type: 'tree', mode: '040000', sha: 'folder-sha' }] });
    if (path.endsWith('/git/trees/folder-sha')) return response({ tree: [{ path: 'a.txt', type: 'blob', mode: '100644', sha: sha('hello') }] });
    return base(path, init);
  };
  const result = await githubClient.fetchRepo('demo/project');
  assert.equal(result.files[0].path, 'folder/a.txt');
});
