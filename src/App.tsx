import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  GitBranch, FolderGit2, RefreshCw, History, Tag, Download,
  FileCode, Folder, File, Search, Sparkles, Plus, Trash2,
  ExternalLink, AlertCircle, CheckCircle2, Clock, Edit3,
  Layers, ArrowRight, ChevronRight, ShieldCheck, Info, X,
  Check, Database, UploadCloud, Cloud, LayoutDashboard,
  Bookmark, Timer, Settings, Bell, Send, Key, UserCheck,
  Copy, FileDiff, ArrowLeft, SlidersHorizontal, Upload,
  BarChart3, PieChart, Activity, Box, Filter, CheckSquare,
  Square, Archive, RefreshCcw, CheckCheck, Loader2, HardDrive,
  FolderDown, FolderCheck, Smartphone, CheckCircle, Wifi,
  FileText, Shield, Save, FileBox
} from 'lucide-react';
import JSZip from 'jszip';
import { Treemap, ResponsiveContainer } from 'recharts';
import { localCache, CachedFile } from './utils/localCache';
import { githubClient } from './utils/githubClient';

interface RepoTreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface BackupVersion {
  id: string;
  versionNumber: number;
  tag: string;
  annotation: string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  commitDate: string;
  backedUpAt: string;
  tree: RepoTreeItem[];
  isReleased?: boolean;
  releaseUrl?: string;
  isCachePurged?: boolean;
}

interface TrackedRepo {
  id: string;
  url: string;
  owner: string;
  repo: string;
  branch: string;
  token?: string;
  remark: string;
  description?: string; // 用户项目详细描述
  tags: string[];
  checkInterval: number;
  lastCheckedAt?: string;
  latestCommitSha: string;
  commitMessage: string;
  commitAuthor: string;
  commitDate: string;
  lastSyncedAt: string;
  repoMeta: {
    description?: string;
    stars?: number;
    forks?: number;
    language?: string;
    updatedAt?: string;
    htmlUrl?: string;
  };
  tree: RepoTreeItem[];
  backups: BackupVersion[];
  hasUpdate?: boolean;
  latestRemoteCommit?: {
    sha: string;
    message: string;
    author: string;
    date: string;
  };
  aiChangelog?: string;
  isCachePurged?: boolean;
  cachedFilesCount?: number;
  privateRepoUrl?: string; // 个人私人仓库直达链接
  lastUploadedToPrivateAt?: string; // 上传至个人私人仓库时间戳
}

interface UserProfile {
  login: string;
  name: string;
  avatarUrl: string;
  htmlUrl: string;
  publicRepos: number;
  privateRepos: number;
}

interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

interface BatchReleaseItemStatus {
  id: string;
  tag: string;
  status: 'pending' | 'releasing' | 'success' | 'error';
  error?: string;
  releaseUrl?: string;
}

interface BatchUploadItemStatus {
  id: string;
  name: string;
  repo: string;
  status: 'pending' | 'creating' | 'uploading' | 'success' | 'error';
  error?: string;
  htmlUrl?: string;
}

// Light Morandi Gradient Color Palette for heatmap
const MORANDI_HEATMAP_COLORS = [
  '#9CB09D', // Soft Morandi Sage
  '#D6A69B', // Soft Morandi Rosewood
  '#93A8B8', // Soft Morandi Slate Blue
  '#C9B59F', // Soft Morandi Ochre
  '#B2A4B8', // Soft Morandi Lavender Grey
  '#A0B3AB', // Soft Morandi Eucalyptus
  '#CDBDB0', // Soft Morandi Greige
  '#8EA3A6', // Soft Morandi Sea Mist
  '#D4A8A1', // Soft Morandi Terracotta
  '#A3B08B', // Soft Morandi Olive
];

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Safe fetch helper that guards against empty body and unexpected JSON errors
async function safeFetchJson(url: string, options?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (netErr: any) {
    throw new Error(`网络连接失败: 无法连接服务 (${netErr.message || '网络中断'})`);
  }

  const text = await res.text();
  let data: any = {};
  if (text && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new Error(`服务异常 (${res.status}): ${text.slice(0, 100)}`);
      }
      throw new Error(`服务返回非JSON数据 (${res.status}): ${text.slice(0, 80)}`);
    }
  } else {
    if (!res.ok) {
      throw new Error(`请求失败，服务返回空响应 (HTTP ${res.status} ${res.statusText})`);
    }
    return {};
  }

  if (!res.ok) {
    throw new Error(data.error || data.message || `请求失败 (HTTP ${res.status})`);
  }

  return data;
}

export default function App() {
  const [repos, setRepos] = useState<TrackedRepo[]>(() => {
    try {
      const saved = localStorage.getItem('gitvault_repos_v8');
      if (saved) return JSON.parse(saved);
      const oldSaved = localStorage.getItem('gitvault_repos_v7');
      if (oldSaved) return JSON.parse(oldSaved);
      return [];
    } catch {
      return [];
    }
  });

  // Global settings state
  const [globalToken, setGlobalToken] = useState<string>(() => {
    return localStorage.getItem('gitvault_global_token') || '';
  });
  const [globalUsername, setGlobalUsername] = useState<string>(() => {
    return localStorage.getItem('gitvault_global_username') || '';
  });
  const [apkDownloadDirectory, setApkDownloadDirectory] = useState<string>(() => {
    return localStorage.getItem('gitvault_apk_download_dir') || '/storage/emulated/0/Download/GitVault';
  });

  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimit | null>(null);
  const [isValidatingToken, setIsValidatingToken] = useState(false);

  // Global token test status state
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  // Responsive views: 'dashboard' | 'projects' | 'workbench'
  const [currentView, setCurrentView] = useState<'dashboard' | 'projects' | 'workbench'>('dashboard');
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);

  // Search & Filter (Projects and Dashboard)
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>('all');

  // Batch Management state for Projects (仓库已有项目)
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [isBatchTagModalOpen, setIsBatchTagModalOpen] = useState(false);
  const [batchTagInput, setBatchTagInput] = useState('');
  const [isBatchUploadModalOpen, setIsBatchUploadModalOpen] = useState(false);
  const [batchUploadStatusList, setBatchUploadStatusList] = useState<BatchUploadItemStatus[]>([]);
  const [isBatchUploading, setIsBatchUploading] = useState(false);

  // Batch Release & Cache Purge state in Backups tab
  const [selectedBackupIds, setSelectedBackupIds] = useState<string[]>([]);
  const [purgeCacheOption, setPurgeCacheOption] = useState<boolean>(true);
  const [isBatchReleaseModalOpen, setIsBatchReleaseModalOpen] = useState(false);
  const [batchReleaseProgress, setBatchReleaseProgress] = useState<BatchReleaseItemStatus[]>([]);
  const [batchReleaseTitlePrefix, setBatchReleaseTitlePrefix] = useState('归档发布');
  const [isBatchPublishing, setIsBatchPublishing] = useState(false);

  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isPushModalOpen, setIsPushModalOpen] = useState(false);
  const [isSingleUploadModalOpen, setIsSingleUploadModalOpen] = useState(false);
  const [singleUploadTargetRepo, setSingleUploadTargetRepo] = useState<TrackedRepo | null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'github' | 'backup' | 'apk' | 'package'>('github');
  const [isDiffModalOpen, setIsDiffModalOpen] = useState(false);
  const [diffBackupTarget, setDiffBackupTarget] = useState<BackupVersion | null>(null);

  // Project Settings & Folder Download Modal state
  const [isProjectSettingsModalOpen, setIsProjectSettingsModalOpen] = useState(false);
  const [projectSettingsTarget, setProjectSettingsTarget] = useState<TrackedRepo | null>(null);
  const [projectSettingsTab, setProjectSettingsTab] = useState<'folderDownload' | 'basic' | 'storage'>('folderDownload');
  const [selectedFolderToDownload, setSelectedFolderToDownload] = useState<string>('/');
  const [folderFilterQuery, setFolderFilterQuery] = useState<string>('');
  const [apkTargetDirectory, setApkTargetDirectory] = useState<string>('');
  const [includeApkManifest, setIncludeApkManifest] = useState<boolean>(true);
  const [isDownloadingFolder, setIsDownloadingFolder] = useState<boolean>(false);
  const [projectRemark, setProjectRemark] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [projectTags, setProjectTags] = useState('');
  const [projectToken, setProjectToken] = useState('');
  const [projectCheckInterval, setProjectCheckInterval] = useState(0);
  const [projectTokenTestStatus, setProjectTokenTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [projectTokenTestMsg, setProjectTokenTestMsg] = useState('');

  // Push modal state (traditional push)
  const [pushTargetRepo, setPushTargetRepo] = useState('');
  const [pushTargetBranch, setPushTargetBranch] = useState('main');
  const [pushToken, setPushToken] = useState('');
  const [pushCommitMsg, setPushCommitMsg] = useState('');
  const [pushBackupTarget, setPushBackupTarget] = useState<BackupVersion | null>(null);
  const [purgePushCacheOption, setPurgePushCacheOption] = useState<boolean>(true);

  // Single Private Repo Upload state
  const [singleUploadRepoName, setSingleUploadRepoName] = useState('');
  const [singleUploadDescription, setSingleUploadDescription] = useState('');
  const [singleUploadRemark, setSingleUploadRemark] = useState('');
  const [singleUploadPurgeCache, setSingleUploadPurgeCache] = useState(false);
  const [isUploadingToPrivate, setIsUploadingToPrivate] = useState(false);

  // Form states for adding repo (Link)
  const [repoUrl, setRepoUrl] = useState('');
  const [branchInput, setBranchInput] = useState('main');
  const [tokenInput, setTokenInput] = useState('');
  const [remarkInput, setRemarkInput] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [tagsInput, setTagsInput] = useState('默认');

  // Workbench state
  const [workbenchTab, setWorkbenchTab] = useState<'files' | 'backups' | 'changelog'>('files');
  const [fileViewMode, setFileViewMode] = useState<'explorer' | 'heatmap'>('explorer');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentType, setFileContentType] = useState<string>('text');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [viewingBackup, setViewingBackup] = useState<BackupVersion | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  // Mobile drawer / drill-down state in File Viewer
  const [mobileFileView, setMobileFileView] = useState<'list' | 'view'>('list');

  // Async / Operation Loading
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  // Hidden file input ref for backup import
  const backupImportInputRef = useRef<HTMLInputElement>(null);

  // Environment detection: Check if running inside APK or Native Android WebView
  const isApkEnvironment = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const w = window as any;
    const ua = navigator.userAgent.toLowerCase();
    return Boolean(w.AndroidBridge) ||
           Boolean(w.Capacitor) ||
           Boolean(w.ReactNativeWebView) ||
           ua.includes('gitvault-apk') ||
           ua.includes('wv') ||
           (ua.includes('android') && ua.includes('version/'));
  }, []);

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem('gitvault_repos_v8', JSON.stringify(repos));
  }, [repos]);

  // Validate GitHub Token on mount or when changed
  useEffect(() => {
    if (globalToken) {
      validateGitHubToken(globalToken);
    }
  }, [globalToken]);

  const validateGitHubToken = async (token: string) => {
    if (!token) return;
    setIsValidatingToken(true);
    try {
      let data: any = null;
      try {
        data = await safeFetchJson('/api/github/validate-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
      } catch (proxyErr) {
        // Fall back to direct browser client call to api.github.com
        data = await githubClient.validateToken(token);
      }

      if (data && data.valid) {
        setUserProfile(data.user);
        setRateLimit(data.rate || data.rateLimit);
      } else {
        setUserProfile(null);
      }
    } catch {
      setUserProfile(null);
    } finally {
      setIsValidatingToken(false);
    }
  };

  // Dedicated Test GitHub Connection handler
  const handleTestGitHubConnection = async (tokenToTest?: string) => {
    const token = (tokenToTest !== undefined ? tokenToTest : globalToken).trim();
    if (!token) {
      setTestStatus('error');
      setTestMsg('请先输入 GitHub Personal Access Token (PAT) 再进行测试');
      return;
    }

    setTestStatus('testing');
    setTestMsg('正在连接 GitHub API 节点并校验用户权限...');

    try {
      let data: any = null;
      try {
        data = await safeFetchJson('/api/github/validate-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
      } catch {
        // Direct browser client fallback
        data = await githubClient.validateToken(token);
      }

      if (data && data.valid) {
        setUserProfile(data.user);
        const rateInfo = data.rate || data.rateLimit;
        setRateLimit(rateInfo);
        setTestStatus('success');
        setTestMsg(`GitHub 连接成功！已验证账号: @${data.user.login} (${data.user.name}) · 剩余 API 配额: ${rateInfo ? `${rateInfo.remaining}/${rateInfo.limit}` : '正常'}`);
      } else {
        setTestStatus('error');
        setTestMsg(data?.error || 'Token 验证失败，请确认是否具有 repo 权限');
      }
    } catch (err: any) {
      setTestStatus('error');
      setTestMsg(`连接失败: ${err.message || '网络连接异常或 Token 无效'}`);
    }
  };

  const handleTestProjectToken = async () => {
    if (!projectToken.trim()) {
      setProjectTokenTestStatus('error');
      setProjectTokenTestMsg('请先填写项目专属 Token');
      return;
    }

    setProjectTokenTestStatus('testing');
    setProjectTokenTestMsg('正在验证项目专属 Token...');

    try {
      const data = await safeFetchJson('/api/github/validate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: projectToken.trim() })
      });

      if (data.valid) {
        setProjectTokenTestStatus('success');
        setProjectTokenTestMsg(`验证成功！已连接 GitHub 账号: @${data.user.login}`);
      } else {
        setProjectTokenTestStatus('error');
        setProjectTokenTestMsg(data.error || '专属 Token 校验失败');
      }
    } catch (err: any) {
      setProjectTokenTestStatus('error');
      setProjectTokenTestMsg('连接 GitHub 失败: ' + err.message);
    }
  };

  const handleSaveGlobalSettings = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('gitvault_global_token', globalToken.trim());
    localStorage.setItem('gitvault_global_username', globalUsername.trim());
    localStorage.setItem('gitvault_apk_download_dir', apkDownloadDirectory.trim());
    validateGitHubToken(globalToken.trim());
    setIsSettingsModalOpen(false);
    alert('全局设置已成功保存！');
  };

  // Export full system backup (settings + project registry + remarks + descriptions)
  const handleExportSystemBackup = () => {
    try {
      const backupData = {
        app: 'GitVault',
        version: '2.5',
        exportedAt: new Date().toISOString(),
        settings: {
          globalToken: globalToken,
          globalUsername: globalUsername,
          apkDownloadDirectory: apkDownloadDirectory,
        },
        projectsCount: repos.length,
        projects: repos
      };

      const jsonStr = JSON.stringify(backupData, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      a.href = url;
      a.download = `GitVault_Backup_${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert('备份导出失败: ' + err.message);
    }
  };

  // Import / restore system backup
  const handleImportSystemBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const data = JSON.parse(text);

        if (!data || !Array.isArray(data.projects)) {
          alert('导入失败：该文件不是合法的 GitVault 备份 JSON');
          return;
        }

        const shouldMerge = confirm(
          `已读取备份文件！包含 ${data.projects.length} 个项目记录。\n点击“确定”将合并追加项目；点击“取消”将覆盖现有所有数据。`
        );

        if (shouldMerge) {
          const existingIds = new Set(repos.map(r => r.id));
          const newItems = data.projects.filter((p: TrackedRepo) => !existingIds.has(p.id));
          setRepos(prev => [...newItems, ...prev]);
        } else {
          setRepos(data.projects);
        }

        // Restore settings if included
        if (data.settings) {
          if (data.settings.globalToken) {
            setGlobalToken(data.settings.globalToken);
            localStorage.setItem('gitvault_global_token', data.settings.globalToken);
          }
          if (data.settings.globalUsername) {
            setGlobalUsername(data.settings.globalUsername);
            localStorage.setItem('gitvault_global_username', data.settings.globalUsername);
          }
          if (data.settings.apkDownloadDirectory) {
            setApkDownloadDirectory(data.settings.apkDownloadDirectory);
            localStorage.setItem('gitvault_apk_download_dir', data.settings.apkDownloadDirectory);
          }
        }

        alert(`备份恢复完成！当前项目总数: ${data.projects.length} 个`);
        setIsSettingsModalOpen(false);
      } catch (err: any) {
        alert('解析备份文件出错: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Export as HTML / ZIP offline package
  const handleExportHtmlBundle = async () => {
    try {
      const zip = new JSZip();
      const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>GitVault Offline Export</title>
  <style>
    body { font-family: sans-serif; background: #FAF8F5; color: #2B2723; padding: 40px; max-width: 800px; margin: 0 auto; }
    h1 { color: #4D5E4A; }
    .card { background: white; border: 1px solid #DFD8CE; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
    code { background: #EFECE6; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
  </style>
</head>
<body>
  <h1>GitVault 离线项目归档与管理中心</h1>
  <div class="card">
    <h3>归档信息</h3>
    <p>导出时间: ${new Date().toLocaleString()}</p>
    <p>项目总数: ${repos.length} 个</p>
  </div>
  <div class="card">
    <h3>项目列表</h3>
    <ul>
      ${repos.map(r => `<li><strong>${r.owner}/${r.repo}</strong> - ${r.remark || '无备注'} (${r.description || '无描述'})</li>`).join('')}
    </ul>
  </div>
</body>
</html>`;
      zip.file("index.html", htmlContent);
      
      const backupData = {
        version: 1,
        exportDate: new Date().toISOString(),
        repos,
        globalUsername,
      };
      zip.file("gitvault_backup.json", JSON.stringify(backupData, null, 2));

      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gitvault_html_offline_package_${new Date().toISOString().slice(0,10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      alert('HTML 离线网页打包与静态资源导出成功！');
    } catch (err: any) {
      alert('导出 HTML 离线包失败: ' + err.message);
    }
  };

  // Download Electron / EXE packaging configuration
  const handleDownloadElectronConfig = async () => {
    try {
      const zip = new JSZip();
      
      const mainJs = `const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
`;

      const electronPackageJson = `{
  "name": "gitvault-desktop",
  "version": "1.0.0",
  "description": "GitVault Desktop EXE App",
  "main": "main.js",
  "scripts": {
    "build": "vite build",
    "electron": "electron .",
    "dist": "electron-builder"
  },
  "build": {
    "appId": "com.gitvault.desktop",
    "files": ["dist/**/*", "main.js", "package.json"],
    "win": { "target": ["nsis", "portable"] }
  },
  "devDependencies": {
    "electron": "^34.0.0",
    "electron-builder": "^25.1.8"
  }
}
`;

      const readme = `# GitVault EXE 打包指南 (Windows 客户端)

1. 将本配置文件解压并合并到您的项目根目录中。
2. 安装依赖: \`npm install\`
3. 打包为 Windows 静态网页与 EXE:
   - 先构建前端: \`npm run build\`
   - 运行桌面端测试: \`npm run electron\`
   - 打包为安装包或绿色版 EXE: \`npx electron-builder\`
4. 打包完成后可在 \`dist_electron\` 目录中获取 \`.exe\` 文件。
`;

      zip.file("main.js", mainJs);
      zip.file("electron-package.json", electronPackageJson);
      zip.file("README_EXE.md", readme);

      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gitvault_exe_electron_config.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      alert('EXE 桌面端打包配置文件已下载！请按照说明在本地运行 electron-builder 生成 exe。');
    } catch (err: any) {
      alert('导出 EXE 配置失败: ' + err.message);
    }
  };

  // Download Capacitor / APK packaging configuration
  const handleDownloadCapacitorConfig = async () => {
    try {
      const zip = new JSZip();

      const capacitorConfig = `import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gitvault.app',
  appName: 'GitVault',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
`;

      const apkGuide = `# Android APK 打包指南 (Capacitor)

1. 在项目根目录安装 Capacitor 依赖:
   \`npm install @capacitor/core @capacitor/cli\`
   \`npm install @capacitor/android\`
2. 初始化 Capacitor:
   \`npx cap init\` (App Name 填 GitVault, Package ID 填 com.gitvault.app)
3. 添加 Android 平台:
   \`npx cap add android\`
4. 构建网页并同步到 Android:
   \`npm run build\`
   \`npx cap sync android\`
5. 打开 Android Studio 生成 APK:
   \`npx cap open android\`
   在 Android Studio 中点击 Build -> Build Bundle(s) / APK(s) -> Build APK(s) 即可生成安卓 APK 安装包。
   *注：打包为 APK 后，系统设置中的 APK 本地存储目录将自动生效，支持下载直落本地文件夹。*
`;

      zip.file("capacitor.config.ts", capacitorConfig);
      zip.file("README_APK.md", apkGuide);

      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gitvault_apk_capacitor_config.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      alert('APK 安卓打包配置已下载！请按照说明安装 Capacitor 并使用 Android Studio 生成 APK。');
    } catch (err: any) {
      alert('导出 APK 配置失败: ' + err.message);
    }
  };

  // Open Project Settings Modal
  const handleOpenProjectSettings = (repo: TrackedRepo, tab: 'folderDownload' | 'basic' | 'storage' = 'folderDownload') => {
    setProjectSettingsTarget(repo);
    setProjectSettingsTab(tab);
    setProjectRemark(repo.remark);
    setProjectDescription(repo.description || repo.repoMeta.description || '');
    setProjectTags(repo.tags.join(', '));
    setProjectToken(repo.token || '');
    setProjectCheckInterval(repo.checkInterval || 0);
    setApkTargetDirectory(`GitVault/${repo.repo}/`);
    setSelectedFolderToDownload('/');
    setProjectTokenTestStatus('idle');
    setProjectTokenTestMsg('');
    setIsProjectSettingsModalOpen(true);
  };

  // Save Project Basic Settings
  const handleSaveProjectSettings = (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectSettingsTarget) return;

    const tagsArray = projectTags.split(',').map(t => t.trim()).filter(Boolean);
    setRepos(prev => prev.map(r => {
      if (r.id === projectSettingsTarget.id) {
        return {
          ...r,
          remark: projectRemark.trim() || '未备注项目',
          description: projectDescription.trim(),
          tags: tagsArray.length > 0 ? tagsArray : ['默认'],
          token: projectToken.trim() || undefined,
          checkInterval: Number(projectCheckInterval)
        };
      }
      return r;
    }));

    setIsProjectSettingsModalOpen(false);
    alert('项目设置已成功保存！');
  };

  // Scheduled polling for auto status checks
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      repos.forEach(repo => {
        if (repo.checkInterval > 0) {
          const lastChecked = repo.lastCheckedAt ? new Date(repo.lastCheckedAt).getTime() : 0;
          if (now - lastChecked >= repo.checkInterval * 60 * 1000) {
            checkSingleRepoStatus(repo.id, true);
          }
        }
      });
    }, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, [repos]);

  const activeRepo = repos.find(r => r.id === activeRepoId);

  // Status check logic
  const checkSingleRepoStatus = async (repoId: string, isBackground = false) => {
    const repo = repos.find(r => r.id === repoId);
    if (!repo) return;

    if (!isBackground) {
      setIsLoading(true);
      setLoadingText(`正在检测项目 ${repo.repo} 的最新状态...`);
    }

    try {
      const tokenToUse = repo.token || globalToken;
      const data = await safeFetchJson('/api/github/check-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.repo,
          branch: repo.branch,
          currentSha: repo.latestCommitSha,
          token: tokenToUse || undefined
        })
      });

      setRepos(prev => prev.map(r => {
        if (r.id === repoId) {
          return {
            ...r,
            hasUpdate: data.hasUpdate,
            latestRemoteCommit: data.latestCommit,
            lastCheckedAt: new Date().toISOString()
          };
        }
        return r;
      }));
    } catch (err) {
      console.error('Status check failed:', err);
    } finally {
      if (!isBackground) setIsLoading(false);
    }
  };

  const checkAllUpdates = async () => {
    setIsLoading(true);
    setLoadingText('正在批量检测所有已链接项目状态...');
    for (const r of repos) {
      await checkSingleRepoStatus(r.id, true);
    }
    setIsLoading(false);
  };

  // Add new repository link: Directly pull project into local memory/storage
  const handleAddRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim()) return;

    setIsLoading(true);
    setErrorMsg('');
    setLoadingText(
      isApkEnvironment
        ? `正在从 GitHub 拉取项目并下载保存至 APK 本地目录 [${apkDownloadDirectory}]...`
        : '正在直接拉取项目完整代码树与元数据进入本地存储...'
    );

    try {
      const tokenToUse = tokenInput.trim() || globalToken;
      let data: any = null;

      try {
        data = await safeFetchJson('/api/github/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: repoUrl.trim(),
            branch: branchInput.trim() || 'main',
            token: tokenToUse || undefined
          })
        });
      } catch (proxyErr) {
        // Direct browser client fallback to GitHub API
        data = await githubClient.fetchRepo(
          repoUrl.trim(),
          branchInput.trim() || 'main',
          tokenToUse || undefined
        );
      }

      const tagsArray = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
      const fileCount = data.files ? data.files.length : 0;

      const newRepo: TrackedRepo = {
        id: `${data.owner}-${data.repo}-${Date.now()}`,
        url: repoUrl.trim(),
        owner: data.owner,
        repo: data.repo,
        branch: data.branch,
        token: tokenInput.trim() || undefined,
        remark: remarkInput.trim() || '未备注项目',
        description: descriptionInput.trim() || data.repoMeta?.description || '',
        tags: tagsArray.length > 0 ? tagsArray : ['默认'],
        checkInterval: 0,
        lastCheckedAt: new Date().toISOString(),
        latestCommitSha: data.latestCommitSha,
        commitMessage: data.commitMessage,
        commitAuthor: data.commitAuthor,
        commitDate: data.commitDate,
        lastSyncedAt: new Date().toISOString(),
        repoMeta: data.repoMeta,
        tree: data.tree,
        backups: [],
        hasUpdate: false,
        isCachePurged: false,
        cachedFilesCount: fileCount
      };

      // 1. Persist full downloaded project files in browser IndexedDB localCache
      if (data.files && data.files.length > 0) {
        try {
          await localCache.saveProjectFiles(newRepo.id, data.files);
        } catch (cacheErr) {
          console.warn('Failed to save to localCache:', cacheErr);
        }
      }

      // 2. If running inside APK native bridge, trigger file saving to apkDownloadDirectory
      if (isApkEnvironment && (window as any).AndroidBridge?.saveProjectFolder) {
        try {
          (window as any).AndroidBridge.saveProjectFolder(
            `${apkDownloadDirectory}/${newRepo.repo}`,
            JSON.stringify({ repo: newRepo.repo, sha: newRepo.latestCommitSha, tree: newRepo.tree, fileCount })
          );
        } catch {}
      }

      setRepos(prev => [newRepo, ...prev]);
      setIsAddModalOpen(false);
      setRepoUrl('');
      setBranchInput('main');
      setTokenInput('');
      setRemarkInput('');
      setDescriptionInput('');
      setCurrentView('projects');
      if (fileCount > 0) {
        alert(`🎉 项目拉取成功！\n已将完整项目（共 ${fileCount} 个文件）下载并保存在本地缓存中，随时可离线浏览并一键上传至私人仓集。`);
      }
    } catch (err: any) {
      setErrorMsg(err.message || '拉取项目失败');
    } finally {
      setIsLoading(false);
    }
  };

  // Open modal for uploading single project to user's private repo
  const handleOpenSingleUploadModal = (repo: TrackedRepo) => {
    setSingleUploadTargetRepo(repo);
    setSingleUploadRepoName(repo.repo);
    setSingleUploadRemark(repo.remark);
    setSingleUploadDescription(repo.description || repo.repoMeta?.description || '');
    setSingleUploadPurgeCache(false);
    setIsSingleUploadModalOpen(true);
  };

  // Execute upload single project to private repository
  const handleExecuteSingleUploadToPrivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleUploadTargetRepo) return;

    let token = singleUploadTargetRepo.token || globalToken;
    if (!token) {
      const entered = prompt('上传至个人私人仓库需要 GitHub Token (PAT)，请输入：');
      if (!entered) return;
      token = entered.trim();
    }

    setIsUploadingToPrivate(true);
    setIsLoading(true);
    setLoadingText(`正在自动为项目 "${singleUploadRepoName}" 在您账号下创建私人仓库并同步备注与描述...`);

    try {
      // 1. Ensure private repository on user's GitHub account (Dual-channel: server or browser)
      let ensureRes: any = null;
      try {
        ensureRes = await safeFetchJson('/api/github/ensure-private-repo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            repoName: singleUploadRepoName.trim(),
            description: singleUploadDescription.trim(),
            remark: singleUploadRemark.trim(),
          })
        });
      } catch (proxyErr) {
        ensureRes = await githubClient.ensurePrivateRepo(
          token,
          singleUploadRepoName.trim(),
          singleUploadDescription.trim(),
          singleUploadRemark.trim()
        );
      }

      const targetOwner = ensureRes.owner;
      const targetRepo = ensureRes.repo;

      setLoadingText(`正在提取项目文件并提交推送至私人仓库: ${targetOwner}/${targetRepo}...`);

      // 2. Fetch all project files from local IndexedDB cache (full source code, 100% complete)
      let payloadFiles: CachedFile[] = await localCache.getProjectFiles(singleUploadTargetRepo.id);

      if (payloadFiles.length === 0) {
        // If local cache was purged or missing, fetch full project snapshot from source and cache it
        setLoadingText(`正在从源仓库完整下载项目所有源码文件并载入本地缓存...`);
        try {
          let freshData: any = null;
          try {
            freshData = await safeFetchJson('/api/github/fetch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: singleUploadTargetRepo.url,
                branch: singleUploadTargetRepo.branch || 'main',
                token: singleUploadTargetRepo.token || globalToken
              })
            });
          } catch {
            freshData = await githubClient.fetchRepo(
              singleUploadTargetRepo.url,
              singleUploadTargetRepo.branch || 'main',
              singleUploadTargetRepo.token || globalToken
            );
          }

          if (freshData.files && freshData.files.length > 0) {
            await localCache.saveProjectFiles(singleUploadTargetRepo.id, freshData.files);
            payloadFiles = freshData.files;
          }
        } catch (fetchErr) {
          console.warn('Could not re-fetch full files:', fetchErr);
        }
      }

      setLoadingText(`正在将完整项目 (共全部 ${payloadFiles.length} 个文件) 提交推送至私人仓库: ${targetOwner}/${targetRepo}...`);

      // 3. Push complete project to newly created private repo (Dual-channel)
      let pushRes: any = null;
      try {
        pushRes = await safeFetchJson('/api/github/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetOwner,
            targetRepo,
            targetBranch: 'main',
            token,
            files: payloadFiles,
            commitMessage: `Initial private backup from GitVault: ${singleUploadRemark.trim() || singleUploadTargetRepo.repo}`,
            description: singleUploadDescription.trim(),
            remark: singleUploadRemark.trim(),
            originalSourceUrl: singleUploadTargetRepo.url
          })
        });
      } catch (proxyErr) {
        pushRes = await githubClient.push(
          targetOwner,
          targetRepo,
          'main',
          token,
          payloadFiles,
          `Initial private backup from GitVault: ${singleUploadRemark.trim() || singleUploadTargetRepo.repo}`,
          singleUploadDescription.trim(),
          singleUploadRemark.trim(),
          singleUploadTargetRepo.url
        );
      }

      // Purge cache if requested
      if (singleUploadPurgeCache) {
        await localCache.deleteProjectFiles(singleUploadTargetRepo.id);
      }

      // Update repo in state
      setRepos(prev => prev.map(r => {
        if (r.id === singleUploadTargetRepo.id) {
          return {
            ...r,
            remark: singleUploadRemark.trim() || r.remark,
            description: singleUploadDescription.trim(),
            privateRepoUrl: ensureRes.htmlUrl,
            lastUploadedToPrivateAt: new Date().toISOString(),
            isCachePurged: singleUploadPurgeCache ? true : r.isCachePurged,
            cachedFilesCount: singleUploadPurgeCache ? 0 : payloadFiles.length,
            tree: singleUploadPurgeCache ? [] : r.tree
          };
        }
        return r;
      }));

      setIsSingleUploadModalOpen(false);
      const uploadedCount = pushRes.uploadedFilesCount || payloadFiles.length;
      alert(`🎉 项目已成功完整上传至您的个人私人仓库！\n共完整上传全部 ${uploadedCount} 个文件。\n仓库地址: ${ensureRes.htmlUrl}\n项目备注与详细描述已同步写入。${singleUploadPurgeCache ? '\n已按您的设定释放本地缓存，随时可重新拉取！' : ''}`);
    } catch (err: any) {
      alert('上传至私人仓库失败: ' + err.message);
    } finally {
      setIsUploadingToPrivate(false);
      setIsLoading(false);
    }
  };

  // Traditional Push / Upload to custom target
  const handlePushProjectToGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRepo || !pushTargetRepo.trim()) return;

    let cleanTarget = pushTargetRepo.trim().replace(/\/$/, '');
    if (cleanTarget.startsWith('https://github.com/')) {
      cleanTarget = cleanTarget.replace('https://github.com/', '');
    }
    const parts = cleanTarget.split('/');
    if (parts.length < 2) {
      alert('目标仓库格式错误，请使用 owner/repo 格式');
      return;
    }
    const targetOwner = parts[0];
    const targetRepo = parts[1];
    const tokenToUse = pushToken.trim() || activeRepo.token || globalToken;

    if (!tokenToUse) {
      alert('请提供有效的 GitHub Token (可在全局设置中配置或在此输入)');
      return;
    }

    setIsLoading(true);
    setLoadingText('正在获取本地缓存完整代码文件并推送到目标 GitHub 仓库...');
    setIsPushModalOpen(false);

    try {
      let payloadFiles: CachedFile[] = await localCache.getProjectFiles(activeRepo.id);

      if (payloadFiles.length === 0) {
        setLoadingText('正在从源仓库完整下载文件快照并载入本地缓存...');
        try {
          let freshData: any = null;
          try {
            freshData = await safeFetchJson('/api/github/fetch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: activeRepo.url,
                branch: activeRepo.branch,
                token: tokenToUse
              })
            });
          } catch {
            freshData = await githubClient.fetchRepo(activeRepo.url, activeRepo.branch, tokenToUse);
          }
          if (freshData.files && freshData.files.length > 0) {
            await localCache.saveProjectFiles(activeRepo.id, freshData.files);
            payloadFiles = freshData.files;
          }
        } catch {}
      }

      let data: any = null;
      try {
        data = await safeFetchJson('/api/github/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetOwner,
            targetRepo,
            targetBranch: pushTargetBranch.trim() || 'main',
            token: tokenToUse,
            files: payloadFiles,
            commitMessage: pushCommitMsg.trim() || `Upload project ${activeRepo.repo} via GitVault`,
            description: activeRepo.description,
            remark: activeRepo.remark,
            originalSourceUrl: activeRepo.url
          })
        });
      } catch (proxyErr) {
        data = await githubClient.push(
          targetOwner,
          targetRepo,
          pushTargetBranch.trim() || 'main',
          tokenToUse,
          payloadFiles,
          pushCommitMsg.trim() || `Upload project ${activeRepo.repo} via GitVault`,
          activeRepo.description,
          activeRepo.remark,
          activeRepo.url
        );
      }

      // Purge local cache if user opted-in
      if (purgePushCacheOption) {
        await localCache.deleteProjectFiles(activeRepo.id);
        if (pushBackupTarget) {
          setRepos(prev => prev.map(r => {
            if (r.id === activeRepo.id) {
              const updated = r.backups.map(b => b.id === pushBackupTarget.id ? { ...b, isCachePurged: true, tree: [] } : b);
              return { ...r, backups: updated };
            }
            return r;
          }));
        } else {
          setRepos(prev => prev.map(r => {
            if (r.id === activeRepo.id) {
              return { ...r, isCachePurged: true, cachedFilesCount: 0, tree: [] };
            }
            return r;
          }));
          setSelectedFilePath(null);
          setFileContent(null);
        }
      }

      alert(`项目已成功独立上传/推送至目标仓库！\n共完整上传 ${data.uploadedFilesCount || payloadFiles.length} 个文件\n访问地址: ${data.htmlUrl}${purgePushCacheOption ? '\n\n已按您的设置自动释放本地大文件缓存以节省空间。软件内已完整保留项目元数据与历史记录，可随时从 GitHub 重新拉取还原（同源互通）！' : ''}`);
      setPushTargetRepo('');
      setPushToken('');
      setPushCommitMsg('');
      setPushBackupTarget(null);
    } catch (err: any) {
      alert('上传推送失败: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOneClickUpdate = async (repo: TrackedRepo) => {
    setIsLoading(true);
    setLoadingText(`正在一键更新项目 ${repo.repo} 并自动归档旧版...`);
    setErrorMsg('');

    try {
      const tokenToUse = repo.token || globalToken;
      const data = await safeFetchJson('/api/github/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `https://github.com/${repo.owner}/${repo.repo}`,
          branch: repo.branch,
          token: tokenToUse
        })
      });

      const isNewCommit = data.latestCommitSha !== repo.latestCommitSha;

      setRepos(prev => prev.map(item => {
        if (item.id === repo.id) {
          let updatedBackups = [...item.backups];
          if (isNewCommit) {
            const newBackupNum = updatedBackups.length + 1;
            const backup: BackupVersion = {
              id: `backup-${Date.now()}`,
              versionNumber: newBackupNum,
              tag: `v${newBackupNum}.0-backup`,
              annotation: `自动归档版本: ${item.commitMessage.slice(0, 30) || '自动同步备份'}`,
              commitSha: item.latestCommitSha,
              commitMessage: item.commitMessage,
              commitAuthor: item.commitAuthor,
              commitDate: item.commitDate,
              backedUpAt: new Date().toISOString(),
              tree: item.tree,
              isCachePurged: false
            };
            updatedBackups = [backup, ...updatedBackups];
          }

          return {
            ...item,
            latestCommitSha: data.latestCommitSha,
            commitMessage: data.commitMessage,
            commitAuthor: data.commitAuthor,
            commitDate: data.commitDate,
            lastSyncedAt: new Date().toISOString(),
            repoMeta: data.repoMeta,
            tree: data.tree,
            backups: updatedBackups,
            hasUpdate: false,
            latestRemoteCommit: undefined,
            lastCheckedAt: new Date().toISOString(),
            isCachePurged: false
          };
        }
        return item;
      }));

      alert(isNewCommit ? '一键更新成功！旧版本已自动归档备份并标记。' : '当前项目已是最新版本，无需更新。');
    } catch (err: any) {
      alert('一键更新出错: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteRepo = (repoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('确定要移除该链接项目吗？本地记录与备份将被清除。')) {
      localCache.deleteProjectFiles(repoId);
      setRepos(prev => prev.filter(r => r.id !== repoId));
      setSelectedProjectIds(prev => prev.filter(id => id !== repoId));
      if (activeRepoId === repoId) {
        setActiveRepoId(null);
        setCurrentView('projects');
      }
    }
  };

  // ================= BATCH OPERATIONS ON PROJECTS =================
  const handleToggleSelectProject = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedProjectIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSelectAllProjects = () => {
    if (selectedProjectIds.length === filteredRepos.length) {
      setSelectedProjectIds([]);
    } else {
      setSelectedProjectIds(filteredRepos.map(r => r.id));
    }
  };

  const handleInvertSelectProjects = () => {
    const currentSet = new Set(selectedProjectIds);
    const inverted = filteredRepos.filter(r => !currentSet.has(r.id)).map(r => r.id);
    setSelectedProjectIds(inverted);
  };

  const handleClearSelectProjects = () => {
    setSelectedProjectIds([]);
  };

  // Batch Delete Projects
  const handleBatchDeleteProjects = () => {
    if (selectedProjectIds.length === 0) return;
    if (confirm(`确定要批量删除选中的 ${selectedProjectIds.length} 个项目吗？本地记录与文件将被移除。`)) {
      selectedProjectIds.forEach(id => localCache.deleteProjectFiles(id));
      setRepos(prev => prev.filter(r => !selectedProjectIds.includes(r.id)));
      if (activeRepoId && selectedProjectIds.includes(activeRepoId)) {
        setActiveRepoId(null);
        setCurrentView('projects');
      }
      setSelectedProjectIds([]);
    }
  };

  // Open Batch Add Tag Modal
  const handleOpenBatchTagModal = () => {
    if (selectedProjectIds.length === 0) return;
    setBatchTagInput('');
    setIsBatchTagModalOpen(true);
  };

  // Confirm Batch Add Tags
  const handleConfirmBatchAddTags = (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchTagInput.trim()) return;

    const newTags = batchTagInput.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
    if (newTags.length === 0) return;

    setRepos(prev => prev.map(r => {
      if (selectedProjectIds.includes(r.id)) {
        const merged = Array.from(new Set([...r.tags, ...newTags]));
        return { ...r, tags: merged };
      }
      return r;
    }));

    setIsBatchTagModalOpen(false);
    alert(`成功为选中的 ${selectedProjectIds.length} 个项目批量添加标签: ${newTags.join(', ')}`);
  };

  // Open Batch Upload Modal
  const handleOpenBatchUploadModal = () => {
    if (selectedProjectIds.length === 0) return;
    const selectedRepos = repos.filter(r => selectedProjectIds.includes(r.id));
    const initialList: BatchUploadItemStatus[] = selectedRepos.map(r => ({
      id: r.id,
      name: r.repo,
      repo: r.repo,
      status: 'pending'
    }));
    setBatchUploadStatusList(initialList);
    setIsBatchUploadModalOpen(true);
  };

  // Execute Batch Upload to User's GitHub Private Repositories
  const handleStartBatchUpload = async () => {
    let token = globalToken;
    if (!token) {
      const entered = prompt('批量上传至个人私人仓库需要 GitHub Token (PAT)，请输入：');
      if (!entered) return;
      token = entered.trim();
    }

    const selectedRepos = repos.filter(r => selectedProjectIds.includes(r.id));
    setIsBatchUploading(true);

    const updatedReposMap = new Map<string, Partial<TrackedRepo>>();

    for (let i = 0; i < selectedRepos.length; i++) {
      const target = selectedRepos[i];

      // Update status to creating
      setBatchUploadStatusList(prev => prev.map((item, idx) =>
        idx === i ? { ...item, status: 'creating' } : item
      ));

      try {
        const tokenToUse = target.token || token;

        // 1. Ensure private repo on user's GitHub account (Dual-channel)
        let ensureRes: any = null;
        try {
          ensureRes = await safeFetchJson('/api/github/ensure-private-repo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token: tokenToUse,
              repoName: target.repo,
              description: target.description || target.repoMeta?.description || '',
              remark: target.remark
            })
          });
        } catch {
          ensureRes = await githubClient.ensurePrivateRepo(
            tokenToUse,
            target.repo,
            target.description || target.repoMeta?.description || '',
            target.remark
          );
        }

        // 2. Fetch full project files from local cache
        setBatchUploadStatusList(prev => prev.map((item, idx) =>
          idx === i ? { ...item, status: 'uploading' } : item
        ));

        let payloadFiles: CachedFile[] = await localCache.getProjectFiles(target.id);
        if (payloadFiles.length === 0) {
          try {
            let freshData: any = null;
            try {
              freshData = await safeFetchJson('/api/github/fetch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  url: target.url,
                  branch: target.branch || 'main',
                  token: tokenToUse
                })
              });
            } catch {
              freshData = await githubClient.fetchRepo(target.url, target.branch || 'main', tokenToUse);
            }

            if (freshData.files && freshData.files.length > 0) {
              await localCache.saveProjectFiles(target.id, freshData.files);
              payloadFiles = freshData.files;
            }
          } catch {}
        }

        // 3. Push complete project to private repo (Dual-channel)
        try {
          await safeFetchJson('/api/github/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetOwner: ensureRes.owner,
              targetRepo: ensureRes.repo,
              targetBranch: 'main',
              token: tokenToUse,
              files: payloadFiles,
              commitMessage: `Batch uploaded via GitVault: ${target.remark || target.repo}`,
              description: target.description || target.repoMeta?.description || '',
              remark: target.remark,
              originalSourceUrl: target.url
            })
          });
        } catch {
          await githubClient.push(
            ensureRes.owner,
            ensureRes.repo,
            'main',
            tokenToUse,
            payloadFiles,
            `Batch uploaded via GitVault: ${target.remark || target.repo}`,
            target.description || target.repoMeta?.description || '',
            target.remark,
            target.url
          );
        }

        updatedReposMap.set(target.id, {
          privateRepoUrl: ensureRes.htmlUrl,
          lastUploadedToPrivateAt: new Date().toISOString(),
          cachedFilesCount: payloadFiles.length
        });

        setBatchUploadStatusList(prev => prev.map((item, idx) =>
          idx === i ? { ...item, status: 'success', htmlUrl: ensureRes.htmlUrl } : item
        ));
      } catch (err: any) {
        setBatchUploadStatusList(prev => prev.map((item, idx) =>
          idx === i ? { ...item, status: 'error', error: err.message || '上传失败' } : item
        ));
      }
    }

    // Apply updates to repos state
    if (updatedReposMap.size > 0) {
      setRepos(prev => prev.map(r => {
        if (updatedReposMap.has(r.id)) {
          return { ...r, ...updatedReposMap.get(r.id)! };
        }
        return r;
      }));
    }

    setIsBatchUploading(false);
  };

  // Batch Purge Local Cache for selected projects
  const handleBatchPurgeCache = () => {
    if (selectedProjectIds.length === 0) return;
    if (confirm(`确定要释放选中的 ${selectedProjectIds.length} 个项目的本地文件缓存吗？\n软件内将完整保留项目名称、备注、描述、标签与归档记录，云端数据保持不变，随时可一键重新拉取还原！`)) {
      setRepos(prev => prev.map(r => {
        if (selectedProjectIds.includes(r.id)) {
          return { ...r, isCachePurged: true, tree: [] };
        }
        return r;
      }));
      alert(`已成功释放 ${selectedProjectIds.length} 个项目的本地缓存空间！`);
      setSelectedProjectIds([]);
    }
  };

  // Selection Experience Enhancements for Backups
  const handleToggleSelectBackup = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedBackupIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSelectAllBackups = () => {
    if (!activeRepo) return;
    if (selectedBackupIds.length === activeRepo.backups.length) {
      setSelectedBackupIds([]);
    } else {
      setSelectedBackupIds(activeRepo.backups.map(b => b.id));
    }
  };

  const handleInvertSelectBackups = () => {
    if (!activeRepo) return;
    const currentSet = new Set(selectedBackupIds);
    const inverted = activeRepo.backups.filter(b => !currentSet.has(b.id)).map(b => b.id);
    setSelectedBackupIds(inverted);
  };

  const handleSelectUnreleasedBackups = () => {
    if (!activeRepo) return;
    const unreleased = activeRepo.backups.filter(b => !b.isReleased).map(b => b.id);
    setSelectedBackupIds(unreleased);
  };

  const handleClearSelectBackups = () => {
    setSelectedBackupIds([]);
  };

  // Open Batch Release Modal
  const handleOpenBatchReleaseModal = () => {
    if (!activeRepo || selectedBackupIds.length === 0) return;
    const initialList: BatchReleaseItemStatus[] = activeRepo.backups
      .filter(b => selectedBackupIds.includes(b.id))
      .map(b => ({
        id: b.id,
        tag: b.tag,
        status: 'pending'
      }));
    setBatchReleaseProgress(initialList);
    setIsBatchReleaseModalOpen(true);
  };

  // Execute Batch Release
  const handleStartBatchPublish = async () => {
    if (!activeRepo) return;
    let token = activeRepo.token || globalToken;
    if (!token) {
      const entered = prompt('请输入您的 GitHub Personal Access Token (PAT)：');
      if (!entered) return;
      token = entered.trim();
    }

    const selectedBackups = activeRepo.backups.filter(b => selectedBackupIds.includes(b.id));
    setIsBatchPublishing(true);

    let successCount = 0;
    const updatedBackups = [...activeRepo.backups];

    for (let i = 0; i < selectedBackups.length; i++) {
      const b = selectedBackups[i];
      setBatchReleaseProgress(prev => prev.map((item, idx) =>
        idx === i ? { ...item, status: 'releasing' } : item
      ));

      try {
        const releaseBody = `## 🚀 GitVault 自动归档版本: ${b.tag}\n\n- **提交信息**: ${b.commitMessage}\n- **提交作者**: ${b.commitAuthor}\n- **归档时间**: ${new Date(b.backedUpAt).toLocaleString()}\n- **Commit SHA**: \`${b.commitSha}\`\n\n> 本 Release 由 GitVault 批量发布中心自动生成。`;
        const res = await safeFetchJson('/api/github/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner: activeRepo.owner,
            repo: activeRepo.repo,
            tagName: b.tag,
            releaseName: `${batchReleaseTitlePrefix.trim()} ${b.tag}`,
            body: releaseBody,
            token
          })
        });

        const targetIdx = updatedBackups.findIndex(x => x.id === b.id);
        if (targetIdx !== -1) {
          updatedBackups[targetIdx] = {
            ...updatedBackups[targetIdx],
            isReleased: true,
            releaseUrl: res.releaseUrl,
            isCachePurged: purgeCacheOption ? true : updatedBackups[targetIdx].isCachePurged,
            tree: purgeCacheOption ? [] : updatedBackups[targetIdx].tree
          };
        }

        setBatchReleaseProgress(prev => prev.map((item, idx) =>
          idx === i ? { ...item, status: 'success', releaseUrl: res.releaseUrl } : item
        ));
        successCount++;
      } catch (err: any) {
        setBatchReleaseProgress(prev => prev.map((item, idx) =>
          idx === i ? { ...item, status: 'error', error: err.message || '发布失败' } : item
        ));
      }
    }

    // Save updated backups to state
    setRepos(prev => prev.map(r => {
      if (r.id === activeRepo.id) {
        return { ...r, backups: updatedBackups };
      }
      return r;
    }));

    setIsBatchPublishing(false);
  };

  // Purge local cache for single backup
  const handlePurgeBackupCache = (backupId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!activeRepo) return;
    if (confirm('确认销毁此归档版本的本地文件大缓存？\n软件内将完整保留版本标签、提交记录、SHA 与发布链接，云端保持不变，可随时同源拉取还原。')) {
      setRepos(prev => prev.map(r => {
        if (r.id === activeRepo.id) {
          const updated = r.backups.map(b => b.id === backupId ? { ...b, isCachePurged: true, tree: [] } : b);
          return { ...r, backups: updated };
        }
        return r;
      }));
    }
  };

  // Purge local cache for the active project
  const handlePurgeProjectCache = async (repoId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (confirm('确认销毁该项目的本地文件大缓存？\n销毁后将释放本地空间，GitVault 会完整保留项目名称、备注、描述、标签及归档元数据，随时可一键从 GitHub 重新拉取还原（同源互通）！')) {
      await localCache.deleteProjectFiles(repoId);
      setRepos(prev => prev.map(r => {
        if (r.id === repoId) {
          return { ...r, isCachePurged: true, cachedFilesCount: 0, tree: [] };
        }
        return r;
      }));
      if (activeRepoId === repoId) {
        setSelectedFilePath(null);
        setFileContent(null);
      }
    }
  };

  // Re-pull and restore cache from GitHub for a project
  const handleRepullProjectCache = async (repoId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const repo = repos.find(r => r.id === repoId);
    if (!repo) return;

    setIsLoading(true);
    setLoadingText(`正在从 GitHub 重新拉取项目 ${repo.repo} 完整文件树并还原本地缓存...`);

    try {
      const tokenToUse = repo.token || globalToken;
      const data = await safeFetchJson('/api/github/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: repo.url,
          branch: repo.branch,
          token: tokenToUse
        })
      });

      if (data.files && data.files.length > 0) {
        await localCache.saveProjectFiles(repoId, data.files);
      }

      setRepos(prev => prev.map(r => {
        if (r.id === repoId) {
          return {
            ...r,
            tree: data.tree,
            latestCommitSha: data.latestCommitSha,
            commitMessage: data.commitMessage,
            commitAuthor: data.commitAuthor,
            commitDate: data.commitDate,
            lastSyncedAt: new Date().toISOString(),
            isCachePurged: false,
            cachedFilesCount: data.files ? data.files.length : r.cachedFilesCount
          };
        }
        return r;
      }));

      alert(`🎉 项目 ${repo.repo} 完整源码已成功从 GitHub 重新拉取！\n本地缓存已还原（共 ${data.files ? data.files.length : 0} 个文件），支持离线查看。`);
    } catch (err: any) {
      alert('重新拉取还原失败: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // File viewing logic (Checks local IndexedDB cache first for 0ms offline display)
  const handleSelectFile = async (filePath: string) => {
    if (!activeRepo) return;
    setSelectedFilePath(filePath);
    setFileLoading(true);
    setFileContent(null);
    setMobileFileView('view');

    try {
      // 1. Try reading from local IndexedDB cache first
      const cached = await localCache.getProjectFile(activeRepo.id, filePath);
      if (cached) {
        setFileContent(cached.content);
        setFileContentType(cached.isBase64 ? 'base64' : 'text');
        setFileLoading(false);
        return;
      }

      // 2. Fall back to remote API
      const tokenToUse = activeRepo.token || globalToken;
      const data = await safeFetchJson('/api/github/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: activeRepo.owner,
          repo: activeRepo.repo,
          path: filePath,
          token: tokenToUse || undefined
        })
      });

      setFileContent(data.content);
      setFileContentType(data.type);
    } catch (err: any) {
      setFileContent(`读取文件失败: ${err.message}`);
      setFileContentType('text');
    } finally {
      setFileLoading(false);
    }
  };

  // AI Changelog generation
  const handleGenerateChangelog = async () => {
    if (!activeRepo) return;
    setAiLoading(true);

    try {
      const data = await safeFetchJson('/api/ai/changelog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoName: activeRepo.repo,
          oldCommitMsg: activeRepo.backups[0]?.commitMessage || '初始版本',
          newCommitMsg: activeRepo.commitMessage,
          fileChangesCount: activeRepo.tree.length
        })
      });

      setRepos(prev => prev.map(r => {
        if (r.id === activeRepo.id) {
          return { ...r, aiChangelog: data.changelog };
        }
        return r;
      }));
    } catch (err) {
      console.error('Changelog failed:', err);
    } finally {
      setAiLoading(false);
    }
  };

  // Compare diff between backup and current
  const computeDiff = (backup: BackupVersion, currentTree: RepoTreeItem[]) => {
    const backupPaths = new Set(backup.tree.map(i => i.path));
    const currentPaths = new Set(currentTree.map(i => i.path));
    const backupMap = new Map(backup.tree.map(i => [i.path, i.sha]));
    const currentMap = new Map(currentTree.map(i => [i.path, i.sha]));

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];

    currentPaths.forEach(path => {
      if (!backupPaths.has(path)) {
        added.push(path);
      } else if (backupMap.get(path) !== currentMap.get(path)) {
        modified.push(path);
      }
    });

    backupPaths.forEach(path => {
      if (!currentPaths.has(path)) {
        removed.push(path);
      }
    });

    return { added, removed, modified };
  };

  const allTags = Array.from(new Set(repos.flatMap(r => r.tags)));

  // Global search filtering across Project Name, Owner, Remark, Description, and Tags
  const filteredRepos = repos.filter(repo => {
    const q = searchFilter.toLowerCase();
    const matchSearch =
      repo.repo.toLowerCase().includes(q) ||
      repo.owner.toLowerCase().includes(q) ||
      (repo.remark && repo.remark.toLowerCase().includes(q)) ||
      (repo.description && repo.description.toLowerCase().includes(q)) ||
      (repo.repoMeta?.description && repo.repoMeta.description.toLowerCase().includes(q)) ||
      repo.tags.some(t => t.toLowerCase().includes(q));

    const matchTag = selectedTagFilter === 'all' || repo.tags.includes(selectedTagFilter);
    return matchSearch && matchTag;
  });

  const activeTree = viewingBackup ? viewingBackup.tree : (activeRepo?.tree || []);
  const heatmapData = useMemo(() => {
    if (!activeTree || activeTree.length === 0) return [];

    const moduleMap = new Map<string, { size: number; files: Array<{ name: string; path: string; size: number }> }>();

    activeTree.forEach(item => {
      if (item.type === 'blob') {
        const parts = item.path.split('/');
        let moduleName = '根目录 (root)';
        let fileName = parts[parts.length - 1];

        if (parts.length > 1) {
          moduleName = parts.slice(0, parts.length - 1).join('/');
        }

        const fileSize = item.size && item.size > 0 ? item.size : 1024;

        if (!moduleMap.has(moduleName)) {
          moduleMap.set(moduleName, { size: 0, files: [] });
        }
        const currentMod = moduleMap.get(moduleName)!;
        currentMod.size += fileSize;
        currentMod.files.push({
          name: fileName,
          path: item.path,
          size: fileSize,
        });
      }
    });

    const nodes: Array<{ name: string; size: number; formattedSize: string; color: string; path?: string }> = [];
    let colorIdx = 0;

    moduleMap.forEach((val, key) => {
      nodes.push({
        name: key,
        size: val.size,
        formattedSize: formatFileSize(val.size),
        color: MORANDI_HEATMAP_COLORS[colorIdx % MORANDI_HEATMAP_COLORS.length],
        path: val.files[0]?.path,
      });
      colorIdx++;
    });

    return nodes.sort((a, b) => b.size - a.size);
  }, [activeTree]);

  const totalProjectSize = useMemo(() => {
    return activeTree.reduce((acc, item) => acc + (item.size || 0), 0);
  }, [activeTree]);

  // Available directories for Custom Folder Download
  const availableFolders = useMemo(() => {
    if (!projectSettingsTarget || !projectSettingsTarget.tree) return ['/'];
    const folderSet = new Set<string>();
    folderSet.add('/'); // Root folder

    projectSettingsTarget.tree.forEach(item => {
      if (item.type === 'tree') {
        folderSet.add(item.path);
      } else if (item.type === 'blob') {
        const parts = item.path.split('/');
        if (parts.length > 1) {
          let current = '';
          for (let i = 0; i < parts.length - 1; i++) {
            current = current ? `${current}/${parts[i]}` : parts[i];
            folderSet.add(current);
          }
        }
      }
    });

    return Array.from(folderSet).sort();
  }, [projectSettingsTarget]);

  // Files in selected folder
  const filesInSelectedFolder = useMemo(() => {
    if (!projectSettingsTarget || !projectSettingsTarget.tree) return [];
    if (selectedFolderToDownload === '/') {
      return projectSettingsTarget.tree.filter(t => t.type === 'blob');
    }
    return projectSettingsTarget.tree.filter(
      t => t.type === 'blob' && (t.path === selectedFolderToDownload || t.path.startsWith(selectedFolderToDownload + '/'))
    );
  }, [projectSettingsTarget, selectedFolderToDownload]);

  const folderTotalSize = useMemo(() => {
    return filesInSelectedFolder.reduce((sum, item) => sum + (item.size || 0), 0);
  }, [filesInSelectedFolder]);

  // Download custom selected folder as zip formatted for APK / mobile export
  const handleDownloadSelectedFolder = async () => {
    if (!projectSettingsTarget || filesInSelectedFolder.length === 0) return;
    setIsDownloadingFolder(true);
    setIsLoading(true);
    setLoadingText(`正在为 APK/移动端 打包自选文件夹 [${selectedFolderToDownload}] (共 ${filesInSelectedFolder.length} 个文件)...`);

    try {
      const zip = new JSZip();
      const cleanFolderName = selectedFolderToDownload === '/' ? 'root' : selectedFolderToDownload.replace(/\//g, '_');
      const zipRootFolderName = `${projectSettingsTarget.repo}-${cleanFolderName}`;
      const rootZipFolder = zip.folder(zipRootFolderName);

      let fetchedCount = 0;
      const filesToFetch = filesInSelectedFolder.slice(0, 100);

      for (const file of filesToFetch) {
        try {
          const data = await safeFetchJson('/api/github/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              owner: projectSettingsTarget.owner,
              repo: projectSettingsTarget.repo,
              path: file.path,
              token: projectSettingsTarget.token || globalToken
            })
          });
          let relPath = file.path;
          if (selectedFolderToDownload !== '/' && file.path.startsWith(selectedFolderToDownload + '/')) {
            relPath = file.path.slice(selectedFolderToDownload.length + 1);
          }
          if (data.type === 'text') {
            rootZipFolder?.file(relPath, data.content);
          } else if (data.type === 'base64') {
            rootZipFolder?.file(relPath, data.content, { base64: true });
          }
          fetchedCount++;
        } catch {}
      }

      // Add APK / Mobile export manifest
      if (includeApkManifest) {
        const manifest = {
          app: 'GitVault',
          environment: 'Android APK / Mobile Offline Package',
          repository: `${projectSettingsTarget.owner}/${projectSettingsTarget.repo}`,
          branch: projectSettingsTarget.branch,
          commitSha: projectSettingsTarget.latestCommitSha,
          selectedFolder: selectedFolderToDownload,
          targetApkStoragePath: apkTargetDirectory.trim() || `Download/GitVault/${projectSettingsTarget.repo}/${cleanFolderName}/`,
          exportedAt: new Date().toISOString(),
          totalFilesCount: fetchedCount,
          files: filesToFetch.map(f => ({
            path: f.path,
            size: f.size || 0,
            sha: f.sha
          }))
        };
        rootZipFolder?.file('gitvault-apk-manifest.json', JSON.stringify(manifest, null, 2));
      }

      rootZipFolder?.file('GITVAULT_EXPORT_INFO.txt', `GitVault Folder Export
Repository: https://github.com/${projectSettingsTarget.owner}/${projectSettingsTarget.repo}
Selected Folder: ${selectedFolderToDownload}
Target Storage Path (APK): ${apkTargetDirectory || `Download/GitVault/${projectSettingsTarget.repo}/`}
Export Time: ${new Date().toISOString()}
Total Files: ${fetchedCount}
Note: 此压缩包可直接解压至手机文件管理器或 APK 存储目录中使用，或供 APK 内置离线资源包读取。
`);

      const blobContent = await zip.generateAsync({ type: 'blob' });
      const blobUrl = URL.createObjectURL(blobContent);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${projectSettingsTarget.repo}-${cleanFolderName}-apk-export.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);

      alert(`自选文件夹 [${selectedFolderToDownload}] 打包下载成功！\n成功提取 ${fetchedCount} 个文件，已适配移动端/APK离线目录规范。`);
    } catch (err: any) {
      alert('打包下载文件夹失败: ' + err.message);
    } finally {
      setIsDownloadingFolder(false);
      setIsLoading(false);
    }
  };

  const CustomizedTreemapContent = (props: any) => {
    const { x, y, width, height, index, name, size, formattedSize, color, path } = props;
    if (width < 25 || height < 20) return null;

    const blockColor = color || MORANDI_HEATMAP_COLORS[index % MORANDI_HEATMAP_COLORS.length];

    return (
      <g
        onClick={() => {
          if (path) {
            handleSelectFile(path);
            setFileViewMode('explorer');
          }
        }}
        className="group cursor-pointer"
      >
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          style={{
            fill: blockColor,
            stroke: '#FAF8F5',
            strokeWidth: 2,
            rx: 6,
            ry: 6,
            opacity: 0.9,
            transition: 'opacity 0.2s',
          }}
          className="hover:opacity-100"
        />
        {width > 55 && height > 30 && (
          <>
            <text
              x={x + 7}
              y={y + 17}
              fill="#2E2B27"
              fontSize={11}
              fontWeight={600}
              fontFamily="monospace"
              className="select-none pointer-events-none"
            >
              {name ? (name.length > 14 ? name.slice(0, 12) + '…' : name) : ''}
            </text>
            <text
              x={x + 7}
              y={y + 31}
              fill="#524D44"
              fontSize={10}
              fontFamily="monospace"
              className="select-none pointer-events-none"
            >
              {formattedSize || (size ? formatFileSize(size) : '')}
            </text>
          </>
        )}
      </g>
    );
  };

  return (
    <div className="min-h-screen bg-[#F8F6F1] text-[#2E2B27] flex flex-col font-sans selection:bg-[#9CB09D] selection:text-white pb-24 md:pb-20">
      {/* Top Navbar */}
      <header className="border-b border-[#E5DFD7] bg-[#FFFFFF]/90 backdrop-blur sticky top-0 z-30 px-4 md:px-8 py-3 flex flex-row items-center justify-between shadow-xs">
        <div className="flex flex-row items-center gap-4 md:gap-8">
          <div
            className="flex flex-row items-center gap-3 cursor-pointer group"
            onClick={() => { setCurrentView('dashboard'); setActiveRepoId(null); setViewingBackup(null); }}
          >
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-[#8E9F8B] via-[#A3B4A0] to-[#C7A39B] flex items-center justify-center shadow-sm text-white font-serif font-bold text-lg tracking-wide border border-[#8E9F8B]/40 group-hover:scale-105 transition shrink-0">
              GV
            </div>
            {/* Perfectly stacked: 智能管家 aligned directly underneath GitVault */}
            <div className="flex flex-col items-start justify-center">
              <span className="text-base md:text-lg font-bold tracking-tight text-[#2B2723] font-serif leading-none whitespace-nowrap">
                GitVault
              </span>
              <span className="text-[11px] text-[#5D6F5A] font-medium tracking-wide mt-1 leading-none whitespace-nowrap">
                智能管家
              </span>
            </div>
          </div>

          {/* Desktop Navigation - Strictly single horizontal row */}
          <nav className="hidden md:flex flex-row items-center gap-1.5 bg-[#EFECE6]/80 p-1 rounded-xl border border-[#DFD8CE] whitespace-nowrap">
            <button
              onClick={() => { setCurrentView('dashboard'); setActiveRepoId(null); setViewingBackup(null); }}
              className={`flex flex-row items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition ${
                currentView === 'dashboard'
                  ? 'bg-[#FFFFFF] text-[#2E2B27] shadow-xs'
                  : 'text-[#6B6358] hover:text-[#2E2B27] hover:bg-[#EAE4DB]'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
              <span>主页面 (Dashboard)</span>
            </button>
            <button
              onClick={() => { setCurrentView('projects'); setActiveRepoId(null); setViewingBackup(null); }}
              className={`flex flex-row items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition ${
                currentView === 'projects' || currentView === 'workbench'
                  ? 'bg-[#FFFFFF] text-[#2E2B27] shadow-xs'
                  : 'text-[#6B6358] hover:text-[#2E2B27] hover:bg-[#EAE4DB]'
              }`}
            >
              <FolderGit2 className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
              <span>仓库已有项目 ({repos.length})</span>
            </button>
          </nav>
        </div>

        {/* Right Actions - Single horizontal line */}
        <div className="flex flex-row items-center gap-2.5 whitespace-nowrap">
          {/* Quick Connection Test Button */}
          <button
            onClick={() => handleTestGitHubConnection(globalToken)}
            disabled={testStatus === 'testing'}
            className="hidden sm:flex flex-row items-center gap-1.5 px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] shadow-xs transition disabled:opacity-50 whitespace-nowrap shrink-0"
            title="一键测试当前配置的 GitHub Token 连通性与 API 额度"
          >
            {testStatus === 'testing' ? (
              <Loader2 className="w-3.5 h-3.5 text-[#8E9F8B] animate-spin shrink-0" />
            ) : (
              <Wifi className="w-3.5 h-3.5 text-[#5D6F5A] shrink-0" />
            )}
            <span>测试连接</span>
          </button>

          <button
            onClick={() => setIsAddModalOpen(true)}
            className="flex flex-row items-center gap-1.5 px-3.5 py-1.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 text-white rounded-xl text-xs font-semibold shadow-xs transition whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span>新建链接/拉取项目</span>
          </button>

          <button
            onClick={() => setIsSettingsModalOpen(true)}
            className="p-2 bg-[#FFFFFF] hover:bg-[#F5F2EB] text-[#554F45] rounded-xl border border-[#DFD8CE] shadow-xs transition shrink-0"
            title="系统设置、备份恢复与 APK 本地目录"
          >
            <Settings className="w-4 h-4 shrink-0" />
          </button>
        </div>
      </header>

      {/* Global Connection Test Result Banner */}
      {testStatus === 'success' && (
        <div className="bg-[#8E9F8B]/20 border-b border-[#8E9F8B]/30 px-4 md:px-8 py-2 flex flex-row items-center justify-between text-xs text-[#2B3B28] whitespace-nowrap">
          <div className="flex flex-row items-center gap-2 truncate">
            <CheckCircle className="w-4 h-4 text-[#5D6F5A] shrink-0" />
            <span className="font-medium truncate">{testMsg}</span>
          </div>
          <button onClick={() => setTestStatus('idle')} className="text-[#5D6F5A] hover:text-[#2B3B28] ml-2 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {testStatus === 'error' && (
        <div className="bg-[#C7A39B]/25 border-b border-[#C7A39B]/40 px-4 md:px-8 py-2 flex flex-row items-center justify-between text-xs text-[#6F342B] whitespace-nowrap">
          <div className="flex flex-row items-center gap-2 truncate">
            <AlertCircle className="w-4 h-4 text-[#B6847A] shrink-0" />
            <span className="font-medium truncate">{testMsg}</span>
          </div>
          <button onClick={() => setTestStatus('idle')} className="text-[#B6847A] hover:text-[#6F342B] ml-2 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* MAIN CONTAINER */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 md:px-8 py-6">
        {/* SECTION 1: DASHBOARD VIEW */}
        {currentView === 'dashboard' && (
          <div className="flex flex-col gap-6">
            {/* Hero Welcome Banner */}
            <div className="bg-gradient-to-r from-[#FFFFFF] via-[#FAF8F5] to-[#F1ECE4] border border-[#E5DFD7] rounded-3xl p-6 md:p-8 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="flex flex-col gap-2 max-w-2xl">
                <div className="flex flex-row items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-full bg-[#8E9F8B]/20 text-[#4D5E4A] text-xs font-semibold font-mono border border-[#8E9F8B]/30 whitespace-nowrap shrink-0">
                    GitVault v2.5
                  </span>
                  {isApkEnvironment ? (
                    <span className="px-2 py-0.5 rounded-full bg-[#8E9F8B]/20 text-[#3D4F3A] text-[11px] font-semibold border border-[#8E9F8B]/30 whitespace-nowrap shrink-0 flex flex-row items-center gap-1">
                      <Smartphone className="w-3 h-3 shrink-0" />
                      <span>APK 运行环境</span>
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-[#EFECE6] text-[#7A7367] text-[11px] font-mono border border-[#DFD8CE] whitespace-nowrap shrink-0">
                      Web 浏览器端
                    </span>
                  )}
                  {userProfile && (
                    <span className="text-xs text-[#7A7367] flex flex-row items-center gap-1 whitespace-nowrap shrink-0">
                      <UserCheck className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                      <span>@{userProfile.login}</span>
                    </span>
                  )}
                </div>
                <h1 className="text-2xl md:text-3xl font-bold font-serif tracking-tight text-[#2B2723]">
                  直接拉取项目到本地 · 一键同步个人私人仓库
                </h1>
                <p className="text-xs md:text-sm text-[#6B6358] leading-relaxed">
                  每个拉取的项目支持一键或批量上传至个人私人仓库，自动建仓并同步备注与描述；支持自选目录导出、APK本地目录落盘及系统备份。
                </p>
              </div>

              <div className="flex flex-row md:flex-col gap-2 shrink-0 whitespace-nowrap">
                <button
                  onClick={() => setIsAddModalOpen(true)}
                  className="px-4 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center justify-center gap-2 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-4 h-4 shrink-0" />
                  <span>拉取新项目链接</span>
                </button>
                <button
                  onClick={() => setCurrentView('projects')}
                  className="px-4 py-2.5 bg-[#FFFFFF] hover:bg-[#FAF8F5] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] shadow-xs transition flex flex-row items-center justify-center gap-2 whitespace-nowrap shrink-0"
                >
                  <FolderGit2 className="w-4 h-4 text-[#8E9F8B] shrink-0" />
                  <span>查看已有项目 ({repos.length})</span>
                </button>
              </div>
            </div>

            {/* Quick Metrics Bar */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-4 shadow-xs flex flex-row items-center justify-between">
                <div>
                  <span className="text-xs text-[#7A7367]">托管项目总数</span>
                  <p className="text-2xl font-serif font-bold text-[#2B2723] mt-0.5">{repos.length}</p>
                </div>
                <div className="w-9 h-9 rounded-xl bg-[#8E9F8B]/15 text-[#5D6F5A] flex items-center justify-center shrink-0">
                  <FolderGit2 className="w-4 h-4 shrink-0" />
                </div>
              </div>

              <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-4 shadow-xs flex flex-row items-center justify-between">
                <div>
                  <span className="text-xs text-[#7A7367]">已同步私人仓库</span>
                  <p className="text-2xl font-serif font-bold text-[#5D6F5A] mt-0.5">
                    {repos.filter(r => r.privateRepoUrl).length}
                  </p>
                </div>
                <div className="w-9 h-9 rounded-xl bg-[#8E9F8B]/15 text-[#5D6F5A] flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                </div>
              </div>

              <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-4 shadow-xs flex flex-row items-center justify-between">
                <div>
                  <span className="text-xs text-[#7A7367]">待更新版本</span>
                  <p className="text-2xl font-serif font-bold text-[#8C5D54] mt-0.5">
                    {repos.filter(r => r.hasUpdate).length}
                  </p>
                </div>
                <div className="w-9 h-9 rounded-xl bg-[#C7A39B]/20 text-[#8C5D54] flex items-center justify-center shrink-0">
                  <RefreshCw className="w-4 h-4 shrink-0" />
                </div>
              </div>

              <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-4 shadow-xs flex flex-row items-center justify-between">
                <div>
                  <span className="text-xs text-[#7A7367]">总归档历史</span>
                  <p className="text-2xl font-serif font-bold text-[#2B2723] mt-0.5">
                    {repos.reduce((acc, r) => acc + r.backups.length, 0)}
                  </p>
                </div>
                <div className="w-9 h-9 rounded-xl bg-[#DFD8CE] text-[#474239] flex items-center justify-center shrink-0">
                  <History className="w-4 h-4 shrink-0" />
                </div>
              </div>
            </div>

            {/* Recent Repos Preview */}
            <div className="flex flex-col gap-4">
              <div className="flex flex-row items-center justify-between whitespace-nowrap">
                <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                  <Clock className="w-4 h-4 text-[#8E9F8B] shrink-0" />
                  <span>近期拉取的项目</span>
                </h3>
                <button
                  onClick={() => setCurrentView('projects')}
                  className="text-xs text-[#5D6F5A] hover:text-[#2B2723] flex flex-row items-center gap-1 font-semibold whitespace-nowrap shrink-0"
                >
                  <span>管理中心</span>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                </button>
              </div>

              {repos.length === 0 ? (
                <div className="bg-[#FFFFFF] border-2 border-dashed border-[#DFD8CE] rounded-3xl p-12 text-center flex flex-col items-center gap-3">
                  <FolderGit2 className="w-10 h-10 text-[#A69E92]" />
                  <p className="text-xs text-[#7A7367]">暂无拉取的项目。点击右上角“新建链接/拉取项目”开始使用。</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {repos.slice(0, 6).map(repo => (
                    <div
                      key={repo.id}
                      onClick={() => {
                        setActiveRepoId(repo.id);
                        setCurrentView('workbench');
                        setViewingBackup(null);
                        setSelectedFilePath(null);
                        setMobileFileView('list');
                        setSelectedBackupIds([]);
                      }}
                      className="bg-[#FFFFFF] hover:bg-[#F9F7F3] border border-[#E5DFD7] hover:border-[#8E9F8B]/50 rounded-2xl p-5 flex flex-col justify-between gap-4 cursor-pointer transition shadow-xs"
                    >
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-row items-center justify-between whitespace-nowrap">
                          <span className="text-xs font-bold text-[#2B2723] font-mono truncate max-w-[170px]">
                            {repo.owner}/{repo.repo}
                          </span>
                          <div className="flex flex-row items-center gap-1 shrink-0 whitespace-nowrap">
                            {repo.privateRepoUrl && (
                              <span className="text-[10px] bg-[#8E9F8B]/15 text-[#3D4F3A] px-2 py-0.5 rounded-full font-mono border border-[#8E9F8B]/30 whitespace-nowrap shrink-0">
                                私人仓已同步
                              </span>
                            )}
                            {repo.isCachePurged && (
                              <span className="text-[10px] bg-[#EFECE6] text-[#7A7367] px-2 py-0.5 rounded-full font-mono border border-[#DFD8CE] whitespace-nowrap shrink-0">
                                缓存已精简
                              </span>
                            )}
                            {repo.hasUpdate ? (
                              <span className="text-[10px] bg-[#B6847A]/20 text-[#8C5D54] px-2 py-0.5 rounded-full font-bold border border-[#B6847A]/30 whitespace-nowrap shrink-0">
                                发现新版本
                              </span>
                            ) : (
                              <span className="text-[10px] bg-[#EFECE6] text-[#6B6358] px-2 py-0.5 rounded-full border border-[#DFD8CE] whitespace-nowrap shrink-0">
                                已同步
                              </span>
                            )}
                          </div>
                        </div>

                        <p className="text-xs font-medium text-[#4D5E4A] italic truncate">备注: {repo.remark}</p>
                        {repo.description && (
                          <p className="text-[11px] text-[#6B6358] line-clamp-2">描述: {repo.description}</p>
                        )}

                        {/* All project tags: strictly single horizontal row per tag badge */}
                        <div className="flex flex-row items-center gap-1.5 flex-wrap mt-1">
                          {repo.tags.map(t => (
                            <span key={t} className="inline-flex flex-row items-center text-[10px] bg-[#EFECE6] text-[#474239] px-2 py-0.5 rounded border border-[#DFD8CE] whitespace-nowrap shrink-0 leading-none">
                              #{t}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-row items-center justify-between pt-3 border-t border-[#EDE7DF] text-[11px] text-[#7A7367] whitespace-nowrap">
                        <span className="shrink-0">归档: {repo.backups.length} 个版本</span>
                        <span className="text-[#5D6F5A] font-medium flex flex-row items-center gap-1 shrink-0">
                          进入工作台 <ChevronRight className="w-3 h-3 shrink-0" />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* SECTION 2: CONNECTED PROJECTS MANAGEMENT (仓库已有项目) WITH BATCH MANAGEMENT */}
        {currentView === 'projects' && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-xl md:text-2xl font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                  <FolderGit2 className="w-6 h-6 text-[#8E9F8B] shrink-0" />
                  <span>仓库已有项目管理中心</span>
                </h2>
                <p className="text-xs text-[#7A7367] mt-0.5">
                  集中管理所有拉取链接的 GitHub 项目，支持批量上传私人仓库、批量删除、批量添加标签及自选文件夹下载。
                </p>
              </div>

              <div className="flex flex-row items-center gap-2 flex-wrap sm:flex-nowrap whitespace-nowrap">
                <button
                  onClick={checkAllUpdates}
                  className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#F5F2EB] text-[#474239] rounded-xl text-xs font-medium border border-[#DFD8CE] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-[#B6847A] shrink-0" />
                  <span>全部检测</span>
                </button>
              </div>
            </div>

            {/* BATCH ACTION TOOLBAR */}
            <div className="bg-[#FAF8F5] border border-[#E5DFD7] rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-xs">
              <div className="flex flex-row items-center gap-2 flex-wrap whitespace-nowrap">
                <button
                  onClick={handleSelectAllProjects}
                  className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <CheckSquare className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                  <span>{selectedProjectIds.length === filteredRepos.length && filteredRepos.length > 0 ? '取消全选' : '全选所有'}</span>
                </button>
                <button
                  onClick={handleInvertSelectProjects}
                  className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition whitespace-nowrap shrink-0"
                >
                  反选
                </button>
                {selectedProjectIds.length > 0 && (
                  <button
                    onClick={handleClearSelectProjects}
                    className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#EFECE6] text-[#7A7367] rounded-xl text-xs font-medium border border-[#DFD8CE] transition whitespace-nowrap shrink-0"
                  >
                    清空选择
                  </button>
                )}

                <span className="text-xs text-[#5D6F5A] font-semibold bg-[#8E9F8B]/15 px-3 py-1 rounded-xl border border-[#8E9F8B]/30 whitespace-nowrap shrink-0">
                  已选定 {selectedProjectIds.length} / {filteredRepos.length} 个项目
                </span>
              </div>

              {/* Batch Action Buttons */}
              <div className="flex flex-row items-center gap-2 flex-wrap whitespace-nowrap">
                <button
                  onClick={handleOpenBatchUploadModal}
                  disabled={selectedProjectIds.length === 0}
                  className="px-3.5 py-1.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 disabled:opacity-40 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                  title="为选中的每个项目自动在您的 GitHub 账号下创建私人仓库并完整上传代码、备注与描述"
                >
                  <UploadCloud className="w-3.5 h-3.5 shrink-0" />
                  <span>批量上传至私人仓库</span>
                </button>

                <button
                  onClick={handleOpenBatchTagModal}
                  disabled={selectedProjectIds.length === 0}
                  className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#F5F2EB] disabled:opacity-40 text-[#474239] rounded-xl text-xs font-medium border border-[#DFD8CE] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Tag className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                  <span>批量加标签</span>
                </button>

                <button
                  onClick={handleBatchPurgeCache}
                  disabled={selectedProjectIds.length === 0}
                  className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#F5F2EB] disabled:opacity-40 text-[#6B6358] rounded-xl text-xs font-medium border border-[#DFD8CE] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                  title="批量释放本地大文件缓存，保留记录与同源拉取功能"
                >
                  <Archive className="w-3.5 h-3.5 shrink-0" />
                  <span>批量精简缓存</span>
                </button>

                <button
                  onClick={handleBatchDeleteProjects}
                  disabled={selectedProjectIds.length === 0}
                  className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#FAF8F5] disabled:opacity-40 text-[#8C5D54] rounded-xl text-xs font-medium border border-[#DFD8CE] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5 text-[#B6847A] shrink-0" />
                  <span>批量删除</span>
                </button>
              </div>
            </div>

            {/* Filter Toolbar */}
            <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-xs">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 text-[#91887C] absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="搜索项目名称、备注、详细描述或标签..."
                  value={searchFilter}
                  onChange={e => setSearchFilter(e.target.value)}
                  className="w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl pl-9 pr-4 py-2 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                />
              </div>

              <div className="flex flex-row items-center gap-2 overflow-x-auto pb-1 md:pb-0 whitespace-nowrap">
                <span className="text-xs text-[#7A7367] flex flex-row items-center gap-1 shrink-0">
                  <Filter className="w-3.5 h-3.5 shrink-0" /> 标签:
                </span>
                <button
                  onClick={() => setSelectedTagFilter('all')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 transition whitespace-nowrap ${
                    selectedTagFilter === 'all'
                      ? 'bg-[#8E9F8B] text-white'
                      : 'bg-[#FAF8F5] text-[#554F45] hover:bg-[#EFECE6]'
                  }`}
                >
                  全部
                </button>
                {allTags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => setSelectedTagFilter(tag)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 transition whitespace-nowrap ${
                      selectedTagFilter === tag
                        ? 'bg-[#8E9F8B] text-white'
                        : 'bg-[#FAF8F5] text-[#554F45] hover:bg-[#EFECE6]'
                    }`}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            </div>

            {/* Repos Cards List */}
            {filteredRepos.length === 0 ? (
              <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-3xl p-12 text-center flex flex-col items-center gap-3 shadow-xs">
                <FolderGit2 className="w-12 h-12 text-[#B2A89B]" />
                <p className="text-xs text-[#7A7367]">未找到匹配的项目</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {filteredRepos.map(repo => {
                  const isSelected = selectedProjectIds.includes(repo.id);

                  return (
                    <div
                      key={repo.id}
                      className={`bg-[#FFFFFF] border rounded-2xl p-5 md:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4 shadow-xs transition ${
                        isSelected
                          ? 'border-[#8E9F8B] bg-[#FAF8F5]'
                          : 'border-[#E5DFD7] hover:border-[#8E9F8B]/40'
                      }`}
                    >
                      <div className="flex flex-row items-start gap-3.5 flex-1 min-w-0">
                        {/* Checkbox for batch selection */}
                        <div
                          onClick={(e) => handleToggleSelectProject(repo.id, e)}
                          className="pt-1 cursor-pointer shrink-0"
                        >
                          {isSelected ? (
                            <div className="w-5 h-5 rounded-md bg-[#8E9F8B] text-white flex items-center justify-center shadow-xs">
                              <Check className="w-3.5 h-3.5" />
                            </div>
                          ) : (
                            <div className="w-5 h-5 rounded-md border border-[#C5BCB0] bg-[#FFFFFF] hover:border-[#8E9F8B] transition" />
                          )}
                        </div>

                        <div className="flex flex-col gap-2 flex-1 min-w-0">
                          <div className="flex flex-row items-center gap-2.5 flex-wrap whitespace-nowrap">
                            <a
                              href={repo.repoMeta.htmlUrl || repo.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-base font-bold text-[#2B2723] hover:text-[#5D6F5A] transition flex flex-row items-center gap-1.5 font-mono shrink-0 whitespace-nowrap"
                            >
                              <span>{repo.owner}/{repo.repo}</span>
                              <ExternalLink className="w-3.5 h-3.5 text-[#91887C] shrink-0" />
                            </a>

                            <span className="text-xs bg-[#8E9F8B]/15 text-[#4D5E4A] px-2.5 py-0.5 rounded-md border border-[#8E9F8B]/30 font-medium whitespace-nowrap shrink-0">
                              备注: {repo.remark}
                            </span>

                            {repo.privateRepoUrl ? (
                              <a
                                href={repo.privateRepoUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] bg-[#8E9F8B]/20 text-[#3D4F3A] px-2 py-0.5 rounded-full font-mono flex flex-row items-center gap-1 border border-[#8E9F8B]/40 hover:underline whitespace-nowrap shrink-0"
                                title="点击直接打开个人私人仓库"
                              >
                                <ShieldCheck className="w-3 h-3 text-[#5D6F5A] shrink-0" />
                                <span>私人仓库已同步</span>
                              </a>
                            ) : (
                              <span className="text-[10px] bg-[#EFECE6] text-[#7A7367] px-2 py-0.5 rounded-full font-mono border border-[#DFD8CE] whitespace-nowrap shrink-0">
                                未上传私人仓
                              </span>
                            )}

                            {repo.isCachePurged ? (
                              <span className="text-[10px] bg-[#EFECE6] text-[#6B6358] px-2 py-0.5 rounded-full font-mono flex flex-row items-center gap-1 border border-[#DFD8CE] whitespace-nowrap shrink-0">
                                <Archive className="w-2.5 h-2.5 shrink-0" />
                                <span>本地缓存已释放</span>
                              </span>
                            ) : (
                              <span className="text-[10px] bg-[#FAF8F5] text-[#7A7367] px-2 py-0.5 rounded-full font-mono border border-[#DFD8CE] whitespace-nowrap shrink-0">
                                本地缓存就绪 ({repo.tree.length} 文件)
                              </span>
                            )}

                            {repo.hasUpdate ? (
                              <span className="text-[10px] bg-[#B6847A]/20 text-[#8C5D54] px-2.5 py-0.5 rounded-full font-bold border border-[#B6847A]/30 flex flex-row items-center gap-1 whitespace-nowrap shrink-0">
                                <AlertCircle className="w-3 h-3 shrink-0" />
                                <span>远程有更新</span>
                              </span>
                            ) : (
                              <span className="text-[10px] bg-[#8E9F8B]/20 text-[#4D5E4A] px-2.5 py-0.5 rounded-full font-medium border border-[#8E9F8B]/30 flex flex-row items-center gap-1 whitespace-nowrap shrink-0">
                                <Check className="w-3 h-3 shrink-0" />
                                <span>最新</span>
                              </span>
                            )}
                          </div>

                          {/* Description display */}
                          {repo.description && (
                            <p className="text-xs text-[#554F45] leading-relaxed line-clamp-2">
                              <span className="font-semibold text-[#474239]">描述: </span>
                              {repo.description}
                            </p>
                          )}

                          {/* Tags & meta line: strictly horizontal single line badges */}
                          <div className="flex flex-row items-center gap-2 flex-wrap whitespace-nowrap">
                            {repo.tags.map(t => (
                              <span key={t} className="inline-flex flex-row items-center text-[10px] bg-[#EFECE6] text-[#474239] px-2 py-0.5 rounded border border-[#DFD8CE] whitespace-nowrap shrink-0 leading-none">
                                #{t}
                              </span>
                            ))}
                            <span className="text-xs text-[#7A7367] font-mono whitespace-nowrap shrink-0">
                              分支: <code>{repo.branch}</code>
                            </span>
                            <span className="text-xs text-[#7A7367] font-mono whitespace-nowrap shrink-0">
                              最新SHA: <code>{repo.latestCommitSha.substring(0, 7)}</code>
                            </span>
                          </div>

                          <p className="text-[11px] text-[#91887C] font-mono whitespace-nowrap">
                            最后检测: {repo.lastCheckedAt ? new Date(repo.lastCheckedAt).toLocaleTimeString() : '从未'} | 归档: {repo.backups.length} 个版本
                            {repo.lastUploadedToPrivateAt && ` | 上传私人仓: ${new Date(repo.lastUploadedToPrivateAt).toLocaleString()}`}
                          </p>
                        </div>
                      </div>

                      {/* Action Buttons - Single horizontal line, whitespace-nowrap */}
                      <div className="flex flex-row items-center gap-2 flex-wrap sm:flex-nowrap shrink-0 whitespace-nowrap">
                        {/* Single Upload to Private Repo Button */}
                        <button
                          onClick={() => handleOpenSingleUploadModal(repo)}
                          className="px-3 py-1.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                          title="上传此整个拉取项目进入自己 GitHub 账号中的私人仓库 (自动新建私人仓集，同步备注与描述)"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                          <span>上传私人仓</span>
                        </button>

                        {/* Project Settings & Custom Folder Download Button */}
                        <button
                          onClick={() => handleOpenProjectSettings(repo, 'folderDownload')}
                          className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#F5F2EB] text-[#3B362F] rounded-xl text-xs font-semibold border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                          title="项目设置与自选文件夹下载 (支持 APK 打包目录)"
                        >
                          <FolderDown className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                          <span>自选下载与设置</span>
                        </button>

                        {repo.isCachePurged ? (
                          <button
                            onClick={() => handleRepullProjectCache(repo.id)}
                            className="px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#4D5E4A] rounded-xl text-xs font-medium border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                            title="从 GitHub 重新拉取完整文件树并还原本地缓存 (同源互通)"
                          >
                            <RefreshCcw className="w-3.5 h-3.5 text-[#5D6F5A] shrink-0" />
                            <span>还原缓存</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => handlePurgeProjectCache(repo.id)}
                            className="px-2.5 py-1.5 bg-[#FFFFFF] hover:bg-[#F5F2EB] text-[#7A7367] rounded-xl text-xs font-medium border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1 whitespace-nowrap shrink-0"
                            title="释放该项目的本地文件大缓存，仅保留项目元数据与归档记录"
                          >
                            <Archive className="w-3.5 h-3.5 shrink-0" />
                            <span>精简缓存</span>
                          </button>
                        )}

                        <button
                          onClick={() => checkSingleRepoStatus(repo.id)}
                          className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#F5F2EB] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                          title="手动检测此项目远程是否有更新"
                        >
                          <RefreshCw className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                          <span>检测</span>
                        </button>

                        <button
                          onClick={() => handleOneClickUpdate(repo)}
                          className="px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#2E2B27] rounded-xl text-xs font-semibold border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                          title="同步最新代码并自动归档旧版"
                        >
                          <UploadCloud className="w-3.5 h-3.5 text-[#5D6F5A] shrink-0" />
                          <span>一键更新</span>
                        </button>

                        <button
                          onClick={() => {
                            setActiveRepoId(repo.id);
                            setCurrentView('workbench');
                            setViewingBackup(null);
                            setSelectedFilePath(null);
                            setMobileFileView('list');
                            setSelectedBackupIds([]);
                          }}
                          className="px-3.5 py-1.5 bg-[#FFFFFF] hover:bg-[#F5F2EB] text-[#4D5E4A] rounded-xl text-xs font-medium border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1 whitespace-nowrap shrink-0"
                        >
                          <span>工作台</span>
                          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                        </button>

                        <button
                          onClick={(e) => handleDeleteRepo(repo.id, e)}
                          className="p-1.5 text-[#91887C] hover:text-[#B6847A] hover:bg-[#FAF8F5] rounded-xl transition shrink-0"
                          title="删除项目"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* WORKBENCH VIEW */}
        {currentView === 'workbench' && activeRepo && (
          <div className="flex flex-col gap-6">
            {/* Header Banner - Strictly single horizontal line */}
            <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-3xl p-5 md:p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xs">
              <div className="flex flex-row items-start gap-3.5">
                <button
                  onClick={() => { setCurrentView('projects'); setActiveRepoId(null); setViewingBackup(null); }}
                  className="mt-0.5 p-2 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl border border-[#DFD8CE] transition shrink-0"
                  title="返回项目列表"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div>
                  <div className="flex flex-row items-center gap-2.5 flex-wrap whitespace-nowrap">
                    <h2 className="text-lg md:text-xl font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2 shrink-0">
                      <a href={activeRepo.repoMeta.htmlUrl || activeRepo.url} target="_blank" rel="noreferrer" className="hover:text-[#5D6F5A] transition flex flex-row items-center gap-1.5">
                        <span>{activeRepo.owner}/{activeRepo.repo}</span>
                        <ExternalLink className="w-3.5 h-3.5 text-[#91887C] shrink-0" />
                      </a>
                    </h2>
                    <span className="text-xs bg-[#8E9F8B]/15 text-[#4D5E4A] px-2.5 py-0.5 rounded border border-[#8E9F8B]/30 font-medium whitespace-nowrap shrink-0">
                      备注: {activeRepo.remark}
                    </span>
                    {activeRepo.privateRepoUrl && (
                      <a
                        href={activeRepo.privateRepoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs bg-[#8E9F8B]/20 text-[#3D4F3A] px-2.5 py-0.5 rounded border border-[#8E9F8B]/40 font-mono flex flex-row items-center gap-1 whitespace-nowrap shrink-0 hover:underline"
                      >
                        <ShieldCheck className="w-3 h-3 text-[#5D6F5A] shrink-0" />
                        <span>私人仓库</span>
                      </a>
                    )}
                    {activeRepo.isCachePurged ? (
                      <span className="text-xs bg-[#EFECE6] text-[#6B6358] px-2.5 py-0.5 rounded border border-[#DFD8CE] font-mono flex flex-row items-center gap-1 whitespace-nowrap shrink-0">
                        <Archive className="w-3 h-3 shrink-0" />
                        <span>本地缓存已释放 (保留元数据)</span>
                      </span>
                    ) : (
                      <span className="text-xs bg-[#8E9F8B]/20 text-[#3D4F3A] px-2.5 py-0.5 rounded border border-[#8E9F8B]/30 font-mono flex flex-row items-center gap-1 whitespace-nowrap shrink-0 font-medium">
                        <HardDrive className="w-3 h-3 text-[#5D6F5A] shrink-0" />
                        <span>源码已完整本地缓存 ({activeRepo.cachedFilesCount || activeRepo.tree.length} 文件，已离线)</span>
                      </span>
                    )}
                    {viewingBackup && (
                      <span className="text-xs bg-[#C7A39B]/20 text-[#8C5D54] px-2.5 py-0.5 rounded border border-[#C7A39B]/30 font-semibold whitespace-nowrap shrink-0">
                        正在查看归档: {viewingBackup.tag}
                      </span>
                    )}
                  </div>

                  {activeRepo.description && (
                    <p className="text-xs text-[#554F45] mt-1.5 leading-relaxed">
                      <span className="font-semibold text-[#474239]">描述: </span>
                      {activeRepo.description}
                    </p>
                  )}

                  <div className="flex flex-row items-center gap-1.5 mt-2 flex-wrap whitespace-nowrap">
                    {activeRepo.tags.map(t => (
                      <span key={t} className="inline-flex flex-row items-center text-[10px] bg-[#EFECE6] text-[#474239] px-2 py-0.5 rounded border border-[#DFD8CE] whitespace-nowrap shrink-0 leading-none">
                        #{t}
                      </span>
                    ))}
                    <span className="text-xs text-[#7A7367] font-mono whitespace-nowrap shrink-0">
                      SHA: <code>{activeRepo.latestCommitSha.substring(0, 7)}</code>
                    </span>
                  </div>
                </div>
              </div>

              {/* Workbench Actions */}
              <div className="flex flex-row items-center gap-2 flex-wrap md:flex-nowrap whitespace-nowrap">
                <button
                  onClick={() => handleOpenSingleUploadModal(activeRepo)}
                  className="px-3.5 py-2 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  <span>上传至个人私人仓库</span>
                </button>

                <button
                  onClick={() => handleOpenProjectSettings(activeRepo, 'folderDownload')}
                  className="px-3 py-2 bg-[#FFFFFF] hover:bg-[#F5F2EB] text-[#3B362F] rounded-xl text-xs font-semibold border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <FolderDown className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                  <span>下载自选文件夹</span>
                </button>

                {activeRepo.isCachePurged ? (
                  <button
                    onClick={() => handleRepullProjectCache(activeRepo.id)}
                    className="px-3 py-2 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#4D5E4A] rounded-xl text-xs font-medium border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <RefreshCcw className="w-3.5 h-3.5 text-[#5D6F5A] shrink-0" />
                    <span>还原缓存</span>
                  </button>
                ) : (
                  <button
                    onClick={() => handlePurgeProjectCache(activeRepo.id)}
                    className="px-3 py-2 bg-[#FFFFFF] hover:bg-[#F5F2EB] text-[#7A7367] rounded-xl text-xs font-medium border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1 whitespace-nowrap shrink-0"
                  >
                    <Archive className="w-3.5 h-3.5 shrink-0" />
                    <span>精简缓存</span>
                  </button>
                )}

                <button
                  onClick={() => handleOneClickUpdate(activeRepo)}
                  className="px-3.5 py-2 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#2E2B27] rounded-xl text-xs font-semibold border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <UploadCloud className="w-3.5 h-3.5 text-[#5D6F5A] shrink-0" />
                  <span>一键更新</span>
                </button>
              </div>
            </div>

            {/* Workbench Navigation Tabs */}
            <div className="flex flex-row border-b border-[#E5DFD7] gap-2 whitespace-nowrap overflow-x-auto pb-1">
              <button
                onClick={() => setWorkbenchTab('files')}
                className={`flex flex-row items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition whitespace-nowrap shrink-0 ${
                  workbenchTab === 'files'
                    ? 'border-[#8E9F8B] text-[#4D5E4A] bg-[#FFFFFF] rounded-t-xl'
                    : 'border-transparent text-[#7A7367] hover:text-[#2E2B27]'
                }`}
              >
                <FileCode className="w-4 h-4 shrink-0" />
                <span>文件浏览器 ({activeTree.length})</span>
              </button>

              <button
                onClick={() => setWorkbenchTab('backups')}
                className={`flex flex-row items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition whitespace-nowrap shrink-0 ${
                  workbenchTab === 'backups'
                    ? 'border-[#8E9F8B] text-[#4D5E4A] bg-[#FFFFFF] rounded-t-xl'
                    : 'border-transparent text-[#7A7367] hover:text-[#2E2B27]'
                }`}
              >
                <History className="w-4 h-4 shrink-0" />
                <span>版本归档库 ({activeRepo.backups.length})</span>
              </button>

              <button
                onClick={() => setWorkbenchTab('changelog')}
                className={`flex flex-row items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition whitespace-nowrap shrink-0 ${
                  workbenchTab === 'changelog'
                    ? 'border-[#8E9F8B] text-[#4D5E4A] bg-[#FFFFFF] rounded-t-xl'
                    : 'border-transparent text-[#7A7367] hover:text-[#2E2B27]'
                }`}
              >
                <Sparkles className="w-4 h-4 text-[#B6847A] shrink-0" />
                <span>智能更新日志</span>
              </button>
            </div>

            {/* WORKBENCH TAB 1: FILES & HEATMAP */}
            {workbenchTab === 'files' && (
              <div className="flex flex-col gap-4">
                {/* View switcher: Explorer vs Heatmap */}
                <div className="flex flex-row items-center justify-between bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-3 shadow-xs">
                  <div className="flex flex-row items-center gap-1.5 bg-[#FAF8F5] p-1 rounded-xl border border-[#DFD8CE] whitespace-nowrap">
                    <button
                      onClick={() => setFileViewMode('explorer')}
                      className={`flex flex-row items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition ${
                        fileViewMode === 'explorer'
                          ? 'bg-[#FFFFFF] text-[#2E2B27] shadow-xs'
                          : 'text-[#7A7367] hover:text-[#2E2B27]'
                      }`}
                    >
                      <Folder className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                      <span>代码列表浏览器</span>
                    </button>
                    <button
                      onClick={() => setFileViewMode('heatmap')}
                      className={`flex flex-row items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition ${
                        fileViewMode === 'heatmap'
                          ? 'bg-[#FFFFFF] text-[#2E2B27] shadow-xs'
                          : 'text-[#7A7367] hover:text-[#2E2B27]'
                      }`}
                    >
                      <BarChart3 className="w-3.5 h-3.5 text-[#B6847A] shrink-0" />
                      <span>文件大小分布热力图</span>
                    </button>
                  </div>

                  <span className="text-xs text-[#7A7367] font-mono whitespace-nowrap shrink-0">
                    项目体积估算: {formatFileSize(totalProjectSize)}
                  </span>
                </div>

                {/* Heatmap View */}
                {fileViewMode === 'heatmap' ? (
                  <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-3xl p-6 shadow-xs flex flex-col gap-4">
                    <div className="flex flex-row items-center justify-between whitespace-nowrap">
                      <div>
                        <h4 className="text-sm font-bold font-serif text-[#2B2723]">核心模块与文件大小热力图分布</h4>
                        <p className="text-xs text-[#7A7367] mt-0.5">
                          基于 Recharts 展现各目录与文件占比分布。点击色块可直达文件代码详情。
                        </p>
                      </div>
                    </div>

                    <div className="h-96 w-full rounded-2xl overflow-hidden border border-[#EFECE6] bg-[#FAF8F5] p-2">
                      {heatmapData.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-xs text-[#7A7367]">
                          暂无文件数据可供生成热力图
                        </div>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <Treemap
                            data={heatmapData}
                            dataKey="size"
                            aspectRatio={4 / 3}
                            stroke="#FAF8F5"
                            content={<CustomizedTreemapContent />}
                          />
                        </ResponsiveContainer>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Standard File Explorer */
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* File Tree List */}
                    <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-4 shadow-xs flex flex-col gap-3 max-h-[600px] overflow-hidden">
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-[#91887C] absolute left-3 top-2.5" />
                        <input
                          type="text"
                          placeholder="过滤文件名称..."
                          value={fileSearchQuery}
                          onChange={e => setFileSearchQuery(e.target.value)}
                          className="w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl pl-8 pr-3 py-1.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
                        />
                      </div>

                      <div className="flex-1 overflow-y-auto flex flex-col gap-1 pr-1">
                        {activeTree
                          .filter(t => t.path.toLowerCase().includes(fileSearchQuery.toLowerCase()))
                          .slice(0, 150)
                          .map(item => {
                            const isSelected = selectedFilePath === item.path;
                            return (
                              <div
                                key={item.path}
                                onClick={() => handleSelectFile(item.path)}
                                className={`flex flex-row items-center gap-2 px-3 py-2 rounded-xl text-xs cursor-pointer transition whitespace-nowrap overflow-hidden ${
                                  isSelected
                                    ? 'bg-[#8E9F8B]/20 text-[#2B2723] font-semibold'
                                    : 'hover:bg-[#FAF8F5] text-[#554F45]'
                                }`}
                              >
                                {item.type === 'tree' ? (
                                  <Folder className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                                ) : (
                                  <FileCode className="w-3.5 h-3.5 text-[#91887C] shrink-0" />
                                )}
                                <span className="truncate font-mono text-[11px]">{item.path}</span>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    {/* File Content Preview */}
                    <div className="md:col-span-2 bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-4 shadow-xs flex flex-col gap-3 min-h-[400px]">
                      {selectedFilePath ? (
                        <>
                          <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-3 whitespace-nowrap">
                            <div className="flex flex-row items-center gap-2 truncate mr-2">
                              <FileCode className="w-4 h-4 text-[#8E9F8B] shrink-0" />
                              <span className="font-mono text-xs font-bold text-[#2B2723] truncate">{selectedFilePath}</span>
                            </div>
                            <button
                              onClick={() => {
                                if (fileContent) {
                                  navigator.clipboard.writeText(fileContent);
                                  setCopySuccess(true);
                                  setTimeout(() => setCopySuccess(false), 2000);
                                }
                              }}
                              className="px-2.5 py-1 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#474239] rounded-lg text-xs font-mono border border-[#DFD8CE] transition flex flex-row items-center gap-1 shrink-0"
                            >
                              <Copy className="w-3 h-3 shrink-0" />
                              <span>{copySuccess ? '已复制' : '复制代码'}</span>
                            </button>
                          </div>

                          <div className="flex-1 overflow-auto bg-[#FAF8F5] rounded-xl p-4 font-mono text-xs border border-[#DFD8CE]">
                            {fileLoading ? (
                              <div className="h-full flex items-center justify-center gap-2 text-xs text-[#7A7367]">
                                <Loader2 className="w-4 h-4 animate-spin text-[#8E9F8B]" />
                                <span>正在读取文件源码...</span>
                              </div>
                            ) : (
                              <pre className="whitespace-pre-wrap break-all text-[#2E2B27]">{fileContent || '空文件或无法显示'}</pre>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-[#7A7367]">
                          <FileCode className="w-8 h-8 text-[#C5BCB0]" />
                          <span>在左侧选择一个文件查看源码</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* WORKBENCH TAB 2: BACKUPS ARCHIVE WITH BATCH RELEASE */}
            {workbenchTab === 'backups' && (
              <div className="flex flex-col gap-4">
                {/* Backups Action Toolbar */}
                <div className="bg-[#FAF8F5] border border-[#E5DFD7] rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-xs">
                  <div className="flex flex-row items-center gap-2 flex-wrap whitespace-nowrap">
                    <button
                      onClick={handleSelectAllBackups}
                      className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition whitespace-nowrap shrink-0"
                    >
                      {selectedBackupIds.length === activeRepo.backups.length && activeRepo.backups.length > 0 ? '取消全选' : '全选所有'}
                    </button>
                    <button
                      onClick={handleInvertSelectBackups}
                      className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition whitespace-nowrap shrink-0"
                    >
                      反选
                    </button>
                    <button
                      onClick={handleSelectUnreleasedBackups}
                      className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition whitespace-nowrap shrink-0"
                    >
                      仅选未发布
                    </button>
                    {selectedBackupIds.length > 0 && (
                      <button
                        onClick={handleClearSelectBackups}
                        className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#EFECE6] text-[#7A7367] rounded-xl text-xs font-medium border border-[#DFD8CE] transition whitespace-nowrap shrink-0"
                      >
                        清空
                      </button>
                    )}

                    <span className="text-xs text-[#5D6F5A] font-semibold bg-[#8E9F8B]/15 px-3 py-1 rounded-xl border border-[#8E9F8B]/30 whitespace-nowrap shrink-0">
                      已勾选 {selectedBackupIds.length} / {activeRepo.backups.length} 个版本
                    </span>
                  </div>

                  <div className="flex flex-row items-center gap-2 whitespace-nowrap">
                    <button
                      onClick={handleOpenBatchReleaseModal}
                      disabled={selectedBackupIds.length === 0}
                      className="px-4 py-2 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 disabled:opacity-40 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <UploadCloud className="w-3.5 h-3.5 shrink-0" />
                      <span>批量发布 Release 到 GitHub</span>
                    </button>
                  </div>
                </div>

                {/* Backups List */}
                {activeRepo.backups.length === 0 ? (
                  <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-3xl p-12 text-center flex flex-col items-center gap-3 shadow-xs">
                    <History className="w-10 h-10 text-[#C5BCB0]" />
                    <p className="text-xs text-[#7A7367]">暂无归档历史。每次执行“一键更新”检测到变动时将自动在此备份旧版本。</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {activeRepo.backups.map(backup => {
                      const isSelected = selectedBackupIds.includes(backup.id);
                      return (
                        <div
                          key={backup.id}
                          className={`bg-[#FFFFFF] border rounded-2xl p-4 md:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xs transition ${
                            isSelected
                              ? 'border-[#8E9F8B] bg-[#FAF8F5]'
                              : 'border-[#E5DFD7] hover:border-[#8E9F8B]/40'
                          }`}
                        >
                          <div className="flex flex-row items-start gap-3 min-w-0 flex-1">
                            <div
                              onClick={(e) => handleToggleSelectBackup(backup.id, e)}
                              className="pt-1 cursor-pointer shrink-0"
                            >
                              {isSelected ? (
                                <div className="w-5 h-5 rounded-md bg-[#8E9F8B] text-white flex items-center justify-center shadow-xs">
                                  <Check className="w-3.5 h-3.5" />
                                </div>
                              ) : (
                                <div className="w-5 h-5 rounded-md border border-[#C5BCB0] bg-[#FFFFFF] hover:border-[#8E9F8B] transition" />
                              )}
                            </div>

                            <div className="flex flex-col gap-1 min-w-0 flex-1">
                              <div className="flex flex-row items-center gap-2 whitespace-nowrap flex-wrap">
                                <span className="font-bold text-xs font-mono text-[#2B2723]">{backup.tag}</span>
                                <span className="text-[11px] text-[#554F45]">{backup.annotation}</span>
                                {backup.isReleased && (
                                  <span className="text-[10px] bg-[#8E9F8B]/20 text-[#3D4F3A] px-2 py-0.5 rounded-full font-semibold border border-[#8E9F8B]/30 whitespace-nowrap shrink-0">
                                    已发布 Release
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-[#7A7367] font-mono whitespace-nowrap">
                                SHA: <code>{backup.commitSha.slice(0, 7)}</code> | 归档于: {new Date(backup.backedUpAt).toLocaleString()}
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-row items-center gap-2 whitespace-nowrap shrink-0">
                            {backup.releaseUrl && (
                              <a
                                href={backup.releaseUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1.5 bg-[#FFFFFF] hover:bg-[#FAF8F5] text-[#3D4F3A] rounded-xl text-xs font-medium border border-[#DFD8CE] shadow-xs transition flex flex-row items-center gap-1 shrink-0"
                              >
                                <ExternalLink className="w-3 h-3 shrink-0" />
                                <span>Release 链接</span>
                              </a>
                            )}
                            <button
                              onClick={() => {
                                setViewingBackup(viewingBackup?.id === backup.id ? null : backup);
                                setWorkbenchTab('files');
                              }}
                              className="px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition shrink-0"
                            >
                              {viewingBackup?.id === backup.id ? '取消查看' : '查看此版本'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* WORKBENCH TAB 3: AI CHANGELOG */}
            {workbenchTab === 'changelog' && (
              <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-3xl p-6 shadow-xs flex flex-col gap-4">
                <div className="flex flex-row items-center justify-between whitespace-nowrap">
                  <div>
                    <h4 className="text-sm font-bold font-serif text-[#2B2723]">Gemini AI 智能代码更新日志</h4>
                    <p className="text-xs text-[#7A7367] mt-0.5">自动比对当前最新代码与上一归档版本的提交，分析核心变动与发布建议。</p>
                  </div>
                  <button
                    onClick={handleGenerateChangelog}
                    disabled={aiLoading}
                    className="px-4 py-2 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    {aiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    <span>{aiLoading ? '正在分析...' : '一键重新分析'}</span>
                  </button>
                </div>

                <div className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-2xl p-5 text-xs text-[#2E2B27] leading-relaxed whitespace-pre-wrap font-sans">
                  {activeRepo.aiChangelog || '暂无更新日志。点击上方“一键重新分析”由智能管家为您生成。'}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ================= MODAL 1: ADD / PULL REPO ================= */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-lg w-full p-6 shadow-xl flex flex-col gap-5">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                <Plus className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                <span>新建链接并拉取项目</span>
              </h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-[#91887C] hover:text-[#2E2B27]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddRepo} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#474239]">GitHub 仓库地址 (URL) *</label>
                <input
                  type="text"
                  placeholder="https://github.com/owner/repo 或 owner/repo"
                  value={repoUrl}
                  onChange={e => setRepoUrl(e.target.value)}
                  required
                  className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">项目备注说明 *</label>
                  <input
                    type="text"
                    placeholder="例如: 生产核心源码 / 模块A"
                    value={remarkInput}
                    onChange={e => setRemarkInput(e.target.value)}
                    required
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">标签 (逗号分隔)</label>
                  <input
                    type="text"
                    placeholder="生产, 核心, 架构"
                    value={tagsInput}
                    onChange={e => setTagsInput(e.target.value)}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                  />
                </div>
              </div>

              {/* Added Project Description Field */}
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-row items-center justify-between whitespace-nowrap">
                  <label className="text-xs font-semibold text-[#474239]">项目详细描述 (Description)</label>
                  <span className="text-[10px] text-[#8E9F8B] font-medium shrink-0">随项目同步上传至私人仓库</span>
                </div>
                <textarea
                  rows={2}
                  placeholder="输入项目的详细用途、核心功能、技术架构或备忘说明（上传至 GitHub 私人仓库时将自动写入仓库描述与元数据文件）..."
                  value={descriptionInput}
                  onChange={e => setDescriptionInput(e.target.value)}
                  className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B] resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">默认拉取分支</label>
                  <input
                    type="text"
                    placeholder="main"
                    value={branchInput}
                    onChange={e => setBranchInput(e.target.value)}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">专属 Token (可选)</label>
                  <input
                    type="password"
                    placeholder="留空则使用全局Token"
                    value={tokenInput}
                    onChange={e => setTokenInput(e.target.value)}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                  />
                </div>
              </div>

              {/* APK environment hint */}
              <div className="bg-[#FAF8F5] p-3 rounded-xl border border-[#DFD8CE] text-[11px] text-[#6B6358] leading-relaxed">
                {isApkEnvironment ? (
                  <span className="text-[#3D4F3A] font-medium">
                    📱 已处于 APK 原生运行环境：拉取时将自动落盘存储至本地目录 <code>{apkDownloadDirectory}</code>。
                  </span>
                ) : (
                  <span>
                    🌐 网页端提示：受浏览器安全沙箱限制，直接拉取项目进入本地高速持久化缓存；打包为 APK 后拉取将自动直接下载落盘至系统目录。
                  </span>
                )}
              </div>

              <div className="flex flex-row items-center justify-end gap-3 pt-3 border-t border-[#EDE7DF] whitespace-nowrap">
                <button type="button" onClick={() => setIsAddModalOpen(false)} className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium whitespace-nowrap shrink-0">取消</button>
                <button type="submit" className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0">确认拉取进入本地</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= MODAL 2: SINGLE UPLOAD TO PRIVATE REPO ================= */}
      {isSingleUploadModalOpen && singleUploadTargetRepo && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-lg w-full p-6 shadow-xl flex flex-col gap-5">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                <span>单个整个上传至个人私人仓库</span>
              </h3>
              <button onClick={() => setIsSingleUploadModalOpen(false)} className="text-[#91887C] hover:text-[#2E2B27]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleExecuteSingleUploadToPrivate} className="flex flex-col gap-4">
              <div className="bg-[#FAF8F5] p-3.5 rounded-xl border border-[#DFD8CE] text-xs text-[#2E2B27] flex flex-col gap-1.5">
                <div className="flex flex-row items-center justify-between">
                  <span className="font-semibold text-[#2B2723]">当前项目:</span>
                  <span className="font-mono text-[#5D6F5A] font-bold">{singleUploadTargetRepo.owner}/{singleUploadTargetRepo.repo}</span>
                </div>
                <div className="flex flex-row items-center justify-between text-[#7A7367]">
                  <span>目标账号:</span>
                  <span className="font-semibold text-[#2B2723]">@{userProfile?.login || '您的 GitHub 授权账号'}</span>
                </div>
                <p className="text-[11px] text-[#7A7367] leading-relaxed">
                  系统将自动在您的 GitHub 个人账号下创建名为 <code>{singleUploadRepoName}</code> 的专属私人仓库（Private Repo），并将拉取的全部文件、备注与描述完整同步上传。
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#474239]">私人仓库名称 (将在您的 GitHub 账号下新建)</label>
                <input
                  type="text"
                  value={singleUploadRepoName}
                  onChange={e => setSingleUploadRepoName(e.target.value)}
                  required
                  className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B] font-mono"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#474239]">同步上传的项目备注</label>
                <input
                  type="text"
                  value={singleUploadRemark}
                  onChange={e => setSingleUploadRemark(e.target.value)}
                  className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#474239]">同步上传的项目详细描述</label>
                <textarea
                  rows={2}
                  value={singleUploadDescription}
                  onChange={e => setSingleUploadDescription(e.target.value)}
                  className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B] resize-none"
                />
              </div>

              <label className="flex flex-row items-start gap-2.5 p-3 rounded-xl bg-[#FAF8F5] border border-[#DFD8CE] cursor-pointer text-xs text-[#524D44] select-none">
                <input
                  type="checkbox"
                  checked={singleUploadPurgeCache}
                  onChange={e => setSingleUploadPurgeCache(e.target.checked)}
                  className="mt-0.5 rounded border-[#D5CDC2] text-[#8E9F8B] focus:ring-0 shrink-0"
                />
                <div className="flex flex-col">
                  <span className="font-semibold text-[#2B2723]">上传成功后，自选释放本地缓存</span>
                  <span className="text-[11px] text-[#7A7367] mt-0.5">
                    仅释放本地文件大缓存；软件内完整保留项目元数据与私人仓库链接，随时可一键同源重新拉取。
                  </span>
                </div>
              </label>

              <div className="flex flex-row items-center justify-end gap-3 pt-3 border-t border-[#EDE7DF] whitespace-nowrap">
                <button type="button" onClick={() => setIsSingleUploadModalOpen(false)} className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium whitespace-nowrap shrink-0">取消</button>
                <button type="submit" disabled={isUploadingToPrivate} className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0">
                  {isUploadingToPrivate ? '正在创建并上传...' : '立即新建私人仓库并上传'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= MODAL 3: BATCH UPLOAD TO PRIVATE REPOS ================= */}
      {isBatchUploadModalOpen && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-xl w-full p-6 shadow-xl flex flex-col gap-5">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                <UploadCloud className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                <span>批量上传项目至个人私人仓库</span>
              </h3>
              <button
                disabled={isBatchUploading}
                onClick={() => setIsBatchUploadModalOpen(false)}
                className="text-[#91887C] hover:text-[#2E2B27] disabled:opacity-30"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-[#FAF8F5] p-3.5 rounded-xl border border-[#DFD8CE] text-xs text-[#2E2B27] flex flex-col gap-1">
              <p>
                <strong>选定项目:</strong> 共 <strong>{batchUploadStatusList.length}</strong> 个项目。
              </p>
              <p className="text-[#7A7367]">
                系统将依次在您的 GitHub 账号 (@{userProfile?.login || '您的账号'}) 下根据项目名称自动新建私人仓库，并将项目代码文件、备注与详细描述一并上传。
              </p>
            </div>

            {/* Progress list */}
            <div className="max-h-60 overflow-y-auto flex flex-col gap-2 pr-1 border border-[#E5DFD7] rounded-xl p-3 bg-[#FAF8F5]">
              {batchUploadStatusList.map(item => (
                <div key={item.id} className="flex flex-row items-center justify-between p-2.5 rounded-lg bg-[#FFFFFF] border border-[#EDE7DF] text-xs whitespace-nowrap">
                  <div className="flex flex-row items-center gap-2 truncate mr-2">
                    <FolderGit2 className="w-3.5 h-3.5 text-[#8E9F8B] shrink-0" />
                    <span className="font-mono font-semibold text-[#2B2723] truncate">{item.name}</span>
                  </div>

                  <div className="shrink-0 flex flex-row items-center gap-1.5 whitespace-nowrap">
                    {item.status === 'pending' && <span className="text-[#7A7367]">等待中</span>}
                    {item.status === 'creating' && (
                      <span className="text-[#8E9F8B] font-medium flex flex-row items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" /> 正在建私人仓...
                      </span>
                    )}
                    {item.status === 'uploading' && (
                      <span className="text-[#5D6F5A] font-medium flex flex-row items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" /> 正在推送代码...
                      </span>
                    )}
                    {item.status === 'success' && (
                      <span className="text-[#5D6F5A] font-semibold flex flex-row items-center gap-1">
                        <CheckCircle className="w-3.5 h-3.5 shrink-0" /> 成功
                      </span>
                    )}
                    {item.status === 'error' && (
                      <span className="text-[#B6847A] font-semibold flex flex-row items-center gap-1" title={item.error}>
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" /> 失败
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-row items-center justify-end gap-3 pt-3 border-t border-[#EDE7DF] whitespace-nowrap">
              <button
                type="button"
                disabled={isBatchUploading}
                onClick={() => setIsBatchUploadModalOpen(false)}
                className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                {isBatchUploading ? '处理中...' : '关闭'}
              </button>
              <button
                type="button"
                disabled={isBatchUploading}
                onClick={handleStartBatchUpload}
                className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                {isBatchUploading ? '正在批量处理...' : '开始批量上传'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= MODAL 4: BATCH ADD TAGS ================= */}
      {isBatchTagModalOpen && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-md w-full p-6 shadow-xl flex flex-col gap-5">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                <Tag className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                <span>批量添加项目标签</span>
              </h3>
              <button onClick={() => setIsBatchTagModalOpen(false)} className="text-[#91887C] hover:text-[#2E2B27]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleConfirmBatchAddTags} className="flex flex-col gap-4">
              <p className="text-xs text-[#7A7367]">
                将为已选定的 <strong>{selectedProjectIds.length}</strong> 个项目追加标签：
              </p>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#474239]">标签名称 (多个标签用逗号或空格分隔)</label>
                <input
                  type="text"
                  placeholder="例如: 生产环境, 模块A, 待重构"
                  value={batchTagInput}
                  onChange={e => setBatchTagInput(e.target.value)}
                  required
                  autoFocus
                  className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                />
              </div>

              <div className="flex flex-row items-center justify-end gap-3 pt-3 border-t border-[#EDE7DF] whitespace-nowrap">
                <button type="button" onClick={() => setIsBatchTagModalOpen(false)} className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium whitespace-nowrap shrink-0">取消</button>
                <button type="submit" className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0">确认添加</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= MODAL 5: SETTINGS & BACKUP & APK DIRECTORY ================= */}
      {isSettingsModalOpen && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-xl w-full p-6 shadow-xl flex flex-col gap-5 max-h-[90vh] overflow-hidden">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                <Settings className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                <span>系统设置、数据备份与 APK 存储</span>
              </h3>
              <button onClick={() => setIsSettingsModalOpen(false)} className="text-[#91887C] hover:text-[#2E2B27]">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Settings Tabs */}
            <div className="flex flex-row border-b border-[#EDE7DF] gap-4 whitespace-nowrap overflow-x-auto">
              <button
                onClick={() => setSettingsTab('github')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  settingsTab === 'github' ? 'border-[#8E9F8B] text-[#4D5E4A]' : 'border-transparent text-[#7A7367]'
                }`}
              >
                <Wifi className="w-4 h-4 shrink-0" />
                <span>GitHub 凭证与连接</span>
              </button>
              <button
                onClick={() => setSettingsTab('backup')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  settingsTab === 'backup' ? 'border-[#8E9F8B] text-[#4D5E4A]' : 'border-transparent text-[#7A7367]'
                }`}
              >
                <Save className="w-4 h-4 shrink-0" />
                <span>数据备份与恢复</span>
              </button>
              <button
                onClick={() => setSettingsTab('apk')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  settingsTab === 'apk' ? 'border-[#8E9F8B] text-[#4D5E4A]' : 'border-transparent text-[#7A7367]'
                }`}
              >
                <Smartphone className="w-4 h-4 shrink-0" />
                <span>APK 下载存储目录</span>
              </button>
              <button
                onClick={() => setSettingsTab('package')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  settingsTab === 'package' ? 'border-[#8E9F8B] text-[#4D5E4A]' : 'border-transparent text-[#7A7367]'
                }`}
              >
                <FileBox className="w-4 h-4 shrink-0" />
                <span>多端打包中心 (HTML/EXE/APK)</span>
              </button>
            </div>

            {/* TAB 1: GITHUB SETTINGS */}
            {settingsTab === 'github' && (
              <form onSubmit={handleSaveGlobalSettings} className="flex-1 overflow-y-auto flex flex-col gap-4 text-xs pr-1">
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-row items-center justify-between whitespace-nowrap">
                    <label className="text-xs font-semibold text-[#474239]">GitHub Personal Access Token (PAT) *</label>
                    <a
                      href="https://github.com/settings/tokens/new?scopes=repo,read:user"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-[#5D6F5A] hover:underline flex flex-row items-center gap-1 shrink-0"
                    >
                      <span>前往 GitHub 生成</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </div>
                  <input
                    type="password"
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    value={globalToken}
                    onChange={e => setGlobalToken(e.target.value)}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                  />
                  <p className="text-[11px] text-[#91887C] leading-relaxed">
                    用于拉取项目、自动新建私人仓库、批量上传及发布 Release。
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">默认用户名 / 组织名</label>
                  <input
                    type="text"
                    placeholder="例如: your-github-username"
                    value={globalUsername}
                    onChange={e => setGlobalUsername(e.target.value)}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                  />
                </div>

                <div className="flex flex-row items-center justify-between pt-3 border-t border-[#EDE7DF] whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => handleTestGitHubConnection(globalToken)}
                    disabled={testStatus === 'testing' || !globalToken.trim()}
                    className="flex flex-row items-center gap-1.5 px-3 py-2 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-semibold border border-[#DFD8CE] transition disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    <Wifi className="w-3.5 h-3.5 text-[#5D6F5A] shrink-0" />
                    <span>测试当前 Token</span>
                  </button>

                  <div className="flex flex-row items-center gap-3 shrink-0 whitespace-nowrap">
                    <button type="button" onClick={() => setIsSettingsModalOpen(false)} className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium whitespace-nowrap shrink-0">取消</button>
                    <button type="submit" className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0">保存设置</button>
                  </div>
                </div>
              </form>
            )}

            {/* TAB 2: BACKUP & RESTORE SYSTEM */}
            {settingsTab === 'backup' && (
              <div className="flex-1 overflow-y-auto flex flex-col gap-4 text-xs pr-1">
                <div className="bg-[#FAF8F5] p-4 rounded-2xl border border-[#DFD8CE] flex flex-col gap-2">
                  <span className="font-bold text-[#2B2723] flex flex-row items-center gap-2">
                    <Save className="w-4 h-4 text-[#8E9F8B]" />
                    <span>系统设置与项目全量备份</span>
                  </span>
                  <p className="text-[#6B6358] text-[11px] leading-relaxed">
                    一键导出包含全部项目名称、备注、详细描述、标签、归档版本历史、私人仓库同步状态以及全局设置配置的 JSON 备份文件，方便随时在其它设备或重装后恢复。
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={handleExportSystemBackup}
                    className="p-4 bg-[#FFFFFF] hover:bg-[#FAF8F5] border border-[#DFD8CE] rounded-2xl flex flex-col items-center justify-center gap-2 text-center transition shadow-xs"
                  >
                    <Download className="w-6 h-6 text-[#8E9F8B]" />
                    <span className="font-bold text-xs text-[#2B2723]">导出全量备份 (JSON)</span>
                    <span className="text-[10px] text-[#7A7367]">包含 {repos.length} 个项目及完整配置</span>
                  </button>

                  <label className="p-4 bg-[#FFFFFF] hover:bg-[#FAF8F5] border border-[#DFD8CE] rounded-2xl flex flex-col items-center justify-center gap-2 text-center transition shadow-xs cursor-pointer">
                    <Upload className="w-6 h-6 text-[#B6847A]" />
                    <span className="font-bold text-xs text-[#2B2723]">恢复/导入备份 (JSON)</span>
                    <span className="text-[10px] text-[#7A7367]">支持合并导入或完全恢复</span>
                    <input
                      type="file"
                      accept=".json"
                      ref={backupImportInputRef}
                      onChange={handleImportSystemBackup}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            )}

            {/* TAB 3: APK DOWNLOAD DIRECTORY */}
            {settingsTab === 'apk' && (
              <div className="flex-1 overflow-y-auto flex flex-col gap-4 text-xs pr-1">
                {/* APK Environment Status Alert */}
                {isApkEnvironment ? (
                  <div className="bg-[#8E9F8B]/20 border border-[#8E9F8B]/30 p-4 rounded-2xl flex flex-row items-start gap-3">
                    <Smartphone className="w-5 h-5 text-[#5D6F5A] shrink-0 mt-0.5" />
                    <div className="flex flex-col gap-1">
                      <span className="font-bold text-[#2B2723]">已检测到 Android APK 原生环境</span>
                      <p className="text-[11px] text-[#474239] leading-relaxed">
                        新建链接拉取项目时，系统将直接调用文件系统下载并落盘保存至下方设定的本地存储目录中。
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="bg-[#C7A39B]/20 border border-[#C7A39B]/30 p-4 rounded-2xl flex flex-row items-start gap-3">
                    <Info className="w-5 h-5 text-[#8C5D54] shrink-0 mt-0.5" />
                    <div className="flex flex-col gap-1">
                      <span className="font-bold text-[#6F342B]">网页端运行环境提示</span>
                      <p className="text-[11px] text-[#554F45] leading-relaxed">
                        当前运行在 Web 浏览器环境中，受现代浏览器安全沙箱限制，无法直接调用手机 Android 本地原生文件目录；新建链接拉取时将自动保存在应用高速离线存储与文件流中。<strong>在打包为 APK 客户端运行后，该功能将自动激活，直接落盘至您设定的目录。</strong>
                      </p>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">APK 本地存储下载目录</label>
                  <input
                    type="text"
                    value={apkDownloadDirectory}
                    onChange={e => setApkDownloadDirectory(e.target.value)}
                    placeholder="/storage/emulated/0/Download/GitVault"
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B] font-mono"
                  />
                  <p className="text-[11px] text-[#91887C] leading-relaxed">
                    在打包为 Android APK 运行时，新建拉取链接将直接存储到此路径。常用路径推荐：<code>/storage/emulated/0/Download/GitVault</code> 或 <code>/sdcard/Documents/GitVault</code>。
                  </p>
                </div>

                <div className="flex flex-row justify-end pt-3 border-t border-[#EDE7DF] whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => {
                      localStorage.setItem('gitvault_apk_download_dir', apkDownloadDirectory.trim());
                      alert('APK 存储目录已保存！打包为 APK 后将生效。');
                      setIsSettingsModalOpen(false);
                    }}
                    className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0"
                  >
                    保存目录设定
                  </button>
                </div>
              </div>
            )}

            {/* TAB 4: PACKAGING CENTER (HTML / EXE / APK) */}
            {settingsTab === 'package' && (
              <div className="flex-1 overflow-y-auto flex flex-col gap-4 text-xs pr-1">
                <div className="bg-[#FAF8F5] p-4 rounded-2xl border border-[#DFD8CE] flex flex-col gap-2">
                  <span className="font-bold text-[#2B2723] flex flex-row items-center gap-2">
                    <FileBox className="w-4 h-4 text-[#8E9F8B]" />
                    <span>多端打包与导出中心 (HTML / EXE / APK)</span>
                  </span>
                  <p className="text-[#6B6358] text-[11px] leading-relaxed">
                    支持将本项目一键打包为离线静态网页包 (HTML)、Windows 桌面客户端 (.exe) 配置文件或 Android 移动端安装包 (.apk) 配置，满足各种离线及多端部署需求。
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {/* HTML Export */}
                  <div className="p-4 bg-[#FFFFFF] hover:bg-[#FAF8F5] border border-[#DFD8CE] rounded-2xl flex flex-col items-center justify-between gap-3 text-center transition shadow-xs">
                    <div className="flex flex-col items-center gap-2">
                      <FileCode className="w-6 h-6 text-[#8E9F8B]" />
                      <span className="font-bold text-xs text-[#2B2723]">HTML 离线网页包</span>
                      <span className="text-[10px] text-[#7A7367] leading-relaxed">打包为静态 HTML + JSON 离线包，可在任何浏览器直接双击打开运行。</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleExportHtmlBundle}
                      className="w-full py-2 bg-[#7E937F] hover:bg-[#6D826E] text-white rounded-xl text-xs font-semibold transition"
                    >
                      导出 HTML 离线包
                    </button>
                  </div>

                  {/* EXE Export */}
                  <div className="p-4 bg-[#FFFFFF] hover:bg-[#FAF8F5] border border-[#DFD8CE] rounded-2xl flex flex-col items-center justify-between gap-3 text-center transition shadow-xs">
                    <div className="flex flex-col items-center gap-2">
                      <Box className="w-6 h-6 text-[#5D6F5A]" />
                      <span className="font-bold text-xs text-[#2B2723]">EXE 桌面客户端</span>
                      <span className="text-[10px] text-[#7A7367] leading-relaxed">下载 Electron 打包配置与主进程脚本，配合 electron-builder 生成 Windows .exe。</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleDownloadElectronConfig}
                      className="w-full py-2 bg-[#7E937F] hover:bg-[#6D826E] text-white rounded-xl text-xs font-semibold transition"
                    >
                      下载 EXE 配置包
                    </button>
                  </div>

                  {/* APK Export */}
                  <div className="p-4 bg-[#FFFFFF] hover:bg-[#FAF8F5] border border-[#DFD8CE] rounded-2xl flex flex-col items-center justify-between gap-3 text-center transition shadow-xs">
                    <div className="flex flex-col items-center gap-2">
                      <Smartphone className="w-6 h-6 text-[#B6847A]" />
                      <span className="font-bold text-xs text-[#2B2723]">APK 安卓客户端</span>
                      <span className="text-[10px] text-[#7A7367] leading-relaxed">下载 Capacitor 配置与编译指南，结合 Android Studio 一键生成 Android APK。</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleDownloadCapacitorConfig}
                      className="w-full py-2 bg-[#7E937F] hover:bg-[#6D826E] text-white rounded-xl text-xs font-semibold transition"
                    >
                      下载 APK 配置包
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= MODAL 6: BATCH RELEASE CONFIRMATION ================= */}
      {isBatchReleaseModalOpen && activeRepo && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-xl w-full p-6 shadow-xl flex flex-col gap-5">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                <UploadCloud className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                <span>批量发布 Release 到 GitHub</span>
              </h3>
              <button
                disabled={isBatchPublishing}
                onClick={() => setIsBatchReleaseModalOpen(false)}
                className="text-[#91887C] hover:text-[#2E2B27] disabled:opacity-30"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-[#FAF8F5] p-3.5 rounded-xl border border-[#DFD8CE] text-xs text-[#2E2B27] flex flex-col gap-1">
              <p>
                <strong>目标仓库:</strong> <code className="font-mono text-[#4D5E4A]">{activeRepo.owner}/{activeRepo.repo}</code>
              </p>
              <p className="text-[#7A7367]">
                已选定 <strong>{batchReleaseProgress.length}</strong> 个归档版本进行批量发布。系统将依序为每个版本在 GitHub 上建立 Tag 并生成正式 Release。
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-[#474239]">Release 标题后缀标识</label>
              <input
                type="text"
                value={batchReleaseTitlePrefix}
                onChange={e => setBatchReleaseTitlePrefix(e.target.value)}
                className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
              />
            </div>

            {/* Progress list */}
            <div className="max-h-56 overflow-y-auto flex flex-col gap-2 border border-[#E5DFD7] rounded-xl p-3 bg-[#FAF8F5]">
              {batchReleaseProgress.map(item => (
                <div key={item.id} className="flex flex-row items-center justify-between p-2.5 rounded-lg bg-[#FFFFFF] border border-[#EDE7DF] text-xs whitespace-nowrap">
                  <span className="font-mono font-semibold text-[#2B2723] truncate mr-2">{item.tag}</span>
                  <div className="shrink-0">
                    {item.status === 'pending' && <span className="text-[#7A7367]">待发布</span>}
                    {item.status === 'releasing' && (
                      <span className="text-[#8E9F8B] font-medium flex flex-row items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" /> 发布中...
                      </span>
                    )}
                    {item.status === 'success' && (
                      <span className="text-[#5D6F5A] font-semibold flex flex-row items-center gap-1">
                        <CheckCircle className="w-3.5 h-3.5 shrink-0" /> 成功
                      </span>
                    )}
                    {item.status === 'error' && (
                      <span className="text-[#B6847A] font-semibold flex flex-row items-center gap-1" title={item.error}>
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" /> 失败
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-row items-center justify-end gap-3 pt-3 border-t border-[#EDE7DF] whitespace-nowrap">
              <button
                type="button"
                disabled={isBatchPublishing}
                onClick={() => setIsBatchReleaseModalOpen(false)}
                className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                关闭
              </button>
              <button
                type="button"
                disabled={isBatchPublishing}
                onClick={handleStartBatchPublish}
                className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                {isBatchPublishing ? '正在批量发布...' : '开始批量发布'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= MODAL 7: PROJECT SETTINGS & FOLDER DOWNLOAD ================= */}
      {isProjectSettingsModalOpen && projectSettingsTarget && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-2xl w-full p-6 shadow-xl flex flex-col gap-5 max-h-[88vh] overflow-hidden">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <div>
                <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                  <SlidersHorizontal className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                  <span>项目设置与自选文件夹下载</span>
                </h3>
                <p className="text-xs text-[#7A7367] mt-0.5">
                  项目: <code className="font-mono text-[#4D5E4A]">{projectSettingsTarget.owner}/{projectSettingsTarget.repo}</code>
                </p>
              </div>
              <button onClick={() => setIsProjectSettingsModalOpen(false)} className="text-[#91887C] hover:text-[#2E2B27]">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Tabs - Horizontal row, no wrap */}
            <div className="flex flex-row border-b border-[#EDE7DF] gap-4 whitespace-nowrap overflow-x-auto">
              <button
                onClick={() => setProjectSettingsTab('folderDownload')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  projectSettingsTab === 'folderDownload'
                    ? 'border-[#8E9F8B] text-[#4D5E4A]'
                    : 'border-transparent text-[#7A7367] hover:text-[#2E2B27]'
                }`}
              >
                <FolderDown className="w-4 h-4 shrink-0" />
                <span>下载自选文件夹 (APK适配)</span>
              </button>
              <button
                onClick={() => setProjectSettingsTab('basic')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  projectSettingsTab === 'basic'
                    ? 'border-[#8E9F8B] text-[#4D5E4A]'
                    : 'border-transparent text-[#7A7367] hover:text-[#2E2B27]'
                }`}
              >
                <Edit3 className="w-4 h-4 shrink-0" />
                <span>项目备注、描述与专属 Token</span>
              </button>
              <button
                onClick={() => setProjectSettingsTab('storage')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  projectSettingsTab === 'storage'
                    ? 'border-[#8E9F8B] text-[#4D5E4A]'
                    : 'border-transparent text-[#7A7367] hover:text-[#2E2B27]'
                }`}
              >
                <HardDrive className="w-4 h-4 shrink-0" />
                <span>本地存储与缓存</span>
              </button>
            </div>

            {/* TAB CONTENT 1: FOLDER DOWNLOAD FOR APK & CUSTOM DIRECTORY */}
            {projectSettingsTab === 'folderDownload' && (
              <div className="flex-1 overflow-y-auto flex flex-col gap-4 text-xs pr-1">
                <div className="bg-[#FAF8F5] p-3.5 rounded-2xl border border-[#DFD8CE] flex flex-row items-start gap-3">
                  <Smartphone className="w-5 h-5 text-[#8E9F8B] shrink-0 mt-0.5" />
                  <div className="flex flex-col gap-1">
                    <span className="font-bold text-[#2B2723] whitespace-nowrap">专为后续打包为 Android APK 离线环境设计</span>
                    <p className="text-[11px] text-[#554F45] leading-relaxed">
                      支持自由选择项目仓库内的任意子目录（例如 <code>src</code>、<code>public</code>、<code>assets</code>、<code>android</code> 或纯核心代码文件夹），单独打包下载并附带 APK 离线资源清单，方便在 APK 本地文件系统或离线模块中使用。
                    </p>
                  </div>
                </div>

                {/* Folder Selector */}
                <div className="flex flex-col gap-2">
                  <div className="flex flex-row items-center justify-between whitespace-nowrap">
                    <label className="text-xs font-semibold text-[#474239]">选择要打包下载的文件夹路径</label>
                    <span className="text-[11px] text-[#7A7367] font-mono shrink-0">
                      可选目录: {availableFolders.length} 个
                    </span>
                  </div>

                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#91887C] absolute left-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="快速过滤目录名称..."
                      value={folderFilterQuery}
                      onChange={e => setFolderFilterQuery(e.target.value)}
                      className="w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl pl-9 pr-3 py-1.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
                    />
                  </div>

                  {/* Folder Options Grid - Each item is strictly single horizontal row */}
                  <div className="max-h-40 overflow-y-auto border border-[#E5DFD7] rounded-xl p-2 bg-[#FAF8F5] grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {availableFolders
                      .filter(f => f.toLowerCase().includes(folderFilterQuery.toLowerCase()))
                      .map(folder => {
                        const isSelected = selectedFolderToDownload === folder;
                        const count = folder === '/'
                          ? projectSettingsTarget.tree.filter(t => t.type === 'blob').length
                          : projectSettingsTarget.tree.filter(t => t.type === 'blob' && (t.path === folder || t.path.startsWith(folder + '/'))).length;

                        return (
                          <div
                            key={folder}
                            onClick={() => setSelectedFolderToDownload(folder)}
                            className={`p-2.5 rounded-xl flex flex-row items-center justify-between cursor-pointer transition border whitespace-nowrap overflow-hidden ${
                              isSelected
                                ? 'bg-[#8E9F8B]/20 border-[#8E9F8B] text-[#2B2723] font-semibold'
                                : 'bg-[#FFFFFF] border-[#E5DFD7] text-[#474239] hover:bg-[#FAF8F5]'
                            }`}
                          >
                            <div className="flex flex-row items-center gap-1.5 min-w-0 flex-1 mr-2 overflow-hidden">
                              <Folder className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-[#5D6F5A]' : 'text-[#C7A39B]'}`} />
                              <span className="truncate font-mono text-[11px]">
                                {folder === '/' ? '项目完整根目录 (/)' : folder}
                              </span>
                            </div>
                            <span className="text-[10px] text-[#7A7367] font-mono shrink-0 whitespace-nowrap ml-1">
                              {count} 文件
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>

                {/* Selected Folder Summary Card - Single line */}
                <div className="bg-[#FFFFFF] p-3.5 rounded-xl border border-[#DFD8CE] flex flex-row items-center justify-between whitespace-nowrap">
                  <div className="truncate mr-2">
                    <span className="font-semibold text-[#2B2723]">当前自选文件夹:</span>{' '}
                    <code className="text-[#5D6F5A] font-bold font-mono text-xs">
                      {selectedFolderToDownload === '/' ? '整个项目根目录' : selectedFolderToDownload}
                    </code>
                  </div>
                  <div className="flex flex-row items-center gap-2 font-mono text-xs shrink-0 whitespace-nowrap">
                    <span className="text-[#7A7367]">共 {filesInSelectedFolder.length} 个文件</span>
                    <span className="font-semibold text-[#2B2723]">({formatFileSize(folderTotalSize)})</span>
                  </div>
                </div>

                {/* APK Storage Destination Path Settings */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">移动端 / APK 本地相对存储路径规范</label>
                  <input
                    type="text"
                    value={apkTargetDirectory}
                    onChange={e => setApkTargetDirectory(e.target.value)}
                    placeholder="Download/GitVault/projects/my-app/"
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B] font-mono"
                  />
                  <p className="text-[11px] text-[#91887C]">
                    打包输出时将记录此路径，便于后续在 Android APK 应用内使用文件管理 API 进行精准本地解压定位。
                  </p>
                </div>

                <label className="flex flex-row items-center gap-2 text-xs text-[#524D44] cursor-pointer select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={includeApkManifest}
                    onChange={e => setIncludeApkManifest(e.target.checked)}
                    className="rounded border-[#D5CDC2] text-[#8E9F8B] focus:ring-0 shrink-0"
                  />
                  <span>压缩包内附带 APK 离线清单文件 (gitvault-apk-manifest.json)</span>
                </label>

                {/* Action button - Strictly single horizontal line */}
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleDownloadSelectedFolder}
                    disabled={isDownloadingFolder || filesInSelectedFolder.length === 0}
                    className="w-full flex flex-row items-center justify-center gap-2 py-3 px-4 bg-gradient-to-r from-[#7E937F] via-[#8E9F8B] to-[#B6847A] hover:brightness-105 disabled:opacity-40 text-white rounded-xl text-xs font-semibold shadow-xs transition whitespace-nowrap shrink-0"
                  >
                    {isDownloadingFolder ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        <span>正在打包下载自选文件夹...</span>
                      </>
                    ) : (
                      <>
                        <FolderDown className="w-4 h-4 shrink-0" />
                        <span>打包下载自选文件夹 ({selectedFolderToDownload === '/' ? '根目录' : selectedFolderToDownload}) .zip</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* TAB CONTENT 2: BASIC SETTINGS & TOKEN & DESCRIPTION */}
            {projectSettingsTab === 'basic' && (
              <form onSubmit={handleSaveProjectSettings} className="flex-1 overflow-y-auto flex flex-col gap-4 text-xs pr-1">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">项目备注说明</label>
                  <input
                    type="text"
                    value={projectRemark}
                    onChange={e => setProjectRemark(e.target.value)}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">项目详细描述 (随项目上传至私人仓库)</label>
                  <textarea
                    rows={3}
                    value={projectDescription}
                    onChange={e => setProjectDescription(e.target.value)}
                    placeholder="输入项目的核心用途、技术栈或架构说明..."
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B] resize-none"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">项目标签 (逗号分隔)</label>
                  <input
                    type="text"
                    value={projectTags}
                    onChange={e => setProjectTags(e.target.value)}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">定时自动检测远程状态频率</label>
                  <select
                    value={projectCheckInterval}
                    onChange={e => setProjectCheckInterval(Number(e.target.value))}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
                  >
                    <option value={0}>仅手动检测 (不自动轮询)</option>
                    <option value={5}>每 5 分钟自动检测一次</option>
                    <option value={15}>每 15 分钟自动检测一次</option>
                    <option value={30}>每 30 分钟自动检测一次</option>
                    <option value={60}>每 1 小时自动检测一次</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-row items-center justify-between whitespace-nowrap">
                    <label className="text-xs font-semibold text-[#474239]">项目专属 GitHub Token (覆盖全局)</label>
                    <button
                      type="button"
                      onClick={handleTestProjectToken}
                      disabled={projectTokenTestStatus === 'testing' || !projectToken.trim()}
                      className="flex flex-row items-center gap-1 text-xs text-[#5D6F5A] hover:text-[#2E2B27] font-semibold bg-[#8E9F8B]/20 hover:bg-[#8E9F8B]/30 px-2 py-0.5 rounded-lg border border-[#8E9F8B]/40 transition disabled:opacity-40 whitespace-nowrap shrink-0"
                    >
                      {projectTokenTestStatus === 'testing' ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : <Wifi className="w-3 h-3 shrink-0" />}
                      <span>测试该 Token</span>
                    </button>
                  </div>
                  <input
                    type="password"
                    placeholder="留空则自动使用全局设置中的 Token"
                    value={projectToken}
                    onChange={e => setProjectToken(e.target.value)}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
                  />

                  {projectTokenTestStatus === 'success' && (
                    <div className="bg-[#8E9F8B]/15 border border-[#8E9F8B]/30 p-2.5 rounded-xl text-xs text-[#3D4F3A] flex flex-row items-center gap-2 whitespace-nowrap">
                      <CheckCircle className="w-4 h-4 text-[#5D6F5A] shrink-0" />
                      <span>{projectTokenTestMsg}</span>
                    </div>
                  )}

                  {projectTokenTestStatus === 'error' && (
                    <div className="bg-[#C7A39B]/20 border border-[#C7A39B]/30 p-2.5 rounded-xl text-xs text-[#8C5D54] flex flex-row items-center gap-2 whitespace-nowrap">
                      <AlertCircle className="w-4 h-4 text-[#B6847A] shrink-0" />
                      <span>{projectTokenTestMsg}</span>
                    </div>
                  )}
                </div>

                <div className="pt-2 flex flex-row justify-end gap-3 border-t border-[#EDE7DF] whitespace-nowrap">
                  <button type="button" onClick={() => setIsProjectSettingsModalOpen(false)} className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium whitespace-nowrap shrink-0">取消</button>
                  <button type="submit" className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0">保存修改</button>
                </div>
              </form>
            )}

            {/* TAB CONTENT 3: STORAGE & CACHE RETENTION */}
            {projectSettingsTab === 'storage' && (
              <div className="flex-1 overflow-y-auto flex flex-col gap-4 text-xs pr-1">
                <div className="bg-[#FAF8F5] p-4 rounded-2xl border border-[#DFD8CE] flex flex-col gap-3">
                  <div className="flex flex-row items-center justify-between whitespace-nowrap">
                    <span className="font-bold text-[#2B2723]">本地缓存状态</span>
                    {projectSettingsTarget.isCachePurged ? (
                      <span className="text-[11px] bg-[#EFECE6] text-[#6B6358] px-2.5 py-0.5 rounded-full font-mono flex flex-row items-center gap-1 border border-[#DFD8CE] whitespace-nowrap shrink-0">
                        <Archive className="w-3 h-3 shrink-0" />
                        <span>已释放 (节省空间)</span>
                      </span>
                    ) : (
                      <span className="text-[11px] bg-[#8E9F8B]/20 text-[#4D5E4A] px-2.5 py-0.5 rounded-full font-mono font-medium whitespace-nowrap shrink-0">
                        就绪 ({projectSettingsTarget.tree.length} 文件)
                      </span>
                    )}
                  </div>
                  <p className="text-[#6B6358] text-[11px] leading-relaxed">
                    销毁本地文件树缓存可极大节省浏览器的存储空间。云端 GitHub 仓库数据不受任何影响，GitVault 软件内完整保留项目元数据与归档历史，支持随时一键重新拉取还原（同源互通）。
                  </p>
                </div>

                <div className="flex flex-row items-center gap-3 pt-2 whitespace-nowrap">
                  {projectSettingsTarget.isCachePurged ? (
                    <button
                      type="button"
                      onClick={() => handleRepullProjectCache(projectSettingsTarget.id)}
                      className="flex-1 flex flex-row items-center justify-center gap-2 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0"
                    >
                      <RefreshCcw className="w-4 h-4 shrink-0" />
                      <span>从 GitHub 重新拉取还原完整缓存 (同源互通)</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handlePurgeProjectCache(projectSettingsTarget.id)}
                      className="flex-1 flex flex-row items-center justify-center gap-2 py-2.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#7A7367] rounded-xl text-xs font-medium border border-[#DFD8CE] whitespace-nowrap shrink-0"
                    >
                      <Archive className="w-4 h-4 shrink-0" />
                      <span>销毁/释放本地大文件缓存 (仅保留元数据)</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Global Async Loading Modal */}
      {isLoading && (
        <div className="fixed inset-0 bg-[#33302C]/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl p-6 shadow-xl flex flex-row items-center gap-3.5 max-w-sm w-full whitespace-nowrap">
            <Loader2 className="w-6 h-6 text-[#8E9F8B] animate-spin shrink-0" />
            <span className="text-xs font-medium text-[#2E2B27] truncate">{loadingText}</span>
          </div>
        </div>
      )}

      {/* Classic App Bottom Navigation Bar (经典移动端/应用底栏 TabBar 样式) */}
      <nav className="fixed bottom-0 inset-x-0 z-40 bg-[#FFFFFF]/95 backdrop-blur-md border-t border-[#E5DFD7] shadow-[0_-4px_24px_rgba(0,0,0,0.05)] pb-safe">
        <div className="max-w-lg mx-auto px-4 h-16 flex items-center justify-around select-none">
          {/* 1. 主页 Tab */}
          <button
            type="button"
            onClick={() => { setCurrentView('dashboard'); setActiveRepoId(null); setViewingBackup(null); }}
            className={`flex flex-col items-center justify-center flex-1 h-full py-1 transition-all group ${
              currentView === 'dashboard'
                ? 'text-[#485C45]'
                : 'text-[#8C857B] hover:text-[#2E2B27]'
            }`}
          >
            <div className={`p-1.5 rounded-xl transition ${currentView === 'dashboard' ? 'bg-[#8E9F8B]/20 text-[#3D4F3A]' : 'group-hover:bg-[#FAF8F5]'}`}>
              <LayoutDashboard className="w-5 h-5 shrink-0" />
            </div>
            <span className={`text-[11px] tracking-tight mt-0.5 whitespace-nowrap ${currentView === 'dashboard' ? 'font-bold text-[#3D4F3A]' : 'font-medium'}`}>
              主页
            </span>
          </button>

          {/* 2. 项目库 Tab */}
          <button
            type="button"
            onClick={() => { setCurrentView('projects'); setActiveRepoId(null); setViewingBackup(null); }}
            className={`flex flex-col items-center justify-center flex-1 h-full py-1 transition-all group ${
              currentView === 'projects'
                ? 'text-[#485C45]'
                : 'text-[#8C857B] hover:text-[#2E2B27]'
            }`}
          >
            <div className={`relative p-1.5 rounded-xl transition ${currentView === 'projects' ? 'bg-[#8E9F8B]/20 text-[#3D4F3A]' : 'group-hover:bg-[#FAF8F5]'}`}>
              <FolderGit2 className="w-5 h-5 shrink-0" />
              {repos.length > 0 && (
                <span className="absolute -top-1 -right-2 px-1.5 min-w-[16px] h-4 text-[10px] font-bold bg-[#C7A39B] text-white rounded-full flex items-center justify-center border-2 border-[#FFFFFF] shadow-2xs leading-none">
                  {repos.length}
                </span>
              )}
            </div>
            <span className={`text-[11px] tracking-tight mt-0.5 whitespace-nowrap ${currentView === 'projects' ? 'font-bold text-[#3D4F3A]' : 'font-medium'}`}>
              项目库
            </span>
          </button>

          {/* 3. 新建拉取 (经典微凸中心主操作按键) */}
          <div className="flex flex-col items-center justify-center flex-1 h-full relative">
            <button
              type="button"
              onClick={() => setIsAddModalOpen(true)}
              className="relative -top-3 w-12 h-12 rounded-2xl bg-gradient-to-tr from-[#7E937F] via-[#8E9F8B] to-[#A3B4A0] text-white shadow-lg shadow-[#8E9F8B]/35 flex items-center justify-center border-[3px] border-[#FFFFFF] hover:scale-105 active:scale-95 transition-all duration-200 group"
              title="新建链接 / 直接拉取项目"
            >
              <Plus className="w-6 h-6 stroke-[2.5] group-hover:rotate-90 transition-transform duration-200" />
            </button>
            <span className="text-[10px] font-semibold text-[#5D6F5A] -mt-2 tracking-tight whitespace-nowrap">
              新建拉取
            </span>
          </div>

          {/* 4. 工作台 Tab */}
          <button
            type="button"
            onClick={() => {
              if (activeRepoId) {
                setCurrentView('workbench');
              } else if (repos.length > 0) {
                setActiveRepoId(repos[0].id);
                setCurrentView('workbench');
              } else {
                setCurrentView('projects');
              }
            }}
            className={`flex flex-col items-center justify-center flex-1 h-full py-1 transition-all group ${
              currentView === 'workbench'
                ? 'text-[#485C45]'
                : 'text-[#8C857B] hover:text-[#2E2B27]'
            }`}
          >
            <div className={`relative p-1.5 rounded-xl transition ${currentView === 'workbench' ? 'bg-[#8E9F8B]/20 text-[#3D4F3A]' : 'group-hover:bg-[#FAF8F5]'}`}>
              <FileCode className="w-5 h-5 shrink-0" />
              {activeRepoId && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#5D6F5A] border border-white" />
              )}
            </div>
            <span className={`text-[11px] tracking-tight mt-0.5 whitespace-nowrap ${currentView === 'workbench' ? 'font-bold text-[#3D4F3A]' : 'font-medium'}`}>
              工作台
            </span>
          </button>

          {/* 5. 设置与备份 Tab */}
          <button
            type="button"
            onClick={() => setIsSettingsModalOpen(true)}
            className={`flex flex-col items-center justify-center flex-1 h-full py-1 transition-all group ${
              isSettingsModalOpen
                ? 'text-[#485C45]'
                : 'text-[#8C857B] hover:text-[#2E2B27]'
            }`}
          >
            <div className={`relative p-1.5 rounded-xl transition ${isSettingsModalOpen ? 'bg-[#8E9F8B]/20 text-[#3D4F3A]' : 'group-hover:bg-[#FAF8F5]'}`}>
              <Settings className="w-5 h-5 shrink-0" />
              {!globalToken && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#C7A39B] border border-white" title="未配置 Token" />
              )}
            </div>
            <span className={`text-[11px] tracking-tight mt-0.5 whitespace-nowrap ${isSettingsModalOpen ? 'font-bold text-[#3D4F3A]' : 'font-medium'}`}>
              设置
            </span>
          </button>
        </div>
      </nav>
    </div>
  );
}
