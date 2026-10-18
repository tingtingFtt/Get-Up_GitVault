/** Durable, version-aware project cache. File contents are shared by Git blob SHA. */
import { gitBlobSha } from './gitFiles';
import { clearNativeGitCache } from './nativeGitCache';
import { usesNativeFolder, hasFolderApi, folderRoot, folderBridge, beginFolder, putFolderFile, finishFolder, folderFiles, hydrateFile, withFolderConfirmation, type FolderFiles } from './nativeFolder';

export interface CachedFile {
  nativeRef?: { version: string; path: string; dirty?: boolean; added?: boolean };
  path: string;
  content: string;
  isBase64: boolean;
  size?: number;
  sha?: string;
  mode?: string;
}
const DB_NAME = 'GitVault_Storage_v1';
const DB_VERSION = 4;
const LEGACY = 'project_files';
const SNAPSHOTS = 'snapshots';
const CONTENTS = 'file_contents';
const RECEIPTS = 'sync_receipts';
const TRANSFERS = 'download_parts';
const UPLOADS = 'uploaded_blobs';
const snapshotId = (repoId: string, ref: string) => `${repoId}@${ref}`;
interface Snapshot { id: string; repoId: string; ref: string; files: Omit<CachedFile, 'content'>[]; savedAt: string; nativeVersion?: string }

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('当前环境不支持持久缓存，请使用支持 IndexedDB 的浏览器'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; reject(new Error('本地数据库被其他窗口占用，请关闭旧窗口后重试')); }, 10000);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY)) db.createObjectStore(LEGACY, { keyPath: 'repoId' });
      if (!db.objectStoreNames.contains(SNAPSHOTS)) { const store = db.createObjectStore(SNAPSHOTS, { keyPath: 'id' }); store.createIndex('repoId', 'repoId'); }
      if (!db.objectStoreNames.contains(CONTENTS)) db.createObjectStore(CONTENTS, { keyPath: 'sha' });
      if (!db.objectStoreNames.contains(TRANSFERS)) { const store = db.createObjectStore(TRANSFERS, { keyPath: 'id' }); store.createIndex('transfer', 'transfer'); store.createIndex('commitSha', 'commitSha'); }
      if (!db.objectStoreNames.contains(RECEIPTS)) db.createObjectStore(RECEIPTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(UPLOADS)) db.createObjectStore(UPLOADS, { keyPath: 'id' }).createIndex('repoId', 'repoId');
    };
    request.onsuccess = () => { clearTimeout(timer); const db = request.result; if (timedOut) { db.close(); return; } db.onversionchange = () => db.close(); resolve(db); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
  });
}
function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('缓存事务未完成，文件未标记为持久保存'));
    tx.onerror = () => { /* onabort owns the transaction result */ };
  });
}
async function withDB<T>(task: (db: IDBDatabase) => Promise<T>) {
  const db = await openDB();
  try { return await task(db); }
  catch (error) { if ((error as Error).name === 'QuotaExceededError') throw new Error('本地存储空间或浏览器缓存配额不足，请释放空间后重试；原有项目和已保存的下载进度保留', { cause: error }); throw error; }
  finally { db.close(); }
}
export const transferCache = {
  async clearAll():Promise<void>{await withDB(async db=>{const tx=db.transaction(TRANSFERS,'readwrite'),done=completed(tx);tx.objectStore(TRANSFERS).clear();await done;});},
  async load(transfer: string): Promise<CachedFile[]> {
    return withDB(async db => {
      const tx = db.transaction(TRANSFERS, 'readonly');
      return (await read<any[]>(tx.objectStore(TRANSFERS).index('transfer').getAll(transfer))).map(item => item.file);
    });
  },
  async save(transfer: string, commitSha: string, file: CachedFile): Promise<void> {
    return transferCache.saveBatch(transfer, commitSha, [file]);
  },
  async saveBatch(transfer: string, commitSha: string, files: CachedFile[]): Promise<void> {
    if (!files.length) return;
    await withDB(async db => {
      const tx = db.transaction(TRANSFERS, 'readwrite'); const done = completed(tx);
      for (const file of files) tx.objectStore(TRANSFERS).put({ id: `${transfer}:${file.path}`, transfer, commitSha, file });
      await done;
    });
  },
  async clear(commitSha: string): Promise<void> {
    await withDB(async db => {
      const tx = db.transaction(TRANSFERS, 'readwrite'); const done = completed(tx);
      const store = tx.objectStore(TRANSFERS);
      for (const key of await read<IDBValidKey[]>(store.index('commitSha').getAllKeys(commitSha))) store.delete(key);
      await done;
    });
  },
};
/** Server-acknowledged object IDs only; no source bytes or tokens. Recheck on reuse. */
export const uploadCache = {
  async load(repoId: number): Promise<Set<string>> {
    return withDB(async db => {
      const tx = db.transaction(UPLOADS, 'readwrite'), done = completed(tx);
      const store = tx.objectStore(UPLOADS), entries = await read<any[]>(store.index('repoId').getAll(repoId));
      const valid = entries.filter(item => item.savedAt > Date.now() - 7 * 86400000);
      for (const item of entries) if (!valid.includes(item)) store.delete(item.id);
      await done;
      return new Set(valid.map(item => item.sha));
    });
  },
  async save(repoId: number, sha: string): Promise<void> {
    return uploadCache.saveBatch(repoId, [sha]);
  },
  async saveBatch(repoId: number, hashes: string[]): Promise<void> {
    await withDB(async db => {
      const tx = db.transaction(UPLOADS, 'readwrite'), done = completed(tx);
      for (const sha of hashes) tx.objectStore(UPLOADS).put({ id: `${repoId}:${sha}`, repoId, sha, savedAt: Date.now() });
      await done;
    });
  },
};
export const localCache = {
  async saveProjectFiles(repoId: string, files: CachedFile[], ref = 'legacy', options: { history?: boolean; storageKey?: string; label?: string } = {}): Promise<void> {
    const inherited = (files as FolderFiles).nativeSnapshot?.version || files.find(file => file.nativeRef)?.nativeRef?.version;
    if (usesNativeFolder() || inherited) {
      let version = inherited;
      if (!version || files.some(file => !file.nativeRef || file.nativeRef.version !== version)) {
        const metadata: Array<{path:string;sha:string;mode:string;size?:number}> = [];
        for (const file of files) {
          if(file.sha&&file.size!==undefined){metadata.push({path:file.path,sha:file.sha,mode:file.mode||'100644',size:file.size});continue;}
          const body=await hydrateFile(file),bytes=body.isBase64?Uint8Array.from(atob(body.content.replace(/\s/g,'')),c=>c.charCodeAt(0)):new TextEncoder().encode(body.content);
          const sha=await gitBlobSha(bytes);if(file.sha&&sha!==file.sha)throw new Error('迁移文件校验失败：'+file.path);
          metadata.push({path:file.path,sha,mode:file.mode||'100644',size:bytes.length});
        }
        const stage = await beginFolder(options.storageKey || JSON.stringify([repoId, 'main']), ref, options.label || repoId, metadata);
        version = stage.id; const handles: CachedFile[] = [];
        for(let i=0;i<files.length;i++)handles.push(await putFolderFile(version!,{...files[i],...metadata[i]}));
        const originals=new Map(files.map((file,i)=>[file.path,{...file,...metadata[i]}]));
        await finishFolder(version!,async paths=>{for(const path of paths){const original=originals.get(path);if(!original)throw new Error('目录修复请求包含迁移清单外路径');await putFolderFile(version!,original);}});files = handles;
      }
      await withDB(async db => { const tx = db.transaction([SNAPSHOTS, LEGACY, TRANSFERS], 'readwrite'), done = completed(tx);
        tx.objectStore(SNAPSHOTS).put({ id: snapshotId(repoId, ref), repoId, ref, files: files.map(({ content, ...file }) => file), nativeVersion: version, savedAt: new Date().toISOString() });
        if(!options.history)tx.objectStore(LEGACY).put({ repoId, currentRef: ref });
        for (const key of await read<IDBValidKey[]>(tx.objectStore(TRANSFERS).index('commitSha').getAllKeys(ref))) tx.objectStore(TRANSFERS).delete(key);
        await done;
      });
      const attached=await folderBridge.attach({ version, owner: repoId, ref, history: !!options.history });
      if(attached.retained?.length)window.dispatchEvent(new CustomEvent('gitvault-folder-warning',{detail:'新版本已保存，以下旧目录仍保留：'+attached.retained.join('；')}));
      if(!options.history)await withDB(async db=>{const tx=db.transaction(SNAPSHOTS,'readwrite'),done=completed(tx),store=tx.objectStore(SNAPSHOTS);for(const old of await read<Snapshot[]>(store.index('repoId').getAll(repoId)))if(!old.nativeVersion&&old.ref!==ref)store.delete(old.id);await done;});
      await localCache.pruneBodies(); return;
    }
    const prepared: CachedFile[] = [];
    for (const file of files) {
      const bytes = file.isBase64 ? Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0)) : new TextEncoder().encode(file.content);
      const sha = await gitBlobSha(bytes);
      if (file.sha && file.sha !== sha) throw new Error(`缓存文件内容与版本不一致: ${file.path}`);
      prepared.push({ ...file, sha, size: bytes.length });
    }
    await withDB(async db => {
      // Commit bounded content batches before publishing the snapshot reference.
      // Existing snapshots stay intact if storage fills up during any batch.
      let batch: CachedFile[] = [], bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        const tx = db.transaction(CONTENTS, 'readwrite'), done = completed(tx);
        for (const file of batch) tx.objectStore(CONTENTS).put({ sha: file.sha, content: file.content, isBase64: file.isBase64 });
        await done; batch = []; bytes = 0;
      };
      for (const file of prepared) { batch.push(file); bytes += file.size || 0; if (bytes >= 4 * 1024 * 1024 || batch.length >= 32) await flush(); }
      await flush();
      const tx = db.transaction([SNAPSHOTS, CONTENTS, LEGACY, TRANSFERS], 'readwrite');
      const done = completed(tx);
      // A different tab may have pruned an old snapshot between batches.
      const present = await Promise.all(prepared.map(file => read(tx.objectStore(CONTENTS).getKey(file.sha!))));
      prepared.forEach((file, i) => { if (present[i] === undefined) tx.objectStore(CONTENTS).put({ sha: file.sha, content: file.content, isBase64: file.isBase64 }); });
      tx.objectStore(SNAPSHOTS).put({ id: snapshotId(repoId, ref), repoId, ref, savedAt: new Date().toISOString(), files: prepared.map(({ content, ...file }) => file) });
      tx.objectStore(LEGACY).put({ repoId, currentRef: ref });
      const partKeys = await read<IDBValidKey[]>(tx.objectStore(TRANSFERS).index('commitSha').getAllKeys(ref));
      for (const key of partKeys) tx.objectStore(TRANSFERS).delete(key);
      await done;
    });
  },
  async getProjectFiles(repoId: string, ref?: string): Promise<FolderFiles> {
    const cached = await withDB(async db => {
      const tx = db.transaction([LEGACY, SNAPSHOTS, CONTENTS], 'readonly');
      const legacy = await read<any>(tx.objectStore(LEGACY).get(repoId));
      // Old records have no trusted version identity. Callers validate them against their file tree.
      if (!ref && Array.isArray(legacy?.files)) return legacy.files;
      const selectedRef = ref || legacy?.currentRef;
      if (!selectedRef) return [];
      const snapshot = await read<Snapshot | undefined>(tx.objectStore(SNAPSHOTS).get(snapshotId(repoId, selectedRef)));
      if (!snapshot) return [];
      if (snapshot.nativeVersion) return { nativeVersion: snapshot.nativeVersion, paths: snapshot.files.map(file => file.path) };
      const files = await Promise.all(snapshot.files.map(async file => {
        const value = await read<any>(tx.objectStore(CONTENTS).get(file.sha!));
        return value ? { ...file, content: value.content, isBase64: value.isBase64 } : null;
      }));
      if (files.some(f => !f)) throw new Error('本地缓存不完整，请重新获取该版本');
      return files as CachedFile[];
    });
    if (!Array.isArray(cached)) {
      const actual=await folderFiles(cached.nativeVersion);const selected=actual.filter(file=>cached.paths.includes(file.path)||file.nativeRef?.added) as FolderFiles;selected.nativeSnapshot=actual.nativeSnapshot;return selected;
    }
    return cached;
  },
  async getProjectFile(repoId: string, filePath: string, ref?: string): Promise<CachedFile | null> {
    // Only load the requested blob rather than every file in a large project.
    return withDB(async db => {
      const tx = db.transaction([LEGACY, SNAPSHOTS, CONTENTS], 'readonly');
      const legacy = await read<any>(tx.objectStore(LEGACY).get(repoId));
      if (!ref && legacy?.files) return legacy.files.find((f: CachedFile) => f.path === filePath) || null;
      const selectedRef = ref || legacy?.currentRef;
      if (!selectedRef) return null;
      const snapshot = await read<Snapshot | undefined>(tx.objectStore(SNAPSHOTS).get(snapshotId(repoId, selectedRef)));
      const file = snapshot?.files.find(f => f.path === filePath.replace(/^\/+/, ''));
      if (!file) return null;
      if (file.nativeRef) return hydrateFile(await folderBridge.file(file.nativeRef), 8 * 1024 * 1024);
      const value = await read<any>(tx.objectStore(CONTENTS).get(file.sha!));
      return value ? { ...file, content: value.content, isBase64: value.isBase64 } : null;
    });
  },
  async deleteProjectFiles(repoId: string, ref?: string, options:{interactive?:boolean;verifiedFiles?:Array<{path:string;sha:string;mode:string}>}={}): Promise<void> {
    // Git pools may contain source and target history shared across tasks. Clear
    // all acceleration objects so a source purge cannot leave a reconstructible copy.
    await clearNativeGitCache();
    if(hasFolderApi()) {
      const clear=(force:boolean)=>folderBridge.clear({owner:repoId,ref:ref||'',force,verifiedFiles:options.verifiedFiles});
      if(options.interactive)await withFolderConfirmation(clear,'清理将删除该项目目录中的已下载文件，保留项目记录和 GitHub 历史。');else await clear(false);
    }
    await withDB(async db => {
      const tx = db.transaction([LEGACY, SNAPSHOTS, CONTENTS, TRANSFERS], 'readwrite');
      const done = completed(tx);
      const snapshots = tx.objectStore(SNAPSHOTS);
      const all = await read<Snapshot[]>(snapshots.getAll());
      const removed = all.filter(s => s.repoId === repoId && (!ref || s.ref === ref));
      for (const snapshot of removed) snapshots.delete(snapshot.id);
      for (const snapshot of removed) for (const key of await read<IDBValidKey[]>(tx.objectStore(TRANSFERS).index('commitSha').getAllKeys(snapshot.ref))) tx.objectStore(TRANSFERS).delete(key);
      const remaining = all.filter(s => !removed.some(r => r.id === s.id));
      const referenced = new Set(remaining.flatMap(s => s.files.map(f => f.sha)));
      for (const snapshot of removed) for (const file of snapshot.files) if (!referenced.has(file.sha)) tx.objectStore(CONTENTS).delete(file.sha!);
      const current = await read<any>(tx.objectStore(LEGACY).get(repoId));
      if (!ref || current?.currentRef === ref || current?.files) tx.objectStore(LEGACY).delete(repoId);
      await done;
    });
  },
  async pruneBodies(): Promise<void> {
    await withDB(async db => { const tx = db.transaction([SNAPSHOTS, CONTENTS], 'readwrite'), done = completed(tx);
      const snapshots = await read<Snapshot[]>(tx.objectStore(SNAPSHOTS).getAll()); const keep = new Set(snapshots.filter(snapshot => !snapshot.nativeVersion).flatMap(snapshot => snapshot.files.map(file => file.sha)));
      for (const key of await read<IDBValidKey[]>(tx.objectStore(CONTENTS).getAllKeys())) if (!keep.has(String(key))) tx.objectStore(CONTENTS).delete(key); await done;
    });
  },
  async migrateProject(repoId: string, ref: string, storageKey: string, label: string, signal?:AbortSignal): Promise<void> {
    const metadata = await withDB(async db => read<Snapshot | undefined>(db.transaction(SNAPSHOTS, 'readonly').objectStore(SNAPSHOTS).get(snapshotId(repoId, ref))));
    if (!metadata) return;
    if(metadata.nativeVersion){const existing=await folderBridge.list({version:metadata.nativeVersion,scan:false});if(!existing.missing&&existing.root===folderRoot())return;}
    const stage = await beginFolder(storageKey, ref, label, metadata.files.map(file => ({ path: file.path, sha: file.sha!, mode: file.mode || '100644', size: file.size })));
    const files: CachedFile[] = [];
    for (const entry of metadata.files) { signal?.throwIfAborted(); const file = entry.nativeRef?{...entry,content:''}:await localCache.getProjectFile(repoId, entry.path, ref); if (!file) throw new Error('旧缓存不完整，尚未切换主存储'); files.push(await putFolderFile(stage.id, file,signal)); }
    const originals=new Map(metadata.files.map(file=>[file.path,file]));
    await finishFolder(stage.id,async paths=>{for(const path of paths){signal?.throwIfAborted();const entry=originals.get(path);if(!entry)throw new Error('目录修复请求包含迁移清单外路径');const original=entry.nativeRef?{...entry,content:''}:await localCache.getProjectFile(repoId,path,ref);if(!original)throw new Error('旧缓存不完整，尚未切换主存储');await putFolderFile(stage.id,original,signal);}},signal);await localCache.saveProjectFiles(repoId, files, ref);
    await withDB(async db=>{const tx=db.transaction(SNAPSHOTS,'readwrite'),done=completed(tx),store=tx.objectStore(SNAPSHOTS);for(const old of await read<Snapshot[]>(store.index('repoId').getAll(repoId)))if(!old.nativeVersion&&old.ref!==ref)store.delete(old.id);await done;});
    await localCache.pruneBodies();
  },
  async saveSyncReceipt(repoId: string, sourceSha: string, receipt: unknown): Promise<void> {
    await withDB(async db => {
      const tx = db.transaction(RECEIPTS, 'readwrite');
      const done = completed(tx);
      tx.objectStore(RECEIPTS).put({ id: snapshotId(repoId, sourceSha), repoId, sourceSha, receipt, savedAt: new Date().toISOString() });
      await done;
    });
  },
  async getCacheStats(repoId: string): Promise<{ count: number; totalBytes: number }> {
    const files = await withDB(async db => { const tx = db.transaction([LEGACY, SNAPSHOTS], 'readonly'); const current = await read<any>(tx.objectStore(LEGACY).get(repoId)); if (!current) return []; return (await read<Snapshot | undefined>(tx.objectStore(SNAPSHOTS).get(snapshotId(repoId, current.currentRef))))?.files || []; });
    return { count: files.length, totalBytes: files.reduce((n, f) => n + (f.size || 0), 0) };
  },
};
