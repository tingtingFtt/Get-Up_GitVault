import { dom } from './dom';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { localCache } from '../src/utils/localCache';
import { beginGithubOperation, githubClient } from '../src/utils/githubClient';
import App from '../src/App';

const originalFetch = globalThis.fetch;
const withoutTargetHealth = (saved: string | null) => JSON.stringify(JSON.parse(saved!).map(({ targetHealth, ...project }: any) => project));
const sha = (s: string) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const file = (content: string) => ({ path: 'a.txt', content, isBase64: false, sha: sha(content), mode: '100644' });
const entry = (content: string) => ({ path: 'a.txt', sha: sha(content), mode: '100644', type: 'blob', size: content.length });

function importAssociationFixture(options: { changedId?: boolean; full?: boolean; delayedComparison?: boolean; missingBranch?: string } = {}) {
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    if (path === '/repos/source/project' || path === '/repos/demo/other') {
      requests.push({ path, payload: null });
      return ok({ id: 42, name: 'project', owner: { login: 'source' }, default_branch: 'develop', html_url: 'https://github.com/source/project' });
    }
    if (path.includes('/repos/source/project/commits/') || path.includes('/repos/demo/other/commits/')) {
      requests.push({ path, payload: null });
      return ok({ sha: 'import-new', commit: { tree: { sha: 'import-tree' }, message: 'imported newest', author: {} } });
    }
    if (path === '/repos/destination/backup') {
      requests.push({ path, payload: null });
      return ok({ id: options.changedId ? 99 : 77, owner: { login: 'destination' }, name: 'backup', default_branch: 'main', html_url: 'https://github.com/destination/backup', ...(options.full ? { fork: true, parent: { full_name: 'source/project' } } : {}) });
    }
    if (path === '/repos/destination/backup/commits/release') {
      requests.push({ path, payload: null });
      if (options.delayedComparison) return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
      return ok({ sha: 'target-current', commit: { tree: { sha: 'compare-tree' } } });
    }
    if (options.missingBranch && path === '/repos/destination/backup/commits/' + encodeURIComponent(options.missingBranch)) return ok({ message: 'Not Found' }, 404);
    if (options.missingBranch && path.startsWith('/repos/destination/backup/branches?')) return ok([{ name: 'main' }, { name: 'release' }]);
    if (path.includes('/git/trees/import-tree')) { requests.push({ path, payload: null }); return ok({ tree: [entry('latest')] }); }
    if (path.includes('/git/trees/compare-tree')) { requests.push({ path, payload: null }); return ok({ tree: [entry('old'), { ...entry('delete'), path: 'deleted.txt' }] }); }
    if (path.includes('/git/blobs/')) {
      const content = ['latest', 'old', 'delete'].find(value => path.endsWith(sha(value)));
      if (content) { requests.push({ path, payload: null }); return ok({ encoding: 'base64', content: Buffer.from(content).toString('base64') }); }
    }
    return base(url, init);
  };
}
const importDialog = () => document.querySelector('[aria-label="选择已有项目作为同步基础"]');
async function beginMatchingImport(batch = false) {
  await click('新建链接/拉取项目');
  if (batch) {
    await click('批量导入链接');
    await setField(document.querySelector<HTMLTextAreaElement>('[aria-label="批量仓库链接"]')!, '新备注  source/project\ndemo/other');
    await click('开始批量导入');
  } else {
    await input('https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo', 'source/project');
    await input('例如: 生产核心源码 / 模块A', '新备注');
    await click('确认拉取进入本地');
  }
  await waitFor(() => !!importDialog());
}
const repo = () => ({ id: 'tracked', url: 'https://github.com/source/project', owner: 'source', repo: 'project', branch: 'develop', token: 'fake-test-token', remark: 'test project', description: '', tags: ['默认'], checkInterval: 0, latestCommitSha: 'v2', commitMessage: 'new', commitAuthor: 'author', commitDate: '2026-10-15T00:00:00Z', lastSyncedAt: '2026-10-15T00:00:00Z', repoMeta: { htmlUrl: 'https://github.com/source/project' }, tree: [entry('new')], cachedFilesCount: 1, isCachePurged: false, backups: [{ id: 'old', versionNumber: 1, tag: 'v1', annotation: 'old version', commitSha: 'v1', commitMessage: 'old', commitAuthor: 'author', commitDate: '2026-10-14T00:00:00Z', backedUpAt: '2026-10-15T00:00:00Z', tree: [entry('old')] }] });
let root: Root;
let alerts: string[];
let requests: Array<{ path: string; payload: any }>;
let failUpload: boolean;
let rejectionStatus: number;
let uploadedContents: string[];
const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(async () => {
  beginGithubOperation(); localStorage.clear(); document.body.innerHTML = '<div id="root"></div>';
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('GitVault_Storage_v1'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  alerts = []; requests = []; uploadedContents = []; failUpload = false; rejectionStatus = 403;
  (globalThis as any).alert = (message: string) => alerts.push(message);
  (globalThis as any).confirm = () => true;
  (globalThis as any).prompt = () => 'fake-test-token';
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).replace('https://api.github.com', '');
    const payload = init.body ? JSON.parse(init.body as string) : null;
    requests.push({ path, payload });
    if (path === '/repos/destination/backup') return ok({ default_branch: 'main' });
    if (path === '/repos/destination/backup/git/ref/heads/release') return ok({ object: { sha: !failUpload && requests.some(r => r.path.endsWith('/git/refs/heads/release')) ? 'uploaded' : 'parent' } });
    if (path === '/repos/destination/backup/git/ref/heads/develop') return requests.some(r => r.payload?.ref === 'refs/heads/develop') ? ok({ object: { sha: 'uploaded' } }) : ok({ message: 'Not Found' }, 404);
    if (path === '/repos/destination/backup/git/refs') return ok({ object: { sha: 'uploaded' } });
    if (path.endsWith('/git/commits/parent')) return ok({ tree: { sha: 'old-tree' } });
    if (path.includes('/git/trees/old-tree')) return ok({ tree: [] });
    if (path.endsWith('/git/blobs')) { uploadedContents.push(payload.content); return ok({ sha: sha(payload.content) }); }
    if (path.endsWith('/git/trees')) return ok({ sha: 'uploaded-tree' });
    if (path.endsWith('/git/commits')) return ok({ sha: 'uploaded' });
    if (path.endsWith('/git/refs/heads/release')) return failUpload ? ok({ message: rejectionStatus === 422 ? 'Update is not a fast forward' : 'rejected' }, rejectionStatus) : ok({ object: { sha: 'uploaded' } });
    if (path.endsWith('/git/commits/uploaded')) return ok({ tree: { sha: 'uploaded-tree' } });
    if (path.endsWith('/forks')) return ok({ owner: { login: 'me' }, name: 'project-fork', default_branch: 'develop', html_url: 'https://github.com/me/project-fork' });
    if (path === '/repos/me/project-fork') return ok({ fork: true, parent: { full_name: 'source/project' }, default_branch: 'develop' });
    if (path.endsWith('/merge-upstream')) return ok({ message: 'synced' });
    throw new Error('Unexpected request: ' + path);
  };
  localStorage.setItem('gitvault_repos_v8', JSON.stringify([repo()]));
  await localCache.saveProjectFiles('tracked', [file('old')], 'v1');
  await localCache.saveProjectFiles('tracked', [file('new')], 'v2');
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(React.createElement(App)); });
});
afterEach(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; });

const storedProjects = () => JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
const targetManager = () => document.querySelector('[aria-label="管理远端目标"]');
function deletedTargetFixture(options: { recreate?: boolean; restoreSource?: boolean; missingSource?: boolean } = {}) {
  const base = globalThis.fetch; let recreated = false;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    if (path === '/repos/destination/backup') {
      requests.push({ path, payload: null });
      return recreated ? ok({ id: 99, private: true, name: 'backup', owner: { login: 'destination' }, default_branch: 'main', html_url: 'https://github.com/destination/backup' }) : ok({ message: 'Not Found' }, 404);
    }
    if (options.recreate && path === '/user') return ok({ login: 'destination' });
    if (options.recreate && path === '/user/repos') { recreated = true; requests.push({ path, payload: JSON.parse(init.body as string) }); return ok({ id: 99, name: 'backup', owner: { login: 'destination' }, default_branch: 'main', html_url: 'https://github.com/destination/backup' }); }
    if (options.recreate && path === '/repos/source/project/commits/develop') return ok({ sha: 'v2', commit: { message: 'new', author: {} } });
    if (options.restoreSource && path === '/repos/source/project') return ok({ id: 42, default_branch: 'develop' });
    if (options.restoreSource && path === '/repos/source/project/commits/v2') { requests.push({ path, payload: null }); return options.missingSource ? ok({ message: 'Not Found' }, 404) : ok({ sha: 'v2', commit: { tree: { sha: 'recovered-source-tree' }, message: 'new', author: {} } }); }
    if (path.includes('/git/trees/recovered-source-tree')) return ok({ tree: [entry('new')] });
    if (path.includes('/git/blobs/') && path.endsWith(sha('new'))) return ok({ encoding: 'base64', content: Buffer.from('new').toString('base64') });
    return base(url, init);
  };
}
async function openDeletedTargetManager() {
  await enterWorkbench();
  await waitFor(() => storedProjects()[0].targetHealth?.['id:77']?.status === 'unavailable');
  await click('管理远端目标');
}
test('a deleted or inaccessible target is detected on workbench entry and update fails with a recovery action without removing data', async () => {
  await reloadProject(boundProject()); deletedTargetFixture();
  await enterWorkbench(); await waitFor(() => storedProjects()[0].targetHealth?.['id:77']?.status === 'unavailable');
  assert.ok(document.body.textContent?.includes('可能已删除'));
  await click('一键更新'); await waitFor(() => alerts.length > 0);
  assert.equal(storedProjects()[0].uploadTarget.id, 77); assert.equal(storedProjects()[0].backups.length, 1);
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.ok(requests.every(request => request.payload === null));
  assert.ok(!requests.some(request => request.path.includes('/commits/')));
});
test('updating the target Token restores access for every shared binding without changing global or source credentials', async () => {
  const first = boundProject(), second = { ...repo(), id: 'fork-reference', forkTarget: { id: 77, owner: 'destination', repo: 'backup', branch: 'develop', htmlUrl: 'https://github.com/destination/backup', branches: ['develop'] } };
  await reloadProjects([first, second]);
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === 'https://api.github.com/repos/destination/backup') return (init.headers as any)?.Authorization === 'Bearer replacement-token' ? ok({ id: 77, owner: { login: 'destination' }, name: 'backup' }) : ok({ message: 'Not Found' }, 404);
    return base(url, init);
  };
  await openDeletedTargetManager();
  await setField(document.querySelector<HTMLInputElement>('[aria-label="远端目标 Token"]')!, 'replacement-token');
  await click('应用 Token 并重新检测'); await waitFor(() => storedProjects()[0].uploadTarget.token === 'replacement-token');
  assert.equal(storedProjects()[0].targetHealth['id:77'].status, 'available');
  assert.equal(storedProjects()[1].forkTarget.token, 'replacement-token');
  assert.equal(storedProjects()[0].token, 'fake-test-token'); assert.equal(localStorage.getItem('gitvault_global_token'), null);
  assert.equal(storedProjects()[0].uploadTarget.id, 77); assert.ok(!targetManager()?.textContent?.includes('目标无法访问'));
});
test('a late failed background check cannot overwrite a successful Token repair', async () => {
  await reloadProject(boundProject());
  const base = globalThis.fetch; let completeOldCheck: (() => void) | undefined;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === 'https://api.github.com/repos/destination/backup') {
      if ((init.headers as any)?.Authorization === 'Bearer repaired-token') return ok({ id: 77, name: 'backup', owner: { login: 'destination' } });
      return new Promise<Response>(resolve => { completeOldCheck = () => resolve(ok({ message: 'Not Found' }, 404)); });
    }
    return base(url, init);
  };
  await enterWorkbench(); await waitFor(() => !!completeOldCheck); await click('管理远端目标');
  await setField(document.querySelector<HTMLInputElement>('[aria-label="远端目标 Token"]')!, 'repaired-token');
  await click('应用 Token 并重新检测'); await waitFor(() => storedProjects()[0].uploadTarget.token === 'repaired-token');
  await act(async () => { completeOldCheck!(); await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(storedProjects()[0].targetHealth['id:77'].status, 'available');
  assert.equal(storedProjects()[0].uploadTarget.id, 77);
});
test('system backup excludes repaired Fork, branch, upload and source credentials', async () => {
  const saved = boundProject();
  saved.branchTargets = { develop: { ...saved.uploadTarget, token: 'branch-secret' } };
  saved.forkTarget = { ...saved.uploadTarget, token: 'fork-secret', htmlUrl: 'old' };
  await reloadProject(saved);
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, anchorClick = dom.window.HTMLAnchorElement.prototype.click;
  let exported: Blob | undefined;
  URL.createObjectURL = blob => { exported = blob as Blob; return 'blob:backup'; };
  URL.revokeObjectURL = () => {}; dom.window.HTMLAnchorElement.prototype.click = () => {};
  try {
    await click('设置'); await click('数据备份与恢复');
    const exportButton = buttons().find(button => button.textContent?.includes('导出全量备份 (JSON)'))!;
    assert.ok(exportButton); await act(async () => exportButton.click());
    assert.ok(exported);
    const content = await exported.text();
    for (const secret of ['target-token', 'branch-secret', 'fork-secret', 'fake-test-token']) assert.ok(!content.includes(secret));
    assert.equal(JSON.parse(content).projects[0].forkTarget.id, 77);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; dom.window.HTMLAnchorElement.prototype.click = anchorClick; }
});
test('detaching a missing target clears its shared branch and Fork bindings while keeping other targets, history and version caches', async () => {
  const first = boundProject();
  first.branchTargets = { develop: first.uploadTarget, feature: { ...first.uploadTarget, branch: 'feature' }, other: { ...first.uploadTarget, id: 88, repo: 'another', branch: 'other' } };
  first.forkTarget = { ...first.uploadTarget, htmlUrl: 'old', branches: ['develop', 'feature'] };
  first.remoteSnapshot = { repoId: 77, owner: 'destination', repo: 'backup', branch: 'release', commitSha: 'target-v2', sourceSha: 'v2', htmlUrl: 'old' };
  const managed = { ...first, id: 'managed', owner: 'destination', repo: 'backup', origin: { owner: 'source', repo: 'project', branch: 'develop', url: 'https://github.com/source/project' }, forkScope: 'full' };
  await reloadProjects([first, managed]); deletedTargetFixture();
  await openDeletedTargetManager();
  await click('解除此目标的所有绑定');
  await waitFor(() => !storedProjects()[0].uploadTarget);
  const saved = storedProjects();
  assert.equal(saved[0].forkTarget, undefined); assert.deepEqual(Object.keys(saved[0].branchTargets), ['other']);
  assert.equal(saved[0].remoteSnapshot.commitSha, 'target-v2'); assert.deepEqual(saved[0].backups, first.backups);
  assert.equal(saved[1].owner, 'source'); assert.equal(saved[1].forkScope, undefined); assert.equal(saved[1].origin.repo, 'project');
  assert.equal((await localCache.getProjectFiles('tracked', 'v1'))[0].content, 'old');
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.ok(targetManager()?.textContent?.includes('2 个记录'));
});
test('refusing detach confirmation keeps every binding intact', async () => {
  await reloadProject(boundProject()); deletedTargetFixture(); await openDeletedTargetManager();
  const before = localStorage.getItem('gitvault_repos_v8');
  (globalThis as any).confirm = () => false; await click('解除此目标的所有绑定');
  assert.equal(localStorage.getItem('gitvault_repos_v8'), before);
});
test('after detaching a deleted upload users can recreate the same repository name with a new ID and upload only the source branch', async () => {
  const saved = boundProject(); saved.privateRepoUrl = 'https://github.com/destination/backup';
  await reloadProject(saved); deletedTargetFixture({ recreate: true }); await openDeletedTargetManager();
  await click('解除此目标的所有绑定'); await click('重新设置上传');
  const name = [...document.querySelectorAll<HTMLInputElement>('input')].find(field => field.value === 'backup')!;
  assert.equal(name.readOnly, false);
  await click('立即新建私人仓库并上传'); await waitFor(() => storedProjects()[0].remoteSnapshot?.repoId === 99);
  assert.equal(storedProjects()[0].uploadTarget.branch, 'develop'); assert.equal(storedProjects()[0].targetHealth['id:99'].status, 'available');
  assert.equal(storedProjects()[0].backups.length, 1); assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.ok(!requests.some(request => request.path.includes('/git/refs/heads/release')));
  const previousAlerts = alerts.length; await click('同步上游'); await waitFor(() => alerts.length > previousAlerts);
  assert.ok(alerts.at(-1)?.includes('当前已是最新版本'));
  assert.ok(!requests.some(request => request.path.endsWith('/merge-upstream')));
});
test('purged source can be recovered from its exact original commit after the old target is deleted and recreated under the same name', async () => {
  const saved = boundProject(); saved.isCachePurged = true; saved.cachedFilesCount = 0;
  saved.remoteSnapshot = { repoId: 77, owner: 'destination', repo: 'backup', branch: 'release', commitSha: 'deleted-target-commit', sourceSha: 'v2', htmlUrl: 'old' };
  await localCache.deleteProjectFiles('tracked', 'v2'); await reloadProject(saved);
  deletedTargetFixture({ recreate: true, restoreSource: true }); await openDeletedTargetManager();
  await click('解除此目标的所有绑定'); await click('重新设置上传'); await click('立即新建私人仓库并上传');
  await waitFor(() => storedProjects()[0].remoteSnapshot?.repoId === 99);
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.equal(storedProjects()[0].isCachePurged, false); assert.ok(requests.some(request => request.path === '/repos/source/project/commits/v2'));
  assert.ok(!requests.some(request => request.path.includes('/commits/deleted-target-commit')));
  assert.ok(storedProjects()[0].backups.some((version: any) => version.remoteSnapshot?.repoId === 77));
});
test('unrecoverable purged versions stay recorded and are never marked as uploaded to a new target', async () => {
  const saved = boundProject(); saved.isCachePurged = true;
  saved.remoteSnapshot = { repoId: 77, owner: 'destination', repo: 'backup', branch: 'release', commitSha: 'deleted-target-commit', sourceSha: 'v2', htmlUrl: 'old' };
  await localCache.deleteProjectFiles('tracked', 'v2'); await reloadProject(saved);
  deletedTargetFixture({ recreate: true, restoreSource: true, missingSource: true }); await openDeletedTargetManager();
  await click('解除此目标的所有绑定'); await click('重新设置上传'); await click('立即新建私人仓库并上传');
  await waitFor(() => alerts.some(message => message.includes('原始提交也未能完整恢复')));
  assert.equal(storedProjects()[0].uploadTarget, undefined); assert.equal(storedProjects()[0].remoteSnapshot.repoId, 77);
  assert.equal(storedProjects()[0].backups.length, 1); assert.equal(storedProjects()[0].isCachePurged, true);
  assert.ok(!requests.some(request => request.path.endsWith('/git/commits') || request.path.endsWith('/git/blobs')));
});
test('a deleted full Fork can be detached and recreated from the original upstream', async () => {
  const saved = boundProject(); saved.forkScope = 'full'; saved.forkTarget = { ...saved.uploadTarget, htmlUrl: 'old', branches: ['develop', 'other'] };
  await reloadProject(saved); deletedTargetFixture(); await openDeletedTargetManager();
  await click('解除此目标的所有绑定'); await click('重新创建分叉');
  completeForkFixture(); await input('project', 'project'); await click('完整分叉并加入我的项目');
  await waitFor(() => storedProjects().some((project: any) => project.origin && project.forkTarget?.repo === 'project'));
  assert.equal(requests.find(request => request.path.endsWith('/forks'))?.path, '/repos/source/project/forks');
  assert.equal(storedProjects().find((project: any) => project.id === 'tracked').backups.length, 1);
});

test('matching link waits for a choice, compares target files, reuses its fixed name and preserves old history before later upload', async () => {
  await reloadProject(boundProject()); importAssociationFixture();
  const before = localStorage.getItem('gitvault_repos_v8');
  await beginMatchingImport();
  assert.equal(localStorage.getItem('gitvault_repos_v8'), before);
  assert.ok(!requests.some(r => r.path.includes('/zipball/') || r.path.includes('/git/blobs/')));
  assert.equal(buttons().find(b => b.textContent === '沿用上传目标')?.disabled, true);
  await click('对比此项目');
  await waitFor(() => importDialog()?.textContent?.includes('新增 0 · 修改 1 · 删除 1') === true);
  assert.ok(importDialog()?.textContent?.includes('develop → release'));
  assert.ok(requests.every(r => r.payload === null));
  await click('沿用上传目标'); await waitFor(() => !importDialog() && alerts.length > 0);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved.length, 1); assert.equal(saved[0].id, 'tracked'); assert.equal(saved[0].uploadTarget.id, 77);
  assert.equal(saved[0].uploadTarget.repo, 'backup'); assert.equal(saved[0].uploadTarget.branch, 'release');
  assert.equal(saved[0].latestCommitSha, 'import-new'); assert.equal(saved[0].backups.length, 2);
  assert.equal(saved[0].backups[0].commitSha, 'v2'); assert.equal(saved[0].remoteSnapshot, undefined);
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.equal((await localCache.getProjectFiles('tracked', 'import-new'))[0].content, 'latest');
  await enterWorkbench(); await click('分叉与私有仓'); await click('更新已绑定仓库（保留历史）');
  await waitFor(() => JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].remoteSnapshot?.commitSha === 'uploaded');
  assert.ok(!requests.some(r => r.path === '/user/repos' || r.path === '/user'));
});
test('choosing independent import never inherits an upload or Fork binding or changes the existing project', async () => {
  await reloadProject(boundProject()); importAssociationFixture();
  const previous = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  await beginMatchingImport(); await click('独立导入，不关联'); await waitFor(() => alerts.length > 0);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved.length, 2); assert.equal(saved[0].uploadTarget, undefined); assert.equal(saved[0].forkTarget, undefined);
  assert.deepEqual(saved.find((project: any) => project.id === 'tracked'), previous);
  assert.ok(requests.every(r => r.payload === null));
});
test('importing the destination URL can explicitly resume the original source instead of tracking the destination as its own upstream', async () => {
  await reloadProject(boundProject()); importAssociationFixture();
  await click('新建链接/拉取项目');
  await input('https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo', 'destination/backup');
  await input('例如: 生产核心源码 / 模块A', '续用已有上传');
  await input('留空自动识别（支持链接指定分支）', 'release');
  await click('确认拉取进入本地'); await waitFor(() => !!importDialog());
  await click('对比此项目'); await waitFor(() => buttons().some(b => b.textContent === '沿用上传目标' && !b.disabled));
  assert.ok(importDialog()?.textContent?.includes('原始来源：source/project'));
  await click('沿用上传目标'); await waitFor(() => alerts.length > 0);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved.length, 1); assert.equal(saved[0].url, 'https://github.com/source/project');
  assert.equal(saved[0].owner, 'source'); assert.equal(saved[0].branch, 'develop');
  assert.equal(saved[0].latestCommitSha, 'import-new'); assert.equal(saved[0].uploadTarget.branch, 'release');
  assert.equal((await localCache.getProjectFiles('tracked', 'import-new'))[0].content, 'latest');
  assert.ok(requests.every(r => r.payload === null));
});
test('importing another source branch reuses the destination repository but plans a matching new branch without overwriting the existing branch', async () => {
  await reloadProject(boundProject()); importAssociationFixture({ missingBranch: 'feature/demo' });
  await click('新建链接/拉取项目');
  await input('https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo', 'source/project');
  await input('例如: 生产核心源码 / 模块A', '新分支');
  await input('留空自动识别（支持链接指定分支）', 'feature/demo');
  await click('确认拉取进入本地'); await waitFor(() => !!importDialog());
  await click('对比此项目'); await waitFor(() => importDialog()?.textContent?.includes('后续上传时新建') === true);
  await click('沿用上传目标'); await waitFor(() => alerts.length > 0);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved.length, 2);
  const feature = saved.find((project: any) => project.branch === 'feature/demo');
  assert.equal(feature.uploadTarget.repo, 'backup'); assert.equal(feature.uploadTarget.branch, 'feature/demo'); assert.equal(feature.branchUploadPending, true);
  assert.equal(saved.find((project: any) => project.id === 'tracked').uploadTarget.branch, 'release');
  assert.ok(requests.every(r => r.payload === null));
});
test('failed identity comparison cannot be accepted and skipping leaves all project records unchanged', async () => {
  await reloadProject(boundProject()); importAssociationFixture({ changedId: true });
  const previous = localStorage.getItem('gitvault_repos_v8');
  await beginMatchingImport(); await click('对比此项目');
  await waitFor(() => importDialog()?.textContent?.includes('身份已变化') === true);
  assert.equal(buttons().find(b => b.textContent === '沿用上传目标')?.disabled, true);
  await click('跳过此链接'); await waitFor(() => !importDialog());
  assert.equal(withoutTargetHealth(localStorage.getItem('gitvault_repos_v8')), withoutTargetHealth(previous));
  assert.equal(JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].targetHealth['id:77'].status, 'identity-changed');
  assert.ok(!requests.some(r => r.path.endsWith('/commits/release')));
  assert.ok(!requests.some(r => r.path.includes('/zipball/') || r.path.includes('/git/blobs/')));
});
test('batch import waits for each existing target decision, then continues the remaining links', async () => {
  const existing = boundProject(); existing.tags = ['保留已有标签'];
  await reloadProject(existing); importAssociationFixture();
  await beginMatchingImport(true);
  assert.ok(!requests.some(r => r.path === '/repos/demo/other'));
  await click('对比此项目'); await waitFor(() => buttons().some(b => b.textContent === '沿用上传目标' && !b.disabled));
  await click('沿用上传目标');
  await waitFor(() => document.querySelector('[role=status]')?.textContent === '成功 2 · 跳过 0 · 失败 0');
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved.length, 2); assert.equal(saved.find((p: any) => p.id === 'tracked').remark, '新备注');
  assert.deepEqual(saved.find((p: any) => p.id === 'tracked').tags, ['保留已有标签']);
  assert.equal(saved.find((p: any) => p.owner === 'demo').remark, '');
  assert.ok(requests.every(r => r.payload === null));
});
test('cancelling during comparison stops the batch and leaves both links retryable without stale bindings', async () => {
  await reloadProject(boundProject()); importAssociationFixture({ delayedComparison: true });
  const previous = localStorage.getItem('gitvault_repos_v8');
  await beginMatchingImport(true); await click('对比此项目');
  await waitFor(() => requests.some(r => r.path.endsWith('/commits/release')));
  await click('取消本次导入');
  await waitFor(() => !importDialog() && document.querySelector('[role=status]')?.textContent === '成功 0 · 跳过 0 · 失败 2');
  assert.equal(withoutTargetHealth(localStorage.getItem('gitvault_repos_v8')), withoutTargetHealth(previous));
  assert.ok(!requests.some(r => r.path === '/repos/demo/other'));
  importAssociationFixture(); await click('重试失败链接'); await waitFor(() => !!importDialog());
  await click('跳过此链接');
  await waitFor(() => document.querySelector('[role=status]')?.textContent === '成功 1 · 跳过 1 · 失败 0');
});
test('native Fork reuse verifies the upstream and routes subsequent all-branch sync to that existing Fork', async () => {
  const saved = boundProject(); saved.uploadTarget.kind = 'full'; saved.forkTarget = { ...saved.uploadTarget, htmlUrl: 'https://github.com/destination/backup', branches: ['develop', 'other'] };
  await reloadProject(saved); importAssociationFixture({ full: true });
  await beginMatchingImport(); await click('对比此项目');
  await waitFor(() => buttons().some(b => b.textContent === '沿用分叉同步' && !b.disabled));
  await click('沿用分叉同步'); await waitFor(() => alerts.length > 0);
  const updated = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(updated.forkTarget.repo, 'backup'); assert.equal(updated.forkScope, 'full');
  assert.deepEqual(updated.forkTarget.branches, ['develop', 'other']);
  assert.ok(requests.every(r => r.payload === null));
  let called = '';
  const original = githubClient.syncAllForkBranches;
  githubClient.syncAllForkBranches = async (owner, name) => { called = `${owner}/${name}`; return [{ branch: 'develop', success: true }]; };
  try { await enterWorkbench(); await click('同步上游'); await waitFor(() => called !== ''); assert.equal(called, 'destination/backup'); }
  finally { githubClient.syncAllForkBranches = original; }
});
test('comparison refuses a target branch already bound to another project even when the branch names match', async () => {
  const unrelated = { ...boundProject(), id: 'unrelated', owner: 'unrelated', url: 'https://github.com/unrelated/project' };
  await reloadProjects([boundProject(), unrelated]); importAssociationFixture();
  await beginMatchingImport(); await click('对比此项目');
  await waitFor(() => importDialog()?.textContent?.includes('unrelated/project') === true);
  assert.equal(buttons().find(b => b.textContent === '沿用上传目标')?.disabled, true);
  await click('跳过此链接');
});
const buttons = () => [...document.querySelectorAll('button')];
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  assert.ok(check(), JSON.stringify({ alerts, requests }));
}

async function click(text: string) {
  const button = buttons().find(b => b.textContent?.trim() === text);
  assert.ok(button, `Missing button ${text}`);
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
async function enterWorkbench() {
  // Dashboard and projects both expose the existing workbench button.
  const workbench = buttons().find(b => b.textContent?.trim() === '工作台');
  if (!workbench) await click('项目库');
  await click('工作台');
}
async function input(placeholder: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  assert.ok(field, placeholder);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function upload(purge: boolean) {
  await click('上传指定仓库');
  await input('owner/repo', 'destination/backup');
  await input('留空使用当前来源分支', 'release');
  const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(e => e.parentElement?.textContent?.includes('上传验证成功后清理'))!;
  if (purge) await act(async () => checkbox.click());
  const submit = buttons().find(b => b.textContent === '确认上传')!;
  await act(async () => { submit.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 50)); });
}

test('historical file view reads its exact version rather than current cache', async () => {
  await enterWorkbench();
  await click('版本归档库 (1)');
  await click('查看此版本');
  const row = [...document.querySelectorAll('span')].find(s => s.textContent === 'a.txt')!;
  assert.ok(row);
  await act(async () => { row.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 20)); });
  await waitFor(() => document.querySelector('pre')?.textContent === 'old');
});

test('verified upload with keep option retains cache and records remote commit', async () => {
  await enterWorkbench(); await upload(false);
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.ok(saved.remoteSnapshot, JSON.stringify({ alerts, requests }));
  assert.equal(saved.remoteSnapshot.commitSha, 'uploaded');
  assert.equal(saved.uploadTarget.branch, 'release');
  assert.ok(uploadedContents.includes('new'));
});

test('verified upload with purge removes only selected contents and keeps manifest', async () => {
  await enterWorkbench(); await upload(true);
  assert.equal((await localCache.getProjectFiles('tracked', 'v2')).length, 0);
  assert.equal((await localCache.getProjectFiles('tracked', 'v1'))[0].content, 'old');
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.isCachePurged, true); assert.equal(saved.tree.length, 1); assert.equal(saved.backups[0].tree.length, 1);
});

test('rejected upload preserves local files even when cleanup is selected', async () => {
  failUpload = true; await enterWorkbench(); await upload(true);
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.equal(JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].remoteSnapshot, undefined);
  assert.ok(alerts.some(text => text.includes('上传未完成')));
});

test('upstream synchronization uses the stored Fork identity', async () => {
  const saved = repo() as any;
  saved.forkTarget = { owner: 'me', repo: 'project-fork', branch: 'develop', htmlUrl: 'https://github.com/me/project-fork' };
  await act(async () => { root.unmount(); });
  localStorage.setItem('gitvault_repos_v8', JSON.stringify([saved]));
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(React.createElement(App)));
  await enterWorkbench(); await click('同步上游');
  assert.ok(requests.some(r => r.path === '/repos/me/project-fork/merge-upstream'));
  assert.ok(!requests.some(r => r.path === '/repos/source/project/merge-upstream'));
});

test('updates save new content, retain old version, and upload to the remembered branch', async () => {
  const saved = repo() as any;
  saved.uploadTarget = { owner: 'destination', repo: 'backup', branch: 'release', purgeAfterUpload: false, token: 'target-token' };
  await act(async () => root.unmount());
  localStorage.setItem('gitvault_repos_v8', JSON.stringify([saved]));
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path.endsWith('/repos/source/project')) return ok({ default_branch: 'develop', html_url: 'https://github.com/source/project' });
    if (path.includes('/repos/source/project/commits/')) return ok({ sha: 'v3', commit: { tree: { sha: 'v3-tree' }, message: 'newest', author: { name: 'author', date: '2026-10-16' } } });
    if (path.includes('/repos/source/project/git/trees/')) return ok({ tree: [entry('newest')] });
    if (path.includes('/repos/source/project/git/blobs/')) return ok({ content: Buffer.from('newest').toString('base64') });
    return baseFetch(input, init);
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(React.createElement(App)));
  await enterWorkbench(); await click('一键更新');
  await waitFor(() => alerts.length > 0);
  const updated = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(updated.latestCommitSha, 'v3');
  assert.equal(updated.remoteSnapshot.sourceSha, 'v3');
  assert.equal(updated.backups[0].commitSha, 'v2');
  assert.equal((await localCache.getProjectFiles('tracked', 'v3'))[0].content, 'newest');
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.ok(uploadedContents.includes('newest'));
});

test('history upload sends old bytes and purges only that selected version', async () => {
  await enterWorkbench(); await click('版本归档库 (1)'); await click('上传此版本');
  await input('owner/repo', 'destination/backup'); await input('留空使用当前来源分支', 'release');
  const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(e => e.parentElement?.textContent?.includes('上传验证成功后清理'))!;
  await act(async () => checkbox.click());
  const submit = buttons().find(b => b.textContent === '确认上传')!;
  await act(async () => { submit.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 50)); });
  assert.ok(uploadedContents.includes('old')); assert.ok(!uploadedContents.includes('new'));
  assert.equal((await localCache.getProjectFiles('tracked', 'v1')).length, 0);
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  const stored = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(stored.backups[0].remoteSnapshot.sourceSha, 'v1'); assert.equal(stored.backups[0].tree.length, 1);
});

test('purged files are read from the saved destination commit rather than source HEAD', async () => {
  const saved = repo() as any;
  saved.remoteSnapshot = { owner: 'destination', repo: 'backup', branch: 'release', commitSha: 'uploaded', sourceSha: 'v2', htmlUrl: 'target' };
  saved.isCachePurged = true; saved.cachedFilesCount = 0;
  await localCache.deleteProjectFiles('tracked', 'v2');
  await act(async () => root.unmount());
  localStorage.setItem('gitvault_repos_v8', JSON.stringify([saved]));
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).includes('/repos/destination/backup/contents/a.txt?ref=uploaded')) return ok({ type: 'file', sha: sha('new'), encoding: 'base64', content: Buffer.from('new').toString('base64') });
    return baseFetch(input, init);
  };
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(React.createElement(App)));
  await enterWorkbench();
  const row = [...document.querySelectorAll('span')].find(s => s.textContent === 'a.txt')!;
  await act(async () => { row.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 20)); });
  await waitFor(() => !!document.querySelector('pre'));
  assert.equal(document.querySelector('pre')?.textContent, 'new');
});

test('file list can reveal entries beyond the original 150 item limit', async () => {
  const saved = repo();
  saved.tree = Array.from({ length: 160 }, (_, i) => ({ ...entry('new'), path: `file-${i}.txt` }));
  await act(async () => root.unmount());
  localStorage.setItem('gitvault_repos_v8', JSON.stringify([saved]));
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(React.createElement(App)));
  await enterWorkbench();
  assert.ok(!document.body.textContent?.includes('file-159.txt'));
  await click('加载更多文件');
  assert.ok(document.body.textContent?.includes('file-159.txt'));
});

const repositoryPlaceholder = 'https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo';
test('new-link branch lookup displays returned branches and selects the URL branch', async () => {
  globalThis.fetch = async url => String(url).includes('/branches?') ? ok([{ name: 'test' }, { name: 'feature/demo' }, { name: 'main' }]) : ok({ default_branch: 'main' });
  await click('新建链接/拉取项目');
  await input(repositoryPlaceholder, 'https://github.com/demo/project/tree/feature/demo');
  await click('获取全部分支');
  await waitFor(() => !!document.querySelector('select'));
  const select = document.querySelector('select')!;
  assert.deepEqual([...select.options].map(o => o.value), ['main', 'feature/demo', 'test']);
  assert.equal(select.value, 'feature/demo');
  assert.ok(document.querySelector('[role=status]')?.textContent?.includes('3 个分支'));
});

test('new-link branch lookup shows a network error and allows retry', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await click('新建链接/拉取项目'); await input(repositoryPlaceholder, 'demo/project'); await click('获取全部分支');
  await waitFor(() => !!document.querySelector('[role=alert]'));
  assert.ok(document.querySelector('[role=alert]')?.textContent?.includes('无法连接 GitHub 分支接口'));
  assert.equal(buttons().find(b => b.textContent?.trim() === '获取全部分支')?.disabled, false);
  globalThis.fetch = async url => String(url).includes('/branches?') ? ok([{ name: 'main' }]) : ok({ default_branch: 'main' });
  await click('获取全部分支'); await waitFor(() => !!document.querySelector('select'));
  assert.equal(document.querySelector('[role=alert]'), null);
});

test('editing repository URL clears obsolete branches and ignores late responses', async () => {
  let resolveOld: (r: Response) => void = () => {};
  globalThis.fetch = async url => String(url).includes('/demo/old') ? new Promise<Response>(resolve => { resolveOld = resolve; }) : String(url).includes('/branches?') ? ok([{ name: 'develop' }]) : ok({ default_branch: 'develop' });
  await click('新建链接/拉取项目'); await input(repositoryPlaceholder, 'demo/old'); await click('获取全部分支');
  await input(repositoryPlaceholder, 'demo/new'); await click('获取全部分支');
  await waitFor(() => !!document.querySelector('select'));
  await act(async () => { resolveOld(ok({ default_branch: 'old-branch' })); await new Promise(r => setTimeout(r, 20)); });
  assert.equal(document.querySelector('select')?.value, 'develop');
  await input(repositoryPlaceholder, 'demo/third');
  assert.equal(document.querySelector('select'), null);
});

test('branch lookup prompts for a repository URL instead of silently doing nothing', async () => {
  await click('新建链接/拉取项目'); await click('获取全部分支');
  assert.ok(document.querySelector('[role=alert]')?.textContent?.includes('请先填写'));
});


test('non-fast-forward rejection never clears the selected local snapshot', async () => {
  failUpload = true; rejectionStatus = 422;
  await enterWorkbench(); await upload(true);
  await waitFor(() => alerts.length > 0);
  assert.ok(alerts.some(message => message.includes('非快进更新')));
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.equal(JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].remoteSnapshot, undefined);
});

async function reloadProject(saved: any) {
  await act(async () => root.unmount());
  localStorage.setItem('gitvault_repos_v8', JSON.stringify([saved]));
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(React.createElement(App)));
}
function boundProject() {
  const saved = repo() as any;
  saved.uploadTarget = { id: 77, owner: 'destination', repo: 'backup', branch: 'release', purgeAfterUpload: false, token: 'target-token' };
  return saved;
}
function identifyDestination() {
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url) === 'https://api.github.com/repos/destination/backup' ? ok({ id: 77, owner: { login: 'destination' }, name: 'backup', default_branch: 'main', html_url: 'https://github.com/destination/backup' }) : base(url, init);
}

test('batch upload reuses the bound renamed repository and branch without creating another', async () => {
  await reloadProject(boundProject()); identifyDestination();
  (globalThis as any).confirm = () => false;
  await click('仓库已有项目 (1)'); await click('全选所有'); await click('批量上传至私人仓库'); await click('开始批量上传');
  await waitFor(() => document.body.textContent?.includes('成功') === true);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.uploadTarget.repo, 'backup'); assert.equal(saved.uploadTarget.branch, 'release');
  assert.equal(saved.remoteSnapshot.commitSha, 'uploaded');
  assert.ok(!requests.some(r => r.path === '/user/repos' || r.path === '/user'));
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
});

test('single re-upload locks the chosen name and reuses the exact bound branch without creating a repo', async () => {
  await reloadProject(boundProject()); identifyDestination();
  await enterWorkbench(); await click('分叉与私有仓');
  const name = [...document.querySelectorAll<HTMLInputElement>('input')].find(field => field.value === 'backup')!;
  assert.equal(name.readOnly, true);
  await click('更新已绑定仓库（保留历史）');
  // Submitting through the button triggers the form's default action in jsdom.
  await waitFor(() => alerts.length > 0);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.uploadTarget.repo, 'backup'); assert.equal(saved.uploadTarget.branch, 'release');
  assert.ok(!requests.some(r => r.path === '/user/repos' || r.path === '/user'));
  assert.ok(alerts.some(message => message.includes('完整上传')));
});

test('rename button changes the existing repository and rewrites historical links while keeping source identity', async () => {
  const saved = boundProject();
  saved.remoteSnapshot = { repoId: 77, owner: 'destination', repo: 'backup', branch: 'release', sourceSha: 'v2', commitSha: 'previous', htmlUrl: 'old' };
  saved.backups[0].remoteSnapshot = { ...saved.remoteSnapshot, sourceSha: 'v1', commitSha: 'old-target' };
  await reloadProject(saved); identifyDestination();
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PATCH' && String(url).endsWith('/repos/destination/backup')) return ok({ id: 77, owner: { login: 'destination' }, name: 'renamed', html_url: 'https://github.com/destination/renamed' });
    return base(url, init);
  };
  (globalThis as any).prompt = () => 'renamed';
  await enterWorkbench(); await click('分叉与私有仓'); await click('修改项目名称');
  await waitFor(() => alerts.length > 0);
  const renamed = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(renamed.uploadTarget.repo, 'renamed'); assert.equal(renamed.repo, 'project');
  assert.equal(renamed.backups[0].remoteSnapshot.repo, 'renamed'); assert.equal(renamed.backups[0].remoteSnapshot.commitSha, 'old-target');
});

test('restoring a version creates a new target commit with old bytes and retains current source/cache', async () => {
  await reloadProject(boundProject()); identifyDestination();
  await enterWorkbench(); await click('版本归档库 (1)'); await click('恢复此版本');
  await waitFor(() => alerts.length > 0);
  assert.ok(uploadedContents.includes('old')); assert.ok(!uploadedContents.includes('new'));
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.latestCommitSha, 'v2'); assert.equal(saved.remoteSnapshot.sourceSha, 'v1');
  assert.equal(saved.remoteSnapshot.commitSha, 'uploaded');
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.ok(requests.some(r => r.path.endsWith('/git/commits') && r.payload.parents[0] === 'parent'));
});

test('upload after a restore archives the restored manifest with its matching source version', async () => {
  const saved = boundProject();
  saved.remoteSnapshot = { repoId: 77, owner: 'destination', repo: 'backup', branch: 'release', sourceSha: 'v1', commitSha: 'restored-old', htmlUrl: 'old' };
  await reloadProject(saved); identifyDestination();
  await enterWorkbench(); await click('分叉与私有仓'); await click('更新已绑定仓库（保留历史）');
  await waitFor(() => alerts.length > 0);
  const updated = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  const archived = updated.backups.find((item: any) => item.remoteSnapshot?.commitSha === 'restored-old');
  assert.equal(archived.commitSha, 'v1'); assert.equal(archived.tree[0].sha, sha('old'));
  assert.equal(updated.latestCommitSha, 'v2'); assert.equal(updated.remoteSnapshot.sourceSha, 'v2');
});

test('current-branch copy saves exact downloaded version and adds a separate managed project', async () => {
  identifyDestination(); const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => String(url).endsWith('/user') ? ok({ login: 'destination' }) : base(url, init);
  // Use an existing private destination chosen explicitly for this test.
  const second = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url) === 'https://api.github.com/repos/destination/backup' ? ok({ id: 77, private: true, owner: { login: 'destination' }, name: 'backup', default_branch: 'release', html_url: 'https://github.com/destination/backup' }) : second(url, init);
  await enterWorkbench(); await click('分叉与私有仓'); await click('板块二：创建分叉与上游同步');
  await input('project', 'backup');
  await click('保存当前分支并加入我的项目');
  await waitFor(() => alerts.length > 0);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  const managed = saved.find((item: any) => item.origin);
  assert.ok(managed, alerts.join(' ')); assert.equal(saved.length, 2);
  assert.equal(managed.origin.branch, 'develop'); assert.equal(managed.uploadTarget.repo, 'backup');
  assert.equal(managed.uploadTarget.branch, 'develop');
  assert.equal(managed.remoteSnapshot.sourceSha, 'v2'); assert.ok(uploadedContents.includes('new'));
  assert.ok(!requests.some(r => r.path.endsWith('/forks')));
});

function completeForkFixture() {
  let created = false;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    const payload = init.body ? JSON.parse(init.body as string) : undefined; requests.push({ path, payload });
    if (path === '/user') return ok({ login: 'me' });
    if (path === '/repos/source/project') return ok({ id: 42, default_branch: 'develop' });
    if (path.startsWith('/repos/source/project/branches?')) return ok([{ name: 'develop' }, { name: 'other' }]);
    if (path === '/repos/source/project/forks') { created = true; return ok({ id: 77, owner: { login: 'me' }, name: 'project' }); }
    if (path === '/repos/me/project') return created ? ok({ id: 77, name: 'project', fork: true, parent: { id: 42 }, owner: { login: 'me' }, default_branch: 'develop', html_url: 'https://github.com/me/project' }) : ok({ message: 'Not Found' }, 404);
    if (path.startsWith('/repos/me/project/branches?')) return ok([{ name: 'develop' }, { name: 'other' }]);
    if (path.includes('/repos/me/project/commits/')) return ok({ sha: 'fork-head', commit: { tree: { sha: 'fork-tree' }, message: 'fork', author: { name: 'author', date: '2026-10-15' } } });
    if (path.includes('/git/trees/fork-tree')) return ok({ tree: [entry('new')] });
    throw new Error(path);
  };
}

test('complete Fork uses original repository, verifies all branches, and adds it without downloading source files', async () => {
  completeForkFixture();
  await enterWorkbench(); await click('分叉与私有仓'); await click('板块二：创建分叉与上游同步');
  const select = [...document.querySelectorAll('select')].find(item => [...item.options].some(option => option.value === 'full'))!;
  await act(async () => { select.value = 'full'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('完整分叉并加入我的项目'); await waitFor(() => alerts.length > 0);
  const records = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  const managed = records.find((item: any) => item.forkScope === 'full');
  assert.ok(managed, alerts.join(' ')); assert.equal(managed.owner, 'me'); assert.equal(managed.forkTarget.branches.length, 2);
  assert.equal(managed.isCachePurged, true); assert.equal(managed.origin.url, 'https://github.com/source/project');
  assert.ok(!requests.some(r => r.path.includes('/git/blobs/')));
});

async function setField(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : field.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function branchFixtures() {
  const base = globalThis.fetch; let featureUploaded = false;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    const payload = init.body ? JSON.parse(init.body as string) : null;
    const respond = (data: unknown, status = 200) => { requests.push({ path, payload }); return ok(data, status); };
    if (path === '/repos/source/project') return respond({ default_branch: 'develop', html_url: 'https://github.com/source/project' });
    if (path.startsWith('/repos/source/project/branches?')) return respond([{ name: 'develop' }, { name: 'feature/demo' }, { name: 'release' }]);
    if (path.startsWith('/repos/source/project/commits/')) {
      const branch = decodeURIComponent(path.split('/commits/')[1]);
      if (!['develop', 'feature/demo', 'release'].includes(branch)) return respond({ message: 'missing branch' }, 404);
      return respond({ sha: branch === 'develop' ? 'v2' : 'feature-v1', commit: { tree: { sha: branch === 'develop' ? 'tree-develop' : 'tree-feature' }, message: branch, author: { name: 'author', date: '2026-10-15' } } });
    }
    if (path.includes('/git/trees/tree-')) return respond({ tree: [entry(path.includes('tree-develop') ? 'new' : 'feature content')] });
    if (path.startsWith('/repos/source/project/git/blobs/')) return respond({ encoding: 'base64', content: Buffer.from(path.endsWith(sha('new')) ? 'new' : 'feature content').toString('base64') });
    if (path.endsWith('/git/ref/heads/feature/demo')) return featureUploaded ? respond({ object: { sha: 'uploaded' } }) : respond({ message: 'Not Found' }, 404);
    if (path === '/repos/destination/backup/git/refs') { featureUploaded = true; return respond({ object: { sha: 'uploaded' } }); }
    return base(url, init);
  };
}
async function switchBranch(branch: string) {
  await setField(document.querySelector<HTMLInputElement | HTMLSelectElement>('[aria-label="工作台分支"]')!, branch);
  await click('切换并重新拉取');
  await waitFor(() => JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].branch === branch || !!document.querySelector('[role=alert]'));
}

test('workbench switch downloads the slash branch and uploads only to its matching branch in the bound repository', async () => {
  await reloadProject(boundProject()); identifyDestination(); branchFixtures();
  await enterWorkbench(); await click('获取可切换分支');
  await waitFor(() => !!document.querySelector('select[aria-label="工作台分支"]'));
  await switchBranch('feature/demo');
  let saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.branch, 'feature/demo'); assert.equal(saved.uploadTarget.repo, 'backup'); assert.equal(saved.uploadTarget.branch, 'feature/demo');
  assert.equal(saved.branchTargets.develop.branch, 'release'); assert.equal(saved.backups[0].branch, 'develop');
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.equal((await localCache.getProjectFiles('tracked', 'feature-v1'))[0].content, 'feature content');
  await click('分叉与私有仓'); await click('更新已绑定仓库（保留历史）');
  await waitFor(() => JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].remoteSnapshot?.branch === 'feature/demo');
  assert.ok(requests.some(r => r.payload?.ref === 'refs/heads/feature/demo'));
  assert.ok(!requests.some(r => r.path.endsWith('/git/refs/heads/release')));
  saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  await reloadProject(saved); await enterWorkbench(); await switchBranch('develop');
  saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.uploadTarget.branch, 'release'); assert.equal(saved.branchTargets['feature/demo'].branch, 'feature/demo');
  assert.ok(requests.filter(r => r.path === '/repos/source/project/commits/develop').length > 0);
});

test('failed branch switch retains the current branch, files and existing upload binding', async () => {
  await reloadProject(boundProject()); identifyDestination(); branchFixtures(); await enterWorkbench();
  await switchBranch('missing');
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.branch, 'develop'); assert.equal(saved.latestCommitSha, 'v2'); assert.equal(saved.uploadTarget.branch, 'release');
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  assert.ok(document.querySelector('[role=alert]')?.textContent?.includes('切换未完成'));
});

test('a branch cannot overwrite another source branch binding and switching back remains usable', async () => {
  await reloadProject(boundProject()); identifyDestination(); branchFixtures(); await enterWorkbench();
  await switchBranch('release');
  await click('分叉与私有仓'); await click('更新已绑定仓库（保留历史）');
  await waitFor(() => alerts.some(message => message.includes('不能用 release 覆盖')));
  assert.ok(!requests.some(r => r.path.endsWith('/git/commits') || r.path.endsWith('/git/refs/heads/release')));
  // Close the failed upload dialog and switch back without reserving the conflicting pending binding.
  const dialog = buttons().find(b => b.textContent === '更新已绑定仓库（保留历史）')!.closest('form')!.parentElement!;
  await act(async () => { dialog.querySelector<HTMLButtonElement>('button')!.click(); });
  await switchBranch('develop');
  assert.equal(JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].uploadTarget.branch, 'release');
  await click('分叉与私有仓'); await click('更新已绑定仓库（保留历史）');
  await waitFor(() => JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].remoteSnapshot?.branch === 'release');
});

test('restoring a historical branch never redirects it into the branch currently shown in the workbench', async () => {
  await reloadProject(boundProject()); identifyDestination(); branchFixtures(); await enterWorkbench(); await switchBranch('feature/demo');
  await click('版本归档库 (2)'); await click('恢复此版本');
  await waitFor(() => alerts.some(message => message.includes('历史版本已恢复')));
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.branch, 'feature/demo'); assert.equal(saved.latestCommitSha, 'feature-v1'); assert.equal(saved.uploadTarget.branch, 'feature/demo');
  assert.equal(saved.backups[0].remoteSnapshot.branch, 'release');
  assert.ok(requests.some(r => r.path.endsWith('/git/refs/heads/release')));
  assert.ok(!requests.some(r => r.payload?.ref === 'refs/heads/feature/demo'));
});

test('batch import needs only links, uses repository default branches, skips duplicates and retries only failed entries', async () => {
  let failed = true;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', ''); requests.push({ path, payload: null });
    const name = path.split('/')[3];
    if (path === '/repos/demo/one' || path === '/repos/demo/two') return name === 'two' && failed ? ok({ message: 'temporary failure' }, 503) : ok({ name, default_branch: name === 'one' ? 'master' : 'main', html_url: `https://github.com/demo/${name}` });
    if (path.includes('/commits/')) return ok({ sha: `commit-${name}`, commit: { tree: { sha: `tree-${name}` }, message: 'default branch', author: {} } });
    if (path.includes('/git/trees/')) return ok({ tree: [entry(name)] });
    if (path.includes('/git/blobs/')) return ok({ encoding: 'base64', content: Buffer.from(name).toString('base64') });
    throw new Error(path);
  };
  await click('新建链接/拉取项目'); await click('批量导入链接');
  await setField(document.querySelector<HTMLTextAreaElement>('[aria-label="批量仓库链接"]')!, '带 空格的备注  https://github.com/demo/one/tree/feature\ndemo/two\nDEMO/one.git\nhttps://example.com/demo/bad');
  assert.ok(!document.querySelector('input[placeholder="例如: 生产核心源码 / 模块A"]'));
  await click('开始批量导入');
  await waitFor(() => document.querySelector('[role=status]')?.textContent === '成功 1 · 跳过 1 · 失败 2');
  let saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  const imported = saved.find((item: any) => item.owner === 'demo');
  assert.equal(imported.branch, 'master'); assert.equal(imported.remark, '带 空格的备注'); assert.equal(imported.files, undefined);
  assert.equal((await localCache.getProjectFiles(imported.id, imported.latestCommitSha))[0].content, 'one');
  assert.ok(!requests.some(r => r.path.includes('/commits/feature')));
  const oneReads = requests.filter(r => r.path === '/repos/demo/one').length;
  failed = false; await click('重试失败链接');
  await waitFor(() => document.querySelector('[role=status]')?.textContent === '成功 2 · 跳过 1 · 失败 1');
  saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved.filter((item: any) => item.owner === 'demo').length, 2);
  assert.equal(saved.find((item: any) => item.repo === 'two').remark, '');
  assert.equal(requests.filter(r => r.path === '/repos/demo/one').length, oneReads);
  const previousReads = requests.filter(r => r.path.includes('/commits/')).length;
  await click('开始批量导入');
  await waitFor(() => document.querySelector('[role=status]')?.textContent === '成功 0 · 跳过 3 · 失败 1');
  assert.equal(requests.filter(r => r.path.includes('/commits/')).length, previousReads);
});

test('cancelling a batch keeps completed projects and leaves remaining links available for retry', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', ''); requests.push({ path, payload: null });
    if (path === '/repos/demo/two') return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    if (path === '/repos/demo/one') return ok({ default_branch: 'main' });
    if (path.includes('/commits/')) return ok({ sha: 'imported', commit: { tree: { sha: 'imported-tree' }, message: '', author: {} } });
    if (path.includes('/git/trees/')) return ok({ tree: [entry('one')] });
    if (path.includes('/git/blobs/')) return ok({ encoding: 'base64', content: Buffer.from('one').toString('base64') });
    throw new Error(path);
  };
  await click('新建链接/拉取项目'); await click('批量导入链接');
  await setField(document.querySelector<HTMLTextAreaElement>('[aria-label="批量仓库链接"]')!, 'demo/one\ndemo/two\ndemo/three');
  await click('开始批量导入'); await waitFor(() => requests.some(r => r.path === '/repos/demo/two'));
  await click('取消');
  await waitFor(() => document.querySelector('[role=status]')?.textContent === '成功 1 · 跳过 0 · 失败 2');
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved.filter((item: any) => item.owner === 'demo').length, 1);
  assert.ok(!requests.some(r => r.path === '/repos/demo/three'));
  assert.ok(buttons().some(b => b.textContent === '重试失败链接'));
});

test('workbench metadata can be edited without pulling files or altering branch bindings', async () => {
  await reloadProject(boundProject()); await enterWorkbench(); await click('编辑备注与描述');
  const form = buttons().find(b => b.textContent === '保存修改')!.closest('form')!;
  await setField(form.querySelector<HTMLInputElement>('input')!, 'new remark');
  await setField(form.querySelector<HTMLTextAreaElement>('textarea')!, 'new description');
  await click('保存修改'); await waitFor(() => alerts.length > 0);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.remark, 'new remark'); assert.equal(saved.description, 'new description');
  assert.equal(saved.uploadTarget.branch, 'release'); assert.equal(saved.latestCommitSha, 'v2');
  assert.ok(requests.every(request => request.path === '/repos/destination/backup' && request.payload === null));
});

test('batch upload after switching uses the matching slash branch and preserves the previously uploaded branch', async () => {
  await reloadProject(boundProject()); identifyDestination(); branchFixtures(); await enterWorkbench(); await switchBranch('feature/demo');
  (globalThis as any).confirm = () => false;
  await click('仓库已有项目 (1)'); await click('全选所有'); await click('批量上传至私人仓库'); await click('开始批量上传');
  await waitFor(() => JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].remoteSnapshot?.branch === 'feature/demo');
  assert.ok(requests.some(r => r.payload?.ref === 'refs/heads/feature/demo'));
  assert.ok(!requests.some(r => r.path.endsWith('/git/refs/heads/release')));
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.branchTargets.develop.branch, 'release'); assert.equal(saved.branchTargets['feature/demo'].repo, 'backup');
});

test('private upload into an existing named repository creates the source branch rather than overwriting its default branch', async () => {
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return ok({ login: 'destination' });
    if (String(url) === 'https://api.github.com/repos/destination/backup') return ok({ id: 77, private: true, name: 'backup', default_branch: 'main', html_url: 'https://github.com/destination/backup' });
    return base(url, init);
  };
  await enterWorkbench(); await click('分叉与私有仓');
  const name = [...document.querySelectorAll<HTMLInputElement>('input')].find(field => field.value === 'project')!;
  await setField(name, 'backup'); await click('立即新建私人仓库并上传');
  await waitFor(() => alerts.length > 0);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.uploadTarget.branch, 'develop');
  assert.ok(requests.some(r => r.payload?.ref === 'refs/heads/develop'));
  assert.ok(!requests.some(r => r.path.includes('/heads/main') || r.path.endsWith('/git/refs/heads/release')));
});

test('manual copy mode cannot bypass another branch binding in the same uploaded repository', async () => {
  await reloadProject(boundProject()); identifyDestination(); branchFixtures(); await enterWorkbench(); await switchBranch('feature/demo');
  await click('上传指定仓库'); await click('另存副本到其他仓库（不改变原绑定）');
  await input('owner/repo', 'destination/backup'); await input('留空使用当前来源分支', 'release');
  await click('确认上传'); await waitFor(() => alerts.some(message => message.includes('不能用 feature/demo 覆盖')));
  assert.ok(!requests.some(r => r.path.endsWith('/git/commits') || r.path.endsWith('/git/refs/heads/release')));
});

test('managed copies switch their original source branch while keeping the destination identity and name', async () => {
  const saved = { ...boundProject(), owner: 'destination', repo: 'backup', url: 'https://github.com/destination/backup', repoMeta: { htmlUrl: 'https://github.com/destination/backup' }, origin: { owner: 'source', repo: 'project', url: 'https://github.com/source/project', branch: 'develop' }, forkScope: 'current' };
  await reloadProject(saved); identifyDestination(); branchFixtures(); await enterWorkbench(); await switchBranch('feature/demo');
  const updated = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(updated.owner, 'destination'); assert.equal(updated.repo, 'backup'); assert.equal(updated.repoMeta.htmlUrl, saved.url);
  assert.equal(updated.origin.branch, 'feature/demo'); assert.equal(updated.uploadTarget.branch, 'feature/demo');
  assert.ok(requests.some(r => r.path === '/repos/source/project/commits/feature%2Fdemo'));
});

async function reloadProjects(saved: any[]) {
  await act(async () => root.unmount());
  localStorage.setItem('gitvault_repos_v8', JSON.stringify(saved));
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(React.createElement(App)));
}
async function openBatch(label: string, count = 1) {
  await click(`仓库已有项目 (${count})`); await click('全选所有'); await click(label);
}
function batchStatus() { return document.querySelector('[role=dialog] [role=status]')?.textContent || ''; }

test('complete batch Fork creates one verified destination and associates duplicate source branches with it', async () => {
  await reloadProjects([repo(), { ...repo(), id: 'second', branch: 'other' }]); completeForkFixture();
  await openBatch('批量分叉', 2); await click('开始批量分叉');
  await waitFor(() => batchStatus() === '成功 1 · 失败 0 · 跳过 1 · 取消 0');
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved.filter((item: any) => item.forkScope === 'full').length, 1);
  assert.equal(saved.find((item: any) => item.id === 'second').forkTarget.repo, 'project');
  assert.equal(requests.filter(r => r.path.endsWith('/forks')).length, 1);
  assert.equal(alerts.length, 0);
});

test('batch current-branch copies use the exact cached source snapshot and corresponding branch', async () => {
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return ok({ login: 'destination' });
    if (String(url) === 'https://api.github.com/repos/destination/backup') return ok({ id: 77, private: true, owner: { login: 'destination' }, name: 'backup', default_branch: 'main', html_url: 'https://github.com/destination/backup' });
    return base(url, init);
  };
  await openBatch('批量分叉');
  await setField(document.querySelector<HTMLSelectElement>('[aria-label="批量分叉范围"]')!, 'current');
  await setField(document.querySelector<HTMLInputElement>('[aria-label="目标名称 1"]')!, 'backup');
  await setField(document.querySelector<HTMLInputElement>('[aria-label="批量操作 Token"]')!, 'test-target-token');
  await click('开始批量分叉');
  await waitFor(() => batchStatus() === '成功 1 · 失败 0 · 跳过 0 · 取消 0');
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  const copy = saved.find((item: any) => item.forkScope === 'current');
  assert.equal(copy.uploadTarget.branch, 'develop'); assert.equal(copy.remoteSnapshot.sourceSha, 'v2');
  assert.ok(uploadedContents.includes('new')); assert.ok(!requests.some(r => r.path.endsWith('/forks')));
  assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
});

test('batch updates retain successful uploads, preserve files on a failing project and retry only the failure', async () => {
  let failSecond = true;
  const first = { ...boundProject(), hasUpdate: true };
  const second = { ...repo(), id: 'second', owner: 'other', repo: 'broken', url: 'https://github.com/other/broken', hasUpdate: true };
  await reloadProjects([first, second]); identifyDestination();
  await localCache.saveProjectFiles('second', [file('new')], 'v2');
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    if (path.startsWith('/repos/source/project') || path.startsWith('/repos/other/broken')) {
      requests.push({ path, payload: null });
      if (failSecond && path.startsWith('/repos/other/broken')) return ok({ message: 'temporary failure' }, 503);
      if (path.endsWith('/project') || path.endsWith('/broken')) return ok({ default_branch: 'develop' });
      if (path.includes('/commits/')) return ok({ sha: 'v3', commit: { tree: { sha: 'new-tree' }, message: 'updated', author: {} } });
      if (path.includes('/git/trees/')) return ok({ tree: [entry('newest')] });
      if (path.includes('/git/blobs/')) return ok({ content: Buffer.from('newest').toString('base64') });
    }
    return base(url, init);
  };
  await click('仓库已有项目 (2)'); await click('仅选有更新'); await click('批量更新'); await click('开始批量更新');
  await waitFor(() => batchStatus() === '成功 1 · 失败 1 · 跳过 0 · 取消 0');
  let saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved[0].remoteSnapshot.branch, 'release'); assert.equal(saved[0].latestCommitSha, 'v3');
  assert.equal(saved[1].latestCommitSha, 'v2');
  assert.equal((await localCache.getProjectFiles('second', 'v2'))[0].content, 'new');
  const firstReads = requests.filter(r => r.path.startsWith('/repos/source/project')).length;
  failSecond = false; await click('重试失败项目');
  await waitFor(() => batchStatus() === '成功 2 · 失败 0 · 跳过 0 · 取消 0');
  saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!);
  assert.equal(saved[1].latestCommitSha, 'v3'); assert.equal(requests.filter(r => r.path.startsWith('/repos/source/project')).length, firstReads);
  assert.equal(alerts.length, 0);
});

test('batch upstream sync uses recorded Fork identities and reports partial branch failures as failures', async () => {
  const source = { ...repo(), forkTarget: { owner: 'me', repo: 'project-fork', branch: 'develop', htmlUrl: '', branches: ['develop', 'other'] } };
  await reloadProject(source);
  const original = githubClient.syncAllForkBranches;
  const destinations: string[] = [];
  githubClient.syncAllForkBranches = async (owner, name) => {
    destinations.push(`${owner}/${name}`);
    return [{ branch: 'develop', success: true, sourceSha: 'v2', commitSha: 'uploaded' }, { branch: 'other', success: false, error: 'protected branch' }];
  };
  try {
    await openBatch('批量分叉同步'); await click('开始批量同步');
    await waitFor(() => batchStatus() === '成功 0 · 失败 1 · 跳过 0 · 取消 0');
    assert.deepEqual(destinations, ['me/project-fork']);
    assert.ok(document.querySelector('[role=dialog]')?.textContent?.includes('1/2 成功'));
    assert.equal((await localCache.getProjectFiles('tracked', 'v2'))[0].content, 'new');
  } finally { githubClient.syncAllForkBranches = original; }
});

test('batch sync shares complete-Fork transfers but refreshes every selected managed record', async () => {
  const target = { id: 77, owner: 'me', repo: 'project-fork', branch: 'develop', htmlUrl: 'https://github.com/me/project-fork', branches: ['develop', 'other'] };
  const source = { ...repo(), forkTarget: target };
  const managed = { ...repo(), id: 'managed', owner: 'me', repo: 'project-fork', url: target.htmlUrl, origin: { owner: 'source', repo: 'project', url: 'https://github.com/source/project', branch: 'develop' }, forkScope: 'full', forkTarget: target, uploadTarget: { ...target, token: 'target-token', purgeAfterUpload: true } };
  await reloadProjects([source, managed]);
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/repos/me/project-fork')) return ok({ id: 77, name: 'project-fork', owner: { login: 'me' }, default_branch: 'develop', html_url: target.htmlUrl });
    if (path.endsWith('/repos/source/project')) return ok({ default_branch: 'develop' });
    if (path.includes('/repos/source/project/commits/')) return ok({ sha: 'source-new', commit: { tree: { sha: 'source-tree' }, message: 'new', author: {} } });
    if (path.includes('/git/trees/source-tree')) return ok({ tree: [entry('newest')] });
    return base(url, init);
  };
  const original = githubClient.syncAllForkBranches; let transfers = 0;
  githubClient.syncAllForkBranches = async () => { transfers++; return [{ branch: 'develop', success: true, sourceSha: 'source-new', commitSha: 'target-new' }, { branch: 'other', success: true, sourceSha: 'other-new', commitSha: 'other-target' }]; };
  try {
    await openBatch('批量分叉同步', 2); await click('开始批量同步');
    await waitFor(() => batchStatus() === '成功 2 · 失败 0 · 跳过 0 · 取消 0');
    assert.equal(transfers, 1);
    const updated = JSON.parse(localStorage.getItem('gitvault_repos_v8')!).find((item: any) => item.id === 'managed');
    assert.equal(updated.latestCommitSha, 'source-new'); assert.equal(updated.remoteSnapshot.commitSha, 'target-new'); assert.equal(updated.isCachePurged, true);
  } finally { githubClient.syncAllForkBranches = original; }
});
