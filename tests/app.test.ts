import { dom } from './dom';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { localCache } from '../src/utils/localCache';
import { beginGithubOperation } from '../src/utils/githubClient';
import App from '../src/App';

const originalFetch = globalThis.fetch;
const sha = (s: string) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const file = (content: string) => ({ path: 'a.txt', content, isBase64: false, sha: sha(content), mode: '100644' });
const entry = (content: string) => ({ path: 'a.txt', sha: sha(content), mode: '100644', type: 'blob', size: content.length });
const repo = () => ({ id: 'tracked', url: 'https://github.com/source/project', owner: 'source', repo: 'project', branch: 'develop', token: 'fake-test-token', remark: 'test project', description: '', tags: ['默认'], checkInterval: 0, latestCommitSha: 'v2', commitMessage: 'new', commitAuthor: 'author', commitDate: '2026-10-15T00:00:00Z', lastSyncedAt: '2026-10-15T00:00:00Z', repoMeta: { htmlUrl: 'https://github.com/source/project' }, tree: [entry('new')], cachedFilesCount: 1, isCachePurged: false, backups: [{ id: 'old', versionNumber: 1, tag: 'v1', annotation: 'old version', commitSha: 'v1', commitMessage: 'old', commitAuthor: 'author', commitDate: '2026-10-14T00:00:00Z', backedUpAt: '2026-10-15T00:00:00Z', tree: [entry('old')] }] });
let root: Root;
let alerts: string[];
let requests: Array<{ path: string; payload: any }>;
let failUpload: boolean;
let uploadedContents: string[];
const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(async () => {
  beginGithubOperation(); localStorage.clear(); document.body.innerHTML = '<div id="root"></div>';
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('GitVault_Storage_v1'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  alerts = []; requests = []; uploadedContents = []; failUpload = false;
  (globalThis as any).alert = (message: string) => alerts.push(message);
  (globalThis as any).confirm = () => true;
  (globalThis as any).prompt = () => 'fake-test-token';
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input).replace('https://api.github.com', '');
    const payload = init.body ? JSON.parse(init.body as string) : null;
    requests.push({ path, payload });
    if (path === '/repos/destination/backup') return ok({ default_branch: 'main' });
    if (path === '/repos/destination/backup/git/ref/heads/release') return ok({ object: { sha: requests.some(r => r.path.endsWith('/git/refs/heads/release')) ? 'uploaded' : 'parent' } });
    if (path.endsWith('/git/commits/parent')) return ok({ tree: { sha: 'old-tree' } });
    if (path.includes('/git/trees/old-tree')) return ok({ tree: [] });
    if (path.endsWith('/git/blobs')) { uploadedContents.push(payload.content); return ok({ sha: sha(payload.content) }); }
    if (path.endsWith('/git/trees')) return ok({ sha: 'uploaded-tree' });
    if (path.endsWith('/git/commits')) return ok({ sha: 'uploaded' });
    if (path.endsWith('/git/refs/heads/release')) return failUpload ? ok({ message: 'rejected' }, 403) : ok({ object: { sha: 'uploaded' } });
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
  await input('留空使用目标默认分支', 'release');
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
  assert.ok(document.querySelector('pre')?.textContent?.includes('old'));
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
  await input('owner/repo', 'destination/backup'); await input('留空使用目标默认分支', 'release');
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
