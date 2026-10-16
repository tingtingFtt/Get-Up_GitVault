/** Durable, version-aware project cache. File contents are shared by Git blob SHA. */
import { gitBlobSha } from './gitFiles';

export interface CachedFile {
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
interface Snapshot { id: string; repoId: string; ref: string; files: Omit<CachedFile, 'content'>[]; savedAt: string }

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
  try { return await task(db); } finally { db.close(); }
}
export const transferCache = {
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
      for (const item of await read<any[]>(store.index('commitSha').getAll(commitSha))) store.delete(item.id);
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
    await withDB(async db => {
      const tx = db.transaction(UPLOADS, 'readwrite'), done = completed(tx);
      tx.objectStore(UPLOADS).put({ id: `${repoId}:${sha}`, repoId, sha, savedAt: Date.now() });
      await done;
    });
  },
};
export const localCache = {
  async saveProjectFiles(repoId: string, files: CachedFile[], ref = 'legacy'): Promise<void> {
    const prepared: CachedFile[] = [];
    for (const file of files) {
      const bytes = file.isBase64 ? Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0)) : new TextEncoder().encode(file.content);
      const sha = await gitBlobSha(bytes);
      if (file.sha && file.sha !== sha) throw new Error(`缓存文件内容与版本不一致: ${file.path}`);
      prepared.push({ ...file, sha, size: bytes.length });
    }
    await withDB(async db => {
      const tx = db.transaction([SNAPSHOTS, CONTENTS, LEGACY, TRANSFERS], 'readwrite');
      const done = completed(tx);
      for (const file of prepared) tx.objectStore(CONTENTS).put({ sha: file.sha, content: file.content, isBase64: file.isBase64 });
      tx.objectStore(SNAPSHOTS).put({ id: snapshotId(repoId, ref), repoId, ref, savedAt: new Date().toISOString(), files: prepared.map(({ content, ...file }) => file) });
      tx.objectStore(LEGACY).put({ repoId, currentRef: ref });
      const parts = await read<any[]>(tx.objectStore(TRANSFERS).index('commitSha').getAll(ref));
      for (const part of parts) tx.objectStore(TRANSFERS).delete(part.id);
      await done;
    });
  },
  async getProjectFiles(repoId: string, ref?: string): Promise<CachedFile[]> {
    return withDB(async db => {
      const tx = db.transaction([LEGACY, SNAPSHOTS, CONTENTS], 'readonly');
      const legacy = await read<any>(tx.objectStore(LEGACY).get(repoId));
      // Old records have no trusted version identity. Callers validate them against their file tree.
      if (!ref && Array.isArray(legacy?.files)) return legacy.files;
      const selectedRef = ref || legacy?.currentRef;
      if (!selectedRef) return [];
      const snapshot = await read<Snapshot | undefined>(tx.objectStore(SNAPSHOTS).get(snapshotId(repoId, selectedRef)));
      if (!snapshot) return [];
      const files = await Promise.all(snapshot.files.map(async file => {
        const value = await read<any>(tx.objectStore(CONTENTS).get(file.sha!));
        return value ? { ...file, content: value.content, isBase64: value.isBase64 } : null;
      }));
      if (files.some(f => !f)) throw new Error('本地缓存不完整，请重新获取该版本');
      return files as CachedFile[];
    });
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
      const value = await read<any>(tx.objectStore(CONTENTS).get(file.sha!));
      return value ? { ...file, content: value.content, isBase64: value.isBase64 } : null;
    });
  },
  async deleteProjectFiles(repoId: string, ref?: string): Promise<void> {
    await withDB(async db => {
      const tx = db.transaction([LEGACY, SNAPSHOTS, CONTENTS], 'readwrite');
      const done = completed(tx);
      const snapshots = tx.objectStore(SNAPSHOTS);
      const all = await read<Snapshot[]>(snapshots.getAll());
      const removed = all.filter(s => s.repoId === repoId && (!ref || s.ref === ref));
      for (const snapshot of removed) snapshots.delete(snapshot.id);
      const remaining = all.filter(s => !removed.some(r => r.id === s.id));
      const referenced = new Set(remaining.flatMap(s => s.files.map(f => f.sha)));
      for (const snapshot of removed) for (const file of snapshot.files) if (!referenced.has(file.sha)) tx.objectStore(CONTENTS).delete(file.sha!);
      const current = await read<any>(tx.objectStore(LEGACY).get(repoId));
      if (!ref || current?.currentRef === ref || current?.files) tx.objectStore(LEGACY).delete(repoId);
      await done;
    });
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
    const files = await this.getProjectFiles(repoId);
    return { count: files.length, totalBytes: files.reduce((n, f) => n + (f.size || 0), 0) };
  },
};
