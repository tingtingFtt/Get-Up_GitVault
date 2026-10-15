/**
 * Local project cache utility using HTML5 IndexedDB
 * Allows storing full project source code, file trees, and binary assets
 * persistent across browser sessions and APK restarts without 5MB limits.
 */

export interface CachedFile {
  path: string;
  content: string;
  isBase64: boolean;
  size?: number;
}

const DB_NAME = 'GitVault_Storage_v1';
const DB_VERSION = 1;
const STORE_NAME = 'project_files';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB 不支持或不可用'));
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event: any) => {
      const db = event.target.result as IDBDatabase;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'repoId' });
      }
    };

    request.onsuccess = (event: any) => {
      resolve(event.target.result);
    };

    request.onerror = (event: any) => {
      reject(event.target.error || new Error('无法打开 IndexedDB 本地数据库'));
    };
  });
}

// Memory fallback in case IndexedDB is restricted in some environments
const memoryCache = new Map<string, CachedFile[]>();

export const localCache = {
  /**
   * Save complete project files to local IndexedDB storage
   */
  async saveProjectFiles(repoId: string, files: CachedFile[]): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const item = {
          repoId,
          files,
          fileCount: files.length,
          savedAt: new Date().toISOString()
        };
        const request = store.put(item);

        request.onsuccess = () => {
          memoryCache.set(repoId, files);
          resolve();
        };

        request.onerror = (err) => {
          console.warn('IndexedDB put error, falling back to memory:', err);
          memoryCache.set(repoId, files);
          resolve();
        };
      });
    } catch (e) {
      console.warn('IndexedDB unavailable, using in-memory store:', e);
      memoryCache.set(repoId, files);
    }
  },

  /**
   * Get all files of a project from local storage
   */
  async getProjectFiles(repoId: string): Promise<CachedFile[]> {
    if (memoryCache.has(repoId)) {
      return memoryCache.get(repoId)!;
    }

    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(repoId);

        request.onsuccess = (event: any) => {
          const item = event.target.result;
          if (item && Array.isArray(item.files)) {
            memoryCache.set(repoId, item.files);
            resolve(item.files);
          } else {
            resolve([]);
          }
        };

        request.onerror = () => {
          resolve([]);
        };
      });
    } catch {
      return [];
    }
  },

  /**
   * Get a single file content by relative path from local storage
   */
  async getProjectFile(repoId: string, filePath: string): Promise<CachedFile | null> {
    const files = await this.getProjectFiles(repoId);
    const cleanPath = filePath.replace(/^\/+/, '');
    const found = files.find(f => f.path === cleanPath || f.path === filePath);
    return found || null;
  },

  /**
   * Delete cached files for a specific project
   */
  async deleteProjectFiles(repoId: string): Promise<void> {
    memoryCache.delete(repoId);
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(repoId);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
      });
    } catch {
      // ignore
    }
  },

  /**
   * Get project file statistics from local storage
   */
  async getCacheStats(repoId: string): Promise<{ count: number; totalBytes: number }> {
    const files = await this.getProjectFiles(repoId);
    let totalBytes = 0;
    for (const f of files) {
      totalBytes += (f.size || f.content?.length || 0);
    }
    return {
      count: files.length,
      totalBytes
    };
  }
};
