import { githubClient, operationSignal } from './githubClient';

/** Pages and native WebViews use the same GitHub implementation as the optional Node server. */
export async function safeFetchJson(url: string, options?: RequestInit): Promise<any> {
  const p = typeof options?.body === 'string' ? JSON.parse(options.body) : {};
  switch (url) {
    case '/api/github/validate-token': return githubClient.validateToken(p.token);
    case '/api/github/fetch': return githubClient.fetchRepo(p.url, p.branch || undefined, p.token, { ref: p.ref, cachedFiles: p.cachedFiles, signal: options?.signal || operationSignal() });
    case '/api/github/file': return githubClient.getFile(p.owner, p.repo, p.path, p.token, p.ref);
    case '/api/github/check-update': return githubClient.checkUpdate(p.owner, p.repo, p.branch, p.currentSha, p.token);
    case '/api/github/ensure-private-repo': return githubClient.ensurePrivateRepo(p.token, p.repoName, p.description, p.remark);
    case '/api/github/push': return githubClient.push(p.targetOwner, p.targetRepo, p.targetBranch, p.token, p.files, p.commitMessage, p.description, p.remark, p.originalSourceUrl);
    case '/api/github/release': return githubClient.release(p.owner, p.repo, p.tagName, p.releaseName, p.body, p.token, p.commitSha);
    case '/api/ai/changelog': {
      // Keep the existing AI entry useful on static hosting; no secret API key belongs in a static bundle.
      if (import.meta.env.DEV || import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_MODE === 'server') {
        const response = await fetch(`${(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')}${url}`, { ...options, signal: AbortSignal.any([operationSignal(), AbortSignal.timeout(60000)]) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'AI 日志服务失败');
        return data;
      }
      return { changelog: `## ${p.repoName} 更新摘要\n\n${p.newCommitMsg || '暂无提交说明'}\n\n- 上次提交：${p.oldCommitMsg || '初始版本'}\n- 文件变化：${p.fileChangesCount ?? '未知'}\n\n当前为基于提交信息生成的本地摘要；连接 AI 后端后可生成智能分析。` };
    }
    default: throw new Error(`未知接口: ${url}`);
  }
}
