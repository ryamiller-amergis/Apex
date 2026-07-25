/**
 * loadTestRunService — FEAT-007 Load Test Run Lifecycle and Dispatch
 *
 * Sole writer of load_test_run rows (BR-008). Owns enqueue/dispatch, status
 * machine, cancel, ingest/progress, pass/fail aggregation, and stale reaper.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db/drizzle';
import { loadTestRuns } from '../../db/schema';
import type {
  ArtifactRef,
  LoadTestDispatchMessage,
  LoadTestExecutionSnapshot,
  LoadTestRun,
  LoadTestRunIngestBody,
  LoadTestRunSource,
  RunStatus,
  ThresholdResult,
} from '../../../shared/types/loadTest';
import { LoadTestValidationError } from '../../../shared/types/loadTest';
import {
  assertAllowlistedNonProd,
  enforceProfileCaps,
  getDefinition,
} from '../loadTestService';
import { normalizeTargetUrl } from '../loadTestTargetService';
import { getDispatchPublisher, resolveCallbackBaseUrl } from './dispatchPublisher';
import { mapRunRow } from './mapRun';
import { publishRunProgress } from './progressHub';
import { tryPromoteNextQueuedRun } from './promote';
import {
  assertTransition,
  evaluateThresholdOutcome,
  isTerminalStatus,
  LOCK_STATUSES,
} from './statusMachine';
import { startLoadTestRunReaper } from './reaper';

export {
  assertTransition,
  evaluateThresholdOutcome,
  isTerminalStatus,
  LOCK_STATUSES,
} from './statusMachine';
export {
  setDispatchPublisher,
  getDispatchPublisher,
  resolveCallbackBaseUrl,
} from './dispatchPublisher';
export {
  publishRunProgress,
  subscribeRunProgress,
  resetRunProgressHub,
} from './progressHub';
export {
  reapStaleLoadTestRuns,
  startLoadTestRunReaper,
  stopLoadTestRunReaper,
  resolveHeartbeatStaleMs,
} from './reaper';

function assertProjectId(projectId: unknown): asserts projectId is string {
  if (!projectId || typeof projectId !== 'string') {
    throw new LoadTestValidationError('projectId is required', 'LOAD_TEST_VALIDATION');
  }
}

function parseArtifactRef(
  value: string | ArtifactRef | undefined,
): ArtifactRef | null {
  if (!value) return null;
  if (typeof value === 'object' && value.container && value.key) {
    return { container: value.container, key: value.key };
  }
  if (typeof value === 'string') {
    // Accept "container/key" or raw URI-ish strings as key with default container.
    const container =
      process.env.LT_BLOB_CONTAINER_NAME?.trim() || 'lt-artifacts';
    const trimmed = value.replace(/^\/+/, '');
    const slash = trimmed.indexOf('/');
    if (slash > 0) {
      return { container: trimmed.slice(0, slash), key: trimmed.slice(slash + 1) };
    }
    return { container, key: trimmed };
  }
  return null;
}

function buildSnapshot(
  definition: NonNullable<Awaited<ReturnType<typeof getDefinition>>>,
): LoadTestExecutionSnapshot {
  return {
    targetUrl: definition.targetUrl,
    script: definition.script,
    loadProfile: definition.loadProfile,
    clientThresholds: definition.clientThresholds,
    secretRefs: definition.secretRefs ? { ...definition.secretRefs } : {},
    environment: definition.environment,
    definitionName: definition.name,
  };
}

export async function getRun(
  projectId: string,
  runId: string,
): Promise<LoadTestRun | null> {
  assertProjectId(projectId);
  const rows = await db
    .select()
    .from(loadTestRuns)
    .where(and(eq(loadTestRuns.id, runId), eq(loadTestRuns.projectId, projectId)))
    .limit(1);
  return rows.length > 0 ? mapRunRow(rows[0]) : null;
}

export async function listRuns(
  projectId: string,
  options?: {
    definitionId?: string;
    status?: RunStatus;
    limit?: number;
  },
): Promise<{ items: LoadTestRun[] }> {
  assertProjectId(projectId);
  const conditions = [eq(loadTestRuns.projectId, projectId)];
  if (options?.definitionId) {
    conditions.push(eq(loadTestRuns.loadTestId, options.definitionId));
  }
  if (options?.status) {
    conditions.push(eq(loadTestRuns.status, options.status));
  }

  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const rows = await db
    .select()
    .from(loadTestRuns)
    .where(and(...conditions))
    .orderBy(desc(loadTestRuns.createdAt))
    .limit(limit);

  return { items: rows.map(mapRunRow) };
}

/**
 * Enqueue a run for a definition (PBI-008 AC-0/1/2, TBI-007 DoD-0).
 * Re-validates allowlist/non-prod/caps; freezes execution snapshot; publishes
 * Service Bus when the target execution lock is free; otherwise leaves queued.
 */
export async function enqueue(
  projectId: string,
  definitionId: string,
  options?: { runSource?: LoadTestRunSource },
): Promise<LoadTestRun> {
  assertProjectId(projectId);
  startLoadTestRunReaper();

  const definition = await getDefinition(projectId, definitionId);
  if (!definition) {
    throw new LoadTestValidationError(
      'Load test definition not found in this project',
      'LOAD_TEST_NOT_FOUND',
    );
  }

  // Fail closed before insert / publish (A-007, BR-001/002/004)
  enforceProfileCaps(definition.loadProfile);
  await assertAllowlistedNonProd(
    projectId,
    definition.targetUrl,
    definition.environment,
  );

  const targetKey = normalizeTargetUrl(definition.targetUrl);
  const snapshot = buildSnapshot(definition);
  const runSource: LoadTestRunSource = options?.runSource ?? 'app';
  const nowIso = new Date().toISOString();

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

  const targetBusy = active.length > 0;
  const dispatchMessageId = randomUUID();

  const inserted = await db
    .insert(loadTestRuns)
    .values({
      projectId,
      loadTestId: definitionId,
      status: 'queued',
      runSource,
      targetKey,
      executionSnapshot: snapshot,
      dispatchMessageId: targetBusy ? null : dispatchMessageId,
      queuedAt: nowIso,
      heartbeatAt: nowIso,
      updatedAt: nowIso,
    })
    .returning();

  let run = mapRunRow(inserted[0]);

  if (targetBusy) {
    // PBI-008 AC-2: remain queued; do not parallel-start / publish
    publishRunProgress({
      type: 'status',
      runId: run.id,
      projectId: run.projectId,
      status: run.status,
      at: nowIso,
    });
    return run;
  }

  const message: LoadTestDispatchMessage = {
    dispatchMessageId,
    projectId,
    runId: run.id,
    definitionId,
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
    const errored = await db
      .update(loadTestRuns)
      .set({
        status: 'errored',
        errorDetail: detail,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(loadTestRuns.id, run.id))
      .returning();
    return mapRunRow(errored[0]);
  }

  const dispatched = await db
    .update(loadTestRuns)
    .set({
      status: 'dispatched',
      dispatchMessageId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(loadTestRuns.id, run.id))
    .returning();

  run = mapRunRow(dispatched[0]);
  publishRunProgress({
    type: 'status',
    runId: run.id,
    projectId: run.projectId,
    status: run.status,
    at: run.updatedAt,
  });
  return run;
}

/**
 * Request cooperative cancel (PBI-008 cancel / TBI-007 DoD-2 / A-008).
 * Idempotent on already-terminal runs.
 */
export async function cancel(
  projectId: string,
  runId: string,
): Promise<LoadTestRun> {
  assertProjectId(projectId);
  const existing = await getRun(projectId, runId);
  if (!existing) {
    throw new LoadTestValidationError(
      'Load test run not found in this project',
      'LOAD_TEST_NOT_FOUND',
    );
  }

  if (isTerminalStatus(existing.status)) {
    return existing;
  }

  const nowIso = new Date().toISOString();

  // Queued (not yet dispatched) can move directly to cancelled without runner.
  if (existing.status === 'queued' && !existing.dispatchMessageId) {
    const updated = await db
      .update(loadTestRuns)
      .set({
        cancelRequested: true,
        status: 'cancelled',
        completedAt: nowIso,
        updatedAt: nowIso,
      })
      .where(and(eq(loadTestRuns.id, runId), eq(loadTestRuns.projectId, projectId)))
      .returning();
    const mapped = mapRunRow(updated[0]);
    publishRunProgress({
      type: 'cancel',
      runId: mapped.id,
      projectId: mapped.projectId,
      status: mapped.status,
      cancelRequested: true,
      at: nowIso,
    });
    if (mapped.targetKey) {
      await tryPromoteNextQueuedRun(mapped.projectId, mapped.targetKey);
    }
    return mapped;
  }

  const updated = await db
    .update(loadTestRuns)
    .set({
      cancelRequested: true,
      updatedAt: nowIso,
    })
    .where(and(eq(loadTestRuns.id, runId), eq(loadTestRuns.projectId, projectId)))
    .returning();

  const mapped = mapRunRow(updated[0]);
  publishRunProgress({
    type: 'cancel',
    runId: mapped.id,
    projectId: mapped.projectId,
    status: mapped.status,
    cancelRequested: true,
    at: nowIso,
  });
  return mapped;
}

/**
 * Apply runner ingest (progress | final | cancel_ack). Project-scoped; rejects
 * mismatched dispatchMessageId. Caller must authenticate runner identity first.
 */
export async function ingest(
  projectId: string,
  runId: string,
  body: LoadTestRunIngestBody,
): Promise<LoadTestRun> {
  assertProjectId(projectId);

  if (!body?.dispatchMessageId || !body?.kind) {
    throw new LoadTestValidationError(
      'dispatchMessageId and kind are required',
      'LOAD_TEST_VALIDATION',
    );
  }

  const existing = await getRun(projectId, runId);
  if (!existing) {
    throw new LoadTestValidationError(
      'Load test run not found in this project',
      'LOAD_TEST_NOT_FOUND',
    );
  }

  if (
    existing.dispatchMessageId &&
    existing.dispatchMessageId !== body.dispatchMessageId
  ) {
    throw new LoadTestValidationError(
      'dispatchMessageId does not match this run',
      'LOAD_TEST_DISPATCH_MISMATCH',
    );
  }

  const nowIso = new Date().toISOString();
  const heartbeatAt = body.heartbeatAt ?? nowIso;

  if (body.kind === 'progress') {
    if (isTerminalStatus(existing.status)) {
      return existing;
    }
    const nextStatus: RunStatus =
      existing.status === 'queued' || existing.status === 'dispatched'
        ? 'running'
        : existing.status;
    if (nextStatus !== existing.status) {
      assertTransition(existing.status, nextStatus);
    }

    const updated = await db
      .update(loadTestRuns)
      .set({
        status: nextStatus,
        heartbeatAt,
        startedAt: existing.startedAt ?? (nextStatus === 'running' ? nowIso : null),
        updatedAt: nowIso,
      })
      .where(and(eq(loadTestRuns.id, runId), eq(loadTestRuns.projectId, projectId)))
      .returning();

    const mapped = mapRunRow(updated[0]);
    publishRunProgress({
      type: 'progress',
      runId: mapped.id,
      projectId: mapped.projectId,
      status: mapped.status,
      progress: body.progress,
      at: nowIso,
    });
    return mapped;
  }

  if (body.kind === 'cancel_ack') {
    if (isTerminalStatus(existing.status)) {
      return existing;
    }
    assertTransition(existing.status, 'cancelled');
    const updated = await db
      .update(loadTestRuns)
      .set({
        status: 'cancelled',
        cancelRequested: true,
        completedAt: nowIso,
        heartbeatAt,
        updatedAt: nowIso,
        errorDetail: body.errorDetail ?? existing.errorDetail ?? null,
      })
      .where(and(eq(loadTestRuns.id, runId), eq(loadTestRuns.projectId, projectId)))
      .returning();
    const mapped = mapRunRow(updated[0]);
    publishRunProgress({
      type: 'terminal',
      runId: mapped.id,
      projectId: mapped.projectId,
      status: mapped.status,
      cancelRequested: true,
      at: nowIso,
    });
    if (mapped.targetKey) {
      await tryPromoteNextQueuedRun(mapped.projectId, mapped.targetKey);
    }
    return mapped;
  }

  // kind === 'final'
  if (isTerminalStatus(existing.status)) {
    return existing;
  }

  const thresholdResults = body.thresholdResults as ThresholdResult[] | undefined;
  let terminal: RunStatus;
  let overallResult: 'passed' | 'failed' | null = null;

  if (body.errorDetail && (!thresholdResults || thresholdResults.length === 0)) {
    terminal = 'errored';
  } else {
    const outcome = evaluateThresholdOutcome(thresholdResults);
    if (outcome === 'errored') {
      terminal = 'errored';
    } else {
      terminal = outcome;
      overallResult = outcome;
    }
  }

  // Move queued → dispatched first if needed, then to terminal.
  let fromStatus = existing.status;
  if (fromStatus === 'queued') {
    assertTransition('queued', 'dispatched');
    fromStatus = 'dispatched';
  }
  assertTransition(fromStatus, terminal);

  const summaryArtifactRef = parseArtifactRef(body.summaryBlobRef);
  const timeseriesArtifactRef = parseArtifactRef(body.timeseriesBlobRef);

  const updated = await db
    .update(loadTestRuns)
    .set({
      status: terminal,
      overallResult,
      thresholdResults: thresholdResults ?? null,
      summaryArtifactRef,
      timeseriesArtifactRef,
      errorDetail: body.errorDetail ?? null,
      completedAt: nowIso,
      heartbeatAt,
      startedAt: existing.startedAt ?? nowIso,
      updatedAt: nowIso,
    })
    .where(and(eq(loadTestRuns.id, runId), eq(loadTestRuns.projectId, projectId)))
    .returning();

  const mapped = mapRunRow(updated[0]);
  publishRunProgress({
    type: 'terminal',
    runId: mapped.id,
    projectId: mapped.projectId,
    status: mapped.status,
    thresholdResults: mapped.thresholdResults,
    overallResult: mapped.overallResult,
    at: nowIso,
  });

  if (mapped.targetKey) {
    await tryPromoteNextQueuedRun(mapped.projectId, mapped.targetKey);
  }

  return mapped;
}

/** Oldest queued waiters for a target (test/ops helper). */
export async function listQueuedForTarget(
  projectId: string,
  targetKey: string,
): Promise<LoadTestRun[]> {
  const rows = await db
    .select()
    .from(loadTestRuns)
    .where(
      and(
        eq(loadTestRuns.projectId, projectId),
        eq(loadTestRuns.targetKey, targetKey),
        eq(loadTestRuns.status, 'queued'),
      ),
    )
    .orderBy(asc(loadTestRuns.queuedAt));
  return rows.map(mapRunRow);
}
