import { sourceOf, type ProjectSource, type RemoteSnapshot, type UploadTarget } from './projectModel';
import type { TargetHistory } from './accountRegistry';
import { sameTarget, targetHealthOf, type TargetHealth } from './targetLifecycle';
export interface BindingProject extends ProjectSource {
  origin?: ProjectSource; uploadTarget?: UploadTarget; forkScope?: 'current'|'full'; forkTarget?: UploadTarget;
  privateRepoUrl?: string; latestCommitSha: string; remoteSnapshot?: RemoteSnapshot;
  cloudPending?: unknown[]; creationReservation?: unknown; pendingSwitch?: unknown;
  targetHealth?: Record<string,TargetHealth>; accountState?: string; verification?: 'unchecked'|'checking'|'ready'|'error';
}
export function bindingLabel(project: BindingProject) {
  const target = project.uploadTarget || project.forkTarget;
  if (!target) return project.verification === 'error' ? '仓库核验失败' : project.verification === 'unchecked' ? '尚未核验账号仓库' : '尚未关联仓库';
  if (project.pendingSwitch) return '另存切换待完成';
  const pending=project.cloudPending?.length || project.creationReservation ? ' · 账号记录待完成' : '';
  const health = targetHealthOf(project,target);
  if (health && health.status !== 'available') return '远端目标异常';
  const synced = project.remoteSnapshot?.sourceSha === project.latestCommitSha && project.remoteSnapshot.branch === target.branch && sameTarget({...project.remoteSnapshot,id:project.remoteSnapshot.repoId},target);
  if (project.forkScope === 'full' || project.forkTarget) return (synced ? '已分叉 · 已同步' : '已分叉 · 待同步') + pending;
  const privateRepo = target.private === true || target.private === undefined && !!project.privateRepoUrl;
  return (synced ? privateRepo ? '私人仓库已同步' : '已关联仓库 · 已同步' : '已绑定 · 待更新／待上传') + pending;
}
export function switchedHistory(project: { uploadTarget?: UploadTarget; forkTarget?: UploadTarget; forkScope?: 'current'|'full'; branchTargets?: Record<string,UploadTarget>; targetHistory?: TargetHistory[] }, now: string) {
  const target = project.uploadTarget || project.forkTarget;
  if (!target) return project.targetHistory || [];
  return [...(project.targetHistory || []), {target:{id:target.id,owner:target.owner,repo:target.repo,private:target.private},kind:project.forkScope || 'upload' as const,bindings:Object.fromEntries(Object.entries(project.branchTargets || {}).filter(([,binding])=>sameTarget(binding,target)).map(([branch,binding])=>[branch,{branch:binding.branch,updatedAt:now}])),changedAt:now}];
}
