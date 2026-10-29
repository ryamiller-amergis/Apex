/**
 * Starts the same Cloud Agent run My Work starts, then waits until it finishes.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { appUsers, playbookRuns, playbookStepRuns } from '../../db/schema';
import type { PlaybookGraph } from '../../../shared/types/playbook';
import { AzureDevOpsService } from '../azureDevOps';
import {
  CloudAgentConflictError,
  CloudAgentEligibilityError,
  startCloudAgentRun,
} from '../cloudAgentService';
import { isSuperAdminEmail } from '../../utils/superAdmin';
import { parseStepInput } from './descriptorValidation';
import { resolveDeadlineMs } from './registry';
import {
  failStepRun,
  suspendStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'cloud-agent';

function deadlineFromNow(deadlineMs: number): string {
  return new Date(Date.now() + deadlineMs).toISOString();
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Ancestors of a node, nearest first. */
export function ancestorsNearestFirst(graph: PlaybookGraph | undefined, stepId: string): string[] {
  if (!graph) return [];
  const baseId = stepId.split('#')[0];
  const ordered: string[] = [];
  const seen = new Set<string>([baseId]);
  let frontier = [baseId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.edges) {
        if (edge.to !== id || seen.has(edge.from)) continue;
        seen.add(edge.from);
        ordered.push(edge.from);
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  return ordered;
}

/** The nearest earlier step's `workItemId`, else the run input's. */
async function inferWorkItemId(context: PlaybookStepExecutionContext): Promise<number | null> {
  const ancestors = ancestorsNearestFirst(context.graph, context.stepId);
  if (ancestors.length) {
    const rows = await db.select({
      stepId: playbookStepRuns.stepId,
      output: playbookStepRuns.outputInline,
      completedAt: playbookStepRuns.completedAt,
    }).from(playbookStepRuns).where(and(
      eq(playbookStepRuns.runId, context.runId),
      eq(playbookStepRuns.status, 'completed'),
    ));
    for (const ancestor of ancestors) {
      const found = rows
        .filter((row) => row.stepId === ancestor || row.stepId.startsWith(`${ancestor}#`))
        .sort((a, b) => String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? '')))
        .map((row) => positiveInteger((row.output as Record<string, unknown> | null)?.workItemId))
        .find((id): id is number => id !== null);
      if (found) return found;
    }
  }
  const [run] = await db.select({ runInput: playbookRuns.runInput })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, context.runId))
    .limit(1);
  return positiveInteger((run?.runInput as Record<string, unknown> | null)?.workItemId);
}

export async function executeCloudAgentStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<{
    workItemId?: number;
    workItemType?: string;
    state?: string;
    tags?: string;
    deadlineMs?: number;
  }>(STEP_TYPE, context.config);
  const deadlineMs = resolveDeadlineMs(STEP_TYPE, config.deadlineMs);
  try {
    const workItemId = positiveInteger(config.workItemId) ?? await inferWorkItemId(context);
    if (!workItemId) {
      throw new CloudAgentEligibilityError(
        'No work item to work on: no earlier step produced a work item id and the run input has none.',
      );
    }
    let { workItemType, state, tags } = config;
    if (!workItemType || !state) {
      const [item] = await new AzureDevOpsService(context.project).getWorkItemsByIds([workItemId]);
      if (!item) {
        throw new CloudAgentEligibilityError(`Work item ${workItemId} was not found in Azure DevOps.`);
      }
      workItemType ||= item.workItemType;
      state ||= item.state;
      tags ??= item.tags;
    }
    const user = await db.query.appUsers.findFirst({
      where: eq(appUsers.oid, context.initiatorUserId),
      columns: { email: true },
    });
    const started = await startCloudAgentRun({
      userId: context.initiatorUserId,
      project: context.project,
      workItemId,
      isSuperAdmin: Boolean(user?.email && isSuperAdminEmail(user.email)),
      item: {
        workItemType: workItemType!,
        state: state!,
        tags: tags ?? '',
      },
    });
    const expiresAt = deadlineFromNow(deadlineMs);
    await suspendStepRun({
      stepRunId: context.stepRunId,
      expiresAt,
      agentRunId: started.runId,
      resumeToken: started.sessionId,
    });
    return { kind: 'suspended', expiresAt, agentRunId: started.runId };
  } catch (error) {
    if (error instanceof CloudAgentEligibilityError || error instanceof CloudAgentConflictError) {
      await failStepRun({
        stepRunId: context.stepRunId,
        reason: error.message,
      });
    }
    throw error;
  }
}
