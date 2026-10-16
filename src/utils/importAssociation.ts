import type { RepoEntry } from './githubClient';
import { sourceOf, type ProjectSource, type UploadTarget, type RemoteSnapshot } from './projectModel';
import { sameTarget, type TargetIdentity } from './targetLifecycle';

type KnownProject = ProjectSource & {
  id: string; remark?: string; origin?: ProjectSource; uploadTarget?: UploadTarget;
  branchTargets?: Record<string, UploadTarget>; branchUploadPending?: boolean;
  forkTarget?: { id?: number; owner: string; repo: string; branch: string; branches?: string[] };
  savedCopies?: RemoteSnapshot[];
  latestCommitSha?: string; backups?: Array<{ commitSha: string; branch?: string }>;
  detachedTargets?: TargetIdentity[];
};
export interface ImportCandidate {
  key: string; projectId: string; remark: string; source: ProjectSource;
  target: UploadTarget; fullFork: boolean; branches?: string[];
}
export function sameRepository(a: { owner: string; repo: string }, b: { owner: string; repo: string }) {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}
/** Only recorded provenance is evidence of a relationship; a matching repository name is not. */
export function importCandidates(projects: KnownProject[], incoming: ProjectSource): ImportCandidate[] {
  const found = new Map<string, ImportCandidate & { exact: boolean }>();
  for (const project of projects) {
    const source = sourceOf(project);
    const bindings: Array<{ target: UploadTarget; branch?: string; fullFork?: boolean; branches?: string[] }> = [];
    for (const [branch, target] of Object.entries(project.branchTargets || {})) bindings.push({ target, branch });
    if (project.uploadTarget && !project.branchUploadPending) bindings.push({ target: project.uploadTarget, branch: source.branch });
    if (project.forkTarget) bindings.push({ target: { ...project.forkTarget, kind: 'full', purgeAfterUpload: false }, fullFork: true, branches: project.forkTarget.branches });
    for (const copy of project.savedCopies || []) {
      if (project.detachedTargets?.some(target => sameTarget(target, { ...copy, id: copy.repoId }))) continue;
      const branch = copy.sourceSha === project.latestCommitSha ? source.branch : project.backups?.find(version => version.commitSha === copy.sourceSha)?.branch;
      bindings.push({ branch: branch || (copy.branch === source.branch ? source.branch : undefined), target: { id: copy.repoId, owner: copy.owner, repo: copy.repo, branch: copy.branch, kind: 'current', purgeAfterUpload: false } });
    }
    for (const binding of bindings) {
      const isSource = sameRepository(source, incoming);
      const isDestination = !isSource && sameRepository(binding.target, incoming);
      if (!isSource && !isDestination) continue;
      // A destination URL uses the reverse of a confirmed branch mapping.
      const selectedSource = isSource ? incoming : { ...source, branch: binding.target.branch === incoming.branch ? binding.branch || incoming.branch : incoming.branch };
      const exact = binding.branch === selectedSource.branch;
      const target = { ...binding.target, branch: isDestination ? incoming.branch : exact ? binding.target.branch : incoming.branch };
      // Ignore self bindings; they cannot provide a separate upload/sync destination.
      if (sameRepository(target, selectedSource)) continue;
      const key = `${selectedSource.owner}/${selectedSource.repo}`.toLowerCase() + `:${selectedSource.branch}=>${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
      const prior = found.get(key);
      const fullFork = binding.fullFork || target.kind === 'full';
      const candidate = { key, projectId: project.id, remark: project.remark || '', source: selectedSource, target, fullFork: !!fullFork, branches: binding.branches || (fullFork ? project.forkTarget?.branches : undefined), exact };
      if (!prior || exact && !prior.exact) found.set(key, candidate);
      else if (fullFork) found.set(key, { ...prior, fullFork: true, branches: candidate.branches || prior.branches });
    }
  }
  return [...found.values()].map(({ exact, ...candidate }) => ({ ...candidate, target: { ...candidate.target, ...(candidate.fullFork ? { kind: 'full' as const } : {}) } }));
}

/** Counts describe the next exact source snapshot relative to the destination. */
export function compareImportTrees(source: RepoEntry[], destination: RepoEntry[], generatedMetadata = false) {
  const entries = (tree: RepoEntry[]) => new Map(tree.filter(item => item.type !== 'tree').map(item => [item.path, item]));
  const from = entries(destination), to = entries(source);
  if (generatedMetadata && !to.has('GITVAULT_METADATA.md')) from.delete('GITVAULT_METADATA.md');
  const added: string[] = [], modified: string[] = [], removed: string[] = [];
  for (const [path, item] of to) {
    const old = from.get(path);
    if (!old) added.push(path);
    else if (old.sha !== item.sha || old.mode !== item.mode || old.type !== item.type) modified.push(path);
  }
  for (const path of from.keys()) if (!to.has(path)) removed.push(path);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}
