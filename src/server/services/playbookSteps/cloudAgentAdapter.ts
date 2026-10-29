/**
 * Starts the same Cloud Agent run My Work starts, then waits until it finishes.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { appUsers } from '../../db/schema';
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

export async function executeCloudAgentStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<{
    workItemId: number;
    workItemType: string;
    state: string;
    tags?: string;
    deadlineMs?: number;
  }>(STEP_TYPE, context.config);
  const deadlineMs = resolveDeadlineMs(STEP_TYPE, config.deadlineMs);
  const user = await db.query.appUsers.findFirst({
    where: eq(appUsers.oid, context.initiatorUserId),
    columns: { email: true },
  });
  try {
    const started = await startCloudAgentRun({
      userId: context.initiatorUserId,
      project: context.project,
      workItemId: config.workItemId,
      isSuperAdmin: Boolean(user?.email && isSuperAdminEmail(user.email)),
      item: {
        workItemType: config.workItemType,
        state: config.state,
        tags: config.tags ?? '',
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
      throw error;
    }
    throw error;
  }
}
