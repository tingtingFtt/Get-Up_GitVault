import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detachedTarget, projectTargets } from '../src/utils/targetLifecycle';
import { importCandidates } from '../src/utils/importAssociation';

const source = { owner: 'source', repo: 'template', branch: 'develop', url: 'https://github.com/source/template' };
const target = { id: 77, owner: 'me', repo: 'backup', branch: 'release', purgeAfterUpload: false, token: 'secret' };
const other = { ...target, id: 88, repo: 'another' };
test('detaching clears only matching live bindings, preserves independent targets and all historical snapshots', () => {
  const snapshot = { owner: 'me', repo: 'backup', repoId: 77, branch: 'release', sourceSha: 'source-sha', commitSha: 'remote-sha', htmlUrl: 'old' };
  const project = { ...source, id: 'original', uploadTarget: target, branchTargets: { develop: target, feature: { ...target, branch: 'feature' }, other }, forkTarget: { ...target, htmlUrl: 'old' }, forkScope: 'full' as const, privateRepoUrl: 'https://github.com/me/backup', remoteSnapshot: snapshot, backups: [{ commitSha: 'old', remoteSnapshot: snapshot }], savedCopies: [snapshot], latestCommitSha: 'source-sha', repoMeta: {}, targetHealth: { 'id:77': { ...target, status: 'unavailable' as const, message: '', checkedAt: '' } } };
  const detached = detachedTarget(project, target);
  assert.equal(detached.uploadTarget, undefined); assert.equal(detached.forkTarget, undefined); assert.equal(detached.forkScope, undefined);
  assert.equal(detached.privateRepoUrl, undefined); assert.deepEqual(detached.branchTargets, { other });
  assert.equal(detached.backups, project.backups); assert.equal(detached.remoteSnapshot, snapshot); assert.equal(detached.savedCopies, project.savedCopies);
  assert.equal(detached.branch, 'develop'); assert.deepEqual(detached.detachedTargets, [{ id: 77, owner: 'me', repo: 'backup' }]);
  assert.equal(importCandidates([detached], source).some(candidate => candidate.target.id === 77), false);
  assert.equal(project.uploadTarget, target);
});
test('detaching a managed Fork resumes its original source without losing project identity or history', () => {
  const project = { ...source, id: 'managed-77', owner: 'me', repo: 'backup', url: 'https://github.com/me/backup', origin: source, uploadTarget: target, forkScope: 'full' as const, repoMeta: { htmlUrl: 'old' }, backups: [{ commitSha: 'historical', remoteSnapshot: undefined }] };
  const detached = detachedTarget(project, target);
  assert.equal(detached.id, 'managed-77'); assert.equal(detached.owner, 'source'); assert.equal(detached.url, source.url);
  assert.equal(detached.origin, source); assert.equal(detached.backups, project.backups); assert.equal(detached.forkScope, undefined);
});
test('current target enumeration deduplicates branches and never includes tokens or historical-only repositories', () => {
  const project = { ...source, uploadTarget: target, branchTargets: { develop: target }, forkTarget: { ...target, htmlUrl: 'old' }, savedCopies: [{ ...other, repoId: 88, sourceSha: 'source-sha', commitSha: 'remote-sha', htmlUrl: '' }], repoMeta: {} };
  assert.deepEqual(projectTargets(project), [{ id: 77, owner: 'me', repo: 'backup' }]);
  assert.equal(detachedTarget(project, { ...target, id: 99 }), project);
});
test('legacy URL-only bindings detach safely and a new confirmed repository ID is still eligible for import matching', () => {
  const legacy = { ...source, id: 'legacy', privateRepoUrl: 'https://github.com/me/backup', repoMeta: {}, backups: [] };
  assert.equal(detachedTarget(legacy, target).privateRepoUrl, undefined);
  const project = { ...source, id: 'new', uploadTarget: { ...target, id: 99 }, detachedTargets: [{ id: 77, owner: 'me', repo: 'backup' }], repoMeta: {} };
  assert.equal(importCandidates([project], source)[0].target.id, 99);
});
test('detaching also retires historical-only copies in sibling source records without changing their live upload destination', () => {
  const snapshot = { owner: 'me', repo: 'backup', repoId: 77, branch: 'develop', sourceSha: 'source-sha', commitSha: 'remote-sha', htmlUrl: 'old' };
  const project = { ...source, id: 'sibling', uploadTarget: other, savedCopies: [snapshot], remoteSnapshot: snapshot, repoMeta: {} };
  const detached = detachedTarget(project, target);
  assert.equal(detached.uploadTarget, other); assert.equal(detached.savedCopies, project.savedCopies); assert.equal(detached.remoteSnapshot, snapshot);
  assert.equal(importCandidates([detached], source).some(candidate => candidate.target.id === 77), false);
  assert.equal(importCandidates([detached], source).some(candidate => candidate.target.id === 88), true);
});
