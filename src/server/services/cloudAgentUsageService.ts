/**
 * Writes one AI Cost row when a Cloud Agent run finishes.
 * The hourly Cursor allocation later replaces the catalog estimate
 * with that run's share of the Cursor bill.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns, aiUsageEvents, devSessions } from '../db/schema';
import type { AgentRunExecutionSnapshot, AgentRunStatus, ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { AiUsageStatus } from '../../shared/types/aiCostAnalytics';
import { computeCost, estimateTokens } from './aiUsageService';

export interface CloudAgentUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RecordCloudAgentUsageInput {
  runId: string;
  project: string;
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
  modelId?: string | null;
  durationMs?: number | null;
  resultText?: string | null;
  tokens?: CloudAgentUsageTokens | null;
}

function isInteractiveTurnSnapshot(
  snapshot: AgentRunExecutionSnapshot,
): snapshot is Exclude<AgentRunExecutionSnapshot, ExecutionSnapshot> {
  return 'kind' in snapshot && snapshot.kind === 'interactive-turn';
}

function backgroundSnapshot(
  snapshot: AgentRunExecutionSnapshot | null | undefined,
): ExecutionSnapshot | null {
  if (!snapshot || isInteractiveTurnSnapshot(snapshot)) return null;
  return snapshot;
}

function reportedTokens(tokens: CloudAgentUsageTokens | null | undefined): CloudAgentUsageTokens | null {
  if (!tokens) return null;
  const total = tokens.inputTokens
    + tokens.outputTokens
    + tokens.cacheReadTokens
    + tokens.cacheWriteTokens;
  if (total <= 0) return null;
  return tokens;
}

async function sessionAuthorId(devSessionId: string | null | undefined): Promise<string | null> {
  if (!devSessionId) return null;
  const session = await db.query.devSessions.findFirst({
    where: eq(devSessions.id, devSessionId),
    columns: { authorId: true },
  });
  return session?.authorId ?? null;
}

function usageStatus(status: RecordCloudAgentUsageInput['status']): AiUsageStatus {
  if (status === 'completed') return 'success';
  if (status === 'cancelled') return 'cancelled';
  return 'error';
}

function durationMs(
  explicit: number | null | undefined,
  startedAt: string | null | undefined,
): number | null {
  if (explicit != null && explicit >= 0) return Math.round(explicit);
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, Date.now() - started);
}

export async function recordCloudAgentUsage(input: RecordCloudAgentUsageInput): Promise<void> {
  const existing = await db
    .select({ id: aiUsageEvents.id })
    .from(aiUsageEvents)
    .where(and(
      eq(aiUsageEvents.runId, input.runId),
      eq(aiUsageEvents.feature, 'cloud-agent'),
    ))
    .limit(1);
  if (existing.length > 0) return;

  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, input.runId),
    columns: {
      requestedByUserId: true,
      threadId: true,
      startedAt: true,
      devSessionId: true,
      executionSnapshot: true,
      projectId: true,
    },
  });
  const snapshot = backgroundSnapshot(run?.executionSnapshot);
  const tokens = reportedTokens(input.tokens);
  const inputTokens = tokens?.inputTokens ?? estimateTokens(snapshot?.prompt ?? '');
  const outputTokens = tokens?.outputTokens ?? estimateTokens(input.resultText ?? '');
  const cacheReadTokens = tokens?.cacheReadTokens ?? 0;
  const cacheWriteTokens = tokens?.cacheWriteTokens ?? 0;
  const modelId = input.modelId?.trim() || snapshot?.model?.trim() || 'unknown';
  const costUsd = await computeCost({
    provider: 'cursor',
    modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
  const tokenSource = tokens ? 'exact' : 'estimated';
  const workItemId = snapshot?.cloudAgent?.workItemId ?? snapshot?.cloudAgent?.bugWorkItemId;
  const userId = run?.requestedByUserId ?? await sessionAuthorId(run?.devSessionId);

  await db.insert(aiUsageEvents).values({
    provider: 'cursor',
    modelId,
    effort: snapshot?.effort ?? null,
    feature: 'cloud-agent',
    project: input.project.trim() || run?.projectId || 'unknown',
    skillPath: snapshot?.skillPath ?? null,
    threadId: run?.threadId ?? null,
    runId: input.runId,
    entityType: run?.devSessionId ? 'dev-session' : null,
    entityId: run?.devSessionId ?? null,
    workItemId: workItemId != null ? String(workItemId) : null,
    userId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokenSource,
    costUsd: costUsd.toFixed(8),
    costSource: tokenSource === 'exact' && costUsd > 0 ? 'computed' : 'estimated',
    durationMs: durationMs(input.durationMs, run?.startedAt),
    status: usageStatus(input.status),
  }).onConflictDoNothing();
}
