import { isNativeAndroid, nativeBridge } from './nativePlatform';
import { createProjectRecordStore, prepareRecords, recordsJSON, type PreparedRecords, type ProjectRecord } from './projectRecordStore';

const projectKeys = ['gitvault_repos_v7', 'gitvault_repos_v8'];
const keys = ['gitvault_global_token', ...projectKeys];
let values: Record<string, string> = {};
let projects: readonly ProjectRecord[] = [];
let prepared: PreparedRecords = { rows: new Map(), order: [] };
let database = createProjectRecordStore();
let initialized = false;
let writeQueue: Promise<void> | undefined;
let requested = 0, committed = 0;
let storageFailure: unknown;
const failureMessage = () => (isNativeAndroid() ? '安全存储未完成' : '项目记录保存未完成') + '；源码缓存已保留，请重试保存或导出备份。' + (storageFailure instanceof Error ? storageFailure.message : '');
function startWrites() {
  if (writeQueue) return;
  writeQueue = Promise.resolve().then(async () => {
    while (committed !== requested) {
      const version = requested;
      const wasFailed = !!storageFailure;
      const records = prepared;
      if (isNativeAndroid()) await nativeBridge.writeVault({ value: JSON.stringify(values) });
      else await database.save(records);
      committed = version;
      storageFailure = undefined;
      if (wasFailed) window.dispatchEvent(new CustomEvent('gitvault-storage-saved'));
    }
  }).catch(error => {
    storageFailure = error;
    window.dispatchEvent(new CustomEvent('gitvault-secure-storage-error', { detail: failureMessage() }));
  }).finally(() => { writeQueue = undefined; if (committed !== requested && !storageFailure) startWrites(); });
}
export async function initializeCredentials() {
  if (writeQueue) await writeQueue;
  initialized = false;
  requested = committed = 0;
  storageFailure = undefined;
  const legacy: Record<string, string> = {};
  for (const key of projectKeys) { const value = localStorage.getItem(key); if (value !== null) legacy[key] = value; }
  if (isNativeAndroid()) {
    const stored = await nativeBridge.readVault();
    values = stored.value ? JSON.parse(stored.value) : {};
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => typeof value !== 'string')) throw new Error('安全存储格式错误，原数据未清除');
    for (const key of keys) if (!(key in values)) { const value = localStorage.getItem(key); if (value !== null) values[key] = value; }
    if (Object.keys(legacy).length) values.gitvault_legacy_project_backup = JSON.stringify(legacy);
    const raw = values.gitvault_repos_v8 ?? values.gitvault_repos_v7 ?? '[]';
    projects = JSON.parse(raw);
    prepared = prepareRecords(projects);
    values.gitvault_repos_v8 = recordsJSON(prepared);
    delete values.gitvault_repos_v7;
    // The plugin resolves only after encrypted SharedPreferences.commit succeeds.
    await nativeBridge.writeVault({ value: JSON.stringify(values) });
    // No project mirror in WebView storage, even when the records exceed its quota.
    localStorage.removeItem('gitvault_global_token');
  } else {
    database = createProjectRecordStore();
    const loaded = await database.initialize(legacy);
    projects = loaded.projects;
    prepared = loaded.records;
  }
  // Migration and read-back verification have completed; originals remain on failure.
  for (const key of projectKeys) localStorage.removeItem(key);
  initialized = true;
}
export function readProjectRecords<T extends ProjectRecord>(): T[] {
  if (!initialized) throw new Error('项目记录尚未完成初始化');
  return projects as T[];
}
export function writeProjectRecords(next: readonly ProjectRecord[]) {
  if (!initialized) throw new Error('项目记录尚未完成初始化');
  const nextRecords = prepareRecords(next);
  const changed = nextRecords.order.length !== prepared.order.length || nextRecords.order.some((id, index) => id !== prepared.order[index] || nextRecords.rows.get(id) !== prepared.rows.get(id));
  projects = next;
  if (!changed && !storageFailure) return;
  prepared = nextRecords;
  if (isNativeAndroid()) values.gitvault_repos_v8 = recordsJSON(prepared);
  requested++;
  startWrites();
}
export function readCredentialValue(key: string) {
  if (projectKeys.includes(key) && initialized) return key === 'gitvault_repos_v8' ? recordsJSON(prepared) : null;
  return isNativeAndroid() ? values[key] ?? localStorage.getItem(key) : localStorage.getItem(key);
}
export function writeCredentialValue(key: string, value: string) {
  if (projectKeys.includes(key)) { writeProjectRecords(JSON.parse(value)); return; }
  if (!isNativeAndroid()) { localStorage.setItem(key, value); return; }
  if (values[key] === value && !storageFailure) return;
  if (key === 'gitvault_global_token') localStorage.removeItem(key);
  values[key] = value;
  requested++;
  startWrites();
}
export const hasUnflushedCredentials = () => requested !== committed || !!storageFailure;
export async function flushCredentials() {
  while (writeQueue) await writeQueue;
  if (storageFailure) throw new Error(failureMessage());
}
export async function retryCredentialWrites() {
  if (requested !== committed || storageFailure) startWrites();
  await flushCredentials();
}
