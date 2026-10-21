import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSelections } from '../src/utils/projectSelection';

const source = { owner: 'upstream', repo: 'app', repositoryId: 1, url: 'https://github.com/upstream/app', branch: 'main' };
const project = (id: string, extra: Record<string, unknown> = {}) => ({ ...source, id, repoMeta: {}, ...extra });
const target = { id: 7, owner: 'me', repo: 'app-copy', branch: 'main', purgeAfterUpload: false };
const fork = { ...target, htmlUrl: 'https://github.com/me/app-copy' };

test('first-operation shortcuts exclude fixed, failed, legacy and pending relationships', () => {
  for (const extra of [
    { uploadTarget: target }, { forkTarget: fork }, { branchTargets: { dev: target } },
    { privateRepoUrl: fork.htmlUrl }, { creationReservation: { target } }, { pendingSwitch: {} },
    { cloudPending: [{}] }, { accountState: 'synced' }, { lastUploadedToPrivateAt: 'yesterday' },
    { uploadTarget: target, targetHealth: { 'id:7': { ...target, status: 'unavailable', message: 'deleted', checkedAt: '' } } },
  ]) {
    const bound = project('bound', extra);
    const selections = projectSelections([bound], [bound]);
    assert.deepEqual(selections.unuploaded, []);
    assert.deepEqual(selections.unforked, []);
  }
  const detached = project('detached', { detachedTargets: [target] });
  assert.deepEqual(projectSelections([detached], [detached]).unuploaded, ['detached']);
});

test('a filtered-out managed copy blocks a repeated first operation across source branches and renames', () => {
  const original = project('original');
  const managed = project('managed', { owner: 'me', repo: 'renamed', origin: { ...source, repo: 'old-name', branch: 'dev' }, uploadTarget: target });
  const unrelated = project('other', { repositoryId: 2, repo: 'different' });
  const selected = projectSelections([original, unrelated], [original, unrelated, managed]);
  assert.deepEqual(selected.unuploaded, ['other']);
  assert.deepEqual(selected.unforked, ['other']);
  // A newly created repository reusing an old name has a different immutable identity.
  const replacement = project('replacement', { repositoryId: 9 });
  const old = project('old', { uploadTarget: target });
  assert.deepEqual(projectSelections([replacement], [replacement, old]).unuploaded, ['replacement']);
  const legacy = project('legacy', { repositoryId: undefined, uploadTarget: target });
  assert.deepEqual(projectSelections([replacement], [replacement, legacy]).unuploaded, []);
});

test('sync shortcut selects managed Forks and branch copies, skips unsafe targets and deduplicates only the same scope', () => {
  const original = project('original', { forkTarget: fork });
  const managed = project('managed', { origin: source, forkScope: 'full', forkTarget: fork, uploadTarget: target });
  const current = project('current', { forkScope: 'current', uploadTarget: { ...target, id: 8 } });
  const dev = project('dev', { forkScope: 'current', uploadTarget: { ...target, id: 8, branch: 'dev' } });
  const duplicate = project('duplicate', { forkScope: 'current', uploadTarget: { ...target, id: 8 } });
  const upload = project('upload', { uploadTarget: target });
  const unavailable = project('unavailable', { forkScope: 'full', forkTarget: { ...fork, id: 10 }, targetHealth: { 'id:10': { ...target, id: 10, status: 'forbidden', message: 'no access', checkedAt: '' } } });
  const pending = project('pending', { forkScope: 'current', uploadTarget: { ...target, id: 11 }, pendingSwitch: {} });
  const reserved = project('reserved', { forkScope: 'current', uploadTarget: { ...target, id: 12 }, creationReservation: { target } });
  const all = [original, current, upload, managed, dev, duplicate, unavailable, pending, reserved];
  assert.deepEqual(projectSelections(all, all).sync, ['managed', 'current', 'dev']);
  assert.deepEqual(projectSelections([original], all).sync, ['original']);
});

test('updates follow the current visible list and do not depend on upload or cache state', () => {
  const ready = project('ready', { hasUpdate: true, isCachePurged: true });
  const bound = project('bound', { hasUpdate: true, uploadTarget: target });
  const unchanged = project('unchanged');
  assert.deepEqual(projectSelections([ready, unchanged], [bound, ready, unchanged]).updates, ['ready']);
});
