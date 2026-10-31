import { markTransferFailure, transferFailureKind } from './transferFailure';
export class GitHubError extends Error {
  constructor(message: string, public status: number, public rateLimited = false, public retryAt?: number) { super(message); }
}

interface Clock { now: () => number; sleep: (milliseconds: number, signal: AbortSignal) => Promise<void> }
interface TransportOptions {
  clock?: Clock;
  writeInterval?: number;
  requestInterval?: number;
  hourlyWrites?: number;
  retries?: number;
  readRetries?: number;
  shareAcrossTabs?: boolean;
  onWait?: (message: string) => void;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {});return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const realClock: Clock = {
  now: Date.now,
  sleep: (milliseconds, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  }),
};
const COOLDOWN = 'gitvault_github_cooldown_v1';
const WRITES = 'gitvault_github_writes_v1';
const LAST_WRITE = 'gitvault_github_last_write_v1';

/** One client-wide policy for all GitHub operations; no credentials are stored. */
export function createGithubTransport(options: TransportOptions = {}) {
  const clock = options.clock || realClock;
  const writeInterval = options.writeInterval ?? 1100;
  const requestInterval = options.requestInterval ?? 150;
  const hourlyWrites = options.hourlyWrites ?? 450;
  // Explicit rate-limit rejections are safe to resume. Keep the task alive until
  // it succeeds or the user cancels; uncertain writes are never replayed here.
  const retries = options.retries ?? Infinity;
  const readRetries = options.readRetries ?? 2;
  let cooldown = 0, nextStart = 0, nextWrite = 0, readers = 0;
  let writeHistory: number[] = [];
  let writeTail = Promise.resolve(), admissionTail = Promise.resolve();
  const readWaiters = new Set<() => void>();
  const notify = options.onWait || ((message: string) => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gitvault-progress', { detail: message }));
  });
  const stored = (key: string) => {
    try { return options.shareAcrossTabs === false || typeof localStorage === 'undefined' ? null : localStorage.getItem(key); }
    catch { return null; }
  };
  const persist = (key: string, value: string) => {
    try { if (options.shareAcrossTabs !== false && typeof localStorage !== 'undefined') localStorage.setItem(key, value); }
    catch { /* In-memory pacing still applies when persistent storage is unavailable. */ }
  };
  const storedTime = (key: string) => { const value = Number(stored(key)); return Number.isFinite(value) && value >= 0 && value <= 8640000000000000 ? value : 0; };
  const blockedUntil = () => cooldown = Math.max(cooldown, storedTime(COOLDOWN));
  const writes = () => {
    try {
      const shared: unknown = JSON.parse(stored(WRITES) || 'null');
      if (Array.isArray(shared)) writeHistory = shared.filter(value => typeof value === 'number' && Number.isFinite(value));
    } catch { /* Ignore malformed timing metadata, never project data. */ }
    writeHistory = writeHistory.filter(at => at > clock.now() - 3600000).sort((a, b) => a - b);
    return writeHistory;
  };
  const writeTime = () => {
    const history = writes();
    return Math.max(nextWrite, storedTime(LAST_WRITE), history.length >= hourlyWrites ? history[history.length - hourlyWrites] + 3600000 : 0);
  };
  const pause = (until: number) => {
    cooldown = Math.max(blockedUntil(), until);
    persist(COOLDOWN, String(cooldown));
  };
  const serial = <T>(previous: Promise<void>, task: () => Promise<T>) => {
    const pending = previous.then(task);
    return { pending, settled: pending.then(() => {}, () => {}) };
  };
  const admit = async (write: boolean, signal: AbortSignal) => {
    const { pending, settled } = serial(admissionTail, async () => {
      while (true) {
        signal.throwIfAborted();
        const now = clock.now(), blocked = blockedUntil();
        const until = Math.max(blocked, nextStart, write ? writeTime() : 0);
        if (until <= now) break;
        if (blocked > now || write && writeTime() - now > writeInterval) {
          notify(`GitHub 请求已暂停，预计 ${new Date(until).toLocaleTimeString()} 继续（剩余 ${Math.ceil((until - now) / 1000)} 秒）；可取消并稍后恢复`);
        }
        await clock.sleep(Math.min(1000, until - now), signal);
      }
      nextStart = clock.now() + requestInterval;
      if (write) { writeHistory = [...writes(), clock.now()]; persist(WRITES, JSON.stringify(writeHistory)); }
    });
    admissionTail = settled;
    return abortable(pending, signal);
  };
  const withReadSlot = async <T>(task: () => Promise<T>, signal: AbortSignal) => {
    while (readers >= 3) {
      let wake!: () => void;
      const ready = new Promise<void>(resolve => { wake = resolve; readWaiters.add(wake); });
      try { await abortable(ready, signal); } finally { readWaiters.delete(wake); }
    }
    signal.throwIfAborted(); readers++;
    try { return await task(); }
    finally { readers--; for (const wake of readWaiters) wake(); }
  };
  // The network deadline starts after queue/cooldown waits, not before them.
  const fetchOnce = async <T>(url: string, init: RequestInit, signal: AbortSignal, timeout: number, attempt: number, consume: (response: Response, touch: () => void, signal: AbortSignal) => Promise<T>, idle: boolean) => {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const touch = () => { if (closed || controller.signal.aborted) return; clearTimeout(timer); timer = setTimeout(() => controller.abort(new DOMException('GitHub 请求超时，请重试', 'TimeoutError')), timeout); };
    touch();
    try {
      const response = await fetch(url, { ...init, signal: controller.signal }).catch(error => {
        controller.signal.throwIfAborted(); throw markTransferFailure(error, 'network');
      });
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const bytes = await response.arrayBuffer();
        let message = new TextDecoder().decode(bytes);
        try { message = JSON.parse(message).message || message; } catch { /* GitHub can return a non-JSON gateway error. */ }
        const limited = [403, 429].includes(response.status) && (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit|secondary limit/i.test(message));
        let retryAt: number | undefined;
        if (limited) {
          const now = clock.now(), retryAfter = response.headers.get('retry-after');
          const seconds = retryAfter !== null && retryAfter.trim() !== '' ? Number(retryAfter) : NaN;
          const after = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : retryAfter ? Date.parse(retryAfter) : NaN;
          const reset = response.headers.get('x-ratelimit-remaining') === '0' ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : NaN;
          const delay = Number.isFinite(after) ? Math.max(1000, after - now) : 60000;
          retryAt = Math.max(now + delay * 2 ** Math.min(attempt, 4), Number.isFinite(reset) ? reset : 0);
          message = `${message.slice(0, 300)}；请求队列已暂停，可在 ${new Date(retryAt).toLocaleTimeString()} 后继续`;
        }
        throw new GitHubError(`GitHub (${response.status}): ${message.slice(0, 450)}`, response.status, limited, retryAt);
      }
      if (idle) touch();
      // Keep the queue slot, cancellation and idle deadline until the streamed
      // consumer has finished; never buffer an archive in the transport.
      const result = await abortable(consume(response, idle ? touch : () => {}, controller.signal), controller.signal);
      controller.signal.throwIfAborted();return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { closed = true; clearTimeout(timer); signal.removeEventListener('abort', abort); }
  };
  const executeRequest = async <T>(url: string, init: RequestInit, signal: AbortSignal, timeout: number, consume: (response: Response, touch: () => void, signal: AbortSignal) => Promise<T>, idle=false, replayConsumer=false): Promise<T> => {
      const queuedAt=clock.now();let entered=false,waitMs=0,requestMs=0,attempts=0,rateLimits=0;
      const write = !['GET', 'HEAD', 'OPTIONS'].includes((init.method || 'GET').toUpperCase());
      const execute = async () => {
        entered=true;waitMs+=Math.max(0,clock.now()-queuedAt);
        let transientAttempts = 0;
        for (let attempt = 0; ; attempt++) {
          const waiting=clock.now();try{await admit(write, signal);}finally{waitMs+=Math.max(0,clock.now()-waiting);}
          const started=clock.now();let retryWait=0;attempts++;
          let consumed = false;
          try { return await fetchOnce(url, init, signal, Math.min(timeout * 2 ** transientAttempts, Math.max(timeout, 180000)), attempt, (response, touch, requestSignal) => { consumed = true; return consume(response, touch, requestSignal); }, idle); }
          catch (error) {
            signal.throwIfAborted();
            if (error instanceof GitHubError && error.rateLimited) {
              rateLimits++;
              pause(error.retryAt!);
              if (rateLimits > retries) throw error;
            } else {
              // Replay only safe reads. A streamed archive consumer may already
              // have written verified files; its caller owns partial recovery.
              const temporary = error instanceof GitHubError ? [408, 500, 502, 503, 504].includes(error.status) : transferFailureKind(error) === 'network';
              if (write || !['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase()) || consumed && !replayConsumer || !temporary || transientAttempts >= readRetries) throw error;
              const delay = 1000 * 2 ** transientAttempts++;
              notify(`GitHub 读取连接中断或超时，${delay / 1000} 秒后恢复（${transientAttempts}/${readRetries}）；可取消`);
              const waiting = clock.now();
              try { await clock.sleep(delay, signal); } finally { retryWait = Math.max(0, clock.now() - waiting);waitMs += retryWait; }
            }
          } finally {
            requestMs+=Math.max(0,clock.now()-started-retryWait);
            if (write) { nextWrite = clock.now() + writeInterval; persist(LAST_WRITE, String(nextWrite)); }
          }
        }
      };
      try {
      if (!write) return await withReadSlot(execute, signal);
      const { pending, settled } = serial(writeTail, async () => {
        signal.throwIfAborted();
        if (options.shareAcrossTabs !== false && typeof navigator !== 'undefined' && navigator.locks) {
          return navigator.locks.request('gitvault-github-writes', { mode: 'exclusive', signal }, execute);
        }
        return execute();
      });
      writeTail = settled;
      return await abortable(pending, signal);
      } finally {
        if(!entered)waitMs=Math.max(0,clock.now()-queuedAt);
        // Only numeric timings and the in-memory signal used for attribution;
        // URLs, request headers, response bodies and credentials are excluded.
        if(typeof window!=='undefined')try{window.dispatchEvent(new CustomEvent('gitvault-transport-metric',{detail:{signal,waitMs,requestMs,attempts,rateLimits}}));}catch{}
      }
    };
  return {
    request(url: string, init: RequestInit, signal: AbortSignal, timeout = 90000): Promise<Response> {
      return executeRequest(url, init, signal, timeout, async (response, touch, requestSignal) => {
        if (response.status === 204 || !response.body) return new Response(null, { status: response.status, headers: response.headers });
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        const abort = () => { void reader.cancel(requestSignal.reason).catch(() => {}); };
        requestSignal.addEventListener('abort', abort, { once: true });
        try {
          while (true) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try { next = await reader.read(); } catch (error) { throw markTransferFailure(error, 'network'); }
            requestSignal.throwIfAborted();
            if (next.done) break;
            chunks.push(next.value);touch();
          }
          return new Response(new Blob(chunks as BlobPart[]), { status: response.status, headers: response.headers });
        } finally { requestSignal.removeEventListener('abort', abort);reader.releaseLock(); }
      }, true, true);
    },
    stream<T>(url: string, init: RequestInit, signal: AbortSignal, consume: (response: Response, touch: () => void, signal: AbortSignal) => Promise<T>, idleTimeout = 60000): Promise<T> {
      if (!['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase())) throw new Error('流式接口仅用于下载');
      return executeRequest(url, init, signal, idleTimeout, consume, true);
    },
  };
}

export const githubTransport = createGithubTransport();
