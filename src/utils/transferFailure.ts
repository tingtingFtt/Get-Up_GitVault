export type TransferFailureKind = 'network' | 'rate-limit' | 'archive' | 'validation' | 'storage-space' | 'storage-permission' | 'storage' | 'http' | 'cancelled' | 'unknown';
const marks = new WeakMap<object, TransferFailureKind>();
/** Keep the original exception (including HTTP status, retry deadline and cause). */
export function markTransferFailure<T>(error: T, kind: TransferFailureKind): T {
  if (error && typeof error === 'object' && !marks.has(error)) marks.set(error, kind);
  return error;
}
export function transferFailureKind(error: unknown): TransferFailureKind {
  const visited = new Set<unknown>();
  for (let value = error; value && typeof value === 'object' && !visited.has(value); value = (value as Error).cause) {
    visited.add(value);
    const e = value as Error & { code?: string; status?: number; rateLimited?: boolean };
    if (e.rateLimited === true) return 'rate-limit';
    if (e.name === 'AbortError' || e.code === 'CANCELLED') return 'cancelled';
    if (e.code === 'GIT_NETWORK') return 'network';
    if (e.name === 'QuotaExceededError' || e.code === 'ENOSPC' || e.code === 'INSUFFICIENT_SPACE') return 'storage-space';
    if (['NotAllowedError', 'SecurityError'].includes(e.name)) return 'storage-permission';
    const marked = marks.get(value); if (marked) return marked;
    // Network errors are marked at the I/O boundary; a TypeError in application
    // code must not be silently misreported as a connection failure.
    if (e.name === 'TimeoutError') return 'network';
    if (typeof e.status === 'number') return e.status >= 500 ? 'network' : 'http';
  }
  return 'unknown';
}
const labels: Record<TransferFailureKind, string> = {
  network: '网络失败或超时', 'rate-limit': 'GitHub 限流', archive: '压缩包解压失败', validation: '文件校验失败',
  'storage-space': '存储空间或配额不足', 'storage-permission': '存储授权失效', storage: '存储写入失败',
  http: 'HTTP 请求失败', cancelled: '用户取消', unknown: '未分类错误',
};
export function transferFailureLabel(error: unknown) { return labels[transferFailureKind(error)]; }
export function isStorageFailure(error: unknown) { return transferFailureKind(error).startsWith('storage'); }
