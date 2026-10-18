import { Capacitor, registerPlugin } from '@capacitor/core';

const KEY = 'gitvault_native_object_cache_v1';
const plugin = registerPlugin<{ clearObjectCache(): Promise<{bytes:number}> }>('GitVaultGit');
export const nativeGitCacheBridge = { clear: () => plugin.clearObjectCache() };
export const nativeGitCacheEnabled = () => typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'true';
export async function clearNativeGitCache() {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('GitVaultGit')) return nativeGitCacheBridge.clear();
}
export async function saveNativeGitCache(enabled:boolean) {
  // Do not announce that retention is disabled until the old objects are gone.
  if (!enabled) await clearNativeGitCache();
  localStorage.setItem(KEY,String(enabled));
}
