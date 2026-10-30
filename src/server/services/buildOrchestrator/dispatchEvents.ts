import type { BuildSuspendReason } from '../../../shared/types/build';

/** Timeline event types the dispatcher writes. The database checks the format, not a closed list. */
export const DISPATCH_EVENT_TYPES = {
  taskLaunched: 'task.launched',
  taskLaunchDeferred: 'task.launch_deferred',
  taskCompleted: 'task.completed',
  taskFailed: 'task.failed',
  taskRequeued: 'task.requeued',
  completionDiscarded: 'task.completion_discarded',
  agentCancelFailed: 'agent.cancel_failed',
  runSuspended: 'run.suspended',
} as const;

/** Plain words for the requester, who may not be technical. */
export function suspensionMessage(reason: BuildSuspendReason): string {
  switch (reason) {
    case 'flag_disabled':
      return 'This build stopped because Build from prompt was switched off. Ask a platform admin to switch it back on, then resume.';
    case 'permission_revoked':
      return 'This build stopped because the person who started it can no longer run builds. Ask a project admin to restore access, then resume.';
    case 'configuration':
      return 'This build stopped because Apex could not prepare the next task. Contact a support contact for this project.';
    case 'repair_cap':
      return 'This build stopped because a task kept failing and no repair attempts are left.';
    case 'plan_invalid':
      return 'This build stopped because its plan no longer matches its tasks. Contact a support contact for this project.';
    case 'cost_cap':
      return 'This build stopped because it reached its cost limit.';
    case 'elapsed_cap':
      return 'This build stopped because it reached its time limit.';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
