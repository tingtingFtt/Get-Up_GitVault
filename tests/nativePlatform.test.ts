import './dom';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Capacitor } from '@capacitor/core';
import { nativeBridge, exportProjectDirectory, saveDownload, safeRelativePath } from '../src/utils/nativePlatform';
import { initializeCredentials, readCredentialValue, writeCredentialValue, flushCredentials } from '../src/utils/credentialStorage';
const methods = { ...nativeBridge };
const platform = { isNativePlatform: Capacitor.isNativePlatform, getPlatform: Capacitor.getPlatform, isPluginAvailable: Capacitor.isPluginAvailable };
beforeEach(() => {
  localStorage.clear();
  Capacitor.isNativePlatform = () => true; Capacitor.getPlatform = () => 'android'; Capacitor.isPluginAvailable = () => true;
  nativeBridge.readVault = async () => ({ value: '' }); nativeBridge.writeVault = async () => {};
});
afterEach(() => { Object.assign(nativeBridge, methods); Object.assign(Capacitor, platform); });
test('Android migration strips all nested project Tokens from WebView storage after encrypted persistence', async () => {
  const project = { id: 'p', token: 'source-token', uploadTarget: { token: 'target-token' }, branchTargets: { main: { token: 'branch-token' } } };
  localStorage.setItem('gitvault_global_token', 'global-token'); localStorage.setItem('gitvault_repos_v8', JSON.stringify([project]));
  let persisted = '';
  nativeBridge.writeVault = async ({ value }) => { persisted = value; };
  await initializeCredentials();
  assert.equal(localStorage.getItem('gitvault_global_token'), null);
  assert.equal(localStorage.getItem('gitvault_repos_v8'), null);
  assert.equal(JSON.parse(readCredentialValue('gitvault_repos_v8')!)[0].uploadTarget.token, 'target-token');
  assert.ok(persisted.includes('global-token'));
  writeCredentialValue('gitvault_global_token', 'replacement-token'); await flushCredentials();
  assert.equal(JSON.parse(persisted).gitvault_global_token, 'replacement-token');
});
test('failed encryption migration preserves originals and prevents cache-clear durability checks', async () => {
  localStorage.setItem('gitvault_global_token', 'original');
  nativeBridge.writeVault = async () => { throw new Error('disk full'); };
  await assert.rejects(initializeCredentials, /disk full/);
  assert.equal(localStorage.getItem('gitvault_global_token'), 'original');
  writeCredentialValue('gitvault_global_token', 'changed');
  await assert.rejects(flushCredentials, /安全存储未完成/);
  nativeBridge.writeVault = async () => {}; writeCredentialValue('gitvault_global_token', 'changed'); await flushCredentials();
});
test('exports distinguish branches, preserve binary bytes and write completion receipt last', async () => {
  const paths: string[] = [], data: string[] = [];
  nativeBridge.writeDocument = async options => { paths.push(options.path); data.push(options.data); };
  await exportProjectDirectory('content://chosen/folder', { owner: 'source', repo: 'project', branch: 'feature/a', latestCommitSha: 'abc' }, [{ path: '.gitvault-export.json', content: 'source content', isBase64: false }, { path: 'image.bin', content: 'AP8=', isBase64: true }]);
  assert.equal(paths[0], 'source/project/feature%2Fa/abc/files/.gitvault-export.json'); assert.equal(data[1], 'AP8=');
  assert.equal(paths.at(-1), 'source/project/feature%2Fa/abc/.gitvault-export.json');
});
test('an interrupted directory export never writes a completion receipt', async () => {
  const paths: string[] = [];
  nativeBridge.writeDocument = async options => { paths.push(options.path); throw new Error('access revoked'); };
  await assert.rejects(() => exportProjectDirectory('content://chosen/folder', { owner: 'a', repo: 'b', branch: 'main', latestCommitSha: 'abc' }, [{ path: 'a.txt', content: 'a', isBase64: false }]), /access revoked/);
  assert.equal(paths.length, 1); assert.ok(!paths[0].endsWith('.gitvault-export.json'));
});
test('unsafe document paths and raw Android paths are rejected', async () => {
  for (const path of ['/absolute','../outside','a/../outside','a\\b','a//b','a/','a/\0b']) assert.throws(() => safeRelativePath(path));
  await assert.rejects(() => exportProjectDirectory('/storage/emulated/0/Download', { owner: 'a', repo: 'b', branch: 'main', latestCommitSha: 'abc' }, []), /授权/);
});
test('native downloads stream chunks and clean private staging when the picker is cancelled', async () => {
  let bytes = 0, aborted = false;
  nativeBridge.beginDownload = async () => ({ id: 'staging' });
  nativeBridge.appendDownload = async ({ data }) => { bytes += Buffer.from(data, 'base64').length; assert.ok(data.length < 400000); };
  nativeBridge.finishDownload = async () => { throw new Error('cancelled'); };
  nativeBridge.abortDownload = async () => { aborted = true; };
  await assert.rejects(() => saveDownload(new Blob([new Uint8Array(600000)]), 'project.zip'), /cancelled/);
  assert.equal(bytes, 600000); assert.equal(aborted, true);
});
