import { dom } from './dom';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { localCache } from '../src/utils/localCache';
import { beginGithubOperation, githubClient, githubApi, GitHubError } from '../src/utils/githubClient';
import App from '../src/App';
import { appDialog } from '../src/utils/appDialog';
import { checkpoint } from '../src/utils/taskJournal';
import { immediateTransport } from './transportFixture';
import { accountRegistry, createAccountRegistry, type AccountProject } from '../src/utils/accountRegistry';
const registryMethods = { ...accountRegistry };

const originalFetch = globalThis.fetch;
const withoutTargetHealth = (saved: string | null) => JSON.stringify(JSON.parse(saved!).map(({ targetHealth, ...project }: any) => project));
const sha = (s: string) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const file = (content: string) => ({ path: 'a.txt', content, isBase64: false, sha: sha(content), mode: '100644' });
const entry = (content: string) => ({ path: 'a.txt', sha: sha(content), mode: '100644', type: 'blob', size: content.length });

function importAssociationFixture(options: { changedId?: boolean; full?: boolean; delayedComparison?: boolean; missingBranch?: string; identical?:boolean } = {}) {
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
    if (path.includes('/git/trees/compare-tree')) { requests.push({ path, payload: null }); return ok({ tree: options.identical ? [entry('latest')] : [entry('old'), { ...entry('delete'), path: 'deleted.txt' }] }); }
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
  immediateTransport();
  accountRegistry.candidates = async () => ({ login: 'destination', recorded: [], legacy: [] });
  accountRegistry.save = async () => ({} as any);
  accountRegistry.remove = async () => ({} as any);
  accountRegistry.reserve = async (source, name, kind, _token, _signal, explicit) => ({ source, target: explicit || {owner:'destination',repo:name}, kind, state:'reserved',createdByApp:true,bindings:{[source.branch]:{branch:source.branch,updatedAt:''}},updatedAt:'' });
  beginGithubOperation(); localStorage.clear(); document.body.innerHTML = '<div id="root"></div>';
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('GitVault_Storage_v1'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  alerts = []; requests = []; uploadedContents = []; failUpload = false; rejectionStatus = 403;
  (globalThis as any).alert = (message: string) => alerts.push(message);
  (globalThis as any).confirm = () => true;
  (globalThis as any).prompt = () => 'fake-test-token';
  appDialog.notify = message => { alerts.push(message); };
  appDialog.confirm = async message => (globalThis as any).confirm(message);
  appDialog.prompt = async (message, value) => (globalThis as any).prompt(message, value);
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
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path) && !init.method) return ok({ message: 'Not Found' }, 404);
    throw new Error('Unexpected request: ' + path);
  };
  localStorage.setItem('gitvault_repos_v8', JSON.stringify([repo()]));
  await localCache.saveProjectFiles('tracked', [file('old')], 'v1');
  await localCache.saveProjectFiles('tracked', [file('new')], 'v2');
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(React.createElement(App)); });
});
afterEach(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; Object.assign(accountRegistry, registryMethods); mock.restoreAll(); });

test('reopening a saved task does not write remotely and a changed branch blocks retry', async () => {
  checkpoint({ kind: 'projects', action: 'update', items: [{ id: 'tracked', label: 'source/project', name: 'project', status: 'running', source: 'https://github.com/source/project', branch: 'other' }] });
  await reloadProject(repo());
  assert.ok(document.body.textContent?.includes('发现上次未完成'));
  const before = requests.length;
  await click('查看并继续');
  assert.equal(requests.length, before);
  await click('重试失败项目');
  await waitFor(() => !!document.body.textContent?.includes('项目来源、分支或固定仓库已变化'));
  assert.ok(!requests.slice(before).some(request => request.payload));
  assert.equal(storedProjects()[0].branch, 'develop');
});
test('restored upload queues retain successful items without repeating their upload', async () => {
  checkpoint({ kind: 'upload', items: [{ id: 'tracked', repo: 'project', name: 'fixed-name', status: 'success' }, { id: 'removed-project', name: 'other-name', status: 'uploading' }] });
  await reloadProject(repo()); await click('查看并继续');
  assert.ok(document.body.textContent?.includes('fixed-name'));
  const before = requests.length;
  await click('重试未完成上传');
  await waitFor(() => !!document.body.textContent?.includes('项目已移除'));
  assert.ok(!requests.slice(before).some(request => request.payload));
  const saved = JSON.parse(localStorage.getItem('gitvault_tasks_v1')!)[0];
  assert.equal(saved.items[0].status, 'success'); assert.equal(saved.items[0].name, 'fixed-name');
});
test('archive publishing with keep-source preserves files and saves each completed result', async () => {
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    if (path.includes('/git/ref/tags/')) return ok({ message: 'Not Found' }, 404);
    if (path.endsWith('/releases') && init.method === 'POST') return ok({ html_url: 'https://github.com/source/project/releases/tag/v1', tag_name: 'v1' });
    return base(url, init);
  };
  await enterWorkbench(); await click('版本归档库 (1)'); await click('全选所有');
  await click('批量发布 Release 到 GitHub'); await click('开始批量发布');
  await waitFor(() => storedProjects()[0].backups[0].isReleased === true);
  assert.equal((await localCache.getProjectFiles('tracked', 'v1'))[0].content, 'old');
  assert.equal(storedProjects()[0].backups[0].isCachePurged, undefined);
  await waitFor(() => JSON.parse(localStorage.getItem('gitvault_tasks_v1')!)[0].items[0].status === 'success');
});

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
  const first = boundProject(); first.accountState = 'synced';
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
  assert.equal(saved[1].owner, 'source'); assert.equal(saved[1].accountState, undefined); assert.equal(saved[1].forkScope, undefined); assert.equal(saved[1].origin.repo, 'project');
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
  const previousAlerts = alerts.length;
  await click('上传指定仓库');
  await input('owner/repo', 'destination/backup');
  await input('留空使用当前来源分支', 'release');
  const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(e => e.parentElement?.textContent?.includes('上传验证成功后清理'))!;
  if (purge) await act(async () => checkbox.click());
  const submit = buttons().find(b => b.textContent === '确认上传')!;
  await act(async () => { submit.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 50)); });
  await waitFor(() => alerts.length > previousAlerts);
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
  await waitFor(() => storedProjects()[0].isCachePurged === true);
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
  await waitFor(() => storedProjects()[0].backups[0].isCachePurged === true);
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

test('batch first upload skips an already bound target and never pushes files', async () => {
  await reloadProject(boundProject()); identifyDestination();
  (globalThis as any).confirm = () => false;
  await click('仓库已有项目 (1)'); await click('全选所有'); await click('批量上传至私人仓库'); await click('开始批量上传');
  await waitFor(() => document.body.textContent?.includes('已跳过') === true);
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.uploadTarget.repo, 'backup'); assert.equal(saved.uploadTarget.branch, 'release');
  assert.equal(saved.remoteSnapshot, undefined);
  assert.ok(!requests.some(r => r.path.includes('/git/')));
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
  newPrivateFixture();
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

function newPrivateFixture() {
  const base = globalThis.fetch; let created = false;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    if (path === '/user') return ok({login:'destination'});
    if (path === '/repos/destination/backup') return created ? ok({id:77,private:true,owner:{login:'destination'},name:'backup',default_branch:'main',html_url:'https://github.com/destination/backup'}) : ok({message:'Not Found'},404);
    if (path === '/user/repos' && init.method === 'POST') { created = true; return ok({id:77,owner:{login:'destination'},name:'backup',default_branch:'main',html_url:'https://github.com/destination/backup'}); }
    return base(url,init);
  };
}

function completeForkFixture() {
  accountRegistry.candidates = async () => ({login:'me',recorded:[],legacy:[]});
  accountRegistry.reserve = async (source, name, kind) => ({source,target:{owner:'me',repo:name},kind,state:'reserved',createdByApp:true,bindings:{[source.branch]:{branch:source.branch,updatedAt:''}},updatedAt:''});
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

test('batch update after switching uses the matching slash branch and preserves the previously uploaded branch', async () => {
  await reloadProject(boundProject()); identifyDestination(); branchFixtures(); await enterWorkbench(); await switchBranch('feature/demo');
  (globalThis as any).confirm = () => false;
  await click('仓库已有项目 (1)'); await click('全选所有'); await click('批量更新'); await click('开始批量更新');
  await waitFor(() => JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0].remoteSnapshot?.branch === 'feature/demo');
  assert.ok(requests.some(r => r.payload?.ref === 'refs/heads/feature/demo'));
  assert.ok(!requests.some(r => r.path.endsWith('/git/refs/heads/release')));
  const saved = JSON.parse(localStorage.getItem('gitvault_repos_v8')!)[0];
  assert.equal(saved.branchTargets.develop.branch, 'release'); assert.equal(saved.branchTargets['feature/demo'].repo, 'backup');
});

test('a proposed private name already present in the account requires comparison before any write', async () => {
  identifyDestination();
  await enterWorkbench(); await click('分叉与私有仓');
  const name = [...document.querySelectorAll<HTMLInputElement>('input')].find(field => field.value === 'project')!;
  await setField(name, 'backup'); await click('立即新建私人仓库并上传');
  await waitFor(() => !!importDialog());
  assert.equal(storedProjects()[0].uploadTarget, undefined);
  assert.ok(!requests.some(r => r.payload));
  await click('跳过此链接'); await waitFor(() => alerts.length > 0);
  assert.equal(storedProjects()[0].uploadTarget, undefined);
  assert.ok(!requests.some(r => r.payload));
});

test('manual copy mode cannot bypass another branch binding in the same uploaded repository', async () => {
  await reloadProject(boundProject()); identifyDestination(); branchFixtures(); await enterWorkbench(); await switchBranch('feature/demo');
  await click('上传指定仓库'); await click('另存副本到其他仓库（不改变原绑定）');
  await input('owner/repo', 'destination/backup'); await input('留空使用当前来源分支', 'release');
  await click('确认上传'); await waitFor(() => alerts.some(message => message.includes('不能再次上传为新副本')));
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
  newPrivateFixture();
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

function cloudEntry(full = false): AccountProject {
  return {source:{owner:'source',repo:'project',url:'https://github.com/source/project',branch:'develop',repositoryId:42},target:{id:77,owner:'destination',repo:'backup'},kind:full?'full':'upload',state:'active',createdByApp:true,branches:full?['develop','other']:undefined,bindings:{develop:{branch:'release',sourceSha:'import-new',commitSha:'target-current',updatedAt:'now'}},updatedAt:'now'};
}
test('a fresh device importing the original link restores the account target and synced receipt without uploading', async () => {
  localStorage.setItem('gitvault_global_token','account-token'); await reloadProjects([]); importAssociationFixture({identical:true});
  accountRegistry.candidates = async () => ({login:'destination',recorded:[cloudEntry()],legacy:[]});
  await click('新建链接/拉取项目'); await input('https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo','source/project');
  await input('例如: 生产核心源码 / 模块A','跨设备项目');await click('确认拉取进入本地'); await waitFor(()=>alerts.length>0);
  const saved = storedProjects()[0]; assert.equal(saved.uploadTarget.repo,'backup'); assert.equal(saved.uploadTarget.branch,'release');
  assert.equal(saved.accountState,'synced'); assert.equal(saved.remoteSnapshot.sourceSha,'import-new');
  assert.ok(document.body.textContent?.includes('已同步')); assert.ok(!importDialog()); assert.ok(requests.every(request=>!request.payload));
});
test('a fresh device importing the destination URL resumes the original source branch and fixed destination', async () => {
  localStorage.setItem('gitvault_global_token','account-token'); await reloadProjects([]); importAssociationFixture({identical:true});
  const base=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>String(url).endsWith('/repos/destination/backup/commits/main')?ok({sha:'target-current',commit:{tree:{sha:'compare-tree'},message:'old',author:{}}}):base(url,init);
  accountRegistry.candidates = async () => ({login:'destination',recorded:[cloudEntry()],legacy:[]});
  await click('新建链接/拉取项目'); await input('https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo','destination/backup/tree/release');
  await input('例如: 生产核心源码 / 模块A','跨设备项目');await click('确认拉取进入本地'); await waitFor(()=>alerts.length>0);
  const saved=storedProjects()[0]; assert.equal(saved.owner,'source'); assert.equal(saved.repo,'project'); assert.equal(saved.branch,'develop'); assert.equal(saved.uploadTarget.branch,'release');
  assert.equal(saved.latestCommitSha,'import-new'); assert.ok(requests.every(request=>!request.payload));
});
test('a fresh-device full Fork import displays forked state and keeps its account target', async()=>{
  localStorage.setItem('gitvault_global_token','account-token'); await reloadProjects([]); importAssociationFixture({full:true,identical:true});
  accountRegistry.candidates=async()=>({login:'destination',recorded:[cloudEntry(true)],legacy:[]});
  await click('新建链接/拉取项目');await input('https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo','source/project');await input('例如: 生产核心源码 / 模块A','跨设备项目');await click('确认拉取进入本地');await waitFor(()=>alerts.length>0);
  assert.equal(storedProjects()[0].forkTarget.id,77);assert.equal(storedProjects()[0].accountState,'forked');assert.ok(document.body.textContent?.includes('已分叉'));assert.ok(requests.every(request=>!request.payload));
});
test('an inaccessible account target remains fixed on a fresh device instead of allowing duplicate creation', async()=>{
  localStorage.setItem('gitvault_global_token','account-token');await reloadProjects([]);importAssociationFixture({identical:true});
  const base=globalThis.fetch;globalThis.fetch=async(url,init={})=>String(url)==='https://api.github.com/repos/destination/backup'?ok({message:'Not Found'},404):base(url,init);
  accountRegistry.candidates=async()=>({login:'destination',recorded:[cloudEntry()],legacy:[]});
  await click('新建链接/拉取项目');await input('https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo','source/project');await input('例如: 生产核心源码 / 模块A','跨设备项目');await click('确认拉取进入本地');await waitFor(()=>alerts.length>0);
  assert.equal(storedProjects()[0].uploadTarget.id,77);assert.equal(storedProjects()[0].accountState,'pending');
  await click('全选所有');await click('批量上传至私人仓库');await click('开始批量上传');await waitFor(()=>document.body.textContent?.includes('失败')===true);
  assert.ok(requests.every(request=>!request.payload));assert.equal(storedProjects()[0].uploadTarget.repo,'backup');
});
test('cancel batch first upload stops the current account check and every remaining item and records reasons',async()=>{
  await reloadProjects([repo(),{...repo(),id:'second',owner:'other',repo:'other',url:'https://github.com/other/other'}]);
  let checks=0;
  const {operationSignal}=await import('../src/utils/githubClient');
  accountRegistry.candidates=async()=>{checks++;const signal=operationSignal();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  await openBatch('批量上传至私人仓库',2);await click('开始批量上传');await waitFor(()=>checks===1);await click('取消剩余上传');
  await waitFor(()=>document.querySelectorAll('span').length>0 && [...document.querySelectorAll('span')].filter(span=>span.textContent==='已取消').length===2);
  assert.equal(checks,1);assert.ok(!requests.some(request=>request.payload));
  const logs=JSON.parse(localStorage.getItem('gitvault_operation_logs_v1')!);assert.equal(logs.filter((log:any)=>log.status==='cancelled').length,2);
});
test('cancel batch update keeps an earlier success and never begins the remaining project',async()=>{
  const first=boundProject();first.remoteSnapshot={repoId:77,owner:'destination',repo:'backup',branch:'release',sourceSha:'v2',commitSha:'uploaded',htmlUrl:''};
  await reloadProjects([first,{...repo(),id:'second',owner:'other',repo:'second'},{...repo(),id:'third',owner:'third',repo:'third'}]);identifyDestination();
  const base=globalThis.fetch;let blocked=false;
  globalThis.fetch=async(url,init={})=>{
    const path=String(url);
    if(path.endsWith('/repos/source/project/commits/develop'))return ok({sha:'v2',commit:{message:'current',author:{}}});
    if(path.endsWith('/repos/other/second/commits/develop')){blocked=true;return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));}
    return base(url,init);
  };
  await openBatch('批量更新',3);await click('开始批量更新');await waitFor(()=>blocked);await click('取消剩余操作');await waitFor(()=>batchStatus()==='成功 1 · 失败 0 · 跳过 0 · 取消 2');
  assert.equal(storedProjects()[0].remoteSnapshot.commitSha,'uploaded');assert.ok(!requests.some(request=>request.path.includes('/repos/third/')));
});
test('a verified upload keeps cache and pending account receipt if cloud registration fails, then retries only registration',async()=>{
  await reloadProject(boundProject());identifyDestination();
  let failing=true,saves=0;
  // Use the existing verified local receipt path so preflight migration does not need a write.
  const original=accountRegistry.candidates;let active=false;
  accountRegistry.candidates=async()=>({login:'destination',recorded:active?[{...cloudEntry(),bindings:{develop:{branch:'release',sourceSha:'v2',commitSha:'uploaded',updatedAt:'now'}}}]:[],legacy:[]});
  // The first migration must succeed; the subsequent verified receipt write fails.
  accountRegistry.save=async()=>{saves++;if(saves>1&&failing)throw new GitHubError('GitHub (409): gitvault.json does not match latest-sha',409);active=true;return {} as any;};
  await enterWorkbench();await upload(true);await waitFor(()=>alerts.some(message=>message.includes('项目已在 GitHub 保存')));
  assert.equal(storedProjects()[0].remoteSnapshot.commitSha,'uploaded');assert.equal(storedProjects()[0].cloudPending.length,1);
  assert.equal((await localCache.getProjectFiles('tracked','v2'))[0].content,'new');
  const log=JSON.parse(localStorage.getItem('gitvault_operation_logs_v1')!).find((item:any)=>item.action==='上传指定仓库');
  assert.equal(log.status,'partial');assert.equal(log.httpStatus,409);assert.ok(log.stage.includes('项目已保存'));
  assert.ok(log.message.includes('gitvault.json does not match'));
  const writes=requests.filter(request=>request.path.endsWith('/git/commits')).length;
  failing=false;
  // Make the remote receipt and unchanged source resolvable during the retry.
  const base=globalThis.fetch;globalThis.fetch=async(url,init={})=>{
    const path=String(url);
    if(path.endsWith('/repos/destination/backup/commits/release'))return ok({sha:'uploaded',commit:{tree:{sha:'old-tree'}}});
    if(path.endsWith('/repos/source/project/commits/develop'))return ok({sha:'v2',commit:{message:'current',author:{}}});
    return base(url,init);
  };
  await click('一键更新');await waitFor(()=>storedProjects()[0].cloudPending.length===0);
  assert.equal(requests.filter(request=>request.path.endsWith('/git/commits')).length,writes);
  accountRegistry.candidates=original;
});
test('a first-upload registry conflict is logged before file upload and creates no target repository',async()=>{
  accountRegistry.reserve=async()=>{throw new GitHubError('GitHub (409): gitvault.json does not match latest-sha',409);};
  await enterWorkbench();await click('分叉与私有仓');await click('立即新建私人仓库并上传');
  await waitFor(()=>alerts.some(message=>message.includes('gitvault.json does not match')));
  const log=JSON.parse(localStorage.getItem('gitvault_operation_logs_v1')!).find((item:any)=>item.action==='上传');
  assert.equal(log.status,'error');assert.equal(log.httpStatus,409);assert.equal(log.stage,'检查并预留账号记录');
  assert.ok(!requests.some(request=>request.payload));
  assert.equal(storedProjects()[0].remoteSnapshot,undefined);
  assert.equal((await localCache.getProjectFiles('tracked','v2'))[0].content,'new');
});
test('failure logs are visible with the original GitHub reason and can be filtered',async()=>{
  failUpload=true;rejectionStatus=422;await enterWorkbench();await upload(false);
  await click('操作日志');const dialog=document.querySelector('[aria-label="操作日志"]')!;
  assert.ok(dialog.textContent?.includes('Update is not a fast forward'), JSON.stringify({text:dialog.textContent,alerts,logs:localStorage.getItem('gitvault_operation_logs_v1')}));assert.ok(dialog.textContent?.includes('HTTP 422'));
  await setField(document.querySelector<HTMLSelectElement>('[aria-label="日志筛选"]')!,'failed');assert.ok(dialog.textContent?.includes('失败'));
  assert.ok(!dialog.textContent?.includes('fake-test-token'));
});
test('batch first uploads create only one target for duplicate source branches and skip the other branch',async()=>{
  await reloadProjects([repo(),{...repo(),id:'second',branch:'other'}]);
  await localCache.saveProjectFiles('second',[file('new')],'v2');
  const base=globalThis.fetch;let created=false,creates=0;let registered:AccountProject|undefined;
  accountRegistry.candidates=async()=>({login:'destination',recorded:registered?[registered]:[],legacy:[]});
  accountRegistry.save=async(entry)=>{registered=entry;return {} as any;};
  globalThis.fetch=async(url,init={})=>{
    const path=String(url).replace('https://api.github.com','');
    if(path==='/user')return ok({login:'destination'});
    if(path==='/user/repos'&&init.method==='POST'){created=true;creates++;return ok({id:77,owner:{login:'destination'},name:'project',html_url:'https://github.com/destination/project',default_branch:'main'});}
    if(path==='/repos/destination/project')return created?ok({id:77,owner:{login:'destination'},name:'project',private:true,default_branch:'main',html_url:'https://github.com/destination/project'}):ok({message:'Not Found'},404);
    if(path==='/repos/destination/project/commits/other')return ok({message:'Not Found'},404);
    if(path.startsWith('/repos/destination/project/branches?'))return ok([{name:'develop'}]);
    if(path.startsWith('/repos/destination/project/'))return base(String(url).replace('/destination/project/','/destination/backup/'),init);
    return base(url,init);
  };
  await openBatch('批量上传至私人仓库',2);await click('开始批量上传');await waitFor(()=>document.body.textContent?.includes('已跳过')===true);
  assert.equal(creates,1);const saved=storedProjects();assert.equal(saved[0].uploadTarget.repo,'project');assert.equal(saved[1].uploadTarget.repo,'project');assert.equal(saved[1].uploadTarget.branch,'other');
  assert.ok(!requests.some(request=>request.payload?.ref==='refs/heads/other'));assert.equal(registered?.bindings.develop.commitSha,'uploaded');
});
test('cancel full batch sync preserves verified branch receipts locally for later account registration',async()=>{
  const target={id:77,owner:'destination',repo:'backup',branch:'develop',htmlUrl:'https://github.com/destination/backup',branches:['develop','other']};
  await reloadProject({...repo(),forkTarget:target});identifyDestination();
  const original=githubClient.syncAllForkBranches;let started=false;
  const {operationSignal}=await import('../src/utils/githubClient');
  githubClient.syncAllForkBranches=async(_owner,_repo,_token,onBranch)=>{
    onBranch?.({branch:'develop',success:true,sourceSha:'v3',commitSha:'verified-branch'});started=true;
    const signal=operationSignal();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  };
  try{
    await openBatch('批量分叉同步');await click('开始批量同步');await waitFor(()=>started);await click('取消剩余操作');await waitFor(()=>batchStatus()==='成功 0 · 失败 0 · 跳过 0 · 取消 1');
    assert.equal(storedProjects()[0].cloudPending[0].bindings.develop.commitSha,'verified-branch');
    const logs=JSON.parse(localStorage.getItem('gitvault_operation_logs_v1')!);assert.ok(logs.some((log:any)=>log.status==='success'&&log.message.includes('develop')));assert.ok(logs.some((log:any)=>log.status==='cancelled'));
  }finally{githubClient.syncAllForkBranches=original;}
});
test('an existing accessible target cannot be detached to bypass first-upload deduplication',async()=>{
  await reloadProject(boundProject());identifyDestination();let removed=false;
  accountRegistry.remove=async()=>{removed=true;return {} as any;};
  await enterWorkbench();await click('管理远端目标');await click('解除此目标的所有绑定');
  await waitFor(()=>targetManager()?.textContent?.includes('目标仓库仍然存在')===true);
  assert.equal(storedProjects()[0].uploadTarget.id,77);assert.equal(removed,false);assert.equal(storedProjects()[0].cloudRemovals,undefined);
});

// Exercise the real registry, GitHub HTTP adapter, comparison and UI together.
// A/B are isolated browser storage sessions sharing this synthetic GitHub account.
function accountHttpFixture() {
  const initial=globalThis.fetch;
  const documents=new Map<string,{sha:string;content:string}>();let registryExists=false,registryVersion=0;
  const trees=new Map<string,any[]>([['empty',[]],['source-v2',[entry('new')]],['source-v3',[entry('newest')]],['source-other',[entry('other')]]]);
  const blobs=new Map<string,string>(['new','newest','other'].map(value=>[sha(value),value]));
  const commits=new Map<string,any>([['init',{tree:{sha:'empty'},message:'init',author:{}}],['v2',{tree:{sha:'source-v2'},message:'source',author:{}}],['v3',{tree:{sha:'source-v3'},message:'source newer',author:{}}],['other-v',{tree:{sha:'source-other'},message:'other',author:{}}]]);
  const repositories=new Map<string,{id:number;name:string;refs:Map<string,string>;fork:boolean;private:boolean;description:string}>();
  let counter=0,sourceHead='v2',failRegistry=false;
  const sent:Array<{path:string;method:string;payload:any}>=[];
  globalThis.fetch=async(url,init={})=>{
    const parsed=new URL(String(url));if(parsed.hostname!=='api.github.com')return initial(url,init);
    const path=decodeURIComponent(parsed.pathname),method=init.method||'GET',payload=init.body?JSON.parse(String(init.body)):undefined;
    sent.push({path,method,payload});
    if(path==='/user')return ok({login:'destination',id:7});
    if(path==='/rate_limit')return ok({resources:{core:{remaining:4999,limit:5000}}});
    const metadata=(repo:any)=>({id:repo.id,name:repo.name,owner:{login:'destination'},private:repo.private,default_branch:'develop',description:repo.description,html_url:`https://github.com/destination/${repo.name}`,fork:repo.fork,...(repo.fork?{parent:{id:42,name:'project',owner:{login:'source'},full_name:'source/project'}}:{})});
    if(path==='/user/repos'&&method==='GET')return ok([...repositories.values()].map(metadata));
    if(path==='/user/repos'&&method==='POST'){
      if(payload.name==='.gitvault-state'){registryExists=true;return ok({private:true,owner:{login:'destination'},default_branch:'main',description:'GitVault account sync registry v1'});}
      if(repositories.has(payload.name))return ok({message:'already exists'},422);
      const repo={id:100+ ++counter,name:payload.name,refs:new Map([['main','init']]),fork:false,private:true,description:payload.description};repositories.set(repo.name,repo);return ok(metadata(repo));
    }
    if(path==='/repos/destination/.gitvault-state')return registryExists?ok({private:true,owner:{login:'destination'},default_branch:'main',description:'GitVault account sync registry v1'}):ok({message:'Not Found'},404);
    if(path==='/repos/destination/.gitvault-state/git/ref/heads/main')return ok({object:{sha:String(registryVersion)}});
    if(path==='/repos/destination/.gitvault-state/contents/gitvault.json'){
      if(method==='PUT'){
        if(failRegistry)return ok({message:'account record denied'},403);
        if(payload.sha!==(registryVersion?String(registryVersion):undefined))return ok({message:'conflict'},409);
        registryVersion++;const saved={sha:String(registryVersion),content:payload.content};documents.set('registry',saved);documents.set(String(registryVersion),saved);return ok({content:{sha:String(registryVersion)},commit:{sha:String(registryVersion)}});
      }
      const doc=documents.get(parsed.searchParams.get('ref')||'registry');return doc?ok({...doc,encoding:'base64',size:500}):ok({message:'Not Found'},404);
    }
    if(path==='/repos/source/project')return ok({id:42,name:'project',owner:{login:'source'},default_branch:'develop',html_url:'https://github.com/source/project'});
    if(path==='/repos/source/project/branches')return ok([{name:'develop'},{name:'other'}]);
    if(path==='/repos/source/project/forks'&&method==='POST'){
      const repo={id:100+ ++counter,name:payload.name||'project',refs:new Map([['develop',sourceHead],['other','other-v']]),fork:true,private:false,description:''};repositories.set(repo.name,repo);return ok(metadata(repo));
    }
    const match=/^\/repos\/(source|destination)\/([^/]+)(.*)$/.exec(path);
    if(!match)return ok({message:'Unexpected endpoint'},404);
    const [,owner,name,suffix]=match;const repo=owner==='destination'?repositories.get(name):undefined;
    if(owner==='destination'&&!repo)return ok({message:'Not Found'},404);
    if(repo&&!suffix){if(method==='PATCH'){repositories.delete(repo.name);repo.name=payload.name;repositories.set(repo.name,repo);}return ok(metadata(repo));}
    if(suffix==='/branches')return ok([...(repo?.refs.keys()||[])].map(name=>({name})));
    if(suffix.startsWith('/commits/')){
      const ref=suffix.slice('/commits/'.length);const head=repo?repo.refs.get(ref)||ref:ref==='develop'?sourceHead:ref==='other'?'other-v':ref;
      const commit=commits.get(head);return commit?ok({sha:head,commit}):ok({message:'Not Found'},404);
    }
    if(suffix.startsWith('/git/ref/heads/')){const head=repo?.refs.get(suffix.slice('/git/ref/heads/'.length));return head?ok({object:{sha:head}}):ok({message:'Not Found'},404);}
    if(suffix==='/git/refs'&&method==='POST'){repo!.refs.set(payload.ref.slice('refs/heads/'.length),payload.sha);return ok({object:{sha:payload.sha}});}
    if(suffix.startsWith('/git/refs/heads/')&&method==='PATCH'){repo!.refs.set(suffix.slice('/git/refs/heads/'.length),payload.sha);return ok({object:{sha:payload.sha}});}
    if(suffix==='/git/blobs'&&method==='POST'){const content=payload.encoding==='base64'?Buffer.from(payload.content,'base64').toString():payload.content;blobs.set(sha(content),content);return ok({sha:sha(content)});}
    if(suffix.startsWith('/git/blobs/')){const hash=suffix.slice('/git/blobs/'.length);return blobs.has(hash)?ok({sha:hash,encoding:'base64',content:Buffer.from(blobs.get(hash)!).toString('base64')}):ok({message:'Not Found'},404);}
    if(suffix==='/git/trees'&&method==='POST'){
      const tree=(trees.get(payload.base_tree)||[]).map(item=>({...item}));
      for(const item of payload.tree){const index=tree.findIndex(old=>old.path===item.path);if(index>=0)tree.splice(index,1);if(item.sha!==null)tree.push(item);}
      const hash='tree-'+ ++counter;trees.set(hash,tree);return ok({sha:hash});
    }
    if(suffix.startsWith('/git/trees/'))return ok({tree:trees.get(suffix.slice('/git/trees/'.length))||[],truncated:false});
    if(suffix==='/git/commits'&&method==='POST'){const hash='commit-'+ ++counter;commits.set(hash,{tree:{sha:payload.tree},message:payload.message,author:{},parents:payload.parents});return ok({sha:hash});}
    if(suffix.startsWith('/git/commits/')){const hash=suffix.slice('/git/commits/'.length);return commits.has(hash)?ok(commits.get(hash)):ok({message:'Not Found'},404);}
    if(suffix.startsWith('/contents/')){
      const ref=parsed.searchParams.get('ref')||'develop',head=repo?.refs.get(ref)||ref;const commit=commits.get(head);const item=trees.get(commit?.tree.sha)?.find(item=>item.path===suffix.slice('/contents/'.length));
      return item?ok({type:'file',sha:item.sha,encoding:'base64',size:blobs.get(item.sha)?.length||0,content:Buffer.from(blobs.get(item.sha)||'').toString('base64')}):ok({message:'Not Found'},404);
    }
    return ok({message:'Unexpected endpoint '+path},404);
  };
  Object.assign(accountRegistry,createAccountRegistry(githubApi));
  return {repositories,sent,documents,trees,commits,setSource:(sha:string)=>{sourceHead=sha;},failRecords:(value:boolean)=>{failRegistry=value;},document:()=>{const stored=documents.get('registry');return stored?JSON.parse(Buffer.from(stored.content,'base64').toString()):undefined;}};
}
async function freshDevice() {localStorage.clear();localStorage.setItem('gitvault_global_token','account-token');await reloadProjects([]);}
async function importSourceLink(){await click('新建链接/拉取项目');await input('https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo','source/project');await input('例如: 生产核心源码 / 模块A','跨设备项目');await click('确认拉取进入本地');}
test('HTTP A upload -> fresh B same-name compare -> auto-bind -> tag save -> branch-only update without registry mocks',async()=>{
  const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');await click('立即新建私人仓库并上传');await waitFor(()=>storedProjects()[0].remoteSnapshot?.commitSha);
  const a=storedProjects()[0];const originalHead=server.repositories.get('project')!.refs.get('develop');assert.equal(server.document().projects[0].target.id,a.uploadTarget.id);
  // A missing index tests same-name discovery and a full manifest comparison.
  const doc=server.documents.get('registry')!;doc.content=Buffer.from(JSON.stringify({...server.document(),projects:[]})).toString('base64');
  await freshDevice();alerts=[];await importSourceLink();await waitFor(()=>alerts.length>0);
  const b=storedProjects()[0];assert.equal(b.uploadTarget.id,a.uploadTarget.id);assert.equal(b.remoteSnapshot.commitSha,originalHead);assert.ok(document.body.textContent?.includes('私人仓库已同步'));assert.ok(!importDialog());
  await enterWorkbench();await click('编辑备注与描述');
  const tagField=[...document.querySelectorAll<HTMLInputElement>('input')].find(field=>field.value==='默认')!;assert.ok(tagField);await setField(tagField,'B标签');await click('保存修改');await waitFor(()=>server.document().projects[0].profile.tags.includes('B标签'));
  server.setSource('v3');await click('一键更新');await waitFor(()=>storedProjects()[0].latestCommitSha==='v3'&&storedProjects()[0].remoteSnapshot?.sourceSha==='v3');
  assert.notEqual(server.repositories.get('project')!.refs.get('develop'),originalHead);assert.equal(server.repositories.get('project')!.refs.get('main'),'init');
  await freshDevice();alerts=[];await importSourceLink();await waitFor(()=>alerts.length>0);assert.deepEqual(storedProjects()[0].tags,['B标签']);
});
test('HTTP A native Fork -> fresh B restores true Fork tag and all-branch identity',async()=>{
  const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');await click('板块二：创建分叉与上游同步');
  const select=[...document.querySelectorAll('select')].find(field=>[...field.options].some(option=>option.value==='full'))!;await setField(select,'full');await input('project','project');await click('完整分叉并加入我的项目');await waitFor(()=>storedProjects().some((project:any)=>project.forkScope==='full'));
  await freshDevice();alerts=[];await importSourceLink();await waitFor(()=>alerts.length>0);assert.equal(storedProjects()[0].forkTarget.repo,'project');assert.ok(document.body.textContent?.includes('已分叉 · 已同步'));
  assert.equal(server.sent.filter(request=>request.path.endsWith('/forks')&&request.method==='POST').length,1);
});
test('HTTP code difference offers a new-name upload and switches primary after verification while preserving old history',async()=>{
  const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');await click('立即新建私人仓库并上传');await waitFor(()=>storedProjects()[0].remoteSnapshot);
  const oldHead=server.repositories.get('project')!.refs.get('develop');server.setSource('v3');await freshDevice();alerts=[];await importSourceLink();await waitFor(()=>!!importDialog());assert.ok(importDialog()?.textContent?.includes('修改 1'));
  await setField(document.querySelector<HTMLInputElement>('[aria-label="导入另存仓库名"]')!,'project-custom');await click('使用新名称上传并固定');await waitFor(()=>storedProjects()[0]?.uploadTarget?.repo==='project-custom');
  assert.equal(server.repositories.get('project')!.refs.get('develop'),oldHead);assert.equal(storedProjects()[0].primarySource.repo,'project-custom');assert.equal(storedProjects()[0].targetHistory[0].target.repo,'project');assert.equal(server.document().projects[0].target.repo,'project-custom');
  // Follow the renamed primary, preserving its own files instead of copying the template.
  const before=server.sent.length;await enterWorkbench();await click('一键更新');await waitFor(()=>alerts.some(message=>message.includes('固定主仓库')));assert.ok(!server.sent.slice(before).some(request=>request.path==='/repos/source/project/commits/develop'));
});
test('HTTP switch registration failure keeps old binding and cached files; retry commits binding without another upload',async()=>{
  const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');await click('立即新建私人仓库并上传');await waitFor(()=>storedProjects()[0].remoteSnapshot);
  const oldId=storedProjects()[0].uploadTarget.id;await click('分叉与私有仓');await click('另存并切换固定仓库');await setField(document.querySelector<HTMLInputElement>('[aria-label="另存目标仓库"]')!,'saved-copy');
  // Allow reservation, then reject only the final switch record.
  const base=globalThis.fetch;globalThis.fetch=async(url,init={})=>{if(init.method==='PUT'&&String(url).includes('.gitvault-state/contents')){const value=JSON.parse(String(init.body));const doc=JSON.parse(Buffer.from(value.content,'base64').toString());if(doc.projects[0]?.target.repo==='saved-copy'&&doc.projects[0].state==='active')return ok({message:'record denied'},403);}return base(url,init);};
  await click('确认另存并切换');await waitFor(()=>!!storedProjects()[0].pendingSwitch?.result);await waitFor(()=>document.querySelector('[aria-label="另存并切换固定仓库"]')?.textContent?.includes('旧固定关系保留')===true);
  assert.equal(storedProjects()[0].uploadTarget.id,oldId);assert.equal((await localCache.getProjectFiles('tracked','v2'))[0].content,'new');const writes=server.sent.filter(request=>request.path.endsWith('/git/commits')&&request.method==='POST').length;
  globalThis.fetch=base;await click('继续完成切换');await waitFor(()=>storedProjects()[0].uploadTarget.repo==='saved-copy');assert.equal(server.sent.filter(request=>request.path.endsWith('/git/commits')&&request.method==='POST').length,writes);assert.equal(storedProjects()[0].pendingSwitch,undefined);
});
test('HTTP difference can update the selected existing branch immediately while keeping other branches',async()=>{
 const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');await click('立即新建私人仓库并上传');await waitFor(()=>storedProjects()[0].remoteSnapshot);
 const previous=server.repositories.get('project')!.refs.get('develop');server.setSource('v3');await freshDevice();alerts=[];await importSourceLink();await waitFor(()=>!!importDialog());await click('更新此仓库（保留历史）');await waitFor(()=>storedProjects()[0]?.remoteSnapshot?.sourceSha==='v3'&&!!alerts.length);
 assert.notEqual(server.repositories.get('project')!.refs.get('develop'),previous);assert.equal(server.repositories.get('project')!.refs.get('main'),'init');assert.equal(server.repositories.size,1);
});
test('HTTP renaming keeps ID, updates shared primary location and can be recovered on another device',async()=>{
 const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');const field=[...document.querySelectorAll<HTMLInputElement>('input')].find(item=>item.value==='project')!;await setField(field,'renamed-copy');await click('立即新建私人仓库并上传');await waitFor(()=>storedProjects()[0].primarySource?.repo==='renamed-copy');
 const id=storedProjects()[0].uploadTarget.id;(globalThis as any).prompt=()=> 'renamed-again';await click('分叉与私有仓');await click('修改项目名称');await waitFor(()=>storedProjects()[0].uploadTarget.repo==='renamed-again');assert.equal(storedProjects()[0].uploadTarget.id,id);assert.equal(storedProjects()[0].primarySource.repo,'renamed-again');assert.equal(server.document().projects[0].target.repo,'renamed-again');
 await freshDevice();alerts=[];await importSourceLink();await waitFor(()=>alerts.length>0);assert.equal(storedProjects()[0].uploadTarget.id,id);assert.equal(storedProjects()[0].primarySource.repo,'renamed-again');
});
test('HTTP cancel a switch preserves its previous target and can resume after explicitly comparing the created destination',async()=>{
 const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');await click('立即新建私人仓库并上传');await waitFor(()=>storedProjects()[0].remoteSnapshot);const oldId=storedProjects()[0].uploadTarget.id;
 await click('分叉与私有仓');await click('另存并切换固定仓库');await setField(document.querySelector<HTMLInputElement>('[aria-label="另存目标仓库"]')!,'cancelled-copy');
 const base=globalThis.fetch;let blocked=false;globalThis.fetch=async(url,init={})=>{if(String(url).includes('/cancelled-copy/git/blobs')&&init.method==='POST'){blocked=true;return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));}return base(url,init);};
 await click('确认另存并切换');await waitFor(()=>blocked);await click('取消剩余操作');await waitFor(()=>!!storedProjects()[0].pendingSwitch&&!document.querySelector('[aria-label="另存并切换固定仓库"]')?.textContent?.includes('取消剩余操作'));
 assert.equal(storedProjects()[0].uploadTarget.id,oldId);assert.equal((await localCache.getProjectFiles('tracked','v2'))[0].content,'new');globalThis.fetch=base;
 await click('比较新目标代码');await waitFor(()=>document.querySelector('[aria-label="另存并切换固定仓库"] [role=status]')!==null);await click('确认另存并切换');await waitFor(()=>storedProjects()[0].uploadTarget.repo==='cancelled-copy');assert.equal(server.repositories.size,2);
});
test('HTTP same-name code comparison works when the optional rename index is unreadable and reports its pending record',async()=>{
 const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');await click('立即新建私人仓库并上传');await waitFor(()=>storedProjects()[0].remoteSnapshot);
 const base=globalThis.fetch;globalThis.fetch=async(url,init={})=>String(url).includes('/repos/destination/.gitvault-state')?ok({message:'index access denied'},403):base(url,init);
 await freshDevice();alerts=[];await importSourceLink();await waitFor(()=>alerts.length>0);assert.equal(storedProjects()[0].uploadTarget.repo,'project');assert.equal(storedProjects()[0].remoteSnapshot.sourceSha,'v2');assert.ok(document.body.textContent?.includes('私人仓库已同步'));assert.ok(document.body.textContent?.includes('账号记录待补存'));assert.equal(server.repositories.size,1);
});
test('HTTP primary branch switching reads the fixed repository, registers the branch and never writes another branch',async()=>{
 const server=accountHttpFixture();await enterWorkbench();await click('分叉与私有仓');const field=[...document.querySelectorAll<HTMLInputElement>('input')].find(item=>item.value==='project')!;await setField(field,'my-primary');await click('立即新建私人仓库并上传');await waitFor(()=>storedProjects()[0].primarySource?.repo==='my-primary');
 server.repositories.get('my-primary')!.refs.set('feature/demo','other-v');const oldHead=server.repositories.get('my-primary')!.refs.get('develop');const before=server.sent.length;await enterWorkbench();await switchBranch('feature/demo');
 assert.equal(storedProjects()[0].primarySource.branch,'feature/demo');assert.equal(storedProjects()[0].uploadTarget.branch,'feature/demo');assert.equal(storedProjects()[0].remoteSnapshot.sourceSha,'other-v');assert.equal(server.document().projects[0].bindings['feature/demo'].branch,'feature/demo');assert.equal(server.repositories.get('my-primary')!.refs.get('develop'),oldHead);assert.ok(!server.sent.slice(before).some(request=>request.method==='PATCH'||request.path.startsWith('/repos/source/project/commits/')));
});
