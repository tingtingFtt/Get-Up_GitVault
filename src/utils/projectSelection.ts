import { sourceOf, type ProjectSource, type UploadTarget } from './projectModel';
import { projectTargets, targetHealthOf, targetKey, type TargetHealth, type TargetIdentity } from './targetLifecycle';

type SelectionProject = ProjectSource & {
  id: string; origin?: ProjectSource; repoMeta: { htmlUrl?: string }; hasUpdate?: boolean;
  uploadTarget?: UploadTarget; branchTargets?: Record<string, UploadTarget>; privateRepoUrl?: string;
  forkScope?: 'current' | 'full'; forkTarget?: TargetIdentity & { branch: string; htmlUrl: string };
  creationReservation?: { target: TargetIdentity }; pendingSwitch?: unknown;
  cloudPending?: unknown[]; accountState?: string; lastUploadedToPrivateAt?: string;
  targetHealth?: Record<string, TargetHealth>;
};
export type ProjectSelection = 'unuploaded' | 'unforked' | 'updates' | 'sync';

/** Selection is local only. Execution still checks the signed-in account and remote identity. */
export function projectSelections<T extends SelectionProject>(visible: T[], all: T[]): Record<ProjectSelection, string[]> {
  const boundIds = new Set<number>(), boundNames = new Set<string>(), boundUnknownNames = new Set<string>();
  const nameOf = (source: ProjectSource) => `${source.owner}/${source.repo}`.toLowerCase();
  const hasRelationship = (project: T) => !!(projectTargets(project).length || project.pendingSwitch || project.cloudPending?.length || project.accountState || project.lastUploadedToPrivateAt || project.forkScope);
  for (const project of all) {
    if (!hasRelationship(project)) continue;
    const source = sourceOf(project), name = nameOf(source);
    boundNames.add(name);
    if (source.repositoryId) boundIds.add(source.repositoryId);
    else boundUnknownNames.add(name);
  }
  const first = visible.filter(project => {
    const source = sourceOf(project), name = nameOf(source);
    return !hasRelationship(project) && !(source.repositoryId ? boundIds.has(source.repositoryId) || boundUnknownNames.has(name) : boundNames.has(name));
  }).map(project => project.id);
  const sync = new Map<string, T>();
  for (const project of visible) {
    if (!(project.forkScope || project.forkTarget) || project.creationReservation || project.pendingSwitch) continue;
    const targets = projectTargets(project);
    if (!targets.length || targets.some(target => { const health = targetHealthOf(project, target); return health && health.status !== 'available'; })) continue;
    const target = project.forkTarget || project.uploadTarget;
    if (!target) continue;
    const full = project.forkScope === 'full' || !!project.forkTarget;
    const key = `${targetKey(target)}:${full ? '*' : JSON.stringify(target.branch)}`;
    const previous = sync.get(key);
    // Prefer the managed copy to its source row, so receipts and local snapshots stay current.
    if (!previous || !previous.uploadTarget && project.uploadTarget) sync.set(key, project);
  }
  return { unuploaded: first, unforked: [...first], updates: visible.filter(project => project.hasUpdate).map(project => project.id), sync: [...sync.values()].map(project => project.id) };
}
