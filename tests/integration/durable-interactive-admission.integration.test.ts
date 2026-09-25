import './ai-run-v2-persistence.setup';
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../src/server/db';
import type {
  DurableInteractiveTurnSpecification,
  ImmutableInteractiveAttachmentRef,
  InteractiveClass,
} from '../../src/shared/types/durableInteractiveTurn';
import {
  createDurableInteractiveTurnRepository,
  type DurableInteractiveAdmissionWriteStage,
  type PreparedDurableInteractiveTurn,
} from '../../src/server/services/durableInteractiveTurnRepository';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260923140000_durable-interactive-turns.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8');
const [upSql = ''] = migrationSql.split(/-- Down Migration/i);

const THREAD_IDS = [
  '11000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002',
  '11000000-0000-4000-8000-000000000003',
  '11000000-0000-4000-8000-000000000004',
  '11000000-0000-4000-8000-000000000005',
  '11000000-0000-4000-8000-000000000006',
  '11000000-0000-4000-8000-000000000007',
  '11000000-0000-4000-8000-000000000008',
  '11000000-0000-4000-8000-000000000009',
  '11000000-0000-4000-8000-000000000010',
] as const;
const USER_IDS = [
  '41000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000002',
  '41000000-0000-4000-8000-000000000003',
  '41000000-0000-4000-8000-000000000004',
  '41000000-0000-4000-8000-000000000005',
  '41000000-0000-4000-8000-000000000006',
  '41000000-0000-4000-8000-000000000007',
  '41000000-0000-4000-8000-000000000008',
  '41000000-0000-4000-8000-000000000009',
  '41000000-0000-4000-8000-000000000010',
] as const;
const TURN_IDS = [
  '21000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000002',
  '21000000-0000-4000-8000-000000000003',
  '21000000-0000-4000-8000-000000000004',
  '21000000-0000-4000-8000-000000000005',
  '21000000-0000-4000-8000-000000000006',
  '21000000-0000-4000-8000-000000000007',
  '21000000-0000-4000-8000-000000000008',
  '21000000-0000-4000-8000-000000000009',
  '21000000-0000-4000-8000-000000000010',
] as const;

const GLOBAL_RUN_IDS = Array.from(
  { length: 16 },
  (_, index) =>
    `51000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

function attachment(
  turnId: string,
  index = 1,
): ImmutableInteractiveAttachmentRef {
  const attachmentId = `31000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    attachmentId,
    name: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 5,
    sha256: 'a'.repeat(64),
    blobRef: {
      container: 'ai-run-artifacts',
      key: `interactive/${turnId}/${attachmentId}/${'a'.repeat(64)}`,
    },
    materializedPath: `.ai-pilot/attachments/${turnId}/notes.txt`,
  };
}

function specification(input: {
  threadId: string;
  turnId: string;
  userId: string;
  interactiveClass: InteractiveClass;
  attachments?: ReadonlyArray<ImmutableInteractiveAttachmentRef>;
}): DurableInteractiveTurnSpecification {
  return {
    schemaVersion: 1,
    kind: 'interactive-turn',
    turnId: input.turnId,
    threadId: input.threadId,
    userId: input.userId,
    projectId: 'project-1',
    interactiveClass: input.interactiveClass,
    workflowClass: 'home-chat',
    model: 'model-a',
    effort: 'low',
    skill: null,
    currentMessage: {
      id: input.turnId,
      text: 'Hello',
      hidden: false,
      attachments: [...(input.attachments ?? [])],
    },
    transcript: [],
    grounding: null,
    mcpServers: [],
    toolGrant: null,
    currentPrompt: 'Hello',
    recreationPrompt: 'Hello',
    deadlines: {
      absoluteTurnMs:
        input.interactiveClass === 'fast' ? 300_000 : 1_200_000,
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
  interactiveClass?: InteractiveClass;
  requestHash?: string;
  withAttachment?: boolean;
}): PreparedDurableInteractiveTurn {
  const interactiveClass = input.interactiveClass ?? 'fast';
  const attachments = input.withAttachment
    ? [attachment(input.turnId)]
    : [];
  return {
    turnId: input.turnId,
    requestHash: input.requestHash ?? 'a'.repeat(64),
    threadId: input.threadId,
    userId: input.userId,
    projectId: 'project-1',
    interactiveClass,
    messageText: 'Hello',
    hidden: false,
    attachments,
    specification: specification({
      ...input,
      interactiveClass,
      attachments,
    }),
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
     )
     OR run_id = ANY($2::text[])`,
    [THREAD_IDS, GLOBAL_RUN_IDS],
  );
  await pool.query(
    `DELETE FROM agent_run_events
     WHERE thread_id = ANY($1::text[])
        OR run_id = ANY($2::text[])`,
    [THREAD_IDS, GLOBAL_RUN_IDS],
  );
  await pool.query(
    `DELETE FROM agent_runs
     WHERE thread_id = ANY($1::text[])
        OR id = ANY($2::text[])`,
    [THREAD_IDS, GLOBAL_RUN_IDS],
  );
  await pool.query(
    `DELETE FROM chat_message_attachments
     WHERE message_id IN (
       SELECT id FROM chat_messages WHERE thread_id = ANY($1::uuid[])
     )`,
    [THREAD_IDS],
  );
  await pool.query(
    `DELETE FROM chat_messages WHERE thread_id = ANY($1::uuid[])`,
    [THREAD_IDS],
  );
  await pool.query(
    `DELETE FROM chat_threads WHERE id = ANY($1::uuid[])`,
    [THREAD_IDS],
  );
}

async function committedCounts(threadId: string): Promise<{
  messages: number;
  attachments: number;
  runs: number;
  attempts: number;
  outbox: number;
  events: number;
}> {
  const result = await pool.query<{
    messages: number;
    attachments: number;
    runs: number;
    attempts: number;
    outbox: number;
    events: number;
  }>(
    `WITH matching_runs AS (
       SELECT id FROM agent_runs WHERE thread_id = $1
     ),
     matching_messages AS (
       SELECT id FROM chat_messages WHERE thread_id = $1::uuid
     )
     SELECT
       (SELECT COUNT(*)::int FROM matching_messages) AS messages,
       (
         SELECT COUNT(*)::int
         FROM chat_message_attachments
         WHERE message_id IN (SELECT id FROM matching_messages)
       ) AS attachments,
       (SELECT COUNT(*)::int FROM matching_runs) AS runs,
       (
         SELECT COUNT(*)::int
         FROM ai_run_attempts
         WHERE run_id IN (SELECT id FROM matching_runs)
       ) AS attempts,
       (
         SELECT COUNT(*)::int
         FROM ai_run_outbox
         WHERE run_id IN (SELECT id FROM matching_runs)
       ) AS outbox,
       (
         SELECT COUNT(*)::int
         FROM agent_run_events
         WHERE thread_id = $1
       ) AS events`,
    [threadId],
  );
  return result.rows[0];
}

function isAccepted(
  result: Awaited<
    ReturnType<
      ReturnType<typeof createDurableInteractiveTurnRepository>['admit']
    >
  >,
): result is Extract<typeof result, { status: 'queued' | 'dispatched' }> {
  return result.status === 'queued' || result.status === 'dispatched';
}

describe('durable interactive atomic admission', () => {
  beforeAll(async () => {
    if (!(await hasDurableColumns())) {
      await pool.query(upSql);
    }
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await pool.end();
    }
  });

  it.each([
    'message',
    'attachments',
    'run',
    'attempt',
    'outbox',
    'queued_event',
    'thread',
  ] as const)(
    'rolls back every PostgreSQL row when %s write is followed by failure',
    async (failureStage) => {
      const stageIndex = (
        [
          'message',
          'attachments',
          'run',
          'attempt',
          'outbox',
          'queued_event',
          'thread',
        ] as const
      ).indexOf(failureStage);
      const threadId = THREAD_IDS[stageIndex];
      const userId = USER_IDS[stageIndex];
      const turnId = TURN_IDS[stageIndex];
      await insertThread(threadId, userId);
      const repository = createDurableInteractiveTurnRepository({
        afterWrite(stage: DurableInteractiveAdmissionWriteStage) {
          if (stage === failureStage) {
            throw new Error(`injected failure after ${stage}`);
          }
        },
      });

      await expect(
        repository.admit(
          preparedTurn({
            threadId,
            turnId,
            userId,
            withAttachment: true,
          }),
        ),
      ).rejects.toThrow(`injected failure after ${failureStage}`);
      await expect(committedCounts(threadId)).resolves.toEqual({
        messages: 0,
        attachments: 0,
        runs: 0,
        attempts: 0,
        outbox: 0,
        events: 0,
      });
      const thread = await pool.query<{
        status: string;
        active_run_id: string | null;
      }>(
        `SELECT status, active_run_id
         FROM chat_threads
         WHERE id = $1::uuid`,
        [threadId],
      );
      expect(thread.rows[0]).toEqual({
        status: 'idle',
        active_run_id: null,
      });
    },
  );

  it('admits the same turn and hash once under concurrent retries', async () => {
    const threadId = THREAD_IDS[0];
    const userId = USER_IDS[0];
    const turnId = TURN_IDS[0];
    await insertThread(threadId, userId);
    const repository = createDurableInteractiveTurnRepository();
    const input = preparedTurn({ threadId, turnId, userId });

    const [first, second] = await Promise.all([
      repository.admit(input),
      repository.admit(input),
    ]);

    expect(isAccepted(first)).toBe(true);
    expect(isAccepted(second)).toBe(true);
    if (!isAccepted(first) || !isAccepted(second)) return;
    expect(first.runId).toBe(second.runId);
    expect([first.idempotent, second.idempotent].sort()).toEqual([
      false,
      true,
    ]);
    await expect(committedCounts(threadId)).resolves.toMatchObject({
      messages: 1,
      runs: 1,
      attempts: 1,
      outbox: 1,
      events: 1,
    });
  });

  it.each([
    'queued',
    'dispatched',
    'running',
    'completed',
    'failed',
    'cancelled',
  ] as const)(
    'returns delayed duplicate with persisted %s status',
    async (status) => {
      const threadId = THREAD_IDS[0];
      const userId = USER_IDS[0];
      const turnId = TURN_IDS[0];
      await insertThread(threadId, userId);
      const repository = createDurableInteractiveTurnRepository();
      const input = preparedTurn({ threadId, turnId, userId });
      const first = await repository.admit(input);
      expect(isAccepted(first)).toBe(true);
      await pool.query(
        `UPDATE agent_runs SET status = $1 WHERE thread_id = $2`,
        [status, threadId],
      );
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        await pool.query(
          `UPDATE chat_threads
           SET status = 'idle', active_run_id = NULL
           WHERE id = $1::uuid`,
          [threadId],
        );
      }

      await expect(repository.admit(input)).resolves.toMatchObject({
        status,
        turnId,
        idempotent: true,
      });
    },
  );

  it('returns an old terminal duplicate without replacing a newer active run', async () => {
    const threadId = THREAD_IDS[0];
    const userId = USER_IDS[0];
    await insertThread(threadId, userId);
    const repository = createDurableInteractiveTurnRepository();
    const oldInput = preparedTurn({
      threadId,
      turnId: TURN_IDS[0],
      userId,
      requestHash: 'a'.repeat(64),
    });
    const oldRun = await repository.admit(oldInput);
    expect(isAccepted(oldRun)).toBe(true);
    await pool.query(
      `UPDATE agent_runs SET status = 'completed' WHERE thread_id = $1`,
      [threadId],
    );
    await pool.query(
      `UPDATE chat_threads
       SET status = 'idle', active_run_id = NULL
       WHERE id = $1::uuid`,
      [threadId],
    );
    const newer = await repository.admit(
      preparedTurn({
        threadId,
        turnId: TURN_IDS[1],
        userId,
        requestHash: 'b'.repeat(64),
      }),
    );
    expect(isAccepted(newer)).toBe(true);
    if (!isAccepted(newer)) return;

    await expect(repository.admit(oldInput)).resolves.toMatchObject({
      status: 'completed',
      shouldReflectThreadState: false,
    });
    const thread = await pool.query<{
      status: string;
      active_run_id: string | null;
    }>(
      `SELECT status, active_run_id
       FROM chat_threads
       WHERE id = $1::uuid`,
      [threadId],
    );
    expect(thread.rows[0]).toEqual({
      status: 'running',
      active_run_id: newer.runId,
    });
  });

  it('concurrently accepts one same-turn hash and conflicts the other', async () => {
    const threadId = THREAD_IDS[0];
    const userId = USER_IDS[0];
    const turnId = TURN_IDS[0];
    await insertThread(threadId, userId);
    const repository = createDurableInteractiveTurnRepository();

    const results = await Promise.all([
      repository.admit(preparedTurn({ threadId, turnId, userId })),
      repository.admit(
        preparedTurn({
          threadId,
          turnId,
          userId,
          requestHash: 'b'.repeat(64),
        }),
      ),
    ]);

    expect(results.filter(isAccepted)).toHaveLength(1);
    expect(results).toContainEqual({ status: 'turn_conflict' });
    await expect(committedCounts(threadId)).resolves.toMatchObject({
      messages: 1,
      runs: 1,
    });
  });

  it('accepts only one of two different concurrent turns on one thread', async () => {
    const threadId = THREAD_IDS[0];
    const userId = USER_IDS[0];
    await insertThread(threadId, userId);
    const repository = createDurableInteractiveTurnRepository();

    const results = await Promise.all([
      repository.admit(
        preparedTurn({
          threadId,
          turnId: TURN_IDS[0],
          userId,
          requestHash: 'a'.repeat(64),
        }),
      ),
      repository.admit(
        preparedTurn({
          threadId,
          turnId: TURN_IDS[1],
          userId,
          requestHash: 'b'.repeat(64),
        }),
      ),
    ]);

    expect(results.filter(isAccepted)).toHaveLength(1);
    expect(results).toContainEqual(
      expect.objectContaining({ status: 'thread_active' }),
    );
  });

  it('serializes two authorized callers sharing one thread', async () => {
    const threadId = THREAD_IDS[0];
    await insertThread(threadId, USER_IDS[0]);
    const repository = createDurableInteractiveTurnRepository();

    const results = await Promise.all([
      repository.admit(
        preparedTurn({
          threadId,
          turnId: TURN_IDS[0],
          userId: 'authorized-admin',
          requestHash: 'a'.repeat(64),
        }),
      ),
      repository.admit(
        preparedTurn({
          threadId,
          turnId: TURN_IDS[1],
          userId: 'assigned-approver',
          requestHash: 'b'.repeat(64),
        }),
      ),
    ]);

    expect(results.filter(isAccepted)).toHaveLength(1);
    expect(results).toContainEqual(
      expect.objectContaining({ status: 'thread_active' }),
    );
    const acceptedRun = await pool.query<{
      requested_by_user_id: string;
    }>(
      `SELECT requested_by_user_id
       FROM agent_runs
       WHERE thread_id = $1`,
      [threadId],
    );
    expect(['authorized-admin', 'assigned-approver']).toContain(
      acceptedRun.rows[0]?.requested_by_user_id,
    );
  });

  it('allows two user turns on different threads and refuses a third', async () => {
    const userId = USER_IDS[0];
    await Promise.all([
      insertThread(THREAD_IDS[0], userId),
      insertThread(THREAD_IDS[1], userId),
      insertThread(THREAD_IDS[2], userId),
    ]);
    const repository = createDurableInteractiveTurnRepository();
    const firstTwo = await Promise.all([
      repository.admit(
        preparedTurn({
          threadId: THREAD_IDS[0],
          turnId: TURN_IDS[0],
          userId,
        }),
      ),
      repository.admit(
        preparedTurn({
          threadId: THREAD_IDS[1],
          turnId: TURN_IDS[1],
          userId,
        }),
      ),
    ]);

    expect(firstTwo.every(isAccepted)).toBe(true);
    await expect(
      repository.admit(
        preparedTurn({
          threadId: THREAD_IDS[2],
          turnId: TURN_IDS[2],
          userId,
        }),
      ),
    ).resolves.toEqual({
      status: 'user_limit',
      code: 'USER_INTERACTIVE_LIMIT',
    });
  });

  it('allows only one concurrent agentic turn per user', async () => {
    const userId = USER_IDS[0];
    await Promise.all([
      insertThread(THREAD_IDS[0], userId),
      insertThread(THREAD_IDS[1], userId),
    ]);
    const repository = createDurableInteractiveTurnRepository();

    const results = await Promise.all([
      repository.admit(
        preparedTurn({
          threadId: THREAD_IDS[0],
          turnId: TURN_IDS[0],
          userId,
          interactiveClass: 'agentic',
        }),
      ),
      repository.admit(
        preparedTurn({
          threadId: THREAD_IDS[1],
          turnId: TURN_IDS[1],
          userId,
          interactiveClass: 'agentic',
        }),
      ),
    ]);

    expect(results.filter(isAccepted)).toHaveLength(1);
    expect(results).toContainEqual({
      status: 'user_limit',
      code: 'USER_AGENTIC_LIMIT',
    });
  });

  it('ignores sixteen dispatched global runs when this user remains eligible', async () => {
    for (let index = 0; index < GLOBAL_RUN_IDS.length; index += 1) {
      const suffix = String(index + 100).padStart(12, '0');
      await pool.query(
        `INSERT INTO agent_runs (
           id, thread_id, status, project_id, lane, queued_at, dispatched_at,
           timeout_at, transport_version, requested_by_user_id,
           interactive_class, client_turn_id, client_turn_hash
         ) VALUES (
           $1, $2, 'dispatched', 'project-1', 'ai-runs-interactive',
           now(), now(), now() + interval '20 minutes', 'dapr-actor-v2',
           $3, 'fast', $4::uuid, $5
         )`,
        [
          GLOBAL_RUN_IDS[index],
          `global-thread-${index}`,
          `global-user-${index}`,
          `61000000-0000-4000-8000-${suffix}`,
          'f'.repeat(64),
        ],
      );
    }
    const threadId = THREAD_IDS[0];
    const userId = USER_IDS[0];
    await insertThread(threadId, userId);

    const result = await createDurableInteractiveTurnRepository().admit(
      preparedTurn({
        threadId,
        turnId: TURN_IDS[0],
        userId,
      }),
    );

    expect(isAccepted(result)).toBe(true);
    expect(result).toMatchObject({
      status: 'queued',
      interactiveClass: 'fast',
    });
  });
});
