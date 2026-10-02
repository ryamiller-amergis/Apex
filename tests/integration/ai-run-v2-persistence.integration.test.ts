/**
 * Task 3 durable AI-run V2 persistence integration tests.
 *
 * Requires an explicitly approved `_e2e` PostgreSQL database with migrations applied.
 * Never infers or uses a production database.
 *
 * Run:
 *   npm run test:integration -- ai-run-v2-persistence.integration.test.ts --runInBand
 */

import './ai-run-v2-persistence.setup';
import { sql } from 'drizzle-orm';
import pool from '../../src/server/db';
import { db } from '../../src/server/db/drizzle';
import { AI_RUN_V2_SCHEMA_VERSION } from '../../src/shared/types/aiRunV2';
import {
  createPostgresDistributedLeaseStore,
  tryAcquireLease,
} from '../../src/server/services/aiRunV2/distributedLeaseRepository';
import { createInboxRepository } from '../../src/server/services/aiRunV2/inboxRepository';
import { createOutboxRepository } from '../../src/server/services/aiRunV2/outboxRepository';
import { createRunAttemptRepository } from '../../src/server/services/aiRunV2/runAttemptRepository';

const PREFIX = 'airunv2-persist-';
const specRef = {
  container: 'ai-run-artifacts',
  key: `${PREFIX}spec.json`,
};

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM ai_run_inbox WHERE run_id LIKE $1 OR attempt_id LIKE $1`,
    [`${PREFIX}%`]
  );
  await pool.query(
    `DELETE FROM ai_run_outbox WHERE run_id LIKE $1 OR idempotency_key LIKE $1`,
    [`${PREFIX}%`]
  );
  await pool.query(
    `DELETE FROM agent_runs WHERE id LIKE $1 OR thread_id LIKE $1`,
    [`${PREFIX}%`]
  );
  await pool.query(
    `UPDATE ai_control_plane_leases
     SET holder_id = NULL, expires_at = 'epoch', updated_at = now()
     WHERE lease_key IN ('admission', 'recovery', 'reaper', 'outbox')`
  );
}

function timeoutIso(hoursAhead = 1): string {
  return new Date(Date.now() + hoursAhead * 60 * 60_000).toISOString();
}

describe('AI-run V2 persistence integration', () => {
  beforeAll(async () => {
    const tables = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass('public.ai_run_attempts') IS NOT NULL AS exists`
    );
    if (!tables.rows[0]?.exists) {
      throw new Error(
        '[ai-run-v2-persistence] ai_run_attempts missing — migrate the *_e2e database first'
      );
    }
  });

  beforeEach(cleanup);
  afterEach(cleanup);

  afterAll(async () => {
    await pool.end();
  });

  it('defaults new agent_runs rows to http-files-v1 transport', async () => {
    const runId = `${PREFIX}v1-default`;
    await pool.query(
      `INSERT INTO agent_runs (
         id, thread_id, status, project_id, lane, queued_at,
         cancel_requested, heartbeat_at, started_at, timeout_at, created_at, updated_at
       ) VALUES (
         $1, $2, 'queued', 'project-1', 'background', now(),
         FALSE, now(), now(), $3, now(), now()
       )`,
      [runId, `${PREFIX}thread-v1`, timeoutIso()]
    );
    const result = await pool.query<{
      transport_version: string;
      status: string;
    }>(`SELECT transport_version, status FROM agent_runs WHERE id = $1`, [
      runId,
    ]);
    expect(result.rows[0]).toEqual({
      transport_version: 'http-files-v1',
      status: 'queued',
    });
  });

  it('enforces one active V2 run per thread across lanes and allows retry after terminal', async () => {
    const repo = createRunAttemptRepository();
    const threadId = `${PREFIX}thread-active`;

    const first = await repo.createQueuedV2Run({
      runId: `${PREFIX}active-1`,
      threadId,
      projectId: 'project-1',
      lane: 'background',
      timeoutAt: timeoutIso(),
      specRef,
    });
    expect(first.status).toBe('created');

    const conflictInteractive = await repo.createQueuedV2Run({
      runId: `${PREFIX}active-2`,
      threadId,
      projectId: 'project-1',
      lane: 'ai-runs-interactive',
      timeoutAt: timeoutIso(),
      specRef,
    });
    expect(conflictInteractive).toMatchObject({
      status: 'active_run_conflict',
      existingRunId: `${PREFIX}active-1`,
    });

    await pool.query(
      `UPDATE ai_run_attempts SET status = 'failed', updated_at = now() WHERE run_id = $1`,
      [`${PREFIX}active-1`]
    );
    await pool.query(
      `UPDATE agent_runs SET status = 'failed', updated_at = now() WHERE id = $1`,
      [`${PREFIX}active-1`]
    );

    const retry = await repo.createQueuedV2Run({
      runId: `${PREFIX}active-3`,
      threadId,
      projectId: 'project-1',
      lane: 'ai-runs-interactive',
      timeoutAt: timeoutIso(),
      specRef,
    });
    expect(retry.status).toBe('created');
  });

  it('dispatches monotonic attempts and rejects stale fences', async () => {
    const repo = createRunAttemptRepository();
    const runId = `${PREFIX}attempts-1`;
    const created = await repo.createQueuedV2Run({
      runId,
      threadId: `${PREFIX}thread-attempts`,
      projectId: 'project-1',
      lane: 'background',
      timeoutAt: timeoutIso(),
      specRef,
    });
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;

    const firstDispatch = await repo.dispatchNextAttempt({
      runId,
      dispatchMessageId: `${PREFIX}dispatch-1`,
      workloadLane: 'document',
      capacityClass: 'batch',
      specRef,
    });
    expect(firstDispatch.attemptNumber).toBe(1);
    expect(firstDispatch.dispatchMessageId).toBe(`${PREFIX}dispatch-1`);
    expect(firstDispatch.outboxId).toBeTruthy();

    await expect(
      repo.transitionAttempt({
        attemptId: firstDispatch.attemptId,
        expectedDispatchMessageId: `${PREFIX}dispatch-stale`,
        to: 'running',
      })
    ).resolves.toEqual({ status: 'fence_mismatch' });

    await expect(
      repo.transitionAttempt({
        attemptId: firstDispatch.attemptId,
        expectedDispatchMessageId: `${PREFIX}dispatch-1`,
        to: 'running',
      })
    ).resolves.toEqual({
      status: 'ok',
      attemptId: firstDispatch.attemptId,
      to: 'running',
      run: null,
    });

    await repo.transitionAttempt({
      attemptId: firstDispatch.attemptId,
      expectedDispatchMessageId: `${PREFIX}dispatch-1`,
      to: 'failed',
      failureCategory: 'worker_lost',
    });

    const secondDispatch = await repo.dispatchNextAttempt({
      runId,
      dispatchMessageId: `${PREFIX}dispatch-2`,
      workloadLane: 'document',
      capacityClass: 'batch',
      specRef,
    });
    expect(secondDispatch.attemptNumber).toBe(2);
    expect(secondDispatch.dispatchMessageId).toBe(`${PREFIX}dispatch-2`);
  });

  it('rolls back attempt + outbox together when the transaction fails', async () => {
    const runId = `${PREFIX}rollback-1`;
    await pool.query(
      `INSERT INTO agent_runs (
         id, thread_id, status, project_id, lane, queued_at,
         cancel_requested, heartbeat_at, started_at, timeout_at,
         transport_version, created_at, updated_at
       ) VALUES (
         $1, $2, 'queued', 'project-1', 'background', now(),
         FALSE, now(), now(), $3, 'servicebus-blob-v2', now(), now()
       )`,
      [runId, `${PREFIX}thread-rollback`, timeoutIso()]
    );

    await expect(
      db.transaction(async (tx) => {
        const executor = {
          execute: (query: unknown) => tx.execute(query as never),
        };
        const outbox = createOutboxRepository(executor);
        await tx.execute(sql`
          INSERT INTO ai_run_attempts (
            id, run_id, attempt_number, dispatch_message_id, status, artifact_status, spec_ref
          ) VALUES (
            ${`${PREFIX}attempt-rb-1`},
            ${runId},
            1,
            ${`${PREFIX}dispatch-rb`},
            'dispatched',
            'pending',
            ${JSON.stringify(specRef)}::jsonb
          )
        `);
        await outbox.enqueue([
          {
            idempotencyKey: `${PREFIX}outbox-rb`,
            kind: 'dispatch_command',
            runId,
            attemptId: `${PREFIX}attempt-rb-1`,
            payload: { kind: 'dispatch_command' },
          },
        ]);
        await tx.execute(sql`
          INSERT INTO ai_run_attempts (
            id, run_id, attempt_number, dispatch_message_id, status, artifact_status, spec_ref
          ) VALUES (
            ${`${PREFIX}attempt-rb-2`},
            ${runId},
            2,
            ${`${PREFIX}dispatch-rb`},
            'dispatched',
            'pending',
            ${JSON.stringify(specRef)}::jsonb
          )
        `);
      })
    ).rejects.toThrow();

    const attempts = await pool.query(
      `SELECT id FROM ai_run_attempts WHERE run_id = $1`,
      [runId]
    );
    const outboxRows = await pool.query(
      `SELECT id FROM ai_run_outbox WHERE run_id = $1`,
      [runId]
    );
    expect(attempts.rows).toHaveLength(0);
    expect(outboxRows.rows).toHaveLength(0);
  });

  it('claims non-overlapping outbox batches and recovers unprocessed inbox duplicates', async () => {
    const executor = {
      execute: (query: unknown) => db.execute(query as never),
    };
    const outbox = createOutboxRepository(executor);
    const inbox = createInboxRepository(executor);

    await pool.query(
      `INSERT INTO agent_runs (
         id, thread_id, status, project_id, lane, queued_at,
         cancel_requested, heartbeat_at, started_at, timeout_at,
         transport_version, created_at, updated_at
       ) VALUES (
         $1, $2, 'running', 'project-1', 'background', now(),
         FALSE, now(), now(), $3, 'servicebus-blob-v2', now(), now()
       )`,
      [`${PREFIX}outbox-run`, `${PREFIX}thread-outbox`, timeoutIso()]
    );

    await outbox.enqueue([
      {
        idempotencyKey: `${PREFIX}outbox-a`,
        kind: 'dispatch_command',
        runId: `${PREFIX}outbox-run`,
        attemptId: `${PREFIX}attempt-a`,
        payload: { n: 1 },
      },
      {
        idempotencyKey: `${PREFIX}outbox-b`,
        kind: 'dispatch_command',
        runId: `${PREFIX}outbox-run`,
        attemptId: `${PREFIX}attempt-b`,
        payload: { n: 2 },
      },
    ]);
    const again = await outbox.enqueue([
      {
        idempotencyKey: `${PREFIX}outbox-a`,
        kind: 'dispatch_command',
        runId: `${PREFIX}outbox-run`,
        payload: { n: 1 },
      },
    ]);
    expect(again).toHaveLength(0);

    const [batchA, batchB] = await Promise.all([
      outbox.claimBatch(1, 'publisher-a', 5_000),
      outbox.claimBatch(1, 'publisher-b', 5_000),
    ]);
    const claimedIds = [...batchA, ...batchB].map((row) => row.id);
    expect(new Set(claimedIds).size).toBe(2);

    const firstClaim = await inbox.claimEvent({
      eventId: `${PREFIX}evt-1`,
      kind: 'checkpoint',
      runId: `${PREFIX}outbox-run`,
      attemptId: `${PREFIX}attempt-a`,
      dispatchMessageId: `${PREFIX}dispatch-inbox`,
      checkpointSequence: 1,
      payload: { seq: 1 },
    });
    expect(firstClaim.status).toBe('inserted');

    const duplicateUnprocessed = await inbox.claimEvent({
      eventId: `${PREFIX}evt-1`,
      kind: 'checkpoint',
      runId: `${PREFIX}outbox-run`,
      attemptId: `${PREFIX}attempt-a`,
      dispatchMessageId: `${PREFIX}dispatch-inbox`,
      checkpointSequence: 1,
      payload: { seq: 1 },
    });
    expect(duplicateUnprocessed.status).toBe('duplicate_unprocessed');

    await inbox.markProcessed(`${PREFIX}evt-1`);
    const duplicateProcessed = await inbox.claimEvent({
      eventId: `${PREFIX}evt-1`,
      kind: 'checkpoint',
      runId: `${PREFIX}outbox-run`,
      attemptId: `${PREFIX}attempt-a`,
      dispatchMessageId: `${PREFIX}dispatch-inbox`,
      checkpointSequence: 1,
      payload: { seq: 1 },
    });
    expect(duplicateProcessed.status).toBe('duplicate_processed');
  });

  it('accepts monotonic checkpoints and rejects stale/duplicate sequences', async () => {
    const repo = createRunAttemptRepository();
    const runId = `${PREFIX}ckpt-run`;
    const created = await repo.createQueuedV2Run({
      runId,
      threadId: `${PREFIX}thread-ckpt`,
      projectId: 'project-1',
      lane: 'background',
      timeoutAt: timeoutIso(),
      specRef,
    });
    if (created.status !== 'created') throw new Error('expected created');

    const dispatch = await repo.dispatchNextAttempt({
      runId,
      dispatchMessageId: `${PREFIX}dispatch-ckpt`,
      workloadLane: 'document',
      capacityClass: 'batch',
      specRef,
    });

    const accepted = await repo.acceptCheckpoint({
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: `${PREFIX}ckpt-evt-1`,
      runId,
      attemptId: dispatch.attemptId,
      attemptNumber: 1,
      dispatchMessageId: `${PREFIX}dispatch-ckpt`,
      timestamp: new Date().toISOString(),
      kind: 'heartbeat',
      checkpointSequence: 1,
    });
    expect(accepted).toEqual({ status: 'accepted', checkpointSequence: 1 });

    const stale = await repo.acceptCheckpoint({
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: `${PREFIX}ckpt-evt-stale`,
      runId,
      attemptId: dispatch.attemptId,
      attemptNumber: 1,
      dispatchMessageId: `${PREFIX}dispatch-ckpt`,
      timestamp: new Date().toISOString(),
      kind: 'heartbeat',
      checkpointSequence: 1,
    });
    expect(stale).toEqual({
      status: 'stale_sequence',
      lastCheckpointSequence: 1,
    });

    const fenceMismatch = await repo.acceptCheckpoint({
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: `${PREFIX}ckpt-evt-fence`,
      runId,
      attemptId: dispatch.attemptId,
      attemptNumber: 1,
      dispatchMessageId: `${PREFIX}dispatch-wrong`,
      timestamp: new Date().toISOString(),
      kind: 'heartbeat',
      checkpointSequence: 2,
    });
    expect(fenceMismatch).toEqual({ status: 'fence_mismatch' });

    const next = await repo.acceptCheckpoint({
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: `${PREFIX}ckpt-evt-2`,
      runId,
      attemptId: dispatch.attemptId,
      attemptNumber: 1,
      dispatchMessageId: `${PREFIX}dispatch-ckpt`,
      timestamp: new Date().toISOString(),
      kind: 'progress',
      checkpointSequence: 2,
      progressPercent: 40,
    });
    expect(next).toEqual({ status: 'accepted', checkpointSequence: 2 });

    const duplicateEvent = await repo.acceptCheckpoint({
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: `${PREFIX}ckpt-evt-2`,
      runId,
      attemptId: dispatch.attemptId,
      attemptNumber: 1,
      dispatchMessageId: `${PREFIX}dispatch-ckpt`,
      timestamp: new Date().toISOString(),
      kind: 'progress',
      checkpointSequence: 3,
      progressPercent: 50,
    });
    expect(duplicateEvent).toEqual({ status: 'duplicate' });
  });

  it('elects one lease winner, supports expiry takeover, and rejects stale holders', async () => {
    const store = createPostgresDistributedLeaseStore({
      execute: (query) => db.execute(query as never),
    });

    const first = await tryAcquireLease('reaper', {
      holderId: `${PREFIX}owner-a`,
      leaseMs: 5_000,
      heartbeatMs: 4_000,
      store,
    });
    expect(first).not.toBeNull();
    const firstToken = first!.fencingToken;

    const blocked = await tryAcquireLease('reaper', {
      holderId: `${PREFIX}owner-b`,
      leaseMs: 5_000,
      heartbeatMs: 4_000,
      store,
    });
    expect(blocked).toBeNull();

    await pool.query(
      `UPDATE ai_control_plane_leases
       SET expires_at = now() - interval '1 second', updated_at = now()
       WHERE lease_key = 'reaper'`
    );

    const second = await tryAcquireLease('reaper', {
      holderId: `${PREFIX}owner-b`,
      leaseMs: 5_000,
      heartbeatMs: 4_000,
      store,
    });
    expect(second).not.toBeNull();
    expect(second!.fencingToken > firstToken).toBe(true);

    await expect(first!.assertOwned()).rejects.toThrow(/lease was lost/i);

    const staleRenew = await store.renew(
      'reaper',
      `${PREFIX}owner-a`,
      firstToken,
      5_000
    );
    expect(staleRenew).toBe(false);

    await second!.release();
  });

  it('prevents split-brain by requiring fencing token + holder for renew/release', async () => {
    const store = createPostgresDistributedLeaseStore({
      execute: (query) => db.execute(query as never),
    });
    const lease = await tryAcquireLease('outbox', {
      holderId: `${PREFIX}split-a`,
      leaseMs: 5_000,
      heartbeatMs: 4_000,
      store,
    });
    expect(lease).not.toBeNull();

    const forgedRelease = await store.release(
      'outbox',
      `${PREFIX}split-b`,
      lease!.fencingToken
    );
    expect(forgedRelease).toBe(false);

    const forgedToken = await store.release(
      'outbox',
      `${PREFIX}split-a`,
      lease!.fencingToken + 1n
    );
    expect(forgedToken).toBe(false);

    const row = await store.getLease('outbox');
    expect(row?.holderId).toBe(`${PREFIX}split-a`);
    await lease!.release();
  });
});
