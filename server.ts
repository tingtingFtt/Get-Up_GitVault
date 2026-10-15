import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import JSZip from 'jszip';
dotenv.config();

function isTextFile(path: string): boolean {
  if (path.match(/\.(md|markdown|txt|ts|tsx|js|jsx|json|html|css|scss|less|py|rs|go|c|cpp|h|hpp|java|kt|rb|php|sh|bash|yml|yaml|xml|toml|sql|env|dockerfile|gitignore|editorconfig|svg|vue|svelte|astro)$/i)) {
    return true;
  }
  const basename = path.split('/').pop() || '';
  if (!basename.includes('.') || basename.startsWith('.')) return true;
  return false;
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));

  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  // API routes are defined first, vite.middlewares is mounted after API routes

  // Validate GitHub Token & Get User Info and Rate Limit
  app.post('/api/github/validate-token', async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ valid: false, error: '请提供 Token' });
      }

      const headers = {
        'User-Agent': 'GitVault-App',
        'Authorization': `Bearer ${token}`,
        'Accept': 'vnd.github+json'
      };

      const userRes = await fetch('https://api.github.com/user', { headers });
      if (!userRes.ok) {
        let errMsg = 'Token 无效或无权访问';
        try {
          const errJson = await userRes.json();
          if (errJson.message) {
            errMsg = `Token 校验失败: ${errJson.message}`;
          }
        } catch {
          const text = await userRes.text();
          if (text) errMsg = `Token 校验失败: ${text.slice(0, 100)}`;
        }
        return res.status(userRes.status).json({ valid: false, error: errMsg });
      }
      const userData = await userRes.json();

      let rateData = null;
      try {
        const rateRes = await fetch('https://api.github.com/rate_limit', { headers });
        if (rateRes.ok) {
          const rateJson = await rateRes.json();
          rateData = rateJson.rate;
        }
      } catch {}

      res.json({
        valid: true,
        user: {
          login: userData.login,
          name: userData.name || userData.login,
          avatarUrl: userData.avatar_url,
          htmlUrl: userData.html_url,
          publicRepos: userData.public_repos,
          privateRepos: userData.total_private_repos || 0,
        },
        rate: rateData
      });
    } catch (err: any) {
      console.error('Error validating token:', err);
      res.status(500).json({ valid: false, error: err.message || 'Token 验证失败' });
    }
  });

  // GitHub Proxy & Sync endpoints
  app.post('/api/github/fetch', async (req, res) => {
    try {
      const { url, branch = 'main', token } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'GitHub URL is required' });
      }

      let cleanUrl = url.trim().replace(/\/$/, '');
      if (cleanUrl.startsWith('https://github.com/')) {
        cleanUrl = cleanUrl.replace('https://github.com/', '');
      }
      const parts = cleanUrl.split('/');
      if (parts.length < 2) {
        return res.status(400).json({ error: 'Invalid GitHub repository URL format. Use owner/repo' });
      }
      const owner = parts[0];
      const repo = parts[1];

      const headers: Record<string, string> = {
        'User-Agent': 'GitVault-App',
        'Accept': 'vnd.github+json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!repoRes.ok) {
        const errText = await repoRes.text();
        return res.status(repoRes.status).json({ error: `GitHub API error: ${repoRes.statusText} - ${errText}` });
      }
      const repoData = await repoRes.json();
      const defaultBranch = branch || repoData.default_branch || 'main';

      const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${defaultBranch}`, { headers });
      if (!commitRes.ok) {
        const errText = await commitRes.text();
        return res.status(commitRes.status).json({ error: `Failed to fetch commit for branch ${defaultBranch}: ${errText}` });
      }
      const commitData = await commitRes.json();
      const latestCommitSha = commitData.sha;
      const commitMessage = commitData.commit?.message || '';
      const commitAuthor = commitData.commit?.author?.name || 'Unknown';
      const commitDate = commitData.commit?.author?.date || new Date().toISOString();

      const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${latestCommitSha}?recursive=1`, { headers });
      if (!treeRes.ok) {
        const errText = await treeRes.text();
        return res.status(treeRes.status).json({ error: `Failed to fetch repository file tree: ${errText}` });
      }
      const treeData = await treeRes.json();

      // 4. Download and unpack entire repository files snapshot via GitHub zipball
      let downloadedFiles: Array<{ path: string; content: string; isBase64: boolean; size: number }> = [];
      try {
        const zipHeaders: Record<string, string> = {
          'User-Agent': 'GitVault-App',
        };
        if (token) {
          zipHeaders['Authorization'] = `Bearer ${token}`;
        }
        const zipRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/${defaultBranch}`, {
          headers: zipHeaders
        });

        if (zipRes.ok) {
          const zipBuffer = await zipRes.arrayBuffer();
          const zip = await JSZip.loadAsync(zipBuffer);

          for (const [rawPath, zipEntry] of Object.entries(zip.files)) {
            if (zipEntry.dir) continue;
            // Strip the root folder "{owner}-{repo}-{sha}/" created by GitHub
            const slashIdx = rawPath.indexOf('/');
            if (slashIdx === -1) continue;
            const filePath = rawPath.slice(slashIdx + 1);
            if (!filePath) continue;

            const isText = isTextFile(filePath);
            if (isText) {
              const textContent = await zipEntry.async('string');
              downloadedFiles.push({
                path: filePath,
                content: textContent,
                isBase64: false,
                size: textContent.length
              });
            } else {
              // Binary / image files
              const base64Content = await zipEntry.async('base64');
              downloadedFiles.push({
                path: filePath,
                content: base64Content,
                isBase64: true,
                size: base64Content.length
              });
            }
          }
        }
      } catch (zipErr) {
        console.warn('Zipball extraction warning (falling back to tree metadata):', zipErr);
      }

      res.json({
        owner,
        repo,
        branch: defaultBranch,
        latestCommitSha,
        commitMessage,
        commitAuthor,
        commitDate,
        repoMeta: {
          description: repoData.description,
          stars: repoData.stargazers_count,
          forks: repoData.forks_count,
          language: repoData.language,
          updatedAt: repoData.updated_at,
          htmlUrl: repoData.html_url,
        },
        tree: treeData.tree || [],
        files: downloadedFiles,
        isFullyCached: downloadedFiles.length > 0,
        cachedFilesCount: downloadedFiles.length
      });
    } catch (err: any) {
      console.error('Error fetching GitHub repo:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  app.post('/api/github/file', async (req, res) => {
    try {
      const { owner, repo, path, token } = req.body;
      if (!owner || !repo || !path) {
        return res.status(400).json({ error: 'owner, repo, and path are required' });
      }

      const headers: Record<string, string> = {
        'User-Agent': 'GitVault-App',
        'Accept': 'application/vnd.github.raw+json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers });
      if (!fileRes.ok) {
        return res.status(fileRes.status).json({ error: `Failed to fetch file content: ${fileRes.statusText}` });
      }

      const contentType = fileRes.headers.get('content-type') || 'text/plain';
      const buffer = await fileRes.arrayBuffer();
      
      if (contentType.includes('text') || path.match(/\.(md|ts|tsx|js|jsx|json|html|css|py|rs|go|yml|yaml|txt|sh|Dockerfile)$/i)) {
        const text = Buffer.from(buffer).toString('utf-8');
        res.json({ type: 'text', content: text });
      } else {
        const base64 = Buffer.from(buffer).toString('base64');
        res.json({ type: 'base64', content: base64, mimeType: contentType });
      }
    } catch (err: any) {
      console.error('Error fetching file:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  app.post('/api/github/check-update', async (req, res) => {
    try {
      const { owner, repo, branch = 'main', currentSha, token } = req.body;
      if (!owner || !repo) {
        return res.status(400).json({ error: 'owner and repo are required' });
      }

      const headers: Record<string, string> = {
        'User-Agent': 'GitVault-App',
        'Accept': 'vnd.github+json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${branch}`, { headers });
      if (!commitRes.ok) {
        return res.status(commitRes.status).json({ error: 'Failed to check updates' });
      }
      const commitData = await commitRes.json();
      const latestSha = commitData.sha;
      const hasUpdate = latestSha !== currentSha;

      res.json({
        hasUpdate,
        latestSha,
        latestCommit: {
          sha: latestSha,
          message: commitData.commit?.message,
          author: commitData.commit?.author?.name,
          date: commitData.commit?.author?.date,
        }
      });
    } catch (err: any) {
      console.error('Error checking update:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Ensure private repository exists on user's GitHub account (create if not exists)
  app.post('/api/github/ensure-private-repo', async (req, res) => {
    try {
      const { token, repoName, description, remark } = req.body;
      if (!token || !repoName) {
        return res.status(400).json({ error: '请提供 GitHub Token 与项目仓库名称' });
      }

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'vnd.github+json',
        'User-Agent': 'GitVault-App',
        'Content-Type': 'application/json'
      };

      // 1. Get current authenticated user
      const userRes = await fetch('https://api.github.com/user', { headers });
      if (!userRes.ok) {
        let errMsg = 'GitHub 用户凭证失效';
        try {
          const errData = await userRes.json();
          if (errData.message) errMsg = errData.message;
        } catch {}
        return res.status(userRes.status).json({ error: errMsg });
      }
      const user = await userRes.json();
      const owner = user.login;

      // Sanitize repo name (only alphanumeric, hyphens, underscores)
      const sanitizedRepoName = repoName.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'gitvault-project';

      const composedDescription = [
        description ? description.trim() : '',
        remark ? `[备注: ${remark.trim()}]` : '',
        '[GitVault 托管]'
      ].filter(Boolean).join(' ');

      // 2. Check if repo already exists
      const checkRes = await fetch(`https://api.github.com/repos/${owner}/${sanitizedRepoName}`, { headers });
      if (checkRes.ok) {
        const existingRepo = await checkRes.json();
        // Update description if changed
        try {
          await fetch(`https://api.github.com/repos/${owner}/${sanitizedRepoName}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              description: composedDescription.slice(0, 350)
            })
          });
        } catch {}

        return res.json({
          owner,
          repo: sanitizedRepoName,
          htmlUrl: existingRepo.html_url,
          alreadyExisted: true
        });
      }

      // 3. Create new private repository on user's personal account
      const createRes = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: sanitizedRepoName,
          description: composedDescription.slice(0, 350),
          private: true,
          auto_init: true
        })
      });

      if (!createRes.ok) {
        let errMsg = '新建私人仓库失败';
        try {
          const errData = await createRes.json();
          if (errData.message) errMsg = `GitHub API: ${errData.message}`;
        } catch {
          const text = await createRes.text();
          if (text) errMsg = text.slice(0, 100);
        }
        return res.status(createRes.status).json({ error: errMsg });
      }

      const createdRepo = await createRes.json();
      res.json({
        owner,
        repo: sanitizedRepoName,
        htmlUrl: createdRepo.html_url,
        alreadyExisted: false
      });
    } catch (err: any) {
      console.error('Error ensuring private repo:', err);
      res.status(500).json({ error: err.message || '创建私人仓库失败' });
    }
  });

  // Push / Upload pulled project files to a target GitHub repository & branch
  app.post('/api/github/push', async (req, res) => {
    try {
      const { targetOwner, targetRepo, targetBranch = 'main', token, files, commitMessage, description, remark, originalSourceUrl } = req.body;
      if (!targetOwner || !targetRepo || !token || !files || !Array.isArray(files)) {
        return res.status(400).json({ error: 'Missing required push parameters' });
      }

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'vnd.github+json',
        'User-Agent': 'GitVault-App',
        'Content-Type': 'application/json'
      };

      // Determine the effective target branch
      let effectiveBranch = targetBranch || 'main';
      try {
        const repoCheckRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}`, { headers });
        if (repoCheckRes.ok) {
          const repoData = await repoCheckRes.json();
          if (repoData.default_branch) {
            effectiveBranch = repoData.default_branch;
          }
        }
      } catch {}

      // 1. Get latest commit SHA of effective branch
      let parentCommitSha = '';
      let refRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/${effectiveBranch}`, { headers });
      if (!refRes.ok && effectiveBranch !== 'main') {
        refRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/main`, { headers });
        if (refRes.ok) effectiveBranch = 'main';
      }
      if (!refRes.ok && effectiveBranch !== 'master') {
        const masterRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/master`, { headers });
        if (masterRes.ok) {
          refRes = masterRes;
          effectiveBranch = 'master';
        }
      }
      if (refRes.ok) {
        const refData = await refRes.json();
        parentCommitSha = refData.object?.sha || '';
      }

      // 2. Include metadata file with description and remarks if present
      const allFiles = [...files];
      if (description || remark || originalSourceUrl) {
        const metadataDoc = [
          `# ${targetRepo}`,
          '',
          `> 本项目由 GitVault 智能管家同步托管至个人私人仓库`,
          '',
          description ? `### 📝 项目描述\n${description}\n` : '',
          remark ? `### 📌 项目备注\n${remark}\n` : '',
          originalSourceUrl ? `### 🔗 原始源地址\n${originalSourceUrl}\n` : '',
          `### ⏱ 同步时间\n${new Date().toISOString()}\n`,
          '---',
          '*由 GitVault 自动同步生成*'
        ].filter(Boolean).join('\n');

        allFiles.push({
          path: 'GITVAULT_METADATA.md',
          content: metadataDoc,
          isBase64: false
        });
      }

      // 3. Build tree items efficiently
      // For text files under 60KB, GitHub accepts 'content' directly inside git/trees
      // For binary or large files, create blobs concurrently
      const treeItems: any[] = [];
      const filesNeedingBlob: Array<{ file: any; index: number }> = [];

      for (let i = 0; i < allFiles.length; i++) {
        const file = allFiles[i];
        if (!file.isBase64 && typeof file.content === 'string' && file.content.length < 60000) {
          treeItems.push({
            path: file.path.replace(/^\/+/, ''),
            mode: '100644',
            type: 'blob',
            content: file.content
          });
        } else {
          filesNeedingBlob.push({ file, index: i });
        }
      }

      // Concurrently create blobs for binary or large files in batches of 8
      if (filesNeedingBlob.length > 0) {
        const batchSize = 8;
        for (let i = 0; i < filesNeedingBlob.length; i += batchSize) {
          const batch = filesNeedingBlob.slice(i, i + batchSize);
          await Promise.all(batch.map(async ({ file }) => {
            const blobRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/blobs`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                content: file.content,
                encoding: file.isBase64 ? 'base64' : 'utf-8'
              })
            });
            if (!blobRes.ok) {
              const errText = await blobRes.text();
              throw new Error(`Failed to create blob for ${file.path}: ${errText}`);
            }
            const blobData = await blobRes.json();
            treeItems.push({
              path: file.path.replace(/^\/+/, ''),
              mode: '100644',
              type: 'blob',
              sha: blobData.sha
            });
          }));
        }
      }

      // 4. Create Tree
      const treePayload: any = {
        tree: treeItems
      };
      if (parentCommitSha) {
        // base_tree merges changes on top of existing repository files
        const commitInfoRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/commits/${parentCommitSha}`, { headers });
        if (commitInfoRes.ok) {
          const commitInfo = await commitInfoRes.json();
          if (commitInfo.tree?.sha) {
            treePayload.base_tree = commitInfo.tree.sha;
          }
        }
      }

      const treeRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/trees`, {
        method: 'POST',
        headers,
        body: JSON.stringify(treePayload)
      });
      if (!treeRes.ok) {
        const errText = await treeRes.text();
        throw new Error(`Failed to create tree: ${errText}`);
      }
      const treeData = await treeRes.json();

      // 5. Create Commit
      const commitPayload: any = {
        message: commitMessage || `Full project backup via GitVault (${allFiles.length} files)`,
        tree: treeData.sha
      };
      if (parentCommitSha) {
        commitPayload.parents = [parentCommitSha];
      }

      const newCommitRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/commits`, {
        method: 'POST',
        headers,
        body: JSON.stringify(commitPayload)
      });
      if (!newCommitRes.ok) {
        const errText = await newCommitRes.text();
        throw new Error(`Failed to create commit: ${errText}`);
      }
      const newCommitData = await newCommitRes.json();

      // 6. Update or Create Ref
      const refUrl = `https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/${effectiveBranch}`;
      let refUpdated = false;

      if (parentCommitSha) {
        const updateRefRes = await fetch(refUrl, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            sha: newCommitData.sha,
            force: true
          })
        });
        if (updateRefRes.ok) {
          refUpdated = true;
        }
      }

      if (!refUpdated) {
        // Try creating ref if update failed or if no parent commit
        const createRefRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ref: `refs/heads/${effectiveBranch}`,
            sha: newCommitData.sha
          })
        });

        if (!createRefRes.ok) {
          // If already exists, retry PATCH with force
          const forcePatchRes = await fetch(refUrl, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              sha: newCommitData.sha,
              force: true
            })
          });
          if (!forcePatchRes.ok) {
            const errText = await forcePatchRes.text();
            throw new Error(`Failed to update branch reference ${effectiveBranch}: ${errText}`);
          }
        }
      }

      res.json({
        success: true,
        commitSha: newCommitData.sha,
        branch: effectiveBranch,
        htmlUrl: `https://github.com/${targetOwner}/${targetRepo}/tree/${effectiveBranch}`,
        uploadedFilesCount: allFiles.length
      });
    } catch (err: any) {
      console.error('Error pushing to GitHub:', err);
      res.status(500).json({ error: err.message || 'Push failed' });
    }
  });

  app.post('/api/ai/changelog', async (req, res) => {
    try {
      const { oldCommitMsg, newCommitMsg, repoName, fileChangesCount } = req.body;

      const prompt = `分析以下 GitHub 仓库 "${repoName}" 的版本更新，并生成一份专业、清晰的中文更新日志（Changelog）摘要：
旧版本提交信息: ${oldCommitMsg || '初始版本'}
新版本提交信息: ${newCommitMsg || '更新提交'}
变动文件数量: ${fileChangesCount || '未知'}

请输出结构化的更新日志，包括：
1. 核心亮点 (Key Highlights)
2. 变更摘要 (Summary of Changes)
3. 建议注意事项 (Recommendations / Notes)
请使用 Markdown 格式。`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          systemInstruction: '你是一个精通软件工程和 GitHub 开源项目的资深技术专家，善于分析代码提交并生成高质量的更新日志。',
          temperature: 0.7,
        }
      });

      res.json({ changelog: response.text || '暂无分析内容' });
    } catch (err: any) {
      console.error('Gemini AI changelog error:', err);
      res.status(500).json({ error: err.message || 'AI generation failed' });
    }
  });

  app.post('/api/github/release', async (req, res) => {
    try {
      const { owner, repo, tagName, releaseName, body, token } = req.body;
      if (!owner || !repo || !tagName || !token) {
        return res.status(400).json({ error: 'Owner, repo, tagName and token are required' });
      }

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'vnd.github+json',
          'User-Agent': 'GitVault-App',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tag_name: tagName,
          name: releaseName || tagName,
          body: body || 'Automated release via GitVault',
          draft: false,
          prerelease: false
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({ error: `GitHub Release error: ${errText}` });
      }

      const releaseData = await response.json();
      res.json({
        success: true,
        releaseUrl: releaseData.html_url,
        tagName: releaseData.tag_name
      });
    } catch (err: any) {
      console.error('Error creating release:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Mount Vite SPA & dev middleware after all API endpoints
  app.use(vite.middlewares);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
