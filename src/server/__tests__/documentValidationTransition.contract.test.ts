import type { ValidationScorecard } from '../../shared/types/interview';

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      chatThreads: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  },
}));

const scorecardFixture = {
  slug: 'phase-2-validation',
  generated_at: '2026-09-22T00:00:00.000Z',
  review_phase: 'final',
  overall_score: 94,
  ready_threshold: 90,
  is_ready: true,
  verdict: 'ready',
  features: [],
  files: [],
  cross_cutting_checks: {},
  accepted_gaps: [],
  deferred_gaps: [],
} satisfies ValidationScorecard;

jest.mock('../services/chatAgentService', () => ({
  readOutputValidationScorecard: jest.fn(),
  readOutputValidationScorecardMd: jest.fn(),
  isThreadIdle: jest.fn(),
  createThread: jest.fn(),
  cancelRun: jest.fn(),
  sendMessage: jest.fn(),
  prepareBackgroundWorkflowTurn: jest.fn(),
  hydrateThread: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn(),
}));

jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn().mockResolvedValue(false),
  canThisInstanceFailGeneration: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(),
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn(),
  runGroundingService: {
    getGroundings: jest.fn(),
    persistThenMarkTerminalInactive: jest.fn(),
  },
}));

import {
  ingestValidationScorecard,
  startDocumentValidationWatcher,
  stopDocumentValidationWatcher,
  type DocumentValidationAdapter,
  type ValidationIngestOutcome,
} from '../services/documentValidationService';

const agent = jest.requireMock('../services/chatAgentService') as Record<
  string,
  jest.Mock
>;

type DocumentKind = 'prd' | 'design_doc';
type Snapshot = {
  status: string;
  score: number | null;
  eventState: string[];
};

function createHarness(kind: DocumentKind, currentThreadId = 'thread-current') {
  const snapshot: Snapshot = {
    status: 'validating',
    score: null,
    eventState: [],
  };
  const adapter: DocumentValidationAdapter = {
    getDocumentId: () => `${kind}-1`,
    getProject: () => 'apex',
    getAuthorId: () => 'user-1',
    getValidationThreadId: () => currentThreadId,
    getStatus: () => snapshot.status,
    buildValidationContext: () => '',
    getSkillPath: () => null,
    getModel: (_config, globalModel) => globalModel,
    updateDbForValidationStart: async () => undefined,
    updateDbForValidationResult: async (scorecard) => {
      snapshot.status =
        kind === 'prd'
          ? scorecard.is_ready
            ? 'pending_review'
            : 'draft'
          : 'pending_review';
      snapshot.score = Math.round(scorecard.overall_score);
      snapshot.eventState.push(`${kind}:persisted`);
    },
    updateDbForValidationTimeout: async () => undefined,
    updateDbForValidationError: async () => undefined,
    isCurrentValidationThread: async (threadId) => threadId === currentThreadId,
    onValidationComplete: async () => {
      snapshot.eventState.push(`${kind}:completed`);
    },
  };
  return { adapter, snapshot };
}

async function flushPromises(depth = 12): Promise<void> {
  for (let index = 0; index < depth; index += 1) await Promise.resolve();
}

describe('validation transition caller contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    agent.readOutputValidationScorecardMd.mockReturnValue('## Fixture report');
    agent.isThreadIdle.mockReturnValue(false);
  });

  afterEach(() => {
    stopDocumentValidationWatcher('prd-1');
    stopDocumentValidationWatcher('design_doc-1');
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const cases: Array<{
    name: string;
    outcome: ValidationIngestOutcome;
    watcherSetup: () => void;
    ticks: number;
  }> = [
    {
      name: 'success',
      outcome: {
        kind: 'success',
        scorecardRaw: JSON.stringify(scorecardFixture),
        reportMd: '## Fixture report',
      },
      watcherSetup: () =>
        agent.readOutputValidationScorecard.mockReturnValue(
          JSON.stringify(scorecardFixture)
        ),
      ticks: 1,
    },
    {
      name: 'unusable',
      outcome: {
        kind: 'unusable',
        reason: 'No validation scorecard was produced.',
      },
      watcherSetup: () => {
        agent.readOutputValidationScorecard.mockReturnValue(null);
        agent.isThreadIdle.mockReturnValue(true);
      },
      ticks: 1,
    },
    {
      name: 'timeout',
      outcome: { kind: 'timeout', reason: 'Validation timed out.' },
      watcherSetup: () => {
        agent.readOutputValidationScorecard.mockReturnValue(null);
        agent.isThreadIdle.mockReturnValue(false);
      },
      ticks: 721,
    },
    {
      name: 'parse-unusable',
      outcome: { kind: 'success', scorecardRaw: '{not-json' },
      watcherSetup: () =>
        agent.readOutputValidationScorecard.mockReturnValue('{not-json'),
      ticks: 1,
    },
  ];

  it.each(['prd', 'design_doc'] as const)(
    'watcher and playbook stand-in reach identical %s status/event state',
    async (kind) => {
      for (const contractCase of cases) {
        const watcher = createHarness(kind);
        contractCase.watcherSetup();
        startDocumentValidationWatcher(watcher.adapter, 'thread-current');
        for (let tick = 0; tick < contractCase.ticks; tick += 1) {
          jest.advanceTimersByTime(5_001);
          await flushPromises();
        }
        stopDocumentValidationWatcher(`${kind}-1`);

        const playbook = createHarness(kind);
        await ingestValidationScorecard(
          playbook.adapter,
          'thread-current',
          contractCase.outcome
        );

        expect(watcher.snapshot).toEqual(playbook.snapshot);
        expect(
          kind === 'prd'
            ? ['validating', 'draft', 'pending_review']
            : ['validating', 'pending_review']
        ).toContain(playbook.snapshot.status);
      }
    }
  );

  it('discards stale watcher and playbook outcomes before writes or events', async () => {
    agent.readOutputValidationScorecard.mockReturnValue(
      JSON.stringify(scorecardFixture)
    );
    const watcher = createHarness('design_doc', 'thread-new');
    startDocumentValidationWatcher(watcher.adapter, 'thread-old');
    jest.advanceTimersByTime(5_001);
    await flushPromises();

    const playbook = createHarness('design_doc', 'thread-new');
    const result = await ingestValidationScorecard(
      playbook.adapter,
      'thread-old',
      { kind: 'success', scorecardRaw: JSON.stringify(scorecardFixture) }
    );

    expect(result).toEqual({ disposition: 'discarded_stale' });
    expect(watcher.snapshot).toEqual(playbook.snapshot);
    expect(playbook.snapshot).toEqual({
      status: 'validating',
      score: null,
      eventState: [],
    });
  });
});
