import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { githubClient, beginGithubOperation, cancelGithubOperation, gitBlobSha, parseRepository, TargetRepositoryError } from '../src/utils/githubClient';
import { localCache } from '../src/utils/localCache';
import type { CachedFile } from '../src/utils/localCache';

test('import comparison verifies immutable identity and pinned target tree without downloading or writing files', async () => {
  handler = path => {
    if (path === '/repos/me/renamed') return response({ id: 77, name: 'renamed', owner: { login: 'me' }, default_branch: 'main' });
    if (path.endsWith('/commits/feature%2Fdemo')) return response({ sha: 'head', commit: { tree: { sha: 'tree' } } });
    if (path.includes('/git/trees/tree')) return response({ tree: [{ path: 'a.txt', sha: 'blob', type: 'blob', mode: '100644' }] });
    throw new Error(path);
  };
  const result = await githubClient.inspectImportTarget({ id: 77, owner: 'me', repo: 'renamed', branch: 'feature/demo' }, 'token');
  assert.equal(result.commitSha, 'head'); assert.equal(result.tree.length, 1);
  assert.ok(calls.every(call => !call.init.method || call.init.method === 'GET'));
  assert.ok(calls.every(call => !call.path.includes('/git/blobs/')));
  await assert.rejects(githubClient.inspectImportTarget({ id: 88, owner: 'me', repo: 'renamed', branch: 'main' }, 'token'), /身份已变化/);
});
test('import comparison rejects a Fork with another upstream before reading its branch', async () => {
  handler = () => response({ id: 77, fork: true, parent: { full_name: 'another/template' } });
  await assert.rejects(githubClient.inspectImportTarget({ id: 77, owner: 'me', repo: 'fork', branch: 'main' }, 'token', { owner: 'source', repo: 'template' }), /上游与来源不一致/);
  assert.equal(calls.length, 1);
});
test('missing target branch is offered for future creation only after repository and branch access are verified', async () => {
  handler = path => {
    if (path === '/repos/me/project') return response({ id: 77, default_branch: 'main' });
    if (path.includes('/commits/')) return response({ message: 'Not Found' }, 404);
    if (path.includes('/branches?')) return response([{ name: 'main' }]);
    throw new Error(path);
  };
  const result = await githubClient.inspectImportTarget({ id: 77, owner: 'me', repo: 'project', branch: 'feature/demo' }, 'token');
  assert.equal(result.missingBranch, true); assert.deepEqual(result.tree, []);
  assert.ok(calls.every(call => !call.init.method || call.init.method === 'GET'));
});
test('import comparison preserves rate-limit errors and never treats them as a missing branch', async () => {
  handler = path => path === '/repos/me/project' ? response({ id: 77 }) : response({ message: 'API rate limit exceeded' }, 403);
  await assert.rejects(githubClient.inspectImportTarget({ id: 77, owner: 'me', repo: 'project', branch: 'main' }, 'token'), /API rate limit exceeded/);
  assert.equal(calls.length, 2);
});
test('repository failures distinguish inaccessible targets, expired credentials, permissions, rate limits and transient failures', async () => {
  for (const [status, message, expected] of [[404, 'Not Found', 'unavailable'], [401, 'Bad credentials', 'auth'], [403, 'Resource not accessible', 'forbidden'], [403, 'API rate limit exceeded', 'limited'], [429, 'Too many requests', 'limited'], [503, 'Server error', 'error']] as const) {
    handler = () => response({ message }, status);
    await assert.rejects(githubClient.repository('me', 'backup', 'token', 77), error => error instanceof TargetRepositoryError && error.health.status === expected);
  }
  assert.ok(calls.every(call => !call.init.method || call.init.method === 'GET'));
});
test('a renamed target with the same immutable ID remains valid while a newly created same-name repository is rejected', async () => {
  handler = () => response({ id: 77, name: 'renamed', owner: { login: 'me' }, default_branch: 'main' });
  assert.equal((await githubClient.repository('me', 'old-name', 'token', 77)).repo, 'renamed');
  await assert.rejects(githubClient.repository('me', 'old-name', 'token', 88), error => error instanceof TargetRepositoryError && error.health.status === 'identity-changed');
});
test('cancelling repository checks does not turn an interrupted request into an inaccessible target', async () => {
  const controller = new AbortController();
  handler = (_path, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  const request = githubClient.repository('me', 'backup', 'token', 77, controller.signal);
  controller.abort();
  await assert.rejects(request, error => !(error instanceof TargetRepositoryError) && (error as Error).name === 'AbortError');
});

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
  let written = false;
  handler = (path, init) => {
    if (path === '/repos/me/backup') return response({ default_branch: 'main' });
    if (path === '/repos/me/backup/git/ref/heads/release') {
      reads++;
      return response({ object: { sha: reads >= 2 && options.race ? 'raced' : written ? options.badVerification ? 'wrong' : 'new-commit' : 'parent' } });
    }
    if (path.endsWith('/git/commits/parent')) return response({ tree: { sha: options.sameTree ? 'new-tree' : 'old-tree' } });
    if (path.includes('/git/trees/old-tree') || path.includes('/git/trees/new-tree')) return response({ tree: [{ path: 'removed.txt', type: 'blob', sha: sha('old'), mode: '100644' }] });
    if (path.endsWith('/git/blobs')) { const p = JSON.parse(init.body as string); return response({ sha: sha(p.encoding === 'base64' ? Buffer.from(p.content, 'base64') : p.content) }); }
    if (path.endsWith('/git/trees')) return response({ sha: 'new-tree' });
    if (path.endsWith('/git/commits')) return response({ sha: 'new-commit' });
    if (path.endsWith('/git/refs/heads/release')) {
      if (options.failPatch) return response({ message: 'protected' }, 403);
      written = true; return response({ object: { sha: 'new-commit' } });
    }
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
  assert.ok(!calls.some(c => c.init.method === 'PATCH'));
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

test('branch lookup paginates, keeps slash names, and puts the default branch first', async () => {
  handler = path => {
    if (path === '/repos/demo/project') return response({ default_branch: 'main' });
    if (path.endsWith('page=1')) return response(Array.from({ length: 100 }, (_, i) => ({ name: `feature/${i}` })));
    if (path.endsWith('page=2')) return response([{ name: 'main' }, { name: 'test' }]);
    throw new Error(path);
  };
  const branches = await githubClient.fetchBranches('demo/project');
  assert.equal(branches.length, 102); assert.equal(branches[0], 'main'); assert.ok(branches.includes('feature/99'));
});

test('branch lookup remains usable after a download was cancelled', async () => {
  cancelGithubOperation();
  handler = path => path === '/repos/demo/project' ? response({ default_branch: 'main' }) : response([{ name: 'main' }, { name: 'test' }]);
  assert.deepEqual(await githubClient.fetchBranches('demo/project'), ['main', 'test']);
});

test('branch lookup explains invalid tokens, private access errors and empty repos', async () => {
  handler = () => response({ message: 'Bad credentials' }, 401);
  await assert.rejects(() => githubClient.fetchBranches('demo/project', 'expired'), /Token 无效或已过期/);
  handler = () => response({ message: 'Not Found' }, 404);
  await assert.rejects(() => githubClient.fetchBranches('demo/project'), /私有仓库/);
  handler = path => path === '/repos/demo/project' ? response({ default_branch: 'main' }) : response([]);
  await assert.rejects(() => githubClient.fetchBranches('demo/project'), /暂无分支/);
});


test('non-fast-forward rejection after the preflight check reports a branch conflict without force', async () => {
  destination(); const base = handler;
  let moved = false;
  handler = (path, init) => {
    if (init.method === 'PATCH') { moved = true; return response({ message: 'Update is not a fast forward' }, 422); }
    if (moved && path.endsWith('/git/ref/heads/release')) return response({ object: { sha: 'concurrent-commit' } });
    return base(path, init);
  };
  await assert.rejects(() => githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync'), /已变化.*本地文件已保留/);
  const patches = calls.filter(c => c.init.method === 'PATCH');
  assert.equal(patches.length, 1); assert.equal(JSON.parse(patches[0].init.body as string).force, false);
});

test('lost successful update response is verified without sending another write', async () => {
  destination(); const base = handler;
  let written = false;
  handler = (path, init) => {
    if (init.method === 'PATCH') { written = true; throw new TypeError('response lost'); }
    if (written && path.endsWith('/git/ref/heads/release')) return response({ object: { sha: 'new-commit' } });
    return base(path, init);
  };
  const result = await githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync');
  assert.equal(result.verified, true); assert.equal(calls.filter(c => c.init.method === 'PATCH').length, 1);
});

test('reference reads bypass stale caches and new commits use the target parent', async () => {
  destination(); await githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync');
  assert.ok(calls.filter(c => c.path.endsWith('/git/ref/heads/release')).every(c => c.init.cache === 'no-store'));
  const commit = calls.find(c => c.path.endsWith('/git/commits') && c.init.method === 'POST')!;
  assert.deepEqual(JSON.parse(commit.init.body as string).parents, ['parent']);
});

test('same-head non-fast-forward errors remain actionable and never force a retry', async () => {
  destination(); const base = handler;
  let rejected = false;
  handler = (path, init) => {
    if (init.method === 'PATCH') { rejected = true; return response({ message: 'Update is not a fast forward' }, 422); }
    if (rejected && path.endsWith('/git/ref/heads/release')) return response({ object: { sha: 'parent' } });
    return base(path, init);
  };
  await assert.rejects(() => githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync'), /非快进更新.*源码已保留/);
  assert.equal(calls.filter(c => c.init.method === 'PATCH').length, 1);
});

test('snapshot updates append to the newest target parent without force when destination changes', async () => {
  destination(); const base = handler;
  let writes = 0;
  handler = (path, init) => {
    if (path.endsWith('/git/ref/heads/release')) return response({ object: { sha: writes ? 'new-commit' : calls.filter(c => c.path.endsWith('/git/ref/heads/release')).length > 1 ? 'concurrent' : 'parent' } });
    if (path.endsWith('/git/commits/concurrent')) return response({ tree: { sha: 'old-tree' } });
    if (init.method === 'PATCH') writes++;
    return base(path, init);
  };
  const result = await githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync', undefined, undefined, undefined, { rebaseOnConflict: true });
  assert.equal(result.verified, true);
  const commits = calls.filter(c => c.path.endsWith('/git/commits') && c.init.method === 'POST').map(c => JSON.parse(c.init.body as string));
  assert.deepEqual(commits.map(c => c.parents), [['parent'], ['concurrent']]);
  assert.ok(calls.filter(c => c.init.method === 'PATCH').every(c => JSON.parse(c.init.body as string).force === false));
});

test('upload refuses a different repository with the same name', async () => {
  destination();
  await assert.rejects(() => githubClient.push('me', 'backup', 'release', 'token', [file('a', 'new')], 'sync', undefined, undefined, undefined, { expectedRepoId: 99 }), /身份校验失败/);
  assert.ok(!calls.some(c => c.init.method === 'POST'));
});

test('rename keeps immutable repository ID and only sends an explicit name update', async () => {
  handler = (path, init) => init.method === 'PATCH' ? response({ id: 77, owner: { login: 'me' }, name: 'new-name', html_url: 'https://github.com/me/new-name' }) : response({ id: 77, owner: { login: 'me' }, name: 'backup', default_branch: 'release' });
  const result = await githubClient.renameRepository({ id: 77, owner: 'me', repo: 'backup' }, 'new-name', 'token');
  assert.equal(result.id, 77); assert.equal(result.repo, 'new-name');
  const writes = calls.filter(c => c.init.method === 'PATCH');
  assert.equal(writes.length, 1); assert.deepEqual(JSON.parse(writes[0].init.body as string), { name: 'new-name' });
  assert.ok(!calls.some(c => c.init.method === 'POST'));
});

test('complete Fork requests all branches and only succeeds after verifying its source and branches', async () => {
  let created = false;
  handler = (path, init) => {
    if (path === '/user') return response({ login: 'me' });
    if (path === '/repos/author/template') return response({ id: 42, default_branch: 'main' });
    if (path.startsWith('/repos/author/template/branches?')) return response([{ name: 'main' }, { name: 'feature/demo' }]);
    if (path.endsWith('/forks')) { created = true; return response({ id: 77, owner: { login: 'me' }, name: 'my-template' }); }
    if (path === '/repos/me/my-template') return created ? response({ id: 77, fork: true, parent: { id: 42 }, owner: { login: 'me' }, name: 'my-template', default_branch: 'main', html_url: 'https://github.com/me/my-template', full_name: 'me/my-template' }) : response({ message: 'Not Found' }, 404);
    if (path.startsWith('/repos/me/my-template/branches?')) return response([{ name: 'main' }, { name: 'feature/demo' }]);
    throw new Error(path);
  };
  const result = await githubClient.createFork('https://github.com/author/template/tree/feature/demo', 'token', 'my-template');
  assert.equal(result.verified, true); assert.equal(result.branches.length, 2);
  assert.equal(JSON.parse(calls.find(c => c.path.endsWith('/forks'))!.init.body as string).default_branch_only, false);
});

test('complete Fork can associate an existing matching Fork without creating another', async () => {
  handler = path => {
    if (path === '/user') return response({ login: 'me' });
    if (path === '/repos/author/template') return response({ id: 42, default_branch: 'main' });
    if (path.includes('/branches?')) return response([{ name: 'main' }]);
    if (path === '/repos/me/mine') return response({ id: 77, name: 'mine', fork: true, owner: { login: 'me' }, parent: { id: 42 }, default_branch: 'main', html_url: 'https://github.com/me/mine' });
    throw new Error(path);
  };
  const result = await githubClient.createFork('author/template', 'token', 'mine');
  assert.equal(result.id, 77); assert.ok(!calls.some(c => c.init.method === 'POST'));
});

test('history requests the bound repository ID, slash branch and selected page without stale caching', async () => {
  handler = (path) => path === '/repos/me/mine' ? response({ id: 77, owner: { login: 'me' }, name: 'mine', default_branch: 'main' }) : response([{ sha: 'old', commit: { message: 'previous', author: { name: 'author', date: 'yesterday' } }, html_url: 'https://github.com/me/mine/commit/old' }]);
  const history = await githubClient.listHistory({ id: 77, owner: 'me', repo: 'mine', branch: 'feature/demo' }, 'token', 2);
  assert.equal(history[0].sha, 'old');
  assert.ok(calls.some(c => c.path.endsWith('/commits?sha=feature%2Fdemo&per_page=30&page=2') && c.init.cache === 'no-store'));
});

test('complete Fork fills a missing branch without overwriting an existing branch', async () => {
  let added = false;
  handler = (path, init) => {
    if (path === '/user') return response({ login: 'me' });
    if (path === '/repos/author/template') return response({ id: 42, default_branch: 'main' });
    if (path.startsWith('/repos/author/template/branches?')) return response([{ name: 'main' }, { name: 'feature/demo' }]);
    if (path === '/repos/me/mine') return response({ id: 77, name: 'mine', fork: true, owner: { login: 'me' }, parent: { id: 42 }, default_branch: 'main', html_url: 'https://github.com/me/mine' });
    if (path.startsWith('/repos/me/mine/branches?')) return response(added ? [{ name: 'main' }, { name: 'feature/demo' }] : [{ name: 'main' }]);
    if (path.endsWith('/commits/feature%2Fdemo')) return response({ sha: 'feature-head' });
    if (path === '/repos/me/mine/git/refs') { assert.deepEqual(JSON.parse(init.body as string), { ref: 'refs/heads/feature/demo', sha: 'feature-head' }); added = true; return response({}); }
    throw new Error(path);
  };
  const result = await githubClient.createFork('author/template', 'token', 'mine');
  assert.equal(result.branches.length, 2); assert.ok(!calls.some(c => c.init.method === 'PATCH' || c.path.endsWith('/forks')));
});

test('complete Fork refuses an unrelated existing repository without writing to it', async () => {
  handler = path => {
    if (path === '/user') return response({ login: 'me' });
    if (path === '/repos/author/template') return response({ id: 42, default_branch: 'main' });
    if (path.includes('/branches?')) return response([{ name: 'main' }]);
    return response({ id: 77, name: 'mine', fork: false });
  };
  await assert.rejects(() => githubClient.createFork('author/template', 'token', 'mine'), /名称已被其他仓库占用/);
  assert.ok(!calls.some(c => ['POST', 'PATCH'].includes(c.init.method || '')));
});

test('all-branch synchronization replaces file snapshots and appends target history for every upstream branch', async () => {
  const heads: Record<string, string> = { main: 'old-main', 'feature/demo': 'old-feature' };
  let commitIndex = 0;
  handler = (path, init) => {
    if (path === '/repos/me/mine') return response({ id: 77, fork: true, parent: { owner: { login: 'author' }, name: 'template' } });
    if (path === '/repos/author/template') return response({ default_branch: 'main' });
    if (path.includes('/branches?')) return response([{ name: 'main' }, { name: 'feature/demo' }]);
    if (path.startsWith('/repos/author/template/commits/')) return response({ sha: 'upstream-' + path.split('/').pop(), commit: { tree: { sha: 'source-tree' }, message: 'upstream', author: {} } });
    if (path.includes('/author/template/git/trees/')) return response({ tree: [{ path: 'a.txt', type: 'blob', mode: '100644', sha: sha('new'), size: 3 }] });
    if (path.includes('/author/template/git/blobs/')) return response({ encoding: 'base64', content: Buffer.from('new').toString('base64') });
    if (path.includes('/git/ref/heads/')) return response({ object: { sha: heads[decodeURIComponent(path.split('/heads/')[1])] } });
    if (path.includes('/git/commits/')) return response({ tree: { sha: path.includes('/old-') ? 'old-tree' : 'new-tree' } });
    if (path.includes('/git/trees/old-tree')) return response({ tree: [{ path: 'deleted.txt', type: 'blob', mode: '100644', sha: sha('remove') }] });
    if (path.endsWith('/git/blobs')) return response({ sha: sha('new') });
    if (path.endsWith('/git/trees')) {
      const payload = JSON.parse(init.body as string); assert.equal(payload.base_tree, undefined); assert.deepEqual(payload.tree.map((f: any) => f.path), ['a.txt']);
      return response({ sha: 'new-tree' });
    }
    if (path.endsWith('/git/commits')) return response({ sha: `saved-${++commitIndex}` });
    if (path.includes('/git/refs/heads/')) {
      const payload = JSON.parse(init.body as string); assert.equal(payload.force, false); heads[decodeURIComponent(path.split('/heads/')[1])] = payload.sha; return response({});
    }
    throw new Error(path);
  };
  const results = await githubClient.syncAllForkBranches('me', 'mine', 'token');
  assert.deepEqual(results.map(r => r.success), [true, true]);
  assert.ok(results.every(r => r.sourceSha && r.commitSha));
  const parents = calls.filter(c => c.path.endsWith('/git/commits') && c.init.method === 'POST').map(c => JSON.parse(c.init.body as string).parents);
  assert.deepEqual(parents, [['old-main'], ['old-feature']]);
});
