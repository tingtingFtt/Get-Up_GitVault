import type { RepoEntry } from './githubClient';

export interface ProjectSource { owner: string; repo: string; url: string; branch: string }
export interface UploadTarget { id?: number; owner: string; repo: string; branch: string; purgeAfterUpload: boolean; token?: string; kind?: 'upload' | 'current' | 'full' }
export interface RemoteSnapshot { repoId?: number; owner: string; repo: string; branch: string; commitSha: string; sourceSha: string; htmlUrl: string }
export interface BackupVersion {
  remoteSnapshot?: RemoteSnapshot;
  id: string; versionNumber: number; tag: string; annotation: string;
  commitSha: string; commitMessage: string; commitAuthor: string; commitDate: string; backedUpAt: string; tree: RepoEntry[];
  isReleased?: boolean; releaseUrl?: string; isCachePurged?: boolean;
}
export function sourceOf(project: ProjectSource & { origin?: ProjectSource }): ProjectSource {
  return project.origin || { owner: project.owner, repo: project.repo, url: project.url, branch: project.branch };
}
export function savedSnapshot(project: { remoteSnapshot?: RemoteSnapshot; backups: BackupVersion[]; savedCopies?: RemoteSnapshot[] }, sha: string) {
  return [project.remoteSnapshot, ...project.backups.map(b => b.remoteSnapshot), ...(project.savedCopies || [])].find(s => s?.sourceSha === sha);
}
export function archiveVersion(project: { latestCommitSha: string; commitMessage: string; commitAuthor: string; commitDate: string; tree: RepoEntry[]; remoteSnapshot?: RemoteSnapshot; isCachePurged?: boolean; backups: BackupVersion[] }): BackupVersion {
  return { id: `backup-${crypto.randomUUID()}`, versionNumber: project.backups.length + 1, tag: `backup-${project.latestCommitSha.slice(0, 12)}-${Date.now()}`, annotation: project.commitMessage.slice(0, 60), commitSha: project.latestCommitSha, commitMessage: project.commitMessage, commitAuthor: project.commitAuthor, commitDate: project.commitDate, tree: project.tree, remoteSnapshot: project.remoteSnapshot, isCachePurged: project.isCachePurged, backedUpAt: new Date().toISOString() };
}
/** Rename every stored reference to the same repository, including historical snapshots. */
export function renamedProject<T extends { uploadTarget?: UploadTarget; forkTarget?: { id?: number; owner: string; repo: string; branch: string; htmlUrl: string }; owner: string; repo: string; url: string; origin?: ProjectSource; privateRepoUrl?: string; repoMeta: { htmlUrl?: string }; remoteSnapshot?: RemoteSnapshot; backups: BackupVersion[]; savedCopies?: RemoteSnapshot[] }>(project: T, previous: UploadTarget, next: { id?: number; owner: string; repo: string; htmlUrl: string }): T {
  const matches = (value: { id?: number; repoId?: number; owner: string; repo: string } | undefined) => !!value && (previous.id && (value.id || value.repoId) ? previous.id === (value.id || value.repoId) : value.owner.toLowerCase() === previous.owner.toLowerCase() && value.repo.toLowerCase() === previous.repo.toLowerCase());
  const snapshot = (value: RemoteSnapshot | undefined) => matches(value) ? { ...value!, owner: next.owner, repo: next.repo, repoId: next.id, htmlUrl: `${next.htmlUrl}/tree/${value!.branch}` } : value;
  const isManaged = !!project.origin && matches(project);
  return { ...project,
    ...(isManaged ? { owner: next.owner, repo: next.repo, url: next.htmlUrl, repoMeta: { ...project.repoMeta, htmlUrl: next.htmlUrl } } : {}),
    uploadTarget: matches(project.uploadTarget) ? { ...project.uploadTarget!, ...next } : project.uploadTarget,
    forkTarget: matches(project.forkTarget) ? { ...project.forkTarget!, ...next } : project.forkTarget,
    privateRepoUrl: matches(project.uploadTarget) ? next.htmlUrl : project.privateRepoUrl,
    remoteSnapshot: snapshot(project.remoteSnapshot),
    backups: project.backups.map(b => ({ ...b, remoteSnapshot: snapshot(b.remoteSnapshot) })),
    savedCopies: project.savedCopies?.map(s => snapshot(s)!),
  };
}
