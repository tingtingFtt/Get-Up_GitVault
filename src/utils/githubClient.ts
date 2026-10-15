import JSZip from 'jszip';
import { CachedFile } from './localCache';

function isTextFile(path: string): boolean {
  if (path.match(/\.(md|markdown|txt|ts|tsx|js|jsx|json|html|css|scss|less|py|rs|go|c|cpp|h|hpp|java|kt|rb|php|sh|bash|yml|yaml|xml|toml|sql|env|dockerfile|gitignore|editorconfig|svg|vue|svelte|astro)$/i)) {
    return true;
  }
  const basename = path.split('/').pop() || '';
  if (!basename.includes('.') || basename.startsWith('.')) return true;
  return false;
}

export const githubClient = {
  /**
   * Direct browser client validation of GitHub Token
   */
  async validateToken(token: string) {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`
    };

    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) {
      let msg = 'Token 无效或无权访问';
      try {
        const errJson = await userRes.json();
        if (errJson.message) msg = errJson.message;
      } catch {}
      throw new Error(`GitHub: ${msg}`);
    }

    const userData = await userRes.json();
    let rateLimit = null;
    try {
      const rateRes = await fetch('https://api.github.com/rate_limit', { headers });
      if (rateRes.ok) {
        const rateJson = await rateRes.json();
        rateLimit = rateJson.rate;
      }
    } catch {}

    return {
      valid: true,
      user: {
        login: userData.login,
        name: userData.name || userData.login,
        avatarUrl: userData.avatar_url,
        htmlUrl: userData.html_url,
        publicRepos: userData.public_repos,
        privateRepos: userData.total_private_repos || 0,
      },
      rateLimit
    };
  },

  /**
   * Direct browser pull of complete repository snapshot
   */
  async fetchRepo(url: string, branch = 'main', token?: string) {
    let cleanUrl = url.trim().replace(/\/$/, '');
    if (cleanUrl.startsWith('https://github.com/')) {
      cleanUrl = cleanUrl.replace('https://github.com/', '');
    }
    const parts = cleanUrl.split('/');
    if (parts.length < 2) {
      throw new Error('仓库地址格式错误，请使用 owner/repo');
    }
    const owner = parts[0];
    const repo = parts[1];

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // 1. Repo metadata
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) {
      const err = await repoRes.text();
      throw new Error(`无法获取仓库信息: ${repoRes.statusText} - ${err.slice(0, 80)}`);
    }
    const repoData = await repoRes.json();
    const defaultBranch = branch || repoData.default_branch || 'main';

    // 2. Commit metadata
    const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${defaultBranch}`, { headers });
    if (!commitRes.ok) {
      throw new Error(`获取分支 ${defaultBranch} 提交失败`);
    }
    const commitData = await commitRes.json();
    const latestCommitSha = commitData.sha;
    const commitMessage = commitData.commit?.message || '';
    const commitAuthor = commitData.commit?.author?.name || 'Unknown';
    const commitDate = commitData.commit?.author?.date || new Date().toISOString();

    // 3. Tree metadata
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${latestCommitSha}?recursive=1`, { headers });
    let tree: any[] = [];
    if (treeRes.ok) {
      const treeJson = await treeRes.json();
      tree = treeJson.tree || [];
    }

    // 4. Download and unpack zipball
    const downloadedFiles: CachedFile[] = [];
    try {
      const zipRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/${defaultBranch}`, {
        headers
      });

      if (zipRes.ok) {
        const arrayBuf = await zipRes.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuf);

        for (const [rawPath, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          const slashIdx = rawPath.indexOf('/');
          if (slashIdx === -1) continue;
          const filePath = rawPath.slice(slashIdx + 1);
          if (!filePath) continue;

          if (isTextFile(filePath)) {
            const text = await entry.async('string');
            downloadedFiles.push({
              path: filePath,
              content: text,
              isBase64: false,
              size: text.length
            });
          } else {
            const base64 = await entry.async('base64');
            downloadedFiles.push({
              path: filePath,
              content: base64,
              isBase64: true,
              size: base64.length
            });
          }
        }
      }
    } catch (zipErr) {
      console.warn('Direct zipball download failed, falling back:', zipErr);
    }

    return {
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
      tree: tree.length > 0 ? tree : downloadedFiles.map(f => ({ path: f.path, type: 'blob', mode: '100644', sha: '' })),
      files: downloadedFiles,
      cachedFilesCount: downloadedFiles.length,
      isFullyCached: downloadedFiles.length > 0
    };
  },

  /**
   * Direct creation of private repository on user's GitHub account
   */
  async ensurePrivateRepo(token: string, repoName: string, description?: string, remark?: string) {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) {
      throw new Error('GitHub 凭证已过期或无效');
    }
    const user = await userRes.json();
    const owner = user.login;
    const sanitizedRepoName = repoName.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'gitvault-project';

    const composedDescription = [
      description ? description.trim() : '',
      remark ? `[备注: ${remark.trim()}]` : '',
      '[GitVault 托管]'
    ].filter(Boolean).join(' ');

    const checkRes = await fetch(`https://api.github.com/repos/${owner}/${sanitizedRepoName}`, { headers });
    if (checkRes.ok) {
      const existing = await checkRes.json();
      return {
        owner,
        repo: sanitizedRepoName,
        defaultBranch: existing.default_branch || 'main',
        htmlUrl: existing.html_url,
        alreadyExisted: true
      };
    }

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
      const err = await createRes.text();
      throw new Error(`创建私人仓库失败: ${err.slice(0, 100)}`);
    }

    const created = await createRes.json();
    return {
      owner,
      repo: sanitizedRepoName,
      defaultBranch: created.default_branch || 'main',
      htmlUrl: created.html_url,
      alreadyExisted: false
    };
  },

  /**
   * Direct client-side push of all files to private repository
   */
  async push(
    targetOwner: string,
    targetRepo: string,
    targetBranch: string,
    token: string,
    files: CachedFile[],
    commitMessage: string,
    description?: string,
    remark?: string,
    originalSourceUrl?: string
  ) {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // 1. Detect default branch
    let effectiveBranch = targetBranch || 'main';
    try {
      const repoRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}`, { headers });
      if (repoRes.ok) {
        const repoData = await repoRes.json();
        effectiveBranch = repoData.default_branch || effectiveBranch;
      }
    } catch {}

    // 2. Get parent commit SHA
    let parentCommitSha = '';
    const refRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/${effectiveBranch}`, { headers });
    if (refRes.ok) {
      const refData = await refRes.json();
      parentCommitSha = refData.object?.sha || '';
    }

    // 3. Prepare files with metadata file
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

    // 4. Build tree items
    const treeItems: any[] = [];
    const filesNeedingBlob: Array<{ file: CachedFile }> = [];

    for (const file of allFiles) {
      if (!file.isBase64 && typeof file.content === 'string' && file.content.length < 60000) {
        treeItems.push({
          path: file.path.replace(/^\/+/, ''),
          mode: '100644',
          type: 'blob',
          content: file.content
        });
      } else {
        filesNeedingBlob.push({ file });
      }
    }

    // Create blobs for binary or large files
    if (filesNeedingBlob.length > 0) {
      const batchSize = 6;
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
            throw new Error(`创建 Blob 失败: ${file.path}`);
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

    // 5. Create Tree
    const treePayload: any = { tree: treeItems };
    if (parentCommitSha) {
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
      const err = await treeRes.text();
      throw new Error(`创建代码树失败: ${err.slice(0, 80)}`);
    }
    const treeData = await treeRes.json();

    // 6. Create Commit
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
      throw new Error('创建提交失败');
    }
    const newCommitData = await newCommitRes.json();

    // 7. Update Ref
    const refUrl = `https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs/heads/${effectiveBranch}`;
    let updated = false;

    if (parentCommitSha) {
      const updateRes = await fetch(refUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          sha: newCommitData.sha,
          force: true
        })
      });
      if (updateRes.ok) updated = true;
    }

    if (!updated) {
      const createRefRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetRepo}/git/refs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ref: `refs/heads/${effectiveBranch}`,
          sha: newCommitData.sha
        })
      });
      if (!createRefRes.ok) {
        await fetch(refUrl, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            sha: newCommitData.sha,
            force: true
          })
        });
      }
    }

    return {
      success: true,
      commitSha: newCommitData.sha,
      branch: effectiveBranch,
      htmlUrl: `https://github.com/${targetOwner}/${targetRepo}/tree/${effectiveBranch}`,
      uploadedFilesCount: allFiles.length
    };
  }
};
