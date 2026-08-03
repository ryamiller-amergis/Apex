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

import {
  ThinkingPhaseCoalescer,
  buildDevelopmentPrompt,
  createRunEventEnvelope,
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
