jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  rmSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  readdirSync: jest.fn().mockReturnValue([]),
  readFileSync: jest.fn().mockReturnValue(''),
}));

jest.mock('@cursor/sdk', () => ({
  Agent: { create: jest.fn(), resume: jest.fn() },
  CursorAgentError: class CursorAgentError extends Error {},
}));

jest.mock('../db/drizzle', () => ({ db: { query: {} } }));
jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
  and: jest.fn(),
  isNull: jest.fn(),
  or: jest.fn(),
}));
jest.mock('../db/schema', () => ({
  interviews: {},
  prds: {},
  designDocs: {},
  testCases: {},
  devSessions: {},
  agentRuns: {},
}));
jest.mock('../services/chatThreadRepository', () => ({
  upsertThread: jest.fn(),
  insertMessage: jest.fn(),
  listThreadsByUser: jest.fn(),
  loadFullThread: jest.fn(),
  deleteThread: jest.fn(),
}));
jest.mock('../services/prdService', () => ({ syncPrdContent: jest.fn() }));
jest.mock('../services/aiCompletionNotifier', () => ({
  notifyAiCompletion: jest.fn(),
}));
jest.mock('../services/designDocService', () => ({
  syncDesignDocContent: jest.fn(),
  syncValidationResult: jest.fn(),
  syncPerFeatureDesignDocs: jest.fn(),
  finalizeSingleFeatureDoc: jest.fn(),
  isSingleFeatureDesignDocRow: jest.fn(
    (row: { designPrototypeId?: string | null; featureIndex?: number | null }) =>
      row.designPrototypeId != null || row.featureIndex != null,
  ),
}));
jest.mock('../services/testCaseService', () => ({
  markTestCaseFailed: jest.fn(),
  syncTestCaseOutput: jest.fn(),
  triggerTestCaseGeneration: jest.fn(),
}));
jest.mock('../services/aiUsageService', () => ({
  recordAiUsage: jest.fn(),
  estimateTokens: jest.fn().mockReturnValue(0),
  resolveFeatureFromKickoff: jest.fn().mockReturnValue('chat'),
}));
jest.mock('../services/maxviewAuthService', () => ({
  isMaxviewConfigured: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../services/telemetry', () => ({
  trackAgentError: jest.fn(),
  trackEvent: jest.fn(),
}));
jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => '/tmp/test-data',
  isAzureWwwroot: () => false,
}));
jest.mock('../utils/retry', () => ({ retryWithBackoff: jest.fn() }));
jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'worker-a',
  notifyRunEvent: jest.fn(),
}));
jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
  handleIncoming: jest.fn(),
}));
jest.mock('../services/linkedContextMaterializerService', () => ({
  LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH: '.ai-pilot/linked-context.md',
  materializeLinkedContext: jest.fn().mockResolvedValue({
    outcome: 'omitted',
    adrCount: 0,
    designModuleCount: 0,
    staleAdrExcluded: 0,
    durationMs: 0,
  }),
}));

import {
  ThinkingPhaseCoalescer,
  buildAgentRunClaimUpdate,
  buildDevelopmentPrompt,
  createRunEventEnvelope,
  disposeAgentWithinDeadline,
  sanitizeTerminalDetail,
  shouldPersistAgentRunProgress,
} from '../services/chatAgentService';

describe('ThinkingPhaseCoalescer', () => {
  it('coalesces hundreds of token fragments into one safe phase event', () => {
    const tracker = new ThinkingPhaseCoalescer(() => 1_000);

    for (let index = 0; index < 600; index += 1) {
      tracker.observe({ text: `private thought ${index}`, durationMs: index });
    }

    const event = tracker.flush(4_000);
    expect(event).toEqual({
      type: 'phase',
      phase: 'analysis',
      status: 'completed',
      detail: 'Analysis completed',
      durationMs: 3_000,
    });
    expect(JSON.stringify(event)).not.toContain('private thought');
    expect(tracker.flush(5_000)).toBeNull();
  });
});

describe('createRunEventEnvelope', () => {
  it('creates a stable typed envelope before fan-out', () => {
    const event = createRunEventEnvelope({
      eventId: 'event-1',
      threadId: 'thread-1',
      runId: 'run-1',
      sequence: 7,
      timestamp: '2026-07-14T12:00:00.000Z',
      event: {
        type: 'phase',
        phase: 'implementation',
        status: 'running',
        detail: 'Implementing FEAT-001',
      },
    });

    expect(event).toMatchObject({
      eventId: 'event-1',
      threadId: 'thread-1',
      runId: 'run-1',
      sourceInstance: 'worker-a',
      sequence: 7,
      type: 'phase',
      phase: 'implementation',
      status: 'running',
      detail: 'Implementing FEAT-001',
    });
  });
});

describe('authoritative terminal safety', () => {
  it('PBI-001 Security NFR normalizes controls, redacts secrets and caps detail at 2,000 characters', () => {
    const detail = [
      'failure\u0000\r\n',
      'Bearer live-token',
      ' password=hunter2',
      ' postgresql://admin:secret@example.invalid/apex',
      ' Server=db;Database=apex;User Id=admin;Password=secret;',
      'x'.repeat(3_000),
    ].join('');

    const sanitized = sanitizeTerminalDetail(detail);

    expect(sanitized.length).toBeLessThanOrEqual(2_000);
    expect(sanitized).not.toMatch(/live-token|hunter2|admin:secret|Password=secret/i);
    expect([...sanitized].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })).toBe(true);
    expect(sanitized).toContain('[redacted]');
  });

  it('PBI-001 AC-1 / VT-02 bounds stalled SDK disposal at 10 seconds', async () => {
    jest.useFakeTimers();
    try {
      const dispose = jest.fn(() => new Promise<void>(() => undefined));
      const pending = disposeAgentWithinDeadline(
        { [Symbol.asyncDispose]: dispose },
        10_000,
      );

      jest.advanceTimersByTime(10_000);

      await expect(pending).resolves.toBe(false);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('TBI-001 DoD-4 retains failure when SDK disposal rejects', async () => {
    const dispose = jest.fn().mockRejectedValue(new Error('pipe closed'));

    await expect(disposeAgentWithinDeadline({
      [Symbol.asyncDispose]: dispose,
    })).resolves.toBe(false);
  });
});

describe('TBI-003 Retire-mode liveness writes', () => {
  it('DoD-2 omits heartbeat and progress fields when claiming an event-driven run', () => {
    const update = buildAgentRunClaimUpdate(
      true,
      'worker-a',
      '2026-08-04T12:00:00.000Z',
    );

    expect(update).toEqual({
      status: 'running',
      ownerInstance: 'worker-a',
      updatedAt: '2026-08-04T12:00:00.000Z',
      eventDriven: true,
    });
    expect(JSON.stringify(update)).not.toMatch(/heartbeatAt|progressAt|progressLabel|progressPhase/);
  });

  it('marks the run event-driven so the reaper classifies it from the row', () => {
    expect(buildAgentRunClaimUpdate(
      true,
      'worker-a',
      '2026-08-04T12:00:00.000Z',
    )).toMatchObject({ eventDriven: true });
    expect(buildAgentRunClaimUpdate(
      false,
      'worker-a',
      '2026-08-04T12:00:00.000Z',
    )).toMatchObject({ eventDriven: false });
  });

  it('DoD-2 preserves legacy heartbeat/progress writes when the flag is disabled', () => {
    expect(buildAgentRunClaimUpdate(
      false,
      'worker-a',
      '2026-08-04T12:00:00.000Z',
    )).toMatchObject({
      heartbeatAt: '2026-08-04T12:00:00.000Z',
      progressAt: '2026-08-04T12:00:00.000Z',
      progressLabel: 'Agent run started',
      progressPhase: 'implementation',
      eventDriven: false,
    });
  });

  it('BR-005 persists semantic events but not liveness columns in event-driven mode', () => {
    expect(shouldPersistAgentRunProgress(true)).toBe(false);
    expect(shouldPersistAgentRunProgress(false)).toBe(true);
  });
});

describe('development dependency instructions', () => {
  it('states package-manager-aware dependencies are prepared when bootstrap ran', () => {
    const prompt = buildDevelopmentPrompt({
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'feature/reliable-sessions',
      mode: 'development',
      dependenciesPrepared: true,
    });

    expect(prompt).toMatch(/package-manager-aware.*dependencies.*prepared/i);
    expect(prompt).toMatch(/do not run.*(?:npm|pnpm|yarn).*(?:install|ci)/i);
    expect(prompt).toMatch(
      /unless.*(?:package-lock\.json|manifest|lockfile).*changes/i
    );
  });

  it('allows the agent workflow to install dependencies when bootstrap was skipped', () => {
    const prompt = buildDevelopmentPrompt({
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'feature/reliable-sessions',
      mode: 'development',
      dependenciesPrepared: false,
    });

    expect(prompt).toMatch(/dependency bootstrap was skipped/i);
    expect(prompt).toMatch(/install.*dependencies.*project.*requires/i);
    expect(prompt).not.toMatch(
      /do not run.*(?:npm|pnpm|yarn).*(?:install|ci)/i
    );
    expect(prompt).not.toMatch(/dependencies.*already prepared/i);
  });
});
