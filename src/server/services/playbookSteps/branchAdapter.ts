import { and, eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookStepRuns } from '../../db/schema';
import type { BranchStepConfig } from '../../../shared/types/playbook';
import { evaluateBranchCondition } from './branchConditionEvaluator';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import type { PlaybookStepExecutionContext, PlaybookStepOutcome } from './stepRuns';
import { createPlaybookStepOutputStore } from '../playbookStepOutputStore';

export async function executeBranchStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<BranchStepConfig>('branch', context.config);
  const [source] = await db
    .select({
      id: playbookStepRuns.id,
      stepId: playbookStepRuns.stepId,
      output: playbookStepRuns.outputInline,
      outputBlobRef: playbookStepRuns.outputBlobRef,
    })
    .from(playbookStepRuns)
    .where(and(
      eq(playbookStepRuns.runId, context.runId),
      eq(playbookStepRuns.stepId, config.condition.sourceStepId),
      eq(playbookStepRuns.status, 'completed'),
    ))
    .limit(1);

  let sourceOutput = source?.output ?? {};
  if (source?.outputBlobRef) {
    const envelope = await createPlaybookStepOutputStore().load(source.outputBlobRef);
    if (
      envelope.runId !== context.runId
      || envelope.stepRunId !== source.id
      || envelope.stepId !== source.stepId
    ) {
      throw new Error(
        `Playbook output reference for step "${config.condition.sourceStepId}" has wrong ownership.`
      );
    }
    sourceOutput = envelope.output;
  }
  const matched = evaluateBranchCondition(config.condition, {
    [config.condition.sourceStepId]: sourceOutput,
  });
  const output = parseStepOutput('branch', {
    matched,
    continuation: matched ? config.whenTrue : config.whenFalse,
  });
  return { kind: 'completed', output };
}
