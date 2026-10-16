export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix); input.set(bytes, prefix.length);
  const digest = await crypto.subtle.digest('SHA-1', input);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Hash an exact Git tree locally, including nested directories and file modes. */
export async function gitTreeSha(files: Array<{ path: string; mode?: string; sha: string }>): Promise<string> {
  interface Tree { entries: Map<string, Tree | { sha: string; mode: string }> }
  const root: Tree = { entries: new Map() }, encoder = new TextEncoder();
  for (const file of files) {
    const parts = file.path.split('/'); let folder = root;
    for (const part of parts.slice(0, -1)) {
      const previous = folder.entries.get(part);
      if (previous && !('entries' in previous)) throw new Error('文件与目录路径冲突');
      if (!previous) folder.entries.set(part, { entries: new Map() });
      folder = folder.entries.get(part) as Tree;
    }
    const name = parts.at(-1)!;
    if (folder.entries.has(name) || !/^[a-f0-9]{40}$/.test(file.sha)) throw new Error('无效的文件树');
    folder.entries.set(name, { sha: file.sha, mode: file.mode || '100644' });
  }
  async function hash(tree: Tree): Promise<string> {
    const rows = await Promise.all([...tree.entries].map(async ([name, value]) => ({
      sort: encoder.encode(name + ('entries' in value ? '/' : '')),
      prefix: encoder.encode(`${'entries' in value ? '40000' : value.mode} ${name}\0`),
      sha: 'entries' in value ? await hash(value) : value.sha,
    })));
    rows.sort((a,b) => { for (let i=0;i<Math.min(a.sort.length,b.sort.length);i++) if(a.sort[i]!==b.sort[i]) return a.sort[i]-b.sort[i]; return a.sort.length-b.sort.length; });
    const size = rows.reduce((n,row)=>n+row.prefix.length+20,0), prefix = encoder.encode(`tree ${size}\0`), bytes = new Uint8Array(prefix.length+size);
    bytes.set(prefix); let offset=prefix.length;
    for(const row of rows) { bytes.set(row.prefix,offset);offset+=row.prefix.length;bytes.set(Uint8Array.from(row.sha.match(/../g)!,x=>parseInt(x,16)),offset);offset+=20; }
    return [...new Uint8Array(await crypto.subtle.digest('SHA-1',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  return hash(root);
}
