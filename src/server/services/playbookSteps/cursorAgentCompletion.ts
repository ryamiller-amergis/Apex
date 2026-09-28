/**
 * Shared completion payload for a cursor-agent step whose agent run already finished.
 *
 * The live NOTIFY path and the reconciliation sweep must record the same output. A sweep that
 * resumes with an empty payload lets the next ingest-artifact step run without a scorecard.
 */
import {
  hydrateThread,
  isOutputWorkspaceReadable,
  readOutputValidationScorecard,
  readOutputValidationScorecardMd,
} from '../chatAgentService';
import { parseStepOutput } from './descriptorValidation';

/**
 * Returns null when the thread's workspace cannot be read yet. A missing file and an
 * unhydrated workspace both look empty, and treating the second as "no scorecard" marks a
 * finished design doc unusable. The caller leaves the step suspended so another instance,
 * or the next sweep, can read it.
 */
export async function cursorAgentCompletionOutput(input: {
  stepType: string;
  agentRunId: string;
  completedAt: string;
  threadId?: string | null;
}): Promise<Record<string, unknown> | null> {
  if (input.threadId) {
    await hydrateThread(input.threadId);
    if (!isOutputWorkspaceReadable(input.threadId)) return null;
  }
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
