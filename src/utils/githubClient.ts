import { gitBlobSha } from './gitFiles';
export { gitBlobSha } from './gitFiles';
import { transferCache } from './localCache';
import type { CachedFile } from './localCache';
import type { TargetHealth, TargetIdentity } from './targetLifecycle';

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

let operation = new AbortController();
export function beginGithubOperation() { operation = new AbortController(); }
export function cancelGithubOperation() { operation.abort(); }
export function operationSignal() { return operation.signal; }
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
export class GitHubError extends Error {
  constructor(message: string, public status: number, public rateLimited = false) { super(message); }
}
export class TargetRepositoryError extends GitHubError {
  constructor(public health: TargetHealth, status: number) { super(health.message, status, health.status === 'limited'); }
}
let repositoryCheckSequence = 0;
function targetHealthEvent(target: TargetIdentity, health: TargetHealth, checkId: number, identity?: { id?: number; owner: string; repo: string; htmlUrl: string }) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gitvault-target-health', { detail: { target, health, identity, checkId } }));
}

// All requests have a deadline, including reading the response body. Mutations are never retried blindly.
async function request(path: string, token?: string, init: RequestInit = {}, signal = operation.signal, timeout = 45000): Promise<Response> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('GitHub 请求超时，请重试', 'TimeoutError')), timeout);
  try {
    const response = await fetch(path.startsWith('https://') ? path : `https://api.github.com${path}`, {
      ...init, headers: { ...headers(token), ...init.headers }, signal: controller.signal,
    });
    // Consume inside the deadline; callers can safely parse the buffered response.
    const body = await response.arrayBuffer();
    if (!response.ok) {
      let message = new TextDecoder().decode(body);
      try { message = JSON.parse(message).message || message; } catch { /* non-JSON error */ }
      if (response.status === 403 || response.status === 429) {
        const reset = response.headers.get('x-ratelimit-reset');
        message += reset ? `；请求受限，可在 ${new Date(Number(reset) * 1000).toLocaleTimeString()} 后重试` : '；请检查访问权限或稍后重试';
      }
      throw new GitHubError(`GitHub (${response.status}): ${message.slice(0, 350)}`, response.status, response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || !!response.headers.get('retry-after') || /rate limit|secondary limit/i.test(message));
    }
    return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
async function json(path: string, token?: string, init: RequestInit = {}, signal?: AbortSignal) {
  const response = await request(path, token, init, signal);
  return response.status === 204 ? {} : response.json();
}
export const githubApi = json;
function body(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
const root = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
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
      catch (e) { if (!(e instanceof GitHubError) || e.status !== 404) throw e; }
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
  if (await gitBlobSha(bytes) !== entry.sha) throw new Error(`文件校验失败: ${entry.path}`);
  let content: string;
  let isBase64 = false;
  try {
    if (bytes.includes(0)) throw new Error('binary');
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // A BOM must survive a round trip as well.
    if (new TextEncoder().encode(content).length !== bytes.length) throw new Error('encoding');
  } catch { content = base64FromBytes(bytes); isBase64 = true; }
  return { path: entry.path, content, isBase64, sha: entry.sha, mode: entry.mode, size: bytes.length };
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
    const signal = options.signal || operation.signal;
    const { owner, repo, linkedRef } = parseRepository(url);
    progress('正在识别仓库和分支…', options);
    const meta = await json(root(owner, repo), token, {}, signal);
    const ref = options.ref || await resolveRef(owner, repo, linkedRef, branch, token, signal) || meta.default_branch;
    const commit = await json(`${root(owner, repo)}/commits/${encodeURIComponent(ref)}`, token, {}, signal);
    const tree = await getTree(owner, repo, commit.commit.tree.sha, token, signal);
    // ZIPs do not include submodule contents. Never claim those projects are completely cached.
    if (tree.some(item => item.type === 'commit')) throw new Error('项目包含 Git 子模块，需要单独获取子模块内容；本次未标记为完整下载');
    const entries = tree.filter(item => item.type === 'blob');
    const checkpoint = typeof window !== 'undefined' && typeof indexedDB !== 'undefined' ? transferCache : undefined;
    const transfer = `${owner}/${repo}@${commit.sha}`;
    const resumed = checkpoint ? await checkpoint.load(transfer) : [];
    const previous = new Map([...resumed, ...(options.cachedFiles || [])].map(f => [f.path, f]));
    const files = new Map<string, CachedFile>();
    let done = 0;
    const missing: RepoEntry[] = [];
    for (const entry of entries) {
      const old = previous.get(entry.path);
      if (old?.sha === entry.sha) { files.set(entry.path, { ...old, mode: entry.mode }); done++; }
      else missing.push(entry);
    }
    // A large initial import is cheaper as one archive; each downloaded blob is still verified.
    // Browser archive redirects can fail CORS, so each channel has its own catch/deadline.
    if (missing.length > 12) {
      const archiveUrls = [`https://api.github.com${root(owner, repo)}/zipball/${commit.sha}`];
      if (!token) archiveUrls.push(`https://codeload.github.com/${owner}/${repo}/zip/${commit.sha}`);
      for (const archiveUrl of archiveUrls) {
        signal.throwIfAborted();
        try {
          progress(`正在下载完整压缩包（${entries.length} 个文件）…`, options);
          const response = await request(archiveUrl, token, {}, signal, 30000);
          const { default: JSZip } = await import('jszip');
          const zip = await JSZip.loadAsync(await response.arrayBuffer());
          const prefix = Object.keys(zip.files)[0]?.split('/')[0] + '/';
          for (const entry of missing) {
            signal.throwIfAborted();
            const item = zip.file(prefix + entry.path);
            if (!item) throw new Error(`压缩包缺少文件: ${entry.path}`);
            const bytes = await item.async('uint8array');
            const file = await cachedFile(entry, bytes);
            if (checkpoint) await checkpoint.save(transfer, commit.sha, file);
            files.set(entry.path, file);
            progress(`正在校验并解压 ${++done}/${entries.length}：${entry.path}`, options);
            if (done % 25 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          }
          break;
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          // Reuse verified entries even when an archive was only partially usable.
          done = files.size;
          progress('压缩包不可用，正在切换逐文件下载…', options);
        }
      }
    }
    await mapConcurrent(missing.filter(e => !files.has(e.path)), 5, async entry => {
      signal.throwIfAborted();
      const data = await json(`${root(owner, repo)}/git/blobs/${entry.sha}`, token, {}, signal);
      const bytes = bytesFromBase64(data.content);
      const file = await cachedFile(entry, bytes);
      if (checkpoint) await checkpoint.save(transfer, commit.sha, file);
      files.set(entry.path, file);
      progress(`正在下载并校验 ${++done}/${entries.length}：${entry.path}`, options);
    });
    if (files.size !== entries.length) throw new Error('文件下载不完整，已保留原版本，请重试');
    // LFS pointer files are project files, but not the binary objects they reference.
    const lfsPointers = [...files.values()].filter(f => !f.isBase64 && f.content.startsWith('version https://git-lfs.github.com/spec/v1')).map(f => f.path);
    if (lfsPointers.length) throw new Error(`项目包含 Git LFS 文件（${lfsPointers.slice(0, 3).join('、')}），当前无法完整保存其大文件内容`);
    progress(`文件已校验 ${files.size}/${entries.length}，正在保存缓存…`, options);
    return {
      owner, repo, repositoryId: meta.id as number | undefined, branch: branch || (linkedRef ? ref : meta.default_branch), latestCommitSha: commit.sha,
      commitMessage: commit.commit.message, commitAuthor: commit.commit.author?.name || 'Unknown', commitDate: commit.commit.author?.date,
      repoMeta: { description: meta.description || '', stars: meta.stargazers_count || 0, forks: meta.forks_count || 0, language: meta.language || 'Unknown', updatedAt: meta.updated_at, htmlUrl: meta.html_url },
      tree, files: entries.map(e => files.get(e.path)!), cachedFilesCount: files.size, isFullyCached: true,
    };
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
    return { hasUpdate: commit.sha !== currentSha, latestSha: commit.sha, latestCommit: { sha: commit.sha, message: commit.commit.message, author: commit.commit.author?.name, date: commit.commit.author?.date } };
  },

  async repository(owner: string, repo: string, token?: string, expectedId?: number, signal = operation.signal) {
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

  async inspectImportTarget(target: { id?: number; owner: string; repo: string; branch: string }, token?: string, forkSource?: { owner: string; repo: string; repositoryId?: number }) {
    const identity = await githubClient.repository(target.owner, target.repo, token, target.id);
    if (forkSource && (forkSource.repositoryId && identity.forkParentId ? forkSource.repositoryId !== identity.forkParentId : identity.forkParent?.toLowerCase() !== `${forkSource.owner}/${forkSource.repo}`.toLowerCase())) throw new Error('目标分叉的上游与来源不一致，不能沿用此同步关系');
    let commit;
    try { commit = await json(`${root(identity.owner, identity.repo)}/commits/${encodeURIComponent(target.branch)}`, token, { cache: 'no-store' }); }
    catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      // A missing ref is safe to create later; an inaccessible repository is not.
      await githubClient.repository(identity.owner, identity.repo, token, identity.id);
      const branches = await githubClient.fetchBranches(identity.htmlUrl, token);
      if (branches.includes(target.branch)) throw error;
      return { identity, commitSha: undefined, tree: [] as RepoEntry[], missingBranch: true };
    }
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
    const signal = operation.signal;
    const base = root(targetOwner, targetRepo);
    const identity = await githubClient.repository(targetOwner, targetRepo, token, options.expectedRepoId, signal);
    const meta = { id: identity.id, default_branch: identity.defaultBranch };
    const branch = targetBranch || meta.default_branch || 'main';
    const refUrl = `${base}/git/ref/heads/${refPath(branch)}`;
    const readHead = async () => (await json(refUrl, token, { cache: 'no-store' }, signal)).object.sha as string;
    const conflict = (latest: string) => new Error(`目标分支 ${targetOwner}/${targetRepo}:${branch} 在上传期间已变化（${parent.slice(0, 7) || '未创建'} → ${latest.slice(0, 7)}），本次未强制覆盖；本地文件已保留。请重新读取目标分支后重试，或上传到新分支。`);
    let parent = '';
    try { parent = await readHead(); }
    catch (error) { if (!(error instanceof GitHubError) || error.status !== 404 && error.status !== 409) throw error; }
    const allFiles = [...files];
    if (description || remark || originalSourceUrl) {
      // Preserve a source project file with this name rather than silently overwriting it.
      if (!allFiles.some(f => f.path === 'GITVAULT_METADATA.md')) allFiles.push({ path: 'GITVAULT_METADATA.md', content: [`# ${targetRepo}`, description || '', remark || '', originalSourceUrl || ''].join('\n\n'), isBase64: false });
    }
    const paths = new Set<string>();
    for (const file of allFiles) {
      if (!file.path || file.path.startsWith('/') || file.path.split('/').some(p => p === '..' || !p) || paths.has(file.path)) throw new Error(`无效或重复的文件路径: ${file.path}`);
      paths.add(file.path);
    }
    let parentTree = '';
    const existing = new Map<string, RepoEntry>();
    if (parent) {
      const commit = await json(`${base}/git/commits/${parent}`, token);
      parentTree = commit.tree.sha;
      for (const item of await getTree(targetOwner, targetRepo, commit.tree.sha, token)) existing.set(item.path, item);
    }
    let done = 0;
    const treeItems = await mapConcurrent(allFiles, 4, async file => {
      const bytes = file.isBase64 ? bytesFromBase64(file.content) : new TextEncoder().encode(file.content);
      const hash = await gitBlobSha(bytes);
      const old = existing.get(file.path);
      let sha = hash;
      if (old?.sha !== hash) {
        const blob = await json(`${base}/git/blobs`, token, body('POST', { content: file.content, encoding: file.isBase64 ? 'base64' : 'utf-8' }));
        sha = blob.sha;
        if (sha !== hash) throw new Error(`上传文件校验失败: ${file.path}`);
      }
      progress(`正在上传并校验 ${++done}/${allFiles.length}：${file.path}`);
      return { path: file.path, mode: file.mode || '100644', type: 'blob', sha };
    });
    // Build an exact snapshot. Omitting base_tree applies source deletions as well.
    let treeSha: string;
    if (treeItems.length) treeSha = (await json(`${base}/git/trees`, token, body('POST', { tree: treeItems }))).sha;
    else {
      // Git's well-known empty tree supports legitimate empty source commits.
      treeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    }
    let expectedParent = parent;
    for (let attempt = 0; attempt < (options.rebaseOnConflict ? 3 : 1); attempt++) {
      signal.throwIfAborted();
      const commit = expectedParent && parentTree === treeSha ? { sha: expectedParent } : await json(`${base}/git/commits`, token, body('POST', { message: commitMessage || 'Sync complete project snapshot via GitVault', tree: treeSha, parents: expectedParent ? [expectedParent] : [] }), signal);
      let moved = '';
      try {
        if (expectedParent) {
          const current = await readHead();
          if (current !== expectedParent && current !== commit.sha) moved = current;
          else if (current !== commit.sha) await json(`${base}/git/refs/heads/${refPath(branch)}`, token, body('PATCH', { sha: commit.sha, force: false }), signal);
        } else await json(`${base}/git/refs`, token, body('POST', { ref: `refs/heads/${branch}`, sha: commit.sha }), signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof GitHubError && error.status < 500 && ![409, 422].includes(error.status)) throw error;
        let actual: string;
        try { actual = await readHead(); } catch { throw error; }
        if (actual !== commit.sha) {
          if (actual !== expectedParent) moved = actual;
          else if (error instanceof GitHubError && error.status === 422 && /fast.forward/i.test(error.message)) throw new GitHubError(`${error.message}；目标分支 ${branch} 拒绝非快进更新，本地源码已保留。请重新读取目标版本后重试，或选择新分支；不会强制覆盖远程历史。`, error.status);
          else throw error;
        }
      }
      if (!moved) {
        progress('正在验证目标提交和分支…');
        const verifiedHead = await readHead();
        const verifiedCommit = await json(`${base}/git/commits/${commit.sha}`, token, {}, signal);
        if (verifiedCommit.tree.sha !== treeSha) throw new Error('上传后的远程版本验证未通过；本地文件已保留，请重新检查');
        if (verifiedHead === commit.sha) return { success: true, verified: true, repoPrivate: identity.private as boolean | undefined, repoId: meta.id as number | undefined, commitSha: commit.sha, treeSha, branch, owner: targetOwner, repo: targetRepo, htmlUrl: `https://github.com/${targetOwner}/${targetRepo}/tree/${branch}`, uploadedFilesCount: files.length };
        // Do not replay after our commit landed and another writer subsequently changed it.
        throw new Error('上传后的分支已被其他提交修改，验证未通过；本地文件已保留，请重新检查');
      }
      if (!options.rebaseOnConflict || attempt === 2) throw conflict(moved);
      expectedParent = moved;
      parentTree = (await json(`${base}/git/commits/${moved}`, token, {}, signal)).tree.sha;
      progress('目标分支出现新提交，正在接续最新历史创建覆盖更新…');
    }
    throw new Error('目标分支持续变化，已停止重试并保留本地文件');
  },

  async fetchBranches(url: string, token?: string, signal?: AbortSignal): Promise<string[]> {
    const { owner, repo } = parseRepository(url);
    // Branch lookup is independent of any cancelled download/upload operation.
    const deadline = AbortSignal.timeout(20000);
    const lookupSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const meta = await json(root(owner, repo), token, {}, lookupSignal);
      const names = new Set<string>();
      for (let page = 1; ; page++) {
        const data = await json(`${root(owner, repo)}/branches?per_page=100&page=${page}`, token, {}, lookupSignal);
        if (!Array.isArray(data)) throw new Error('GitHub 返回的分支列表格式异常，请重试');
        for (const branch of data) if (typeof branch.name === 'string') names.add(branch.name);
        if (data.length < 100) break;
      }
      if (!names.size) throw new Error('仓库暂无分支，请确认仓库已经创建首次提交');
      return [...names].sort((a, b) => a === meta.default_branch ? -1 : b === meta.default_branch ? 1 : a.localeCompare(b));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (deadline.aborted) throw new Error('获取分支超时（20 秒），请检查 GitHub API 连接后重试');
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
    const branches = await githubClient.fetchBranches(`${owner}/${repo}`, token, operation.signal);
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
      operation.signal.throwIfAborted();
      progress(`正在验证完整分叉的 ${branches.length} 个分支（${attempt + 1}/30）…`);
      try {
        const current = await json(root(forkOwner, forkName), token, { cache: 'no-store' });
        if (!current.fork || current.parent?.id !== source.id) throw new Error('分叉来源身份校验失败');
        let found = await githubClient.fetchBranches(`${forkOwner}/${forkName}`, token, operation.signal);
        for (const missing of branches.filter(branch => !found.includes(branch))) {
          const sourceCommit = await json(`${root(owner, repo)}/commits/${encodeURIComponent(missing)}`, token);
          try { await json(`${root(forkOwner, forkName)}/git/refs`, token, body('POST', { ref: `refs/heads/${missing}`, sha: sourceCommit.sha })); }
          catch (error) { if (!(error instanceof GitHubError) || ![404, 409, 422].includes(error.status)) throw error; }
        }
        if (!branches.every(branch => found.includes(branch))) found = await githubClient.fetchBranches(`${forkOwner}/${forkName}`, token, operation.signal);
        if (branches.every(branch => found.includes(branch))) return { id: current.id as number, owner: forkOwner, repo: forkName, htmlUrl: current.html_url as string, defaultBranch: source.default_branch as string, branches: found, full_name: current.full_name as string, verified: true };
      } catch (error) {
        if (!(error instanceof GitHubError) || ![404, 409].includes(error.status)) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const signal = operation.signal;
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error(`分叉仍在创建或缺少分支，请稍后重试以关联已有 Fork：https://github.com/${forkOwner}/${forkName}`);
  },

  async syncAllForkBranches(owner: string, repo: string, token: string, onBranch?: (result: { branch: string; success: boolean; error?: string; sourceSha?: string; commitSha?: string }) => void) {
    const meta = await json(root(owner, repo), token);
    if (!meta.fork || !meta.parent) throw new Error('目标不是 Fork');
    const sourceOwner = meta.parent.owner.login;
    const sourceRepo = meta.parent.name;
    const branches = await githubClient.fetchBranches(`${sourceOwner}/${sourceRepo}`, token, operation.signal);
    const results: Array<{ branch: string; success: boolean; error?: string; sourceSha?: string; commitSha?: string }> = [];
    for (const branch of branches) {
      operation.signal.throwIfAborted();
      progress(`正在同步分支 ${branch}（${results.length + 1}/${branches.length}）…`);
      try {
        const snapshot = await githubClient.fetchRepo(`${sourceOwner}/${sourceRepo}`, branch, token);
        const uploaded = await githubClient.push(owner, repo, branch, token, snapshot.files, `Sync upstream ${sourceOwner}/${sourceRepo}:${branch} @ ${snapshot.latestCommitSha}`, undefined, undefined, undefined, { rebaseOnConflict: true, expectedRepoId: meta.id });
        if (typeof indexedDB !== 'undefined') await transferCache.clear(snapshot.latestCommitSha);
        results.push({ branch, success: true, sourceSha: snapshot.latestCommitSha, commitSha: uploaded.commitSha });
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
