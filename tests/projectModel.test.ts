import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOf, savedSnapshot, renamedProject, archiveVersion, targetForBranch, assertBranchTarget } from '../src/utils/projectModel';

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
  const archived = archiveVersion({ ...project, latestCommitSha: 'new', tree: [], commitMessage: '', commitAuthor: '', commitDate: '' });
  assert.equal(archived.remoteSnapshot?.sourceSha, 'new');
  assert.equal(archived.remoteSnapshot?.commitSha, 'previous-current');
});

test('branch routing remembers explicit legacy bindings and uses slash branch names for new branches', () => {
  const uploadTarget = { id: 77, owner: 'me', repo: 'chosen', branch: 'release', purgeAfterUpload: false };
  const project = { owner: 'author', repo: 'template', url: 'author/template', branch: 'develop', uploadTarget, branchTargets: { develop: uploadTarget } };
  assert.equal(targetForBranch(project, 'develop')?.branch, 'release');
  const next = targetForBranch(project, 'feature/demo')!;
  assert.equal(next.branch, 'feature/demo'); assert.equal(next.id, 77);
  assert.doesNotThrow(() => assertBranchTarget(project, 'feature/demo', next));
  assert.throws(() => assertBranchTarget(project, 'release', { ...next, branch: 'release' }), /不能用 release 覆盖/);
  assert.equal(targetForBranch(project, '__proto__')?.branch, '__proto__');
});

test('renaming a repository updates every branch binding and retains the source branch of archived versions', () => {
  const source = { owner: 'author', repo: 'template', url: 'author/template', branch: 'feature/demo' };
  const uploadTarget = { id: 77, owner: 'me', repo: 'chosen', branch: 'feature/demo', purgeAfterUpload: false };
  const project = { ...source, uploadTarget, branchTargets: { develop: { ...uploadTarget, branch: 'release' }, 'feature/demo': uploadTarget }, repoMeta: {}, backups: [], latestCommitSha: 'source', tree: [], commitMessage: '', commitAuthor: '', commitDate: '' };
  const renamed = renamedProject(project, uploadTarget, { id: 77, owner: 'me', repo: 'new-name', htmlUrl: 'https://github.com/me/new-name' });
  assert.equal(renamed.branchTargets.develop.repo, 'new-name'); assert.equal(renamed.branchTargets.develop.branch, 'release');
  assert.equal(renamed.branchTargets['feature/demo'].repo, 'new-name');
  assert.equal(archiveVersion(project).branch, 'feature/demo');
});
