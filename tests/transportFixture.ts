import { mock } from 'node:test';
import { createGithubTransport, githubTransport } from '../src/utils/githubTransport';

// Existing workflow fixtures assert API behavior without real-time delays.
// githubTransport.test.ts independently exercises the production timing policy.
export function immediateTransport() {
  let now = Date.now();
  const clock = { now: () => now, sleep: async (milliseconds: number, signal: AbortSignal) => { signal.throwIfAborted(); now += milliseconds; } };
  const transport = createGithubTransport({ clock, writeInterval: 0, requestInterval: 0, hourlyWrites: Infinity, retries: 0, shareAcrossTabs: false });
  mock.method(githubTransport, 'request', transport.request);
}
