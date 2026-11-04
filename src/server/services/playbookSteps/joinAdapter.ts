/**
 * Merges completed arms. The engine reaches this step after the parallel region.
 * Arm results are read from Apex step rows, which survive a restart.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookStepRuns } from '../../db/schema';
import { evaluateJoin, type JoinArmResult, type JoinPolicy } from '../playbookJoinPolicy';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import {
  completeStepRun,
  failStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'join';

export async function executeJoinStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<{ predecessors: string[]; policy: JoinPolicy }>(STEP_TYPE, context.config);
  const rows = await db
    .select({
      stepId: playbookStepRuns.stepId,
      status: playbookStepRuns.status,
      outputInline: playbookStepRuns.outputInline,
    })
    .from(playbookStepRuns)
    .where(and(
      eq(playbookStepRuns.runId, context.runId),
      inArray(playbookStepRuns.stepId, config.predecessors),
    ));
  const arms: JoinArmResult[] = config.predecessors.map((stepId) => {
    const row = rows.find((candidate) => candidate.stepId === stepId);
    const status = row?.status === 'completed' ? 'completed' : 'failed';
    const output = row?.outputInline && typeof row.outputInline === 'object'
      ? row.outputInline as Record<string, unknown>
      : {};
    return { stepId, status, output };
  });
  const decision = evaluateJoin(config.policy, arms);
  if (!decision.ok) {
    await failStepRun({ stepRunId: context.stepRunId, reason: decision.error });
    throw new Error(decision.error);
  }
  const output = parseStepOutput(STEP_TYPE, decision.output);
  await completeStepRun({ stepRunId: context.stepRunId, output });
  return { kind: 'completed', output };
}
