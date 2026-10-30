/**
 * One sweep pass over every active build. It reads only stored rows, so it is
 * also the restart path. The flag gate runs first so a run whose flag just
 * went off discards results instead of merging them.
 */
import { isAgentRunTerminalStatus } from '../../../shared/types/agentRunLifecycle';
import { BUILD_PLAN_TASK_ROLES } from '../../../shared/types/build';
import type { CompletionOutcome } from './applyCompletion';
import { DISPATCH_EVENT_TYPES } from './dispatchEvents';
import { AGENT_STAGE_STATUSES, type BuildAgentRunRow, type DispatchRunRow, type DispatchStore } from './dispatchStore';
import type { BuildFlagState, GuardRun } from './launchGuard';

export interface BuildSweepOutcome {
  startedAt: string;
  durationMs: number;
  /** Another instance held the sweep lock. */
  skipped: boolean;
  flagSuspended: number;
  completionsApplied: number;
  cancelRetries: number;
  dispatched: number;
  errors: number;
}

export interface ReconcileDeps {
  store: DispatchStore;
  readFlag: (run: GuardRun) => Promise<BuildFlagState>;
  applyCompletion: (input: { agentRunId: string }) => Promise<CompletionOutcome>;
  dispatchNext: (buildRunId: string) => Promise<unknown>;
  /** Requests the cancel, asks Cursor to stop, and ends the agent run. Throws when Cursor refuses. */
  cancelAgent: (agentRun: BuildAgentRunRow) => Promise<void>;
  track: (name: string, props: Record<string, string>, measurements?: Record<string, number>) => void;
  logError?: (message: string, detail: string) => void;
  now?: () => number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBuildReconciler(deps: ReconcileDeps): () => Promise<BuildSweepOutcome> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const logError = deps.logError ?? ((message: string, detail: string) => console.error(message, detail));

  /** Returns true when the cancel went through. One failure event per agent run, however many retries. */
  const cancelOrRecord = async (run: DispatchRunRow, agentRun: BuildAgentRunRow): Promise<boolean> => {
    try {
      await deps.cancelAgent(agentRun);
      return true;
    } catch (error) {
      await store.appendEvent({
        buildRunId: run.id,
        buildRevisionId: run.revisionId,
        eventType: DISPATCH_EVENT_TYPES.agentCancelFailed,
        severity: 'warn',
        message: 'Apex could not stop one of this build\'s agents. It will keep trying.',
        detail: { error: errorText(error) },
        correlation: { kind: 'agent_run', id: agentRun.id },
        dedupeKey: `cancel_failed:${agentRun.id}`,
      });
      return false;
    }
  };

  /** Live agents of every role. Only implementer and QA tasks are handed back for reset. */
  const liveAgentRuns = async (run: DispatchRunRow, onlyRunningTasks: boolean): Promise<{ agentRuns: BuildAgentRunRow[]; runningTaskIds: string[] }> => {
    if (!run.revisionId) return { agentRuns: [], runningTaskIds: [] };
    const tasks = await store.loadRevisionTasks(run.revisionId);
    const runningTaskIds = tasks
      .filter((task) => task.status === 'running' && (BUILD_PLAN_TASK_ROLES as readonly string[]).includes(task.role))
      .map((task) => task.id);
    const heads = tasks.filter((task) => (task.chainHeadKey ?? task.key) === task.key
      && (!onlyRunningTasks || task.status === 'running'));
    const agentRuns: BuildAgentRunRow[] = [];
    for (const head of heads) {
      const latest = await store.latestAgentRunForTask(head.id);
      if (latest && !isAgentRunTerminalStatus(latest.status)) agentRuns.push(latest);
    }
    return { agentRuns, runningTaskIds };
  };

  const suspendForFlagOff = async (run: DispatchRunRow): Promise<void> => {
    if (await store.suspend(run.id, 'flag_disabled')) {
      deps.track('build_run.suspended', { buildRunId: run.id, reason: 'flag_disabled' });
    }
    const { agentRuns, runningTaskIds } = await liveAgentRuns(run, true);
    for (const agentRun of agentRuns) await cancelOrRecord(run, agentRun);
    await store.resetToReady(runningTaskIds);
  };

  return async () => {
    const startedMs = now();
    const outcome: BuildSweepOutcome = {
      startedAt: new Date(startedMs).toISOString(),
      durationMs: 0,
      skipped: false,
      flagSuspended: 0,
      completionsApplied: 0,
      cancelRetries: 0,
      dispatched: 0,
      errors: 0,
    };
    const attempt = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        outcome.errors += 1;
        logError(`[build-reconciliation] ${label} failed`, errorText(error));
      }
    };

    const ran = await store.withSweepLock(async () => {
      for (const run of await store.listRuns(AGENT_STAGE_STATUSES)) {
        await attempt(`flag check for ${run.id}`, async () => {
          const flag = await deps.readFlag({ requesterUserId: run.requesterUserId, project: run.project });
          if (flag === 'on') return;
          await suspendForFlagOff(run);
          outcome.flagSuspended += 1;
        });
      }

      for (const agentRunId of await store.listRunningHeadAgentRunIds()) {
        await attempt(`completion for ${agentRunId}`, async () => {
          const applied = await deps.applyCompletion({ agentRunId });
          if (applied !== 'not_settled') outcome.completionsApplied += 1;
        });
      }

      for (const run of await store.listRunsSuspendedFor('flag_disabled')) {
        await attempt(`cancel retry for ${run.id}`, async () => {
          const { agentRuns } = await liveAgentRuns(run, false);
          for (const agentRun of agentRuns) {
            outcome.cancelRetries += 1;
            await cancelOrRecord(run, agentRun);
          }
        });
      }

      for (const run of await store.listRuns(['building'])) {
        await attempt(`dispatch for ${run.id}`, async () => {
          await deps.dispatchNext(run.id);
          outcome.dispatched += 1;
        });
      }
      return true;
    });

    outcome.skipped = ran === null;
    outcome.durationMs = now() - startedMs;
    deps.track('build_sweep.completed', { skipped: String(outcome.skipped) }, {
      durationMs: outcome.durationMs,
      flagSuspended: outcome.flagSuspended,
      completionsApplied: outcome.completionsApplied,
      cancelRetries: outcome.cancelRetries,
      dispatched: outcome.dispatched,
      errors: outcome.errors,
    });
    return outcome;
  };
}
