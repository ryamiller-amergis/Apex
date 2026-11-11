/**
 * Shared completion payload for a cursor-agent step whose agent run already finished.
 *
 * The live NOTIFY path and the reconciliation sweep must record the same output. A sweep that
 * resumes with an empty payload lets the next ingest-artifact step run without a scorecard.
 */
import {
  getThread,
  hydrateThread,
  isOutputWorkspaceReadable,
  readOutputValidationScorecard,
  readOutputValidationScorecardMd,
} from '../chatAgentService';
import { extractOutcome } from './agentOutcome';
import { parseStepOutput } from './descriptorValidation';
import { readV2ScorecardFiles, type StepScorecardFiles } from './v2StepArtifacts';

async function lastAgentReply(threadId: string): Promise<string | null> {
  const thread = await getThread(threadId);
  const reply = [...(thread?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'agent' && !message.hidden && message.text.trim());
  return reply?.text ?? null;
}

async function readWorkspaceScorecardFiles(
  threadId: string | null | undefined,
): Promise<StepScorecardFiles | null> {
  if (!threadId) return { scorecard: null, reportMd: null, reply: null };
  await hydrateThread(threadId);
  if (!isOutputWorkspaceReadable(threadId)) return null;
  return {
    scorecard: readOutputValidationScorecard(threadId),
    reportMd: readOutputValidationScorecardMd(threadId),
    reply: await lastAgentReply(threadId),
  };
}

/**
 * Returns null when the thread's workspace cannot be read yet. A missing file and an
 * unhydrated workspace both look empty, and treating the second as "no scorecard" marks a
 * finished design doc unusable. The caller leaves the step suspended so another instance,
 * or the next sweep, can read it.
 *
 * `output` is the report a Skill wrote, else the agent's last reply, so a step without a
 * report-writing Skill still hands its answer on. `reportMd` stays for published bindings.
 */
export async function cursorAgentCompletionOutput(input: {
  stepType: string;
  agentRunId: string;
  completedAt: string;
  threadId?: string | null;
}): Promise<Record<string, unknown> | null> {
  const files =
    (await readV2ScorecardFiles(input.agentRunId))
    ?? (await readWorkspaceScorecardFiles(input.threadId));
  if (!files) return null;
  const reply = files.reply ? extractOutcome(files.reply) : null;
  // The V2 reader falls back to the reply for reportMd, so drop the OUTCOME line there too.
  const reportMd = files.reportMd && files.reportMd === files.reply ? reply?.text || null : files.reportMd;
  const output = reportMd ?? (reply?.text || null);
  return parseStepOutput(input.stepType, {
    agentRunId: input.agentRunId,
    completedAt: input.completedAt,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(files.scorecard ? { scorecard: files.scorecard } : {}),
    ...(reportMd ? { reportMd } : {}),
    ...(output ? { output } : {}),
    ...(reply?.outcome ? { outcome: reply.outcome } : {}),
  });
}
