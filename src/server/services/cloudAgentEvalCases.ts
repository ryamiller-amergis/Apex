import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns, devSessions } from '../db/schema';
import type {
  AgentRunExecutionSnapshot,
  ExecutionSnapshot,
  RunCheckResult,
} from '../../shared/types/agentRunLifecycle';
import {
  toCloudAgentEvalCase,
  type CloudAgentEvalCase,
  type CloudAgentEvalRunInput,
} from '../../shared/utils/cloudAgentEval';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

function isExecutionSnapshot(
  snapshot: AgentRunExecutionSnapshot,
): snapshot is ExecutionSnapshot {
  return !('kind' in snapshot && snapshot.kind === 'interactive-turn');
}

function deliveryOf(
  cloud: ExecutionSnapshot['cloudAgent'] | null,
): CloudAgentEvalRunInput['delivery'] {
  const delivery = cloud?.delivery;
  if (delivery === 'implementation' || delivery === 'guided') {
    return delivery;
  }
  return null;
}

function checksOf(value: RunCheckResult[] | null): RunCheckResult[] | null {
  return value && value.length > 0 ? value : null;
}

/**
 * Recent finished cloud-agent runs, newest first.
 * Leftover work is kept only when this run is still the session's current run.
 */
export async function loadCloudAgentEvalCases(limit: number): Promise<CloudAgentEvalCase[]> {
  const rows = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      projectId: agentRuns.projectId,
      updatedAt: agentRuns.updatedAt,
      terminalReason: agentRuns.terminalReason,
      lastError: agentRuns.lastError,
      executionSnapshot: agentRuns.executionSnapshot,
      checkResults: agentRuns.checkResults,
      cloudPrUrl: agentRuns.cloudPrUrl,
      cloudPrStatus: agentRuns.cloudPrStatus,
      cloudBranchName: agentRuns.cloudBranchName,
      devSessionId: agentRuns.devSessionId,
      sessionCurrentRunId: devSessions.currentRunId,
      sessionWorkItemId: devSessions.workItemId,
      leftoverWork: devSessions.leftoverWork,
    })
    .from(agentRuns)
    .leftJoin(devSessions, eq(agentRuns.devSessionId, devSessions.id))
    .where(and(
      eq(agentRuns.lane, 'cloud-agent'),
      inArray(agentRuns.status, [...TERMINAL_STATUSES]),
    ))
    .orderBy(desc(agentRuns.updatedAt))
    .limit(limit);

  return rows.flatMap((row) => {
    if (row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cancelled') {
      return [];
    }
    const snapshot = row.executionSnapshot && isExecutionSnapshot(row.executionSnapshot)
      ? row.executionSnapshot
      : null;
    const cloud = snapshot?.cloudAgent ?? null;
    const leftoverApplies = Boolean(row.devSessionId) && row.sessionCurrentRunId === row.id;
    const workItemId = cloud?.workItemId ?? row.sessionWorkItemId ?? cloud?.bugWorkItemId ?? null;
    return [toCloudAgentEvalCase({
      runId: row.id,
      project: row.projectId,
      finishedAt: row.updatedAt,
      status: row.status,
      terminalReason: row.terminalReason,
      lastError: row.lastError,
      prompt: snapshot?.prompt ?? null,
      model: snapshot?.model ?? null,
      skillPath: snapshot?.skillPath ?? null,
      workItemId,
      workItemTitle: cloud?.workItemTitle ?? null,
      task: cloud?.task ?? null,
      branchName: row.cloudBranchName ?? cloud?.branchName ?? null,
      prUrl: row.cloudPrUrl,
      prStatus: row.cloudPrStatus,
      delivery: deliveryOf(cloud),
      opensPullRequest: cloud?.opensPullRequest ?? null,
      checkResults: checksOf(row.checkResults),
      leftoverApplies,
      incompleteAcceptanceCriteria: leftoverApplies
        ? (row.leftoverWork?.incompleteAcceptanceCriteria ?? [])
        : [],
      customPrompt: cloud?.customPrompt ?? null,
    })];
  });
}
