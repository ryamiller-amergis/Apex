import './ai-run-v2-persistence.setup';
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../src/server/db';
import type { DurableInteractiveTurnSpecification } from '../../src/shared/types/durableInteractiveTurn';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260923140000_durable-interactive-turns.sql'
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8');
const [upSql = '', downSql = ''] = migrationSql.split(/-- Down Migration/i);

const PREFIX = 'durable-interactive-int-';
const LEGACY_THREAD_ID = '10000000-0000-4000-8000-000000000001';
const FIRST_THREAD_ID = '10000000-0000-4000-8000-000000000002';
const SECOND_THREAD_ID = '10000000-0000-4000-8000-000000000003';
const FIRST_TURN_ID = '20000000-0000-4000-8000-000000000001';
const DUPLICATE_TURN_ID = '20000000-0000-4000-8000-000000000002';
const SECOND_TURN_ID = '20000000-0000-4000-8000-000000000003';
const ATTACHMENT_ID = '30000000-0000-4000-8000-000000000001';
const ATTACHMENT_MESSAGE_ID = '30000000-0000-4000-8000-000000000002';
const USER_ID = `${PREFIX}user`;

const specification: DurableInteractiveTurnSpecification = {
  schemaVersion: 1,
  kind: 'interactive-turn',
  turnId: FIRST_TURN_ID,
  threadId: FIRST_THREAD_ID,
  userId: USER_ID,
  projectId: 'project-1',
  interactiveClass: 'fast',
  workflowClass: 'home-chat',
  model: 'model-a',
  effort: 'low',
  skill: null,
  currentMessage: {
    id: FIRST_TURN_ID,
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
    absoluteTurnMs: 300_000,
    repositoryPreparationMs: null,
    firstEventMs: 30_000,
    toolCallMs: 60_000,
  },
};

async function hasDurableColumns(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'agent_runs'
         AND column_name = 'interactive_class'
     ) AS exists`
  );
  return result.rows[0]?.exists ?? false;
}

async function cleanupFixtures(): Promise<void> {
  await pool.query(
    `DELETE FROM ai_run_outbox
     WHERE run_id LIKE $1 OR idempotency_key LIKE $1`,
    [`${PREFIX}%`]
  );
  await pool.query(`DELETE FROM agent_runs WHERE id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(
    `DELETE FROM chat_threads
     WHERE id::text = ANY($1::text[])`,
    [[LEGACY_THREAD_ID, FIRST_THREAD_ID, SECOND_THREAD_ID]]
  );
}

async function insertThread(threadId: string): Promise<void> {
  await pool.query(
    `INSERT INTO chat_threads (
       id, user_id, status, kickoff, created_at, last_activity_at
     ) VALUES ($1, $2, 'idle', '{}'::jsonb, now(), now())`,
    [threadId, USER_ID]
  );
}

async function insertDaprRun(input: {
  runId: string;
  threadId: string;
  turnId: string;
  interactiveClass: 'fast' | 'agentic';
  hashCharacter: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO agent_runs (
       id, thread_id, status, project_id, lane, queued_at, timeout_at,
       transport_version, requested_by_user_id, interactive_class,
       client_turn_id, client_turn_hash, execution_snapshot
     ) VALUES (
       $1, $2, 'queued', 'project-1', 'ai-runs-interactive', now(),
       now() + interval '20 minutes', 'dapr-actor-v2', $3, $4, $5,
       $6, $7::jsonb
     )`,
    [
      input.runId,
      input.threadId,
      USER_ID,
      input.interactiveClass,
      input.turnId,
      input.hashCharacter.repeat(64),
      JSON.stringify(specification),
    ]
  );
}

describe('durable interactive turns migration', () => {
  beforeAll(async () => {
    await cleanupFixtures();
    if (await hasDurableColumns()) {
      await pool.query(downSql);
    }
  });

  afterAll(async () => {
    try {
      await cleanupFixtures();
      if (!(await hasDurableColumns())) {
        await pool.query(upSql);
      }
    } finally {
      await pool.end();
    }
  });

  it('applies up, enforces uniqueness, preserves snapshots, and guards down', async () => {
    await insertThread(LEGACY_THREAD_ID);
    await insertThread(FIRST_THREAD_ID);
    await insertThread(SECOND_THREAD_ID);

    await pool.query(
      `INSERT INTO agent_runs (
         id, thread_id, status, project_id, lane, transport_version
       ) VALUES (
         $1, $2, 'completed', 'project-1', 'ai-runs-interactive',
         'http-files-v1'
       )`,
      [`${PREFIX}legacy`, LEGACY_THREAD_ID]
    );

    await pool.query(upSql);

    const legacy = await pool.query<{
      interactive_class: string;
      requested_by_user_id: string;
    }>(
      `SELECT interactive_class, requested_by_user_id
       FROM agent_runs
       WHERE id = $1`,
      [`${PREFIX}legacy`]
    );
    expect(legacy.rows[0]).toEqual({
      interactive_class: 'agentic',
      requested_by_user_id: USER_ID,
    });

    await expect(
      pool.query(
        `INSERT INTO agent_runs (
           id, thread_id, status, interactive_class
         ) VALUES ($1, $2, 'completed', 'slow')`,
        [`${PREFIX}invalid-class`, FIRST_THREAD_ID]
      )
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'agent_runs_interactive_class_check',
    });

    await expect(
      pool.query(
        `INSERT INTO agent_runs (
           id, thread_id, status, client_turn_id, client_turn_hash
         ) VALUES ($1, $2, 'completed', $3, $4)`,
        [
          `${PREFIX}invalid-turn-hash`,
          FIRST_THREAD_ID,
          DUPLICATE_TURN_ID,
          'A'.repeat(64),
        ]
      )
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'agent_runs_client_turn_hash_check',
    });

    await expect(
      pool.query(
        `INSERT INTO chat_message_attachments (
           id, message_id, name, type, size, sha256
         ) VALUES ($1, $2, 'notes.txt', 'text/plain', 12, $3)`,
        [ATTACHMENT_ID, ATTACHMENT_MESSAGE_ID, 'g'.repeat(64)]
      )
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'chat_message_attachments_sha256_check',
    });

    await expect(
      pool.query(
        `INSERT INTO agent_runs (
           id, thread_id, status, transport_version
         ) VALUES ($1, $2, 'completed', 'dapr-actor-v2')`,
        [`${PREFIX}missing-dapr-fields`, FIRST_THREAD_ID]
      )
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'agent_runs_dapr_actor_v2_required_fields_check',
    });

    await insertDaprRun({
      runId: `${PREFIX}run-1`,
      threadId: FIRST_THREAD_ID,
      turnId: FIRST_TURN_ID,
      interactiveClass: 'fast',
      hashCharacter: 'a',
    });
    await pool.query(
      `INSERT INTO ai_run_attempts (
         id, run_id, attempt_number, dispatch_message_id, status,
         artifact_status, spec_snapshot
       ) VALUES (
         $1, $2, 1, $3, 'queued', 'pending', $4::jsonb
       )`,
      [
        `${PREFIX}attempt-1`,
        `${PREFIX}run-1`,
        `${PREFIX}fence-1`,
        JSON.stringify(specification),
      ]
    );

    const attempt = await pool.query<{ spec_snapshot: unknown }>(
      `SELECT spec_snapshot
       FROM ai_run_attempts
       WHERE id = $1`,
      [`${PREFIX}attempt-1`]
    );
    expect(attempt.rows[0]?.spec_snapshot).toEqual(specification);

    await expect(
      pool.query(
        `INSERT INTO agent_runs (
           id, thread_id, status, client_turn_id, client_turn_hash
         ) VALUES ($1, $2, 'completed', $3, $4)`,
        [
          `${PREFIX}duplicate-turn`,
          FIRST_THREAD_ID,
          FIRST_TURN_ID,
          'b'.repeat(64),
        ]
      )
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_agent_runs_client_turn',
    });

    await expect(
      insertDaprRun({
        runId: `${PREFIX}same-thread`,
        threadId: FIRST_THREAD_ID,
        turnId: DUPLICATE_TURN_ID,
        interactiveClass: 'agentic',
        hashCharacter: 'b',
      })
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_agent_runs_interactive_active_thread',
    });

    await insertDaprRun({
      runId: `${PREFIX}run-2`,
      threadId: SECOND_THREAD_ID,
      turnId: SECOND_TURN_ID,
      interactiveClass: 'agentic',
      hashCharacter: 'c',
    });
    const activeForUser = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM agent_runs
       WHERE requested_by_user_id = $1
         AND status IN ('queued', 'dispatched', 'running')`,
      [USER_ID]
    );
    expect(activeForUser.rows[0]?.count).toBe(2);

    await expect(pool.query(downSql)).rejects.toThrow(
      /Cannot remove durable interactive turn schema while dapr-actor-v2 data exists/
    );

    await cleanupFixtures();
    await pool.query(downSql);

    const removedColumns = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND (
           (table_name = 'agent_runs' AND column_name IN (
             'requested_by_user_id',
             'interactive_class',
             'client_turn_id',
             'client_turn_hash'
           ))
           OR (
             table_name = 'chat_message_attachments'
             AND column_name IN ('blob_ref', 'sha256')
           )
           OR (
             table_name = 'ai_run_attempts'
             AND column_name = 'spec_snapshot'
           )
         )`
    );
    expect(removedColumns.rows[0]?.count).toBe(0);

    await expect(
      pool.query(
        `INSERT INTO agent_runs (
           id, thread_id, status, transport_version
         ) VALUES ($1, $2, 'completed', 'dapr-actor-v2')`,
        [`${PREFIX}down-check`, FIRST_THREAD_ID]
      )
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'agent_runs_transport_version_check',
    });
  });
});
