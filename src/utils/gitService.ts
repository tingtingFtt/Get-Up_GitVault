import { hasNativeGit, nativeGitTransfer } from './nativeGit';
import type { NativeFetchOptions } from './nativeGit';
import {hydrateFile} from './nativeFolder';
import type { CachedFile } from './localCache';

export interface GitServiceConfig { mode: 'rest' | 'git' | 'native'; url: string }
const KEY = 'gitvault_git_service_v1';
export class GitServiceError extends Error { constructor(message: string, public status = 0) { super(message); } }
export function serviceUrl(value: string) {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Git 服务需要 HTTPS 地址，本机开发可使用 localhost HTTP；地址中不能带凭证或查询参数');
  return url.href.replace(/\/+$/, '');
}
export function gitServiceConfig(): GitServiceConfig {
  if (typeof window === 'undefined') return { mode: 'rest', url: '' };
  try { const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved && ['git','rest','native'].includes(saved.mode)) return { mode: saved.mode, url: saved.url ? serviceUrl(saved.url) : '' }; }
  catch { if (localStorage.getItem(KEY)) throw new Error('Git 传输设置无效，请在设置中重新选择传输方式'); }
  return { mode: hasNativeGit() ? 'native' : 'rest', url: import.meta.env?.VITE_GIT_SERVICE_URL || '' };
}
export function saveGitServiceConfig(config: GitServiceConfig) {
  const value = { mode: config.mode, url: config.url.trim() ? serviceUrl(config.url) : '' };
  if (value.mode === 'git' && !value.url) throw new Error('请填写自己信任的 Git 服务地址');
  localStorage.setItem(KEY, JSON.stringify(value));
}
async function call(url: string, path: string, token: string, payload: unknown, signal: AbortSignal) {
  const endpoint = serviceUrl(url);
  const response = await fetch(`${endpoint}/api/git/${path}`, { method: payload ? 'POST' : 'GET', headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.any([signal, AbortSignal.timeout(payload ? 10 * 60000 : 10000)]), cache: 'no-store', credentials: 'omit', redirect: 'error' });
  const value = await response.json();
  if (!response.ok) throw new GitServiceError(`Git 服务 (${response.status})：${String(value.error || '传输失败').slice(0, 450)}`, response.status);
  if (value.service !== 'GitVault' || value.version !== 1) throw new GitServiceError('Git 服务响应格式不符，未继续传输');
  return value;
}
export async function testGitService(url: string, signal = new AbortController().signal) {
  // Check the configured service without transmitting the GitHub credential.
  const result = await call(url, 'health', '', undefined, signal);
  if (!['fetch','push'].every(item => result.capabilities?.includes(item))) throw new GitServiceError('Git 服务缺少拉取或推送能力');
  return result;
}
export async function gitServiceTransfer(action: 'fetch' | 'push', payload: { owner: string; repo: string; expectedRepoId: number; ref?: string; branch?: string; files?: CachedFile[]; message?: string; rebaseOnConflict?: boolean; totalBytes?: number; folderVersion?: string }, token: string, signal: AbortSignal, options: NativeFetchOptions = {}) {
  const config = gitServiceConfig();
  if (config.mode === 'native') return nativeGitTransfer(action,payload,token,signal,options);
  if (config.mode !== 'git') throw new GitServiceError('当前尚未启用 Git 服务传输');
  if (!token) throw new GitServiceError('Git 服务模式需要先填写 GitHub Token', 401);
  await testGitService(config.url, signal); signal.throwIfAborted();
  // The external JSON service is optional; native mode streams document handles directly.
  if(payload.files?.some(file=>file.nativeRef)){const hydrated:CachedFile[]=[];for(const file of payload.files){signal.throwIfAborted();hydrated.push(await hydrateFile(file));}payload={...payload,files:hydrated};}
  return (await call(config.url, action, token, payload, signal)).result;
}
