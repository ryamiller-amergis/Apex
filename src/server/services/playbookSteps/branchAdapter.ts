import { and, eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookStepRuns } from '../../db/schema';
import type { BranchStepConfig } from '../../../shared/types/playbook';
import { evaluateBranchCondition } from './branchConditionEvaluator';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import type { PlaybookStepExecutionContext, PlaybookStepOutcome } from './stepRuns';

export async function executeBranchStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<BranchStepConfig>('branch', context.config);
  const [source] = await db
    .select({ output: playbookStepRuns.outputInline })
    .from(playbookStepRuns)
    .where(and(
      eq(playbookStepRuns.runId, context.runId),
      eq(playbookStepRuns.stepId, config.condition.sourceStepId),
    ))
    .limit(1);

  const matched = evaluateBranchCondition(config.condition, {
    [config.condition.sourceStepId]: source?.output ?? {},
  });
  const output = parseStepOutput('branch', {
    matched,
    continuation: matched ? config.whenTrue : config.whenFalse,
  });
  return { kind: 'completed', output };
}
