/** Metadata is a hint until the user accepts the destination. Never scan prose for links. */
export function readMetadataSource(text: string): { owner: string; repo: string } | undefined {
  const lines = text.trim().split(/\r?\n/);
  const marker = lines.filter(line => line.startsWith('<!-- gitvault-source:v1 '));
  if (marker.length) {
    if (marker.length !== 1) return undefined;
    try {
      const source = JSON.parse(marker[0].replace(/^<!-- gitvault-source:v1 /, '').replace(/ -->$/, ''));
      if (typeof source?.owner==='string' && typeof source.repo==='string' && /^[\w.-]+$/.test(source.owner) && /^[\w.-]+$/.test(source.repo)) return { owner: source.owner, repo: source.repo };
    } catch { /* malformed explicit metadata must not fall back to prose */ }
    return undefined;
  }
  // Older uploads put their original source URL in the final nonempty line.
  const last = lines.at(-1)?.trim() || '';
  const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(last);
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

export function sourceMarker(url?: string): string {
  const source = url && readMetadataSource(url);
  return source ? `<!-- gitvault-source:v1 ${JSON.stringify(source)} -->` : '';
}
