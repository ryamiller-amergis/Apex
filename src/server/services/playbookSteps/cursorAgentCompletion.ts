/**
 * Shared completion payload for a cursor-agent step whose agent run already finished.
 *
 * The live NOTIFY path and the reconciliation sweep must record the same output. A sweep that
 * resumes with an empty payload lets the next ingest-artifact step run without a scorecard.
 */
import {
  readOutputValidationScorecard,
  readOutputValidationScorecardMd,
} from '../chatAgentService';
import { parseStepOutput } from './descriptorValidation';

export function cursorAgentCompletionOutput(input: {
  stepType: string;
  agentRunId: string;
  completedAt: string;
  threadId?: string | null;
}): Record<string, unknown> {
  const scorecard = input.threadId ? readOutputValidationScorecard(input.threadId) : null;
  const reportMd = input.threadId ? readOutputValidationScorecardMd(input.threadId) : null;
  return parseStepOutput(input.stepType, {
    agentRunId: input.agentRunId,
    completedAt: input.completedAt,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(scorecard ? { scorecard } : {}),
    ...(reportMd ? { reportMd } : {}),
  });
}
