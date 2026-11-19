/**
 * FEAT-002 / S4 — Summary store, summary ingest, recreation builder,
 * stalled-resume binding clear, and durable summarize/harness support.
 *
 * Covers: TBI-011 (DoD-0..2), PBI-006 (AC-0..2), PBI-007 (AC-2..3),
 * BR-005, BR-006, BR-007, BR-012, VT-12, VT-13, VT-14, VT-19, VT-20, VT-21, VT-22.
 */
const mockFindFirst = jest.fn();
const mockUpdate = jest.fn();
const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockTransaction = jest.fn();
const mockNotifyRunEvent = jest.fn();
const mockTransition = jest.fn();
const mockMarkTerminal = jest.fn();
const mockTrackEvent = jest.fn();
const mockGetCursorAgentId = jest.fn();
const mockSetCursorAgentId = jest.fn();
const mockWorkerInteractiveTurn = jest.fn();
const mockWorkerColdStart = jest.fn();

jest.mock('../../db/drizzle', () => ({
  db: {
    query: {
      agentRuns: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

jest.mock('../../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'test-instance',
  nextRunEventSequence: jest.fn().mockReturnValue(11),
  notifyRunEvent: (...args: unknown[]) => mockNotifyRunEvent(...args),
}));

jest.mock('../../services/agentRunLifecycleService', () => ({
  transition: (...args: unknown[]) => mockTransition(...args),
  markTerminal: (...args: unknown[]) => mockMarkTerminal(...args),
}));

jest.mock('../../services/telemetry', () => ({
  ...jest.requireActual('../../services/telemetry'),
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

jest.mock('../../services/workerTierTelemetry', () => ({
  workerTierTelemetry: {
    inflight: jest.fn(),
    queueDepth: jest.fn(),
    queueOldestAge: jest.fn(),
    projectInflight: jest.fn(),
    admissionWait: jest.fn(),
    coldStart: (...args: unknown[]) => mockWorkerColdStart(...args),
    cancellation: jest.fn(),
    reaperAction: jest.fn(),
    terminalReason: jest.fn(),
    interactiveTurn: (...args: unknown[]) => mockWorkerInteractiveTurn(...args),
    interactiveFirstToken: jest.fn(),
    interactiveInflight: jest.fn(),
    interactiveShed: jest.fn(),
    interactiveActorHealth: jest.fn(),
    interactiveReplay: jest.fn(),
    interactiveStage: jest.fn(),
    interactiveHeartbeats: jest.fn(),
  },
}));

jest.mock('../../services/chatThreadRepository', () => ({
  getCursorAgentId: (...args: unknown[]) => mockGetCursorAgentId(...args),
  setCursorAgentId: (...args: unknown[]) => mockSetCursorAgentId(...args),
  insertMessage: jest.fn(),
}));

jest.mock('../../services/testCaseService', () => ({
  failGeneratingTestCasesForThread: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/adrService', () => ({
  applyAdrGenerationResult: jest.fn().mockResolvedValue(false),
}));

import {
  saveSummary,
  getLatestNonFallbackSummary,
  getLatestSummaryMarker,
  countVisibleMessagesBefore,
} from '../../services/chatHarness/chatHarnessSummaryStore';
import {
  buildRecreationPrompt,
  DEFAULT_MAX_TURNS_WITHOUT_SUMMARY,
  DEFAULT_RECREATION_MAX_CHARS,
} from '../../services/chatHarness/chatHarnessRecreation';
import {
  ingest,
  getBootstrap,
  AiRunIngestError,
} from '../../services/aiRunIngestService';
import {
  createDurableInteractiveTurnRepository,
  type PreparedDurableInteractiveTurn,
} from '../../services/durableInteractiveTurnRepository';
import { createDurableInteractiveTurnService } from '../../services/durableInteractiveTurnService';
import type { ChatMessage, ChatThread } from '../../../shared/types/chat';
import type {
  DurableInteractiveTurnSpecification,
  FrozenHarnessSpec,
} from '../../../shared/types/durableInteractiveTurn';

const THREAD_ID = '10000000-0000-4000-8000-000000000001';
const TURN_ID = '20000000-0000-4000-8000-000000000002';
const COMMAND_ID = '30000000-0000-4000-8000-000000000003';
const USER_ID = '40000000-0000-4000-8000-000000000004';
const RUN_ID = '50000000-0000-4000-8000-000000000005';
const ATTEMPT_ID = '60000000-0000-4000-8000-000000000006';
const DISPATCH_ID = '70000000-0000-4000-8000-000000000007';

const HARNESS_SPEC: FrozenHarnessSpec = {
  area: 'agent-home',
  version: 1,
  toolAllowlist: ['Read', 'Glob'],
  customTools: [],
  writeConfirmation: [],
  safety: {
    repositoryCode: 'read',
    shell: 'none',
    settingSources: [],
  },
};

function makeMessages(count: number): Array<ChatMessage & { role: 'user' | 'agent' }> {
  return Array.from({ length: count }, (_, idx) => {
    const ordinal = idx + 1;
    const role: 'user' | 'agent' = ordinal % 2 === 1 ? 'user' : 'agent';
    return {
      id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
      role,
      text: `Message number ${ordinal} payload content`,
      ts: new Date(Date.UTC(2026, 9, 1, 0, 0, ordinal)).toISOString(),
    };
  });
}

function makeInteractiveRunRow(overrides: Record<string, unknown> = {}) {
  const baseSpec: DurableInteractiveTurnSpecification = {
    schemaVersion: 1,
    kind: 'interactive-turn',
    turnId: TURN_ID,
    threadId: THREAD_ID,
    userId: USER_ID,
    projectId: 'project-1',
    interactiveClass: 'fast',
    workflowClass: 'home-chat',
    model: 'composer-2.5',
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
    harness: HARNESS_SPEC,
  };
  return {
    id: RUN_ID,
    threadId: THREAD_ID,
    status: 'running',
    projectId: 'project-1',
    lane: 'ai-runs-interactive',
    transportVersion: 'dapr-actor-v2',
    queuedAt: '2026-10-01T12:00:00.000Z',
    dispatchedAt: '2026-10-01T12:00:01.000Z',
    dispatchMessageId: DISPATCH_ID,
    executionSnapshot: baseSpec,
    cancelRequested: false,
    cancelState: null,
    terminalReason: null,
    timeoutAt: new Date(Date.now() + 120_000).toISOString(),
    ownerInstance: null,
    updatedAt: '2026-10-01T12:00:02.000Z',
    heartbeatAt: '2026-10-01T12:00:02.000Z',
    progressAt: null,
    progressLabel: null,
    progressPhase: null,
    startedAt: '2026-10-01T12:00:01.000Z',
    createdAt: '2026-10-01T12:00:00.000Z',
    eventDriven: true,
    lastError: null,
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

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SESSION_SECRET = 'test-session-secret-for-s4-tests';
  mockNotifyRunEvent.mockResolvedValue(undefined);
  mockSetCursorAgentId.mockResolvedValue(undefined);
  mockGetCursorAgentId.mockResolvedValue(null);
  mockTransition.mockImplementation(async (_id, status) => ({
    ok: true,
    run: makeInteractiveRunRow({ status }),
  }));
  mockMarkTerminal.mockImplementation(async (_id, input) => ({
    ok: true,
    run: makeInteractiveRunRow({ status: input.status }),
  }));
});

describe('chatHarnessSummaryStore (TBI-011, PBI-006, BR-005, BR-007)', () => {
  it('VT-12 / PBI-006 AC-0 / BR-007: saveSummary persists row and never logs summary text', async () => {
    const secretSummary = 'CONFIDENTIAL_SUMMARY_BODY_991122';
    const returning = jest.fn().mockResolvedValue([
      {
        id: '80000000-0000-4000-8000-000000000001',
        threadId: THREAD_ID,
        runId: RUN_ID,
        summaryText: secretSummary,
        source: 'user',
        isFallback: false,
        coversThroughOrdinal: 42,
        createdAt: '2026-10-01T12:10:00.000Z',
      },
    ]);
    const values = jest.fn().mockReturnValue({ returning });
    mockInsert.mockReturnValue({ values });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const saved = await saveSummary({
        threadId: THREAD_ID,
        runId: RUN_ID,
        summaryText: secretSummary,
        source: 'user',
        isFallback: false,
        coversThroughOrdinal: 42,
      });

      expect(values).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        runId: RUN_ID,
        summaryText: secretSummary,
        source: 'user',
        isFallback: false,
        coversThroughOrdinal: 42,
      });
      expect(saved).toMatchObject({
        threadId: THREAD_ID,
        runId: RUN_ID,
        summaryText: secretSummary,
        source: 'user',
        isFallback: false,
        coversThroughOrdinal: 42,
      });
      const allLogs = [
        ...logSpy.mock.calls,
        ...infoSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ];
      expect(JSON.stringify(allLogs)).not.toContain(secretSummary);
    } finally {
      logSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('TBI-011 DoD-0 / VT-14: getLatestNonFallbackSummary queries only non-fallback rows and getLatestSummaryMarker omits summaryText', async () => {
    const fullRow = {
      id: '80000000-0000-4000-8000-000000000001',
      threadId: THREAD_ID,
      runId: RUN_ID,
      summaryText: 'Earlier full summary text',
      source: 'auto' as const,
      isFallback: false,
      coversThroughOrdinal: 100,
      createdAt: '2026-10-01T12:00:00.000Z',
    };

    const limitFull = jest.fn().mockResolvedValue([fullRow]);
    const orderByFull = jest.fn().mockReturnValue({ limit: limitFull });
    const whereFull = jest.fn().mockReturnValue({ orderBy: orderByFull });
    const fromFull = jest.fn().mockReturnValue({ where: whereFull });
    mockSelect.mockReturnValueOnce({ from: fromFull });

    const latestFull = await getLatestNonFallbackSummary(THREAD_ID);
    expect(latestFull).toEqual(fullRow);
    expect(limitFull).toHaveBeenCalledWith(1);

    // Latest marker returns fallback metadata WITHOUT summaryText
    const markerRow = {
      id: '80000000-0000-4000-8000-000000000002',
      source: 'user' as const,
      isFallback: true,
      createdAt: '2026-10-01T12:30:00.000Z',
    };
    const limitMarker = jest.fn().mockResolvedValue([markerRow]);
    const orderByMarker = jest.fn().mockReturnValue({ limit: limitMarker });
    const whereMarker = jest.fn().mockReturnValue({ orderBy: orderByMarker });
    const fromMarker = jest.fn().mockReturnValue({ where: whereMarker });
    mockSelect.mockReturnValueOnce({ from: fromMarker });

    const marker = await getLatestSummaryMarker(THREAD_ID);
    expect(marker).toEqual({
      id: markerRow.id,
      source: 'user',
      fallback: true,
      createdAt: markerRow.createdAt,
    });
    expect(marker).not.toHaveProperty('summaryText');
    // The marker query itself should not even select summaryText
    const selectShape = mockSelect.mock.calls[1]?.[0];
    expect(selectShape).toBeDefined();
    expect(selectShape).not.toHaveProperty('summaryText');
  });

  it('TBI-011: countVisibleMessagesBefore counts only non-hidden user/agent messages before beforeMessageId', async () => {
    const orderedRows = [
      { id: 'm1', role: 'user', hidden: false, toolName: null },
      { id: 'm2', role: 'agent', hidden: false, toolName: '_reasoning' },
      { id: 'm3', role: 'agent', hidden: false, toolName: null },
      { id: 'm4', role: 'user', hidden: true, toolName: null },
      { id: 'm5', role: 'tool', hidden: false, toolName: 'Read' },
      { id: 'm6', role: 'user', hidden: false, toolName: null }, // current turn message
      { id: 'm7', role: 'agent', hidden: false, toolName: null },
    ];
    const orderBy = jest.fn().mockResolvedValue(orderedRows);
    const where = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });

    expect(await countVisibleMessagesBefore(THREAD_ID, 'm6')).toBe(2);
    expect(await countVisibleMessagesBefore(THREAD_ID, null)).toBe(4);
  });
});

describe('chatHarnessRecreation.buildRecreationPrompt (VT-19, VT-20, PBI-007 AC-2/3, DoD-0/1)', () => {
  it('VT-19 / PBI-007 AC-2 / DoD-0: 500-message thread with full summary covering position 480 uses skill, summary, and ONLY messages 481..500', () => {
    const messages = makeMessages(500);
    const prompt = buildRecreationPrompt({
      header: '# Apex interactive turn\nProject: Apex\nRepository: AI-Pilot',
      areaKeyContext: 'PRD draft v3: authentication scope',
      latestFullSummary: {
        summaryText: 'Full summary covering turns 1 through 480.',
        coversThroughOrdinal: 480,
        isFallback: false,
      },
      messages,
      currentTurnBlock: '# Pre-loaded skill content (.cursor/skills/grill-with-docs/SKILL.md)\nFollow grill-with-docs.\n\nUser request:\nContinue from step 4.',
    });

    expect(prompt).toContain('# Area context');
    expect(prompt).toContain('PRD draft v3: authentication scope');
    expect(prompt).toContain('# Conversation summary');
    expect(prompt).toContain('Full summary covering turns 1 through 480.');
    expect(prompt).toContain('# Messages after the summary');
    expect(prompt).toContain('# Current turn');
    expect(prompt).toContain('Follow grill-with-docs.');
    expect(prompt).toContain('Message number 481 payload content');
    expect(prompt).toContain('Message number 500 payload content');
    expect(prompt).not.toContain('Message number 480 payload content');
    expect(prompt).not.toContain('Message number 1 payload content');
    expect(prompt).not.toContain('Message number 250 payload content');
  });

  it('VT-20 / PBI-007 AC-3 / DoD-0 / DoD-1 / BR-005: ignores fallback summary and falls back to bounded last-10-turns handoff + area context (never all 500 messages)', () => {
    const messages = makeMessages(500);
    const fallbackText = 'TRIMMED_FALLBACK_SUMMARY_MUST_NEVER_APPEAR';

    const prompt = buildRecreationPrompt({
      areaKeyContext: 'Brainstorm artifact v2: checkout flow',
      latestFullSummary: {
        summaryText: fallbackText,
        coversThroughOrdinal: 490,
        isFallback: true,
      },
      messages,
      currentTurnBlock: 'User request:\nAdd retry handling.',
    });

    expect(DEFAULT_MAX_TURNS_WITHOUT_SUMMARY).toBe(10);
    expect(DEFAULT_RECREATION_MAX_CHARS).toBe(24_000);
    expect(prompt).not.toContain(fallbackText);
    expect(prompt).not.toContain('# Conversation summary');
    expect(prompt).toContain('# Area context');
    expect(prompt).toContain('Brainstorm artifact v2: checkout flow');
    expect(prompt).toContain('# Recent conversation');
    expect(prompt).toContain('# Current turn');
    // Last 10 turns = 20 messages = positions 481..500
    expect(prompt).toContain('Message number 481 payload content');
    expect(prompt).toContain('Message number 500 payload content');
    expect(prompt).not.toContain('Message number 480 payload content');
    expect(prompt).not.toContain('Message number 1 payload content');
  });

  it('VT-20 / DoD-1: bounds recent conversation and post-summary messages to maxChars', () => {
    const messages = makeMessages(30).map((m, i) => ({
      role: m.role as 'user' | 'agent',
      text: `Msg ${i + 1}: ${'A'.repeat(200)}`,
    }));

    const prompt = buildRecreationPrompt({
      latestFullSummary: null,
      messages,
      currentTurnBlock: 'User request:\nNext step',
      maxChars: 600,
    });

    // Latest message is kept; older messages beyond maxChars are dropped
    expect(prompt).toContain('Msg 30:');
    expect(prompt).not.toContain('Msg 11:');
    const recentSection = prompt.split('# Recent conversation\n')[1]?.split('\n\n# Current turn')[0] ?? '';
    expect(recentSection.length).toBeLessThanOrEqual(600);
  });
});

describe('aiRunIngestService summary ingest (VT-12, VT-13, VT-14, PBI-006 AC-0..2)', () => {
  function setupRunningAttemptMocks(runRow: Record<string, unknown>) {
    mockFindFirst.mockResolvedValue(runRow);
    // assertAttemptFence select
    const limit = jest.fn().mockResolvedValue([
      {
        id: ATTEMPT_ID,
        runId: RUN_ID,
        attemptNumber: 1,
        status: 'running',
        dispatchMessageId: DISPATCH_ID,
      },
    ]);
    const whereSelect = jest.fn().mockReturnValue({ limit });
    const fromSelect = jest.fn().mockReturnValue({ where: whereSelect, limit });
    mockSelect.mockReturnValue({ from: fromSelect });

    // updateWorkerClocks update
    const returning = jest.fn().mockResolvedValue([runRow]);
    const whereUpdate = jest.fn().mockReturnValue({ returning });
    const setUpdate = jest.fn().mockReturnValue({ where: whereUpdate });
    mockUpdate.mockReturnValue({ set: setUpdate });
  }

  it('VT-12 / PBI-006 AC-0 / BR-007: running emits text-free event; completed saves user summary, emits text-free event & telemetry, updates command receipt, never logs summary text', async () => {
    const secretSummary = 'PRIVATE_USER_SUMMARY_SHOULD_NEVER_BE_LOGGED_OR_EMITTED';
    const summarizeSpec: DurableInteractiveTurnSpecification = {
      ...(makeInteractiveRunRow().executionSnapshot as DurableInteractiveTurnSpecification),
      harness: { ...HARNESS_SPEC, operation: 'summarize' },
    };
    const runRow = makeInteractiveRunRow({ executionSnapshot: summarizeSpec });
    setupRunningAttemptMocks(runRow);

    const mockSaveSummary = jest.fn().mockResolvedValue({
      id: '90000000-0000-4000-8000-000000000001',
      threadId: THREAD_ID,
      runId: RUN_ID,
      summaryText: secretSummary,
      source: 'user',
      isFallback: false,
      coversThroughOrdinal: 24,
      createdAt: '2026-10-01T12:05:00.000Z',
    });
    const mockCountBefore = jest.fn().mockResolvedValue(24);
    const mockUpdateReceipt = jest.fn().mockResolvedValue(undefined);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // 1. running status: no summary row written, text-free event emitted
      await ingest(
        'project-1',
        RUN_ID,
        {
          kind: 'summary',
          dispatchMessageId: DISPATCH_ID,
          attemptId: ATTEMPT_ID,
          status: 'running',
          commandId: COMMAND_ID,
        },
        {
          summaryStore: {
            saveSummary: mockSaveSummary,
            countVisibleMessagesBefore: mockCountBefore,
          },
          updateCommandReceipt: mockUpdateReceipt,
        },
      );

      expect(mockSaveSummary).not.toHaveBeenCalled();
      expect(mockUpdateReceipt).not.toHaveBeenCalled();
      expect(mockNotifyRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'summary',
          event: expect.objectContaining({ type: 'summary', status: 'running' }),
        }),
        { persist: true },
      );

      mockNotifyRunEvent.mockClear();

      // 2. completed status: saves user non-fallback summary, writes text-free event, updates receipt
      await ingest(
        'project-1',
        RUN_ID,
        {
          kind: 'summary',
          dispatchMessageId: DISPATCH_ID,
          attemptId: ATTEMPT_ID,
          status: 'completed',
          text: secretSummary,
          commandId: COMMAND_ID,
        },
        {
          summaryStore: {
            saveSummary: mockSaveSummary,
            countVisibleMessagesBefore: mockCountBefore,
          },
          updateCommandReceipt: mockUpdateReceipt,
        },
      );

      expect(mockSaveSummary).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        runId: RUN_ID,
        summaryText: secretSummary,
        source: 'user',
        isFallback: false,
        coversThroughOrdinal: 24,
      });
      expect(mockNotifyRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'summary',
          event: expect.objectContaining({ type: 'summary', status: 'completed' }),
        }),
        { persist: true },
      );
      expect(JSON.stringify(mockNotifyRunEvent.mock.calls)).not.toContain(secretSummary);
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'chat.harness.summary',
        expect.objectContaining({
          area: 'agent-home',
          source: 'user',
          fallback: 'false',
          runId: RUN_ID,
        }),
        { coversThroughOrdinal: 24 },
      );
      expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain(secretSummary);
      expect(mockUpdateReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: THREAD_ID,
          commandId: COMMAND_ID,
          status: 'applied',
          reason: null,
        }),
      );
      const allLogs = [
        ...logSpy.mock.calls,
        ...infoSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ];
      expect(JSON.stringify(allLogs)).not.toContain(secretSummary);
    } finally {
      logSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('VT-13 / PBI-006 AC-1: summary error writes no summary row, emits text-free error event, and rejects command receipt', async () => {
    const runRow = makeInteractiveRunRow();
    setupRunningAttemptMocks(runRow);
    const mockSaveSummary = jest.fn();
    const mockCountBefore = jest.fn();
    const mockUpdateReceipt = jest.fn().mockResolvedValue(undefined);

    await ingest(
      'project-1',
      RUN_ID,
      {
        kind: 'summary',
        dispatchMessageId: DISPATCH_ID,
        attemptId: ATTEMPT_ID,
        status: 'error',
        commandId: COMMAND_ID,
      },
      {
        summaryStore: {
          saveSummary: mockSaveSummary,
          countVisibleMessagesBefore: mockCountBefore,
        },
        updateCommandReceipt: mockUpdateReceipt,
      },
    );

    expect(mockSaveSummary).not.toHaveBeenCalled();
    expect(mockNotifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'summary',
        status: 'failed',
        event: expect.objectContaining({ type: 'summary', status: 'error' }),
      }),
      { persist: true },
    );
    expect(mockUpdateReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        commandId: COMMAND_ID,
        status: 'rejected',
        reason: 'Could not summarize this conversation',
      }),
    );
  });

  it('VT-14 / PBI-006 AC-2 / BR-005: fallback summary saves isFallback=true with source=auto on regular turn and emits text-free event', async () => {
    const fallbackText = 'FALLBACK_TRIMMED_TRANSCRIPT_SECRET';
    const runRow = makeInteractiveRunRow(); // regular turn (no operation: 'summarize')
    setupRunningAttemptMocks(runRow);
    const mockSaveSummary = jest.fn().mockResolvedValue({
      id: '90000000-0000-4000-8000-000000000002',
      threadId: THREAD_ID,
      runId: RUN_ID,
      summaryText: fallbackText,
      source: 'auto',
      isFallback: true,
      coversThroughOrdinal: 18,
      createdAt: '2026-10-01T12:06:00.000Z',
    });
    const mockCountBefore = jest.fn().mockResolvedValue(18);

    await ingest(
      'project-1',
      RUN_ID,
      {
        kind: 'summary',
        dispatchMessageId: DISPATCH_ID,
        attemptId: ATTEMPT_ID,
        status: 'fallback',
        text: fallbackText,
      },
      {
        summaryStore: {
          saveSummary: mockSaveSummary,
          countVisibleMessagesBefore: mockCountBefore,
        },
      },
    );

    expect(mockCountBefore).toHaveBeenCalledWith(THREAD_ID, TURN_ID);
    expect(mockSaveSummary).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      runId: RUN_ID,
      summaryText: fallbackText,
      source: 'auto',
      isFallback: true,
      coversThroughOrdinal: 18,
    });
    expect(mockNotifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'summary',
        event: expect.objectContaining({ type: 'summary', status: 'fallback' }),
      }),
      { persist: true },
    );
    expect(JSON.stringify(mockNotifyRunEvent.mock.calls)).not.toContain(fallbackText);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'chat.harness.summary',
      expect.objectContaining({
        source: 'auto',
        fallback: 'true',
        runId: RUN_ID,
      }),
      { coversThroughOrdinal: 18 },
    );
  });

  it('rejects summary ingest with stale fence or missing text on completed/fallback', async () => {
    mockFindFirst.mockResolvedValue(makeInteractiveRunRow());

    await expect(
      ingest('project-1', RUN_ID, {
        kind: 'summary',
        dispatchMessageId: 'stale-dispatch-id',
        attemptId: ATTEMPT_ID,
        status: 'completed',
        text: 'Summary text',
      }),
    ).rejects.toMatchObject({ code: 'AI_RUN_DISPATCH_MISMATCH' });

    await expect(
      ingest('project-1', RUN_ID, {
        kind: 'summary',
        dispatchMessageId: DISPATCH_ID,
        attemptId: ATTEMPT_ID,
        status: 'completed',
        text: '   ',
      }),
    ).rejects.toBeInstanceOf(AiRunIngestError);
  });
});

describe('stalled-resume binding clear & idle reap vs stop (VT-21, VT-22, DoD-2, BR-012)', () => {
  function setupDaprTerminalMocks(finalStatus: 'completed' | 'failed' | 'cancelled') {
    const runRow = makeInteractiveRunRow({ status: 'running' });
    mockFindFirst.mockResolvedValue(runRow);

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount += 1;
      const limit = jest.fn().mockImplementation(async () => {
        if (selectCount <= 2) {
          return [
            {
              id: ATTEMPT_ID,
              runId: RUN_ID,
              attemptNumber: 1,
              status: 'running',
              dispatchMessageId: DISPATCH_ID,
            },
          ];
        }
        return [{ dispatchMessageId: DISPATCH_ID, status: 'running' }];
      });
      const where = jest.fn().mockReturnValue({ limit });
      const from = jest.fn().mockReturnValue({ where, limit });
      return { from };
    });

    const txUpdates: Array<Record<string, unknown>> = [];
    const txUpdate = jest.fn().mockImplementation(() => ({
      set: (values: Record<string, unknown>) => {
        txUpdates.push(values);
        const returning = jest.fn().mockResolvedValue([
          makeInteractiveRunRow({ status: finalStatus }),
        ]);
        const where = jest.fn().mockReturnValue({ returning });
        return { where };
      },
    }));

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        select: mockSelect,
        update: txUpdate,
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
        execute: jest.fn().mockResolvedValue(undefined),
      });
    });

    return { txUpdates };
  }

  it('VT-21 / TBI-011 DoD-2: stalled resume terminal with clearCursorAgentId=true clears cursor_agent_id=NULL through fenced ingest and emits telemetry with acquisitionMode & recreateReason', async () => {
    const { txUpdates } = setupDaprTerminalMocks('failed');

    await ingest('project-1', RUN_ID, {
      kind: 'terminal',
      dispatchMessageId: DISPATCH_ID,
      attemptId: ATTEMPT_ID,
      status: 'failed',
      artifactsFlushed: false,
      clearCursorAgentId: true,
      recreateReason: 'deploy',
      stageTimings: {
        agentMode: 'recreated',
        recreateReason: 'deploy',
        workerTurnMs: 1_500,
      },
      detail: 'Stalled resume timed out',
    });

    expect(txUpdates).toContainEqual({ cursorAgentId: null });
    expect(mockWorkerInteractiveTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        dispatchMessageId: DISPATCH_ID,
        project: 'project-1',
        lane: 'ai-runs-interactive',
        area: 'agent-home',
        acquisitionMode: 'recreated',
        recreateReason: 'deploy',
      }),
      1_500,
    );

    // After binding clear, a subsequent bootstrap sees cursorAgentId: null (restart does not retry resume)
    mockFindFirst.mockResolvedValueOnce(
      makeInteractiveRunRow({ status: 'dispatched' }),
    );
    mockSelect.mockImplementationOnce(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([
            {
              id: ATTEMPT_ID,
              runId: RUN_ID,
              attemptNumber: 1,
              status: 'dispatched',
              dispatchMessageId: DISPATCH_ID,
              specSnapshot: makeInteractiveRunRow().executionSnapshot,
            },
          ]),
        }),
      }),
    }));
    mockGetCursorAgentId.mockResolvedValueOnce(null);

    const bootstrap = await getBootstrap(RUN_ID, DISPATCH_ID);
    expect(bootstrap).toMatchObject({
      kind: 'interactive-actor-v2',
      cursorAgentId: null,
    });
  });

  it('VT-22 / BR-012: non-stalled failure (idle reap / transient) preserves cursor_agent_id; explicit stop/cancel clears it', async () => {
    // 1. Non-stalled failed terminal (clearCursorAgentId absent) preserves cursorAgentId
    const failedRun = setupDaprTerminalMocks('failed');
    await ingest('project-1', RUN_ID, {
      kind: 'terminal',
      dispatchMessageId: DISPATCH_ID,
      attemptId: ATTEMPT_ID,
      status: 'failed',
      artifactsFlushed: false,
      detail: 'Transient timeout',
    });
    expect(failedRun.txUpdates).not.toContainEqual(
      expect.objectContaining({ cursorAgentId: null }),
    );

    // 2. Explicit cancelled terminal clears cursorAgentId
    const cancelledRun = setupDaprTerminalMocks('cancelled');
    await ingest('project-1', RUN_ID, {
      kind: 'terminal',
      dispatchMessageId: DISPATCH_ID,
      attemptId: ATTEMPT_ID,
      status: 'cancelled',
      artifactsFlushed: true,
      detail: 'User stopped turn',
    });
    expect(cancelledRun.txUpdates).toContainEqual({ cursorAgentId: null });

    // 3. Explicit cancel_ack on interactive lane clears cursorAgentId
    mockSetCursorAgentId.mockClear();
    mockFindFirst.mockResolvedValue(
      makeInteractiveRunRow({ status: 'running', cancelRequested: true }),
    );
    const limit = jest.fn().mockResolvedValue([
      {
        id: ATTEMPT_ID,
        runId: RUN_ID,
        attemptNumber: 1,
        status: 'running',
        dispatchMessageId: DISPATCH_ID,
      },
    ]);
    mockSelect.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            makeInteractiveRunRow({ status: 'cancelled', cancelRequested: true }),
          ]),
        }),
      }),
    });

    await ingest('project-1', RUN_ID, {
      kind: 'cancel_ack',
      dispatchMessageId: DISPATCH_ID,
      attemptId: ATTEMPT_ID,
      detail: 'User cancelled',
    });

    expect(mockSetCursorAgentId).toHaveBeenCalledWith(THREAD_ID, null);
  });
});

describe('durableInteractiveTurnService & Repository summarize + harness + summary-based recreation (VT-12, VT-19, VT-20)', () => {
  it('VT-12 / PBI-006 AC-0: operation=summarize admits a run without inserting a chat_messages row and freezes harness block', async () => {
    const sqlStatements: string[] = [];
    const execute = jest.fn(async (query: unknown) => {
      const statement = sqlText(query);
      sqlStatements.push(statement);
      if (statement.includes('FROM chat_threads')) {
        return [{ id: THREAD_ID, user_id: USER_ID, active_run_id: null }];
      }
      if (statement.includes('FROM agent_runs') && statement.includes('client_turn_id')) {
        return [];
      }
      if (statement.includes('FROM agent_runs') && statement.includes('COUNT')) {
        return [{ active_count: 0, agentic_count: 0 }];
      }
      if (statement.includes('FROM agent_runs')) {
        return [];
      }
      if (statement.includes('accepted_at') && statement.includes('deadline_at')) {
        return [
          {
            accepted_at: new Date('2026-10-01T12:00:00.000Z'),
            deadline_at: new Date('2026-10-01T12:05:00.000Z'),
          },
        ];
      }
      if (statement.includes('INSERT INTO ai_run_outbox')) {
        return [{ id: 'outbox-1' }];
      }
      return [];
    });

    const repo = createDurableInteractiveTurnRepository({
      runInTransaction: async (work) => work({ execute }),
      newId: () => RUN_ID,
    });

    const captured: PreparedDurableInteractiveTurn[] = [];
    const wrappedRepo = {
      admit: async (prepared: PreparedDurableInteractiveTurn) => {
        captured.push(prepared);
        return repo.admit(prepared);
      },
      retry: repo.retry,
    };

    const thread: ChatThread = {
      id: THREAD_ID,
      userId: USER_ID,
      kickoff: {
        project: 'project-1',
        repo: 'repo-1',
        model: 'composer-2.5',
        effort: 'low',
      },
      messages: makeMessages(4),
      status: 'idle',
      workspaceDir: '/tmp/thread',
      flagged: false,
      createdAt: '2026-10-01T10:00:00.000Z',
      lastActivityAt: '2026-10-01T11:59:00.000Z',
    };

    const service = createDurableInteractiveTurnService({
      repository: wrappedRepo,
      attachmentStore: { upload: jest.fn() },
      resolveThreadAccess: jest.fn().mockResolvedValue({ access: 'owner', thread }),
      resolveSkillConfig: jest.fn().mockResolvedValue(null),
      loadSkill: jest.fn().mockResolvedValue(null),
      resolveGrounding: jest.fn().mockResolvedValue(null),
      hasPinnedGrounding: jest.fn().mockResolvedValue(false),
      resolveMaxviewCapability: jest.fn().mockResolvedValue('disabled'),
      resolveDeadlines: jest.fn().mockReturnValue({
        absoluteTurnMs: 300_000,
        repositoryPreparationMs: null,
        firstEventMs: 45_000,
        toolCallMs: 60_000,
      }),
      encryptToolGrant: jest.fn(),
      loadLatestFullSummary: jest.fn().mockResolvedValue(null),
      now: () => new Date('2026-10-01T12:00:00.000Z'),
    });

    const accepted = await service.admit({
      threadId: THREAD_ID,
      userId: USER_ID,
      workflowClass: 'home-chat',
      turnId: TURN_ID,
      text: '',
      operation: 'summarize',
      harness: HARNESS_SPEC,
    });

    expect(accepted).toMatchObject({
      turnId: TURN_ID,
      runId: RUN_ID,
      status: 'queued',
    });
    expect(captured[0]?.specification.harness).toEqual({
      ...HARNESS_SPEC,
      operation: 'summarize',
    });
    expect(captured[0]?.specification.currentMessage.hidden).toBe(true);
    // No chat_messages or chat_message_attachments row inserted for summarize operation
    expect(
      sqlStatements.some((s) => s.includes('INSERT INTO chat_messages')),
    ).toBe(false);
    expect(
      sqlStatements.some((s) => s.includes('INSERT INTO agent_runs')),
    ).toBe(true);
    expect(
      sqlStatements.some((s) => s.includes('INSERT INTO ai_run_attempts')),
    ).toBe(true);
  });

  it('VT-19 / PBI-007 AC-2: durableInteractiveTurnService uses latest non-fallback summary and only later messages for recreationPrompt on a 500-message thread', async () => {
    const admittedSpecs: DurableInteractiveTurnSpecification[] = [];
    const thread: ChatThread = {
      id: THREAD_ID,
      userId: USER_ID,
      kickoff: {
        project: 'project-1',
        repo: 'repo-1',
        skillProvider: 'github',
        skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        model: 'composer-2.5',
        effort: 'low',
      },
      messages: makeMessages(500),
      status: 'idle',
      workspaceDir: '/tmp/thread',
      flagged: false,
      createdAt: '2026-10-01T10:00:00.000Z',
      lastActivityAt: '2026-10-01T11:59:00.000Z',
    };

    const service = createDurableInteractiveTurnService({
      repository: {
        admit: jest.fn(async (input: PreparedDurableInteractiveTurn) => {
          admittedSpecs.push(input.specification);
          return {
            turnId: input.turnId,
            runId: RUN_ID,
            status: 'queued' as const,
            interactiveClass: input.interactiveClass,
            idempotent: false,
          };
        }),
        retry: jest.fn(),
      },
      attachmentStore: { upload: jest.fn() },
      resolveThreadAccess: jest.fn().mockResolvedValue({ access: 'owner', thread }),
      resolveSkillConfig: jest.fn().mockResolvedValue({
        quickSkillPills: [
          { label: 'App Knowledge', skillPath: '.cursor/skills/app-knowledge/SKILL.md' },
        ],
      }),
      loadSkill: jest.fn().mockResolvedValue({
        path: '.cursor/skills/app-knowledge/SKILL.md',
        content: '# App Knowledge Skill\nAnswer accurately.',
      }),
      resolveGrounding: jest.fn().mockResolvedValue({
        provider: 'github',
        project: 'project-1',
        repository: 'repo-1',
        sha: 'abc123',
        profileId: 'profile-1',
      }),
      hasPinnedGrounding: jest.fn().mockResolvedValue(true),
      loadRepositoryContext: jest.fn().mockResolvedValue(null),
      resolveMaxviewCapability: jest.fn().mockResolvedValue('disabled'),
      resolveDeadlines: jest.fn().mockReturnValue({
        absoluteTurnMs: 1_200_000,
        repositoryPreparationMs: 120_000,
        firstEventMs: 45_000,
        toolCallMs: 60_000,
      }),
      encryptToolGrant: jest.fn(),
      loadLatestFullSummary: jest.fn().mockResolvedValue({
        summaryText: 'Saved full summary through ordinal 480.',
        coversThroughOrdinal: 480,
        isFallback: false,
      }),
      now: () => new Date('2026-10-01T12:00:00.000Z'),
    });

    await service.admit({
      threadId: THREAD_ID,
      userId: USER_ID,
      workflowClass: 'home-chat',
      turnId: TURN_ID,
      text: 'Continue the refactor',
      harness: HARNESS_SPEC,
      areaKeyContext: 'Area key context: architecture notes',
    });

    const spec = admittedSpecs[0];
    expect(spec.harness).toEqual(HARNESS_SPEC);
    expect(spec.recreationPrompt).toContain('# App Knowledge Skill');
    expect(spec.recreationPrompt).toContain('Saved full summary through ordinal 480.');
    expect(spec.recreationPrompt).toContain('Area key context: architecture notes');
    expect(spec.recreationPrompt).toContain('Message number 481 payload content');
    expect(spec.recreationPrompt).toContain('Message number 500 payload content');
    expect(spec.recreationPrompt).not.toContain('Message number 480 payload content');
    expect(spec.recreationPrompt).not.toContain('Message number 1 payload content');
  });
});
