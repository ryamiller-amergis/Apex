import fs from 'node:fs';
import path from 'node:path';
import type { DurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';
import type { ChatThread } from '../../shared/types/chat';
import {
  createDurableInteractiveTurnRepository,
  type PreparedDurableInteractiveTurn,
} from '../services/durableInteractiveTurnRepository';
import { createDurableInteractiveTurnService } from '../services/durableInteractiveTurnService';

const THREAD_ID = '10000000-0000-4000-8000-000000000001';
const TURN_ID = '20000000-0000-4000-8000-000000000001';
const USER_ID = '40000000-0000-4000-8000-000000000001';
const RUN_ID = '50000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '60000000-0000-4000-8000-000000000001';
const FENCE_ID = '70000000-0000-4000-8000-000000000001';
const EVENT_ID = '80000000-0000-4000-8000-000000000001';
const ACCEPTED_AT = '2026-09-23T16:00:00.000Z';
const DEADLINE_AT = '2026-09-23T16:05:00.000Z';

function specification(
  overrides: Partial<DurableInteractiveTurnSpecification> = {},
): DurableInteractiveTurnSpecification {
  return {
    schemaVersion: 1,
    kind: 'interactive-turn',
    turnId: TURN_ID,
    threadId: THREAD_ID,
    userId: USER_ID,
    projectId: 'project-1',
    interactiveClass: 'fast',
    workflowClass: 'home-chat',
    model: 'model-a',
    effort: 'low',
    skill: null,
    currentMessage: {
      id: TURN_ID,
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
      firstEventMs: 45_000,
      toolCallMs: 60_000,
    },
    ...overrides,
  };
}

function preparedTurn(
  overrides: Partial<PreparedDurableInteractiveTurn> = {},
): PreparedDurableInteractiveTurn {
  const frozen = specification();
  return {
    turnId: TURN_ID,
    requestHash: 'a'.repeat(64),
    threadId: THREAD_ID,
    userId: USER_ID,
    projectId: 'project-1',
    interactiveClass: 'fast',
    messageText: 'Hello',
    hidden: false,
    attachments: [],
    specification: frozen,
    ...overrides,
  };
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function boundStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((entry) =>
    boundStrings(entry, seen),
  );
}

function repositoryHarness(options?: {
  activeCount?: number;
  agenticCount?: number;
  activeRunId?: string | null;
  threadActiveRunId?: string | null;
}) {
  const sqlStatements: string[] = [];
  const queries: unknown[] = [];
  let existing:
    | {
        id: string;
        client_turn_hash: string;
        status: string;
        interactive_class: 'fast' | 'agentic';
      }
    | undefined;
  const execute = jest.fn(async (query: unknown) => {
    queries.push(query);
    const statement = sqlText(query);
    sqlStatements.push(statement);

    if (statement.includes('FROM chat_threads')) {
      return [
        {
          id: THREAD_ID,
          user_id: USER_ID,
          active_run_id: options?.threadActiveRunId ?? null,
        },
      ];
    }
    if (
      statement.includes('FROM agent_runs') &&
      statement.includes('client_turn_id')
    ) {
      return existing ? [existing] : [];
    }
    if (
      statement.includes('FROM agent_runs') &&
      statement.includes('requested_by_user_id') &&
      statement.includes('COUNT')
    ) {
      return [
        {
          active_count: options?.activeCount ?? 0,
          agentic_count: options?.agenticCount ?? 0,
        },
      ];
    }
    if (
      statement.includes('FROM agent_runs') &&
      statement.includes("status IN ('queued', 'dispatched', 'running')")
    ) {
      return options?.activeRunId ? [{ id: options.activeRunId }] : [];
    }
    if (
      statement.includes('accepted_at') &&
      statement.includes('deadline_at')
    ) {
      return [
        {
          accepted_at: new Date(ACCEPTED_AT),
          deadline_at: new Date(DEADLINE_AT),
        },
      ];
    }
    if (statement.includes('INSERT INTO agent_runs')) {
      existing = {
        id: RUN_ID,
        client_turn_hash: 'a'.repeat(64),
        status: 'queued',
        interactive_class: 'fast',
      };
    }
    if (statement.includes('INSERT INTO ai_run_outbox')) {
      return [{ id: 'outbox-1' }];
    }
    return [];
  });
  const ids = [RUN_ID, ATTEMPT_ID, FENCE_ID, EVENT_ID];
  let nextId = 0;
  const repository = createDurableInteractiveTurnRepository({
    runInTransaction: async (work) => work({ execute }),
    newId: () => ids[nextId++] ?? `90000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
  });

  return {
    repository,
    execute,
    queries,
    sqlStatements,
    setExistingHash(hash: string) {
      existing = {
        id: RUN_ID,
        client_turn_hash: hash,
        status: 'queued',
        interactive_class: 'fast',
      };
    },
    setExistingStatus(status: string) {
      existing = {
        id: RUN_ID,
        client_turn_hash: 'a'.repeat(64),
        status,
        interactive_class: 'fast',
      };
    },
  };
}

describe('durable interactive turn repository', () => {
  it('returns the original run for the same turn hash', async () => {
    const { repository } = repositoryHarness();

    const first = await repository.admit(preparedTurn());
    const duplicate = await repository.admit(preparedTurn());

    expect(first).toMatchObject({
      status: 'queued',
      runId: RUN_ID,
      idempotent: false,
    });
    expect(duplicate).toMatchObject({
      status: 'queued',
      runId: RUN_ID,
      turnId: TURN_ID,
      idempotent: true,
    });
  });

  it('does not insert a second bubble for a duplicate turn', async () => {
    const { repository, sqlStatements } = repositoryHarness();

    await repository.admit(preparedTurn());
    await repository.admit(preparedTurn());

    expect(
      sqlStatements.filter((statement) =>
        statement.includes('INSERT INTO chat_messages'),
      ),
    ).toHaveLength(1);
  });

  it.each([
    'queued',
    'dispatched',
    'running',
    'completed',
    'failed',
    'cancelled',
  ] as const)(
    'returns the original exhaustive %s status for a delayed duplicate',
    async (status) => {
      const harness = repositoryHarness();
      harness.setExistingStatus(status);

      await expect(
        harness.repository.admit(preparedTurn()),
      ).resolves.toMatchObject({
        status,
        runId: RUN_ID,
        turnId: TURN_ID,
        idempotent: true,
      });
      expect(
        harness.sqlStatements.some((statement) =>
          statement.includes('INSERT INTO chat_messages'),
        ),
      ).toBe(false);
    },
  );

  it('preserves superseded duplicate reflection metadata for the wrapper', async () => {
    const { service } = durableServiceHarness({
      repositoryResult: {
        turnId: TURN_ID,
        runId: RUN_ID,
        status: 'completed',
        interactiveClass: 'fast',
        idempotent: true,
        shouldReflectThreadState: false,
      },
    });

    await expect(
      service.admit({
        threadId: THREAD_ID,
        userId: USER_ID,
        workflowClass: 'home-chat',
        turnId: TURN_ID,
        text: 'Delayed old turn',
        attachments: [],
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      shouldReflectThreadState: false,
    });
  });

  it('marks an old terminal duplicate superseded when another run owns the thread', async () => {
    const harness = repositoryHarness({
      threadActiveRunId: 'newer-active-run',
    });
    harness.setExistingStatus('completed');

    await expect(
      harness.repository.admit(preparedTurn()),
    ).resolves.toMatchObject({
      status: 'completed',
      runId: RUN_ID,
      idempotent: true,
      shouldReflectThreadState: false,
    });
  });

  it('accepts a bounded non-UUID requester identity for locks and limits', async () => {
    const { repository, queries } = repositoryHarness();
    const userId = 'internal:workflow-user';
    const frozen = specification({ userId });

    await expect(
      repository.admit(
        preparedTurn({
          userId,
          specification: frozen,
        }),
      ),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(queries.flatMap((query) => boundStrings(query))).toContain(userId);
  });

  it('returns a turn conflict before limits or writes when the hash differs', async () => {
    const harness = repositoryHarness();
    harness.setExistingHash('b'.repeat(64));

    await expect(harness.repository.admit(preparedTurn())).resolves.toEqual({
      status: 'turn_conflict',
    });
    expect(
      harness.sqlStatements.some((statement) => statement.includes('COUNT')),
    ).toBe(false);
    expect(
      harness.sqlStatements.some((statement) =>
        statement.includes('INSERT INTO chat_messages'),
      ),
    ).toBe(false);
  });

  it('locks the user and thread before checking identity and active limits', async () => {
    const { repository, sqlStatements } = repositoryHarness();

    await repository.admit(preparedTurn());

    const advisory = sqlStatements.findIndex(
      (statement) =>
        statement.includes('pg_advisory_xact_lock') &&
        statement.includes('hashtextextended') &&
        statement.includes('interactive-user:'),
    );
    const threadLock = sqlStatements.findIndex(
      (statement) =>
        statement.includes('FROM chat_threads') &&
        statement.includes('FOR UPDATE'),
    );
    const identity = sqlStatements.findIndex(
      (statement) =>
        statement.includes('client_turn_id') &&
        statement.includes('FROM agent_runs'),
    );
    const counts = sqlStatements.findIndex(
      (statement) =>
        statement.includes('requested_by_user_id') &&
        statement.includes('COUNT'),
    );

    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(advisory).toBeLessThan(threadLock);
    expect(threadLock).toBeLessThan(identity);
    expect(identity).toBeLessThan(counts);
  });

  it('uses one database clock value for the complete accepted turn', async () => {
    const { repository, sqlStatements } = repositoryHarness();

    await repository.admit(preparedTurn());

    expect(
      sqlStatements.filter(
        (statement) =>
          statement.includes('accepted_at') &&
          statement.includes('deadline_at'),
      ),
    ).toHaveLength(1);
    for (const table of [
      'chat_messages',
      'agent_runs',
      'ai_run_attempts',
      'ai_run_outbox',
      'agent_run_events',
    ]) {
      expect(
        sqlStatements.some((statement) =>
          statement.includes(`INSERT INTO ${table}`),
        ),
      ).toBe(true);
    }
    expect(
      sqlStatements.some(
        (statement) =>
          statement.includes('UPDATE chat_threads') &&
          statement.includes("status = 'running'"),
      ),
    ).toBe(true);
  });

  it('persists durable canonical turns as event-driven at admission', async () => {
    const { repository, sqlStatements } = repositoryHarness();

    await repository.admit(preparedTurn());

    const runInsert = sqlStatements.find((statement) =>
      statement.includes('INSERT INTO agent_runs'),
    );
    expect(runInsert).toContain('event_driven');
    expect(runInsert).toMatch(/event_driven[\s\S]*TRUE/);
  });

  it('stores attempt one, its fence, the snapshot, and interactive outbox payload together', async () => {
    const { repository, queries } = repositoryHarness();

    await repository.admit(preparedTurn());

    const bound = queries.flatMap((query) => boundStrings(query)).join('\n');
    expect(bound).toContain(ATTEMPT_ID);
    expect(bound).toContain(FENCE_ID);
    expect(bound).toContain(`${ATTEMPT_ID}:interactive-dispatch`);
    expect(bound).toContain('"kind":"interactive_dispatch"');
    expect(bound).toContain('"attemptNumber":1');
    expect(bound).toContain(`"dispatchMessageId":"${FENCE_ID}"`);
    expect(bound).toContain(`"deadlineAt":"${DEADLINE_AT}"`);
    expect(bound).toContain('"kind":"interactive-turn"');
  });

  it('returns the thread conflict before evaluating user limits', async () => {
    const { repository, sqlStatements } = repositoryHarness({
      activeRunId: 'active-run-1',
    });

    await expect(repository.admit(preparedTurn())).resolves.toEqual({
      status: 'thread_active',
      activeRunId: 'active-run-1',
    });
    expect(
      sqlStatements.some((statement) => statement.includes('COUNT')),
    ).toBe(false);
  });

  it.each([
    {
      activeCount: 2,
      agenticCount: 0,
      interactiveClass: 'fast' as const,
      code: 'USER_INTERACTIVE_LIMIT',
    },
    {
      activeCount: 1,
      agenticCount: 1,
      interactiveClass: 'agentic' as const,
      code: 'USER_AGENTIC_LIMIT',
    },
  ])('returns the exact $code response', async (testCase) => {
    const { repository } = repositoryHarness(testCase);
    const frozen = specification({
      interactiveClass: testCase.interactiveClass,
      deadlines: {
        absoluteTurnMs:
          testCase.interactiveClass === 'fast' ? 300_000 : 1_200_000,
        repositoryPreparationMs: null,
        firstEventMs: 45_000,
        toolCallMs: 60_000,
      },
    });

    await expect(
      repository.admit(
        preparedTurn({
          interactiveClass: testCase.interactiveClass,
          specification: frozen,
        }),
      ),
    ).resolves.toEqual({
      status: 'user_limit',
      code: testCase.code,
    });
  });

  it('does not query or order limits by model or global capacity', async () => {
    const { repository, sqlStatements } = repositoryHarness();

    await repository.admit(preparedTurn());

    const countQuery = sqlStatements.find((statement) =>
      statement.includes('requested_by_user_id'),
    );
    expect(countQuery).toBeDefined();
    expect(countQuery).not.toContain('model');
    expect(countQuery).not.toContain('LIMIT 16');
    expect(countQuery).not.toContain('capacity');
  });
});

const FAILED_RUN_ID = RUN_ID;
const RETRY_ATTEMPT_ID = '61000000-0000-4000-8000-000000000001';
const RETRY_FENCE_ID = '71000000-0000-4000-8000-000000000001';
const RETRY_EVENT_ID = '81000000-0000-4000-8000-000000000001';
const RETRY_DEADLINES = {
  absoluteTurnMs: 300_000 as const,
  repositoryPreparationMs: null,
  firstEventMs: 45_000,
  toolCallMs: 60_000,
};

function retryInput(
  overrides: Partial<{
    threadId: string;
    runId: string;
    userId: string;
    refreshedToolGrant: null;
    refreshedDeadlines: typeof RETRY_DEADLINES;
  }> = {},
) {
  return {
    threadId: THREAD_ID,
    runId: FAILED_RUN_ID,
    userId: USER_ID,
    refreshedToolGrant: null,
    refreshedDeadlines: RETRY_DEADLINES,
    ...overrides,
  };
}

function retryHarness(options?: {
  activeCount?: number;
  agenticCount?: number;
  runStatus?: string;
  attemptStatus?: string;
  transport?: string;
  interactiveClass?: 'fast' | 'agentic';
  missingRun?: boolean;
  missingThread?: boolean;
  attemptNumber?: number;
  startWithActiveRetry?: boolean;
}) {
  const sqlStatements: string[] = [];
  const queries: unknown[] = [];
  let messageInsertCount = 0;
  let attemptInsertCount = 0;
  let outboxInsertCount = 0;
  let latestAttempt = {
    id: ATTEMPT_ID,
    attempt_number: options?.attemptNumber ?? 1,
    status: options?.startWithActiveRetry
      ? 'queued'
      : (options?.attemptStatus ?? 'failed'),
    dispatch_message_id: FENCE_ID,
    spec_snapshot: specification(),
  };
  const execute = jest.fn(async (query: unknown) => {
    queries.push(query);
    const statement = sqlText(query);
    sqlStatements.push(statement);

    if (statement.includes('FROM chat_threads')) {
      if (options?.missingThread) return [];
      return [
        {
          id: THREAD_ID,
          user_id: USER_ID,
          active_run_id: null,
        },
      ];
    }
    if (
      statement.includes('FROM agent_runs') &&
      statement.includes('transport_version') &&
      statement.includes('FOR UPDATE')
    ) {
      if (options?.missingRun) return [];
      return [
        {
          id: FAILED_RUN_ID,
          thread_id: THREAD_ID,
          status: options?.startWithActiveRetry
            ? 'queued'
            : (options?.runStatus ?? 'failed'),
          interactive_class: options?.interactiveClass ?? 'fast',
          transport_version: options?.transport ?? 'dapr-actor-v2',
          requested_by_user_id: USER_ID,
          client_turn_id: TURN_ID,
          execution_snapshot: specification(),
        },
      ];
    }
    if (
      statement.includes('FROM ai_run_attempts') &&
      statement.includes('ORDER BY attempt_number DESC')
    ) {
      return [latestAttempt];
    }
    if (
      statement.includes('FROM agent_runs') &&
      statement.includes('requested_by_user_id') &&
      statement.includes('COUNT')
    ) {
      return [
        {
          active_count: options?.activeCount ?? 0,
          agentic_count: options?.agenticCount ?? 0,
        },
      ];
    }
    if (
      statement.includes('accepted_at') &&
      statement.includes('deadline_at')
    ) {
      return [
        {
          accepted_at: new Date(ACCEPTED_AT),
          deadline_at: new Date(DEADLINE_AT),
        },
      ];
    }
    if (statement.includes('INSERT INTO chat_messages')) {
      messageInsertCount += 1;
    }
    if (statement.includes('INSERT INTO ai_run_attempts')) {
      attemptInsertCount += 1;
      latestAttempt = {
        id: RETRY_ATTEMPT_ID,
        attempt_number: (options?.attemptNumber ?? 1) + 1,
        status: 'queued',
        dispatch_message_id: RETRY_FENCE_ID,
        spec_snapshot: specification(),
      };
    }
    if (statement.includes('INSERT INTO ai_run_outbox')) {
      outboxInsertCount += 1;
      return [{ id: 'outbox-retry-1' }];
    }
    if (
      statement.includes('FROM agent_run_events') &&
      statement.includes('MAX(sequence)')
    ) {
      return [{ max_sequence: 1 }];
    }
    return [];
  });
  const ids = [RETRY_ATTEMPT_ID, RETRY_FENCE_ID, RETRY_EVENT_ID];
  let nextId = 0;
  const repository = createDurableInteractiveTurnRepository({
    runInTransaction: async (work) => work({ execute }),
    newId: () =>
      ids[nextId++] ??
      `90000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
  });

  return {
    repository,
    execute,
    queries,
    sqlStatements,
    get messageInsertCount() {
      return messageInsertCount;
    },
    get attemptInsertCount() {
      return attemptInsertCount;
    },
    get outboxInsertCount() {
      return outboxInsertCount;
    },
    get latestAttempt() {
      return latestAttempt;
    },
  };
}

describe('durable interactive turn repository retry', () => {
  it('creates a fresh attempt and reuses the original message', async () => {
    const harness = retryHarness();
    const retried = await harness.repository.retry(retryInput());

    expect(retried).toMatchObject({
      runId: FAILED_RUN_ID,
      turnId: TURN_ID,
      status: 'queued',
      interactiveClass: 'fast',
    });
    expect(harness.latestAttempt.attempt_number).toBe(2);
    expect(harness.latestAttempt.dispatch_message_id).toBe(RETRY_FENCE_ID);
    expect(harness.latestAttempt.dispatch_message_id).not.toBe(FENCE_ID);
    expect(harness.messageInsertCount).toBe(0);
    expect(harness.attemptInsertCount).toBe(1);
    expect(harness.outboxInsertCount).toBe(1);

    const bound = harness.queries.flatMap((query) => boundStrings(query)).join('\n');
    expect(bound).toContain(`${RETRY_ATTEMPT_ID}:interactive-dispatch`);
    expect(bound).toContain('"attemptNumber":2');
    expect(
      harness.sqlStatements.some((statement) =>
        statement.includes('INSERT INTO chat_messages'),
      ),
    ).toBe(false);
  });

  it('returns the active retry when the request is repeated', async () => {
    const harness = retryHarness();
    const first = await harness.repository.retry(retryInput());
    const second = await harness.repository.retry(retryInput());

    expect(first).toMatchObject({ runId: FAILED_RUN_ID, status: 'queued' });
    expect(second).toMatchObject({
      runId: FAILED_RUN_ID,
      status: 'queued',
      turnId: TURN_ID,
    });
    expect(harness.attemptInsertCount).toBe(1);
    expect(harness.latestAttempt.attempt_number).toBe(2);
  });

  it('rejects non-failed runs as not retryable', async () => {
    const harness = retryHarness({ runStatus: 'completed', attemptStatus: 'completed' });
    await expect(harness.repository.retry(retryInput())).resolves.toEqual({
      status: 'not_retryable',
    });
    expect(harness.attemptInsertCount).toBe(0);
  });

  it('rejects non-v2 transport as not retryable', async () => {
    const harness = retryHarness({ transport: 'legacy-in-process' });
    await expect(harness.repository.retry(retryInput())).resolves.toEqual({
      status: 'not_retryable',
    });
  });

  it('returns exact user limit codes without writing', async () => {
    const harness = retryHarness({ activeCount: 2 });
    await expect(harness.repository.retry(retryInput())).resolves.toEqual({
      status: 'user_limit',
      code: 'USER_INTERACTIVE_LIMIT',
    });
    expect(harness.attemptInsertCount).toBe(0);
    expect(harness.outboxInsertCount).toBe(0);
  });

  it('throws thread-not-found when the run is absent from the thread', async () => {
    const harness = retryHarness({ missingRun: true });
    await expect(harness.repository.retry(retryInput())).rejects.toMatchObject({
      status: 404,
      message: 'Thread not found',
    });
  });
});

function authoritativeThread(
  overrides: Partial<ChatThread> = {},
): ChatThread {
  return {
    id: THREAD_ID,
    userId: USER_ID,
    kickoff: {
      project: 'project-1',
      repo: 'repo-1',
      skillProvider: 'github',
      model: 'model-a',
      effort: 'low',
    },
    messages: [
      {
        id: '90000000-0000-4000-8000-000000000001',
        role: 'user',
        text: 'Earlier question',
        ts: '2026-09-23T15:00:00.000Z',
      },
      {
        id: '90000000-0000-4000-8000-000000000002',
        role: 'agent',
        text: 'Earlier answer',
        ts: '2026-09-23T15:00:01.000Z',
      },
      {
        id: '90000000-0000-4000-8000-000000000003',
        role: 'user',
        text: 'hidden setup',
        hidden: true,
        ts: '2026-09-23T15:00:02.000Z',
      },
    ],
    status: 'idle',
    workspaceDir: '/tmp/thread',
    flagged: false,
    createdAt: '2026-09-23T14:00:00.000Z',
    lastActivityAt: '2026-09-23T15:00:02.000Z',
    ...overrides,
  };
}

function durableServiceHarness(options?: {
  thread?: ChatThread;
  repositoryResult?: Awaited<
    ReturnType<
      ReturnType<typeof createDurableInteractiveTurnRepository>['admit']
    >
  >;
  grounding?: DurableInteractiveTurnSpecification['grounding'];
  groundingError?: Error;
  maxviewCapability?: 'disabled' | 'enabled' | 'unavailable';
}) {
  const admitted: PreparedDurableInteractiveTurn[] = [];
  const order: string[] = [];
  const repository = {
    admit: jest.fn(async (input: PreparedDurableInteractiveTurn) => {
      order.push('repository');
      admitted.push(input);
      return (
        options?.repositoryResult ?? {
          turnId: input.turnId,
          runId: RUN_ID,
          status: 'queued' as const,
          interactiveClass: input.interactiveClass,
          idempotent: false,
        }
      );
    }),
    retry: jest.fn(),
  };
  const attachmentStore = {
    upload: jest.fn(async ({ attachment }: { attachment: { id: string; name: string; type: string; size: number } }) => {
      order.push(`upload:${attachment.id}`);
      return {
        attachmentId: attachment.id,
        name: attachment.name,
        contentType: attachment.type,
        sizeBytes: attachment.size,
        sha256: attachment.id === ATTEMPT_ID ? 'b'.repeat(64) : 'a'.repeat(64),
        blobRef: {
          container: 'ai-run-artifacts',
          key: `interactive/${attachment.id}`,
        },
        materializedPath: `.ai-pilot/attachments/${TURN_ID}/${attachment.name}`,
      };
    }),
  };
  const service = createDurableInteractiveTurnService({
    repository,
    attachmentStore,
    resolveThreadAccess: jest.fn().mockResolvedValue({
      access: 'owner',
      thread: options?.thread ?? authoritativeThread(),
    }),
    resolveSkillConfig: jest.fn().mockResolvedValue({
      quickSkillPills: [
        {
          label: 'App Knowledge',
          skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        },
      ],
    }),
    loadSkill: jest.fn().mockResolvedValue({
      path: '.cursor/skills/app-knowledge/SKILL.md',
      content: '# App Knowledge\nAnswer from the repository.',
    }),
    resolveGrounding: options?.groundingError
      ? jest.fn().mockRejectedValue(options.groundingError)
      : jest.fn().mockResolvedValue(
          options && 'grounding' in options
            ? options.grounding
            : {
                provider: 'github',
                project: 'project-1',
                repository: 'repo-1',
                sha: 'abc123',
                profileId: 'profile-1',
              },
        ),
    resolveMaxviewCapability: jest
      .fn()
      .mockResolvedValue(options?.maxviewCapability ?? 'disabled'),
    resolveDeadlines: jest.fn(({ interactiveClass, requiresRepositoryPreparation }) => ({
      absoluteTurnMs:
        interactiveClass === 'fast' ? 300_000 : 1_200_000,
      repositoryPreparationMs: requiresRepositoryPreparation ? 120_000 : null,
      firstEventMs: 45_000,
      toolCallMs: 60_000,
    })),
    encryptToolGrant: jest.fn((input) => ({
      userId: input.userId,
      projectId: input.projectId,
      allowedOperations: input.allowedOperations,
      expiresAt: input.expiresAt,
      encryptedAdoToken: null,
    })),
    now: () => new Date('2026-09-23T16:00:00.000Z'),
  });
  return { service, repository, attachmentStore, admitted, order };
}

describe('durable interactive turn service', () => {
  it('validates the client turn UUID before any upload or database write', async () => {
    const { service, repository, attachmentStore } = durableServiceHarness();

    await expect(
      service.admit({
        threadId: THREAD_ID,
        userId: USER_ID,
        workflowClass: 'home-chat',
        turnId: 'not-a-uuid',
        text: 'Hello',
        attachments: [],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_TURN_ID' });
    expect(attachmentStore.upload).not.toHaveBeenCalled();
    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('uploads ordered attachments before opening the admission transaction', async () => {
    const { service, order, admitted } = durableServiceHarness();

    await service.admit({
      threadId: THREAD_ID,
      userId: USER_ID,
      workflowClass: 'home-chat',
      turnId: TURN_ID,
      text: '',
      attachments: [
        {
          id: ATTEMPT_ID,
          name: 'first.txt',
          type: 'text/plain',
          size: 1,
          content: 'a',
        },
        {
          id: FENCE_ID,
          name: 'second.txt',
          type: 'text/plain',
          size: 1,
          content: 'b',
        },
      ],
    });

    expect(order).toEqual([
      `upload:${ATTEMPT_ID}`,
      `upload:${FENCE_ID}`,
      'repository',
    ]);
    expect(
      admitted[0].specification.currentMessage.attachments.map(
        (attachment) => attachment.attachmentId,
      ),
    ).toEqual([ATTEMPT_ID, FENCE_ID]);
  });

  it('classifies from capability metadata while model remains execution input only', async () => {
    const first = durableServiceHarness();
    const second = durableServiceHarness();

    await first.service.admit({
      threadId: THREAD_ID,
      userId: USER_ID,
      workflowClass: 'home-chat',
      turnId: TURN_ID,
      text: 'Hello',
      modelOverride: 'model-a',
      attachments: [],
    });
    await second.service.admit({
      threadId: THREAD_ID,
      userId: USER_ID,
      workflowClass: 'home-chat',
      turnId: TURN_ID,
      text: 'Hello',
      modelOverride: 'model-b',
      attachments: [],
    });

    expect(first.admitted[0].interactiveClass).toBe('fast');
    expect(second.admitted[0].interactiveClass).toBe('fast');
    expect(first.admitted[0].requestHash).not.toBe(
      second.admitted[0].requestHash,
    );
    expect(first.admitted[0].specification.model).toBe('model-a');
    expect(second.admitted[0].specification.model).toBe('model-b');
  });

  it('rejects stdio MCP before uploads with the stable 422 code', async () => {
    const thread = authoritativeThread({
      kickoff: {
        project: 'project-1',
        repo: 'repo-1',
        mcpPill: {
          label: 'Local tool',
          mcpServerName: 'local-tool',
          transport: 'stdio',
          command: 'npx',
        },
      },
    });
    const { service, attachmentStore, repository } = durableServiceHarness({
      thread,
    });

    await expect(
      service.admit({
        threadId: THREAD_ID,
        userId: USER_ID,
        workflowClass: 'home-chat',
        turnId: TURN_ID,
        text: 'Use the tool',
        attachments: [
          {
            id: ATTEMPT_ID,
            name: 'notes.txt',
            type: 'text/plain',
            size: 1,
            content: 'a',
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED',
    });
    expect(attachmentStore.upload).not.toHaveBeenCalled();
    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('requires pinned grounding for a registered workspace skill', async () => {
    const thread = authoritativeThread({
      kickoff: {
        project: 'project-1',
        repo: 'repo-1',
        skillProvider: 'github',
        skillPath: '.cursor/skills/app-knowledge/SKILL.md',
      },
    });
    const { service, repository } = durableServiceHarness({
      thread,
      grounding: null,
    });

    await expect(
      service.admit({
        threadId: THREAD_ID,
        userId: USER_ID,
        workflowClass: 'home-chat',
        turnId: TURN_ID,
        text: 'How does Apex work?',
        attachments: [],
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_GROUNDING_UNAVAILABLE',
    });
    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('maps thrown grounding resolution to the explicit 422 unavailable code', async () => {
    const thread = authoritativeThread({
      kickoff: {
        project: 'project-1',
        repo: 'repo-1',
        skillProvider: 'github',
        skillPath: '.cursor/skills/app-knowledge/SKILL.md',
      },
    });
    const { service, repository } = durableServiceHarness({
      thread,
      groundingError: new Error('grounding resolver unavailable'),
    });

    await expect(
      service.admit({
        threadId: THREAD_ID,
        userId: USER_ID,
        workflowClass: 'home-chat',
        turnId: TURN_ID,
        text: 'How does Apex work?',
        attachments: [],
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_GROUNDING_UNAVAILABLE',
    });
    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('freezes enabled registered MaxView as an agentic internal proxy capability', async () => {
    const { service, admitted } = durableServiceHarness({
      maxviewCapability: 'enabled',
    });

    await service.admit({
      threadId: THREAD_ID,
      userId: USER_ID,
      workflowClass: 'home-chat',
      turnId: TURN_ID,
      text: 'Inspect a timecard',
      attachments: [],
    });

    expect(admitted[0].interactiveClass).toBe('agentic');
    expect(admitted[0].specification.mcpServers).toContainEqual({
      kind: 'internal-proxy',
      serverName: 'maxview',
      enableRepoBrowse: false,
    });
  });

  it('fails explicitly when registered MaxView is enabled but unavailable', async () => {
    const { service, repository } = durableServiceHarness({
      maxviewCapability: 'unavailable',
    });

    await expect(
      service.admit({
        threadId: THREAD_ID,
        userId: USER_ID,
        workflowClass: 'home-chat',
        turnId: TURN_ID,
        text: 'Inspect a timecard',
        attachments: [],
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INTERACTIVE_V2_MAXVIEW_UNAVAILABLE',
    });
    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('freezes visible transcript, skill, grounding, prompts, and deadlines', async () => {
    const thread = authoritativeThread({
      kickoff: {
        project: 'project-1',
        repo: 'repo-1',
        skillProvider: 'github',
        skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        effort: 'low',
      },
    });
    const { service, admitted } = durableServiceHarness({ thread });

    await service.admit({
      threadId: THREAD_ID,
      userId: USER_ID,
      workflowClass: 'home-chat',
      turnId: TURN_ID,
      text: 'Explain notifications',
      attachments: [],
    });

    const frozen = admitted[0].specification;
    expect(frozen.interactiveClass).toBe('agentic');
    expect(frozen.transcript.map((entry) => entry.text)).toEqual([
      'Earlier question',
      'Earlier answer',
    ]);
    expect(frozen.skill).toMatchObject({
      name: 'App Knowledge',
      path: '.cursor/skills/app-knowledge/SKILL.md',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(frozen.grounding).toEqual({
      provider: 'github',
      project: 'project-1',
      repository: 'repo-1',
      sha: 'abc123',
      profileId: 'profile-1',
    });
    expect(frozen.currentPrompt).toContain('Explain notifications');
    expect(frozen.recreationPrompt).toContain('Earlier answer');
    expect(frozen.recreationPrompt).toContain('Explain notifications');
    expect(frozen.deadlines).toEqual({
      absoluteTurnMs: 1_200_000,
      repositoryPreparationMs: 120_000,
      firstEventMs: 45_000,
      toolCallMs: 60_000,
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
    'preserves the repository %s response for client-compatible idempotency',
    async (status) => {
      const { service } = durableServiceHarness({
        repositoryResult: {
          turnId: TURN_ID,
          runId: RUN_ID,
          status,
          interactiveClass: 'fast',
          idempotent: true,
        },
      });

      await expect(
        service.admit({
          threadId: THREAD_ID,
          userId: USER_ID,
          workflowClass: 'home-chat',
          turnId: TURN_ID,
          text: 'Hello',
          attachments: [],
        }),
      ).resolves.toEqual({
        turnId: TURN_ID,
        runId: RUN_ID,
        status,
        interactiveClass: 'fast',
        idempotent: true,
      });
    },
  );

  it.each([
    {
      repositoryResult: {
        status: 'thread_active' as const,
        activeRunId: RUN_ID,
      },
      status: 409,
      code: 'THREAD_ACTIVE_TURN',
    },
    {
      repositoryResult: {
        status: 'turn_conflict' as const,
      },
      status: 409,
      code: 'TURN_ID_CONFLICT',
    },
    {
      repositoryResult: {
        status: 'user_limit' as const,
        code: 'USER_INTERACTIVE_LIMIT' as const,
      },
      status: 429,
      code: 'USER_INTERACTIVE_LIMIT',
    },
    {
      repositoryResult: {
        status: 'user_limit' as const,
        code: 'USER_AGENTIC_LIMIT' as const,
      },
      status: 429,
      code: 'USER_AGENTIC_LIMIT',
    },
  ])('maps repository refusal to $status $code', async (testCase) => {
    const { service } = durableServiceHarness({
      repositoryResult: testCase.repositoryResult,
    });

    await expect(
      service.admit({
        threadId: THREAD_ID,
        userId: USER_ID,
        workflowClass: 'home-chat',
        turnId: TURN_ID,
        text: 'Hello',
        attachments: [],
      }),
    ).rejects.toMatchObject({
      status: testCase.status,
      code: testCase.code,
      message: testCase.code,
    });
  });

  it('has no Cursor SDK, interactive executor, Agent, or model-client import', () => {
    const source = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'src/server/services/durableInteractiveTurnService.ts',
      ),
      'utf8',
    );

    expect(source).not.toMatch(/from ['"]@cursor\/sdk/);
    expect(source).not.toMatch(/interactiveCursorExecution/);
    expect(source).not.toMatch(/\bAgent\b/);
    expect(source).not.toMatch(/bedrockService|modelClient/);
  });
});
