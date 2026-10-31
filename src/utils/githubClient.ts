import { sourceMarker } from './projectProvenance';
import {usesNativeFolder, beginFolder, putFolderFile, finishFolder, hasLocalFolderChanges, confirmFolderUpload, hydrateFile, type FolderFiles} from './nativeFolder';
import { gitBlobSha, gitTreeSha } from './gitFiles';
import {beginGithubOperation, cancelGithubOperation, operationSignal, cooperate} from './operation';
export {beginGithubOperation, cancelGithubOperation, operationSignal} from './operation';
import {verifiedBlobSha, rememberVerifiedFile} from './verifiedFiles';
import {planFileChanges,shouldUseNativeBlobDelta} from './transferPlan';
export { gitBlobSha } from './gitFiles';
import { transferCache, uploadCache } from './localCache';
import type { CachedFile } from './localCache';
import type { TargetHealth, TargetIdentity } from './targetLifecycle';
import { githubTransport, GitHubError } from './githubTransport';
export { GitHubError } from './githubTransport';
import { gitServiceConfig, gitServiceTransfer } from './gitService';
import { measureTransfer } from './transferMetrics';
import {shouldUseArchive} from './transferPlan';
import {markTransferFailure, transferFailureKind, transferFailureLabel, isStorageFailure} from './transferFailure';

export interface RepoEntry {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
}
export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  cachedFiles?: CachedFile[];
  ref?: string;
}

export function isOperationCancelled(error: unknown, signal: AbortSignal) {
  const reason = error as { name?: string; code?: string } | null;
  return signal.aborted || reason?.name === 'AbortError' || reason?.code === 'CANCELLED';
}
function progress(message: string, options?: TransferOptions) {
  options?.onProgress?.(message);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gitvault-progress', { detail: message }));
}
function headers(token?: string, raw = false): Record<string, string> {
  return {
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
export class TargetRepositoryError extends GitHubError {
  constructor(public health: TargetHealth, status: number) { super(health.message, status, health.status === 'limited'); }
}
let repositoryCheckSequence = 0;
function targetHealthEvent(target: TargetIdentity, health: TargetHealth, checkId: number, identity?: { id?: number; owner: string; repo: string; htmlUrl: string }) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gitvault-target-health', { detail: { target, health, identity, checkId } }));
}

// Every operation, including account records and source blobs, uses one policy.
async function request(path: string, token?: string, init: RequestInit = {}, signal = operationSignal(), timeout = 90000): Promise<Response> {
  return githubTransport.request(path.startsWith('https://') ? path : `https://api.github.com${path}`, {
    ...init, headers: { ...headers(token), ...init.headers },
  }, signal, timeout);
}
const taskReads=new WeakMap<AbortSignal,Map<string,Promise<any>>>();
function reads(signal:AbortSignal){let values=taskReads.get(signal);if(!values){values=new Map();taskReads.set(signal,values);}return values;}
async function json(path: string, token?: string, init: RequestInit = {}, signal=operationSignal()) {
  signal.throwIfAborted();
  // A token identifies one account for this task. Only immutable full-SHA Git
  // resources are reused; mutable refs, repository identity and registry heads
  // always go to the server and are never served from this map.
  const reusable=!init.method&&(path==='/user'||/\/(?:git\/)?(?:commits|trees)\/[a-f0-9]{40}(?:\?recursive=1)?$/.test(path));
  const key=JSON.stringify([token||'',path]),values=reads(signal);
  let pending=reusable?values.get(key):undefined;
  if(!pending){pending=(async()=>{const response=await request(path,token,init,signal);return response.status===204?{}:response.json();})();if(reusable){values.set(key,pending);void pending.catch(()=>{if(values.get(key)===pending)values.delete(key);});}}
  const value=await pending;signal.throwIfAborted();
  const commitPath=/^(.*\/commits)\/[^?]+$/.exec(path);
  if(commitPath&&/^[a-f0-9]{40}$/.test(value?.sha)&&value?.commit?.tree?.sha)values.set(JSON.stringify([token||'',`${commitPath[1]}/${value.sha}`]),Promise.resolve(structuredClone(value)));
  return reusable?structuredClone(value):value;
}
export const githubApi = json;
function body(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
const root = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
function temporaryConnectionFailure(error: unknown) {
  return error instanceof GitHubError ? !error.rateLimited && [408, 500, 502, 503, 504].includes(error.status) : transferFailureKind(error) === 'network';
}
async function waitForUploadRecovery(attempt: number, signal: AbortSignal) {
  const delay = 1000 * 2 ** attempt;
  progress(`上传连接中断，已核对远端，${delay / 1000} 秒后恢复（${attempt + 1}/2）；可取消`);
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export function parseRepository(url: string) {
  const input = url.trim();
  const full = /^https?:\/\//i.test(input) ? new URL(input) : null;
  if (full && !/^(www\.)?github\.com$/i.test(full.hostname)) throw new Error('请使用 github.com 仓库地址');
  const parts = (full ? full.pathname : input.replace(/^(www\.)?github\.com\//i, '')).split('/').filter(Boolean).map(decodeURIComponent);
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, '');
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('仓库地址格式错误，请使用 owner/repo 或 GitHub 链接');
  return { owner, repo, linkedRef: ['tree', 'blob'].includes(parts[2]) ? parts.slice(3).join('/') : '' };
}
async function resolveRef(owner: string, repo: string, linked: string, explicit: string | undefined, token?: string, signal?: AbortSignal) {
  if (explicit) return explicit;
  if (linked) {
    // Longest matching branch/tag also supports branch names containing slashes and file URLs.
    const parts = linked.split('/');
    for (let n = parts.length; n > 0; n--) {
      const candidate = parts.slice(0, n).join('/');
      try { await json(`${root(owner, repo)}/commits/${encodeURIComponent(candidate)}`, token, {}, signal); return candidate; }
      catch (e) { if (!(e instanceof GitHubError) || !(e.status === 404 || e.status === 422 && /No commit found for SHA:/i.test(e.message))) throw e; }
    }
    throw new Error('链接中的分支、标签或提交不存在');
  }
  return ''; // caller already has the repository metadata

}
async function getTree(owner: string, repo: string, sha: string, token?: string, signal?: AbortSignal): Promise<RepoEntry[]> {
  const data = await json(`${root(owner, repo)}/git/trees/${sha}?recursive=1`, token, {}, signal);
  if (!data.truncated) return data.tree;
  const result: RepoEntry[] = [];
  async function walk(treeSha: string, prefix = '') {
    const tree = await json(`${root(owner, repo)}/git/trees/${treeSha}`, token, {}, signal);
    for (const item of tree.tree) {
      const entry = { ...item, path: prefix + item.path };
      result.push(entry);
      if (item.type === 'tree') await walk(item.sha, entry.path + '/');
    }
  }
  await walk(sha);
  return result;
}
function bytesFromBase64(value: string) {
  const text = atob(value.replace(/\s/g, ''));
  return Uint8Array.from(text, c => c.charCodeAt(0));
}
function base64FromBytes(bytes: Uint8Array) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}

async function cachedFile(entry: RepoEntry, bytes: Uint8Array): Promise<CachedFile> {
  if (entry.size !== undefined && bytes.length !== entry.size) throw markTransferFailure(new Error(`文件大小校验失败: ${entry.path}`), 'validation');
  if (await gitBlobSha(bytes) !== entry.sha) throw markTransferFailure(new Error(`文件校验失败: ${entry.path}`), 'validation');
  let content: string;
  let isBase64 = false;
  try {
    if (bytes.includes(0)) throw new Error('binary');
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // A BOM must survive a round trip as well.
    if (new TextEncoder().encode(content).length !== bytes.length) throw new Error('encoding');
  } catch { content = base64FromBytes(bytes); isBase64 = true; }
  return rememberVerifiedFile({ path: entry.path, content, isBase64, sha: entry.sha, mode: entry.mode, size: bytes.length },entry.sha,bytes.length);
}
/** Small native deltas still use the shared admission/rate-limit policy. Read
 * their bounded JSON bodies with an idle deadline, not a total 45-second timer. */
async function deltaBlob(owner:string,repo:string,entry:RepoEntry,token:string|undefined,signal:AbortSignal) {
  return githubTransport.stream(`https://api.github.com${root(owner,repo)}/git/blobs/${entry.sha}`,{headers:headers(token)},signal,async(response,touch,downloadSignal)=>{
    if(!response.body)throw markTransferFailure(new Error('变化文件响应没有正文'),'network');
    const reader=response.body.getReader(),decoder=new TextDecoder(),parts:string[]=[];
    const limit=Math.ceil(((entry.size||0)+2)/3)*4+1024*1024;let received=0,lastReport=0;
    try{
      for(;;){downloadSignal.throwIfAborted();let chunk;
        try{chunk=await reader.read();}catch(error){downloadSignal.throwIfAborted();throw markTransferFailure(error,'network');}
        if(chunk.done)break;touch();received+=chunk.value.length;
        if(received>limit)throw markTransferFailure(new Error('变化文件响应超过预期大小：'+entry.path),'validation');
        parts.push(decoder.decode(chunk.value,{stream:true}));
        if(Date.now()-lastReport>500){lastReport=Date.now();progress(`正在接收变化文件 ${entry.path} · ${(received/1048576).toFixed(1)} MiB`);}
      }
      parts.push(decoder.decode());let value;
      try{value=JSON.parse(parts.join(''));}catch(error){throw markTransferFailure(error,'validation');}
      if(value.encoding&&value.encoding!=='base64'||typeof value.content!=='string')throw markTransferFailure(new Error('变化文件编码无效：'+entry.path),'validation');
      return value.content as string;
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  });
}
export async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index], index); } catch (e) { failed = e; }
    }
  }));
  if (failed) throw failed;
  return results;
}

export const githubClient = {
  async validateToken(token: string) {
    const user = await json('/user', token);
    const limits = await json('/rate_limit', token);
    return { valid: true, user: { login: user.login, name: user.name || user.login, avatarUrl: user.avatar_url, htmlUrl: user.html_url, publicRepos: user.public_repos, privateRepos: user.total_private_repos || 0 }, rateLimit: limits.rate };
  },

  async fetchRepo(url: string, branch?: string, token?: string, options: TransferOptions = {}) {
    const signal = options.signal || operationSignal();
    const { owner, repo, linkedRef } = parseRepository(url);
    return measureTransfer({action:'拉取',project:`${owner}/${repo}`,branch,mode:gitServiceConfig().mode,signal}, async trace => {
    progress('正在识别仓库和分支…', options);
    const meta = await json(root(owner, repo), token, {}, signal);
    const ref = options.ref || await resolveRef(owner, repo, linkedRef, branch, token, signal) || meta.default_branch;
    const commit = await json(`${root(owner, repo)}/commits/${encodeURIComponent(ref)}`, token, {}, signal);
    const tree = await getTree(owner, repo, commit.commit.tree.sha, token, signal);
    // ZIPs do not include submodule contents. Never claim those projects are completely cached.
    if (tree.some(item => item.type === 'commit')) throw new Error('项目包含 Git 子模块，需要单独获取子模块内容；本次未标记为完整下载');
    const entries = tree.filter(item => item.type === 'blob');
    const plan=planFileChanges(options.cachedFiles||[],entries);
    progress(`更新计划：新增 ${plan.added.length} · 修改 ${plan.modified.length} · 删除 ${plan.removed.length} · 未变化 ${plan.unchanged.length}`,options);
    trace.count('新增文件',plan.added.length);trace.count('修改文件',plan.modified.length);trace.count('删除文件',plan.removed.length);
    trace.branch(branch || (linkedRef ? ref : meta.default_branch));trace.phase('准备本地目录与恢复进度');
    const folder = usesNativeFolder() ? await beginFolder(JSON.stringify([meta.id || `${owner}/${repo}`, branch || (linkedRef ? ref : meta.default_branch)]), commit.sha, repo, entries,signal,options.cachedFiles?.find(file=>file.nativeRef)?.nativeRef?.version) : undefined;
    const checkpoint = typeof window !== 'undefined' && typeof indexedDB !== 'undefined' ? transferCache : undefined;
    const transfer = `${owner}/${repo}@${commit.sha}`;
    const resumed = folder ? folder.files as CachedFile[] : checkpoint ? await checkpoint.load(transfer) : [];
    const cachedPrevious=new Map((options.cachedFiles||[]).filter(file=>!folder||!file.nativeRef).map(file=>[file.path,file]));
    const previous = new Map([...cachedPrevious.values(), ...resumed].map(f => [f.path, f]));
    const previousBlobs = new Map([...previous.values()].filter(file => !file.nativeRef).map(file => [file.sha, file]));
    const files = new Map<string, CachedFile>();
    let pendingParts: CachedFile[] = [], pendingBytes = 0, saving = Promise.resolve();
    const flushParts = () => { const batch = pendingParts; pendingParts = []; pendingBytes = 0; if (checkpoint && batch.length) saving = saving.then(() => checkpoint.saveBatch(transfer, commit.sha, batch)).catch(error => { throw markTransferFailure(error, isStorageFailure(error) ? transferFailureKind(error) : 'storage'); }); return saving; };
    const savePart = async (file: CachedFile) => { if (folder) return; if (!checkpoint) return; pendingParts.push(file); pendingBytes += file.size || file.content.length; if (pendingBytes >= 4 * 1024 * 1024 || pendingParts.length >= (entries.length >= 64 ? 32 : 1)) await flushParts(); };
    const storeFile = async (file:CachedFile) => {
      if(!file.isBase64&&file.content.startsWith('version https://git-lfs.github.com/spec/v1'))throw new Error('项目包含 Git LFS 指针，未标记完整下载');
      try{const saved=folder&&file.nativeRef?.version!==folder.id?await putFolderFile(folder.id,file,signal):file;
      await savePart(saved);files.set(file.path,saved);}catch(error){throw markTransferFailure(error, isStorageFailure(error) ? transferFailureKind(error) : 'storage');}
    };
    let done = 0, nativeFolderFinished=false;
    const missing: RepoEntry[] = [];
    for (const entry of entries) {
      await cooperate(signal);const known=cachedPrevious.get(entry.path);const old = known?.sha===entry.sha ? known : previous.get(entry.path)?.sha === entry.sha ? previous.get(entry.path) : previousBlobs.get(entry.sha);
      if (old?.sha === entry.sha) {
        const reused={...old,path:entry.path,mode:entry.mode};
        if(!old.nativeRef){const verified=await verifiedBlobSha(old,signal);rememberVerifiedFile(reused,verified.sha,verified.size);}
        await storeFile(reused);done++;
        if(done%32===0)progress(`正在复用未变化文件 ${done}/${entries.length}：${entry.path}`,options);
      }
      else missing.push(entry);
    }
    trace.phase('获取、校验并保存文件（含排队等待）');
    trace.count('复用文件',done);
    const transport=gitServiceConfig(),nativeDelta=transport.mode==='native'&&shouldUseNativeBlobDelta(entries,missing);
    if(nativeDelta)progress(`增量更新：仅补拉 ${missing.length} 个变化文件，跳过完整 Git 对象包…`,options);
    if (transport.mode !== 'rest' && missing.length && !nativeDelta) {
      if (!Number.isSafeInteger(meta.id) || meta.id <= 0) throw new Error('来源仓库缺少可信 ID，未开始 Git 传输');
      progress('正在通过 Git 获取选定提交的完整项目…', options);
      const expected = new Map(entries.map(entry => [entry.path, entry]));
      const acceptFile = async (remote: { path: string; sha: string; mode: string; encoding: string; content: string; nativeRef?: CachedFile['nativeRef'];size?:number }) => {
        signal.throwIfAborted(); const entry = expected.get(remote.path);
        if (!entry || remote.sha !== entry.sha || remote.mode !== entry.mode || remote.encoding !== 'base64') throw new Error('Git 文件清单校验失败，本地原版本已保留');
        const file = remote.nativeRef ? {...remote,isBase64:true} : await cachedFile(entry, bytesFromBase64(remote.content)); await storeFile(file);
      };
      let result;
      try { result = await gitServiceTransfer('fetch', { owner, repo, expectedRepoId: meta.id, ref: commit.sha, folderVersion: folder?.id, totalBytes: entries.reduce((n, entry) => n + (entry.size || 0), 0) }, token || '', signal, { onFile: acceptFile, paths: missing.map(entry => entry.path) }); }
      finally { await flushParts(); }
      trace.native(result.timings);
      if (result.commitSha !== commit.sha || result.treeSha !== commit.commit.tree.sha || !Array.isArray(result.files) || result.files.length !== entries.length) throw new Error('Git 拉取结果与选定快照不一致，本地原版本已保留');
      const received = new Set<string>();
      for (const remote of result.files) {
        signal.throwIfAborted();
        const entry = expected.get(remote.path);
        if (!entry || received.has(remote.path) || remote.sha !== entry.sha || remote.mode !== entry.mode || remote.encoding !== 'base64') throw new Error('Git 文件清单校验失败，本地原版本已保留');
        received.add(remote.path);
        if (!result.streamed) await acceptFile(remote);
        else if (files.get(entry.path)?.sha !== entry.sha) throw new Error('Git 文件分块未完整接收，本地原版本已保留');
      }
      done = files.size;nativeFolderFinished=!!result.folder;
    }
    // Stream large initial snapshots too: keep neither the complete ZIP nor
    // all inflated bytes alongside the cached source bodies in memory.
    const remainingBytes = missing.reduce((sum, entry) => sum + (entry.size || 0), 0);
    // A previous partial archive already paid for the whole package. Keep that
    // decision across reloads and fill only missing blobs for the same commit.
    const archiveRecovery = checkpoint ? await checkpoint.archiveRecovery(transfer) : undefined;
    if (archiveRecovery && missing.length) progress('恢复上次下载：复用已校验文件，仅补齐缺失内容…', options);
    if (!nativeDelta && !archiveRecovery && shouldUseArchive(entries,missing.filter(entry=>!files.has(entry.path)),!!options.cachedFiles?.length)) {
      const archiveUrls = [`https://api.github.com${root(owner, repo)}/zipball/${commit.sha}`];
      if (!token) archiveUrls.push(`https://codeload.github.com/${owner}/${repo}/zip/${commit.sha}`);
      const { readArchive } = await import('./archiveDownload');
      for (const archiveUrl of archiveUrls) {
        signal.throwIfAborted();
        const before=files.size;trace.count('ZIP 尝试',1);let received=0;
        try {
          progress(`正在流式下载压缩包（${entries.length} 个文件）…`, options);
          let lastReport = 0;
          await githubTransport.stream(archiveUrl, { headers: headers(token) }, signal, (response, touch, downloadSignal) =>
            readArchive(response, missing.filter(entry => !files.has(entry.path)), downloadSignal, async (entry, bytes) => {
              const file = await cachedFile(entry, bytes); await storeFile(file); done++;
              if (Date.now() - lastReport >= 200 || done === entries.length) { lastReport = Date.now(); progress(`正在解压、校验并保存 ${done}/${entries.length}：${entry.path}`, options); }
            }, bytes => { received=bytes;if (Date.now() - lastReport >= 500) { lastReport = Date.now(); progress(`正在接收压缩包 ${(bytes / 1024 / 1024).toFixed(1)} MiB · 已保存 ${done}/${entries.length}`, options); } }, touch));
          break;
        } catch (error) {
          await flushParts();
          // Persist only partial progress; metadata never contains source bodies,
          // credentials or an unpinned branch name. Storage failures stop here.
          if (checkpoint && files.size > before && !isStorageFailure(error)) {
            await checkpoint.noteArchiveRecovery(transfer, commit.sha, signal.aborted ? 'cancelled' : transferFailureKind(error));
          }
          if (signal.aborted) throw signal.reason;
          if (error instanceof GitHubError && error.rateLimited) throw error;
          if(isStorageFailure(error))throw error;
          trace.count('ZIP 失败',1);
          trace.recovery(error);
          done = files.size;
          progress(`${transferFailureLabel(error)}；保留已验证文件并补齐缺失内容…`, options);
          if (files.size === entries.length) break;
          // Once an archive has yielded verified files, do not download the
          // complete ZIP again via another endpoint just to fill a small gap.
          if(files.size>before)break;
        }finally{trace.count('ZIP 接收字节',received);}
      }
    }
    // Identical Git blobs at different paths need one download and one hash.
    const blobs = new Map<string, RepoEntry[]>();
    for (const entry of missing) if (!files.has(entry.path)) { const aliases = blobs.get(entry.sha); if (aliases) aliases.push(entry); else blobs.set(entry.sha, [entry]); }
    const reusableBlobs = new Map([...files.values()].filter(file => !file.nativeRef).map(file => [file.sha, file]));
    try { await mapConcurrent([...blobs.values()], remainingBytes > 32 * 1024 * 1024 ? 2 : 3, async aliases => {
      signal.throwIfAborted();
      const entry = aliases[0];
      const reused = reusableBlobs.get(entry.sha);
      if(!reused)trace.count('补拉文件',1);
      const file = reused || await cachedFile(entry, bytesFromBase64(nativeDelta?await deltaBlob(owner,repo,entry,token,signal):(await json(`${root(owner, repo)}/git/blobs/${entry.sha}`, token, {}, signal)).content));
      for (const alias of aliases) { if (alias.size !== undefined && alias.size !== file.size) throw new Error('相同内容的文件大小不一致：' + alias.path); const copy={ ...file, path: alias.path, mode: alias.mode };if(!copy.nativeRef)rememberVerifiedFile(copy,entry.sha,file.size!);await storeFile(copy); done++; }
      progress(`正在下载并校验 ${done}/${entries.length}：${entry.path}`, options);
    }); } finally { await flushParts(); }
    if (files.size !== entries.length) throw new Error('文件下载不完整，已保留原版本，请重试');
    // LFS pointer files are project files, but not the binary objects they reference.
    const lfsPointers = [...files.values()].filter(f => !f.isBase64 && f.content.startsWith('version https://git-lfs.github.com/spec/v1')).map(f => f.path);
    if (lfsPointers.length) throw new Error(`项目包含 Git LFS 文件（${lfsPointers.slice(0, 3).join('、')}），当前无法完整保存其大文件内容`);
    trace.phase('验证完整快照');
    progress(`文件已校验 ${files.size}/${entries.length}，正在保存缓存…`, options);
    if(folder&&!nativeFolderFinished)await finishFolder(folder.id,async paths=>{
      const manifest=new Map(entries.map(entry=>[entry.path,entry]));
      if(paths.some(path=>!manifest.has(path)))throw new Error('目录修复请求包含快照外路径，已停止并保留文件');
      await mapConcurrent(paths,2,async path=>{signal.throwIfAborted();const entry=manifest.get(path)!;const blob=await json(`${root(owner,repo)}/git/blobs/${entry.sha}`,token,{},signal);await storeFile(await cachedFile(entry,bytesFromBase64(blob.content)));});
    },signal);
    const completedFiles=entries.map(e=>files.get(e.path)!) as FolderFiles;
    if(folder)completedFiles.nativeSnapshot={version:folder.id,dirty:false};
    return {
      owner, repo, repositoryId: meta.id as number | undefined, branch: branch || (linkedRef ? ref : meta.default_branch), latestCommitSha: commit.sha,
      commitMessage: commit.commit.message, commitAuthor: commit.commit.author?.name || 'Unknown', commitDate: commit.commit.author?.date,
      repoMeta: { description: meta.description || '', stars: meta.stargazers_count || 0, forks: meta.forks_count || 0, language: meta.language || 'Unknown', updatedAt: meta.updated_at, htmlUrl: meta.html_url },
      tree, files: completedFiles, cachedFilesCount: files.size, isFullyCached: true,
    };
    });
  },

  async getFile(owner: string, repo: string, path: string, token?: string, ref?: string) {
    const entry = await json(`${root(owner, repo)}/contents/${refPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, token);
    if (entry.type !== 'file' && entry.type !== 'symlink') throw new Error('请选择文件，目录不能作为文件读取');
    let bytes: Uint8Array;
    if (entry.encoding === 'base64') bytes = bytesFromBase64(entry.content);
    else bytes = new Uint8Array(await (await request(`${root(owner, repo)}/contents/${refPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, token, { headers: headers(token, true) })).arrayBuffer());
    const file = await cachedFile({ ...entry, path, mode: entry.mode || '100644' }, bytes);
    return { type: file.isBase64 ? 'base64' : 'text', content: file.content };
  },

  async checkUpdate(owner: string, repo: string, branch: string, currentSha: string, token?: string) {
    const commit = await json(`${root(owner, repo)}/commits/${encodeURIComponent(branch)}`, token);
    if(/^[a-f0-9]{40}$/.test(commit.sha))reads(operationSignal()).set(JSON.stringify([token||'',`${root(owner,repo)}/commits/${commit.sha}`]),Promise.resolve(commit));
    return { hasUpdate: commit.sha !== currentSha, latestSha: commit.sha, latestCommit: { sha: commit.sha, message: commit.commit.message, author: commit.commit.author?.name, date: commit.commit.author?.date } };
  },

  async repository(owner: string, repo: string, token?: string, expectedId?: number, signal = operationSignal()) {
    const target = { id: expectedId, owner, repo };
    const checkId = ++repositoryCheckSequence;
    try {
      const meta = await json(root(owner, repo), token, { cache: 'no-store' }, signal);
      if (expectedId && meta.id !== expectedId) throw new TargetRepositoryError({ ...target, status: 'identity-changed', checkedAt: new Date().toISOString(), message: '目标仓库身份已变化，身份校验失败，已停止操作；可能删除后创建了同名仓库。请通过“管理远端目标”确认解除旧绑定后重新设置，避免误写新仓库。' }, 409);
      const identity = { id: meta.id as number | undefined, owner: meta.owner?.login || owner, repo: meta.name || repo, defaultBranch: meta.default_branch || 'main', htmlUrl: meta.html_url || `https://github.com/${owner}/${repo}`, private: meta.private, forkParentId: meta.fork ? meta.parent?.id as number | undefined : undefined, forkParent: meta.fork ? (meta.parent?.full_name || (meta.parent?.owner?.login && meta.parent?.name ? `${meta.parent.owner.login}/${meta.parent.name}` : undefined)) as string | undefined : undefined };
      targetHealthEvent(target, { id: identity.id, owner: identity.owner, repo: identity.repo, status: 'available', checkedAt: new Date().toISOString(), message: '远端仓库可访问，身份校验通过' }, checkId, { id: identity.id, owner: identity.owner, repo: identity.repo, htmlUrl: identity.htmlUrl });
      return identity;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const status = error instanceof GitHubError ? error.status : 0;
      const kind: TargetHealth['status'] = error instanceof TargetRepositoryError ? error.health.status : status === 404 ? 'unavailable' : status === 401 ? 'auth' : error instanceof GitHubError && error.rateLimited ? 'limited' : status === 403 ? 'forbidden' : 'error';
      const explanation = { available: '', unavailable: '远端目标无法访问：可能已删除、改名，或当前 Token 无权限。请重新检测、更新 Token，或确认后解除旧绑定。', auth: 'GitHub Token 无效或已过期，请更新 Token 后重新检测。', forbidden: '当前 Token 无访问权限，或需要组织授权；请检查权限后重新检测。', limited: 'GitHub 请求受限，请在限流恢复后重试；绑定已保留。', error: '远端检测暂时失败，请检查网络并重试；绑定已保留。', 'identity-changed': '' }[kind];
      const health: TargetHealth = error instanceof TargetRepositoryError ? error.health : { ...target, status: kind, checkedAt: new Date().toISOString(), message: `${explanation} ${(error as Error).message}` };
      targetHealthEvent(target, health, checkId);
      throw new TargetRepositoryError(health, status);
    }
  },

  async inspectImportTarget(target: { id?: number; owner: string; repo: string; branch: string }, token?: string, forkSource?: { owner: string; repo: string; repositoryId?: number }, verifiedCommit?: string) {
    const identity = await githubClient.repository(target.owner, target.repo, token, target.id);
    if (forkSource && (forkSource.repositoryId && identity.forkParentId ? forkSource.repositoryId !== identity.forkParentId : identity.forkParent?.toLowerCase() !== `${forkSource.owner}/${forkSource.repo}`.toLowerCase())) throw new Error('目标分叉的上游与来源不一致，不能沿用此同步关系');
    let commit;
    try { commit = await json(`${root(identity.owner, identity.repo)}/commits/${encodeURIComponent(target.branch)}`, token, { cache: 'no-store' }); }
    catch (error) {
      const missingRef = error instanceof GitHubError && (error.status === 404
        || error.status === 422 && /No commit found for SHA:/i.test(error.message)
        || error.status === 409 && /Git Repository is empty/i.test(error.message));
      if (!missingRef) throw error;
      // A missing ref is safe to create later; an inaccessible repository is not.
      await githubClient.repository(identity.owner, identity.repo, token, identity.id);
      for (let page = 1; ; page++) {
        const branches = await json(`${root(identity.owner, identity.repo)}/branches?per_page=100&page=${page}`, token, { cache: 'no-store' });
        if (!Array.isArray(branches)) throw new Error('目标分支列表读取失败，未将其当作空仓库');
        if (branches.some(branch => branch.name === target.branch)) throw error;
        // An accessible empty target is legitimate; source imports still require a commit.
        if (branches.length < 100) return { identity, commitSha: undefined, tree: [] as RepoEntry[], missingBranch: true };
      }
    }
    if(verifiedCommit && commit.sha===verifiedCommit)return {identity,commitSha:commit.sha as string,tree:[] as RepoEntry[],missingBranch:false,receiptMatched:true};
    const tree = await getTree(identity.owner, identity.repo, commit.commit.tree.sha, token);
    return { identity, commitSha: commit.sha as string, tree, missingBranch: false };
  },

  async renameRepository(target: { id?: number; owner: string; repo: string }, name: string, token: string) {
    const requested = name.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(requested)) throw new Error('仓库名称只能包含英文、数字、点、下划线和连字符');
    const before = await githubClient.repository(target.owner, target.repo, token, target.id);
    const meta = await json(root(before.owner, before.repo), token, body('PATCH', { name: requested }));
    if (before.id && meta.id !== before.id) throw new Error('重命名后的仓库身份校验失败，未更新本地绑定');
    return { id: meta.id as number | undefined, owner: meta.owner?.login || before.owner, repo: meta.name as string, htmlUrl: meta.html_url as string };
  },

  async inspectRepo(url: string, branch: string | undefined, token?: string, ref?: string) {
    const { owner, repo, linkedRef } = parseRepository(url);
    const meta = await json(root(owner, repo), token, { cache: 'no-store' });
    const selectedBranch = await resolveRef(owner, repo, linkedRef, branch, token) || meta.default_branch;
    const selected = ref || selectedBranch;
    const commit = await json(`${root(owner, repo)}/commits/${encodeURIComponent(selected)}`, token, { cache: 'no-store' });
    const tree = await getTree(owner, repo, commit.commit.tree.sha, token);
    return { owner, repo, repositoryId: meta.id as number | undefined, branch: selectedBranch as string, latestCommitSha: commit.sha as string, commitMessage: commit.commit.message as string, commitAuthor: commit.commit.author?.name || 'Unknown', commitDate: commit.commit.author?.date || new Date().toISOString(), tree, repoMeta: { description: meta.description || '', stars: meta.stargazers_count || 0, forks: meta.forks_count || 0, language: meta.language || 'Unknown', updatedAt: meta.updated_at, htmlUrl: meta.html_url } };
  },

  async listHistory(target: { id?: number; owner: string; repo: string; branch: string }, token: string, page = 1) {
    const identity = await githubClient.repository(target.owner, target.repo, token, target.id);
    const entries = await json(`${root(identity.owner, identity.repo)}/commits?sha=${encodeURIComponent(target.branch)}&per_page=30&page=${page}`, token, { cache: 'no-store' });
    return entries.map((item: any) => ({ sha: item.sha as string, message: item.commit.message as string, author: item.commit.author?.name || 'Unknown', date: item.commit.author?.date || '', htmlUrl: item.html_url as string }));
  },

  async ensurePrivateRepo(token: string, repoName: string, description?: string, remark?: string) {
    const user = await json('/user', token);
    const name = repoName.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('请输入有效仓库名称');
    const composed = [description?.trim(), remark ? `[备注: ${remark.trim()}]` : '', '[GitVault 托管]'].filter(Boolean).join(' ').slice(0, 350);
    try {
      const existing = await json(root(user.login, name), token);
      if (!existing.private) throw new Error('目标仓库已存在且为公开仓库，请选择其他名称或使用指定仓库上传');
      return { id: existing.id as number | undefined, owner: user.login, repo: existing.name, defaultBranch: existing.default_branch, htmlUrl: existing.html_url, alreadyExisted: true };
    } catch (error) { if (!(error instanceof GitHubError) || error.status !== 404) throw error; }
    const created = await json('/user/repos', token, body('POST', { name, description: composed, private: true, auto_init: true }));
    return { id: created.id as number | undefined, owner: user.login, repo: created.name, defaultBranch: created.default_branch || 'main', htmlUrl: created.html_url, alreadyExisted: false };
  },

  async push(targetOwner: string, targetRepo: string, targetBranch: string, token: string, files: CachedFile[], commitMessage: string, description?: string, remark?: string, originalSourceUrl?: string, options: { rebaseOnConflict?: boolean; expectedRepoId?: number } = {}) {
    const signal = operationSignal();
    return measureTransfer({action:'上传',project:`${targetOwner}/${targetRepo}`,branch:targetBranch,target:`${targetOwner}/${targetRepo}:${targetBranch}`,mode:gitServiceConfig().mode,signal}, async trace => {
    await confirmFolderUpload(files,signal);signal.throwIfAborted();
    const base = root(targetOwner, targetRepo);
    const identity = await githubClient.repository(targetOwner, targetRepo, token, options.expectedRepoId, signal);
    const meta = { id: identity.id, default_branch: identity.defaultBranch };
    const branch = targetBranch || meta.default_branch || 'main';
    trace.branch(branch);
    const refUrl = `${base}/git/ref/heads/${refPath(branch)}`;
    const readHead = async () => (await json(refUrl, token, { cache: 'no-store' }, signal)).object.sha as string;
    const conflict = (latest: string) => new Error(`目标分支 ${targetOwner}/${targetRepo}:${branch} 在上传期间已变化（${parent.slice(0, 7) || '未创建'} → ${latest.slice(0, 7)}），本次未强制覆盖；本地文件已保留。请重新读取目标分支后重试，或上传到新分支。`);
    let parent = '';
    try { parent = await readHead(); }
    catch (error) { if (!(error instanceof GitHubError) || error.status !== 404 && error.status !== 409) throw error; }
    trace.phase('准备上传文件');
    const localFiles=hasLocalFolderChanges(files)?files.map(({path,sha,mode,size})=>({path,sha:sha!,mode:mode||'100644',size,type:'blob' as const})):undefined;
    const allFiles = [...files];
    if (description || remark || originalSourceUrl) {
      // Preserve a source project file with this name rather than silently overwriting it.
      if (!allFiles.some(f => f.path === 'GITVAULT_METADATA.md')) allFiles.push({ path: 'GITVAULT_METADATA.md', content: [`# ${targetRepo}`, description || '', remark || '', originalSourceUrl || '', sourceMarker(originalSourceUrl)].filter(Boolean).join('\n\n'), isBase64: false });
    }
    const paths = new Set<string>();
    for (const file of allFiles) {
      if (!file.path || file.path.startsWith('/') || file.path.split('/').some(p => p === '..' || !p) || paths.has(file.path)) throw new Error(`无效或重复的文件路径: ${file.path}`);
      paths.add(file.path);
    }
    if (gitServiceConfig().mode !== 'rest') {
      if (!Number.isSafeInteger(identity.id) || !identity.id || identity.id <= 0) throw new Error('目标仓库缺少可信 ID，未开始 Git 推送');
      progress(`正在通过 Git 推送 ${allFiles.length} 个文件到 ${targetOwner}/${targetRepo}:${branch}…`);
      const prepared: CachedFile[] = [];
      for (const file of allFiles) {
        signal.throwIfAborted();
        prepared.push({ ...file, sha: file.nativeRef ? file.sha : (await verifiedBlobSha(file,signal)).sha });
      }
      trace.phase('原生暂存与 Git 推送（含排队等待）');
      const result = await gitServiceTransfer('push', { owner: identity.owner, repo: identity.repo, expectedRepoId: identity.id, branch, files: prepared, message: commitMessage, rebaseOnConflict: !!options.rebaseOnConflict }, token, signal);
      trace.native(result.timings);trace.phase('验证目标提交与分支');
      if (!result.verified || result.repoId !== identity.id || result.branch !== branch || !/^[a-f0-9]{40}$/.test(result.commitSha) || !/^[a-f0-9]{40}$/.test(result.treeSha)) throw new Error('Git 推送回执无效，本地缓存已保留');
      const committed = await json(`${base}/git/commits/${result.commitSha}`, token, { cache: 'no-store' }, signal);
      const tree = await getTree(targetOwner, targetRepo, result.treeSha, token, signal);
      const blobs = tree.filter(item => item.type === 'blob'), expected = new Map(prepared.map(file => [file.path, file]));
      if (committed.tree.sha !== result.treeSha || blobs.length !== prepared.length || tree.some(item => item.type === 'commit') || blobs.some(item => item.sha !== expected.get(item.path)?.sha || item.mode !== (expected.get(item.path)?.mode || '100644')) || await readHead() !== result.commitSha) throw new Error('Git 推送后的文件或分支校验失败，本地缓存已保留，请检查目标最新提交');
      return { success: true, verified: true, repoPrivate: identity.private as boolean | undefined, repoId: identity.id, commitSha: result.commitSha as string, treeSha: result.treeSha as string, branch, owner: targetOwner, repo: targetRepo, htmlUrl: `https://github.com/${targetOwner}/${targetRepo}/tree/${branch}`, uploadedFilesCount: files.length, ...(localFiles?{localFiles}:{}) };
    }
    trace.phase('比较目标并合并上传文件（含排队等待）');
    let parentTree = '';
    const existing = new Map<string, RepoEntry>();
    if (parent) {
      const commit = await json(`${base}/git/commits/${parent}`, token);
      parentTree = commit.tree.sha;
      for (const item of await getTree(targetOwner, targetRepo, commit.tree.sha, token)) existing.set(item.path, item);
    }
    let done = 0;
    const checkpointId = meta.id || 0;
    const checkpoints = typeof indexedDB !== 'undefined' && Number.isSafeInteger(checkpointId) && checkpointId > 0 ? uploadCache : undefined;
    const acknowledged = checkpoints ? await checkpoints.load(checkpointId) : new Set<string>();
    const verifiedBlobs = new Set([...existing.values()].filter(item => item.type === 'blob').map(item => item.sha));
    const writeObject = async (kind: 'blobs' | 'trees', hash: string, payload: unknown) => {
      for (let attempt = 0; ; attempt++) {
        try { return await json(`${base}/git/${kind}`, token, body('POST', payload), signal); }
        catch (error) {
          signal.throwIfAborted();
          if (!temporaryConnectionFailure(error)) throw error;
          // Content-addressed objects can be recovered by their expected SHA.
          // An unreadable remote is never treated as an absent object.
          try {
            const remote = await json(`${base}/git/${kind}/${hash}`, token, { cache: 'no-store' }, signal);
            if (remote.sha !== hash || kind === 'blobs' && await gitBlobSha(bytesFromBase64(remote.content)) !== hash) throw new Error('恢复上传时远程对象校验失败，本地文件已保留');
            return remote;
          } catch (lookupError) {
            signal.throwIfAborted();
            if (!(lookupError instanceof GitHubError) || lookupError.status !== 404) throw lookupError;
          }
          if (attempt >= 2) throw error;
          await waitForUploadRecovery(attempt, signal);
          await githubClient.repository(targetOwner, targetRepo, token, identity.id, signal);
        }
      }
    };
    let inlineBudget = 2 * 1024 * 1024, inlineCount = 0;
    let pendingText: Array<{item: {path:string;mode:string;type:string;content?:string;sha?:string}; sha:string}> = [];
    const flushText = async () => {
      if (!pendingText.length) return;
      progress(`正在合并上传 ${pendingText.length} 个文本文件…`);
      const hashes = pendingText.map(entry=>({path:entry.item.path,mode:entry.item.mode,sha:entry.sha}));
      const expectedTree = await gitTreeSha(hashes);
      const result = await writeObject('trees', expectedTree, {tree:pendingText.map(entry=>entry.item)});
      if (result.sha !== expectedTree) throw new Error('文本批次文件树校验失败，未更新目标分支；本地文件已保留');
      if (checkpoints) await checkpoints.saveBatch(checkpointId,hashes.map(entry=>entry.sha));
      for (const entry of pendingText) { delete entry.item.content; entry.item.sha=entry.sha; verifiedBlobs.add(entry.sha); }
      pendingText=[];inlineBudget=2*1024*1024;
    };
    const expectedFiles: Array<{path:string;mode:string;sha:string}> = [];
    const treeItems = await mapConcurrent(allFiles, 1, async file => {
      signal.throwIfAborted();
      file=await hydrateFile(file,Infinity,signal);
      const hash = (await verifiedBlobSha(file,signal)).sha;
      expectedFiles.push({path:file.path,mode:file.mode || '100644',sha:hash});
      const old = existing.get(file.path);
      let sha = hash;
      // Small UTF-8 sources can be created in one tree request. Binary and large
      // files retain verified blob checkpoints. Never send both content and sha.
      const inlineSize = new TextEncoder().encode(JSON.stringify(file.content)).length;
      if (allFiles.length >= 4 && !file.isBase64 && old?.sha !== hash && !verifiedBlobs.has(hash) && inlineSize <= 512 * 1024 && !acknowledged.has(hash)) {
        if (inlineSize > inlineBudget) await flushText();
        inlineBudget -= inlineSize; inlineCount++;
        progress(`正在合并文本文件 ${++done}/${allFiles.length}：${file.path}`);
        const item = {path:file.path,mode:file.mode || '100644',type:'blob',content:file.content};
        pendingText.push({item,sha:hash});return item;
      }
      if (old?.sha !== hash && !verifiedBlobs.has(hash)) {
        let reusable = false;
        if (acknowledged.has(hash)) {
          try {
            const blob = await json(`${base}/git/blobs/${hash}`, token, { cache: 'no-store' }, signal);
            const remote = bytesFromBase64(blob.content);
            reusable = await gitBlobSha(remote) === hash;
          } catch (error) { if (!(error instanceof GitHubError) || error.status !== 404) throw error; }
        }
        if (!reusable) {
          const blob = await writeObject('blobs', hash, { content: file.content, encoding: file.isBase64 ? 'base64' : 'utf-8' });
          sha = blob.sha;
          if (sha !== hash) throw new Error(`上传文件校验失败: ${file.path}`);
          if (checkpoints) await checkpoints.save(checkpointId, hash);
        }
        verifiedBlobs.add(hash);
      }
      progress(`正在上传并校验 ${++done}/${allFiles.length}：${file.path}`);
      return { path: file.path, mode: file.mode || '100644', type: 'blob', sha };
    });
    // No content changed: verify the same target head and avoid even a tree
    // mutation. This also avoids consuming write budget for repeated uploads.
    if (parent && ![...existing.values()].some(item => item.type === 'commit') && expectedFiles.length === [...existing.values()].filter(item => item.type === 'blob').length && expectedFiles.every(file => existing.get(file.path)?.sha === file.sha && existing.get(file.path)?.mode === file.mode) && await readHead() === parent) {
      progress('目标分支内容一致，已跳过重复上传');
      return { success: true, verified: true, unchanged: true, repoPrivate: identity.private as boolean | undefined, repoId: meta.id as number | undefined, commitSha: parent, treeSha: parentTree, branch, owner: targetOwner, repo: targetRepo, htmlUrl: `https://github.com/${targetOwner}/${targetRepo}/tree/${branch}`, uploadedFilesCount: 0, ...(localFiles?{localFiles}:{}) };
    }
    trace.phase('生成提交并验证目标分支');
    // Build an exact snapshot. Omitting base_tree applies source deletions as well.
    let treeSha: string;
    if (treeItems.length) treeSha = (await writeObject('trees', await gitTreeSha(expectedFiles), { tree: treeItems })).sha;
    else {
      // Git's well-known empty tree supports legitimate empty source commits.
      treeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    }
    if (inlineCount && treeSha !== await gitTreeSha(expectedFiles)) throw new Error('合并上传后的文件树哈希不一致，未更新目标分支；本地文件已保留');
    let expectedParent = parent;
    for (let attempt = 0; attempt < (options.rebaseOnConflict ? 3 : 1); attempt++) {
      signal.throwIfAborted();
      const commit = expectedParent && parentTree === treeSha ? { sha: expectedParent } : await json(`${base}/git/commits`, token, body('POST', { message: commitMessage || 'Sync complete project snapshot via GitVault', tree: treeSha, parents: expectedParent ? [expectedParent] : [] }), signal);
      let moved = '';
      for (let writeAttempt = 0; ; writeAttempt++) { try {
        if (expectedParent) {
          const current = await readHead();
          if (current !== expectedParent && current !== commit.sha) moved = current;
          else if (current !== commit.sha) await json(`${base}/git/refs/heads/${refPath(branch)}`, token, body('PATCH', { sha: commit.sha, force: false }), signal);
        } else await json(`${base}/git/refs`, token, body('POST', { ref: `refs/heads/${branch}`, sha: commit.sha }), signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof GitHubError && error.status < 500 && ![408, 409, 422].includes(error.status)) throw error;
        let actual: string;
        try { actual = await readHead(); } catch (lookupError) { signal.throwIfAborted(); if (!expectedParent && lookupError instanceof GitHubError && lookupError.status === 404) actual = ''; else throw lookupError; }
        if (actual !== commit.sha) {
          if (actual !== expectedParent) moved = actual;
          else if (error instanceof GitHubError && error.status === 422 && /fast.forward/i.test(error.message)) throw new GitHubError(`${error.message}；目标分支 ${branch} 拒绝非快进更新，本地源码已保留。请重新读取目标版本后重试，或选择新分支；不会强制覆盖远程历史。`, error.status);
          else if (temporaryConnectionFailure(error) && writeAttempt < 2) {
            await waitForUploadRecovery(writeAttempt, signal);
            await githubClient.repository(targetOwner, targetRepo, token, identity.id, signal);
            continue;
          }
          else throw error;
        }
      } break; }
      if (!moved) {
        progress('正在验证目标提交和分支…');
        const verifiedHead = await readHead();
        const verifiedCommit = await json(`${base}/git/commits/${commit.sha}`, token, {}, signal);
        if (verifiedCommit.tree.sha !== treeSha) throw new Error('上传后的远程版本验证未通过；本地文件已保留，请重新检查');
        if (verifiedHead === commit.sha) return { success: true, verified: true, repoPrivate: identity.private as boolean | undefined, repoId: meta.id as number | undefined, commitSha: commit.sha, treeSha, branch, owner: targetOwner, repo: targetRepo, htmlUrl: `https://github.com/${targetOwner}/${targetRepo}/tree/${branch}`, uploadedFilesCount: files.length, ...(localFiles?{localFiles}:{}) };
        // Do not replay after our commit landed and another writer subsequently changed it.
        throw new Error('上传后的分支已被其他提交修改，验证未通过；本地文件已保留，请重新检查');
      }
      if (!options.rebaseOnConflict || attempt === 2) throw conflict(moved);
      expectedParent = moved;
      parentTree = (await json(`${base}/git/commits/${moved}`, token, {}, signal)).tree.sha;
      progress('目标分支出现新提交，正在接续最新历史创建覆盖更新…');
    }
    throw new Error('目标分支持续变化，已停止重试并保留本地文件');
    });
  },

  async fetchBranches(url: string, token?: string, signal?: AbortSignal): Promise<string[]> {
    const { owner, repo } = parseRepository(url);
    // Branch lookup is independent of any cancelled download/upload operation.
    const lookupSignal = signal || new AbortController().signal;
    const lookup = async (path: string) => (await request(path, token, {}, lookupSignal, 20000)).json();
    try {
      const meta = await lookup(root(owner, repo));
      const names = new Set<string>();
      for (let page = 1; ; page++) {
        const data = await lookup(`${root(owner, repo)}/branches?per_page=100&page=${page}`);
        if (!Array.isArray(data)) throw new Error('GitHub 返回的分支列表格式异常，请重试');
        for (const branch of data) if (typeof branch.name === 'string') names.add(branch.name);
        if (data.length < 100) break;
      }
      if (!names.size) throw new Error('仓库暂无分支，请确认仓库已经创建首次提交');
      return [...names].sort((a, b) => a === meta.default_branch ? -1 : b === meta.default_branch ? 1 : a.localeCompare(b));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if ((error as Error).name === 'TimeoutError') throw new Error('获取分支超时（20 秒），请检查 GitHub API 连接后重试');
      if (error instanceof GitHubError && error.status === 401) throw new Error('GitHub Token 无效或已过期。公开仓库可清空专属及全局 Token 后重试；私有仓库请更换有效 Token');
      if (error instanceof GitHubError && error.status === 404) throw new Error('仓库不存在，或当前 Token 没有访问此私有仓库的权限');
      if (error instanceof TypeError) throw new Error('无法连接 GitHub 分支接口，请检查网络连接后重试');
      throw error;
    }
  },

  async createFork(url: string, token: string, newRepoName?: string) {
    const { owner, repo } = parseRepository(url);
    const source = await json(root(owner, repo), token);
    const user = await json('/user', token);
    if (owner.toLowerCase() === user.login.toLowerCase()) throw new Error('不能在同一个账号下 Fork 自己的仓库，请使用“当前分支独立副本”或指定其他账号');
    const branches = await githubClient.fetchBranches(`${owner}/${repo}`, token, operationSignal());
    const requestedName = newRepoName?.trim() || repo;
    let fork: any;
    try {
      fork = await json(root(user.login, requestedName), token, { cache: 'no-store' });
      if (!fork.fork || fork.parent?.id !== source.id) throw new Error('目标名称已被其他仓库占用，请更换名称；未修改已有仓库');
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      fork = await json(`${root(owner, repo)}/forks`, token, body('POST', { name: requestedName, default_branch_only: false }));
    }
    const forkOwner = fork.owner.login;
    const forkName = fork.name;
    for (let attempt = 0; attempt < 30; attempt++) {
      operationSignal().throwIfAborted();
      progress(`正在验证完整分叉的 ${branches.length} 个分支（${attempt + 1}/30）…`);
      try {
        const current = await json(root(forkOwner, forkName), token, { cache: 'no-store' });
        if (!current.fork || current.parent?.id !== source.id) throw new Error('分叉来源身份校验失败');
        let found = await githubClient.fetchBranches(`${forkOwner}/${forkName}`, token, operationSignal());
        for (const missing of branches.filter(branch => !found.includes(branch))) {
          const sourceCommit = await json(`${root(owner, repo)}/commits/${encodeURIComponent(missing)}`, token);
          try { await json(`${root(forkOwner, forkName)}/git/refs`, token, body('POST', { ref: `refs/heads/${missing}`, sha: sourceCommit.sha })); }
          catch (error) { if (!(error instanceof GitHubError) || ![404, 409, 422].includes(error.status)) throw error; }
        }
        if (!branches.every(branch => found.includes(branch))) found = await githubClient.fetchBranches(`${forkOwner}/${forkName}`, token, operationSignal());
        if (branches.every(branch => found.includes(branch))) return { id: current.id as number, owner: forkOwner, repo: forkName, htmlUrl: current.html_url as string, defaultBranch: source.default_branch as string, branches: found, full_name: current.full_name as string, verified: true };
      } catch (error) {
        if (!(error instanceof GitHubError) || ![404, 409].includes(error.status)) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const signal = operationSignal();
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error(`分叉仍在创建或缺少分支，请稍后重试以关联已有 Fork：https://github.com/${forkOwner}/${forkName}`);
  },

  async syncAllForkBranches(owner: string, repo: string, token: string, onBranch?: (result: { branch: string; success: boolean; error?: string; sourceSha?: string; commitSha?: string; nativeVersion?:string }) => void) {
    const meta = await json(root(owner, repo), token);
    if (!meta.fork || !meta.parent) throw new Error('目标不是 Fork');
    const sourceOwner = meta.parent.owner.login;
    const sourceRepo = meta.parent.name;
    const branches = await githubClient.fetchBranches(`${sourceOwner}/${sourceRepo}`, token, operationSignal());
    const results: Array<{ branch: string; success: boolean; error?: string; sourceSha?: string; commitSha?: string; nativeVersion?:string }> = [];
    for (const branch of branches) {
      operationSignal().throwIfAborted();
      progress(`正在同步分支 ${branch}（${results.length + 1}/${branches.length}）…`);
      try {
        const upstream=await json(`${root(sourceOwner,sourceRepo)}/commits/${encodeURIComponent(branch)}`,token);
        let destination;
        try{destination=await json(`${root(owner,repo)}/commits/${encodeURIComponent(branch)}`,token,{cache:'no-store'});}
        catch(error){if(!(error instanceof GitHubError)||![404,409,422].includes(error.status)||error.status===422&&!/No commit found for SHA:/i.test(error.message))throw error;}
        if(destination?.commit?.tree?.sha&&destination.commit.tree.sha===upstream.commit.tree.sha){
          await githubClient.repository(owner,repo,token,meta.id);
          const latest=await json(`${root(owner,repo)}/commits/${encodeURIComponent(branch)}`,token,{cache:'no-store'});
          if(latest.sha!==destination.sha)throw new Error('分支在比较期间已变化，请重试；未写入远端');
          progress(`分支 ${branch} 文件内容一致，跳过下载和上传`);
          results.push({branch,success:true,sourceSha:upstream.sha,commitSha:destination.sha});onBranch?.(results[results.length-1]);continue;
        }
        const snapshot = await githubClient.fetchRepo(`${sourceOwner}/${sourceRepo}`, branch, token,{ref:upstream.sha});
        const uploaded = await githubClient.push(owner, repo, branch, token, snapshot.files, `Sync upstream ${sourceOwner}/${sourceRepo}:${branch} @ ${snapshot.latestCommitSha}`, undefined, undefined, undefined, { rebaseOnConflict: true, expectedRepoId: meta.id });
        if (typeof indexedDB !== 'undefined') await transferCache.clear(snapshot.latestCommitSha);
        results.push({ branch, success: true, sourceSha: snapshot.latestCommitSha, commitSha: uploaded.commitSha, ...(snapshot.files.nativeSnapshot?{nativeVersion:snapshot.files.nativeSnapshot.version}:{}) });
      } catch (error) { results.push({ branch, success: false, error: (error as Error).message }); }
      onBranch?.(results[results.length - 1]);
    }
    return results;
  },

  async syncFork(owner: string, repo: string, branch: string, token: string) {
    const meta = await json(root(owner, repo), token);
    if (!meta.fork || !meta.parent) throw new Error('目标仓库不是 Fork，无法同步上游');
    const result = await json(`${root(owner, repo)}/merge-upstream`, token, body('POST', { branch: branch || meta.default_branch }));
    return { success: true, message: result.message || '同步成功' };
  },

  async release(owner: string, repo: string, tagName: string, releaseName: string, releaseBody: string, token: string, commitSha?: string) {
    if (!commitSha) throw new Error('缺少归档版本提交 SHA，不能发布到不确定的版本');
    // Resolve existing tags before creating a release: target_commitish is ignored for existing tags.
    try {
      let tag = await json(`${root(owner, repo)}/git/ref/tags/${refPath(tagName)}`, token);
      while (tag.object.type === 'tag') tag = { object: await json(`${root(owner, repo)}/git/tags/${tag.object.sha}`, token).then(t => t.object) };
      if (tag.object.sha !== commitSha) throw new Error('该标签已指向其他版本，请更换标签名称');
    } catch (error) { if (!(error instanceof GitHubError) || error.status !== 404) throw error; }
    let release;
    try {
      release = await json(`${root(owner, repo)}/releases`, token, body('POST', { tag_name: tagName, name: releaseName || tagName, body: releaseBody, target_commitish: commitSha, draft: false, prerelease: false }));
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      // A previous attempt may have succeeded before the app stopped. Verify the
      // tag again (including annotated tags) before accepting an existing Release.
      let tag = await json(`${root(owner, repo)}/git/ref/tags/${refPath(tagName)}`, token);
      while (tag.object.type === 'tag') tag = { object: await json(`${root(owner, repo)}/git/tags/${tag.object.sha}`, token).then(value => value.object) };
      if (tag.object.sha !== commitSha) throw new Error('该标签已指向其他版本，请更换标签名称');
      release = await json(`${root(owner, repo)}/releases/tags/${refPath(tagName)}`, token);
      if (release.tag_name !== tagName) throw new Error('已有 Release 标签不一致，未标记成功');
    }
    return { success: true, releaseUrl: release.html_url, tagName: release.tag_name };
  },
};
