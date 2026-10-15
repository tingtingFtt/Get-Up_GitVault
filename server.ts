import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { githubClient } from './src/utils/githubClient';
dotenv.config({ path: '.env.local' });
dotenv.config();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  const routes: Record<string, (p: any) => Promise<unknown>> = {
    'validate-token': p => githubClient.validateToken(p.token),
    fetch: p => githubClient.fetchRepo(p.url, p.branch, p.token, { ref: p.ref }),
    file: p => githubClient.getFile(p.owner, p.repo, p.path, p.token, p.ref),
    'check-update': p => githubClient.checkUpdate(p.owner, p.repo, p.branch, p.currentSha, p.token),
    'ensure-private-repo': p => githubClient.ensurePrivateRepo(p.token, p.repoName, p.description, p.remark),
    push: p => githubClient.push(p.targetOwner, p.targetRepo, p.targetBranch, p.token, p.files, p.commitMessage, p.description, p.remark, p.originalSourceUrl),
    release: p => githubClient.release(p.owner, p.repo, p.tagName, p.releaseName, p.body, p.token, p.commitSha),
  };
  for (const [name, handler] of Object.entries(routes)) {
    app.post(`/api/github/${name}`, async (req, res) => {
      try { res.json(await handler(req.body)); }
      catch (error: any) { res.status(error.status || 500).json({ error: error.message || '操作失败' }); }
    });
  }
  app.post('/api/ai/changelog', async (req, res) => {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: '服务端尚未配置 GEMINI_API_KEY' });
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const p = req.body;
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
        contents: `请用中文 Markdown 根据以下提交信息生成更新摘要，不能推测未提供的代码变化。项目：${p.repoName}\n旧提交：${p.oldCommitMsg}\n新提交：${p.newCommitMsg}\n变动文件数：${p.fileChangesCount}`,
      });
      res.json({ changelog: response.text || '暂无分析内容' });
    } catch (error: any) { res.status(500).json({ error: error.message || 'AI 日志生成失败' }); }
  });
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => res.sendFile('index.html', { root: 'dist' }));
  } else {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  app.listen(process.env.PORT || 3000, () => console.log('GitVault server ready'));
}
startServer();
