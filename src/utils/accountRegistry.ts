import { scanAccountDiscovery,discoveryStore,type DiscoveryRow } from './accountDiscovery';
import { readMetadataSource } from './projectProvenance';
import { githubApi, GitHubError, operationSignal } from './githubClient';
import type { ProjectSource } from './projectModel';
import type { TargetIdentity } from './targetLifecycle';

export const REGISTRY_REPO = '.gitvault-state';
const MARKER = 'GitVault account sync registry v1';
const FILE = 'gitvault.json';
const accountWrites = new Map<string, Promise<void>>();
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function retryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(2000, 250 * 2 ** attempt) + Math.random() * 150);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export class AccountRecordPendingError extends Error {
  constructor(cause: unknown) {
    super(`项目已在 GitHub 保存，但跨设备记录尚未完成；本地缓存和固定目标已保留，请使用更新／同步重试，不能重复创建：${(cause as Error).message}`, { cause });
  }
}
const report = (message: string) => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gitvault-progress', {detail:message})); };
export interface TargetHistory { target: TargetIdentity; kind: 'upload' | 'current' | 'full'; bindings: AccountProject['bindings']; changedAt: string }
export interface AccountProject {
  source: ProjectSource; target: TargetIdentity;
  discovery?: { kind: 'name' | 'fork' | 'metadata' | 'search'; source?: {owner:string;repo:string}; branches?: string[]; fork?:boolean };
  kind: 'upload' | 'current' | 'full'; state: 'reserved' | 'active';
  createdByApp: boolean; reservationId?: string; branches?: string[];
  bindings: Record<string, { branch: string; sourceSha?: string; commitSha?: string; updatedAt: string }>;
  updatedAt: string;
  primary?: boolean; profile?: { tags: string[]; remark: string; description: string; updatedAt: string };
  history?: TargetHistory[];
  switchReservation?: { id: string; from?: TargetIdentity; target: TargetIdentity; branch: string; sourceSha?: string; sourceBranch?: string; createdAt: string };
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
const cleanTarget = (target: TargetIdentity) => ({id:target.id,owner:target.owner,repo:target.repo, ...(typeof target.private === 'boolean' ? {private:target.private} : {})});
const validName = (value: unknown) => typeof value === 'string' && /^[\w.-]+$/.test(value);
function cleanProject(project: AccountProject): AccountProject {
  return { source: { owner: project.source.owner, repo: project.source.repo, url: `https://github.com/${project.source.owner}/${project.source.repo}`, branch: project.source.branch, repositoryId: project.source.repositoryId }, target: cleanTarget(project.target), kind: project.kind, state: project.state, createdByApp: !!project.createdByApp, reservationId: project.reservationId, branches: project.branches?.filter(branch => typeof branch === 'string'), bindings: Object.fromEntries(Object.entries(project.bindings).map(([branch, binding]) => [branch, { branch: binding.branch, sourceSha: binding.sourceSha, commitSha: binding.commitSha, updatedAt: binding.updatedAt }])), updatedAt: project.updatedAt, primary: project.primary, profile: project.profile ? {tags: project.profile.tags.filter(tag => typeof tag === 'string'), remark: project.profile.remark, description: project.profile.description, updatedAt:project.profile.updatedAt} : undefined, history: project.history?.map(item => ({target:cleanTarget(item.target),kind:item.kind,bindings:cleanProject({...project,bindings:item.bindings,history:undefined,switchReservation:undefined}).bindings,changedAt:item.changedAt})), switchReservation: project.switchReservation ? {id:project.switchReservation.id,from:project.switchReservation.from ? cleanTarget(project.switchReservation.from) : undefined,target:cleanTarget(project.switchReservation.target),branch:project.switchReservation.branch,sourceSha:project.switchReservation.sourceSha,sourceBranch:project.switchReservation.sourceBranch,createdAt:project.switchReservation.createdAt} : undefined };
}
export class ExistingSourceError extends Error {
  constructor(public existing: AccountProject) { super(`账号已有同源目标 ${existing.target.owner}/${existing.target.repo}，请使用更新／同步，不可重复首次上传或分叉。`); }
}
function validateDocument(value: any, login: string): RegistryDocument {
  if (value?.app !== 'Get-Up_GitVault' || value.version !== 1 || value.account?.toLowerCase() !== login.toLowerCase() || !Array.isArray(value.projects)) throw new Error('账号记录格式或所属账号不符，已停止操作，未覆盖记录仓库');
  for (const project of value.projects) {
    if (typeof project.source?.branch !== 'string' || !project.source.branch || !validName(project.source?.owner) || !validName(project.source?.repo) || !validName(project.target?.owner) || !validName(project.target?.repo) || project.target.repo.toLowerCase() === REGISTRY_REPO || !['upload', 'current', 'full'].includes(project.kind) || !['active', 'reserved'].includes(project.state) || !project.bindings || typeof project.bindings !== 'object' || Array.isArray(project.bindings)) throw new Error('账号记录包含无效项目，已停止操作');
    if (project.profile && (!Array.isArray(project.profile.tags) || typeof project.profile.remark !== 'string' || typeof project.profile.description !== 'string' || typeof project.profile.updatedAt !== 'string')) throw new Error('账号资料格式无效');
    if (project.history && (!Array.isArray(project.history) || project.history.some((item:any) => !validName(item.target?.owner) || !validName(item.target?.repo) || !item.bindings || !['upload','current','full'].includes(item.kind)))) throw new Error('旧仓库关系记录无效');
    if (project.switchReservation && (!validName(project.switchReservation.target?.owner) || !validName(project.switchReservation.target?.repo) || typeof project.switchReservation.id !== 'string')) throw new Error('待切换记录无效');
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
export function createAccountRegistry(api = githubApi, wait = retryDelay) {
  let epoch=0,discoveryEpoch=0;
  const discoveryReads=new WeakMap<AbortSignal,Map<string,{epoch:number,value:Promise<Awaited<ReturnType<typeof discoveryStore.load>>>}>>();
  let taskAccounts=new WeakMap<AbortSignal,Map<string,{epoch:number;value:Promise<Awaited<ReturnType<typeof read>>>}>>();
  const taskNames=new WeakMap<AbortSignal,Map<string,Promise<any>>>();
  const read = async (token: string, signal = operationSignal(), create = false, commitRef?: string) => {
    if (!token) throw new Error('跨设备识别需要 GitHub Token，请在设置中填写可访问账号仓库的凭证');
    const user = await api('/user', token, {}, signal);
    if (!validName(user.login)) throw new Error('无法识别当前 GitHub 账号');
    const root = `/repos/${user.login}/${REGISTRY_REPO}`;
    let meta: any;
    try { meta = await api(root, token, { cache: 'no-store' }, signal); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!create) return { login: user.login as string, root, meta: undefined, sha: undefined as string | undefined, ref:undefined as string|undefined, document: { app: 'Get-Up_GitVault', version: 1, account: user.login, projects: [] } as RegistryDocument };
      try { meta = await api('/user/repos', token, init('POST', { name: REGISTRY_REPO, description: MARKER, private: true, auto_init: true }), signal); }
      catch (creationError) { if (!(creationError instanceof GitHubError) || ![409, 422].includes(creationError.status)) throw creationError; meta = await api(root, token, { cache: 'no-store' }, signal); }
    }
    if (!meta.private || meta.owner?.login?.toLowerCase() !== user.login.toLowerCase()) throw new Error('跨设备记录仓库必须属于当前账号且为私有仓库，未写入任何记录');
    // Pin content reads to an immutable commit. A branch Contents response may
    // lag behind a just-completed write even when browser caching is disabled.
    const branch = meta.default_branch || 'main';
    const ref = commitRef || (await api(`${root}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, token, { cache: 'no-store' }, signal)).object.sha;
    let file: any;
    try { file = await api(`${root}/contents/${FILE}?ref=${encodeURIComponent(ref)}`, token, { cache: 'no-store' }, signal); }
    catch (error) { if (!missing(error)) throw error; if (meta.description !== MARKER) throw new Error(`私人仓库 ${REGISTRY_REPO} 已被其他用途占用，请更名后重试，未覆盖文件`); }
    if (file && (file.encoding !== 'base64' || !file.content || file.size > 1000000)) throw new Error('跨设备记录文件过大或不可读取，未将其当作空记录');
    const document = file ? validateDocument(decode(file.content), user.login) : { app: 'Get-Up_GitVault', version: 1, account: user.login, projects: [] } as RegistryDocument;
    return { login: user.login as string, root, meta, sha: file?.sha as string | undefined, document,ref };
  };
  const lookupRead = async (token:string,signal:AbortSignal,fresh=false) => {
    signal.throwIfAborted();let entries=taskAccounts.get(signal);if(!entries){entries=new Map();taskAccounts.set(signal,entries);}
    let entry=entries.get(token);const reused=!!entry&&entry.epoch===epoch;
    if(!entry||entry.epoch!==epoch){entry={epoch,value:read(token,signal)};entries.set(token,entry);const current=entry;void entry.value.catch(()=>{if(entries!.get(token)===current)entries!.delete(token);});}
    const account=await entry.value;signal.throwIfAborted();
    if(fresh&&reused){
      if(!account.meta){entries.delete(token);return lookupRead(token,signal);}
      try{const ref=await api(`${account.root}/git/ref/heads/${(account.meta.default_branch||'main').split('/').map(encodeURIComponent).join('/')}`,token,{cache:'no-store'},signal);
        if(ref.object?.sha!==account.ref){entries.delete(token);return lookupRead(token,signal);}
      }catch(error){if(!missing(error))throw error;entries.delete(token);return lookupRead(token,signal);}
    }
    return account;
  };
  const cachedName = async (path:string,token:string,signal:AbortSignal) => {
    let entries=taskNames.get(signal);if(!entries){entries=new Map();taskNames.set(signal,entries);}
    const key=JSON.stringify([token,path]);let value=entries.get(key);
    if(!value){value=api(path,token,{cache:'no-store'},signal).catch(error=>{if(missing(error))return undefined;entries!.delete(key);throw error;});entries.set(key,value);}
    const result=await value;signal.throwIfAborted();return structuredClone(result);
  };
  const rememberAccount=(token:string,signal:AbortSignal,account:Awaited<ReturnType<typeof read>>)=>{
    epoch++;let entries=taskAccounts.get(signal);if(!entries){entries=new Map();taskAccounts.set(signal,entries);}entries.set(token,{epoch,value:Promise.resolve(account)});
  };
  // Build identity maps once per account snapshot. Writes never use these maps.
  const indexes=new WeakMap<object,{sourceIds:Map<number,AccountProject[]>;sourceNames:Map<string,AccountProject[]>;targetIds:Map<number,AccountProject[]>;targetNames:Map<string,AccountProject[]>}>();
  const nameKey=(value:{owner:string;repo:string})=>`${value.owner}/${value.repo}`.toLowerCase();
  const indexed = (document:RegistryDocument) => {
    let index=indexes.get(document);if(index)return index;
    index={sourceIds:new Map(),sourceNames:new Map(),targetIds:new Map(),targetNames:new Map()};
    const add=(map:Map<any,AccountProject[]>,key:any,item:AccountProject)=>{if(key!==undefined)map.set(key,[...(map.get(key)||[]),item]);};
    for(const item of document.projects){add(index.sourceIds,item.source.repositoryId,item);add(index.sourceNames,nameKey(item.source),item);add(index.targetIds,item.target.id,item);add(index.targetNames,nameKey(item.target),item);}
    indexes.set(document,index);return index;
  };
  const recordedFor=(account:Awaited<ReturnType<typeof read>>,source:ProjectSource)=>{
    const index=indexed(account.document);
    const bySource=[...(source.repositoryId?index.sourceIds.get(source.repositoryId)||[]:[]),...(index.sourceNames.get(nameKey(source))||[])].filter(item=>sameSource(item.source,source));
    if(bySource.length)return [...new Set(bySource)];
    return [...new Set([...(source.repositoryId?index.targetIds.get(source.repositoryId)||[]:[]),...(index.targetNames.get(nameKey(source))||[])].filter(item=>source.repositoryId&&item.target.id?source.repositoryId===item.target.id:nameKey(item.target)===nameKey(source)))];
  };
  const legacyProject=(source:ProjectSource,meta:any,discovery:AccountProject['discovery']={kind:'name'}):AccountProject=>{
    if(!Number.isSafeInteger(meta.id)||meta.id<=0||!validName(meta.owner?.login)||!validName(meta.name))throw new Error('候选仓库身份无效，请重新查找');
    const full=!!meta.fork&&!!meta.parent&&(source.repositoryId&&meta.parent.id?source.repositoryId===meta.parent.id:meta.parent.full_name?.toLowerCase()===nameKey(source));
    return {source,target:{id:meta.id,owner:meta.owner.login,repo:meta.name,private:meta.private},discovery:full?{kind:'fork',source:{owner:source.owner,repo:source.repo}}:discovery,kind:full?'full':'upload',state:'active',createdByApp:false,bindings:{[source.branch]:{branch:source.branch,updatedAt:''}},updatedAt:''};
  };
  const change = async (token: string, edit: (document: RegistryDocument, login: string) => RegistryDocument, signal = operationSignal()) => {
    signal.throwIfAborted();
    if (!token) throw new Error('跨设备识别需要 GitHub Token，请在设置中填写可访问账号仓库的凭证');
    const user = await api('/user', token, { cache: 'no-store' }, signal);
    if (!validName(user.login)) throw new Error('无法识别当前 GitHub 账号');
    const key = user.login.toLowerCase();
    const mutate = async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        signal.throwIfAborted();
        report('正在保存并验证账号来源与分支记录…');
        try {
          const current = await read(token, signal, true);
          if (current.login.toLowerCase() !== key) throw new Error('GitHub 账号发生变化，已停止保存记录');
          const document = validateDocument(edit(current.document, current.login), current.login);
          if (JSON.stringify(current.document) === JSON.stringify(document)) {rememberAccount(token,signal,current);return document;}
          const written = await api(`${current.root}/contents/${FILE}`, token, init('PUT', { message: 'Update GitVault account bindings', content: encode(document), branch: current.meta.default_branch || 'main', ...(current.sha ? { sha: current.sha } : {}) }), signal);
          if (!written.commit?.sha) throw new Error('GitHub 未返回账号记录提交版本，请使用更新／同步重新核实');
          // Verify our committed snapshot, not the entire mutable branch after
          // another device has legitimately added its own records.
          const verified = await read(token, signal, false, written.commit.sha);
          if (JSON.stringify(verified.document) !== JSON.stringify(document)) throw new GitHubError('账号记录在验证时发生变化，请重试合并', 409);
          rememberAccount(token,signal,verified);return verified.document;
        } catch (error) {
          epoch++;signal.throwIfAborted();
          const conflict = error instanceof GitHubError && (error.status === 409 || error.status === 422 && /sha|already exists|reference update|conflict|does not match/i.test(error.message));
          const uncertain = error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError' || error instanceof GitHubError && error.status >= 500;
          if (!conflict && !uncertain) throw error;
          if (attempt === 5) throw new Error(`账号记录持续发生写入冲突或响应异常，本地项目已保留，请稍后使用更新／同步重试：${(error as Error).message}`, { cause: error });
          report(`账号记录已变化，正在等待并合并最新记录（${attempt + 1}/5）…`);
          await wait(attempt, signal);
        }
      }
      throw new Error('账号记录并发写入冲突，请稍后重试');
    };
    const queued = (accountWrites.get(key) || Promise.resolve()).then(async () => {
      signal.throwIfAborted();
      // Web Locks also serialize other tabs on the same origin. SHA checks
      // and merge retries remain required for other devices and APK clients.
      if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(`gitvault-account-record:${key}`, { mode: 'exclusive', signal }, mutate);
      return mutate();
    });
    const settled = queued.then(() => {}, () => {});
    accountWrites.set(key, settled);
    void settled.then(() => { if (accountWrites.get(key) === settled) accountWrites.delete(key); });
    return abortable(queued, signal);
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
    if (old?.profile && project.profile && old.profile.updatedAt !== project.profile.updatedAt && Date.parse(old.profile.updatedAt) > Date.parse(project.profile.updatedAt)) throw new Error('另一台设备的项目资料已更新，请重新读取后再保存标签');
    const merged = { ...old, ...project, primary: project.primary ?? old?.primary, profile: project.profile || old?.profile, history: project.history || old?.history, switchReservation: old?.switchReservation, kind: old?.kind === 'full' ? 'full' as const : project.kind, branches: project.branches || old?.branches, createdByApp: !!old?.createdByApp || project.createdByApp, bindings };
    return { ...document, projects: [...document.projects.filter(item => !sameSource(item.source, project.source)), merged] };
  }, signal);
  const reserve = async (source: ProjectSource, name: string, kind: AccountProject['kind'], token: string, signal = operationSignal(), explicit?: TargetIdentity) => {
    if (!validName(name) || name.length > 100 || /^\.+$/.test(name) || name.toLowerCase() === REGISTRY_REPO) throw new Error('目标名称无效或属于跨设备记录仓库，请使用其他名称');
    let selected!: AccountProject;
    const reservationId = crypto.randomUUID();
    await change(token, (document, login) => {
      const old = document.projects.find(item => sameSource(item.source, source));
      if (old?.reservationId === reservationId) { selected = old; return document; }
      if (old) throw new ExistingSourceError(old);
      const targetOwner = explicit?.owner || login;
      if (document.projects.some(item => item.target.owner.toLowerCase() === targetOwner.toLowerCase() && item.target.repo.toLowerCase() === name.toLowerCase())) throw new Error('该目标名称已绑定其他来源，请先比较项目，不能覆盖其他来源');
      selected = { source, target: explicit ? { id: explicit.id, owner: explicit.owner, repo: explicit.repo } : { owner: login, repo: name }, kind, state: 'reserved', createdByApp: true, reservationId, bindings: { [source.branch]: { branch: source.branch, updatedAt: new Date().toISOString() } }, updatedAt: new Date().toISOString() };
      return { ...document, projects: [...document.projects, selected] };
    }, signal);
    return selected;
  };
  const equalTarget = (a: TargetIdentity | undefined, b: TargetIdentity | undefined) => !a || !b ? a === b : a.id && b.id ? a.id === b.id : a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
  const reserveSwitch = async (source: ProjectSource, target: TargetIdentity, branch: string, expected: TargetIdentity | undefined, token: string, signal = operationSignal(), sourceSha?:string) => {
    if (!validName(target.owner) || !validName(target.repo) || target.repo.length > 100 || /^\.+$/.test(target.repo) || target.repo.toLowerCase() === REGISTRY_REPO) throw new Error('新仓库名称无效');
    let reservation!: NonNullable<AccountProject['switchReservation']>;
    await change(token, document => {
      const old = document.projects.find(item => sameSource(item.source,source));
      if (old && !equalTarget(old.target,expected) && !(old.state === 'reserved' && equalTarget(old.target,target))) throw new ExistingSourceError(old);
      if (old?.switchReservation) {
        if (!equalTarget(old.switchReservation.target,target) || old.switchReservation.branch !== branch) throw new Error('已有另存任务尚未完成，请继续该任务后再选择其他目标');
        reservation = old.switchReservation; return document;
      }
      if (document.projects.some(item => !sameSource(item.source,source) && (equalTarget(item.target,target) || equalTarget(item.switchReservation?.target,target)))) throw new Error('新目标已绑定其他来源，不能覆盖');
      reservation = {id:crypto.randomUUID(),from:old?.state==='active'?old.target:undefined,target:cleanTarget(target),branch,sourceSha,sourceBranch:source.branch,createdAt:new Date().toISOString()};
      const entry: AccountProject = old || {source,target:expected||target,kind:'upload',state:expected?.id?'active':'reserved',createdByApp:true,bindings:expected?{[source.branch]:{branch:(expected as TargetIdentity & {branch?:string}).branch || source.branch,updatedAt:reservation.createdAt}}:{},updatedAt:reservation.createdAt};
      return {...document,projects:[...document.projects.filter(item=>!sameSource(item.source,source)),{...entry,switchReservation:reservation}]};
    },signal);
    return reservation;
  };
  const completeSwitch = async (project: AccountProject, reservationId: string, token: string, signal = operationSignal()) => change(token,document => {
    const old = document.projects.find(item=>sameSource(item.source,project.source));
    if (old && !old.switchReservation && equalTarget(old.target,project.target)) return document;
    if (!old?.switchReservation || old.switchReservation.id !== reservationId) throw new Error('切换预留已改变，旧绑定保留，请重新检查账号记录');
    if (!equalTarget(old.switchReservation.target,project.target)) throw new Error('新目标与切换预留不一致');
    if (document.projects.some(item=>!sameSource(item.source,project.source)&&equalTarget(item.target,project.target))) throw new Error('新目标已被其他来源绑定');
    const history = old.state==='active' && !equalTarget(old.target,project.target) ? [...(old.history||[]),{target:old.target,kind:old.kind,bindings:old.bindings,changedAt:project.updatedAt}] : old.history || [];
    const next = {...project,profile:project.profile || old.profile,history,switchReservation:undefined,primary:true};
    return {...document,projects:[...document.projects.filter(item=>!sameSource(item.source,project.source)),next]};
  },signal);
  const remove = async (target: TargetIdentity, token: string, signal = operationSignal()) => {
    const current = await read(token, signal);
    if (!current.meta) return current.document;
    return change(token, document => ({ ...document, projects: document.projects.filter(item => target.id && item.target.id ? item.target.id !== target.id : item.target.owner.toLowerCase() !== target.owner.toLowerCase() || item.target.repo.toLowerCase() !== target.repo.toLowerCase()) }), signal);
  };
  const discoveryIndexes=new WeakMap<object,{names:Map<string,DiscoveryRow[]>;parents:Map<number,DiscoveryRow[]>}>();
  const legacyRows=(source:ProjectSource,rows:DiscoveryRow[])=>{
    let index=discoveryIndexes.get(rows);if(!index){index={names:new Map(),parents:new Map()};
      const add=(map:Map<any,DiscoveryRow[]>,key:any,row:DiscoveryRow)=>{if(key!==undefined)map.set(key,[...(map.get(key)||[]),row]);};
      for(const row of rows){for(const item of row.sources)add(index.names,nameKey(item),row);if(row.parent?.id)add(index.parents,row.parent.id,row);if(row.parent?.full_name)add(index.names,row.parent.full_name.toLowerCase(),row);add(index.names,`name:${row.repo.name.toLowerCase()}`,row);}discoveryIndexes.set(rows,index);
    }
    const matching=[...new Set([...(index.names.get(nameKey(source))||[]),...(index.names.get(`name:${source.repo.toLowerCase()}`)||[]),...(source.repositoryId?index.parents.get(source.repositoryId)||[]:[])])];
    const legacy:AccountProject[]=[];
    for(const row of matching){const repo=row.repo;if(repo.id===source.repositoryId||nameKey({owner:repo.owner.login,repo:repo.name})===nameKey(source))continue;
      if(repo.fork&&row.parent&&(source.repositoryId&&row.parent.id?source.repositoryId===row.parent.id:row.parent.full_name?.toLowerCase()===nameKey(source)))legacy.push(legacyProject(source,{...repo,parent:row.parent}));
      else{const matches=row.sources.filter(item=>nameKey(item)===nameKey(source));
        if(matches.length){const entry=legacyProject(source,repo,{kind:'metadata',source:{owner:matches[0].owner,repo:matches[0].repo},branches:matches.map(item=>item.branch).sort()});entry.bindings[source.branch].branch=matches.find(item=>item.branch===source.branch)?.branch||matches[0].branch;legacy.push(entry);}
        else if(repo.name.toLowerCase()===source.repo.toLowerCase())legacy.push(legacyProject(source,repo));}
    }return legacy;
  };
  const availableLegacy=(account:Awaited<ReturnType<typeof read>>,source:ProjectSource,list:AccountProject[])=>{
    const index=indexed(account.document);return list.filter(item=>![...(index.targetIds.get(item.target.id!)||[]),...(index.targetNames.get(nameKey(item.target))||[])].some(bound=>!sameSource(bound.source,source)));
  };
  const cachedDiscovery=async(login:string,signal:AbortSignal)=>{
    let entries=discoveryReads.get(signal);if(!entries){entries=new Map();discoveryReads.set(signal,entries);}let entry=entries.get(login);
    if(!entry||entry.epoch!==discoveryEpoch){entry={epoch:discoveryEpoch,value:discoveryStore.load(login.toLowerCase())};entries.set(login,entry);const current=entry;void entry.value.catch(()=>{if(entries!.get(login)===current)entries!.delete(login);});}
    return entry.value;
  };
  const candidates = async (source: ProjectSource, token: string, signal = operationSignal(), options:{fresh?:boolean}={}) => {
    report('正在读取账号来源记录，识别已有上传与分叉…');
    let account: Awaited<ReturnType<typeof read>>;
    try { account = await lookupRead(token,signal,options.fresh); }
    catch (registryError) {
      signal.throwIfAborted();
      // A readable same-name repository can still be compared without the
      // optional rename index. Never claim absence when the index is unreadable.
      const user=await api('/user',token,{},signal);
      if(!validName(user.login))throw registryError;
      let meta:any;
      try{meta=await api(`/repos/${user.login}/${source.repo}`,token,{cache:'no-store'},signal);}catch{throw registryError;}
      const full=!!meta.fork&&!!meta.parent&&(source.repositoryId&&meta.parent.id?source.repositoryId===meta.parent.id:meta.parent.full_name?.toLowerCase()===`${source.owner}/${source.repo}`.toLowerCase());
      return {login:user.login as string,recorded:[] as AccountProject[],legacy:[{source,target:{id:meta.id,owner:meta.owner?.login || user.login,repo:meta.name || source.repo,private:meta.private},discovery:{kind:full?'fork' as const:'name' as const,source:full?{owner:meta.parent.owner?.login || meta.parent.full_name?.split('/')[0],repo:meta.parent.name || meta.parent.full_name?.split('/')[1]}:undefined},kind:full?'full' as const:'upload' as const,state:'active' as const,createdByApp:false,bindings:{[source.branch]:{branch:source.branch,updatedAt:''}},updatedAt:''}],registryError:(registryError as Error).message};
    }
    const recorded=recordedFor(account,source);
    if (recorded.length) return { login: account.login, recorded:structuredClone(recorded), legacy: [] as AccountProject[] };
    const meta=await cachedName(`/repos/${account.login}/${source.repo}`,token,signal);
    if(meta)return {login:account.login,recorded:[] as AccountProject[],legacy:availableLegacy(account,source,[legacyProject(source,meta)]),discoveryComplete:false};
    // Reuse already saved evidence; a quick lookup never starts a remote scan.
    try{const cached=await cachedDiscovery(account.login,signal);signal.throwIfAborted();return {login:account.login,recorded:[] as AccountProject[],legacy:availableLegacy(account,source,legacyRows(source,cached.rows)),discoveryComplete:false};}
    catch(error){signal.throwIfAborted();report('旧版发现缓存暂不可读取；可在“查找已有仓库”中重试。');return {login:account.login,recorded:[] as AccountProject[],legacy:[] as AccountProject[],discoveryComplete:false,discoveryError:(error as Error).message};}
  };
  const discover = async (source:ProjectSource,token:string,signal=operationSignal(),refresh=false) => {
    const account=await lookupRead(token,signal);
    let rows:DiscoveryRow[];
    try{rows=await scanAccountDiscovery(account.login,token,api,signal,report,refresh);}finally{discoveryEpoch++;}
    return {login:account.login,recorded:structuredClone(recordedFor(account,source)),legacy:availableLegacy(account,source,legacyRows(source,rows)),discoveryComplete:true};
  };
  const search = async (source:ProjectSource,token:string,query:string,signal=operationSignal()) => {
    signal.throwIfAborted();const account=await lookupRead(token,signal);const text=query.trim();
    if(!text)throw new Error('请输入仓库关键词或完整仓库链接');
    let repos:any[],incomplete=false;
    const exact=/^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(text);
    if(exact)repos=[await api(`/repos/${exact[1]}/${exact[2]}`,token,{cache:'no-store'},signal)];
    else{
      // Treat user input as literal name terms; do not allow qualifiers to change the account scope.
      const terms=text.match(/[\p{L}\p{N}_.-]+/gu)?.slice(0,8).join(' ')||'';
      if(!terms||terms.length>120)throw new Error('请输入较短的仓库名称关键词');
      const result=await api(`/search/repositories?q=${encodeURIComponent(`user:${account.login} ${terms} in:name fork:true`)}&per_page=30`,token,{cache:'no-store'},signal);
      if(!Array.isArray(result.items))throw new Error('仓库搜索结果格式错误');
      repos=result.items.filter((item:any)=>item.owner?.login?.toLowerCase()===account.login.toLowerCase());incomplete=!!result.incomplete_results||result.total_count>repos.length;
    }
    const recorded:AccountProject[]=[],legacy:AccountProject[]=[];let blocked=0;
    const index=indexed(account.document);
    for(const meta of repos){
      const bound=[...(index.targetIds.get(meta.id)||[]),...(index.targetNames.get(nameKey({owner:meta.owner?.login||'',repo:meta.name||''}))||[])];
      const same=bound.find(item=>sameSource(item.source,source));
      if(same)recorded.push(structuredClone(same));
      else if(bound.length)blocked++;
      else if(meta.id!==source.repositoryId)legacy.push(legacyProject(source,meta,{kind:'search',fork:!!meta.fork}));
    }
    return {login:account.login,recorded,legacy,incomplete,blocked};
  };
  return { read, save, reserve, reserveSwitch, completeSwitch, remove, candidates, discover, search, invalidate: () => { epoch++;discoveryEpoch++;taskAccounts=new WeakMap(); } };
}
export const accountRegistry = createAccountRegistry();
