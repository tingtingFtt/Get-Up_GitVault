import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOf, savedSnapshot, renamedProject } from '../src/utils/projectModel';

test('renaming a bound repository updates copies and all history links without changing source', () => {
  const target = { id: 77, owner: 'me', repo: 'chosen-name', branch: 'release', purgeAfterUpload: false };
  const snapshot = { repoId: 77, owner: 'me', repo: 'chosen-name', branch: 'release', commitSha: 'target-v1', sourceSha: 'source-v1', htmlUrl: 'old' };
  const source = { owner: 'author', repo: 'template', url: 'https://github.com/author/template', branch: 'develop' };
  const project = { ...source, repoMeta: { htmlUrl: source.url }, uploadTarget: target, remoteSnapshot: snapshot, privateRepoUrl: 'old', backups: [{ id: 'v1', versionNumber: 1, tag: 'v1', annotation: '', commitSha: 'source-v1', commitMessage: '', commitAuthor: '', commitDate: '', backedUpAt: '', tree: [], remoteSnapshot: snapshot }], savedCopies: [snapshot] };
  const renamed = renamedProject(project, target, { id: 77, owner: 'me', repo: 'new-name', htmlUrl: 'https://github.com/me/new-name' });
  assert.equal(renamed.uploadTarget.repo, 'new-name'); assert.equal(renamed.uploadTarget.branch, 'release');
  assert.equal(renamed.remoteSnapshot.commitSha, 'target-v1'); assert.equal(renamed.backups[0].remoteSnapshot?.repo, 'new-name');
  assert.equal(renamed.savedCopies[0].repo, 'new-name'); assert.deepEqual(sourceOf(renamed), source);
  assert.equal(project.uploadTarget.repo, 'chosen-name');
});

test('restoring an old target does not make it the cache source for a newer source version', () => {
  const old = { owner: 'me', repo: 'backup', branch: 'main', sourceSha: 'old', commitSha: 'restored', htmlUrl: '' };
  const current = { ...old, sourceSha: 'new', commitSha: 'previous-current' };
  const project = { remoteSnapshot: old, backups: [{ id: 'new', versionNumber: 1, tag: '', annotation: '', commitSha: 'new', commitMessage: '', commitAuthor: '', commitDate: '', backedUpAt: '', tree: [], remoteSnapshot: current }] };
  assert.equal(savedSnapshot(project, 'new')?.commitSha, 'previous-current');
  assert.equal(savedSnapshot(project, 'old')?.commitSha, 'restored');
});
