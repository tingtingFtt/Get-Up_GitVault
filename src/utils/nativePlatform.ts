import {hydrateFile} from './nativeFolder';
import { Capacitor } from '@capacitor/core';
import { androidPlugin } from './androidPlugin';
import type { CachedFile } from './localCache';

interface GitVaultNative {
  readVault(): Promise<{ value: string }>;
  writeVault(options: { value: string }): Promise<void>;
  chooseDirectory(): Promise<{ uri: string }>;
  writeDocument(options: { directory: string; path: string; data: string }): Promise<void>;
  beginDownload(options: { name: string; mime: string }): Promise<{ id: string }>;
  appendDownload(options: { id: string; data: string }): Promise<void>;
  finishDownload(options: { id: string }): Promise<void>;
  abortDownload(options: { id: string }): Promise<void>;
}
const plugin = androidPlugin as unknown as GitVaultNative;
export const nativeBridge: GitVaultNative = {
  readVault: () => plugin.readVault(),
  writeVault: options => plugin.writeVault(options),
  chooseDirectory: () => plugin.chooseDirectory(),
  writeDocument: options => plugin.writeDocument(options),
  beginDownload: options => plugin.beginDownload(options),
  appendDownload: options => plugin.appendDownload(options),
  finishDownload: options => plugin.finishDownload(options),
  abortDownload: options => plugin.abortDownload(options),
};
export const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
export const hasNativeFiles = () => isNativeAndroid() && Capacitor.isPluginAvailable('GitVaultNative');

export function safeRelativePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) throw new Error('文件路径不安全：' + path);
  return path;
}
const safeSegment = (value: string) => encodeURIComponent(value).replace(/\*/g, '%2A');
function bytesToBase64(bytes: Uint8Array) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export async function exportProjectDirectory(directory: string, project: { owner: string; repo: string; branch: string; latestCommitSha: string }, files: CachedFile[], signal?: AbortSignal) {
  if (!hasNativeFiles()) throw new Error('当前安装包没有可用的 Android 文件插件');
  if (!directory.startsWith('content://')) throw new Error('请先通过系统选择器授权导出目录');
  const prefix = [project.owner, project.repo, project.branch, project.latestCommitSha].map(safeSegment).join('/');
  for (const handle of files) {
    const file=await hydrateFile(handle);
    signal?.throwIfAborted(); safeRelativePath(file.path);
    const data = file.isBase64 ? file.content.replace(/\s/g, '') : bytesToBase64(new TextEncoder().encode(file.content));
    await nativeBridge.writeDocument({ directory, path: `${prefix}/files/${file.path}`, data });
  }
  signal?.throwIfAborted();
  // A final receipt distinguishes a complete export from an interrupted directory.
  await nativeBridge.writeDocument({ directory, path: `${prefix}/.gitvault-export.json`, data: bytesToBase64(new TextEncoder().encode(JSON.stringify({ ...project, files: files.map(({ content, ...file }) => file), completedAt: new Date().toISOString() }))) });
}

/** Stream chunks to app-private staging, then let Android choose the destination. */
export async function saveDownload(blob: Blob, name: string) {
  if (!isNativeAndroid()) {
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); return;
  }
  if (!hasNativeFiles()) throw new Error('当前安装包缺少文件导出插件');
  const { id } = await nativeBridge.beginDownload({ name, mime: blob.type || 'application/octet-stream' });
  try {
    for (let offset = 0; offset < blob.size; offset += 256 * 1024) {
      await nativeBridge.appendDownload({ id, data: bytesToBase64(new Uint8Array(await blob.slice(offset, offset + 256 * 1024).arrayBuffer())) });
    }
    await nativeBridge.finishDownload({ id });
  } catch (error) { await nativeBridge.abortDownload({ id }).catch(() => {}); throw error; }
}
