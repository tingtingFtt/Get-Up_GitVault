export type DialogRequest = { id: number; kind: 'confirm' | 'prompt'; message: string; value: string; secret: boolean; accept: string; cancel: string };
export type Notice = { id: number; message: string; error: boolean };
type Options = { signal?:AbortSignal; secret?: boolean; accept?: string; cancel?: string };
let sequence = 0;
let active: DialogRequest | null = null;
let notices: Notice[] = [];
const listeners = new Set<() => void>();
const queue: Array<{ request: DialogRequest; resolve: (value: string | boolean | null) => void; cleanup?:()=>void }> = [];
const emit = () => listeners.forEach(listener => listener());
function ask(kind: DialogRequest['kind'], message: string, value = '', options: Options = {}) {
  options.signal?.throwIfAborted();
  return new Promise<string | boolean | null>((resolve,reject) => {
    const entry:typeof queue[number]={ request: { id: ++sequence, kind, message, value, secret: options.secret ?? /token|PAT|令牌/i.test(message), accept: options.accept || '确定', cancel: options.cancel || '取消' }, resolve };
    if(options.signal){const signal=options.signal;const abort=()=>{const at=queue.indexOf(entry);if(at<0)return;queue.splice(at,1);entry.cleanup?.();active=queue[0]?.request||null;emit();reject(signal.reason);};entry.cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});}
    queue.push(entry);active = queue[0].request; emit();
  });
}
export const appDialog = {
  confirm: async (message: string, options?: Options): Promise<boolean> => (await ask('confirm', message, '', options)) === true,
  prompt: async (message: string, value = '', options?: Options): Promise<string | null> => await ask('prompt', message, value, options) as string | null,
  notify(message: string) {
    const notice = { id: ++sequence, message: String(message), error: /失败|未完成|出错|不足|待重试|请先|请填写/.test(String(message)) };
    notices = [...notices.slice(-3), notice]; emit();
    if (!notice.error) setTimeout(() => appDialog.dismiss(notice.id), 5000);
  },
  dismiss(id: number) { notices = notices.filter(notice => notice.id !== id); emit(); },
  answer(value: string | boolean | null) {
    const entry = queue.shift(); if (!entry) return;
    active = queue[0]?.request || null;entry.cleanup?.(); entry.resolve(value); emit();
  },
  cancelActive() { if (!active) return false; appDialog.answer(active.kind === 'confirm' ? false : null); return true; },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => ({ active, notices }),
};
