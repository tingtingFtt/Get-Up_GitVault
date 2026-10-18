import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile, type AsyncFlateStreamHandler } from 'fflate';
import { markTransferFailure } from './transferFailure';

export interface ArchiveEntry { path: string; sha: string; mode: string; size?: number }

/** Stream a pinned ZIP, with backpressure between small compressed chunks.
 * Only requested manifest paths are inflated. Completed files are handed to the
 * caller before reading more network data; the compressed archive is not kept.
 */
export async function readArchive<T extends ArchiveEntry>(response: Response, expected: T[], signal: AbortSignal,
  accept: (entry: T, bytes: Uint8Array) => Promise<void>,
  onBytes: (bytes: number) => void = () => {}, touch: () => void = () => {}) {
  if (!response.body) throw markTransferFailure(new Error('浏览器无法流式读取压缩包'), 'archive');
  const wanted = new Map(expected.map(entry => [entry.path, entry]));
  const seen = new Set<string>(), completed = new Set<string>(), active = new Set<UnzipFile>();
  const ready: Array<{ entry: T; bytes: Uint8Array }> = [];
  let prefix = '', received = 0, failure: unknown;
  const unzip = new Unzip(file => {
    const parts = file.name.split('/');
    if (file.name.includes('\\') || parts.some(part => part === '..' || part === '.') || !parts[0] || file.name.includes('\0')) throw markTransferFailure(new Error('压缩包文件路径无效'), 'validation');
    if (!prefix) prefix = parts[0];
    if (parts[0] !== prefix) throw markTransferFailure(new Error('压缩包项目根目录不一致'), 'validation');
    const path = parts.slice(1).join('/'), entry = wanted.get(path);
    if (!entry || file.name.endsWith('/')) {
      // Leaving a file unstarted makes fflate retain its compressed chunks for
      // a later start. Drain unwanted entries with a no-op decoder instead.
      const compression = file.compression;
      unzip.register(class Discard {
        static compression = compression;
        ondata: AsyncFlateStreamHandler = () => {};
        push(_bytes: Uint8Array, final: boolean) { if (final) this.ondata(null, new Uint8Array(), true); }
      });
      file.ondata = () => {}; file.start();
      unzip.register(UnzipInflate); unzip.register(UnzipPassThrough); return;
    }
    if (seen.has(path)) throw markTransferFailure(new Error('压缩包包含重复文件：' + path), 'validation');
    seen.add(path);
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0 || file.originalSize !== undefined && file.originalSize !== entry.size) throw markTransferFailure(new Error('压缩包文件大小与快照不一致：' + path), 'validation');
    let buffer: Uint8Array | undefined = new Uint8Array(entry.size!), offset = 0;
    active.add(file);
    file.ondata = (error, bytes, final) => {
      if (failure) return;
      if (error) { failure = markTransferFailure(error, 'archive'); return; }
      if (!buffer || offset + bytes.length > buffer.length) { failure = markTransferFailure(new Error('压缩包文件超过快照大小：' + path), 'validation'); return; }
      buffer.set(bytes, offset); offset += bytes.length;
      if (final) {
        active.delete(file);
        if (offset !== buffer.length) { failure = markTransferFailure(new Error('压缩包文件不完整：' + path), 'validation'); return; }
        ready.push({ entry, bytes: buffer }); buffer = undefined; completed.add(path);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const drain = async () => {
    if (failure) throw failure;
    while (ready.length) { signal.throwIfAborted(); const file = ready.shift()!; await accept(file.entry, file.bytes); signal.throwIfAborted(); touch(); }
  };
  const push = (bytes: Uint8Array, final: boolean) => {
    try { unzip.push(bytes, final); } catch (error) { throw markTransferFailure(error, 'archive'); }
  };
  let finished = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read().catch(error => {
        signal.throwIfAborted(); throw markTransferFailure(error, 'network');
      }); signal.throwIfAborted(); touch();
      if (done) { push(new Uint8Array(), true); await drain(); break; }
      received += value.length; onBytes(received);
      // A tiny compressed chunk can expand greatly. Bound each feed and await
      // storage/hashing before feeding more, instead of accumulating ZIP output.
      for (let offset = 0; offset < value.length; offset += 8192) {
        signal.throwIfAborted(); push(value.subarray(offset, offset + 8192), false); await drain();
      }
    }
    signal.throwIfAborted();
    if (completed.size !== wanted.size || active.size) throw markTransferFailure(new Error('压缩包缺少快照文件，继续补齐缺失文件'), 'archive');
    finished = true;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock(); for (const file of active) file.terminate();
  }
}
