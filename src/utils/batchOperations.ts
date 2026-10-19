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
    let failure: unknown,lastProgress=0;
    const progress=(event:Event)=>{
      if(options.signal.aborted)return;
      const message=(event as CustomEvent<string>).detail;
      if(typeof message!=='string'||Date.now()-lastProgress<400)return;
      lastProgress=Date.now();queue[i]={...queue[i],message:`${i+1}/${queue.length} · ${message}`};emit();
    };
    if(typeof window!=='undefined')window.addEventListener('gitvault-progress',progress);
    try {
      const result = await options.run(queue[i]);
      queue[i] = { ...queue[i], status: result.skipped ? 'skipped' : 'success', message: result.message };
    } catch (error) {
      failure = error;
      queue[i] = { ...queue[i], status: options.signal.aborted ? 'cancelled' : 'error', message: options.signal.aborted ? '已取消，可重试' : (error as Error).message || '处理失败' };
    }
    finally{if(typeof window!=='undefined')window.removeEventListener('gitvault-progress',progress);}
    emit(); options.onResult?.(queue[i], failure);
  }
  for (let i = 0; i < queue.length; i++) if (queue[i].status === 'pending') { queue[i] = { ...queue[i], status: 'cancelled', message: '未执行，可重试' }; options.onResult?.(queue[i]); }
  emit(); return queue;
}
