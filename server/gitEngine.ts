import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CachedFile } from '../src/utils/localCache';

export interface GitIdentity { owner: string; repo: string; id: number }
export class GitTransferError extends Error {
  constructor(message: string, public status = 502, public exitCode?: number) { super(message); }
}
const validSegment = (value: unknown) => typeof value === 'string' && /^[\w.-]+$/.test(value) && !/^\.+$/.test(value);
export function validateIdentity(value: GitIdentity) {
  if (!validSegment(value.owner) || !validSegment(value.repo) || !Number.isSafeInteger(value.id) || value.id <= 0) throw new GitTransferError('Git 目标仓库身份无效', 400);
}
export function validatePath(path: string) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[\x00-\x1f\x7f]/.test(part))) throw new GitTransferError('Git 文件路径无效', 400);
}
function scrub(value: string, token: string) {
  for (const secret of [token, Buffer.from(`x-access-token:${token}`).toString('base64')].filter(Boolean)) value = value.split(secret).join('[已隐藏凭证]');
  return value.replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[已隐藏凭证]@').slice(-2500);
}
export function createGitEngine(options: { remote?: (identity: GitIdentity) => string; allowLocal?: boolean; workspaceRoot?: string; maxBytes?: number } = {}) {
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const remote = options.remote || ((identity: GitIdentity) => `https://github.com/${identity.owner}/${identity.repo}.git`);
  async function workspace<T>(identity: GitIdentity, token: string, signal: AbortSignal, task: (git: (args: string[], input?: Buffer | string, limit?: number) => Promise<Buffer>) => Promise<T>) {
    validateIdentity(identity); signal.throwIfAborted();
    const folder = await mkdtemp(join(options.workspaceRoot || tmpdir(), 'gitvault-git-'));
    // Credentials live only in child-process environment, never a URL, config file or argv.
    const config: Record<string, string> = {
      'credential.helper': '', 'core.hooksPath': '/dev/null', 'http.followRedirects': 'false',
      'protocol.allow': 'never', 'protocol.https.allow': 'always',
      ...(options.allowLocal ? { 'protocol.file.allow': 'always' } : {}),
      ...(token ? { 'http.https://github.com/.extraHeader': `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {}),
    };
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_AUTHOR_NAME: 'GitVault', GIT_AUTHOR_EMAIL: 'gitvault@users.noreply.github.com', GIT_COMMITTER_NAME: 'GitVault', GIT_COMMITTER_EMAIL: 'gitvault@users.noreply.github.com', GIT_INDEX_FILE: join(folder, 'snapshot-index'), GIT_CONFIG_COUNT: String(Object.keys(config).length) } as Record<string, string>;
    Object.entries(config).forEach(([key,value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
    const git = (args: string[], input?: Buffer | string, limit = maxBytes * 2): Promise<Buffer> => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn('git', args, { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      const chunks: Buffer[] = []; let length = 0, stderr = '', failure: Error | undefined;
      const stop = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { /* Process already exited. */ } };
      const abort = () => { failure = signal.reason; stop(); };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > limit) { failure = new GitTransferError('Git 项目超过服务传输大小上限', 413); stop(); } else chunks.push(chunk); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
      child.stdin.on('error', () => { /* Git's exit code owns early stdin termination. */ });
      child.on('error', error => { failure = new GitTransferError(`无法启动 Git：${scrub(error.message, token)}`); });
      child.on('close', code => {
        signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new GitTransferError(`Git 操作失败：${scrub(stderr, token)}`, 502, code ?? undefined));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
    try {
      await git(['init', '--bare', '.']); await git(['remote', 'add', 'origin', remote(identity)]);
      return await task(git);
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
  return {
    async fetch(identity: GitIdentity, ref: string, token: string, signal: AbortSignal) {
      if (!/^[a-f0-9]{40}$/.test(ref)) throw new GitTransferError('拉取必须固定到完整提交 SHA', 400);
      return workspace(identity, token, signal, async git => {
        await git(['fetch', '--no-tags', '--depth=1', 'origin', ref]);
        const commitSha = (await git(['rev-parse', 'FETCH_HEAD^{commit}'])).toString().trim();
        if (commitSha !== ref) throw new GitTransferError('Git 拉取提交与选定快照不一致');
        const treeSha = (await git(['rev-parse', `${ref}^{tree}`])).toString().trim();
        const rows = new TextDecoder('utf-8', { fatal: true }).decode(await git(['ls-tree', '-rz', '--full-tree', ref])).split('\0').filter(Boolean);
        const entries = rows.map(row => {
          const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
          if (!match || match[2] !== 'blob') throw new GitTransferError('Git 项目包含暂不支持的子模块，未标记为完整下载', 422);
          validatePath(match[4]); return { mode: match[1], sha: match[3], path: match[4] };
        });
        const packed = await git(['cat-file', '--batch'], entries.map(entry => entry.sha + '\n').join(''), maxBytes + entries.length * 128);
        let offset = 0, total = 0;
        const files = entries.map(entry => {
          const lineEnd = packed.indexOf(10, offset), header = packed.subarray(offset, lineEnd).toString();
          const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
          if (!match || match[1] !== entry.sha) throw new GitTransferError('Git 对象清单验证失败');
          const size = Number(match[2]); offset = lineEnd + 1; const bytes = packed.subarray(offset, offset + size); offset += size + 1; total += size;
          const hash = createHash('sha1').update(`blob ${size}\0`).update(bytes).digest('hex');
          if (total > maxBytes || hash !== entry.sha) throw new GitTransferError('Git 文件内容或大小验证失败', 413);
          if (bytes.subarray(0, 50).toString().startsWith('version https://git-lfs.github.com/spec/v1')) throw new GitTransferError('Git 项目包含 LFS 指针，尚未完整取得大文件', 422);
          return { ...entry, content: bytes.toString('base64'), encoding: 'base64' };
        });
        return { commitSha, treeSha, files };
      });
    },
    async push(identity: GitIdentity, branch: string, token: string, files: CachedFile[], message: string, signal: AbortSignal, verifyIdentity: () => Promise<void> = async () => {}, rebaseOnConflict = false) {
      if (!token) throw new GitTransferError('Git 推送需要 GitHub Token', 401);
      if (typeof branch !== 'string' || !branch || branch.startsWith('-') || /[\x00-\x20\x7f]/.test(branch)) throw new GitTransferError('目标分支名称无效', 400);
      if (!Array.isArray(files)) throw new GitTransferError('缺少完整项目文件', 400);
      return workspace(identity, token, signal, async git => {
        await git(['check-ref-format', `refs/heads/${branch}`]);
        const index: string[] = [], paths = new Set<string>(); let total = 0;
        for (const file of files) {
          signal.throwIfAborted(); validatePath(file.path);
          if (paths.has(file.path) || !['100644','100755','120000'].includes(file.mode || '100644') || typeof file.content !== 'string') throw new GitTransferError('Git 文件路径重复、内容或模式无效', 400);
          paths.add(file.path); const bytes = Buffer.from(file.content, file.isBase64 ? 'base64' : 'utf8'); total += bytes.length;
          if (total > maxBytes) throw new GitTransferError('项目超过 Git 服务大小上限', 413);
          const sha = (await git(['hash-object', '-w', '--stdin'], bytes)).toString().trim();
          if (file.sha && file.sha !== sha) throw new GitTransferError('本地文件与快照校验不一致', 400);
          index.push(`${file.mode || '100644'} ${sha}\t${file.path}\0`);
        }
        await git(['update-index', '-z', '--index-info'], index.join(''));
        const treeSha = (await git(['write-tree'])).toString().trim();
        const head = async () => {
          try { return (await git(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`])).toString().split(/\s/)[0]; }
          catch (error) { if (error instanceof GitTransferError && error.exitCode === 2) return ''; throw error; }
        };
        for (let attempt = 0; attempt < 3; attempt++) {
          const parent = await head();
          if (parent) await git(['fetch', '--no-tags', '--depth=1', 'origin', `refs/heads/${branch}`]);
          // Pin the commit we fetched; a concurrent remote update is handled by normal push rejection.
          const fetched = parent ? (await git(['rev-parse', 'FETCH_HEAD^{commit}'])).toString().trim() : '';
          const oldTree = fetched ? (await git(['rev-parse', `${fetched}^{tree}`])).toString().trim() : '';
          const commitSha = oldTree === treeSha ? fetched : (await git(['commit-tree', treeSha, ...(fetched ? ['-p', fetched] : [])], (message || 'Sync project snapshot via GitVault') + '\n')).toString().trim();
          await verifyIdentity(); signal.throwIfAborted();
          try {
            if (commitSha !== fetched) await git(['push', '--porcelain', 'origin', `${commitSha}:refs/heads/${branch}`]);
          } catch (error) {
            signal.throwIfAborted();
            const actual = await head();
            if (actual !== commitSha) {
              if (actual !== fetched && rebaseOnConflict && attempt < 2) continue;
              throw error;
            }
          }
          if (await head() !== commitSha) throw new GitTransferError('推送后目标分支发生变化，请重新检查；本地文件保留', 409);
          return { commitSha, treeSha, branch, repoId: identity.id, verified: true };
        }
        throw new GitTransferError('目标分支持续变化，请稍后重试；不会强推', 409);
      });
    },
  };
}
