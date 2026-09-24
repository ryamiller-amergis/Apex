import './ai-run-v2-persistence.setup';
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../src/server/db';
import type {
  DurableInteractiveTurnSpecification,
  InteractiveClass,
} from '../../src/shared/types/durableInteractiveTurn';
import {
  createDurableInteractiveTurnRepository,
  type PreparedDurableInteractiveTurn,
  type RetryDurableInteractiveRunInput,
} from '../../src/server/services/durableInteractiveTurnRepository';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260923140000_durable-interactive-turns.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8');
const [upSql = ''] = migrationSql.split(/-- Down Migration/i);

const THREAD_ID = '12000000-0000-4000-8000-000000000001';
const USER_ID = '42000000-0000-4000-8000-000000000001';
const OTHER_THREAD_A = '12000000-0000-4000-8000-000000000002';
const OTHER_THREAD_B = '12000000-0000-4000-8000-000000000003';
const TURN_ID = '22000000-0000-4000-8000-000000000001';
const OTHER_TURN_A = '22000000-0000-4000-8000-000000000002';
const OTHER_TURN_B = '22000000-0000-4000-8000-000000000003';
const ALL_THREADS = [THREAD_ID, OTHER_THREAD_A, OTHER_THREAD_B] as const;

function specification(input: {
  threadId: string;
  turnId: string;
  userId: string;
  interactiveClass?: InteractiveClass;
}): DurableInteractiveTurnSpecification {
  const interactiveClass = input.interactiveClass ?? 'fast';
  return {
    schemaVersion: 1,
    kind: 'interactive-turn',
    turnId: input.turnId,
    threadId: input.threadId,
    userId: input.userId,
    projectId: 'project-1',
    interactiveClass,
    workflowClass: 'home-chat',
    model: 'model-a',
    effort: 'low',
    skill: null,
    currentMessage: {
      id: input.turnId,
      text: 'Hello',
      hidden: false,
      attachments: [],
    },
    transcript: [],
    grounding: null,
    mcpServers: [],
    toolGrant: null,
    currentPrompt: 'Hello',
    recreationPrompt: 'Hello',
    deadlines: {
      absoluteTurnMs: interactiveClass === 'fast' ? 300_000 : 1_200_000,
      repositoryPreparationMs: null,
      firstEventMs: 45_000,
      toolCallMs: 60_000,
    },
  };
}

function preparedTurn(input: {
  threadId: string;
  turnId: string;
  userId: string;
}): PreparedDurableInteractiveTurn {
  return {
    turnId: input.turnId,
    requestHash: 'a'.repeat(64),
    threadId: input.threadId,
    userId: input.userId,
    projectId: 'project-1',
    interactiveClass: 'fast',
    messageText: 'Hello',
    hidden: false,
    attachments: [],
    specification: specification(input),
  };
}

function retryInput(runId: string): RetryDurableInteractiveRunInput {
  return {
    threadId: THREAD_ID,
    runId,
    userId: USER_ID,
    refreshedToolGrant: null,
    refreshedDeadlines: {
      absoluteTurnMs: 300_000,
      repositoryPreparationMs: null,
      firstEventMs: 45_000,
      toolCallMs: 60_000,
    },
  };
}

async function hasDurableColumns(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'agent_runs'
         AND column_name = 'interactive_class'
     ) AS exists`,
  );
  return result.rows[0]?.exists ?? false;
}

async function insertThread(threadId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO chat_threads (
       id, user_id, status, kickoff, created_at, last_activity_at
     ) VALUES (
       $1::uuid, $2, 'idle',
       '{"project":"project-1","repo":"repo-1"}'::jsonb,
       now(), now()
     )`,
    [threadId, userId],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM ai_run_outbox
     WHERE run_id IN (
       SELECT id FROM agent_runs WHERE thread_id = ANY($1::text[])
     )`,
    [ALL_THREADS],
  );
  await pool.query(
    `DELETE FROM agent_run_events WHERE thread_id = ANY($1::text[])`,
    [ALL_THREADS],
  );
  await pool.query(
    `DELETE FROM agent_runs WHERE thread_id = ANY($1::text[])`,
    [ALL_THREADS],
  );
  await pool.query(
    `DELETE FROM chat_messages WHERE thread_id = ANY($1::uuid[])`,
    [ALL_THREADS],
  );
  await pool.query(
    `DELETE FROM chat_threads WHERE id = ANY($1::uuid[])`,
    [ALL_THREADS],
  );
}

async function markRunFailed(runId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_runs
     SET status = 'failed',
         updated_at = now()
     WHERE id = $1`,
    [runId],
  );
  await pool.query(
    `UPDATE ai_run_attempts
     SET status = 'failed', updated_at = now()
     WHERE run_id = $1`,
    [runId],
  );
  await pool.query(
    `UPDATE ai_run_outbox
     SET published_at = now()
     WHERE run_id = $1 AND published_at IS NULL`,
    [runId],
  );
  await pool.query(
    `UPDATE chat_threads
     SET status = 'error', active_run_id = NULL
     WHERE id = $1::uuid`,
    [THREAD_ID],
  );
}

describe('durable interactive retry integration', () => {
  beforeAll(async () => {
    if (!(await hasDurableColumns())) {
      await pool.query(upSql);
    }
  });

  beforeEach(async () => {
    await cleanup();
    await insertThread(THREAD_ID, USER_ID);
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await pool.end();
    }
  });

  it('concurrent double-retry keeps one run, one message, two attempts, new fence, one outbox', async () => {
    const repository = createDurableInteractiveTurnRepository();
    const admitted = await repository.admit(
      preparedTurn({ threadId: THREAD_ID, turnId: TURN_ID, userId: USER_ID }),
    );
    if (!('runId' in admitted)) {
      throw new Error('expected admission success');
    }
    const firstFence = await pool.query<{ dispatch_message_id: string }>(
      `SELECT dispatch_message_id FROM ai_run_attempts WHERE run_id = $1`,
      [admitted.runId],
    );
    await markRunFailed(admitted.runId);

    const [first, second] = await Promise.all([
      repository.retry(retryInput(admitted.runId)),
      repository.retry(retryInput(admitted.runId)),
    ]);

    expect('runId' in first && first.runId).toBe(admitted.runId);
    expect('runId' in second && second.runId).toBe(admitted.runId);

    const runs = await pool.query(`SELECT id FROM agent_runs WHERE thread_id = $1`, [
      THREAD_ID,
    ]);
    const messages = await pool.query(
      `SELECT id FROM chat_messages WHERE thread_id = $1::uuid`,
      [THREAD_ID],
    );
    const attempts = await pool.query<{
      attempt_number: number;
      dispatch_message_id: string;
      status: string;
    }>(
      `SELECT attempt_number, dispatch_message_id, status
       FROM ai_run_attempts
       WHERE run_id = $1
       ORDER BY attempt_number ASC`,
      [admitted.runId],
    );
    const outbox = await pool.query(
      `SELECT id FROM ai_run_outbox
       WHERE run_id = $1 AND published_at IS NULL AND kind = 'interactive_dispatch'`,
      [admitted.runId],
    );
    const thread = await pool.query<{ active_run_id: string | null }>(
      `SELECT active_run_id FROM chat_threads WHERE id = $1::uuid`,
      [THREAD_ID],
    );

    expect(runs.rowCount).toBe(1);
    expect(messages.rowCount).toBe(1);
    expect(attempts.rowCount).toBe(2);
    expect(attempts.rows[1]?.attempt_number).toBe(2);
    expect(attempts.rows[1]?.dispatch_message_id).not.toBe(
      firstFence.rows[0]?.dispatch_message_id,
    );
    expect(outbox.rowCount).toBe(1);
    expect(thread.rows[0]?.active_run_id).toBe(admitted.runId);
  });

  it('user cap rejection adds no attempt or outbox', async () => {
    const repository = createDurableInteractiveTurnRepository();
    await insertThread(OTHER_THREAD_A, USER_ID);
    await insertThread(OTHER_THREAD_B, USER_ID);

    const failed = await repository.admit(
      preparedTurn({ threadId: THREAD_ID, turnId: TURN_ID, userId: USER_ID }),
    );
    if (!('runId' in failed)) throw new Error('expected failed-run admission');
    await markRunFailed(failed.runId);

    await repository.admit(
      preparedTurn({
        threadId: OTHER_THREAD_A,
        turnId: OTHER_TURN_A,
        userId: USER_ID,
      }),
    );
    await repository.admit(
      preparedTurn({
        threadId: OTHER_THREAD_B,
        turnId: OTHER_TURN_B,
        userId: USER_ID,
      }),
    );

    const beforeAttempts = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ai_run_attempts WHERE run_id = $1`,
      [failed.runId],
    );
    const beforeOutbox = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ai_run_outbox WHERE run_id = $1`,
      [failed.runId],
    );

    const result = await repository.retry(retryInput(failed.runId));
    expect(result).toEqual({
      status: 'user_limit',
      code: 'USER_INTERACTIVE_LIMIT',
    });

    const afterAttempts = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ai_run_attempts WHERE run_id = $1`,
      [failed.runId],
    );
    const afterOutbox = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ai_run_outbox WHERE run_id = $1`,
      [failed.runId],
    );
    expect(afterAttempts.rows[0]?.count).toBe(beforeAttempts.rows[0]?.count);
    expect(afterOutbox.rows[0]?.count).toBe(beforeOutbox.rows[0]?.count);
  });
});
