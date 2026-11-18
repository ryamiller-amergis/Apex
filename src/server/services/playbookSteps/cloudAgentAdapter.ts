/**
 * Starts the same Cloud Agent run My Work starts, then waits until it finishes.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import {
  appUsers,
  playbookDefinitionVersions,
  playbookDefinitions,
  playbookRuns,
} from '../../db/schema';
import type { CloudAgentStepConfig } from '../../../shared/types/playbook';
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
import { inferWorkItemId, positiveInteger } from './workItemContext';

export { ancestorsNearestFirst } from './workItemContext';

const STEP_TYPE = 'cloud-agent';

function deadlineFromNow(deadlineMs: number): string {
  return new Date(Date.now() + deadlineMs).toISOString();
}

/** The person who created the Playbook. Its pull requests open under their name. */
async function playbookAuthorId(runId: string): Promise<string | null> {
  const [row] = await db.select({ createdBy: playbookDefinitions.createdBy })
    .from(playbookRuns)
    .innerJoin(playbookDefinitionVersions, eq(playbookDefinitionVersions.id, playbookRuns.definitionVersionId))
    .innerJoin(playbookDefinitions, eq(playbookDefinitions.id, playbookDefinitionVersions.definitionId))
    .where(eq(playbookRuns.id, runId))
    .limit(1);
  return row?.createdBy ?? null;
}

export async function executeCloudAgentStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<CloudAgentStepConfig>(STEP_TYPE, context.config);
  const deadlineMs = resolveDeadlineMs(STEP_TYPE, config.deadlineMs);
  try {
    const explicitId = positiveInteger(config.workItemId);
    if (!explicitId && config.workItemSource === 'manual') {
      throw new CloudAgentEligibilityError(
        'This step is set to a specific work item, but no work item id was entered.',
      );
    }
    const workItemId = explicitId ?? await inferWorkItemId(context);
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
    const authorId = await playbookAuthorId(context.runId);
    const started = await startCloudAgentRun({
      userId: context.initiatorUserId,
      project: context.project,
      workItemId,
      ...(config.model?.trim() ? { model: config.model.trim() } : {}),
      isSuperAdmin: Boolean(user?.email && isSuperAdminEmail(user.email)),
      ...(authorId ? { pullRequestAuthorId: authorId } : {}),
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
