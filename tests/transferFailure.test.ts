import {test} from 'node:test';
import assert from 'node:assert/strict';
import {markTransferFailure, transferFailureKind} from '../src/utils/transferFailure';
import {GitHubError} from '../src/utils/githubTransport';

test('failure classification preserves HTTP identity, deadlines and storage causes', () => {
  const rate = new GitHubError('secondary limit', 403, true, 1234);
  assert.equal(markTransferFailure(rate, 'network'), rate);
  assert.equal(transferFailureKind(rate), 'rate-limit'); assert.equal(rate.retryAt, 1234);
  assert.equal(transferFailureKind(new Error('wrapped', {cause: new DOMException('full', 'QuotaExceededError')})), 'storage-space');
  assert.equal(transferFailureKind(new DOMException('denied', 'NotAllowedError')), 'storage-permission');
  assert.equal(transferFailureKind(new DOMException('cancel', 'AbortError')), 'cancelled');
  assert.equal(transferFailureKind(new DOMException('timeout', 'TimeoutError')), 'network');
  assert.equal(transferFailureKind(new TypeError('application bug')), 'unknown');
  assert.equal(transferFailureKind(new GitHubError('forbidden', 403)), 'http');
});
