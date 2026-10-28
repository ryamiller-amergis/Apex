/**
 * Plain-language wording for the Build Run View. The server sends stage tokens; this module owns
 * the sentences (design.md "Stage line copy" and "Exception copy"). Planning wording comes from
 * `buildPlanCopy`, which FEAT-007 owns.
 */
import type { BuildSuspendReason } from '../../shared/types/build';
import type {
  BuildCapView,
  BuildStageView,
  BuildSupportContactView,
  BuildTimingView,
} from '../../shared/types/buildView';
import { formatSupportContacts, planInvalidNotice, planningHeaderText } from '../../shared/buildPlanCopy';

export function stageText(stage: BuildStageView, repairAttempts: number): string {
  if (stage.kind === 'exception') {
    const key = stage.key;
    switch (key) {
      case 'suspended': return 'Suspended';
      case 'deployment_failed': return 'Deployment failed';
      case 'needs_developer': return 'Needs a developer';
      case 'failed': return 'Failed';
      case 'cancelled': return 'Cancelled';
      case 'accepted': return 'Accepted';
      default: {
        const unhandled: never = key;
        return unhandled;
      }
    }
  }
  const key = stage.key;
  switch (key) {
    case 'queued':
      return stage.queuePosition ? `Queued, number ${stage.queuePosition} in line` : 'Queued';
    case 'intake': return 'Intake';
    case 'planning': return planningHeaderText(repairAttempts);
    case 'building':
      return stage.tasks ? `Building, ${stage.tasks.merged} of ${stage.tasks.total} tasks` : 'Building';
    case 'checking': return 'Checking';
    case 'deploying': return 'Deploying';
    case 'preview_ready': return 'Preview ready';
    default: {
      const unhandled: never = key;
      return unhandled;
    }
  }
}

export interface ExceptionCopy {
  cause: string;
  /** Who to contact, or null when nobody needs to act. */
  contact: string | null;
  /** Who may resume a suspended build. */
  resume: string | null;
  /** True when the server sent a suspended build with no reason. */
  dataError: boolean;
}

const RESUME_LINE = 'The requester, a Project Admin or a Platform Admin can resume this build once the cause is cleared.';
const PROJECT_ADMIN = 'Contact a Project Admin.';
const PLATFORM_ADMIN = 'Contact a Platform Admin.';
const LIMIT_CAUSE = 'This build stopped because it reached a limit on revisions, time or parallel agents. It continues once the limit is raised and someone resumes it.';

function contactNames(contacts: readonly BuildSupportContactView[]): string {
  return formatSupportContacts(contacts.map((contact) => (
    contact.email ? `${contact.displayName} (${contact.email})` : contact.displayName
  )));
}

function suspendedCopy(reason: BuildSuspendReason, who: string): Pick<ExceptionCopy, 'cause' | 'contact'> {
  switch (reason) {
    case 'cost_cap':
      return {
        cause: 'This build stopped because it reached its cost limit. It continues once a Project Admin raises the limit and someone resumes it.',
        contact: PROJECT_ADMIN,
      };
    case 'elapsed_cap':
    case 'repair_cap':
      return { cause: LIMIT_CAUSE, contact: PROJECT_ADMIN };
    case 'flag_disabled':
      return {
        cause: 'Builds are turned off for now, so this build stopped. It continues after builds are turned back on and someone resumes it.',
        contact: PLATFORM_ADMIN,
      };
    case 'permission_revoked':
      return { cause: 'This build stopped because the person who started it can no longer run builds.', contact: PROJECT_ADMIN };
    case 'configuration':
      return { cause: "This build stopped because the project's Build settings are incomplete or changed.", contact: PROJECT_ADMIN };
    case 'plan_invalid':
      return { cause: planInvalidNotice({ kind: 'validation', contacts: [who] }), contact: `Contact ${who}.` };
    default: {
      const unhandled: never = reason;
      return unhandled;
    }
  }
}

export function exceptionCopy(
  stage: BuildStageView,
  contacts: readonly BuildSupportContactView[],
): ExceptionCopy | null {
  if (stage.kind === 'stage') return null;
  const who = contactNames(contacts);
  const key = stage.key;
  switch (key) {
    case 'suspended':
      if (!stage.suspendReason) {
        return {
          cause: `This build is suspended, but the reason is missing. This is a data error. Contact ${who}.`,
          contact: `Contact ${who}.`,
          resume: null,
          dataError: true,
        };
      }
      return { ...suspendedCopy(stage.suspendReason, who), resume: RESUME_LINE, dataError: false };
    case 'deployment_failed':
      return {
        cause: `Your feature was built and passed its checks, but deployment failed. ${who} have been notified.`,
        contact: `Contact ${who}.`,
        resume: null,
        dataError: false,
      };
    case 'needs_developer':
      return {
        cause: `Apex could not merge your change with the latest code. ${who} have been notified.`,
        contact: `Contact ${who}.`,
        resume: null,
        dataError: false,
      };
    case 'failed':
      return { cause: 'Apex could not finish this build.', contact: `Contact ${who}.`, resume: null, dataError: false };
    case 'cancelled':
      return { cause: 'This build was cancelled.', contact: null, resume: null, dataError: false };
    case 'accepted':
      return { cause: 'This build was accepted.', contact: null, resume: null, dataError: false };
    default: {
      const unhandled: never = key;
      return unhandled;
    }
  }
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

function formatTarget(seconds: number): string {
  return seconds < 3600 ? `${Math.round(seconds / 60)} min` : formatDuration(seconds);
}

export function elapsedLabel(timing: BuildTimingView): string {
  const label = timing.includesDeployment ? 'Elapsed (includes deployment)' : 'Elapsed';
  if (timing.elapsedSeconds === null) return `${label}: not started`;
  return `${label}: ${formatDuration(timing.elapsedSeconds)}`;
}

export function targetText(timing: BuildTimingView): string {
  if (timing.targetSeconds === null) return 'No delivery target yet';
  const target = formatTarget(timing.targetSeconds);
  return timing.state === 'over' ? `Taking longer than the usual ${target}` : `Target: ${target}`;
}

function usd(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : value;
}

export function capLines(caps: BuildCapView): Record<'cost' | 'revisions' | 'elapsed' | 'parallelism', string> {
  return {
    cost: `Estimated cost: ${usd(caps.cost.usedUsd)} of ${usd(caps.cost.limitUsd)}`,
    revisions: `Revisions: ${caps.revisions.used} of ${caps.revisions.limit}`,
    elapsed: `Time used: ${formatDuration(caps.elapsedSeconds.used)} of ${formatDuration(caps.elapsedSeconds.limit)}`,
    parallelism: `Parallel agents: ${caps.parallelism.used} of ${caps.parallelism.limit}`,
  };
}
