/** Project metadata lives separately from disposable source caches. */
export const PROJECT_RECORD_DB = 'GitVault_Records_v1';
const PROJECTS = 'projects', STATE = 'state', MIGRATION = 'migration';
export type ProjectRecord = { id: string };
export interface PreparedRecords { rows: Map<string, string>; order: string[] }
interface RecordState { key: 'current'; revision: number; order: string[] }
const serialized = new WeakMap<object, string>();
export function prepareRecords(projects: readonly ProjectRecord[]): PreparedRecords {
  if (!Array.isArray(projects)) throw new Error('项目记录格式错误，原数据未清除');
  const rows = new Map<string, string>();
  for (const project of projects) {
    if (!project || typeof project.id !== 'string' || !project.id || rows.has(project.id)) throw new Error('项目记录缺少 ID 或存在重复 ID，原数据未清除');
    let json = serialized.get(project);
    if (!json) { json = JSON.stringify(project); serialized.set(project, json); }
    rows.set(project.id, json);
  }
  return { rows, order: [...rows.keys()] };
}
export const recordsJSON = (records: PreparedRecords) => '[' + records.order.map(id => records.rows.get(id)!).join(',') + ']';
function parseRecords(json: string): ProjectRecord[] {
  const projects = JSON.parse(json);
  prepareRecords(projects);
  return projects;
}
async function openRecords(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('当前环境无法使用项目数据库，原记录未清除');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_RECORD_DB, 1);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; reject(new Error('项目数据库被其他页面占用，请关闭旧页面后重试')); }, 10000);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(PROJECTS, { keyPath: 'id' });
      db.createObjectStore(STATE, { keyPath: 'key' });
      db.createObjectStore(MIGRATION, { keyPath: 'key' });
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (timedOut) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
async function readRecords() {
  const db = await openRecords();
  try {
    return await new Promise<{ state?: RecordState; records: PreparedRecords }>((resolve, reject) => {
      const transaction = db.transaction([PROJECTS, STATE], 'readonly');
      const state = transaction.objectStore(STATE).get('current');
      const projects = transaction.objectStore(PROJECTS).getAll();
      transaction.onabort = () => reject(transaction.error || new Error('项目数据库读取中断'));
      transaction.onerror = () => {};
      transaction.oncomplete = () => {
        try {
          const value = state.result as RecordState | undefined;
          const rows = new Map<string, string>((projects.result as Array<{id:string;json:string}>).map(row => [row.id, row.json]));
          if (!value && rows.size) throw new Error('项目数据库缺少索引，已停止读取');
          if (value && (!Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.order) || new Set(value.order).size !== value.order.length || rows.size !== value.order.length || value.order.some(id => !rows.has(id)))) throw new Error('项目数据库索引不完整，已停止读取');
          const records = { rows, order: value?.order || [] };
          const parsed = parseRecords(recordsJSON(records));
          if (parsed.some((project, index) => project.id !== records.order[index])) throw new Error('项目数据库身份不一致，已停止读取');
          resolve({ state: value, records });
        } catch (error) { reject(error); }
      };
    });
  } finally { db.close(); }
}
export function createProjectRecordStore() {
  let revision = 0, persisted: PreparedRecords = { rows: new Map(), order: [] };
  const commit = async (next: PreparedRecords, backups?: Record<string, string>) => {
    const db = await openRecords();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([PROJECTS, STATE, MIGRATION], 'readwrite');
        let failure: unknown;
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(failure || transaction.error || new Error('项目数据库写入中断'));
        transaction.onerror = () => {};
        const state = transaction.objectStore(STATE).get('current');
        state.onsuccess = () => {
          try {
            if ((state.result?.revision || 0) !== revision) throw new Error('其他页面已修改项目记录，请先导出当前备份并重新打开页面，未覆盖较新记录');
            const projects = transaction.objectStore(PROJECTS);
            for (const [id, json] of next.rows) if (persisted.rows.get(id) !== json) projects.put({ id, json });
            for (const id of persisted.order) if (!next.rows.has(id)) projects.delete(id);
            transaction.objectStore(STATE).put({ key: 'current', revision: revision + 1, order: next.order });
            for (const [key, json] of Object.entries(backups || {})) transaction.objectStore(MIGRATION).put({ key, json });
          } catch (error) { failure = error; transaction.abort(); }
        };
      });
      revision++;
      persisted = next;
    } finally { db.close(); }
  };
  return {
    async initialize(legacy: Record<string, string>) {
      const loaded = await readRecords();
      revision = loaded.state?.revision || 0;
      persisted = loaded.records;
      // An existing empty index is authoritative too: never resurrect deleted projects.
      if (!loaded.state) {
        const raw = legacy.gitvault_repos_v8 ?? legacy.gitvault_repos_v7 ?? '[]';
        const prepared = prepareRecords(parseRecords(raw));
        await commit(prepared, legacy);
        const verified = await readRecords();
        if (recordsJSON(verified.records) !== recordsJSON(prepared)) throw new Error('项目记录迁移校验失败，旧记录未清除');
      } else if (Object.keys(legacy).length) {
        // Keep a copy from an older open app before removing its localStorage value.
        await commit(persisted, legacy);
      }
      return { records: persisted, projects: parseRecords(recordsJSON(persisted)) };
    },
    async save(next: PreparedRecords) { await commit(next); },
  };
}
