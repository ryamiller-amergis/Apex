import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  playbookRuns,
  playbookStepRuns,
} from '../db/schema';
import { getUserPermissions } from './rbacService';
import * as playbookEngine from './playbookEngine';
import type {
  CancelPlaybookRunResponse,
  PlaybookCancelInput,
  PlaybookGraph,
  PlaybookRetryInput,
  RetryPlaybookStepResponse,
} from '../../shared/types/playbook';

export class PlaybookRunActionNotFoundError extends Error {
  constructor() {
    super('No such Playbook run or step in this project.');
    this.name = 'PlaybookRunActionNotFoundError';
  }
}

export class PlaybookRunActionForbiddenError extends Error {
  constructor() {
    super('Only the run initiator or a Playbook administrator may perform this action.');
    this.name = 'PlaybookRunActionForbiddenError';
  }
}

export class PlaybookRunActionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookRunActionConflictError';
  }
}

interface ActionStep {
  id: string;
  stepId: string;
  stepType: string;
  status: string;
}

interface ActionContext {
  runId: string;
  project: string;
  initiatorUserId: string;
  definitionVersionId: string;
  status: string;
  graph: PlaybookGraph;
  steps: ActionStep[];
}

interface ActionDependencies {
  loadContext(project: string, runId: string): Promise<ActionContext | null>;
  getUserPermissions(userId: string, project: string): Promise<Set<string>>;
  cancelEngine(input: PlaybookCancelInput): Promise<void>;
  cancelRows(runId: string): Promise<boolean>;
  prepareRetry(runId: string, stepRunId: string): Promise<boolean>;
  retryEngine(input: PlaybookRetryInput): Promise<playbookEngine.EngineOutcome>;
  restoreRetryable(runId: string, stepRunId: string, reason: string): Promise<void>;
}

export interface PlaybookRunActionActor {
  actorUserId: string;
  isSuperAdmin?: boolean;
}

export interface CancelPlaybookRunInput extends PlaybookRunActionActor {
  runId: string;
  project: string;
  reason?: string;
}

export interface RetryPlaybookStepInput extends PlaybookRunActionActor {
  runId: string;
  stepRunId: string;
  project: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function loadContext(project: string, runId: string): Promise<ActionContext | null> {
  const row = await db.query.playbookRuns.findFirst({
    where: and(eq(playbookRuns.id, runId), eq(playbookRuns.project, project)),
    with: {
      definitionVersion: { columns: { id: true, graph: true } },
      steps: true,
    },
  });
  if (!row) return null;

  const typed = row as unknown as {
    id: string;
    project: string;
    initiatorUserId: string;
    definitionVersionId: string;
    status: string;
    definitionVersion: { graph: PlaybookGraph };
    steps: Array<ActionStep & { createdAt: string }>;
  };
  return {
    runId: typed.id,
    project: typed.project,
    initiatorUserId: typed.initiatorUserId,
    definitionVersionId: typed.definitionVersionId,
    status: typed.status,
    graph: typed.definitionVersion.graph,
    steps: [...typed.steps].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

async function cancelRows(runId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(playbookRuns)
      .set({ status: 'cancelled', completedAt: nowIso(), updatedAt: nowIso() })
      .where(
        and(eq(playbookRuns.id, runId), inArray(playbookRuns.status, ['running', 'suspended']))
      )
      .returning({ id: playbookRuns.id });
    if (moved.length === 0) return false;

    await tx
      .update(playbookStepRuns)
      .set({ status: 'cancelled', completedAt: nowIso(), updatedAt: nowIso() })
      .where(
        and(
          eq(playbookStepRuns.runId, runId),
          inArray(playbookStepRuns.status, [
            'pending',
            'running',
            'suspended',
            'failed_retryable',
          ])
        )
      );
    return true;
  });
}

async function prepareRetry(runId: string, stepRunId: string): Promise<boolean> {
  const stale = new Error('retry-state-changed');
  try {
    return await db.transaction(async (tx) => {
      const moved = await tx
        .update(playbookStepRuns)
        .set({
          status: 'running',
          agentRunId: null,
          resumeToken: null,
          outputInline: null,
          outputBlobRef: null,
          expiresAt: null,
          completedAt: null,
          startedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(playbookStepRuns.id, stepRunId),
            eq(playbookStepRuns.runId, runId),
            eq(playbookStepRuns.status, 'failed_retryable')
          )
        )
        .returning({ id: playbookStepRuns.id });
      if (moved.length === 0) throw stale;

      const runMoved = await tx
        .update(playbookRuns)
        .set({ status: 'running', completedAt: null, updatedAt: nowIso() })
        .where(
          and(eq(playbookRuns.id, runId), inArray(playbookRuns.status, ['running', 'suspended']))
        )
        .returning({ id: playbookRuns.id });
      if (runMoved.length === 0) throw stale;
      return true;
    });
  } catch (error) {
    if (error === stale) return false;
    throw error;
  }
}

async function restoreRetryable(
  runId: string,
  stepRunId: string,
  reason: string
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(playbookStepRuns)
      .set({
        status: 'failed_retryable',
        outputInline: { error: reason },
        completedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(playbookStepRuns.id, stepRunId),
          eq(playbookStepRuns.runId, runId),
          eq(playbookStepRuns.status, 'running')
        )
      );
    await tx
      .update(playbookRuns)
      .set({ status: 'suspended', completedAt: null, updatedAt: nowIso() })
      .where(and(eq(playbookRuns.id, runId), eq(playbookRuns.status, 'running')));
  });
}

const productionDependencies: ActionDependencies = {
  loadContext,
  getUserPermissions,
  cancelEngine: playbookEngine.cancel,
  cancelRows,
  prepareRetry,
  retryEngine: playbookEngine.retry,
  restoreRetryable,
};

export function createPlaybookRunActionService(dependencies: ActionDependencies) {
  async function authorizedContext(
    project: string,
    runId: string,
    actor: PlaybookRunActionActor
  ): Promise<ActionContext> {
    const context = await dependencies.loadContext(project, runId);
    if (!context) throw new PlaybookRunActionNotFoundError();

    if (
      actor.actorUserId !== context.initiatorUserId &&
      !actor.isSuperAdmin
    ) {
      const permissions = await dependencies.getUserPermissions(actor.actorUserId, context.project);
      if (!permissions.has('playbooks:admin')) {
        throw new PlaybookRunActionForbiddenError();
      }
    }
    return context;
  }

  return {
    async cancel(input: CancelPlaybookRunInput): Promise<CancelPlaybookRunResponse> {
      const context = await authorizedContext(input.project, input.runId, input);
      if (context.status === 'cancelled') {
        return { runId: context.runId, status: 'cancelled', outcome: 'already-cancelled' };
      }
      if (!['running', 'suspended'].includes(context.status)) {
        throw new PlaybookRunActionConflictError(
          `A ${context.status} Playbook run cannot be cancelled.`
        );
      }

      await dependencies.cancelEngine({
        runId: context.runId,
        graph: context.graph,
        projectName: context.project,
        initiatorUserId: context.initiatorUserId,
        cancelledByUserId: input.actorUserId,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      if (!(await dependencies.cancelRows(context.runId))) {
        throw new PlaybookRunActionConflictError('The run changed before cancellation completed.');
      }

      console.info('playbook.run.cancelled', {
        project: context.project,
        runId: context.runId,
        actorUserId: input.actorUserId,
        authorization:
          input.actorUserId === context.initiatorUserId ? 'initiator' : 'administrator',
        reason: input.reason,
      });
      return { runId: context.runId, status: 'cancelled', outcome: 'cancelled' };
    },

    async retry(input: RetryPlaybookStepInput): Promise<RetryPlaybookStepResponse> {
      const context = await authorizedContext(input.project, input.runId, input);
      // Linear graphs create rows in execution order, so only the newest row can be current.
      const current = context.steps[context.steps.length - 1];
      if (
        !current ||
        current.id !== input.stepRunId ||
        current.status !== 'failed_retryable' ||
        !['running', 'suspended'].includes(context.status)
      ) {
        throw new PlaybookRunActionConflictError(
          'Only the current failed_retryable step can be retried.'
        );
      }
      if (!(await dependencies.prepareRetry(context.runId, current.id))) {
        throw new PlaybookRunActionConflictError('The step changed before retry started.');
      }

      console.info('playbook.step.retry_started', {
        project: context.project,
        runId: context.runId,
        stepRunId: current.id,
        actorUserId: input.actorUserId,
        authorization:
          input.actorUserId === context.initiatorUserId ? 'initiator' : 'administrator',
      });

      let outcome: playbookEngine.EngineOutcome;
      try {
        outcome = await dependencies.retryEngine({
          runId: context.runId,
          graph: context.graph,
          projectName: context.project,
          initiatorUserId: context.initiatorUserId,
          definitionVersionId: context.definitionVersionId,
          stepRunId: current.id,
          stepId: current.stepId,
          retriedByUserId: input.actorUserId,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The retry failed.';
        await dependencies.restoreRetryable(context.runId, current.id, reason);
        throw error;
      }
      if (outcome.endedAs === 'failed') {
        const reason =
          outcome.error instanceof Error ? outcome.error.message : 'The retry failed.';
        await dependencies.restoreRetryable(context.runId, current.id, reason);
        throw outcome.error instanceof Error ? outcome.error : new Error(reason);
      }

      return {
        runId: context.runId,
        stepRunId: current.id,
        status: 'running',
        outcome: 'retried',
      };
    },
  };
}

const actionService = createPlaybookRunActionService(productionDependencies);
export const cancelPlaybookRun = actionService.cancel;
export const retryPlaybookStep = actionService.retry;
