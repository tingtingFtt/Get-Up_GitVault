import { parseRepository } from './githubClient';

export interface ImportLink {
  input: string;
  url?: string;
  remark?: string;
  status: 'pending' | 'downloading' | 'success' | 'skipped' | 'error' | 'cancelled';
  message?: string;
}

// Batch imports deliberately discard tree/blob refs and use the repository default branch.
export function parseImportLinks(text: string): ImportLink[] {
  const seen = new Set<string>();
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(input => {
    try {
      const parts = input.split(/\s+/);
      const link = parts.pop()!;
      const remark = parts.join(' ').trim();
      if (/https?:\/\//i.test(remark)) throw new Error('每行只能填写一个链接，可在链接前填写备注名');
      const { owner, repo } = parseRepository(link);
      if (/[，,;；]/.test(link)) throw new Error('每行只能填写一个链接，请换行分隔');
      const key = `${owner}/${repo}`.toLowerCase();
      const url = `https://github.com/${owner}/${repo}`;
      if (seen.has(key)) return { input, url, remark, status: 'skipped', message: '重复链接，已跳过' };
      seen.add(key);
      return { input, url, remark, status: 'pending' };
    } catch (error) { return { input, status: 'error', message: (error as Error).message }; }
  });
}
