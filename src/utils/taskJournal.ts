export type TaskKind = 'projects' | 'upload' | 'import' | 'release';
export interface SavedTask {
  kind: TaskKind;
  updatedAt: string;
  action?: 'fork' | 'update' | 'sync';
  scope?: 'current' | 'full';
  purge?: boolean;
  projectId?: string;
  prefix?: string;
  items: Array<{ id?: string; label?: string; name?: string; repo?: string; input?: string; url?: string; remark?: string; status: string; branch?: string; source?: string; targetId?: number; sha?: string; targetOwner?: string; targetRepo?: string }>;
}
const KEY = 'gitvault_tasks_v1';
const statuses = new Set(['pending','running','creating','uploading','downloading','releasing','success','skipped','error','cancelled']);
export function readTasks(): SavedTask[] {
  const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
  if (!Array.isArray(parsed) || parsed.some(task => !task || !['projects','upload','import','release'].includes(task.kind) || (task.kind === 'projects' && !['fork','update','sync'].includes(task.action)) || !Array.isArray(task.items) || task.items.some((item: SavedTask['items'][number]) => !item || !statuses.has(item.status)))) throw new Error('任务恢复记录损坏，请先导出日志并检查本地存储');
  return parsed;
}
export function checkpoint(task: Omit<SavedTask, 'updatedAt'>) {
  // Explicit field selection prevents transient Tokens/errors/payloads entering the journal.
  const items = task.items.map(({ id, label, name, repo, url, remark, status, branch, source, targetId, sha, targetOwner, targetRepo }) => ({ id, label, name, repo, url, remark, status, branch, source, targetId, sha, targetOwner, targetRepo }));
  const entry: SavedTask = { kind: task.kind, action: task.action, scope: task.scope, purge: task.purge, projectId: task.projectId, prefix: task.prefix, items, updatedAt: new Date().toISOString() };
  localStorage.setItem(KEY, JSON.stringify([...readTasks().filter(item => item.kind !== task.kind), entry]));
  window.dispatchEvent(new CustomEvent('gitvault-tasks-changed'));
}
export function forgetTask(kind: TaskKind) {
  localStorage.setItem(KEY, JSON.stringify(readTasks().filter(item => item.kind !== kind)));
  window.dispatchEvent(new CustomEvent('gitvault-tasks-changed'));
}
export function interruptedTask(task: SavedTask): SavedTask {
  return { ...task, items: task.items.map(item => ['running','creating','uploading','downloading','releasing','pending'].includes(item.status) ? { ...item, status: task.kind === 'import' ? 'error' : 'cancelled' } : { ...item }) };
}
export const hasUnfinished = (task: SavedTask) => task.items.some(item => !['success','skipped'].includes(item.status));
