import { appendOperationLog } from './operationLog';

interface TransferContext { action: string; project: string; branch?: string; target?: string; mode: string; signal: AbortSignal }
export interface TransferTrace {
  phase: (name: string) => void;
  native: (timings: unknown) => void;
  branch: (name: string) => void;
}

/** Phase durations include I/O and queue waits. Native details are sub-phases,
 * not additional time to add to the total. No credentials or file bodies enter logs. */
export async function measureTransfer<T>(context: TransferContext, work: (trace: TransferTrace) => Promise<T>): Promise<T> {
  const now = () => performance.now(), start = now(), durations: Array<{ name: string; ms: number }> = [];
  let current = '识别仓库与分支', since = start, status: 'success' | 'error' | 'cancelled' = 'error', native = '';
  const trace: TransferTrace = {
    phase(name) { const at = now(); durations.push({ name: current, ms: at - since }); current = name; since = at; },
    branch(name) { context.branch = name; },
    native(value) {
      if (!value || typeof value !== 'object') return;
      const labels: Record<string, string> = { preparationMs: '原生批量暂存', fetchMs: 'Git 获取', folderMs: '目录写入与验证', pushMs: 'Git 提交与推送' };
      native = Object.entries(labels).flatMap(([key, name]) => { const ms = (value as Record<string, unknown>)[key]; return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? [`${name} ${(ms / 1000).toFixed(2)} 秒`] : []; }).join('；');
    },
  };
  try { const result = await work(trace); status = 'success'; return result; }
  catch (error) { if (context.signal.aborted || (error as Error)?.name === 'AbortError' || (error as { code?: string })?.code === 'CANCELLED') status = 'cancelled'; throw error; }
  finally {
    const end = now(); durations.push({ name: current, ms: end - since });
    const message = [`传输方式：${context.mode}；总耗时 ${((end - start) / 1000).toFixed(2)} 秒`, ...durations.map(item => `${item.name}：${(item.ms / 1000).toFixed(2)} 秒`), ...(native ? [`原生细项（已包含在上述耗时内）：${native}`] : [])].join('\n');
    try { if (typeof window !== 'undefined') appendOperationLog({ action: `${context.action}传输明细`, project: context.project, branch: context.branch, target: context.target, status, stage: status === 'success' ? '传输完成' : current, message }); }
    catch { /* Diagnostics must never turn a verified transfer into a failure. */ }
  }
}
