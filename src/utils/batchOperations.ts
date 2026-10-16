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
  run: (item: ProjectBatchItem) => Promise<{ message: string; skipped?: boolean }>;
}) {
  const queue = items.map(item => ({ ...item }));
  const emit = () => options.onChange(queue.map(item => ({ ...item })));
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].status !== 'pending') continue;
    if (options.signal.aborted) break;
    queue[i] = { ...queue[i], status: 'running', message: '正在处理…' }; emit();
    try {
      const result = await options.run(queue[i]);
      queue[i] = { ...queue[i], status: result.skipped ? 'skipped' : 'success', message: result.message };
    } catch (error) {
      queue[i] = { ...queue[i], status: options.signal.aborted ? 'cancelled' : 'error', message: options.signal.aborted ? '已取消，可重试' : (error as Error).message || '处理失败' };
    }
    emit();
  }
  for (let i = 0; i < queue.length; i++) if (queue[i].status === 'pending') queue[i] = { ...queue[i], status: 'cancelled', message: '未执行，可重试' };
  emit(); return queue;
}
