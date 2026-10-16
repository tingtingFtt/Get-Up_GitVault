import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitEngine, GitTransferError, validateIdentity, type GitIdentity } from './gitEngine';

export function createGitRouter(options: { enabled?: boolean; allowedOrigins?: string[]; engine?: ReturnType<typeof createGitEngine>; identity?: (owner: string, repo: string, token: string, signal: AbortSignal) => Promise<GitIdentity> } = {}) {
  const router = express.Router(), engine = options.engine || createGitEngine();
  const enabled = options.enabled ?? process.env.GITVAULT_GIT_ENABLED === '1';
  const allowed = new Set(options.allowedOrigins || (process.env.GITVAULT_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
  let running = 0;
  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      let sameHost = false;
      try { const parsed = new URL(origin); sameHost = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.get('host'); } catch { /* Invalid origin. */ }
      if (!sameHost && !allowed.has(origin)) { res.status(403).json({ error: 'Git 服务未允许此网页来源，请配置 GITVAULT_ALLOWED_ORIGINS' }); return; }
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    if (!enabled) { res.status(503).json({ error: 'Git 服务尚未启用，请设置 GITVAULT_GIT_ENABLED=1' }); return; }
    next();
  });
  router.get('/health', async (_req, res) => {
    try { const result = await promisify(execFile)('git', ['--version'], { timeout: 5000 }); res.json({ service: 'GitVault', version: 1, git: result.stdout.trim(), capabilities: ['fetch', 'push'] }); }
    catch { res.status(503).json({ error: 'Git 服务未安装可用的 Git 命令' }); }
  });
  router.use(express.json({ limit: '150mb' }));
  const identify = options.identity || (async (owner, repo, token, signal) => {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
    const value = await response.json();
    if (!response.ok) throw new GitTransferError(`GitHub 仓库校验失败：${String(value.message || response.status).slice(0, 350)}`, response.status);
    return { id: value.id, owner: value.owner.login, repo: value.name };
  });
  for (const action of ['fetch', 'push'] as const) router.post(`/${action}`, async (req, res) => {
    if (running >= 2) { res.setHeader('Retry-After', '30'); res.status(429).json({ error: 'Git 服务正在处理其他传输，请稍后重试；本地缓存保留' }); return; }
    const token = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '')?.[1];
    if (!token) { res.status(401).json({ error: 'Git 服务传输需要当前 GitHub Token' }); return; }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Git 服务传输超时，本地缓存已保留', 'TimeoutError')), 10 * 60000);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect); running++;
    try {
      const p = req.body || {}, requested = { owner: p.owner, repo: p.repo, id: p.expectedRepoId };
      validateIdentity(requested);
      const identity = await identify(requested.owner, requested.repo, token, controller.signal);
      if (identity.id !== requested.id) throw new GitTransferError('目标仓库 ID 已变化，已停止传输；请重新确认固定目标', 409);
      const verify = async () => { if ((await identify(identity.owner, identity.repo, token, controller.signal)).id !== identity.id) throw new GitTransferError('推送前仓库身份发生变化，已停止写入', 409); };
      const result = action === 'fetch' ? await engine.fetch(identity, p.ref, token, controller.signal)
        : await engine.push(identity, p.branch, token, p.files, p.message, controller.signal, verify, p.rebaseOnConflict === true);
      if (!res.destroyed) res.json({ service: 'GitVault', version: 1, result });
    } catch (error) {
      if (!res.destroyed) res.status(error instanceof GitTransferError ? error.status : controller.signal.aborted ? 408 : 500).json({ error: error instanceof GitTransferError ? error.message : controller.signal.aborted ? 'Git 传输已中断或超时，本地缓存保留' : 'Git 服务未能完成传输，请检查服务状态；本地缓存保留' });
    } finally { clearTimeout(timer); res.off('close', disconnect); running--; }
  });
  router.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? '项目请求超过 Git 服务大小上限' : 'Git 服务请求格式无效' }); });
  return router;
}
