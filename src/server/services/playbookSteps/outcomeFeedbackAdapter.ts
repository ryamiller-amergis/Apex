/**
 * The reusable `capture-outcome-feedback` step.
 *
 * It finishes in the same turn it starts. The learning record is the artifact; no agent is called
 * and no skill file is changed.
 */
import type { CaptureOutcomeFeedbackStepConfig } from '../../../shared/types/playbook';
import { capturePlaybookOutcomeFeedback } from '../playbookOutcomeFeedbackService';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import {
  completeStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'capture-outcome-feedback';

export async function executeCaptureOutcomeFeedbackStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<CaptureOutcomeFeedbackStepConfig>(
    STEP_TYPE,
    context.config
  );
  const captured = await capturePlaybookOutcomeFeedback({
    runId: context.runId,
    captureStepRunId: context.stepRunId,
    sourceStepIds: config.sourceStepIds,
    ...(config.reviewStepId ? { reviewStepId: config.reviewStepId } : {}),
    ...(config.feedbackStepId ? { feedbackStepId: config.feedbackStepId } : {}),
    ...(config.label ? { label: config.label } : {}),
  });
  const output = parseStepOutput(STEP_TYPE, {
    feedbackId: captured.feedbackId,
    decision: captured.decision,
    sourceCount: captured.sourceCount,
    capturedAt: captured.capturedAt,
  });
  await completeStepRun({ stepRunId: context.stepRunId, output });
  return { kind: 'completed', output };
}
