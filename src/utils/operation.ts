/** Shared task lifetime for HTTP, local storage and Android work. */
let controller = new AbortController();
function event(name: string, detail?: unknown) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, {detail}));
}
export function beginGithubOperation() { controller = new AbortController(); event('gitvault-operation', 'running'); }
export function cancelGithubOperation() {
  if (controller.signal.aborted) return;
  controller.abort(new DOMException('操作已取消，可重试未完成项', 'AbortError'));
  event('gitvault-operation', 'cancelling');
  reportProgress('正在取消，等待当前文件操作停止；已完成结果和恢复进度会保留…');
}
export const operationSignal = () => controller.signal;
export function reportProgress(message: string) { event('gitvault-progress', message); }
let lastYield = 0;
/** Give clicks/timers a turn even during large cached, network-free loops. */
export async function cooperate(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (Date.now() - lastYield >= 32) {
    await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = Date.now();
    signal?.throwIfAborted();
  }
}
