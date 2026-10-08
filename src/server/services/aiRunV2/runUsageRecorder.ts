import { eq } from 'drizzle-orm';
import type { AiRunV2TerminalResult } from '../../../shared/types/aiRunV2';
import { db } from '../../db/drizzle';
import { agentRuns } from '../../db/schema';
import { recordCursorChatUsage } from '../aiUsageService';

function hasUsage(result: AiRunV2TerminalResult): boolean {
  return (
    result.durationMs !== undefined
    || result.inputTokens !== undefined
    || result.outputTokens !== undefined
    || result.cacheReadTokens !== undefined
    || result.cacheWriteTokens !== undefined
  );
}

/**
 * Record generic Cursor usage after the attempt transition wins its fence.
 * A replay reaches `illegal_transition` and never calls this function again.
 */
export async function recordV2TerminalUsage(
  result: AiRunV2TerminalResult,
): Promise<void> {
  if (!hasUsage(result)) return;

  try {
    const run = await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, result.runId),
      columns: {
        threadId: true,
        lane: true,
        executionSnapshot: true,
      },
    });
    const snapshot = run?.executionSnapshot as
      | Record<string, unknown>
      | null
      | undefined;
    if (
      run?.lane !== 'background'
      || !snapshot
      || typeof snapshot.model !== 'string'
      || !snapshot.model.trim()
      || typeof snapshot.projectId !== 'string'
      || !snapshot.projectId.trim()
    ) {
      return;
    }

    const hasReportedTokens =
      result.inputTokens !== undefined || result.outputTokens !== undefined;
    await recordCursorChatUsage({
      kickoff: {
        project: snapshot.projectId,
        ...(typeof snapshot.skillPath === 'string'
          ? { skillPath: snapshot.skillPath }
          : {}),
      },
      modelId: snapshot.model,
      threadId: run.threadId,
      runId: result.runId,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      tokenSource: hasReportedTokens ? 'exact' : 'estimated',
      durationMs: result.durationMs ?? 0,
      status:
        result.status === 'completed'
          ? 'success'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'error',
    });
  } catch (error) {
    console.error(
      `[aiRunV2] Failed to record terminal usage (runId=${result.runId})`,
      error,
    );
  }
}
