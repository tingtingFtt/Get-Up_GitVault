import type { UploadTarget, ProjectSource, RemoteSnapshot } from './projectModel';
import { sourceOf } from './projectModel';

export type TargetIdentity = { id?: number; owner: string; repo: string };
export type TargetHealth = TargetIdentity & {
  status: 'available' | 'unavailable' | 'auth' | 'forbidden' | 'limited' | 'identity-changed' | 'error';
  message: string; checkedAt: string;
};
export const targetKey = (target: TargetIdentity) => target.id ? `id:${target.id}` : `${target.owner}/${target.repo}`.toLowerCase();
export function sameTarget(a: TargetIdentity, b: TargetIdentity) {
  return a.id && b.id ? a.id === b.id : a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}
type TargetProject = ProjectSource & {
  origin?: ProjectSource; uploadTarget?: UploadTarget; branchTargets?: Record<string, UploadTarget>;
  forkTarget?: TargetIdentity & { branch: string; htmlUrl: string; branches?: string[]; token?: string };
  forkScope?: 'current' | 'full'; privateRepoUrl?: string; branchUploadPending?: boolean;
  targetHealth?: Record<string, TargetHealth>; lastUploadedToPrivateAt?: string; repoMeta: { htmlUrl?: string };
  detachedTargets?: TargetIdentity[]; creationReservation?: { target: TargetIdentity }; 
  remoteSnapshot?: RemoteSnapshot; savedCopies?: RemoteSnapshot[]; backups?: Array<{ commitSha: string; branch?: string; remoteSnapshot?: RemoteSnapshot }>;
};
export function projectTargets(project: TargetProject): TargetIdentity[] {
  const targets: TargetIdentity[] = [project.uploadTarget, project.forkTarget, project.creationReservation?.target, ...Object.values(project.branchTargets || {})].filter((value): value is NonNullable<typeof value> => !!value);
  if (project.privateRepoUrl && !project.uploadTarget) {
    const match = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(project.privateRepoUrl);
    if (match) targets.push({ owner: match[1], repo: match[2].replace(/\.git$/i, '') });
  }
  return targets.filter((target, index) => !targets.slice(0, index).some(other => sameTarget(other, target))).map(({ id, owner, repo }) => ({ id, owner, repo }));
}
export function targetHealthOf(project: TargetProject, target: TargetIdentity) {
  return project.targetHealth?.[targetKey(target)] || Object.values(project.targetHealth || {}).find(health => sameTarget(health, target));
}
/** Detach only current bindings. Never rewrite historical snapshots or remove cached files. */
export function detachedTarget<T extends TargetProject>(project: T, target: TargetIdentity): T & TargetProject {
  const detachedTargets = [...(project.detachedTargets || []).filter(item => !sameTarget(item, target)), { id: target.id, owner: target.owner, repo: target.repo }];
  if (!projectTargets(project).some(item => sameTarget(item, target))) {
    const historical = [project.remoteSnapshot, ...(project.savedCopies || []), ...(project.backups || []).map(version => version.remoteSnapshot)];
    // A sibling source record may contain only a historical copy of this target.
    // Keep that receipt but prevent a later import from offering it as a live base.
    return historical.some(snapshot => snapshot && sameTarget({ ...snapshot, id: snapshot.repoId }, target)) ? { ...project, detachedTargets } : project;
  }
  const uploadRemoved = !!project.uploadTarget && sameTarget(project.uploadTarget, target);
  const forkRemoved = !!project.forkTarget && sameTarget(project.forkTarget, target);
  const branchTargets = project.branchTargets ? Object.fromEntries(Object.entries(project.branchTargets).filter(([, binding]) => !sameTarget(binding, target))) : undefined;
  const uploadTarget = uploadRemoved ? branchTargets?.[sourceOf(project).branch] : project.uploadTarget;
  const health = Object.fromEntries(Object.entries(project.targetHealth || {}).filter(([, value]) => !sameTarget(value, target)));
  const managedRemoved = !!project.origin && project.owner.toLowerCase() === target.owner.toLowerCase() && project.repo.toLowerCase() === target.repo.toLowerCase();
  const source = sourceOf(project);
  const privateRemoved = uploadRemoved || project.privateRepoUrl?.replace(/\/$/, '').toLowerCase() === `https://github.com/${target.owner}/${target.repo}`.toLowerCase();
  return { ...project, uploadTarget, branchTargets,
    forkTarget: forkRemoved ? undefined : project.forkTarget,
    forkScope: forkRemoved || uploadRemoved ? (uploadTarget?.kind === 'current' ? 'current' : undefined) : project.forkScope,
    privateRepoUrl: privateRemoved ? undefined : project.privateRepoUrl,
    branchUploadPending: uploadRemoved ? false : project.branchUploadPending,
    lastUploadedToPrivateAt: uploadRemoved ? undefined : project.lastUploadedToPrivateAt,
    targetHealth: health,
    detachedTargets,
    ...(managedRemoved ? { owner: source.owner, repo: source.repo, url: source.url, repoMeta: { ...project.repoMeta, htmlUrl: source.url } } : {}),
  };
}
