/**
 * Pure authorization and allowedActions computation for build run controls (FEAT-016, S3).
 */
import type { BuildRunStatus } from '../../shared/types/build';
import type {
  BuildAllowedActions,
  BuildSuspendReason,
} from '../../shared/types/buildRunControls';

export interface BuildRunAuthView {
  requestedByUserId: string;
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
}

export interface BuildActor {
  userId: string;
  isProjectAdmin: boolean;
  isSuperAdmin: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<BuildRunStatus> = new Set([
  'accepted',
  'cancelled',
  'failed',
]);

const NON_RESUMABLE_REASONS: ReadonlySet<BuildSuspendReason> = new Set([
  'plan_invalid',
  'cap_reached',
]);

export function canActOnBuild(run: BuildRunAuthView, actor: BuildActor): boolean {
  if (!actor.userId || actor.userId === 'anonymous') return false;
  if (actor.userId === run.requestedByUserId) return true;
  return Boolean(actor.isSuperAdmin || actor.isProjectAdmin);
}

export function computeAllowedActions(
  run: BuildRunAuthView,
  actor: BuildActor,
): BuildAllowedActions {
  if (!canActOnBuild(run, actor)) {
    return { cancel: false, resume: false };
  }

  const canCancel = !TERMINAL_STATUSES.has(run.status);
  const canResume =
    run.status === 'suspended'
    && run.suspendReason !== null
    && !NON_RESUMABLE_REASONS.has(run.suspendReason);

  return {
    cancel: canCancel,
    resume: canResume,
  };
}
