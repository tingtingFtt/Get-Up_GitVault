import { appendOperationLog } from './operationLog';

interface TransferContext { action: string; project: string; branch?: string; target?: string; mode: string; signal: AbortSignal }
export interface TransferTrace {
  phase: (name: string) => void;
  native: (timings: unknown) => void;
  branch: (name: string) => void;
  count: (name:'复用文件'|'ZIP 尝试'|'ZIP 失败'|'ZIP 接收字节'|'补拉文件',amount:number) => void;
}

/** Phase durations include I/O and queue waits. Native details are sub-phases,
 * not additional time to add to the total. No credentials or file bodies enter logs. */
export async function measureTransfer<T>(context: TransferContext, work: (trace: TransferTrace) => Promise<T>): Promise<T> {
  const now = () => performance.now(), start = now(), durations: Array<{ name: string; ms: number }> = [];
  let current = '识别仓库与分支', since = start, status: 'success' | 'error' | 'cancelled' = 'error', native = '';
  const counters=new Map<string,number>();let waitMs=0,requestMs=0,attempts=0,rateLimits=0;
  const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
  const metric=(event:Event)=>{const data=(event as CustomEvent).detail;if(data?.signal!==context.signal)return;waitMs+=number(data.waitMs);requestMs+=number(data.requestMs);attempts+=number(data.attempts);rateLimits+=number(data.rateLimits);};
  if(typeof window!=='undefined')window.addEventListener('gitvault-transport-metric',metric);
  const trace: TransferTrace = {
    phase(name) { const at = now(); durations.push({ name: current, ms: at - since }); current = name; since = at; },
    branch(name) { context.branch = name; },
    count(name,amount){if(Number.isSafeInteger(amount)&&amount>=0)counters.set(name,(counters.get(name)||0)+amount);},
    native(value) {
      if (!value || typeof value !== 'object') return;
      const labels: Record<string, string> = { preparationMs: '原生批量暂存', fetchMs: 'Git 获取', folderMs: '目录写入与验证', pushMs: 'Git 提交与推送' };
      native = Object.entries(labels).flatMap(([key, name]) => { const ms = (value as Record<string, unknown>)[key]; return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? [`${name} ${(ms / 1000).toFixed(2)} 秒`] : []; }).join('；');
      const stats=value as Record<string,unknown>;
      native+=[...(typeof stats.cacheHit==='boolean'?[`Git 对象缓存：${stats.cacheHit?'命中':'未命中'}`]:[]),...Object.entries({newObjects:'上传新写对象',reusedObjects:'上传复用对象',sourceBytes:'上传读取字节'}).flatMap(([key,label])=>typeof stats[key]==='number'&&Number.isSafeInteger(stats[key])&&Number(stats[key])>=0?[`${label} ${stats[key]}`]:[])].map(text=>'；'+text).join('');
    },
  };
  try { const result = await work(trace); status = 'success'; return result; }
  catch (error) { if (context.signal.aborted || (error as Error)?.name === 'AbortError' || (error as { code?: string })?.code === 'CANCELLED') status = 'cancelled'; throw error; }
  finally {
    if(typeof window!=='undefined')window.removeEventListener('gitvault-transport-metric',metric);
    const end = now(); durations.push({ name: current, ms: end - since });
    const message = [`传输方式：${context.mode}；总耗时 ${((end - start) / 1000).toFixed(2)} 秒`, ...durations.map(item => `${item.name}：${(item.ms / 1000).toFixed(2)} 秒`),`网页层 API 请求 ${attempts} 次；限流响应 ${rateLimits} 次；排队／限流等待累计 ${(waitMs/1000).toFixed(2)} 秒；请求与响应处理累计 ${(requestMs/1000).toFixed(2)} 秒（含流式解压、校验和保存；并发累计值不可与总耗时相加）`,...Array.from(counters,([key,value])=>`${key}：${value}`), ...(native ? [`原生细项（已包含在上述耗时内）：${native}`] : [])].join('\n');
    try { if (typeof window !== 'undefined') appendOperationLog({ action: `${context.action}传输明细`, project: context.project, branch: context.branch, target: context.target, status, stage: status === 'success' ? '传输完成' : current, message }); }
    catch { /* Diagnostics must never turn a verified transfer into a failure. */ }
  }
}
