import { DISPATCH_EVENT_TYPES } from './dispatchEvents';
import type { DispatchStore } from './dispatchStore';

export interface TaskFailureInput {
  buildRunId: string;
  revisionId: string;
  headKey: string;
  taskIds: string[];
  /** Plain words for the timeline. Never a prompt or a snapshot. */
  detail: string;
  /** Repeats with the same key write no second event. */
  dedupeKey: string;
  /** When true, suspend immediately instead of spinning up a fresh duplicate agent. */
  noAutoRequeue?: boolean;
}

export type TaskFailureResult = 'requeued' | 'suspended' | 'already_handled';

export type TaskFailurePolicy = (input: TaskFailureInput) => Promise<TaskFailureResult>;

/**
 * Marks the unit failed and uses one repair attempt. With an attempt left the
 * unit goes back to ready; with none left the run suspends with `repair_cap`.
 */
export function createTaskFailurePolicy(deps: {
  store: DispatchStore;
  track: (name: string, props: Record<string, string>) => void;
}): TaskFailurePolicy {
  return async (input) => {
    const moved = await deps.store.markFailed(input.taskIds);
    if (moved === 0) return 'already_handled';

    await deps.store.appendEvent({
      buildRunId: input.buildRunId,
      buildRevisionId: input.revisionId,
      eventType: DISPATCH_EVENT_TYPES.taskFailed,
      severity: 'error',
      message: input.detail,
      detail: { taskKey: input.headKey },
      dedupeKey: input.dedupeKey,
    });

    if (input.noAutoRequeue) {
      if (await deps.store.suspend(input.buildRunId, 'repair_cap')) {
        deps.track('build_run.suspended', { buildRunId: input.buildRunId, reason: 'repair_cap' });
      }
      return 'suspended';
    }

    const repair = await deps.store.consumeRepairAttempt(input.revisionId);
    if (repair === 'none_left') {
      if (await deps.store.suspend(input.buildRunId, 'repair_cap')) {
        deps.track('build_run.suspended', { buildRunId: input.buildRunId, reason: 'repair_cap' });
      }
      return 'suspended';
    }

    await deps.store.requeue(input.taskIds);
    await deps.store.appendEvent({
      buildRunId: input.buildRunId,
      buildRevisionId: input.revisionId,
      eventType: DISPATCH_EVENT_TYPES.taskRequeued,
      message: 'Apex is going back to finish this. No action needed.',
      detail: { taskKey: input.headKey },
      dedupeKey: `${input.dedupeKey}:requeued`,
    });
    return 'requeued';
  };
}
