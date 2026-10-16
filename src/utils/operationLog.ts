export interface OperationLog {
  id: string; time: string; action: string; status: 'success' | 'error' | 'skipped' | 'cancelled' | 'partial';
  project?: string; branch?: string; target?: string; stage?: string; message: string; httpStatus?: number; batchId?: string;
}
const KEY = 'gitvault_operation_logs_v1';
export function redactLog(value: string, secrets: string[] = []) {
  let result = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[已隐藏凭证]');
  return result.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏凭证]')
    .replace(/(Bearer\s+)[^\s,;"']+/gi, '$1[已隐藏凭证]')
    .replace(/([?&](?:access_token|token|auth)=)[^&\s]+/gi, '$1[已隐藏凭证]')
    .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/g, 'https://[已隐藏凭证]@').slice(0, 5000);
}
export function readOperationLogs(): OperationLog[] {
  try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value.filter(entry => entry && typeof entry.id === 'string' && typeof entry.time === 'string' && typeof entry.message === 'string' && ['success','error','skipped','cancelled','partial'].includes(entry.status)).slice(0, 1000) : []; } catch { return []; }
}
export function appendOperationLog(entry: Omit<OperationLog, 'id' | 'time'>, secrets: string[] = []) {
  const clean = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, typeof value === 'string' ? redactLog(value, secrets) : value]));
  const record = { ...clean, id: crypto.randomUUID(), time: new Date().toISOString() } as OperationLog;
  let logs = [record, ...readOperationLogs()].slice(0, 1000);
  try { localStorage.setItem(KEY, JSON.stringify(logs)); }
  catch { logs = logs.slice(0, 100); localStorage.setItem(KEY, JSON.stringify(logs)); }
  window.dispatchEvent(new CustomEvent('gitvault-logs-changed'));
  return record;
}
export function clearOperationLogs() { localStorage.removeItem(KEY); window.dispatchEvent(new CustomEvent('gitvault-logs-changed')); }
