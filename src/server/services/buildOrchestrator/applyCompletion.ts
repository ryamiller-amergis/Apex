/**
 * Records one agent run's result for its build task. Called by the stream
 * watcher, the sweep, and start-up; repeats change nothing.
 */
import { isAgentRunTerminalStatus } from '../../../shared/types/agentRunLifecycle';
import type { CloudAgentRunObservation } from '../cursorCloudAgentClient';
import { DISPATCH_EVENT_TYPES } from './dispatchEvents';
import { canObserveAgentRun, type DispatchStore, type DispatchTaskRow } from './dispatchStore';
import type { TaskFailurePolicy } from './taskFailure';

export type CompletionOutcome =
  | 'ignored_unknown_run'
  | 'not_settled'
  | 'ignored_superseded'
  | 'recorded_only'
  | 'discarded'
  | 'finished'
  | 'failed'
  | 'already_applied';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface CloudAgentTarget {
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}

export interface CompletionDeps {
  store: DispatchStore;
  observe: (target: CloudAgentTarget) => Promise<CloudAgentRunObservation>;
  markTerminal: (agentRunId: string, status: TerminalStatus, dispatchMessageId: string | null) => Promise<void>;
  /** True when every task in the unit has red evidence, green evidence, and a test reference. Runs under the run lock, so it must not suspend. */
  mayReportDone: (input: { buildRunId: string; taskIds: string[] }) => Promise<boolean>;
  /** Must ignore a repeat for a task already merged, and must not merge into a run that is no longer building. */
  requestMerge: (input: { buildRunId: string; headTaskId: string; taskIds: string[] }) => Promise<void>;
  failTask: TaskFailurePolicy;
  dispatchNext: (buildRunId: string) => Promise<unknown>;
  track: (name: string, props: Record<string, string>) => void;
}

export function terminalStatusFromObservation(status: string): TerminalStatus {
  switch (status) {
    case 'finished':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

function failureDetail(status: TerminalStatus): string {
  switch (status) {
    case 'completed':
      return 'The agent finished without the required test evidence.';
    case 'failed':
      return 'The agent run failed.';
    case 'cancelled':
      return 'The agent run was cancelled.';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function unitMembers(head: DispatchTaskRow, tasks: DispatchTaskRow[]): DispatchTaskRow[] {
  return tasks.filter((task) => (task.chainHeadKey ?? task.key) === (head.chainHeadKey ?? head.key));
}

type Decision =
  | { kind: 'done'; outcome: CompletionOutcome }
  | { kind: 'merge'; buildRunId: string; headTaskId: string; taskIds: string[]; inserted: boolean }
  | { kind: 'fail'; buildRunId: string; revisionId: string; headKey: string; taskIds: string[] };

export function createCompletionHandler(deps: CompletionDeps): (input: { agentRunId: string }) => Promise<CompletionOutcome> {
  const { store } = deps;
  const done = (outcome: CompletionOutcome): Decision => ({ kind: 'done', outcome });

  /** Reads the run and task fresh under the run lock, so a suspend cannot land between the read and the write. */
  const decide = async (agentRunId: string, taskId: string, status: TerminalStatus): Promise<Decision> => {
    const context = await store.loadTaskContext(taskId);
    if (!context) return done('ignored_unknown_run');
    const run = await store.loadRun(context.buildRunId);
    if (!run) return done('ignored_unknown_run');

    const current = await store.currentAgentRunForTask(context.task.id);
    if (current?.id !== agentRunId) return done('ignored_superseded');
    if (run.status === 'accepted' || run.status === 'cancelled' || run.status === 'failed') return done('recorded_only');

    const members = unitMembers(context.task, await store.loadPlanTasks(context.revisionId));
    const memberIds = members.map((task) => task.id);
    const dedupeKey = `completion:${agentRunId}`;

    if (run.status === 'suspended' && run.suspendReason === 'flag_disabled') {
      await store.resetToReady(memberIds);
      await store.appendEvent({
        buildRunId: run.id,
        buildRevisionId: context.revisionId,
        eventType: DISPATCH_EVENT_TYPES.completionDiscarded,
        message: `The result for task ${context.task.key} was set aside because Build from prompt is switched off.`,
        detail: { taskKey: context.task.key, agentStatus: status },
        correlation: { kind: 'agent_run', id: agentRunId },
        dedupeKey,
      });
      return done('discarded');
    }

    if (context.task.status === 'merged') return done('already_applied');
    if (context.task.status !== 'running') return done('ignored_superseded');

    if (status === 'completed' && await deps.mayReportDone({ buildRunId: run.id, taskIds: memberIds })) {
      const inserted = await store.appendEvent({
        buildRunId: run.id,
        buildRevisionId: context.revisionId,
        eventType: DISPATCH_EVENT_TYPES.taskCompleted,
        message: `Task ${context.task.key} finished and is waiting to merge.`,
        detail: { taskKeys: members.map((task) => task.key) },
        correlation: { kind: 'agent_run', id: agentRunId },
        dedupeKey,
      });
      return { kind: 'merge', buildRunId: run.id, headTaskId: context.task.id, taskIds: memberIds, inserted };
    }
    return { kind: 'fail', buildRunId: run.id, revisionId: context.revisionId, headKey: context.task.key, taskIds: memberIds };
  };

  const apply = async (agentRunId: string): Promise<CompletionOutcome> => {
    const agentRun = await store.loadAgentRun(agentRunId);
    if (!agentRun) return 'ignored_unknown_run';
    const owner = await store.loadTaskContext(agentRun.buildTaskId);
    if (!owner) return 'ignored_unknown_run';

    let status: TerminalStatus;
    if (isAgentRunTerminalStatus(agentRun.status)) {
      status = agentRun.status;
    } else {
      if (!canObserveAgentRun(agentRun)) return 'not_settled';
      const observed = await deps.observe({
        project: agentRun.projectId,
        cloudAgentId: agentRun.cloudAgentIdentity,
        cursorRunId: agentRun.dispatchMessageId,
      });
      if (!observed.settled) return 'not_settled';
      status = terminalStatusFromObservation(observed.status);
      await deps.markTerminal(agentRunId, status, agentRun.dispatchMessageId);
    }

    const decision = await store.withRunLock(owner.buildRunId, () => decide(agentRunId, agentRun.buildTaskId, status));
    switch (decision.kind) {
      case 'done':
        return decision.outcome;
      case 'merge':
        // Outside the lock: the merge is slow, and the completion it acts on is already recorded.
        await deps.requestMerge({ buildRunId: decision.buildRunId, headTaskId: decision.headTaskId, taskIds: decision.taskIds });
        return decision.inserted ? 'finished' : 'already_applied';
      case 'fail': {
        // Outside the lock because the policy may suspend. It only moves running tasks, so a reset since the decision makes it a no-op.
        const result = await deps.failTask({
          buildRunId: decision.buildRunId,
          revisionId: decision.revisionId,
          headKey: decision.headKey,
          taskIds: decision.taskIds,
          detail: failureDetail(status),
          dedupeKey: `completion:${agentRunId}`,
        });
        if (result === 'already_handled') return 'already_applied';
        if (result === 'requeued') await deps.dispatchNext(decision.buildRunId);
        return 'failed';
      }
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  };

  return async ({ agentRunId }) => {
    const outcome = await apply(agentRunId);
    if (outcome !== 'not_settled') deps.track('build_completion.applied', { agentRunId, outcome });
    return outcome;
  };
}

export interface CompletionWatcher {
  watch(target: CloudAgentTarget & { agentRunId: string }): void;
  watching(): number;
}

/**
 * Drains the agent stream in memory, then asks the handler to look. The handler
 * acts only on an observed settled run; a dropped stream leaves it to the sweep.
 */
export function createCompletionWatcher(deps: {
  stream: (target: CloudAgentTarget) => AsyncIterator<unknown>;
  apply: (input: { agentRunId: string }) => Promise<CompletionOutcome>;
  logError?: (message: string, detail: string) => void;
}): CompletionWatcher {
  const active = new Set<string>();
  const logError = deps.logError ?? ((message: string, detail: string) => console.warn(message, detail));
  return {
    watch(target) {
      if (active.has(target.agentRunId)) return;
      active.add(target.agentRunId);
      void (async () => {
        try {
          const iterator = deps.stream(target);
          while (!(await iterator.next()).done) {
            // Drain until the agent stops.
          }
          await deps.apply({ agentRunId: target.agentRunId });
        } catch (error) {
          logError('[build-dispatch] agent stream ended early; the sweep will pick it up',
            JSON.stringify({ agentRunId: target.agentRunId, error: error instanceof Error ? error.message : String(error) }));
        } finally {
          active.delete(target.agentRunId);
        }
      })();
    },
    watching: () => active.size,
  };
}
