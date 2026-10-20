import type { BoardDeliberationStepConfig } from '../../../shared/types/playbook';
import {
  BoardDeliberationInputError,
  startBoardDeliberation,
} from '../boardDeliberationService';
import { parseStepInput } from './descriptorValidation';
import {
  deadlineFromNow,
  failStepRunForHuman,
  suspendStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';
import { resolveDeadlineMs } from './registry';

const STEP_TYPE = 'board-deliberation';

export async function executeBoardDeliberationStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<BoardDeliberationStepConfig>(
    STEP_TYPE,
    context.config
  );
  const deadline = deadlineFromNow(
    resolveDeadlineMs(STEP_TYPE, config.deadlineMs)
  );
  let started: { sessionId: string; agentRunId: string };
  try {
    started = await startBoardDeliberation({
      stepRunId: context.stepRunId,
      config,
      project: context.project,
      userId: context.initiatorUserId,
    });
  } catch (error) {
    if (!(error instanceof BoardDeliberationInputError)) throw error;
    const reason =
      error.message || 'ATS board deliberation input is invalid.';
    await failStepRunForHuman({
      stepRunId: context.stepRunId,
      reason,
    });
    return { kind: 'suspended', expiresAt: deadline };
  }
  await suspendStepRun({
    stepRunId: context.stepRunId,
    expiresAt: deadline,
    agentRunId: started.agentRunId,
    resumeToken: started.sessionId,
  });
  return {
    kind: 'suspended',
    expiresAt: deadline,
    agentRunId: started.agentRunId,
  };
}
