import { BUILD_CONCURRENCY_LIMITS, BUILD_RUN_SLOT_STATUSES } from '../../../shared/types/build';
import type { BuildSuspendReason } from '../../../shared/types/build';

export interface AdmissionCounts {
  projectSlots: number;
  platformSlots: number;
  olderQueued: number;
}

export interface AdmissionDecision {
  status: 'intake' | 'queued';
  queueReason: 'project_limit' | 'platform_limit' | null;
  queuePosition: number | null;
}

export function decideAdmission(counts: AdmissionCounts): AdmissionDecision {
  const overProject = counts.projectSlots >= BUILD_CONCURRENCY_LIMITS.perProject;
  const overPlatform = counts.platformSlots >= BUILD_CONCURRENCY_LIMITS.platform;
  const behindQueue = counts.olderQueued > 0;
  if (!overProject && !overPlatform && !behindQueue) {
    return { status: 'intake', queueReason: null, queuePosition: null };
  }
  return {
    status: 'queued',
    queueReason: overProject ? 'project_limit' : overPlatform ? 'platform_limit' : null,
    queuePosition: counts.olderQueued + 1,
  };
}

export type QueuedPromotion = 'stay' | 'suspend-permission' | 'suspend-configuration' | 'promote';

export function classifyQueuedBuild(input: {
  flagOn: boolean;
  allowed: boolean;
  hasRunPermission: boolean;
}): QueuedPromotion {
  if (!input.flagOn) return 'stay';
  if (!input.hasRunPermission) return 'suspend-permission';
  if (!input.allowed) return 'suspend-configuration';
  return 'promote';
}

export function suspendReasonFor(decision: QueuedPromotion): BuildSuspendReason | null {
  if (decision === 'suspend-permission') return 'permission_revoked';
  if (decision === 'suspend-configuration') return 'configuration';
  return null;
}

export function slotStatuses(): readonly string[] {
  return BUILD_RUN_SLOT_STATUSES;
}

export interface QueuedBuild {
  id: string;
  project: string;
  repository: string;
  requestedByUserId: string;
  prompt: string;
  skillSettingsId: string | null;
  queuedAt: string;
}

export interface PromotionIo {
  transaction<T>(fn: (tx: PromotionTx) => Promise<T>): Promise<T>;
  launch(build: QueuedBuild): Promise<void>;
}

export interface PromotionTx {
  lock(): Promise<void>;
  listQueued(): Promise<QueuedBuild[]>;
  projectSlots(project: string): Promise<number>;
  platformSlots(): Promise<number>;
  checks(build: QueuedBuild): Promise<{ flagOn: boolean; allowed: boolean; hasRunPermission: boolean }>;
  markIntake(id: string): Promise<boolean>;
  suspend(id: string, reason: BuildSuspendReason): Promise<void>;
}

/**
 * Promotes the oldest queued builds that fit the caps. Flag-off builds stay queued.
 * A lost permission or allow-list entry suspends the build. Playbook start happens
 * after the transaction commits.
 */
export async function promoteQueuedBuilds(io: PromotionIo): Promise<string[]> {
  const pending = await io.transaction(async (tx) => {
    await tx.lock();
    const queued = await tx.listQueued();
    const projectSlots = new Map<string, number>();
    let platform = await tx.platformSlots();
    const ready: QueuedBuild[] = [];
    for (const build of queued) {
      if (!projectSlots.has(build.project)) {
        projectSlots.set(build.project, await tx.projectSlots(build.project));
      }
      const decision = classifyQueuedBuild(await tx.checks(build));
      const reason = suspendReasonFor(decision);
      if (reason) {
        await tx.suspend(build.id, reason);
        continue;
      }
      if (decision !== 'promote') continue;
      const projectCount = projectSlots.get(build.project) ?? 0;
      if (
        projectCount >= BUILD_CONCURRENCY_LIMITS.perProject
        || platform >= BUILD_CONCURRENCY_LIMITS.platform
      ) {
        continue;
      }
      const moved = await tx.markIntake(build.id);
      if (!moved) continue;
      projectSlots.set(build.project, projectCount + 1);
      platform += 1;
      ready.push(build);
    }
    return ready;
  });

  const promoted: string[] = [];
  for (const build of pending) {
    await io.launch(build);
    promoted.push(build.id);
  }
  return promoted;
}
