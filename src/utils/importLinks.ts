import { parseRepository } from './githubClient';

export interface ImportLink {
  input: string;
  url?: string;
  status: 'pending' | 'downloading' | 'success' | 'skipped' | 'error';
  message?: string;
}

// Batch imports deliberately discard tree/blob refs and use the repository default branch.
export function parseImportLinks(text: string): ImportLink[] {
  const seen = new Set<string>();
  return text.split(/[\s,，;；]+/).filter(Boolean).map(input => {
    try {
      const { owner, repo } = parseRepository(input);
      const key = `${owner}/${repo}`.toLowerCase();
      const url = `https://github.com/${owner}/${repo}`;
      if (seen.has(key)) return { input, url, status: 'skipped', message: '重复链接，已跳过' };
      seen.add(key);
      return { input, url, status: 'pending' };
    } catch (error) { return { input, status: 'error', message: (error as Error).message }; }
  });
}
