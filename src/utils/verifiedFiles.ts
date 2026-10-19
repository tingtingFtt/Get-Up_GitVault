import type {CachedFile} from './localCache';
import {gitBlobSha} from './gitFiles';
import {cooperate} from './operation';
// Task-local in-memory evidence, never a persistent flag supplied by a caller.
// Content/encoding changes invalidate it; native handles are always read natively.
const verified = new WeakMap<CachedFile, {content:string;isBase64:boolean;sha:string;size:number}>();
export function rememberVerifiedFile(file: CachedFile, sha: string, size: number) {
  if (!file.nativeRef) verified.set(file, {content:file.content,isBase64:file.isBase64,sha,size});
  return file;
}
export async function verifiedBlobSha(file: CachedFile, signal?: AbortSignal): Promise<{sha:string;size:number}> {
  await cooperate(signal);
  if (file.nativeRef) throw new Error('目录引用必须读取当前内容后校验');
  let value = verified.get(file);
  if (!value || value.content !== file.content || value.isBase64 !== file.isBase64) {
    const bytes = file.isBase64 ? Uint8Array.from(atob(file.content.replace(/\s/g,'')), c=>c.charCodeAt(0)) : new TextEncoder().encode(file.content);
    value = {content:file.content,isBase64:file.isBase64,sha:await gitBlobSha(bytes),size:bytes.length};
    signal?.throwIfAborted(); verified.set(file,value);
  }
  if (file.sha && file.sha !== value.sha) throw new Error('文件内容与版本不一致：'+file.path);
  if (file.size !== undefined && file.size !== value.size) throw new Error('文件大小与版本不一致：'+file.path);
  return {sha:value.sha,size:value.size};
}
