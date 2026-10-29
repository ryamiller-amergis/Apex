/**
 * Bounded loops. The cap is enforced here, on the resolved input, not in a prompt.
 */
import {
  assertForeachWithinCap,
  assertUntilWithinCap,
  PlaybookIterationCapError,
} from '../playbookJoinPolicy';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import {
  completeStepRun,
  failStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

export async function executeForeachStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<{ items: unknown[]; maxIterations: number }>('foreach', context.config);
  try {
    assertForeachWithinCap(config.items.length, config.maxIterations);
  } catch (error) {
    const reason = error instanceof PlaybookIterationCapError ? error.message : 'foreach hit its cap.';
    await failStepRun({ stepRunId: context.stepRunId, reason });
    throw error;
  }
  const output = parseStepOutput('foreach', { iterations: config.items.length });
  await completeStepRun({ stepRunId: context.stepRunId, output });
  return { kind: 'completed', output };
}

export async function executeUntilStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<{ done: boolean; iteration: number; maxIterations: number }>(
    'until',
    context.config,
  );
  try {
    assertUntilWithinCap(config.iteration, config.maxIterations, config.done);
  } catch (error) {
    const reason = error instanceof PlaybookIterationCapError ? error.message : 'until hit its cap.';
    await failStepRun({ stepRunId: context.stepRunId, reason });
    throw error;
  }
  const output = parseStepOutput('until', { iterations: config.iteration });
  await completeStepRun({ stepRunId: context.stepRunId, output });
  return { kind: 'completed', output };
}
