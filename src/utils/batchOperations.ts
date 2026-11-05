import {withOperationSignal} from './operation';
export interface ProjectBatchItem {
  id: string;
  label: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'cancelled';
  message?: string;
}

/** Keep a fixed queue; a failure never restarts or discards successful items. */
export async function runProjectBatch(items: ProjectBatchItem[], options: {
  signal: AbortSignal;
  stallMs?:number;
  onChange: (items: ProjectBatchItem[]) => void;
  onResult?: (item: ProjectBatchItem, error?: unknown) => void;
  run: (item: ProjectBatchItem) => Promise<{ message: string; skipped?: boolean }>;
}) {
  const queue = items.map(item => ({ ...item }));
  const emit = () => options.onChange(queue.map(item => ({ ...item })));
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].status !== 'pending') continue;
    if (options.signal.aborted) break;
    queue[i] = { ...queue[i], status: 'running', message: '正在处理…' }; emit();
    let failure: unknown,lastProgress=0,lastActivity=performance.now();
    const child=new AbortController(),abort=()=>child.abort(options.signal.reason);
    options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
    const activity=(event:Event)=>{if((event as CustomEvent<{signal:AbortSignal}>).detail?.signal===child.signal)lastActivity=performance.now();};
    const timer=options.stallMs?setInterval(()=>{
      if(!child.signal.aborted&&performance.now()-lastActivity>=options.stallMs!){
        child.abort(new DOMException('当前项目长时间没有有效进展，已请求停止；本地文件和已完成结果保留，可稍后重试','TimeoutError'));
        queue[i]={...queue[i],message:'长时间无进展，正在等待当前项目停止；随后继续其他项目…'};emit();
      }
    },Math.min(1000,Math.max(5,(options.stallMs||1000)/4))):undefined;
    const progress=(event:Event)=>{
      if(options.signal.aborted||child.signal.aborted)return;
      const message=(event as CustomEvent<string>).detail;
      if(typeof message!=='string'||Date.now()-lastProgress<400)return;
      lastProgress=Date.now();queue[i]={...queue[i],message:`${i+1}/${queue.length} · ${message}`};emit();
    };
    if(typeof window!=='undefined')window.addEventListener('gitvault-progress',progress);
    if(typeof window!=='undefined')window.addEventListener('gitvault-transfer-activity',activity);
    try {
      const result = await (options.stallMs?withOperationSignal(child.signal,options.signal,()=>options.run(queue[i])):options.run(queue[i]));
      if(child.signal.aborted&&!options.signal.aborted)child.signal.throwIfAborted();
      queue[i] = { ...queue[i], status: result.skipped ? 'skipped' : 'success', message: result.message };
    } catch (error) {
      failure = error;
      queue[i] = { ...queue[i], status: options.signal.aborted ? 'cancelled' : 'error', message: options.signal.aborted ? '已取消，可重试' : (error as Error).message || '处理失败' };
    }
    finally{clearInterval(timer);options.signal.removeEventListener('abort',abort);if(typeof window!=='undefined'){window.removeEventListener('gitvault-progress',progress);window.removeEventListener('gitvault-transfer-activity',activity);}}
    emit(); options.onResult?.(queue[i], failure);
  }
  for (let i = 0; i < queue.length; i++) if (queue[i].status === 'pending') { queue[i] = { ...queue[i], status: 'cancelled', message: '未执行，可重试' }; options.onResult?.(queue[i]); }
  emit(); return queue;
}
