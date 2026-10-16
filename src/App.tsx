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
  FileText, Shield, Save
} from 'lucide-react';
const RepoHeatmap = React.lazy(() => import('./components/RepoHeatmap'));
import { localCache, transferCache, CachedFile } from './utils/localCache';
import { githubClient, beginGithubOperation, cancelGithubOperation, operationSignal, parseRepository, gitBlobSha, GitHubError, TargetRepositoryError } from './utils/githubClient';
import { safeFetchJson } from './utils/api';
import { sourceOf, savedSnapshot, archiveVersion, renamedProject, targetForBranch, assertBranchTarget } from './utils/projectModel';
import { parseImportLinks, type ImportLink } from './utils/importLinks';
import { runProjectBatch, type ProjectBatchItem } from './utils/batchOperations';
import { importCandidates, compareImportTrees, sameRepository, type ImportCandidate } from './utils/importAssociation';
import { projectTargets, detachedTarget, sameTarget, targetHealthOf, targetKey, type TargetHealth, type TargetIdentity } from './utils/targetLifecycle';
import type { ProjectSource, UploadTarget, RemoteSnapshot, BackupVersion } from './utils/projectModel';

interface RepoTreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface TrackedRepo {
  targetHealth?: Record<string, TargetHealth>;
  detachedTargets?: TargetIdentity[];
  remoteSnapshot?: RemoteSnapshot;
  uploadTarget?: UploadTarget;
  branchTargets?: Record<string, UploadTarget>;
  branchUploadPending?: boolean;
  origin?: ProjectSource;
  savedCopies?: RemoteSnapshot[];
  forkScope?: 'current' | 'full';
  forkTarget?: { id?: number; owner: string; repo: string; branch: string; htmlUrl: string; branches?: string[]; token?: string };
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

type ImportComparison = { status: 'loading' | 'ready' | 'error'; error?: string; target?: UploadTarget; sourceSha?: string; commitSha?: string; missingBranch?: boolean; diff?: ReturnType<typeof compareImportTrees> };
type ImportChoice = { candidate: ImportCandidate; comparison: ImportComparison } | 'independent' | 'skip';

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

function publicProjectRecord({ token, uploadTarget, branchTargets, forkTarget, ...repo }: TrackedRepo) {
  return { ...repo, forkTarget: forkTarget ? { ...forkTarget, token: undefined } : undefined, uploadTarget: uploadTarget ? { ...uploadTarget, token: undefined } : undefined, branchTargets: branchTargets ? Object.fromEntries(Object.entries(branchTargets).map(([branch, target]) => [branch, { ...target, token: undefined }])) : undefined };
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }

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
  const [batchTask, setBatchTask] = useState<'fork' | 'update' | 'sync' | null>(null);
  const [batchTaskItems, setBatchTaskItems] = useState<ProjectBatchItem[]>([]);
  const [batchTaskRunning, setBatchTaskRunning] = useState(false);
  const batchTaskLock = useRef(false);
  const [batchForkScope, setBatchForkScope] = useState<'current' | 'full'>('full');
  const [batchTaskToken, setBatchTaskToken] = useState('');
  const [batchForkPurge, setBatchForkPurge] = useState(false);

  // Batch Release & Cache Purge state in Backups tab
  const [selectedBackupIds, setSelectedBackupIds] = useState<string[]>([]);
  const [purgeCacheOption, setPurgeCacheOption] = useState<boolean>(false);
  const [isBatchReleaseModalOpen, setIsBatchReleaseModalOpen] = useState(false);
  const [batchReleaseProgress, setBatchReleaseProgress] = useState<BatchReleaseItemStatus[]>([]);
  const [batchReleaseTitlePrefix, setBatchReleaseTitlePrefix] = useState('归档发布');
  const [isBatchPublishing, setIsBatchPublishing] = useState(false);

  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isPushModalOpen, setIsPushModalOpen] = useState(false);
  const [isSingleUploadModalOpen, setIsSingleUploadModalOpen] = useState(false);
  const [singleUploadTargetRepo, setSingleUploadTargetRepo] = useState<TrackedRepo | null>(null);
  const [targetManagerId, setTargetManagerId] = useState<string | null>(null);
  const [targetManagerToken, setTargetManagerToken] = useState('');
  const [targetManagerMessage, setTargetManagerMessage] = useState('');
  const [targetManagerBusy, setTargetManagerBusy] = useState(false);
  const [detachedTargetName, setDetachedTargetName] = useState('');
  const latestTargetChecks = useRef(new Map<string, number>());
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'github' | 'backup' | 'apk'>('github');
  const [isDiffModalOpen, setIsDiffModalOpen] = useState(false);
  const [diffBackupTarget, setDiffBackupTarget] = useState<BackupVersion | null>(null);

  // Project Settings & Folder Download Modal state
  const [isProjectSettingsModalOpen, setIsProjectSettingsModalOpen] = useState(false);
  const [projectSettingsTarget, setProjectSettingsTarget] = useState<TrackedRepo | null>(null);
  const [projectSettingsTab, setProjectSettingsTab] = useState<'folderDownload' | 'basic' | 'storage'>('folderDownload');
  const [selectedFolderToDownload, setSelectedFolderToDownload] = useState<string>('/');
  const [folderFilterQuery, setFolderFilterQuery] = useState<string>('');
  const [apkTargetDirectory, setApkTargetDirectory] = useState<string>('');
  const [includeApkManifest, setIncludeApkManifest] = useState<boolean>(false);
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
  const [purgePushCacheOption, setPurgePushCacheOption] = useState<boolean>(false);

  // Single Private Repo Upload state
  const [singleUploadRepoName, setSingleUploadRepoName] = useState('');
  const [singleUploadDescription, setSingleUploadDescription] = useState('');
  const [singleUploadRemark, setSingleUploadRemark] = useState('');
  const [singleUploadPurgeCache, setSingleUploadPurgeCache] = useState(false);
  const [isUploadingToPrivate, setIsUploadingToPrivate] = useState(false);
  const [projectSyncTab, setProjectSyncTab] = useState<'privateRepo' | 'fork'>('privateRepo');
  const [isForking, setIsForking] = useState(false);
  const [forkScope, setForkScope] = useState<'current' | 'full'>('current');
  const [forkRepoName, setForkRepoName] = useState('');
  const [pushCopyMode, setPushCopyMode] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const [importMode, setImportMode] = useState<'single' | 'batch'>('single');
  const [batchLinks, setBatchLinks] = useState('');
  const [importResults, setImportResults] = useState<ImportLink[]>([]);
  const [workbenchBranches, setWorkbenchBranches] = useState<string[]>([]);
  const [workbenchBranchInput, setWorkbenchBranchInput] = useState('');
  const [workbenchBranchError, setWorkbenchBranchError] = useState('');
  const [workbenchBranchLoading, setWorkbenchBranchLoading] = useState(false);
  const workbenchLookup = useRef<AbortController | null>(null);

  // Form states for adding repo (Link)
  const [repoUrl, setRepoUrl] = useState('');
  const [branchInput, setBranchInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [remarkInput, setRemarkInput] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [tagsInput, setTagsInput] = useState('默认');
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branchError, setBranchError] = useState('');
  const branchLookup = useRef<AbortController | null>(null);
  const branchLookupId = useRef(0);

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

  // Cancel obsolete lookups so an old repository response cannot overwrite the current form.
  useEffect(() => {
    branchLookup.current?.abort();
    branchLookupId.current++;
    setIsLoadingBranches(false); setAvailableBranches([]); setBranchError('');
    return () => { branchLookup.current?.abort(); branchLookupId.current++; };
  }, [repoUrl, tokenInput, globalToken, isAddModalOpen]);

  const handleFetchBranches = async () => {
    if (!repoUrl.trim()) { setBranchError('请先填写 GitHub 仓库地址'); return; }
    branchLookup.current?.abort();
    const controller = new AbortController();
    branchLookup.current = controller;
    const requestId = ++branchLookupId.current;
    setIsLoadingBranches(true); setBranchError('');
    try {
      const branches = await githubClient.fetchBranches(repoUrl.trim(), tokenInput.trim() || globalToken.trim(), controller.signal);
      if (requestId !== branchLookupId.current) return;
      setAvailableBranches(branches);
      const linked = parseRepository(repoUrl).linkedRef;
      const linkedBranch = branches.filter(name => linked === name || linked.startsWith(name + '/')).sort((a, b) => b.length - a.length)[0];
      setBranchInput(branches.includes(branchInput) ? branchInput : linkedBranch || branches[0]);
    } catch (error) {
      if (requestId !== branchLookupId.current || controller.signal.aborted) return;
      setAvailableBranches([]);
      setBranchError((error as Error).message || '获取分支失败，请重试');
    } finally {
      if (requestId === branchLookupId.current) setIsLoadingBranches(false);
    }
  };

  // Async / Operation Loading
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [importMatch, setImportMatch] = useState<{ source: ProjectSource; sha: string; tree: RepoTreeItem[]; candidates: ImportCandidate[]; token: string; comparisons: Record<string, ImportComparison> } | null>(null);
  const importResolver = useRef<((choice: ImportChoice) => void) | null>(null);
  const importSession = useRef(0);
  const importLock = useRef(false);
  useEffect(() => () => { importSession.current++; if (importLock.current) cancelGithubOperation(); importResolver.current = null; }, []);
  useEffect(() => {
    if (!importMatch) return;
    const dialog = document.querySelector<HTMLElement>('[aria-label="选择已有项目作为同步基础"]');
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [href], input:not(:disabled), [tabindex="0"]')];
    const focus = () => controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); cancelGithubOperation(); }
      if (event.key !== 'Tab') return;
      const list = controls(), first = list[0], last = list[list.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    const focusin = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) focus(); };
    focus(); document.addEventListener('keydown', keydown); document.addEventListener('focusin', focusin);
    return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('focusin', focusin); if (previous?.isConnected) previous.focus(); };
  }, [!!importMatch]);
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

  const reposRef = useRef(repos);
  reposRef.current = repos;
  const checkingRepos = useRef(new Set<string>());
  const fileRequest = useRef(0);
  const [visibleFileCount, setVisibleFileCount] = useState(150);
  const startOperation = () => { beginGithubOperation(); setIsLoading(true); };
  useEffect(() => {
    const listener = (event: Event) => setLoadingText((event as CustomEvent<string>).detail);
    window.addEventListener('gitvault-progress', listener);
    return () => window.removeEventListener('gitvault-progress', listener);
  }, []);
  useEffect(() => { setHistoryPage(1); setHistoryHasMore(true); }, [activeRepoId, repos.find(repo => repo.id === activeRepoId)?.branch]);
  useEffect(() => {
    workbenchLookup.current?.abort();
    setWorkbenchBranches([]); setWorkbenchBranchError(''); setWorkbenchBranchLoading(false);
    setWorkbenchBranchInput(reposRef.current.find(repo => repo.id === activeRepoId)?.branch || '');
    return () => workbenchLookup.current?.abort();
  }, [activeRepoId]);
  useEffect(() => { setVisibleFileCount(150); }, [activeRepoId, viewingBackup?.id, fileSearchQuery]);

  // Persist a reviewable record before deleting any local source content.
  const persistRepos = (next: TrackedRepo[]) => {
    localStorage.setItem('gitvault_repos_v8', JSON.stringify(next));
    reposRef.current = next;
    setRepos(next);
  };
  const patchRepo = (id: string, patch: Partial<TrackedRepo>) => {
    persistRepos(reposRef.current.map(repo => repo.id === id ? { ...repo, ...patch } : repo));
  };
  useEffect(() => {
    const listener = (event: Event) => {
      const { target, health, identity, checkId } = (event as CustomEvent<{ target: TargetIdentity; health: TargetHealth; identity?: { id?: number; owner: string; repo: string; htmlUrl: string }; checkId: number }>).detail;
      const key = targetKey(target);
      if ((latestTargetChecks.current.get(key) || 0) > checkId) return;
      latestTargetChecks.current.set(key, checkId);
      let changed = false;
      const next = reposRef.current.map(project => {
        if (!projectTargets(project).some(item => sameTarget(item, target))) return project;
        changed = true;
        const renamed = identity && target.id && identity.id === target.id && !sameRepository(target, identity)
          ? renamedProject(project, { ...target, branch: '', purgeAfterUpload: false }, identity) : project;
        return { ...renamed, targetHealth: { ...renamed.targetHealth, [targetKey(health)]: health } };
      });
      if (changed) { try { persistRepos(next); } catch { setErrorMsg('远端状态保存失败，请检查浏览器存储空间'); } }
    };
    window.addEventListener('gitvault-target-health', listener);
    return () => window.removeEventListener('gitvault-target-health', listener);
  }, []);
  useEffect(() => {
    if (singleUploadTargetRepo) {
      const current = repos.find(project => project.id === singleUploadTargetRepo.id) || null;
      if (current?.uploadTarget && current.uploadTarget.repo !== singleUploadTargetRepo.uploadTarget?.repo) setSingleUploadRepoName(current.uploadTarget.repo);
      setSingleUploadTargetRepo(current);
    }
  }, [repos, singleUploadTargetRepo?.id]);

  const targetToken = (repo: TrackedRepo, target: TargetIdentity, override = '') => override || [repo.uploadTarget, repo.forkTarget, ...Object.values(repo.branchTargets || {})].find(binding => binding && sameTarget(binding, target))?.token || globalToken || repo.token || '';
  const checkRepoTargets = async (repo: TrackedRepo, override = '', signal = operationSignal()) => {
    for (const target of projectTargets(repo)) {
      signal.throwIfAborted();
      try { await githubClient.repository(target.owner, target.repo, targetToken(repo, target, override), target.id, signal); }
      catch (error) { if (signal.aborted) throw signal.reason; if (!(error instanceof TargetRepositoryError)) throw error; }
    }
  };
  useEffect(() => {
    if (currentView !== 'workbench' || !activeRepoId) return;
    const project = reposRef.current.find(item => item.id === activeRepoId);
    if (!project || !projectTargets(project).length) return;
    const controller = new AbortController();
    void checkRepoTargets(project, '', controller.signal).catch(() => { /* States are reported per target; navigation aborts silently. */ });
    return () => controller.abort();
  }, [currentView, activeRepoId]);
  const versionFiles = async (repo: TrackedRepo, version?: BackupVersion): Promise<CachedFile[]> => {
    const sha = version?.commitSha || repo.latestCommitSha;
    let files = await localCache.getProjectFiles(repo.id, sha);
    if (!files.length && !version) {
      // Migrate old unversioned caches only after matching every byte to the stored tree.
      const legacy = await localCache.getProjectFiles(repo.id);
      const entries = repo.tree.filter(f => f.type === 'blob');
      if (legacy.length && legacy.length === entries.length) {
        const byPath = new Map(legacy.map(f => [f.path, f]));
        let matches = true;
        for (const entry of entries) {
          const file = byPath.get(entry.path);
          if (!file) { matches = false; break; }
          const bytes = file.isBase64 ? Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0)) : new TextEncoder().encode(file.content);
          if (await gitBlobSha(bytes) !== entry.sha) { matches = false; break; }
          file.sha = entry.sha; file.mode = entry.mode;
        }
        if (matches) { await localCache.saveProjectFiles(repo.id, legacy, sha); files = legacy; }
      }
    }
    if (files.length) return files;
    const remote = version?.remoteSnapshot || savedSnapshot(repo, sha);
    let data: Awaited<ReturnType<typeof githubClient.fetchRepo>>;
    if (remote) {
      try {
        const token = repo.uploadTarget?.token || globalToken || repo.token;
        await githubClient.repository(remote.owner, remote.repo, token, remote.repoId);
        data = await githubClient.fetchRepo(`${remote.owner}/${remote.repo}`, remote.branch, token, { ref: remote.commitSha });
      } catch (error) {
        if (operationSignal().aborted) throw operationSignal().reason;
        if (!(error instanceof GitHubError) || error.rateLimited || ![401, 403, 404, 409].includes(error.status)) throw error;
        const source = sourceOf(repo);
        try {
          data = await githubClient.fetchRepo(source.url, version?.branch || source.branch, repo.token || globalToken, { ref: sha === 'HEAD' ? undefined : sha });
          const expected = (version?.tree || repo.tree).filter(item => item.type !== 'tree');
          const actual = new Map(data.tree.filter(item => item.type !== 'tree').map(item => [item.path, item]));
          if (sha === 'HEAD' || actual.size !== expected.length || expected.some(item => { const next = actual.get(item.path); return !next || next.sha !== item.sha || next.mode !== item.mode || next.type !== item.type; })) throw new Error('原始来源与保存的版本清单不一致');
        } catch (fallbackError) { throw new Error(`旧远端版本无法访问，原始提交也未能完整恢复；本地快照仍保留。需要该版本缓存、导出文件或恢复旧仓库后重试：${(fallbackError as Error).message}`); }
      }
      const sourcePaths = new Map((version?.tree || repo.tree).filter(f => f.type === 'blob').map(f => [f.path, f]));
      // Only the source manifest belongs to this snapshot; generated metadata is excluded.
      data.files = data.files.filter(f => sourcePaths.has(f.path));
    } else {
      const source = sourceOf(repo);
      data = await githubClient.fetchRepo(source.url, source.branch, repo.token || globalToken, { ref: sha === 'HEAD' ? undefined : sha });
      if (sha === 'HEAD') throw new Error('旧记录缺少准确提交，请先执行更新再上传');
    }
    await localCache.saveProjectFiles(repo.id, data.files, sha);
    await transferCache.clear(data.latestCommitSha);
    return data.files;
  };
  const recordUpload = async (repo: TrackedRepo, result: any, purge: boolean, version?: BackupVersion, extra: Partial<TrackedRepo> = {}, uploadToken?: string, bindTarget = true) => {
    const sourceSha = version?.commitSha || repo.latestCommitSha;
    if (!result.verified) throw new Error('远程版本尚未验证，本地缓存已保留');
    const snapshot: RemoteSnapshot = { repoId: result.repoId, owner: result.owner, repo: result.repo, branch: result.branch, commitSha: result.commitSha, sourceSha, htmlUrl: result.htmlUrl };
    await localCache.saveSyncReceipt(repo.id, sourceSha, snapshot);
    const current = reposRef.current.find(r => r.id === repo.id) || repo;
    const sourceBranch = version?.branch || sourceOf(repo).branch;
    const binding: UploadTarget = { ...current.uploadTarget, id: result.repoId || current.uploadTarget?.id, owner: result.owner, repo: result.repo, branch: result.branch, purgeAfterUpload: purge, token: uploadToken || current.uploadTarget?.token };
    const targetHealth = { ...current.targetHealth, [targetKey(binding)]: { id: binding.id, owner: binding.owner, repo: binding.repo, status: 'available' as const, checkedAt: new Date().toISOString(), message: '远端上传已验证成功' } };
    const branchTargets = bindTarget ? { ...current.branchTargets, [sourceBranch]: binding } : current.branchTargets;
    if (version) patchRepo(repo.id, { targetHealth, branchTargets, backups: current.backups.map(b => b.id === version.id ? { ...b, remoteSnapshot: snapshot } : b) });
    else if (!bindTarget) patchRepo(repo.id, { savedCopies: [snapshot, ...(current.savedCopies || [])] });
    else {
      const previous = current.remoteSnapshot;
      const priorVersion = previous && previous.sourceSha !== current.latestCommitSha ? current.backups.find(item => item.commitSha === previous.sourceSha) : undefined;
      const archived = previous ? archiveVersion(priorVersion ? { ...current, ...priorVersion, latestCommitSha: priorVersion.commitSha, remoteSnapshot: previous } : current) : undefined;
      const backups = previous && previous.commitSha !== snapshot.commitSha && archived ? [archived, ...current.backups] : current.backups;
      patchRepo(repo.id, { ...extra, targetHealth, backups, remoteSnapshot: snapshot, branchTargets, uploadTarget: binding, branchUploadPending: false, lastUploadedToPrivateAt: new Date().toISOString() });
    }
    if (purge) {
      try {
        await localCache.deleteProjectFiles(repo.id, sourceSha);
        if (version) patchRepo(repo.id, { backups: (reposRef.current.find(r => r.id === repo.id)?.backups || []).map(b => b.id === version.id ? { ...b, isCachePurged: true } : b) });
        else patchRepo(repo.id, { isCachePurged: true, cachedFilesCount: 0 });
      } catch (error) { throw new Error(`上传已验证成功，缓存清理未完成，可稍后重试：${(error as Error).message}`); }
    } else if (!version && sourceSha === current.latestCommitSha) patchRepo(repo.id, { isCachePurged: false, cachedFilesCount: (await localCache.getProjectFiles(repo.id, sourceSha)).length });
  };

  const boundTarget = async (repo: TrackedRepo, token: string, branch = sourceOf(repo).branch) => {
    const stored = targetForBranch(repo, branch);
    if (stored) {
      assertBranchTarget(repo, branch, stored);
      const identity = await githubClient.repository(stored.owner, stored.repo, token, stored.id);
      return { ...stored, id: identity.id || stored.id, owner: identity.owner, repo: identity.repo, htmlUrl: identity.htmlUrl, defaultBranch: stored.branch };
    }
    if (repo.privateRepoUrl) {
      const parsed = parseRepository(repo.privateRepoUrl);
      const identity = await githubClient.repository(parsed.owner, parsed.repo, token);
      return { ...identity, branch: identity.defaultBranch, purgeAfterUpload: false };
    }
    return undefined;
  };
  const openTargetManager = (repo: TrackedRepo) => {
    setIsSingleUploadModalOpen(false); setIsPushModalOpen(false);
    setTargetManagerId(repo.id); setTargetManagerToken(''); setTargetManagerMessage(''); setDetachedTargetName('');
  };
  const handleCheckTarget = async (repoId: string, target?: TargetIdentity) => {
    const repo = reposRef.current.find(project => project.id === repoId);
    if (!repo || targetManagerBusy) return;
    beginGithubOperation(); setTargetManagerBusy(true); setTargetManagerMessage('');
    const signal = operationSignal(), override = targetManagerToken.trim();
    try {
      for (const item of target ? [target] : projectTargets(repo)) {
        try {
          await githubClient.repository(item.owner, item.repo, targetToken(repo, item, override), item.id, signal);
          signal.throwIfAborted();
          if (override) persistRepos(reposRef.current.map(project => ({ ...project,
            uploadTarget: project.uploadTarget && sameTarget(project.uploadTarget, item) ? { ...project.uploadTarget, token: override } : project.uploadTarget,
            forkTarget: project.forkTarget && sameTarget(project.forkTarget, item) ? { ...project.forkTarget, token: override } : project.forkTarget,
            branchTargets: project.branchTargets ? Object.fromEntries(Object.entries(project.branchTargets).map(([branch, binding]) => [branch, sameTarget(binding, item) ? { ...binding, token: override } : binding])) : undefined,
          })));
        } catch (error) { if (signal.aborted || !(error instanceof TargetRepositoryError)) throw error; }
      }
      setTargetManagerMessage(override ? '检测完成；仅对身份验证成功的目标保存了新 Token。' : '检测完成；异常目标的原绑定仍保留，可按状态处理。');
    } catch (error) { setTargetManagerMessage(signal.aborted ? '检测已取消，原绑定保持不变。' : (error as Error).message); }
    finally { setTargetManagerBusy(false); }
  };
  const handleDetachTarget = (repoId: string, target: TargetIdentity) => {
    if (targetManagerBusy) return;
    const affected = reposRef.current.filter(project => projectTargets(project).some(item => sameTarget(item, target)));
    if (!affected.length || !confirm(`解除 ${target.owner}/${target.repo} 在 ${affected.length} 个项目记录中的所有当前分支／分叉绑定？\n本地文件、原始来源、历史快照和其他目标绑定全部保留，不删除任何 GitHub 仓库。\n之后需要重新选择上传目标或创建分叉。若只是 Token 无权限，建议先更新 Token 并重新检测。`)) return;
    try {
      persistRepos(reposRef.current.map(project => detachedTarget(project, target)));
      setDetachedTargetName(target.repo);
      setTargetManagerMessage(`已解除 ${affected.length} 个记录的旧目标绑定。可以重新设置上传或创建分叉；本地文件和历史快照已保留。GitHub 上已删除的历史无法在新仓库中自动重建。`);
      setTargetManagerId(repoId);
    } catch (error) { setTargetManagerMessage('解除绑定未保存：' + (error as Error).message); }
  };
  const reopenTargetSetup = (repoId: string, fork: boolean) => {
    const repo = reposRef.current.find(project => project.id === repoId);
    if (!repo) return;
    handleOpenSingleUploadModal(repo);
    if (fork) { setProjectSyncTab('fork'); setForkScope('full'); setForkRepoName(detachedTargetName || sourceOf(repo).repo); }
    else if (!repo.uploadTarget && !repo.privateRepoUrl) setSingleUploadRepoName(detachedTargetName || sourceOf(repo).repo);
    setTargetManagerId(null);
  };
  const targetWarning = (repo: TrackedRepo) => {
    const unavailable = projectTargets(repo).map(target => targetHealthOf(repo, target)).filter(health => health && health.status !== 'available');
    return unavailable.length ? <div className="bg-[#C7A39B]/15 border border-[#C7A39B]/30 rounded-xl p-3 text-xs text-[#8C5D54] flex flex-col gap-2">
      <p role="alert">{unavailable[0]!.message}</p>
      <button type="button" onClick={() => openTargetManager(repo)} className="self-start px-3 py-2 border border-[#DFD8CE] bg-[#FAF8F5] rounded-xl">处理远端目标异常{unavailable.length > 1 ? `（${unavailable.length}）` : ''}</button>
    </div> : null;
  };
  const hasTargetIssue = (repo: TrackedRepo) => projectTargets(repo).some(target => { const health = targetHealthOf(repo, target); return health && health.status !== 'available'; });
  const assertDestinationBranch = (repo: TrackedRepo, destination: { id?: number; owner: string; repo: string; branch: string }, branch = sourceOf(repo).branch) => {
    for (const item of reposRef.current) {
      const bindings = { ...item.branchTargets, ...(item.uploadTarget && !item.branchUploadPending ? { [sourceOf(item).branch]: item.uploadTarget } : {}) };
      for (const [sourceBranch, target] of Object.entries(bindings)) {
        const sameRepo = destination.id && target.id ? destination.id === target.id : destination.owner.toLowerCase() === target.owner.toLowerCase() && destination.repo.toLowerCase() === target.repo.toLowerCase();
        if (sameRepo && destination.branch === target.branch && (sourceBranch !== branch || !sameRepository(sourceOf(item), sourceOf(repo)))) throw new Error(`目标分支 ${target.branch} 已绑定来源 ${sourceOf(item).owner}/${sourceOf(item).repo} 的来源分支 ${sourceBranch}，不能用 ${branch} 覆盖。请使用对应分支或另存副本到其他仓库。`);
      }
    }
  };
  const pushSnapshot = async (repo: TrackedRepo, files: CachedFile[], token: string, message: string, branch = sourceOf(repo).branch) => {
    const target = await boundTarget(repo, token, branch);
    if (!target) throw new Error('请先通过上传入口指定并绑定目标仓库');
    assertDestinationBranch(repo, target, branch);
    return githubClient.push(target.owner, target.repo, target.branch, token, files, message, repo.forkScope === 'full' ? undefined : repo.description, repo.forkScope === 'full' ? undefined : repo.remark, repo.forkScope === 'full' ? undefined : sourceOf(repo).url, { rebaseOnConflict: true, expectedRepoId: target.id });
  };
  const handleRenameTarget = async (repo: TrackedRepo) => {
    const token = repo.uploadTarget?.token || globalToken || repo.token || prompt('请输入 GitHub Token：')?.trim();
    if (!token) return;
    const name = prompt('修改已绑定的 GitHub 仓库名称（保留原仓库和全部历史）：', repo.uploadTarget?.repo || singleUploadRepoName)?.trim();
    if (!name) return;
    startOperation();
    try {
      const previous = await boundTarget(repo, token);
      if (!previous) throw new Error('尚未绑定上传目标');
      const next = await githubClient.renameRepository(previous, name, token);
      persistRepos(reposRef.current.map(item => renamedProject(item, previous, next)));
      const refreshed = reposRef.current.find(item => item.id === repo.id)!;
      setSingleUploadTargetRepo(refreshed); setSingleUploadRepoName(next.repo);
      alert('项目名称已修改，仓库身份和历史记录保持不变。');
    } catch (error) { alert('修改名称失败：' + (error as Error).message); }
    finally { setIsLoading(false); }
  };

  // Save to localStorage
  useEffect(() => {
    try { localStorage.setItem('gitvault_repos_v8', JSON.stringify(repos)); }
    catch (error) { setErrorMsg('项目记录保存失败，请导出备份并检查浏览器存储空间'); }
  }, [repos]);

  // Validate GitHub Token on mount or when changed
  useEffect(() => {
    if (globalToken) {
      validateGitHubToken(globalToken);
    }
  }, [globalToken]);

  const validateGitHubToken = async (token: string) => {
    if (!token) return;
    if (operationSignal().aborted) beginGithubOperation();
    setIsValidatingToken(true);
    try { const data = await githubClient.validateToken(token); setUserProfile(data.user); setRateLimit(data.rateLimit); }
    catch { setUserProfile(null); } finally { setIsValidatingToken(false); }
  };

  // Dedicated Test GitHub Connection handler
  const handleTestGitHubConnection = async (tokenToTest?: string) => {
    const token = (tokenToTest !== undefined ? tokenToTest : globalToken).trim();
    if (!token) {
      setTestStatus('error');
      setTestMsg('请先输入 GitHub Personal Access Token (PAT) 再进行测试');
      return;
    }

    if (operationSignal().aborted) beginGithubOperation();
    setTestStatus('testing');
    setTestMsg('正在连接 GitHub API 节点并校验用户权限...');

    try {
      const data = await githubClient.validateToken(token);

      if (data && data.valid) {
        setUserProfile(data.user);
        const rateInfo = data.rateLimit;
        setRateLimit(rateInfo);
        setTestStatus('success');
        setTestMsg(`GitHub 连接成功！已验证账号: @${data.user.login} (${data.user.name}) · 剩余 API 配额: ${rateInfo ? `${rateInfo.remaining}/${rateInfo.limit}` : '正常'}`);
      } else {
        setTestStatus('error');
        setTestMsg('Token 验证失败，请确认是否具有 repo 权限');
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

    if (operationSignal().aborted) beginGithubOperation();
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
          globalToken: '',
          globalUsername: globalUsername,
          apkDownloadDirectory: apkDownloadDirectory,
        },
        projectsCount: repos.length,
        projects: repos.map(publicProjectRecord)
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

        // Imported metadata does not imply that source files exist on this device.
        const importedIds = new Set(data.projects.map((project: TrackedRepo) => project.id));
        setRepos(prev => prev.map(repo => importedIds.has(repo.id) ? { ...repo, isCachePurged: true, cachedFilesCount: 0 } : repo));

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
      const { default: JSZip } = await import('jszip');
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
      ${repos.map(r => `<li><strong>${escapeHtml(r.owner)}/${escapeHtml(r.repo)}</strong> - ${escapeHtml(r.remark || '无备注')} (${escapeHtml(r.description || '无描述')})</li>`).join('')}
    </ul>
  </div>
</body>
</html>`;
      zip.file("index.html", htmlContent);
      
      const backupData = {
        version: 1,
        exportDate: new Date().toISOString(),
        repos: repos.map(publicProjectRecord),
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
      const { default: JSZip } = await import('jszip');
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
      const { default: JSZip } = await import('jszip');
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
          remark: projectRemark.trim(),
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
  const targetManagerRepo = repos.find(r => r.id === targetManagerId);

  const handleWorkbenchBranches = async () => {
    if (!activeRepo) return;
    workbenchLookup.current?.abort();
    const controller = new AbortController(); workbenchLookup.current = controller;
    setWorkbenchBranchLoading(true); setWorkbenchBranchError('');
    const source = sourceOf(activeRepo);
    try {
      const branches = await githubClient.fetchBranches(`${source.owner}/${source.repo}`, activeRepo.token || globalToken, controller.signal);
      if (controller.signal.aborted) return;
      setWorkbenchBranches(branches); setWorkbenchBranchInput(source.branch);
    } catch (error) { if (!controller.signal.aborted) setWorkbenchBranchError((error as Error).message); }
    finally { if (!controller.signal.aborted) setWorkbenchBranchLoading(false); }
  };
  const handleSwitchBranch = async () => {
    if (!activeRepo || !workbenchBranchInput.trim()) return;
    const repo = activeRepo; const source = sourceOf(repo); const branch = workbenchBranchInput.trim();
    if (branch === source.branch) return;
    workbenchLookup.current?.abort(); setWorkbenchBranchLoading(false);
    startOperation(); setWorkbenchBranchError(''); fileRequest.current++;
    try {
      const auth = repo.uploadTarget?.token || globalToken || repo.token || '';
      const previousTarget = repo.uploadTarget || (repo.privateRepoUrl ? await boundTarget(repo, auth) : undefined);
      const branchTargets = { ...repo.branchTargets, ...(previousTarget && !repo.branchUploadPending ? { [source.branch]: previousTarget } : {}) };
      const nextTarget = targetForBranch({ ...repo, uploadTarget: previousTarget, branchTargets }, branch);
      const cached = await localCache.getProjectFiles(repo.id, repo.latestCommitSha);
      const data = await githubClient.fetchRepo(`${source.owner}/${source.repo}`, branch, repo.token || globalToken, { cachedFiles: cached });
      operationSignal().throwIfAborted();
      await localCache.saveProjectFiles(repo.id, data.files, data.latestCommitSha);
      operationSignal().throwIfAborted();
      const current = reposRef.current.find(item => item.id === repo.id);
      if (!current || sourceOf(current).branch !== source.branch) throw new Error('项目已改变，请重新选择分支');
      const old = archiveVersion(repo);
      patchRepo(repo.id, { branch: data.branch, url: repo.origin ? repo.url : `https://github.com/${source.owner}/${source.repo}`, origin: repo.origin ? { ...repo.origin, branch: data.branch } : undefined,
        latestCommitSha: data.latestCommitSha, commitMessage: data.commitMessage, commitAuthor: data.commitAuthor, commitDate: data.commitDate, tree: data.tree,
        repoMeta: { ...data.repoMeta, htmlUrl: repo.origin ? repo.repoMeta.htmlUrl : data.repoMeta.htmlUrl },
        backups: [old, ...current.backups.map(item => ({ ...item, branch: item.branch || source.branch }))], branchTargets, uploadTarget: nextTarget, branchUploadPending: !!nextTarget && !Object.hasOwn(branchTargets, data.branch), remoteSnapshot: undefined,
        forkTarget: repo.forkTarget ? { ...repo.forkTarget, branch: data.branch } : undefined,
        hasUpdate: false, latestRemoteCommit: undefined, isCachePurged: false, cachedFilesCount: data.files.length, lastSyncedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() });
      setViewingBackup(null); setSelectedFilePath(null); setFileContent(null); setSelectedBackupIds([]); setFileSearchQuery(''); setVisibleFileCount(150); setMobileFileView('list'); setWorkbenchTab('files');
      await transferCache.clear(data.latestCommitSha);
      alert(`已重新拉取并切换到 ${data.branch}，共 ${data.files.length} 个文件。${nextTarget ? `上传目标：${nextTarget.owner}/${nextTarget.repo}:${nextTarget.branch}。` : ''}其他分支的文件和历史记录已保留。`);
    } catch (error) { setWorkbenchBranchError('切换未完成：' + (error as Error).message); }
    finally { setIsLoading(false); }
  };

  // Status check logic
  const checkSingleRepoStatus = async (repoId: string, isBackground = false) => {
    const repo = reposRef.current.find(r => r.id === repoId);
    if (!repo || checkingRepos.current.has(repoId)) return;
    if (operationSignal().aborted && isBackground) return;
    checkingRepos.current.add(repoId);
    if (!isBackground) { startOperation(); setLoadingText(`正在检测 ${repo.repo} 的更新…`); }
    try {
      await checkRepoTargets(repo);
      const source = sourceOf(repo);
      const data = await githubClient.checkUpdate(source.owner, source.repo, source.branch, repo.latestCommitSha, repo.token || globalToken);
      const current = reposRef.current.find(item => item.id === repoId);
      if (!current || sourceOf(current).branch !== source.branch) return;
      patchRepo(repo.id, { hasUpdate: data.hasUpdate, latestRemoteCommit: data.latestCommit, lastCheckedAt: new Date().toISOString() });
    } catch (error) {
      patchRepo(repo.id, { lastCheckedAt: new Date().toISOString() });
      if (!isBackground) alert('检测失败：' + (error as Error).message);
    } finally { checkingRepos.current.delete(repoId); if (!isBackground) setIsLoading(false); }
  };

  const checkAllUpdates = async () => {
    startOperation();
    setLoadingText('正在批量检测所有已链接项目状态...');
    for (const r of repos) {
      await checkSingleRepoStatus(r.id, true);
    }
    setIsLoading(false);
  };

  // Import matching is read-only. A destination is bound only after an explicit choice.
  const chooseImportBase = async (data: { owner: string; repo: string; branch: string; latestCommitSha: string; tree: RepoTreeItem[] }, token: string): Promise<ImportChoice> => {
    const source = { owner: data.owner, repo: data.repo, branch: data.branch, url: `https://github.com/${data.owner}/${data.repo}` };
    const candidates = importCandidates(reposRef.current, source);
    if (!candidates.length) return 'independent';
    const signal = operationSignal(); signal.throwIfAborted();
    importSession.current++;
    setImportMatch({ source, sha: data.latestCommitSha, tree: data.tree, candidates, token, comparisons: {} });
    setIsLoading(false);
    try {
      return await new Promise<ImportChoice>((resolve, reject) => {
        const finish = (choice: ImportChoice) => { signal.removeEventListener('abort', abort); importResolver.current = null; resolve(choice); };
        const abort = () => { importResolver.current = null; reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        importResolver.current = finish;
      });
    } finally { importSession.current++; setImportMatch(null); setIsLoading(true); }
  };

  const compareImportBase = async (candidate: ImportCandidate) => {
    if (!importMatch) return;
    const session = importSession.current, match = importMatch;
    const update = (comparison: ImportComparison) => {
      if (session === importSession.current) setImportMatch(current => current ? { ...current, comparisons: { ...current.comparisons, [candidate.key]: comparison } } : current);
    };
    update({ status: 'loading' });
    try {
      const token = candidate.target.token || match.token;
      const sourceManifest = sameRepository(candidate.source, match.source) && candidate.source.branch === match.source.branch ? { latestCommitSha: match.sha, tree: match.tree } : await githubClient.inspectRepo(candidate.source.url, candidate.source.branch, match.token || token);
      const inspected = await githubClient.inspectImportTarget(candidate.target, token, candidate.fullFork ? candidate.source : undefined);
      operationSignal().throwIfAborted();
      const target = { ...candidate.target, id: inspected.identity.id, owner: inspected.identity.owner, repo: inspected.identity.repo, token: token || undefined };
      const draft = { ...candidate.source, id: 'import-comparison', backups: [], tree: sourceManifest.tree } as unknown as TrackedRepo;
      assertDestinationBranch(draft, target);
      update({ status: 'ready', target, sourceSha: sourceManifest.latestCommitSha, commitSha: inspected.commitSha, missingBranch: inspected.missingBranch, diff: compareImportTrees(sourceManifest.tree, inspected.tree, !candidate.fullFork) });
    } catch (error) { update({ status: 'error', error: (error as Error).message || '对比已取消' }); }
  };

  const prepareImport = async (url: string, branch: string | undefined, token: string) => {
    const parsed = parseRepository(url);
    const source = { owner: parsed.owner, repo: parsed.repo, url: `https://github.com/${parsed.owner}/${parsed.repo}`, branch: branch || parsed.linkedRef || 'main' };
    if (!importCandidates(reposRef.current, source).length) return { choice: 'independent' as const, data: await githubClient.fetchRepo(url, branch, token) };
    // Compare manifests before downloading file bytes; skipping an existing project
    // must not require downloading it again.
    const manifest = await githubClient.inspectRepo(url, branch, token);
    const choice = await chooseImportBase(manifest, token);
    operationSignal().throwIfAborted();
    if (choice === 'skip') return { choice, data: undefined };
    const selected = typeof choice === 'string' ? { ...source, branch: manifest.branch } : choice.candidate.source;
    const sha = typeof choice === 'string' ? manifest.latestCommitSha : choice.comparison.sourceSha;
    if (!sha) throw new Error('来源提交未完成校验，请重新对比');
    const previous = reposRef.current.find(project => sameRepository(sourceOf(project), selected) && sourceOf(project).branch === selected.branch);
    const cachedFiles = previous ? await localCache.getProjectFiles(previous.id, sha) : [];
    const data = await githubClient.fetchRepo(selected.url, selected.branch, token || (typeof choice === 'string' ? undefined : choice.comparison.target?.token), { ref: sha, cachedFiles });
    return { choice, data };
  };

  const importWithBase = (newRepo: TrackedRepo, choice: ImportChoice, batch = false): TrackedRepo => {
    if (typeof choice === 'string') return newRepo;
    const { candidate, comparison } = choice;
    if (comparison.status !== 'ready' || !comparison.target) throw new Error('请完成项目对比后再选择同步基础');
    const previous = reposRef.current.find(project => !project.origin && sameRepository(project, newRepo) && project.branch === newRepo.branch);
    const target = comparison.target;
    const next = { ...previous, ...newRepo, id: previous?.id || newRepo.id,
      token: newRepo.token || previous?.token, checkInterval: previous?.checkInterval || newRepo.checkInterval,
      tags: batch && previous ? previous.tags : newRepo.tags, latestRemoteCommit: undefined, lastUploadedToPrivateAt: undefined,
      backups: previous ? (previous.latestCommitSha !== newRepo.latestCommitSha ? [archiveVersion(previous), ...previous.backups] : previous.backups) : [],
      uploadTarget: target, branchTargets: { ...previous?.branchTargets, [newRepo.branch]: target }, branchUploadPending: comparison.missingBranch || false,
      // No upload receipt is invented by a comparison, even if the files are identical.
      remoteSnapshot: undefined,
      savedCopies: [...(previous?.savedCopies || []), ...(previous?.remoteSnapshot ? [previous.remoteSnapshot] : [])],
      privateRepoUrl: `https://github.com/${target.owner}/${target.repo}`,
      forkScope: candidate.fullFork ? 'full' as const : target.kind === 'current' ? 'current' as const : undefined,
      forkTarget: candidate.fullFork ? { id: target.id, owner: target.owner, repo: target.repo, branch: target.branch, htmlUrl: `https://github.com/${target.owner}/${target.repo}`, branches: candidate.branches?.length ? candidate.branches : [newRepo.branch] } : undefined,
    };
    assertDestinationBranch(next, target);
    return next;
  };

  // Add new repository link: Directly pull project into local memory/storage
  const handleBatchImport = async (retry = false) => {
    if (importLock.current) return;
    const items = retry ? importResults.map(item => item.status === 'error' && item.url ? { ...item, status: 'pending' as const, message: undefined } : item) : parseImportLinks(batchLinks);
    if (!items.length) { setImportResults([]); setErrorMsg('请先填写至少一个仓库链接'); return; }
    importLock.current = true; startOperation(); setErrorMsg(''); setImportResults([...items]);
    const token = tokenInput.trim() || globalToken;
    for (let i = 0; i < items.length; i++) {
      if (items[i].status !== 'pending') continue;
      if (operationSignal().aborted) break;
      items[i] = { ...items[i], status: 'downloading', message: '正在拉取默认分支…' }; setImportResults([...items]);
      try {
        const parsed = parseRepository(items[i].url!);
        const existing = reposRef.current.filter(item => !item.origin && item.owner.toLowerCase() === parsed.owner.toLowerCase() && item.repo.toLowerCase() === parsed.repo.toLowerCase());
        if (existing.length) {
          const meta = await githubClient.repository(parsed.owner, parsed.repo, token);
          if (existing.some(item => item.branch === meta.defaultBranch) && !importCandidates(reposRef.current, { ...parsed, url: items[i].url!, branch: meta.defaultBranch }).length) {
            items[i] = { ...items[i], status: 'skipped', message: `默认分支 ${meta.defaultBranch} 已在项目列表中` }; setImportResults([...items]); continue;
          }
        }
        const { choice, data } = await prepareImport(`https://github.com/${parsed.owner}/${parsed.repo}`, undefined, token);
        operationSignal().throwIfAborted();
        if (!data) { items[i] = { ...items[i], status: 'skipped', message: '用户选择跳过此链接' }; setImportResults([...items]); continue; }
        const exists = reposRef.current.some(item => { const source = sourceOf(item); return source.owner.toLowerCase() === data.owner.toLowerCase() && source.repo.toLowerCase() === data.repo.toLowerCase() && source.branch === data.branch && !item.origin; });
        if (exists && choice === 'independent' && !importCandidates(reposRef.current, { ...data, url: items[i].url! }).length) { items[i] = { ...items[i], status: 'skipped', message: `默认分支 ${data.branch} 已在项目列表中` }; }
        else {
          const newRepo = importWithBase({ ...data, id: `repo-${crypto.randomUUID()}`, url: typeof choice === 'string' ? items[i].url! : choice.candidate.source.url, token: tokenInput.trim() || undefined, remark: items[i].remark || '', description: data.repoMeta.description || '', tags: ['默认'], checkInterval: 0, lastCheckedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString(), backups: [], hasUpdate: false, isCachePurged: false, cachedFilesCount: data.files.length }, choice, true);
          // Keep file contents in IndexedDB only; never copy them into the project record.
          const { files, ...record } = newRepo as TrackedRepo & { files?: CachedFile[] };
          await localCache.saveProjectFiles(record.id, data.files, data.latestCommitSha);
          operationSignal().throwIfAborted(); persistRepos([record, ...reposRef.current.filter(item => item.id !== record.id)]);
          if (isApkEnvironment && (window as any).AndroidBridge?.saveProjectFolder) {
            try { (window as any).AndroidBridge.saveProjectFolder(`${apkDownloadDirectory}/${record.repo}`, JSON.stringify({ repo: record.repo, sha: record.latestCommitSha, files: data.files })); }
            catch { /* Durable browser cache is already saved; native export can be retried separately. */ }
          }
          items[i] = { ...items[i], status: 'success', message: `${data.branch} · ${data.files.length} 个文件${typeof choice !== 'string' ? `，已沿用 ${choice.comparison.target!.owner}/${choice.comparison.target!.repo} · ${choice.comparison.target!.branch}（尚未写入远端）` : '，备注和描述可在项目设置中修改'}` };
        }
        await transferCache.clear(data.latestCommitSha);
      } catch (error) { items[i] = { ...items[i], status: 'error', message: (error as Error).message || '操作已取消' }; }
      setImportResults([...items]);
    }
    for (let i = 0; i < items.length; i++) if (items[i].status === 'pending' || items[i].status === 'downloading') items[i] = { ...items[i], status: 'error', message: '操作已取消，尚未导入，可重试' };
    setImportResults([...items]); setIsLoading(false); setCurrentView('projects'); importLock.current = false;
  };

  const handleAddRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim() || importLock.current) return;
    importLock.current = true;
    startOperation(); setErrorMsg(''); setLoadingText('正在获取完整项目…');
    try {
      const { choice, data } = await prepareImport(repoUrl.trim(), branchInput.trim() || undefined, tokenInput.trim() || globalToken);
      operationSignal().throwIfAborted();
      if (!data) return;
      const newRepo = importWithBase({
        id: `${data.owner}-${data.repo}-${Date.now()}`, url: typeof choice === 'string' ? repoUrl.trim() : choice.candidate.source.url, owner: data.owner, repo: data.repo, branch: data.branch,
        token: tokenInput.trim() || undefined, remark: remarkInput.trim() || '未备注项目', description: descriptionInput.trim() || data.repoMeta.description,
        tags: tagsInput.split(',').map(t => t.trim()).filter(Boolean), checkInterval: 0, lastCheckedAt: new Date().toISOString(),
        latestCommitSha: data.latestCommitSha, commitMessage: data.commitMessage, commitAuthor: data.commitAuthor, commitDate: data.commitDate,
        lastSyncedAt: new Date().toISOString(), repoMeta: data.repoMeta, tree: data.tree, backups: [], hasUpdate: false, isCachePurged: false, cachedFilesCount: data.files.length,
      }, choice);
      await localCache.saveProjectFiles(newRepo.id, data.files, data.latestCommitSha);
      operationSignal().throwIfAborted(); persistRepos([newRepo, ...reposRef.current.filter(item => item.id !== newRepo.id)]);
      if (isApkEnvironment && (window as any).AndroidBridge?.saveProjectFolder) {
        (window as any).AndroidBridge.saveProjectFolder(`${apkDownloadDirectory}/${newRepo.repo}`, JSON.stringify({ repo: newRepo.repo, sha: newRepo.latestCommitSha, files: data.files }));
      }
      setIsAddModalOpen(false); setRepoUrl(''); setBranchInput(''); setAvailableBranches([]); setTokenInput(''); setRemarkInput(''); setDescriptionInput(''); setCurrentView('projects');
      await transferCache.clear(data.latestCommitSha);
      alert(`项目完整下载并持久保存成功，共 ${data.files.length} 个文件。${typeof choice !== 'string' ? '已按选择绑定已有目标，后续上传或分叉同步时使用；本次未写入远端。' : ''}`);
    } catch (error) { setErrorMsg((error as Error).message || '操作已取消'); }
    finally { setIsLoading(false); importLock.current = false; }
  };

  // Open modal for uploading single project to user's private repo
  const handleOpenSingleUploadModal = (repo: TrackedRepo) => {
    setSingleUploadTargetRepo(repo);
    setSingleUploadRepoName(repo.uploadTarget?.repo || (repo.privateRepoUrl ? parseRepository(repo.privateRepoUrl).repo : repo.repo));
    setProjectSyncTab('privateRepo'); setForkScope('current');
    setForkRepoName(`${sourceOf(repo).repo}-${sourceOf(repo).branch.replace(/[^a-zA-Z0-9._-]/g, '-')}`);
    setSingleUploadRemark(repo.remark);
    setSingleUploadDescription(repo.description || repo.repoMeta?.description || '');
    setSingleUploadPurgeCache(repo.uploadTarget?.purgeAfterUpload || false);
    setIsSingleUploadModalOpen(true);
  };

  // Execute upload single project to private repository
  const handleExecuteSingleUploadToPrivate = async (e: React.FormEvent) => {
    e.preventDefault(); if (!singleUploadTargetRepo) return;
    const token = singleUploadTargetRepo.uploadTarget?.token || globalToken || singleUploadTargetRepo.token || prompt('请输入 GitHub Token：')?.trim();
    if (!token) return;
    startOperation(); setIsUploadingToPrivate(true);
    try {
      const existing = await boundTarget(singleUploadTargetRepo, token);
      const target = existing || await githubClient.ensurePrivateRepo(token, singleUploadRepoName.trim(), singleUploadDescription.trim(), singleUploadRemark.trim());
      const branch = existing?.branch || sourceOf(singleUploadTargetRepo).branch;
      assertDestinationBranch(singleUploadTargetRepo, { ...target, branch });
      const files = await versionFiles(singleUploadTargetRepo);
      const result = await githubClient.push(target.owner, target.repo, branch, token, files, `Sync ${singleUploadTargetRepo.repo} @ ${singleUploadTargetRepo.latestCommitSha}`, singleUploadDescription.trim(), singleUploadRemark.trim(), sourceOf(singleUploadTargetRepo).url, { rebaseOnConflict: true, expectedRepoId: target.id });
      await recordUpload(singleUploadTargetRepo, result, singleUploadPurgeCache, undefined, { privateRepoUrl: target.htmlUrl, remark: singleUploadRemark.trim(), description: singleUploadDescription.trim() }, token);
      setIsSingleUploadModalOpen(false);
      alert(`已验证完整上传 ${files.length} 个文件。${singleUploadPurgeCache ? '本地源码已清理，版本快照已保留。' : '本地源码已保留。'}`);
    } catch (error) { alert('上传未完成：' + (error as Error).message); }
    finally { setIsUploadingToPrivate(false); setIsLoading(false); }
  };

  const createProjectCopy = async (sourceProject: TrackedRepo, scope: 'current' | 'full', name: string, token: string, purge: boolean) => {
    const origin = sourceOf(sourceProject);
      let target: { id?: number; owner: string; repo: string; htmlUrl: string; defaultBranch: string; branches?: string[] };
      let manifest: Awaited<ReturnType<typeof githubClient.inspectRepo>>;
      let remoteSha: string;
      let copiedFiles: CachedFile[] | undefined;
      if (scope === 'full') {
        target = await githubClient.createFork(origin.url, token, name.trim() || origin.repo);
        manifest = await githubClient.inspectRepo(target.htmlUrl, target.defaultBranch, token);
        remoteSha = manifest.latestCommitSha;
      } else {
        target = await githubClient.ensurePrivateRepo(token, name.trim(), sourceProject.description, sourceProject.remark);
        target.defaultBranch = origin.branch;
        assertDestinationBranch(sourceProject, { ...target, branch: origin.branch });
        copiedFiles = await versionFiles(sourceProject);
        const uploaded = await githubClient.push(target.owner, target.repo, target.defaultBranch, token, copiedFiles, `Save source branch ${origin.branch} @ ${sourceProject.latestCommitSha}`, sourceProject.description, sourceProject.remark, origin.url, { rebaseOnConflict: true, expectedRepoId: target.id });
        remoteSha = uploaded.commitSha;
        manifest = { owner: origin.owner, repo: origin.repo, branch: origin.branch, latestCommitSha: sourceProject.latestCommitSha, commitMessage: sourceProject.commitMessage, commitAuthor: sourceProject.commitAuthor, commitDate: sourceProject.commitDate, tree: sourceProject.tree, repoMeta: { description: sourceProject.repoMeta.description || '', stars: sourceProject.repoMeta.stars || 0, forks: sourceProject.repoMeta.forks || 0, language: sourceProject.repoMeta.language || 'Unknown', updatedAt: sourceProject.repoMeta.updatedAt, htmlUrl: sourceProject.repoMeta.htmlUrl } };
      }
      const originForCopy = { ...origin, branch: manifest.branch };
      const id = `managed-${target.id || `${target.owner}/${target.repo}`}-${manifest.branch}`;
      const previous = reposRef.current.find(item => item.id === id);
      const snapshot: RemoteSnapshot = { repoId: target.id, owner: target.owner, repo: target.repo, branch: target.defaultBranch, commitSha: remoteSha, sourceSha: manifest.latestCommitSha, htmlUrl: `${target.htmlUrl}/tree/${target.defaultBranch}` };
      const managed: TrackedRepo = { ...sourceProject, ...manifest, id, owner: target.owner, repo: target.repo, url: target.htmlUrl, origin: originForCopy, branch: manifest.branch, repoMeta: { ...manifest.repoMeta, htmlUrl: target.htmlUrl },
        backups: previous ? (previous.latestCommitSha !== manifest.latestCommitSha ? [archiveVersion(previous), ...previous.backups] : previous.backups) : [], savedCopies: previous?.savedCopies || [], branchTargets: undefined, branchUploadPending: false, privateRepoUrl: scope === 'current' ? target.htmlUrl : undefined,
        forkScope: scope, forkTarget: scope === 'full' ? { id: target.id, owner: target.owner, repo: target.repo, branch: target.defaultBranch, htmlUrl: target.htmlUrl, branches: target.branches } : undefined,
        uploadTarget: { id: target.id, owner: target.owner, repo: target.repo, branch: target.defaultBranch, purgeAfterUpload: purge, token, kind: scope }, remoteSnapshot: snapshot,
        isCachePurged: !copiedFiles || purge, cachedFilesCount: copiedFiles && !purge ? copiedFiles.length : 0, lastSyncedAt: new Date().toISOString(), hasUpdate: false };
      await localCache.saveSyncReceipt(id, manifest.latestCommitSha, snapshot);
      if (copiedFiles && !purge) await localCache.saveProjectFiles(id, copiedFiles, manifest.latestCommitSha);
      persistRepos([managed, ...reposRef.current.filter(item => item.id !== id)]);
      if (scope === 'full') patchRepo(sourceProject.id, { forkTarget: managed.forkTarget });
      if (copiedFiles && purge) await recordUpload(sourceProject, { verified: true, repoId: target.id, owner: target.owner, repo: target.repo, branch: target.defaultBranch, commitSha: remoteSha, htmlUrl: snapshot.htmlUrl }, true, undefined, {}, token, false);
    return scope === 'full' ? `完整分叉已验证并加入我的项目，共 ${target.branches?.length || 0} 个分支。` : `当前分支 ${origin.branch} 已保存为独立副本并加入我的项目，后续更新继续使用固定名称。`;
  };

  const handleExecuteCreateFork = async (e: React.FormEvent) => {
    e.preventDefault(); if (!singleUploadTargetRepo) return;
    const token = globalToken || singleUploadTargetRepo.token || prompt('请输入 GitHub Token：')?.trim();
    if (!token) return;
    startOperation(); setIsForking(true);
    try {
      const message = await createProjectCopy(singleUploadTargetRepo, forkScope, forkRepoName, token, singleUploadPurgeCache);
      setIsSingleUploadModalOpen(false); setCurrentView('projects'); alert(message);
    } catch (error) { alert('创建副本未完成：' + (error as Error).message); }
    finally { setIsForking(false); setIsLoading(false); }
  };

  const syncFullProject = async (repo: TrackedRepo, token: string, synced?: Awaited<ReturnType<typeof githubClient.syncAllForkBranches>>) => {
    const target = repo.forkTarget;
    if (!target || !repo.uploadTarget) throw new Error('完整分叉尚未绑定目标仓库');
    await boundTarget(repo, token);
    const results = synced || await githubClient.syncAllForkBranches(target.owner, target.repo, token);
    const source = sourceOf(repo);
    const current = results.find(result => result.branch === source.branch && result.success);
    if (current?.sourceSha && current.commitSha) {
      const manifest = await githubClient.inspectRepo(source.url, source.branch, repo.token || token, current.sourceSha);
      const old = archiveVersion(repo);
      const changed = repo.latestCommitSha !== manifest.latestCommitSha || repo.remoteSnapshot?.commitSha !== current.commitSha;
      let count = 0;
      if (!repo.uploadTarget.purgeAfterUpload) {
        const cached = await localCache.getProjectFiles(repo.id, repo.latestCommitSha);
        const data = await githubClient.fetchRepo(source.url, source.branch, repo.token || token, { ref: current.sourceSha, cachedFiles: cached });
        await localCache.saveProjectFiles(repo.id, data.files, current.sourceSha); count = data.files.length;
      }
      const updated = { ...repo, ...manifest, owner: repo.owner, repo: repo.repo, url: repo.url, repoMeta: { ...manifest.repoMeta, htmlUrl: repo.repoMeta.htmlUrl }, remoteSnapshot: undefined, backups: changed ? [old, ...repo.backups] : repo.backups, isCachePurged: repo.uploadTarget.purgeAfterUpload, cachedFilesCount: count, lastSyncedAt: new Date().toISOString(), hasUpdate: false };
      patchRepo(repo.id, updated);
      await recordUpload(updated, { verified: true, repoId: repo.uploadTarget.id, owner: target.owner, repo: target.repo, branch: source.branch, commitSha: current.commitSha, htmlUrl: `${target.htmlUrl}/tree/${source.branch}` }, repo.uploadTarget.purgeAfterUpload);
    }
    const failed = results.filter(result => !result.success);
    const message = `全部分支同步：${results.length - failed.length}/${results.length} 成功。${failed.map(result => `\n${result.branch}：${result.error}`).join('')}`;
    if (failed.length) throw new Error(message);
    return message;
  };

  const syncProjectUpstream = async (repo: TrackedRepo, token: string, syncedTargets?: Map<string, Awaited<ReturnType<typeof githubClient.syncAllForkBranches>>>): Promise<string> => {
    if (repo.forkScope === 'current') return updateProject(repo, token);
    if (repo.detachedTargets?.length && !repo.forkTarget && !repo.forkScope) throw new Error('旧分叉绑定已解除，请先在“分叉与私有仓”中重新创建或关联分叉。');
    const target = repo.forkTarget || { owner: repo.owner, repo: repo.repo, branch: repo.branch };
    await githubClient.repository(target.owner, target.repo, token, 'id' in target ? target.id : undefined);
    if (repo.forkScope === 'full' && repo.origin || repo.forkTarget?.branches?.length) {
      const key = `${target.owner}/${target.repo}`.toLowerCase();
      const results = syncedTargets?.get(key) || await githubClient.syncAllForkBranches(target.owner, target.repo, token);
      syncedTargets?.set(key, results);
      if (repo.forkScope === 'full' && repo.origin) return syncFullProject(repo, token, results);
      const failed = results.filter(item => !item.success);
      const message = `全部分支同步：${results.length - failed.length}/${results.length} 成功。${failed.map(item => `\n${item.branch}：${item.error}`).join('')}`;
      if (failed.length) throw new Error(message);
      return message;
    }
    const result = await githubClient.syncFork(target.owner, target.repo, target.branch, token);
    return `分叉 ${target.owner}/${target.repo}：${result.message}`;
  };
  const handleSyncUpstream = async (repo: TrackedRepo) => {
    const token = repo.forkTarget?.token || repo.uploadTarget?.token || globalToken || repo.token || prompt('请输入 GitHub Token：')?.trim();
    if (!token) return;
    startOperation();
    try { alert(await syncProjectUpstream(repo, token)); }
    catch (error) { alert('同步上游未完成：' + (error as Error).message); }
    finally { setIsLoading(false); }
  };

  // Traditional Push / Upload to custom target
  const handleOpenPush = (repo: TrackedRepo, version?: BackupVersion | null) => {
    const branch = version?.branch || sourceOf(repo).branch;
    const target = targetForBranch(repo, branch);
    setPushCopyMode(false); setPushBackupTarget(version || null);
    setPushTargetRepo(target ? `${target.owner}/${target.repo}` : ''); setPushTargetBranch(target?.branch || branch); setPushToken(''); setIsPushModalOpen(true);
  };
  const handlePushProjectToGitHub = async (e: React.FormEvent) => {
    e.preventDefault(); if (!activeRepo || !pushTargetRepo.trim()) return;
    const token = pushToken.trim() || activeRepo.uploadTarget?.token || globalToken || activeRepo.token;
    if (!token) return alert('请填写 GitHub Token');
    startOperation();
    try {
      const version = pushBackupTarget || viewingBackup || undefined;
      const sourceBranch = version?.branch || sourceOf(activeRepo).branch;
      const requested = parseRepository(pushTargetRepo);
      const target = !pushCopyMode && activeRepo.uploadTarget ? await boundTarget(activeRepo, token, sourceBranch) : await githubClient.repository(requested.owner, requested.repo, token);
      if (!target) throw new Error('目标仓库未指定');
      const destinationBranch = !pushCopyMode && activeRepo.uploadTarget ? targetForBranch(activeRepo, sourceBranch)!.branch : pushTargetBranch.trim() || sourceBranch;
      assertDestinationBranch(activeRepo, { ...target, branch: destinationBranch }, sourceBranch);
      const files = await versionFiles(activeRepo, version);
      const result = await githubClient.push(target.owner, target.repo, destinationBranch, token, files, pushCommitMsg.trim() || `Sync ${activeRepo.repo} @ ${version?.commitSha || activeRepo.latestCommitSha}`, activeRepo.description, activeRepo.remark, sourceOf(activeRepo).url, { rebaseOnConflict: !pushCopyMode, expectedRepoId: target.id });
      await recordUpload(activeRepo, result, purgePushCacheOption, version, {}, token, !pushCopyMode && (!!activeRepo.uploadTarget || !version));
      setIsPushModalOpen(false); setPushBackupTarget(null);
      alert(`已验证上传 ${files.length} 个文件。${purgePushCacheOption ? '对应版本源码已清理，快照已保留。' : '对应版本源码已保留。'}`);
    } catch (error) { alert('上传未完成：' + (error as Error).message); }
    finally { setIsLoading(false); }
  };

  const updateProject = async (repo: TrackedRepo, authToken = ''): Promise<string> => {
      if (repo.forkScope === 'full' && repo.origin) {
        const auth = repo.uploadTarget?.token || authToken || globalToken || repo.token;
        if (!auth) throw new Error('请填写 GitHub Token');
        return syncFullProject(repo, auth);
      }
      const source = sourceOf(repo);
      const token = repo.token || authToken || globalToken;
      if (repo.uploadTarget || repo.privateRepoUrl) await boundTarget(repo, repo.uploadTarget?.token || authToken || globalToken || token);
      const status = await githubClient.checkUpdate(source.owner, source.repo, source.branch, repo.latestCommitSha, token);
      if (!status.hasUpdate) {
        patchRepo(repo.id, { hasUpdate: false, lastCheckedAt: new Date().toISOString() });
        if (repo.uploadTarget && repo.remoteSnapshot?.sourceSha !== repo.latestCommitSha) {
          const target = repo.uploadTarget;
          const files = await versionFiles(repo);
          const result = await pushSnapshot(repo, files, target.token || globalToken || token, `Sync ${repo.repo} @ ${repo.latestCommitSha}`);
          await recordUpload(repo, result, target.purgeAfterUpload);
          return '已完成上次待上传的版本，并验证成功。';
        }
        return '当前已是最新版本';
      }
      let cached = await localCache.getProjectFiles(repo.id, repo.latestCommitSha);
      if (!cached.length && !repo.isCachePurged && repo.latestCommitSha !== 'HEAD') cached = await versionFiles(repo);
      const data = await githubClient.fetchRepo(source.url, source.branch, token, { ref: status.latestSha, cachedFiles: cached });
      await localCache.saveProjectFiles(repo.id, data.files, data.latestCommitSha);
      const old = archiveVersion(repo);
      const updated: TrackedRepo = { ...repo, latestCommitSha: data.latestCommitSha, commitMessage: data.commitMessage, commitAuthor: data.commitAuthor, commitDate: data.commitDate, tree: data.tree, repoMeta: { ...data.repoMeta, htmlUrl: repo.origin ? repo.repoMeta.htmlUrl : data.repoMeta.htmlUrl }, backups: repo.latestCommitSha === 'HEAD' ? repo.backups : [old, ...repo.backups], remoteSnapshot: undefined, isCachePurged: false, cachedFilesCount: data.files.length, lastSyncedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), hasUpdate: true };
      // Persist the newly downloaded version even if its subsequent upload fails.
      patchRepo(repo.id, { latestCommitSha: updated.latestCommitSha, commitMessage: updated.commitMessage, commitAuthor: updated.commitAuthor, commitDate: updated.commitDate, tree: updated.tree, repoMeta: updated.repoMeta, backups: updated.backups, remoteSnapshot: undefined, isCachePurged: false, cachedFilesCount: data.files.length, lastSyncedAt: updated.lastSyncedAt, hasUpdate: false, latestRemoteCommit: undefined });
      let message = '新版本已完整保存，旧版本已归档。请使用现有上传入口选择目标仓库。';
      if (repo.uploadTarget) {
        const target = repo.uploadTarget;
        const result = await pushSnapshot(updated, data.files, target.token || globalToken || token, `Sync ${repo.repo} @ ${data.latestCommitSha}`);
        await recordUpload(updated, result, target.purgeAfterUpload);
        message = '新版本已更新并验证上传；旧版本记录已保留。';
      }
      if (activeRepoId === repo.id) { setFileContent(null); setSelectedFilePath(null); setViewingBackup(null); }
      return message;
  };
  const handleOneClickUpdate = async (repo: TrackedRepo) => {
    startOperation(); setErrorMsg('');
    try { alert(await updateProject(repo)); }
    catch (error) { alert('更新未完成，已下载的版本会保留，可重新上传：' + (error as Error).message); }
    finally { setIsLoading(false); }
  };

  const handleDeleteRepo = async (repoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定移除该项目的本地记录和缓存？远程仓库不会删除。')) return;
    try {
      await localCache.deleteProjectFiles(repoId);
      persistRepos(reposRef.current.filter(r => r.id !== repoId));
      setSelectedProjectIds(prev => prev.filter(id => id !== repoId));
      if (activeRepoId === repoId) { setActiveRepoId(null); setCurrentView('projects'); }
    } catch (error) { alert('删除未完成：' + (error as Error).message); }
  };

  // ================= BATCH OPERATIONS ON PROJECTS =================
  const suggestedCopyName = (repo: TrackedRepo, scope: 'current' | 'full') => {
    const source = sourceOf(repo);
    if (repo.origin && repo.forkScope === scope) return repo.uploadTarget?.repo || repo.repo;
    return (scope === 'full' ? source.repo : `${source.owner}-${source.repo}-${source.branch}`).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100);
  };
  const openProjectBatch = (task: 'fork' | 'update' | 'sync') => {
    const items = reposRef.current.filter(repo => selectedProjectIds.includes(repo.id)).map(repo => ({ id: repo.id, label: `${repo.owner}/${repo.repo} · ${repo.branch}`, name: suggestedCopyName(repo, 'full'), status: 'pending' as const }));
    if (!items.length) return;
    setBatchTask(task); setBatchTaskItems(items); setBatchForkScope('full'); setBatchTaskToken(''); setBatchForkPurge(false);
  };
  const startProjectBatch = async (retry = false) => {
    if (!batchTask || batchTaskLock.current) return;
    const items = batchTaskItems.map(item => retry && ['error', 'cancelled'].includes(item.status) ? { ...item, status: 'pending' as const, message: undefined } : { ...item });
    batchTaskLock.current = true; setBatchTaskRunning(true); beginGithubOperation();
    const signal = operationSignal(); const seen = new Set<string>(); const targetNames = new Map<string, string>();
    const syncedTargets = new Map<string, Awaited<ReturnType<typeof githubClient.syncAllForkBranches>>>();
    if (batchTask === 'fork') for (const item of items.filter(item => item.status === 'success')) {
      const repo = reposRef.current.find(project => project.id === item.id);
      if (!repo) continue;
      const source = sourceOf(repo);
      const key = `${source.owner}/${source.repo}`.toLowerCase() + (batchForkScope === 'current' ? `:${source.branch}` : '');
      seen.add(key); targetNames.set(item.name.trim().toLowerCase(), key);
    }
    try {
      await runProjectBatch(items, { signal, onChange: setBatchTaskItems, run: async item => {
        const repo = reposRef.current.find(project => project.id === item.id);
        if (!repo) throw new Error('项目已移除，未执行');
        const token = batchTaskToken.trim() || (batchTask === 'sync' ? repo.forkTarget?.token : undefined) || repo.uploadTarget?.token || globalToken || repo.token || '';
        if (batchTask !== 'update' && !token) throw new Error('请填写 GitHub Token 或配置全局 Token 后重试');
        if (batchTask === 'update') return { message: await updateProject(repo, token) };
        const source = sourceOf(repo);
        if (batchTask === 'fork') {
          const sourceKey = `${source.owner}/${source.repo}`.toLowerCase() + (batchForkScope === 'current' ? `:${source.branch}` : '');
          if (seen.has(sourceKey)) {
            if (batchForkScope === 'full') {
              const managed = reposRef.current.find(project => project.forkScope === 'full' && project.origin?.owner.toLowerCase() === source.owner.toLowerCase() && project.origin?.repo.toLowerCase() === source.repo.toLowerCase());
              if (managed?.forkTarget) patchRepo(repo.id, { forkTarget: managed.forkTarget });
            }
            return { skipped: true, message: '本批已处理同一来源，已关联现有完整分叉或跳过重复副本' };
          }
          const name = item.name.trim();
          if (!/^[a-zA-Z0-9._-]{1,100}$/.test(name)) throw new Error('目标仓库名称需为 1–100 个字母、数字、点、横线或下划线');
          const occupied = targetNames.get(name.toLowerCase());
          if (occupied && occupied !== sourceKey) throw new Error('本批其他项目使用了相同目标名称，请修改名称后重试');
          targetNames.set(name.toLowerCase(), sourceKey);
          const message = await createProjectCopy(repo, batchForkScope, name, token, batchForkPurge);
          seen.add(sourceKey); return { message };
        }
        return { message: await syncProjectUpstream(repo, token, syncedTargets) };
      } });
    } finally { batchTaskLock.current = false; setBatchTaskRunning(false); }
  };

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
  const handleBatchDeleteProjects = async () => {
    if (!selectedProjectIds.length || !confirm('删除所选项目的本地记录和缓存？远程仓库不会删除。')) return;
    try {
      for (const id of selectedProjectIds) { await localCache.deleteProjectFiles(id); persistRepos(reposRef.current.filter(r => r.id !== id)); }
      if (activeRepoId && selectedProjectIds.includes(activeRepoId)) { setActiveRepoId(null); setCurrentView('projects'); }
      setSelectedProjectIds([]);
    } catch (error) { alert('部分删除未完成：' + (error as Error).message); }
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
    const token = globalToken || prompt('请输入 GitHub Token：')?.trim();
    if (!token) return;
    const purge = confirm('上传验证成功后是否清理本地源码？\n确定：清理源码并保留快照；取消：保留源码。');
    beginGithubOperation(); setIsBatchUploading(true);
    try {
      for (const repo of reposRef.current.filter(r => selectedProjectIds.includes(r.id))) {
        if (operationSignal().aborted) break;
        const status = (value: Partial<BatchUploadItemStatus>) => setBatchUploadStatusList(prev => prev.map(item => item.id === repo.id ? { ...item, ...value } : item));
        try {
          status({ status: 'creating' });
          const auth = repo.uploadTarget?.token || token;
          const existing = await boundTarget(repo, auth);
          const target = existing || await githubClient.ensurePrivateRepo(auth, repo.repo, repo.description, repo.remark);
          const branch = existing?.branch || sourceOf(repo).branch;
          assertDestinationBranch(repo, { ...target, branch });
          status({ status: 'uploading' });
          const files = await versionFiles(repo);
          const result = await githubClient.push(target.owner, target.repo, branch, auth, files, `Sync ${repo.repo} @ ${repo.latestCommitSha}`, repo.description, repo.remark, sourceOf(repo).url, { rebaseOnConflict: true, expectedRepoId: target.id });
          await recordUpload(repo, result, purge, undefined, { privateRepoUrl: target.htmlUrl }, auth);
          status({ status: 'success', htmlUrl: target.htmlUrl });
        } catch (error) { status({ status: 'error', error: (error as Error).message }); }
      }
    } finally { setIsBatchUploading(false); }
  };

  // Batch Purge Local Cache for selected projects
  const handleBatchPurgeCache = async () => {
    if (!selectedProjectIds.length || !confirm('清理所选项目的本地源码？项目快照和版本记录会保留。')) return;
    try {
      for (const id of selectedProjectIds) { await localCache.deleteProjectFiles(id); patchRepo(id, { isCachePurged: true, cachedFilesCount: 0, backups: (reposRef.current.find(r => r.id === id)?.backups || []).map(b => ({ ...b, isCachePurged: true })) }); }
      setSelectedProjectIds([]); alert('本地源码已清理，快照已保留。');
    } catch (error) { alert('缓存清理未完成：' + (error as Error).message); }
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
    beginGithubOperation();
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
            owner: b.remoteSnapshot?.owner || activeRepo.owner,
            repo: b.remoteSnapshot?.repo || activeRepo.repo,
            commitSha: b.remoteSnapshot?.commitSha || b.commitSha,
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
            tree: updatedBackups[targetIdx].tree
          };
        }

        setBatchReleaseProgress(prev => prev.map((item, idx) =>
          idx === i ? { ...item, status: 'success', releaseUrl: res.releaseUrl } : item
        ));
        if (purgeCacheOption) await localCache.deleteProjectFiles(activeRepo.id, b.commitSha);
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
  const handlePurgeBackupCache = async (backupId: string, e?: React.MouseEvent) => {
    e?.stopPropagation(); if (!activeRepo) return;
    const backup = activeRepo.backups.find(b => b.id === backupId);
    if (!backup || !confirm('清理此版本的本地源码？版本快照会保留。')) return;
    try {
      await localCache.deleteProjectFiles(activeRepo.id, backup.commitSha);
      patchRepo(activeRepo.id, { backups: activeRepo.backups.map(b => b.id === backupId ? { ...b, isCachePurged: true } : b) });
    } catch (error) { alert('清理失败：' + (error as Error).message); }
  };

  // Purge local cache for the active project
  const handlePurgeProjectCache = async (repoId: string, e?: React.MouseEvent) => {
    e?.stopPropagation(); if (!confirm('清理该项目的本地源码？项目快照和历史版本记录会保留。')) return;
    try {
      await localCache.deleteProjectFiles(repoId);
      patchRepo(repoId, { isCachePurged: true, cachedFilesCount: 0, backups: (reposRef.current.find(r => r.id === repoId)?.backups || []).map(b => ({ ...b, isCachePurged: true })) });
      if (activeRepoId === repoId) { setSelectedFilePath(null); setFileContent(null); }
    } catch (error) { alert('清理失败：' + (error as Error).message); }
  };

  // Re-pull and restore cache from GitHub for a project
  const handleRepullProjectCache = async (repoId: string, e?: React.MouseEvent) => {
    e?.stopPropagation(); const repo = reposRef.current.find(r => r.id === repoId); if (!repo) return;
    startOperation();
    try {
      const files = await versionFiles(repo);
      patchRepo(repo.id, { isCachePurged: false, cachedFilesCount: files.length });
      alert(`已恢复当前快照的 ${files.length} 个文件；获取新版本请使用更新操作。`);
    } catch (error) { alert('恢复未完成：' + (error as Error).message); }
    finally { setIsLoading(false); }
  };

  // File viewing logic (Checks local IndexedDB cache first for 0ms offline display)
  const handleSelectFile = async (filePath: string) => {
    if (!activeRepo || activeTree.find(f => f.path === filePath)?.type !== 'blob') return;
    if (operationSignal().aborted) beginGithubOperation();
    const requestId = ++fileRequest.current;
    const version = viewingBackup;
    const sha = version?.commitSha || activeRepo.latestCommitSha;
    setSelectedFilePath(filePath); setFileLoading(true); setFileContent(null); setMobileFileView('view');
    try {
      const cached = await localCache.getProjectFile(activeRepo.id, filePath, sha);
      let data: { type: string; content: string };
      if (cached) data = { content: cached.content, type: cached.isBase64 ? 'base64' : 'text' };
      else {
        const remote = version?.remoteSnapshot || savedSnapshot(activeRepo, sha);
        const source = sourceOf(activeRepo);
        try { data = await githubClient.getFile(remote?.owner || source.owner, remote?.repo || source.repo, filePath, remote ? activeRepo.uploadTarget?.token || globalToken || activeRepo.token : activeRepo.token || globalToken, remote?.commitSha || sha); }
        catch (error) {
          if (!remote || !(error instanceof GitHubError) || error.rateLimited || ![401, 403, 404, 409].includes(error.status)) throw error;
          const files = await versionFiles(activeRepo, version || undefined);
          const recovered = files.find(file => file.path === filePath);
          if (!recovered) throw new Error('保存的版本中没有该文件');
          data = { content: recovered.content, type: recovered.isBase64 ? 'base64' : 'text' };
        }
      }
      if (requestId === fileRequest.current) { setFileContent(data.content); setFileContentType(data.type); }
    } catch (error) { if (requestId === fileRequest.current) { setFileContent('读取失败：' + (error as Error).message); setFileContentType('text'); } }
    finally { if (requestId === fileRequest.current) setFileLoading(false); }
  };

  const handleLoadHistory = async () => {
    if (!activeRepo) return;
    const token = activeRepo.uploadTarget?.token || globalToken || activeRepo.token;
    if (!token) return alert('请先填写 GitHub Token');
    startOperation();
    try {
      const target = await boundTarget(activeRepo, token);
      if (!target) throw new Error('请先绑定上传目标');
      const entries = await githubClient.listHistory(target, token, historyPage);
      const loaded: BackupVersion[] = [];
      const known = new Set(activeRepo.backups.filter(item => item.branch === sourceOf(activeRepo).branch || !item.branch && item.remoteSnapshot?.branch === target.branch).map(item => item.remoteSnapshot?.commitSha));
      for (const entry of entries) {
        operationSignal().throwIfAborted();
        if (known.has(entry.sha)) continue;
        const manifest = await githubClient.inspectRepo(target.htmlUrl, target.branch, token, entry.sha);
        loaded.push({ branch: sourceOf(activeRepo).branch, id: `git-${entry.sha}-${target.branch}`, versionNumber: 0, tag: entry.sha.slice(0, 12), annotation: entry.message.split('\n')[0], commitSha: entry.sha, commitMessage: entry.message, commitAuthor: entry.author, commitDate: entry.date, backedUpAt: entry.date, tree: manifest.tree, isCachePurged: true,
          remoteSnapshot: { repoId: target.id, owner: target.owner, repo: target.repo, branch: target.branch, commitSha: entry.sha, sourceSha: entry.sha, htmlUrl: `${target.htmlUrl}/commit/${entry.sha}` } });
      }
      patchRepo(activeRepo.id, { backups: [...activeRepo.backups, ...loaded] });
      setHistoryPage(page => page + 1); setHistoryHasMore(entries.length === 30);
    } catch (error) { alert('获取历史失败：' + (error as Error).message); }
    finally { setIsLoading(false); }
  };
  const handleDownloadVersion = async (version: BackupVersion) => {
    if (!activeRepo) return;
    startOperation();
    try {
      const files = await versionFiles(activeRepo, version);
      const { default: JSZip } = await import('jszip'); const zip = new JSZip();
      for (const file of files) zip.file(file.path, file.content, { base64: file.isBase64 });
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${activeRepo.repo}-${version.commitSha.slice(0, 12)}.zip`; link.click(); URL.revokeObjectURL(url);
    } catch (error) { alert('版本下载失败：' + (error as Error).message); }
    finally { setIsLoading(false); }
  };
  const handleRestoreVersion = async (version: BackupVersion) => {
    if (!activeRepo || !confirm(`将此历史版本恢复到 ${version.branch || sourceOf(activeRepo).branch} 对应的目标分支？会创建新提交，保留之后的全部历史。`)) return;
    const token = activeRepo.uploadTarget?.token || globalToken || activeRepo.token;
    if (!token) return alert('请填写 GitHub Token');
    startOperation();
    try {
      const files = await versionFiles(activeRepo, version);
      const branch = version.branch || sourceOf(activeRepo).branch;
      const result = await pushSnapshot(activeRepo, files, token, `Restore historical version ${version.remoteSnapshot?.commitSha || version.commitSha}`, branch);
      const restored = { ...activeRepo, latestCommitSha: version.commitSha, tree: version.tree, commitMessage: version.commitMessage, commitAuthor: version.commitAuthor, commitDate: version.commitDate };
      await recordUpload(restored, result, false, branch === sourceOf(activeRepo).branch ? undefined : version, {}, token);
      alert(`历史版本已恢复为目标分支 ${result.branch} 的新提交，原有历史全部保留。`);
    } catch (error) { alert('恢复未完成，本地文件保留：' + (error as Error).message); }
    finally { setIsLoading(false); }
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
          fileChangesCount: activeRepo.backups[0] ? Object.values(computeDiff(activeRepo.backups[0], activeRepo.tree)).reduce((n, paths) => n + paths.length, 0) : activeRepo.tree.filter(f => f.type === 'blob').length
        })
      });

      setRepos(prev => prev.map(r => {
        if (r.id === activeRepo.id) {
          return { ...r, aiChangelog: data.changelog };
        }
        return r;
      }));
    } catch (err) {
      alert('日志生成失败：' + (err as Error).message);
    } finally {
      setAiLoading(false);
    }
  };

  // Compare diff between backup and current
  const computeDiff = (backup: BackupVersion, currentTree: RepoTreeItem[]) => {
    const backupFiles = backup.tree.filter(item => item.type === 'blob');
    currentTree = currentTree.filter(item => item.type === 'blob');
    const backupPaths = new Set(backupFiles.map(i => i.path));
    const currentPaths = new Set(currentTree.map(i => i.path));
    const backupMap = new Map(backupFiles.map(i => [i.path, i.sha]));
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
    startOperation();
    setLoadingText(`正在为 APK/移动端 打包自选文件夹 [${selectedFolderToDownload}] (共 ${filesInSelectedFolder.length} 个文件)...`);

    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const cleanFolderName = selectedFolderToDownload === '/' ? 'root' : selectedFolderToDownload.replace(/\//g, '_');
      const zipRootFolderName = `${projectSettingsTarget.repo}-${cleanFolderName}`;
      const rootZipFolder = zip.folder(zipRootFolderName);

      let fetchedCount = 0;
      const filesToFetch = filesInSelectedFolder;
      const fullSnapshot = await versionFiles(projectSettingsTarget);
      const filesByPath = new Map(fullSnapshot.map(file => [file.path, file]));
      for (const file of filesToFetch) {
        operationSignal().throwIfAborted();
        const cached = filesByPath.get(file.path);
        if (!cached) throw new Error(`文件缺失，导出已停止：${file.path}`);
        const relPath = selectedFolderToDownload === '/' ? file.path : file.path.slice(selectedFolderToDownload.length + 1);
        rootZipFolder?.file(relPath, cached.content, { base64: cached.isBase64 });
        setLoadingText(`正在打包 ${++fetchedCount}/${filesToFetch.length}：${file.path}`);
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
    <div className="app-shell min-h-screen bg-[#F8F6F1] text-[#2E2B27] flex flex-col font-sans selection:bg-[#9CB09D] selection:text-white pb-24 md:pb-20">
      {/* Top Navbar */}
      <header className="app-header border-b border-[#E5DFD7] bg-[#FFFFFF]/90 backdrop-blur sticky top-0 z-30 px-4 md:px-8 py-3 flex flex-row items-center justify-between shadow-xs">
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
          <nav className="hidden xl:flex flex-row items-center gap-1.5 bg-[#EFECE6]/80 p-1 rounded-xl border border-[#DFD8CE] whitespace-nowrap">
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
            <div className="bg-gradient-to-r from-[#FFFFFF] via-[#FAF8F5] to-[#F1ECE4] border border-[#E5DFD7] rounded-3xl p-6 md:p-8 shadow-xs flex flex-col xl:flex-row xl:items-center justify-between gap-6">
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
                                {hasTargetIssue(repo) ? '远端目标异常' : '私人仓已同步'}
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

                        <p className="text-xs font-medium text-[#4D5E4A] italic break-words">备注: {repo.remark}</p>
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
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h2 className="text-xl md:text-2xl font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                  <FolderGit2 className="w-6 h-6 text-[#8E9F8B] shrink-0" />
                  <span>仓库已有项目管理中心</span>
                </h2>
                <p className="text-xs text-[#7A7367] mt-0.5">
                  集中管理所有拉取链接的 GitHub 项目，支持批量上传私人仓库、批量删除、批量添加标签及自选文件夹下载。
                </p>
              </div>

              <div className="flex flex-row items-center gap-2 flex-wrap sm:flex-wrap whitespace-nowrap">
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
            <div className="batch-toolbar bg-[#FAF8F5] border border-[#E5DFD7] rounded-2xl p-3 md:p-4 flex flex-col gap-3 shadow-xs">
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
                <button type="button" onClick={() => setSelectedProjectIds(filteredRepos.filter(repo => repo.hasUpdate).map(repo => repo.id))} disabled={!filteredRepos.some(repo => repo.hasUpdate)} className="px-3 py-1.5 bg-[#FFFFFF] border border-[#DFD8CE] rounded-xl text-xs text-[#5D6F5A] disabled:opacity-40">仅选有更新</button>
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
              <div className="batch-actions">
                <button
                  onClick={handleOpenBatchUploadModal}
                  disabled={selectedProjectIds.length === 0}
                  className="px-3.5 py-1.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 disabled:opacity-40 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                  title="为选中的每个项目自动在您的 GitHub 账号下创建私人仓库并完整上传代码、备注与描述"
                >
                  <UploadCloud className="w-3.5 h-3.5 shrink-0" />
                  <span>批量上传至私人仓库</span>
                </button>

                <button type="button" onClick={() => openProjectBatch('fork')} disabled={!selectedProjectIds.length} className="px-3 py-1.5 bg-[#FFFFFF] border border-[#DFD8CE] rounded-xl text-xs text-[#4D5E4A] disabled:opacity-40">批量分叉</button>
                <button type="button" onClick={() => openProjectBatch('update')} disabled={!selectedProjectIds.length} className="px-3 py-1.5 bg-[#FFFFFF] border border-[#DFD8CE] rounded-xl text-xs text-[#4D5E4A] disabled:opacity-40">批量更新</button>
                <button type="button" onClick={() => openProjectBatch('sync')} disabled={!selectedProjectIds.length} className="px-3 py-1.5 bg-[#FFFFFF] border border-[#DFD8CE] rounded-xl text-xs text-[#4D5E4A] disabled:opacity-40">批量分叉同步</button>
              </div>
              <details className="text-xs text-[#6B6358]">
                <summary className="cursor-pointer py-1">更多管理</summary>
                <div className="batch-secondary mt-2">
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
              </details>
            </div>

            {/* Filter Toolbar */}
            <div className="bg-[#FFFFFF] border border-[#E5DFD7] rounded-2xl p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-3 shadow-xs">
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
                          <div className="flex flex-row items-center gap-2 flex-wrap">
                            <a
                              href={repo.repoMeta.htmlUrl || repo.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-base font-bold text-[#2B2723] hover:text-[#5D6F5A] transition flex flex-row items-center gap-1.5 font-mono shrink-0"
                            >
                              <span>{repo.owner}/{repo.repo}</span>
                              <ExternalLink className="w-3.5 h-3.5 text-[#91887C] shrink-0" />
                            </a>

                            <span className="text-xs bg-[#8E9F8B]/15 text-[#4D5E4A] px-2.5 py-0.5 rounded-md border border-[#8E9F8B]/30 font-medium shrink-0">
                              备注: {repo.remark}
                            </span>

                            {repo.privateRepoUrl ? (
                              <a
                                href={repo.privateRepoUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] bg-[#8E9F8B]/20 text-[#3D4F3A] px-2 py-0.5 rounded-full font-mono flex flex-row items-center gap-1 border border-[#8E9F8B]/40 hover:underline shrink-0"
                                title="点击直接打开个人私人仓库"
                              >
                                <ShieldCheck className="w-3 h-3 text-[#5D6F5A] shrink-0" />
                                <span>{hasTargetIssue(repo) ? '远端目标异常' : '私人仓库已同步'}</span>
                              </a>
                            ) : (
                              <span className="text-[10px] bg-[#EFECE6] text-[#7A7367] px-2 py-0.5 rounded-full font-mono border border-[#DFD8CE] shrink-0">
                                未上传私人仓
                              </span>
                            )}

                            {repo.isCachePurged ? (
                              <span className="text-[10px] bg-[#EFECE6] text-[#6B6358] px-2 py-0.5 rounded-full font-mono flex flex-row items-center gap-1 border border-[#DFD8CE] shrink-0">
                                <Archive className="w-2.5 h-2.5 shrink-0" />
                                <span>本地缓存已释放</span>
                              </span>
                            ) : (
                              <span className="text-[10px] bg-[#FAF8F5] text-[#7A7367] px-2 py-0.5 rounded-full font-mono border border-[#DFD8CE] shrink-0">
                                本地缓存就绪 ({repo.tree.length} 文件)
                              </span>
                            )}

                            {repo.hasUpdate ? (
                              <span className="text-[10px] bg-[#B6847A]/20 text-[#8C5D54] px-2.5 py-0.5 rounded-full font-bold border border-[#B6847A]/30 flex flex-row items-center gap-1 shrink-0">
                                <AlertCircle className="w-3 h-3 shrink-0" />
                                <span>远程有更新</span>
                              </span>
                            ) : (
                              <span className="text-[10px] bg-[#8E9F8B]/20 text-[#4D5E4A] px-2.5 py-0.5 rounded-full font-medium border border-[#8E9F8B]/30 flex flex-row items-center gap-1 shrink-0">
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

                          {/* Tags & meta line */}
                          {targetWarning(repo)}
                          <div className="flex flex-row items-center gap-2 flex-wrap">
                            {repo.tags.map(t => (
                              <span key={t} className="inline-flex flex-row items-center text-[10px] bg-[#EFECE6] text-[#474239] px-2 py-0.5 rounded border border-[#DFD8CE] shrink-0 leading-none">
                                #{t}
                              </span>
                            ))}
                            <span className="text-xs text-[#7A7367] font-mono shrink-0">
                              分支: <code>{repo.branch}</code>
                            </span>
                            <span className="text-xs text-[#7A7367] font-mono shrink-0">
                              最新SHA: <code>{repo.latestCommitSha.substring(0, 7)}</code>
                            </span>
                          </div>

                          <p className="text-[11px] text-[#91887C] font-mono flex flex-wrap gap-2">
                            <span>最后检测: {repo.lastCheckedAt ? new Date(repo.lastCheckedAt).toLocaleTimeString() : '从未'}</span>
                            <span>| 归档: {repo.backups.length} 个版本</span>
                            {repo.lastUploadedToPrivateAt && <span>| 上传私人仓: {new Date(repo.lastUploadedToPrivateAt).toLocaleString()}</span>}
                          </p>
                        </div>
                      </div>

                      {/* Action Buttons - Single horizontal line, whitespace-nowrap */}
                      <div className="flex flex-row items-center gap-2 flex-wrap sm:flex-wrap shrink-0 whitespace-nowrap">
                        {/* Single Upload to Private Repo Button */}
                        <button
                          onClick={() => handleOpenSingleUploadModal(repo)}
                          className="px-3 py-1.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                          title="管理项目：选择创建私人仓库上传或创建分叉及上游同步"
                        >
                          <GitBranch className="w-3.5 h-3.5 shrink-0" />
                          <span>分叉与私有仓</span>
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
            {/* Repository details and actions each remain within the card width. */}
            <div className="workbench-banner bg-[#FFFFFF] border border-[#E5DFD7] rounded-3xl p-4 md:p-5 flex flex-col gap-4 shadow-xs">
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
                        <span>源码已本地保存 ({activeRepo.cachedFilesCount ?? activeRepo.tree.length} 文件)</span>
                      </span>
                    )}
                    {viewingBackup && (
                      <span className="text-xs bg-[#C7A39B]/20 text-[#8C5D54] px-2.5 py-0.5 rounded border border-[#C7A39B]/30 font-semibold whitespace-nowrap shrink-0">
                        正在查看归档: {viewingBackup.tag}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-row flex-wrap items-center gap-2 mt-2">
                    <span className="text-xs text-[#5D6F5A] font-mono">当前分支：{activeRepo.branch}</span>
                    <button type="button" onClick={() => handleOpenProjectSettings(activeRepo, 'basic')} className="text-xs text-[#5D6F5A] hover:underline">编辑备注与描述</button>
                  </div>
                  <div className="flex flex-row flex-wrap items-center gap-2 mt-2">
                    {workbenchBranches.length ? <select aria-label="工作台分支" value={workbenchBranchInput} onChange={e => setWorkbenchBranchInput(e.target.value)} className="max-w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-3 py-2 text-xs text-[#2E2B27]">
                      {!workbenchBranches.includes(workbenchBranchInput) && <option value={workbenchBranchInput}>{workbenchBranchInput}</option>}
                      {workbenchBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
                    </select> : <input aria-label="工作台分支" placeholder="输入要切换的分支" value={workbenchBranchInput} onChange={e => setWorkbenchBranchInput(e.target.value)} className="max-w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-3 py-2 text-xs text-[#2E2B27]" />}
                    <button type="button" disabled={workbenchBranchLoading || isLoading} onClick={handleWorkbenchBranches} className="text-xs text-[#5D6F5A] hover:underline disabled:opacity-40">{workbenchBranchLoading ? '获取分支中…' : '获取可切换分支'}</button>
                    <button type="button" disabled={isLoading || !workbenchBranchInput.trim() || workbenchBranchInput.trim() === activeRepo.branch} onClick={handleSwitchBranch} className="px-3 py-2 bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl text-xs text-[#4D5E4A] disabled:opacity-40">切换并重新拉取</button>
                  </div>
                  {activeRepo.uploadTarget && <p className="text-[11px] text-[#7A7367] mt-1 break-all">上传分支：{activeRepo.uploadTarget.owner}/{activeRepo.uploadTarget.repo} · {activeRepo.uploadTarget.branch}</p>}
                  {projectTargets(activeRepo).length > 0 && <button type="button" onClick={() => openTargetManager(activeRepo)} className="mt-2 text-xs text-[#5D6F5A] hover:underline">管理远端目标</button>}
                  {workbenchBranchError && <p role="alert" className="text-xs text-[#8C5D54] mt-1 break-words">{workbenchBranchError}</p>}

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

              {targetWarning(activeRepo)}
              {/* Workbench Actions */}
              <div className="workbench-actions">
                <button
                  onClick={() => handleOpenSingleUploadModal(activeRepo)}
                  className="px-3.5 py-2 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] hover:brightness-105 text-white rounded-xl text-xs font-semibold shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                  title="管理项目：选择创建私人仓库上传或创建分叉及上游同步"
                >
                  <GitBranch className="w-3.5 h-3.5 shrink-0" />
                  <span>分叉与私有仓</span>
                </button>
                <button
                  onClick={() => handleOpenPush(activeRepo, viewingBackup)}
                  className="px-3 py-2 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#4D5E4A] rounded-xl text-xs font-semibold border border-[#DCD5CB] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <UploadCloud className="w-3.5 h-3.5 shrink-0" /><span>上传指定仓库</span>
                </button>

                <button
                  onClick={() => handleSyncUpstream(activeRepo)}
                  className="px-3 py-2 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#4D5E4A] rounded-xl text-xs font-semibold border border-[#DFD8CE] shadow-xs transition flex flex-row items-center gap-1.5 whitespace-nowrap shrink-0"
                  title="将该分叉与上游源仓库进行合并同步"
                >
                  <RefreshCcw className="w-3.5 h-3.5 text-[#5D6F5A] shrink-0" />
                  <span>同步上游</span>
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
                        <React.Suspense fallback={<span className="text-xs text-[#7A7367]">正在加载图表…</span>}>
                          <RepoHeatmap data={heatmapData} content={<CustomizedTreemapContent />} />
                        </React.Suspense>
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
                          .slice(0, visibleFileCount)
                          .map(item => {
                            const isSelected = selectedFilePath === item.path;
                            return (
                              <div
                                key={item.path}
                                onClick={() => handleSelectFile(item.path)}
                                className={`file-row flex flex-row items-center gap-2 px-3 py-2 rounded-xl text-xs cursor-pointer transition whitespace-nowrap overflow-hidden ${
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
                        {activeTree.filter(t => t.path.toLowerCase().includes(fileSearchQuery.toLowerCase())).length > visibleFileCount && (
                          <button type="button" onClick={() => setVisibleFileCount(n => n + 150)} className="px-3 py-2 text-xs text-[#5D6F5A] hover:underline">加载更多文件</button>
                        )}
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
                {activeRepo.uploadTarget && historyHasMore && <button type="button" onClick={handleLoadHistory} className="text-xs text-[#5D6F5A] hover:underline">获取 GitHub 历史记录</button>}
                {/* Backups Action Toolbar */}
                <div className="bg-[#FAF8F5] border border-[#E5DFD7] rounded-2xl p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-3 shadow-xs">
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
                          className={`bg-[#FFFFFF] border rounded-2xl p-4 md:p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4 shadow-xs transition ${
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
                                分支: <code>{backup.branch || activeRepo.branch}</code> | SHA: <code>{backup.commitSha.slice(0, 7)}</code> | 归档于: {new Date(backup.backedUpAt).toLocaleString()}
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-row flex-wrap items-center gap-2 whitespace-nowrap shrink-0">
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
                                fileRequest.current++; setSelectedFilePath(null); setFileContent(null);
                                setWorkbenchTab('files');
                              }}
                              className="px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition shrink-0"
                            >
                              {viewingBackup?.id === backup.id ? '取消查看' : '查看此版本'}
                            </button>
                            <button onClick={() => handleDownloadVersion(backup)} className="px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition shrink-0">下载</button>
                            <button onClick={() => { setDiffBackupTarget(backup); setIsDiffModalOpen(true); }} className="px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition shrink-0">对比</button>
                            {activeRepo.uploadTarget && <button onClick={() => handleRestoreVersion(backup)} className="px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition shrink-0">恢复此版本</button>}
                            <button onClick={() => handleOpenPush(activeRepo, backup)} className="px-3 py-1.5 bg-[#FAF8F5] hover:bg-[#EFECE6] text-[#3B362F] rounded-xl text-xs font-medium border border-[#DFD8CE] transition shrink-0">上传此版本</button>
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

      {targetManagerRepo && <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-[60] flex items-center justify-center p-4">
        <div role="dialog" aria-modal="true" aria-label="管理远端目标" className="bg-white border border-[#E2DBD0] rounded-3xl max-w-2xl w-full p-6 shadow-xl flex flex-col gap-4">
          <div className="flex flex-row justify-between items-start gap-3">
            <h3 className="text-base font-bold font-serif text-[#2B2723]">管理远端目标</h3>
            <button type="button" aria-label="关闭远端目标管理" disabled={targetManagerBusy} onClick={() => setTargetManagerId(null)} className="p-1 text-[#91887C] disabled:opacity-40"><X className="w-5 h-5" /></button>
          </div>
          <p className="text-xs text-[#7A7367] leading-relaxed">仓库被删除、私有仓权限不足或改名都可能导致访问失败。检测不会删除本地内容，也不会自动解除绑定。确认旧目标不再使用后，可解除该目标在所有项目中的当前绑定，再重新上传或创建分叉。</p>
          <p className="text-xs text-[#474239] break-all">当前项目：{sourceOf(targetManagerRepo).owner}/{sourceOf(targetManagerRepo).repo} · {sourceOf(targetManagerRepo).branch}</p>
          <label className="text-xs text-[#474239]">更新该目标的 GitHub Token（可选）<input aria-label="远端目标 Token" type="password" autoComplete="off" disabled={targetManagerBusy} value={targetManagerToken} onChange={e => setTargetManagerToken(e.target.value)} className="w-full mt-1 px-3 py-2 bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl" /></label>
          <p className="text-xs text-[#7A7367]">新 Token 仅在目标身份验证通过后保存到对应绑定；不会替换全局 Token。</p>
          <div className="flex flex-col gap-3">
            {projectTargets(targetManagerRepo).map(target => {
              const health = targetHealthOf(targetManagerRepo, target);
              const count = repos.filter(project => projectTargets(project).some(item => sameTarget(item, target))).length;
              return <div key={targetKey(target)} className="p-3 border border-[#DFD8CE] rounded-xl bg-[#FAF8F5] flex flex-col gap-2 text-xs">
                <a href={`https://github.com/${target.owner}/${target.repo}`} target="_blank" rel="noreferrer" className="font-semibold text-[#4D5E4A] break-all">{target.owner}/{target.repo}</a>
                <p className="text-[#7A7367]">关联 {count} 个项目记录{target.id ? ` · 仓库 ID：${target.id}` : ''}</p>
                <p className={health?.status === 'available' ? 'text-[#5D6F5A]' : 'text-[#8C5D54]'}>{health?.message || '尚未检测，请点击重新检测。'}</p>
                {health?.checkedAt && <p className="text-[#7A7367]">检测时间：{new Date(health.checkedAt).toLocaleString()}</p>}
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" disabled={targetManagerBusy} onClick={() => void handleCheckTarget(targetManagerRepo.id, target)} className="px-3 py-2 border border-[#DFD8CE] rounded-xl text-[#5D6F5A] disabled:opacity-40">重新检测此目标</button>
                  <button type="button" disabled={targetManagerBusy} onClick={() => handleDetachTarget(targetManagerRepo.id, target)} className="px-3 py-2 border border-[#C7A39B] rounded-xl text-[#8C5D54] disabled:opacity-40">解除此目标的所有绑定</button>
                </div>
              </div>;
            })}
            {!projectTargets(targetManagerRepo).length && <p className="text-xs text-[#5D6F5A]">当前没有上传或分叉目标绑定，可重新设置。</p>}
          </div>
          {targetManagerMessage && <p role="status" className="text-xs text-[#5D6F5A]">{targetManagerMessage}</p>}
          {detachedTargetName && <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => reopenTargetSetup(targetManagerRepo.id, false)} className="px-3 py-2 bg-[#8E9F8B] text-white rounded-xl text-xs">重新设置上传</button>
            <button type="button" onClick={() => reopenTargetSetup(targetManagerRepo.id, true)} className="px-3 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs">重新创建分叉</button>
          </div>}
          <div className="flex flex-row flex-wrap justify-end gap-2 border-t border-[#EDE7DF] pt-3">
            {targetManagerBusy ? <button type="button" onClick={cancelGithubOperation} className="px-3 py-2 text-xs text-[#8C5D54]">取消检测</button> : <>
              <button type="button" onClick={() => setTargetManagerId(null)} className="px-3 py-2 bg-[#EFECE6] rounded-xl text-xs text-[#554F45]">关闭</button>
              {projectTargets(targetManagerRepo).length > 0 && <>
                <button type="button" onClick={() => void handleCheckTarget(targetManagerRepo.id)} className="px-3 py-2 border border-[#DFD8CE] rounded-xl text-xs text-[#5D6F5A]">重新检测全部</button>
                <button type="button" disabled={!targetManagerToken.trim()} onClick={() => void handleCheckTarget(targetManagerRepo.id)} className="px-3 py-2 bg-[#8E9F8B] text-white rounded-xl text-xs disabled:opacity-40">应用 Token 并重新检测</button>
              </>}
            </>}
          </div>
        </div>
      </div>}

      {importMatch && <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-[60] flex items-center justify-center p-4">
        <div role="dialog" aria-modal="true" aria-label="选择已有项目作为同步基础" className="bg-white border border-[#E2DBD0] rounded-3xl max-w-2xl w-full p-6 shadow-xl flex flex-col gap-4">
          <div className="flex flex-row justify-between items-start gap-3">
            <h3 className="text-base font-bold font-serif text-[#2B2723]">发现已有上传或分叉项目</h3>
            <button type="button" aria-label="取消本次导入" onClick={cancelGithubOperation} className="text-[#91887C] p-1"><X className="w-5 h-5" /></button>
          </div>
          <p className="text-xs text-[#7A7367] leading-relaxed break-words">已按项目列表中保存的来源关系匹配。请先对比再决定是否沿用；本次只保存本地项目和绑定，后续上传或分叉同步才会写入远端。也可以独立导入或跳过。</p>
          <p className="text-xs text-[#474239] break-all">新链接：{importMatch.source.owner}/{importMatch.source.repo} · {importMatch.source.branch}<br />待导入提交：{importMatch.sha}</p>
          <div className="flex flex-col gap-3">
            {importMatch.candidates.map(candidate => {
              const comparison = importMatch.comparisons[candidate.key];
              const target = comparison?.target || candidate.target;
              return <div key={candidate.key} className="border border-[#DFD8CE] rounded-xl bg-[#FAF8F5] p-3 flex flex-col gap-2 text-xs break-words">
                <p className="font-semibold text-[#4D5E4A] break-all">{candidate.fullFork ? '完整分叉' : target.kind === 'current' ? '分支副本' : '上传仓库'}：{target.owner}/{target.repo}</p>
                {candidate.remark && <p className="text-[#7A7367]">已有备注：{candidate.remark}</p>}
                <p className="text-[#474239] break-all">原始来源：{candidate.source.owner}/{candidate.source.repo}</p>
                <p className="text-[#474239] break-all">分支映射：{candidate.source.branch} → {target.branch}</p>
                {comparison?.status === 'loading' && <p role="status" className="text-[#7A7367]">正在校验仓库身份并对比文件…</p>}
                {comparison?.status === 'error' && <p role="alert" className="text-[#8C5D54]">无法沿用：{comparison.error}</p>}
                {comparison?.status === 'ready' && <div className="flex flex-col gap-2 text-[#5D6F5A]">
                  <p className="break-all">来源提交：{comparison.sourceSha}</p>
                  <p className="break-all">目标提交：{comparison.commitSha || '目标分支尚不存在，后续上传时新建'}</p>
                  <p role="status">相对目标：新增 {comparison.diff!.added.length} · 修改 {comparison.diff!.modified.length} · 删除 {comparison.diff!.removed.length}</p>
                  {!candidate.fullFork && <p className="text-[#7A7367]">应用自动生成的 GITVAULT_METADATA.md 不计入差异；来源自带的同名文件仍会比较。</p>}
                  {!comparison.diff!.added.length && !comparison.diff!.modified.length && !comparison.diff!.removed.length && <p>当前文件内容与文件模式一致。</p>}
                  <p className="text-[#7A7367]">文件差异不影响同一来源的识别。沿用后上传会按来源快照覆盖该目标分支的文件，并保留提交历史。</p>
                  {candidate.fullFork && <p className="text-[#7A7367]">此处对比当前分支；后续“分叉同步”会同步该分叉的全部上游分支。</p>}
                  {comparison.diff!.added.length + comparison.diff!.modified.length + comparison.diff!.removed.length > 0 && <details><summary className="cursor-pointer">查看文件差异</summary><div className="max-h-40 overflow-y-auto mt-2 flex flex-col gap-1 break-all">{(['added', 'modified', 'removed'] as const).flatMap((kind, index) => comparison.diff![kind].map(path => <p key={`${kind}:${path}`}>{['新增', '修改', '删除'][index]} · {path}</p>))}</div></details>}
                </div>}
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button type="button" disabled={comparison?.status === 'loading'} onClick={() => void compareImportBase(candidate)} className="px-3 py-2 border border-[#DFD8CE] rounded-xl text-[#5D6F5A] disabled:opacity-40">{comparison?.status === 'ready' ? '重新对比' : '对比此项目'}</button>
                  <button type="button" disabled={comparison?.status !== 'ready'} onClick={() => comparison?.status === 'ready' && importResolver.current?.({ candidate, comparison })} className="px-3 py-2 bg-[#8E9F8B] text-white rounded-xl disabled:opacity-40">{candidate.fullFork ? '沿用分叉同步' : '沿用上传目标'}</button>
                </div>
              </div>;
            })}
          </div>
          <div className="flex flex-row flex-wrap justify-end gap-2 border-t border-[#EDE7DF] pt-3">
            <button type="button" onClick={cancelGithubOperation} className="px-3 py-2 text-xs text-[#8C5D54]">取消本次导入</button>
            <button type="button" onClick={() => importResolver.current?.('skip')} className="px-3 py-2 text-xs border border-[#DFD8CE] rounded-xl text-[#554F45]">跳过此链接</button>
            <button type="button" onClick={() => importResolver.current?.('independent')} className="px-3 py-2 text-xs bg-[#EFECE6] rounded-xl text-[#554F45]">独立导入，不关联</button>
          </div>
        </div>
      </div>}

      {/* ================= MODAL 1: ADD / PULL REPO ================= */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-lg w-full p-6 shadow-xl flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                <Plus className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                <span>新建链接并拉取项目</span>
              </h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-[#91887C] hover:text-[#2E2B27]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-row gap-4 border-b border-[#EDE7DF]">
              <button type="button" onClick={() => { setImportMode('single'); setErrorMsg(''); }} className={`pb-2 text-xs font-semibold border-b-2 ${importMode === 'single' ? 'border-[#8E9F8B] text-[#4D5E4A]' : 'border-transparent text-[#7A7367]'}`}>单个链接</button>
              <button type="button" onClick={() => { setImportMode('batch'); setErrorMsg(''); }} className={`pb-2 text-xs font-semibold border-b-2 ${importMode === 'batch' ? 'border-[#8E9F8B] text-[#4D5E4A]' : 'border-transparent text-[#7A7367]'}`}>批量导入链接</button>
            </div>
            {importMode === 'batch' ? <form onSubmit={e => { e.preventDefault(); void handleBatchImport(); }} className="flex flex-col gap-4">
              <p className="text-xs text-[#7A7367] leading-relaxed">每行一个项目：填写“备注名  链接”或只填写链接。备注可含空格；只有链接时备注留空。统一拉取仓库默认主分支（main、master 等），忽略链接中的分支。备注和描述可稍后修改。</p>
              <textarea aria-label="批量仓库链接" required rows={6} value={batchLinks} onChange={e => { setBatchLinks(e.target.value); setImportResults([]); }} placeholder={'项目备注  https://github.com/owner/repo\nhttps://github.com/owner/another-repo'} className="w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]" />
              <label className="text-xs text-[#474239]">GitHub Token（可选，留空使用全局设置）<input type="password" aria-label="批量导入 Token" value={tokenInput} onChange={e => setTokenInput(e.target.value)} className="mt-1 w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27]" /></label>
              {errorMsg && <p role="alert" className="text-xs text-[#8C5D54]">{errorMsg}</p>}
              {importResults.length > 0 && <div className="max-h-48 overflow-y-auto flex flex-col gap-2">
                <p role="status" className="text-xs text-[#5D6F5A]">成功 {importResults.filter(item => item.status === 'success').length} · 跳过 {importResults.filter(item => item.status === 'skipped').length} · 失败 {importResults.filter(item => item.status === 'error').length}</p>
                {importResults.map((item, i) => <div key={i} className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl p-2 text-xs break-all"><span className="font-mono">{item.input}</span><p className={item.status === 'error' ? 'text-[#8C5D54]' : 'text-[#5D6F5A]'}>{item.message || '等待中'}</p></div>)}
              </div>}
              <div className="flex flex-row flex-wrap justify-end gap-3 pt-3 border-t border-[#EDE7DF]">
                <button type="button" onClick={() => setIsAddModalOpen(false)} className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs">关闭</button>
                {importResults.some(item => item.status === 'error' && item.url) && <button type="button" onClick={() => handleBatchImport(true)} className="px-3 py-2 text-xs text-[#5D6F5A]">重试失败链接</button>}
                <button type="submit" className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold">开始批量导入</button>
              </div>
            </form> : (
            <form onSubmit={handleAddRepo} className="flex flex-col gap-4">
              {errorMsg && (
                <div className="bg-[#B6847A]/15 border border-[#B6847A]/30 text-[#8C5D54] p-3 rounded-xl text-xs flex flex-row items-start gap-2 overflow-hidden max-w-full">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="flex flex-col gap-1 w-full overflow-hidden">
                    <span className="font-semibold">拉取项目失败提示：</span>
                    <span className="break-all whitespace-pre-wrap">{errorMsg}</span>
                    <span className="text-[11px] text-[#7A7367] mt-0.5 leading-relaxed break-words">
                      支持格式：1. 完整链接（如 https://github.com/owner/repo 或带 .git 的完整地址）；2. 简写（如 owner/repo）；3. 带有分支的链接。若为私有仓库请填写 Token。
                    </span>
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#474239]">GitHub 仓库地址 (URL) *</label>
                <input
                  type="text"
                  placeholder="https://github.com/owner/repo 或 https://github.com/owner/repo.git 或 owner/repo"
                  value={repoUrl}
                  onChange={e => { branchLookup.current?.abort(); branchLookupId.current++; setRepoUrl(e.target.value); setBranchInput(''); }}
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
                  <div className="flex flex-row items-center justify-between whitespace-nowrap">
                    <label className="text-xs font-semibold text-[#474239]">拉取分支</label>
                    <button
                      type="button"
                      onClick={handleFetchBranches}
                      disabled={isLoadingBranches}
                      className="text-[10px] text-[#5D6F5A] hover:underline font-medium shrink-0 flex items-center gap-1"
                    >
                      {isLoadingBranches ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitBranch className="w-3 h-3" />}
                      <span>{isLoadingBranches ? '正在获取分支…' : '获取全部分支'}</span>
                    </button>
                  </div>
                  {branchError && <p role="alert" className="text-[11px] text-[#8C5D54] break-words">{branchError}</p>}
                  {availableBranches.length > 0 && <p role="status" className="text-[10px] text-[#7A7367]">已获取 {availableBranches.length} 个分支，请在下方选择</p>}
                  {availableBranches.length > 0 ? (
                    <select
                      value={branchInput}
                      onChange={e => setBranchInput(e.target.value)}
                      className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]"
                    >
                      {availableBranches.map(b => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      placeholder="留空自动识别（支持链接指定分支）"
                      value={branchInput}
                      onChange={e => setBranchInput(e.target.value)}
                      className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] placeholder-[#91887C] focus:outline-none focus:border-[#8E9F8B]"
                    />
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">专属 Token (完全可选)</label>
                  <input
                    type="password"
                    placeholder="公开仓库无需填写"
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
            </form>)}
          </div>
        </div>
      )}

      {/* ================= MODAL 2: PROJECT SYNC: PRIVATE REPO VS FORK ================= */}
      {isSingleUploadModalOpen && singleUploadTargetRepo && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-lg w-full p-6 shadow-xl flex flex-col gap-5 max-h-[90vh] overflow-hidden">
            <div className="flex flex-row items-center justify-between border-b border-[#EDE7DF] pb-4 whitespace-nowrap">
              <h3 className="text-base font-bold font-serif text-[#2B2723] flex flex-row items-center gap-2">
                <GitBranch className="w-5 h-5 text-[#8E9F8B] shrink-0" />
                <span>项目分叉与私有仓库中心</span>
              </h3>
              <button onClick={() => setIsSingleUploadModalOpen(false)} className="text-[#91887C] hover:text-[#2E2B27]">
                <X className="w-5 h-5" />
              </button>
            </div>

            {projectTargets(singleUploadTargetRepo).length > 0 && <div className="flex flex-col gap-2">
              {targetWarning(singleUploadTargetRepo)}
              <button type="button" onClick={() => openTargetManager(singleUploadTargetRepo)} className="self-start text-xs text-[#5D6F5A] hover:underline">管理远端目标</button>
            </div>}

            {/* Tabs */}
            <div className="flex flex-row border-b border-[#EDE7DF] gap-4 whitespace-nowrap overflow-x-auto">
              <button
                type="button"
                onClick={() => setProjectSyncTab('privateRepo')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  projectSyncTab === 'privateRepo' ? 'border-[#8E9F8B] text-[#4D5E4A]' : 'border-transparent text-[#7A7367]'
                }`}
              >
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>板块一：创建私人仓库上传</span>
              </button>
              <button
                type="button"
                onClick={() => setProjectSyncTab('fork')}
                className={`pb-2.5 text-xs font-semibold flex flex-row items-center gap-1.5 border-b-2 transition whitespace-nowrap shrink-0 ${
                  projectSyncTab === 'fork' ? 'border-[#8E9F8B] text-[#4D5E4A]' : 'border-transparent text-[#7A7367]'
                }`}
              >
                <GitBranch className="w-4 h-4 shrink-0" />
                <span>板块二：创建分叉与上游同步</span>
              </button>
            </div>

            {projectSyncTab === 'privateRepo' ? (
              <form onSubmit={handleExecuteSingleUploadToPrivate} className="flex flex-col gap-4 overflow-y-auto pr-1">
                <div className="bg-[#FAF8F5] p-3.5 rounded-xl border border-[#DFD8CE] text-xs text-[#2E2B27] flex flex-col gap-1.5">
                  <div className="flex flex-row items-center justify-between">
                    <span className="font-semibold text-[#2B2723]">当前项目:</span>
                    <span className="font-mono text-[#5D6F5A] font-bold">{singleUploadTargetRepo.owner}/{singleUploadTargetRepo.repo}</span>
                  </div>
                  <div className="flex flex-row items-center justify-between text-[#7A7367]">
                    <span>目标账号:</span>
                    <span className="font-semibold text-[#2B2723]">@{userProfile?.login || '您的 GitHub 授权账号'}</span>
                  </div>
                  {singleUploadTargetRepo.uploadTarget && <p className="text-xs text-[#5D6F5A]">已绑定：{singleUploadTargetRepo.uploadTarget.owner}/{singleUploadTargetRepo.uploadTarget.repo} · {singleUploadTargetRepo.uploadTarget.branch}</p>}
                  <p className="text-[11px] text-[#7A7367] leading-relaxed">
                    首次上传使用名为 <code>{singleUploadRepoName}</code> 的私人仓库并写入当前来源分支；切换分支后上传到对应分支，每次提交保留历史，名称仅通过“修改项目名称”按钮更改。
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">目标仓库名称（首次上传确定，之后固定使用）</label>
                  <input
                    type="text"
                    value={singleUploadRepoName}
                    readOnly={!!singleUploadTargetRepo.uploadTarget || !!singleUploadTargetRepo.privateRepoUrl}
                    onChange={e => setSingleUploadRepoName(e.target.value)}
                    required
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B] font-mono"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  {(singleUploadTargetRepo.uploadTarget || singleUploadTargetRepo.privateRepoUrl) && <button type="button" onClick={() => handleRenameTarget(singleUploadTargetRepo)} className="text-xs text-[#5D6F5A] hover:underline">修改项目名称</button>}
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
                    {isUploadingToPrivate ? '正在验证上传...' : singleUploadTargetRepo.uploadTarget || singleUploadTargetRepo.privateRepoUrl ? '更新已绑定仓库（保留历史）' : '立即新建私人仓库并上传'}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleExecuteCreateFork} className="flex flex-col gap-4 overflow-y-auto pr-1">
                <div className="bg-[#FAF8F5] p-3.5 rounded-xl border border-[#DFD8CE] text-xs text-[#2E2B27] flex flex-col gap-1.5">
                  <div className="flex flex-row items-center justify-between">
                    <span className="font-semibold text-[#2B2723]">目标源项目:</span>
                    <span className="font-mono text-[#5D6F5A] font-bold">{singleUploadTargetRepo.owner}/{singleUploadTargetRepo.repo}</span>
                  </div>
                  <div className="flex flex-row items-center justify-between text-[#7A7367]">
                    <span>目标账号:</span>
                    <span className="font-semibold text-[#2B2723]">@{userProfile?.login || '您的 GitHub 授权账号'}</span>
                  </div>
                  <p className="text-[11px] text-[#7A7367] leading-relaxed">
                    当前分支模式使用已下载的准确版本创建独立副本；完整模式直接 Fork 最初来源仓库的全部分支与历史。完成后自动加入我的项目，原本地项目继续保留。
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">保存范围</label>
                  <select value={forkScope} onChange={e => { const scope = e.target.value as 'current' | 'full'; setForkScope(scope); setForkRepoName(scope === 'full' ? sourceOf(singleUploadTargetRepo).repo : `${sourceOf(singleUploadTargetRepo).repo}-${sourceOf(singleUploadTargetRepo).branch.replace(/[^a-zA-Z0-9._-]/g, '-')}`); }} className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]">
                    <option value="current">当前分支独立副本（{sourceOf(singleUploadTargetRepo).branch}）</option><option value="full">完整源项目 Fork（全部分支与历史）</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-[#474239]">副本 / 完整分叉的仓库名称</label>
                  <input
                    type="text"
                    value={forkRepoName}
                    onChange={e => setForkRepoName(e.target.value)}
                    placeholder={singleUploadTargetRepo.repo}
                    className="bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B] font-mono"
                  />
                </div>

                {forkScope === 'current' && <label className="flex items-center gap-2 text-xs text-[#524D44]"><input type="checkbox" checked={singleUploadPurgeCache} onChange={e => setSingleUploadPurgeCache(e.target.checked)} />上传验证成功后清理本地源码，保留快照</label>}
                <div className="bg-[#FAF8F5] p-3 rounded-xl border border-[#DFD8CE] text-[11px] text-[#6B6358] leading-relaxed">
                  💡 <strong>分叉与同步说明</strong>：创建分叉后，您可以在项目工作台中随时点击“同步上游”按钮，自动拉取并合并上游项目的最新提交。
                </div>

                <div className="flex flex-row items-center justify-end gap-3 pt-3 border-t border-[#EDE7DF] whitespace-nowrap">
                  <button type="button" onClick={() => setIsSingleUploadModalOpen(false)} className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium whitespace-nowrap shrink-0">取消</button>
                  <button type="submit" disabled={isForking} className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs whitespace-nowrap shrink-0">
                    {isForking ? '正在创建并验证...' : forkScope === 'full' ? '完整分叉并加入我的项目' : '保存当前分支并加入我的项目'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {batchTask && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-label={batchTask === 'fork' ? '批量分叉' : batchTask === 'update' ? '批量更新' : '批量分叉同步'} className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-xl w-full p-5 shadow-xl flex flex-col gap-4">
            <h3 className="text-base font-bold font-serif text-[#2B2723]">{batchTask === 'fork' ? '批量分叉' : batchTask === 'update' ? '批量更新' : '批量分叉同步'} · {batchTaskItems.length} 个项目</h3>
            <p className="text-xs text-[#7A7367]">{batchTask === 'fork' ? '选择分叉范围，可分别修改目标名称。成功后加入我的项目，原记录保留。' : batchTask === 'update' ? '逐项检查最新版本，有变化时归档旧版并下载；已绑定仓库将更新对应分支，保留历史。' : '同步已记录的分叉目标；当前分支副本按原始来源更新，完整分叉同步全部上游分支。'} 单个失败会继续处理，完成后可仅重试失败项目。</p>
            {batchTask === 'fork' && <>
              <label className="text-xs text-[#474239]">分叉范围<select aria-label="批量分叉范围" disabled={batchTaskRunning || batchTaskItems.some(item => item.status !== 'pending')} value={batchForkScope} onChange={e => {
                const scope = e.target.value as 'current' | 'full'; setBatchForkScope(scope);
                setBatchTaskItems(items => items.map(item => { const repo = reposRef.current.find(repo => repo.id === item.id); return { ...item, name: repo ? suggestedCopyName(repo, scope) : item.name }; }));
              }} className="mt-1 w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-3 py-2 text-xs"><option value="full">完整来源仓库（全部分支与历史）</option><option value="current">当前分支独立私人副本</option></select></label>
              <label className="text-xs text-[#554F45] flex gap-2 items-start"><input type="checkbox" checked={batchForkPurge} disabled={batchTaskRunning || batchForkScope === 'full'} onChange={e => setBatchForkPurge(e.target.checked)} />当前分支副本上传验证成功后清理源码缓存，保留快照</label>
            </>}
            <label className="text-xs text-[#474239]">共用 GitHub Token（可选，留空使用项目或全局设置）<input type="password" aria-label="批量操作 Token" disabled={batchTaskRunning} value={batchTaskToken} onChange={e => setBatchTaskToken(e.target.value)} className="mt-1 w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-3 py-2 text-xs" /></label>
            <p role="status" aria-live="polite" className="text-xs text-[#5D6F5A]">成功 {batchTaskItems.filter(item => item.status === 'success').length} · 失败 {batchTaskItems.filter(item => item.status === 'error').length} · 跳过 {batchTaskItems.filter(item => item.status === 'skipped').length} · 取消 {batchTaskItems.filter(item => item.status === 'cancelled').length}</p>
            {batchTaskRunning && <p className="text-xs text-[#7A7367]">{loadingText}</p>}
            <div className="batch-results">
              {batchTaskItems.map((item, index) => <div key={item.id} className="batch-result text-xs">
                <p className="font-mono text-[#2B2723]">{item.label}</p>
                {batchTask === 'fork' && <label className="block mt-1 text-[#7A7367]">目标名称<input aria-label={`目标名称 ${index + 1}`} value={item.name} disabled={batchTaskRunning || item.status === 'success' || item.status === 'skipped'} onChange={e => setBatchTaskItems(items => items.map((old, i) => i === index ? { ...old, name: e.target.value } : old))} className="mt-1 w-full bg-[#FFFFFF] border border-[#DFD8CE] rounded-lg px-2 py-1.5 font-mono text-xs" /></label>}
                <p className={`mt-1 whitespace-pre-wrap ${item.status === 'error' ? 'text-[#8C5D54]' : 'text-[#5D6F5A]'}`}>{item.message || '等待开始'}</p>
              </div>)}
            </div>
            <div className="flex flex-row flex-wrap justify-end gap-2 border-t border-[#EDE7DF] pt-3">
              <button type="button" disabled={batchTaskRunning} onClick={() => setBatchTask(null)} className="px-3 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs disabled:opacity-40">关闭</button>
              {batchTaskRunning ? <button type="button" onClick={cancelGithubOperation} className="px-3 py-2 text-[#8C5D54] border border-[#DFD8CE] rounded-xl text-xs">取消剩余操作</button> : <>
                {batchTaskItems.some(item => item.status === 'error' || item.status === 'cancelled') && <button type="button" onClick={() => startProjectBatch(true)} className="px-3 py-2 text-[#5D6F5A] border border-[#DFD8CE] rounded-xl text-xs">重试失败项目</button>}
                <button type="button" disabled={!batchTaskItems.some(item => item.status === 'pending')} onClick={() => startProjectBatch()} className="px-4 py-2 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs disabled:opacity-40">{batchTask === 'fork' ? '开始批量分叉' : batchTask === 'update' ? '开始批量更新' : '开始批量同步'}</button>
              </>}
            </div>
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
                已绑定项目沿用固定仓库名称和分支并保留历史；首次上传的项目会在您的 GitHub 账号 (@{userProfile?.login || '您的账号'}) 下创建私人仓库。
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
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" /> 正在确认目标...
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

      {isPushModalOpen && activeRepo && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-xl w-full p-6 shadow-xl flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-[#EDE7DF] pb-4">
              <h3 className="text-base font-bold font-serif text-[#2B2723]">上传指定仓库</h3>
              <button type="button" onClick={() => setIsPushModalOpen(false)} className="text-[#91887C] hover:text-[#2E2B27]"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handlePushProjectToGitHub} className="flex flex-col gap-4">
              <p className="text-xs text-[#7A7367]">上传版本：{(pushBackupTarget?.commitSha || activeRepo.latestCommitSha).slice(0, 12)}。目标分支会同步为该版本的完整文件，包括删除的文件。</p>
              <label className="text-xs font-semibold text-[#474239]">目标仓库
                <input required readOnly={!!activeRepo.uploadTarget && !pushCopyMode} value={pushTargetRepo} onChange={e => setPushTargetRepo(e.target.value)} placeholder="owner/repo" className="mt-1 w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]" />
              </label>
              {activeRepo.uploadTarget && <button type="button" onClick={() => { setPushCopyMode(true); setPushTargetRepo(''); setPushTargetBranch(pushBackupTarget?.branch || sourceOf(activeRepo).branch); }} className="text-xs text-[#5D6F5A] hover:underline">另存副本到其他仓库（不改变原绑定）</button>}
              <label className="text-xs font-semibold text-[#474239]">目标分支
                <input readOnly={!!activeRepo.uploadTarget && !pushCopyMode} value={pushTargetBranch} onChange={e => setPushTargetBranch(e.target.value)} placeholder="留空使用当前来源分支" className="mt-1 w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]" />
              </label>
              <label className="text-xs font-semibold text-[#474239]">提交说明
                <input value={pushCommitMsg} onChange={e => setPushCommitMsg(e.target.value)} className="mt-1 w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]" />
              </label>
              <label className="text-xs font-semibold text-[#474239]">上传 Token（留空使用项目或全局 Token）
                <input type="password" value={pushToken} onChange={e => setPushToken(e.target.value)} className="mt-1 w-full bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-4 py-2.5 text-xs text-[#2E2B27] focus:outline-none focus:border-[#8E9F8B]" />
              </label>
              <label className="flex items-center gap-2 text-xs text-[#474239]"><input type="checkbox" checked={purgePushCacheOption} onChange={e => setPurgePushCacheOption(e.target.checked)} className="accent-[#8E9F8B]" />上传验证成功后清理对应版本的本地源码，保留快照</label>
              <div className="flex justify-end gap-3 pt-3 border-t border-[#EDE7DF]">
                <button type="button" onClick={() => setIsPushModalOpen(false)} className="px-4 py-2 bg-[#EFECE6] text-[#554F45] rounded-xl text-xs font-medium">取消</button>
                <button type="submit" className="px-5 py-2.5 bg-gradient-to-r from-[#7E937F] to-[#8E9F8B] text-white rounded-xl text-xs font-semibold shadow-xs">确认上传</button>
              </div>
            </form>
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

      {isDiffModalOpen && diffBackupTarget && activeRepo && (
        <div className="fixed inset-0 bg-[#33302C]/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl max-w-xl w-full p-6 shadow-xl flex flex-col gap-4 max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between"><h3 className="text-base font-bold font-serif text-[#2B2723]">版本文件对比</h3><button onClick={() => setIsDiffModalOpen(false)} className="text-[#91887C]"><X className="w-5 h-5" /></button></div>
            {Object.entries(computeDiff(diffBackupTarget, activeRepo.tree)).map(([kind, paths]) => <div key={kind} className="text-xs text-[#474239]"><strong>{kind === 'added' ? '新增' : kind === 'removed' ? '删除' : '修改'}：{paths.length}</strong><p className="whitespace-pre-wrap font-mono mt-1">{paths.join('\n') || '无'}</p></div>)}
          </div>
        </div>
      )}

      {/* Global Async Loading Modal */}
      {isLoading && (
        <div className="fixed inset-0 bg-[#33302C]/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFFFF] border border-[#E2DBD0] rounded-3xl p-6 shadow-xl flex flex-row items-center gap-3.5 max-w-sm w-full whitespace-nowrap">
            <Loader2 className="w-6 h-6 text-[#8E9F8B] animate-spin shrink-0" />
            <span className="text-xs font-medium text-[#2E2B27] truncate" title={loadingText}>{loadingText}</span>
            <button type="button" onClick={cancelGithubOperation} className="text-xs text-[#8C5D54] shrink-0 hover:underline">取消</button>
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
