import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCandidates, compareImportTrees } from '../src/utils/importAssociation';

const source = { owner: 'author', repo: 'template', url: 'https://github.com/author/template', branch: 'develop' };
const target = { id: 77, owner: 'me', repo: 'renamed-project', branch: 'release', purgeAfterUpload: true, kind: 'upload' as const };
test('import matching uses recorded source identity, preserves renamed targets and exact branch mappings', () => {
  const projects = [{ ...source, id: 'old', uploadTarget: target, branchTargets: { develop: target } }];
  const exact = importCandidates(projects, { ...source, owner: 'AUTHOR' });
  assert.equal(exact.length, 1); assert.equal(exact[0].target.repo, 'renamed-project'); assert.equal(exact[0].target.branch, 'release');
  assert.equal(importCandidates(projects, { ...source, owner: 'unrelated' }).length, 0);
  assert.equal(importCandidates(projects, { ...source, branch: 'feature/demo' })[0].target.branch, 'feature/demo');
});
test('managed Forks, independent copies and multiple destination choices are discovered without mutating bindings', () => {
  const projects = [{ ...source, id: 'original', savedCopies: [{ repoId: 78, owner: 'me', repo: 'copy', branch: 'develop', commitSha: 'copy', sourceSha: 'source', htmlUrl: '' }] },
    { ...source, owner: 'me', repo: 'renamed-project', id: 'managed', origin: source, uploadTarget: { ...target, kind: 'full' as const }, forkTarget: { ...target, branches: ['develop', 'other'] } }];
  const before = JSON.stringify(projects), candidates = importCandidates(projects, source);
  assert.equal(candidates.length, 2); assert.equal(candidates.find(c => c.target.id === 77)?.fullFork, true);
  assert.equal(candidates.find(c => c.target.id === 77)?.target.branch, 'release');
  assert.equal(candidates.find(c => c.target.id === 78)?.target.kind, 'current');
  assert.equal(JSON.stringify(projects), before);
});
test('explicit mappings from another record take priority over inferred branch names', () => {
  const projects = [{ ...source, id: 'develop', uploadTarget: target }, { ...source, id: 'feature', branch: 'feature/demo', uploadTarget: { ...target, branch: 'delivery' } }];
  assert.equal(importCandidates(projects, { ...source, branch: 'feature/demo' })[0].target.branch, 'delivery');
});
test('a link to a known uploaded destination resolves back to its original source and explicit branch mapping', () => {
  const projects = [{ ...source, id: 'old', uploadTarget: target }];
  const candidates = importCandidates(projects, { owner: 'ME', repo: 'renamed-project', url: 'https://github.com/me/renamed-project', branch: 'release' });
  assert.equal(candidates.length, 1); assert.deepEqual(candidates[0].source, source);
  assert.equal(candidates[0].target.branch, 'release');
  assert.equal(importCandidates(projects, { ...source, owner: 'me', repo: 'renamed-project', branch: 'unmapped' })[0].source.branch, 'unmapped');
});
test('comparison checks paths, hashes, file modes, symlinks and submodules, with generated metadata excluded only for uploads', () => {
  const file = (path: string, sha = 'same', mode = '100644', type = 'blob') => ({ path, sha, mode, type });
  const from = [file('mode'), file('old'), file('link'), file('module', 'a', '160000', 'commit'), file('GITVAULT_METADATA.md')];
  const to = [file('mode', 'same', '100755'), file('new'), file('link', 'same', '120000'), file('module', 'b', '160000', 'commit')];
  assert.deepEqual(compareImportTrees(to, from, true), { added: ['new'], modified: ['link', 'mode', 'module'], removed: ['old'] });
  assert.deepEqual(compareImportTrees(to, from).removed, ['GITVAULT_METADATA.md', 'old']);
  assert.deepEqual(compareImportTrees([file('GITVAULT_METADATA.md', 'source')], [file('GITVAULT_METADATA.md')], true).modified, ['GITVAULT_METADATA.md']);
});
