/**
 * Pure notification copy builder for the five build events (FEAT-016, PBI-037, TBI-030 / S3).
 */
import type {
  BuildNotificationKind,
  BuildSuspendReason,
} from '../../shared/types/buildRunControls';
import { redactText } from './buildRedactionService';

export interface BuildNotificationCopyContext {
  buildRunId: string;
  featureTitle: string;
  revisionNumber?: number;
  reason?: BuildSuspendReason;
  failedStage?: string;
  riskDecisionCount?: number;
}

export function suspensionReasonPlainMessage(
  reason: BuildSuspendReason | undefined,
): string {
  switch (reason) {
    case 'cost_cap':
      return 'This build reached its cost limit. Ask a Project Admin to raise the limit, then resume.';
    case 'elapsed_cap':
      return 'This build used its 4 hours of build time for this revision. Resume to continue once the limit is raised.';
    case 'parallelism_cap':
      return 'This build exceeded its parallel agent limit. Resume to continue.';
    case 'cap_reached':
    case 'repair_cap':
      return 'This build reached its repair or revision limit. Contact a Project Admin.';
    case 'flag_disabled':
      return 'Builds are paused by a Platform Admin. You can resume once builds are back on.';
    case 'permission_revoked':
      return 'Your access to run builds was removed. Resume works once it is restored.';
    case 'configuration':
      return 'A setting this build needs is missing or changed. A support contact can fix it, then resume.';
    case 'plan_invalid':
      return 'Apex could not produce a valid plan. Cancel this build or ask a support contact.';
    default:
      return 'This build is paused.';
  }
}

export function buildNotificationCopy(
  kind: BuildNotificationKind,
  context: BuildNotificationCopyContext,
): { title: string; body: string; link: string } {
  const safeTitle = redactText(context.featureTitle.trim() || 'your feature').slice(0, 200);
  const link = `/builds/${encodeURIComponent(context.buildRunId)}`;

  switch (kind) {
    case 'build_started':
      return {
        title: 'Your build has started',
        body: redactText(`Apex is planning "${safeTitle}".`),
        link,
      };
    case 'preview_ready':
      return {
        title: 'Your build preview is ready',
        body: redactText(
          `Revision ${context.revisionNumber ?? 1} of "${safeTitle}" is ready to review.`,
        ),
        link,
      };
    case 'run_suspended': {
      const sentence = suspensionReasonPlainMessage(context.reason);
      return {
        title: 'Your build is paused',
        body: redactText(`${sentence} Open the build to resume it.`),
        link,
      };
    }
    case 'deployment_failed': {
      const safeStage = redactText(context.failedStage?.trim() || 'deploy').slice(0, 100);
      return {
        title: 'A build failed to deploy',
        body: redactText(
          `"${safeTitle}" failed at ${safeStage}. Open the build for the error and pipeline link.`,
        ),
        link,
      };
    }
    case 'pull_request_created':
      return {
        title: 'Your pull request is ready',
        body: redactText(
          `"${safeTitle}" has a pull request with ${context.riskDecisionCount ?? 0} risk decisions listed for reviewers.`,
        ),
        link,
      };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
