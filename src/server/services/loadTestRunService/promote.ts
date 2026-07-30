/**
 * Promote the oldest queued run for a target once the execution lock is free.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db/drizzle';
import { loadTestRuns } from '../../db/schema';
import type { LoadTestDispatchMessage, LoadTestRun } from '../../../shared/types/loadTest';
import { getDispatchPublisher, resolveCallbackBaseUrl } from './dispatchPublisher';
import { mapRunRow } from './mapRun';
import { publishRunProgress } from './progressHub';
import { LOCK_STATUSES } from './statusMachine';

export async function tryPromoteNextQueuedRun(
  projectId: string,
  targetKey: string,
): Promise<LoadTestRun | null> {
  const active = await db
    .select({ id: loadTestRuns.id })
    .from(loadTestRuns)
    .where(
      and(
        eq(loadTestRuns.projectId, projectId),
        eq(loadTestRuns.targetKey, targetKey),
        inArray(loadTestRuns.status, LOCK_STATUSES),
      ),
    )
    .limit(1);

  if (active.length > 0) return null;

  const waiting = await db
    .select()
    .from(loadTestRuns)
    .where(
      and(
        eq(loadTestRuns.projectId, projectId),
        eq(loadTestRuns.targetKey, targetKey),
        eq(loadTestRuns.status, 'queued'),
      ),
    )
    .orderBy(asc(loadTestRuns.queuedAt))
    .limit(1);

  if (waiting.length === 0) return null;

  const row = waiting[0];
  const snapshot = row.executionSnapshot;
  if (!snapshot) return null;

  const dispatchMessageId = row.dispatchMessageId || randomUUID();
  const nowIso = new Date().toISOString();

  const message: LoadTestDispatchMessage = {
    dispatchMessageId,
    projectId,
    runId: row.id,
    definitionId: row.loadTestId,
    targetUrl: snapshot.targetUrl,
    environment: snapshot.environment,
    script: snapshot.script,
    loadProfile: snapshot.loadProfile,
    clientThresholds: snapshot.clientThresholds,
    secretRefs: snapshot.secretRefs,
    callbackBaseUrl: resolveCallbackBaseUrl(),
  };

  try {
    await getDispatchPublisher().publish(message);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Dispatch publish failed';
    await db
      .update(loadTestRuns)
      .set({
        status: 'errored',
        errorDetail: detail,
        completedAt: nowIso,
        updatedAt: nowIso,
      })
      .where(eq(loadTestRuns.id, row.id));
    return null;
  }

  const updated = await db
    .update(loadTestRuns)
    .set({
      status: 'dispatched',
      dispatchMessageId,
      heartbeatAt: nowIso,
      updatedAt: nowIso,
    })
    .where(and(eq(loadTestRuns.id, row.id), eq(loadTestRuns.status, 'queued')))
    .returning();

  if (updated.length === 0) return null;

  const mapped = mapRunRow(updated[0]);
  publishRunProgress({
    type: 'status',
    runId: mapped.id,
    projectId: mapped.projectId,
    status: mapped.status,
    at: nowIso,
  });
  return mapped;
}
