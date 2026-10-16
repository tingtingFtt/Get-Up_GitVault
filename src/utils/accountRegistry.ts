import { githubApi, GitHubError, operationSignal, parseRepository } from './githubClient';
import type { ProjectSource } from './projectModel';
import type { TargetIdentity } from './targetLifecycle';

export const REGISTRY_REPO = '.gitvault-state';
const MARKER = 'GitVault account sync registry v1';
const FILE = 'gitvault.json';
const report = (message: string) => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gitvault-progress', {detail:message})); };
export interface AccountProject {
  source: ProjectSource; target: TargetIdentity;
  kind: 'upload' | 'current' | 'full'; state: 'reserved' | 'active';
  createdByApp: boolean; reservationId?: string; branches?: string[];
  bindings: Record<string, { branch: string; sourceSha?: string; commitSha?: string; updatedAt: string }>;
  updatedAt: string;
}
interface RegistryDocument { app: 'Get-Up_GitVault'; version: 1; account: string; projects: AccountProject[] }
export function sameSource(a: ProjectSource, b: ProjectSource) {
  return a.repositoryId && b.repositoryId ? a.repositoryId === b.repositoryId : a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}
const encode = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2)); let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const decode = (content: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\s/g, '')), char => char.charCodeAt(0))));
const init = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const missing = (error: unknown) => error instanceof GitHubError && error.status === 404;
const validName = (value: unknown) => typeof value === 'string' && /^[\w.-]+$/.test(value);
function cleanProject(project: AccountProject): AccountProject {
  return { source: { owner: project.source.owner, repo: project.source.repo, url: `https://github.com/${project.source.owner}/${project.source.repo}`, branch: project.source.branch, repositoryId: project.source.repositoryId }, target: { id: project.target.id, owner: project.target.owner, repo: project.target.repo }, kind: project.kind, state: project.state, createdByApp: !!project.createdByApp, reservationId: project.reservationId, branches: project.branches?.filter(branch => typeof branch === 'string'), bindings: Object.fromEntries(Object.entries(project.bindings).map(([branch, binding]) => [branch, { branch: binding.branch, sourceSha: binding.sourceSha, commitSha: binding.commitSha, updatedAt: binding.updatedAt }])), updatedAt: project.updatedAt };
}
export class ExistingSourceError extends Error {
  constructor(public existing: AccountProject) { super(`账号已有同源目标 ${existing.target.owner}/${existing.target.repo}，请使用更新／同步，不可重复首次上传或分叉。`); }
}
function validateDocument(value: any, login: string): RegistryDocument {
  if (value?.app !== 'Get-Up_GitVault' || value.version !== 1 || value.account?.toLowerCase() !== login.toLowerCase() || !Array.isArray(value.projects)) throw new Error('账号记录格式或所属账号不符，已停止操作，未覆盖记录仓库');
  for (const project of value.projects) {
    if (typeof project.source?.branch !== 'string' || !project.source.branch || !validName(project.source?.owner) || !validName(project.source?.repo) || !validName(project.target?.owner) || !validName(project.target?.repo) || project.target.repo.toLowerCase() === REGISTRY_REPO || !['upload', 'current', 'full'].includes(project.kind) || !['active', 'reserved'].includes(project.state) || !project.bindings || typeof project.bindings !== 'object' || Array.isArray(project.bindings)) throw new Error('账号记录包含无效项目，已停止操作');
    if (project.source.repositoryId !== undefined && (!Number.isSafeInteger(project.source.repositoryId) || project.source.repositoryId <= 0)) throw new Error('账号记录来源仓库 ID 无效');
    if (project.state === 'active' && (!Number.isSafeInteger(project.target.id) || project.target.id <= 0)) throw new Error('账号记录缺少目标仓库 ID，不能自动绑定');
    for (const binding of Object.values(project.bindings) as any[]) if (!binding || typeof binding.branch !== 'string' || !binding.branch) throw new Error('账号记录包含无效分支映射');
    const bindings = Object.entries(project.bindings) as [string, {branch:string}][];
    if (bindings.some(([branch, binding]) => bindings.some(([other, candidate]) => other !== branch && binding.branch === candidate.branch))) throw new Error('账号记录的多个来源分支映射到同一目标分支，已停止操作');
    project.source.url = `https://github.com/${project.source.owner}/${project.source.repo}`;
  }
  return { app: 'Get-Up_GitVault', version: 1, account: login, projects: value.projects.map(cleanProject) };
}

/** Only account bindings and receipts are stored remotely; never tokens or project file bytes. */
export function createAccountRegistry(api = githubApi) {
  const ownedCache = new Map<string, { at: number; projects: any[] }>();
  const parentCache = new Map<string, { at: number; meta: any }>();
  const provenanceCache = new Map<string, { at: number; sources: Array<{owner:string;repo:string}> }>();
  const read = async (token: string, signal = operationSignal(), create = false) => {
    if (!token) throw new Error('跨设备识别需要 GitHub Token，请在设置中填写可访问账号仓库的凭证');
    const user = await api('/user', token, {}, signal);
    if (!validName(user.login)) throw new Error('无法识别当前 GitHub 账号');
    const root = `/repos/${user.login}/${REGISTRY_REPO}`;
    let meta: any;
    try { meta = await api(root, token, { cache: 'no-store' }, signal); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!create) return { login: user.login as string, root, meta: undefined, sha: undefined as string | undefined, document: { app: 'Get-Up_GitVault', version: 1, account: user.login, projects: [] } as RegistryDocument };
      try { meta = await api('/user/repos', token, init('POST', { name: REGISTRY_REPO, description: MARKER, private: true, auto_init: true }), signal); }
      catch (creationError) { if (!(creationError instanceof GitHubError) || ![409, 422].includes(creationError.status)) throw creationError; meta = await api(root, token, { cache: 'no-store' }, signal); }
    }
    if (!meta.private || meta.owner?.login?.toLowerCase() !== user.login.toLowerCase()) throw new Error('跨设备记录仓库必须属于当前账号且为私有仓库，未写入任何记录');
    let file: any;
    try { file = await api(`${root}/contents/${FILE}?ref=${encodeURIComponent(meta.default_branch || 'main')}`, token, { cache: 'no-store' }, signal); }
    catch (error) { if (!missing(error)) throw error; if (meta.description !== MARKER) throw new Error(`私人仓库 ${REGISTRY_REPO} 已被其他用途占用，请更名后重试，未覆盖文件`); }
    if (file && (file.encoding !== 'base64' || !file.content || file.size > 1000000)) throw new Error('跨设备记录文件过大或不可读取，未将其当作空记录');
    const document = file ? validateDocument(decode(file.content), user.login) : { app: 'Get-Up_GitVault', version: 1, account: user.login, projects: [] } as RegistryDocument;
    return { login: user.login as string, root, meta, sha: file?.sha as string | undefined, document };
  };
  const change = async (token: string, edit: (document: RegistryDocument, login: string) => RegistryDocument, signal = operationSignal()) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      report('正在保存并验证账号来源与分支记录…');
      const current = await read(token, signal, true), document = validateDocument(edit(current.document, current.login), current.login);
      try {
        await api(`${current.root}/contents/${FILE}`, token, init('PUT', { message: 'Update GitVault account bindings', content: encode(document), branch: current.meta.default_branch || 'main', ...(current.sha ? { sha: current.sha } : {}) }), signal);
        // Read back to verify the registry write; a lost response is retried by a later sync.
        const verified = await read(token, signal);
        if (JSON.stringify(verified.document) !== JSON.stringify(document)) throw new GitHubError('账号记录在验证时发生变化，请重试合并', 409);
        return verified.document;
      } catch (error) { if (!(error instanceof GitHubError) || ![409, 422].includes(error.status) || attempt === 3) throw error; }
    }
    throw new Error('账号记录并发写入冲突，请稍后重试');
  };
  const save = async (project: AccountProject, token: string, signal = operationSignal()) => change(token, document => {
    const old = document.projects.find(item => sameSource(item.source, project.source));
    if (old && (old.target.id && project.target.id ? old.target.id !== project.target.id : old.target.owner.toLowerCase() !== project.target.owner.toLowerCase() || old.target.repo.toLowerCase() !== project.target.repo.toLowerCase())) throw new ExistingSourceError(old);
    if (document.projects.some(item => !sameSource(item.source, project.source) && (item.target.id && project.target.id ? item.target.id === project.target.id : item.target.owner.toLowerCase() === project.target.owner.toLowerCase() && item.target.repo.toLowerCase() === project.target.repo.toLowerCase()))) throw new Error('该目标已固定其他来源，不能覆盖');
    const bindings = { ...old?.bindings };
    for (const [branch, binding] of Object.entries(project.bindings)) {
      const previous = bindings[branch];
      if (old?.state === 'active' && previous && previous.branch !== binding.branch) throw new Error(`来源分支 ${branch} 已固定目标分支 ${previous.branch}，不能改写其他映射`);
      bindings[branch] = { ...previous, ...binding, sourceSha: binding.sourceSha || previous?.sourceSha, commitSha: binding.commitSha || previous?.commitSha };
    }
    const merged = { ...old, ...project, kind: old?.kind === 'full' ? 'full' as const : project.kind, branches: project.branches || old?.branches, createdByApp: !!old?.createdByApp || project.createdByApp, bindings };
    return { ...document, projects: [...document.projects.filter(item => !sameSource(item.source, project.source)), merged] };
  }, signal);
  const reserve = async (source: ProjectSource, name: string, kind: AccountProject['kind'], token: string, signal = operationSignal(), explicit?: TargetIdentity) => {
    if (!validName(name) || name.length > 100 || /^\.+$/.test(name) || name.toLowerCase() === REGISTRY_REPO) throw new Error('目标名称无效或属于跨设备记录仓库，请使用其他名称');
    let selected!: AccountProject;
    await change(token, (document, login) => {
      const old = document.projects.find(item => sameSource(item.source, source));
      if (old) throw new ExistingSourceError(old);
      const targetOwner = explicit?.owner || login;
      if (document.projects.some(item => item.target.owner.toLowerCase() === targetOwner.toLowerCase() && item.target.repo.toLowerCase() === name.toLowerCase())) throw new Error('该目标名称已绑定其他来源，请先比较项目，不能覆盖其他来源');
      selected = { source, target: explicit ? { id: explicit.id, owner: explicit.owner, repo: explicit.repo } : { owner: login, repo: name }, kind, state: 'reserved', createdByApp: true, reservationId: crypto.randomUUID(), bindings: { [source.branch]: { branch: source.branch, updatedAt: new Date().toISOString() } }, updatedAt: new Date().toISOString() };
      return { ...document, projects: [...document.projects, selected] };
    }, signal);
    return selected;
  };
  const remove = async (target: TargetIdentity, token: string, signal = operationSignal()) => {
    const current = await read(token, signal);
    if (!current.meta) return current.document;
    return change(token, document => ({ ...document, projects: document.projects.filter(item => target.id && item.target.id ? item.target.id !== target.id : item.target.owner.toLowerCase() !== target.owner.toLowerCase() || item.target.repo.toLowerCase() !== target.repo.toLowerCase()) }), signal);
  };
  const candidates = async (source: ProjectSource, token: string, signal = operationSignal()) => {
    report('正在读取账号来源记录，识别已有上传与分叉…');
    const account = await read(token, signal);
    let recorded = account.document.projects.filter(item => sameSource(item.source, source));
    if (!recorded.length) recorded = account.document.projects.filter(item => source.repositoryId && item.target.id ? source.repositoryId === item.target.id : item.target.owner.toLowerCase() === source.owner.toLowerCase() && item.target.repo.toLowerCase() === source.repo.toLowerCase());
    if (recorded.length) return { login: account.login, recorded, legacy: [] as AccountProject[] };
    let owned = ownedCache.get(token)?.projects;
    if (!owned || Date.now() - ownedCache.get(token)!.at > 60000) {
      owned = [];
      for (let page = 1; page <= 50; page++) {
        report(`正在发现旧版同源目标：读取账号仓库第 ${page} 页…`);
        const list = await api(`/user/repos?affiliation=owner&per_page=100&page=${page}`, token, { cache: 'no-store' }, signal);
        if (!Array.isArray(list)) throw new Error('账号仓库列表读取失败，不能确认没有同源项目');
        owned.push(...list.filter(item => item.owner?.login?.toLowerCase() === account.login.toLowerCase() && item.name !== REGISTRY_REPO));
        if (list.length < 100) break;
        if (page === 50) throw new Error('账号仓库列表未遍历完整，请先导入已有目标比较，未创建重复项目');
      }
      ownedCache.set(token, { at: Date.now(), projects: owned });
    }
    const legacy: AccountProject[] = [];
    let checked = 0;
    for (const repo of owned) {
      signal.throwIfAborted();
      report(`正在核对已有仓库来源 ${++checked}/${owned.length}…`);
      if (repo.id === source.repositoryId || repo.owner?.login?.toLowerCase() === source.owner.toLowerCase() && repo.name.toLowerCase() === source.repo.toLowerCase()) continue;
      let match = repo.name.toLowerCase() === source.repo.toLowerCase(), full = false;
      if (repo.fork) {
        const key = `${token}:${repo.id || `${repo.owner.login}/${repo.name}`}`;
        let meta = parentCache.get(key)?.meta;
        if (!meta || Date.now() - parentCache.get(key)!.at > 60000) { meta = await api(`/repos/${repo.owner.login}/${repo.name}`, token, { cache: 'no-store' }, signal); parentCache.set(key, {at: Date.now(), meta}); }
        full = !!meta.parent && (source.repositoryId ? meta.parent.id === source.repositoryId : meta.parent.full_name?.toLowerCase() === `${source.owner}/${source.repo}`.toLowerCase());
        match ||= full;
      }
      if (!match && repo.description?.includes('[GitVault 托管]')) {
        const key = `${token}:${repo.id || `${repo.owner.login}/${repo.name}`}`;
        let provenance = provenanceCache.get(key);
        if (!provenance || Date.now() - provenance.at > 60000) {
          const root = `/repos/${repo.owner.login}/${repo.name}`, sources: Array<{owner:string;repo:string}> = [];
          const branches: string[] = [];
          for (let page = 1; page <= 50; page++) {
            const list = await api(`${root}/branches?per_page=100&page=${page}`, token, {}, signal);
            if (!Array.isArray(list)) throw new Error('旧版托管仓库分支读取失败，未创建重复项目');
            branches.push(...list.map(item => item.name)); if (list.length < 100) break;
            if (page === 50) throw new Error('旧版托管仓库分支未完整遍历');
          }
          for (const branch of branches) {
            try {
              const file = await api(`${root}/contents/GITVAULT_METADATA.md?ref=${encodeURIComponent(branch)}`, token, {}, signal);
              if (file.encoding !== 'base64' || file.size > 64000) continue;
              const text = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), char => char.charCodeAt(0)));
              for (const line of text.split(/\r?\n/)) { try { sources.push(parseRepository(line.trim())); } catch { /* only source links */ } }
            } catch (error) { if (!missing(error)) throw error; }
          }
          provenance = { at: Date.now(), sources }; provenanceCache.set(key, provenance);
        }
        match = !provenance.sources.length || provenance.sources.some(item => item.owner.toLowerCase() === source.owner.toLowerCase() && item.repo.toLowerCase() === source.repo.toLowerCase());
      }
      if (match) legacy.push({ source, target: { id: repo.id, owner: repo.owner.login, repo: repo.name }, kind: full ? 'full' : 'upload', state: 'active', createdByApp: false, bindings: { [source.branch]: { branch: source.branch, updatedAt: '' } }, updatedAt: '' });
    }
    return { login: account.login, recorded: [], legacy };
  };
  return { read, save, reserve, remove, candidates, invalidate: () => { ownedCache.clear(); parentCache.clear(); provenanceCache.clear(); } };
}
export const accountRegistry = createAccountRegistry();
