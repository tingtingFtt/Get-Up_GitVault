import { isNativeAndroid, nativeBridge } from './nativePlatform';

const keys = ['gitvault_global_token', 'gitvault_repos_v7', 'gitvault_repos_v8'];
let values: Record<string, string> = {};
let writeQueue: Promise<void> = Promise.resolve();
let storageFailure: unknown;
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'token').map(([key, item]) => [key, redact(item)]));
  return value;
}
export async function initializeCredentials() {
  if (!isNativeAndroid()) return;
  const stored = await nativeBridge.readVault();
  values = stored.value ? JSON.parse(stored.value) : {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('安全存储格式错误，未清理原数据');
  // Migrate only after a successful encrypted write, keeping originals on failure.
  for (const key of keys) if (!(key in values)) { const value = localStorage.getItem(key); if (value !== null) values[key] = value; }
  await nativeBridge.writeVault({ value: JSON.stringify(values) });
  for (const key of keys) {
    if (key === 'gitvault_global_token') localStorage.removeItem(key);
    else if (values[key]) localStorage.setItem(key, JSON.stringify(redact(JSON.parse(values[key]))));
  }
}
export function readCredentialValue(key: string) {
  return isNativeAndroid() ? values[key] ?? localStorage.getItem(key) : localStorage.getItem(key);
}
export function writeCredentialValue(key: string, value: string) {
  if (!isNativeAndroid()) { localStorage.setItem(key, value); return; }
  if (values[key] === value && !storageFailure) return;
  // Never leave project-specific Tokens in WebView localStorage either.
  if (key === 'gitvault_global_token') localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(redact(JSON.parse(value))));
  values[key] = value;
  const snapshot = JSON.stringify(values);
  writeQueue = writeQueue.catch(() => {}).then(() => nativeBridge.writeVault({ value: snapshot })).then(() => { storageFailure = undefined; }).catch(error => {
    storageFailure = error;
    window.dispatchEvent(new CustomEvent('gitvault-secure-storage-error'));
  });
}
export async function flushCredentials() {
  await writeQueue;
  if (storageFailure) throw new Error('安全存储未完成，请重试保存设置；源码缓存已保留');
}
