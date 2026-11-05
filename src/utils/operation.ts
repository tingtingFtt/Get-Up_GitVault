/** Shared task lifetime for HTTP, local storage and Android work. */
let controller = new AbortController();
let scoped:AbortSignal|undefined;
const groups=new WeakMap<AbortSignal,AbortSignal>();
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
export const operationSignal = () => scoped||controller.signal;
export const operationGroup = (signal:AbortSignal) => groups.get(signal)||signal;
export function noteTransferActivity(signal=operationSignal()){event('gitvault-transfer-activity',{signal});}
/** Serial batch workers await complete stop acknowledgement before restoring
 * their parent scope. Read-only caches can still share the parent task. */
export async function withOperationSignal<T>(signal:AbortSignal,parent:AbortSignal,run:()=>Promise<T>){
  const previous=scoped;groups.set(signal,operationGroup(parent));scoped=signal;
  try{return await run();}finally{if(scoped===signal)scoped=previous;}
}
export function reportProgress(message: string,active=true,signal=operationSignal()) {
  event('gitvault-progress', message);
  if(active)noteTransferActivity(signal);
}
let lastYield = 0;
/** Give clicks/timers a turn even during large cached, network-free loops. */
export async function cooperate(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (Date.now() - lastYield >= 32) {
    await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = Date.now();
    signal?.throwIfAborted();
  }
}
