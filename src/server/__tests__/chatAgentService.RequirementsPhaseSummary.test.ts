/**
 * Unit tests for the Requirements Phase Summary output reader
 * (FEAT-004 / PBI-007 / TBI-004 DoD-1).
 *
 * The filesystem is mocked, so each test states exactly which files the
 * requirements-phase Skill left in the thread output directory.
 */
// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  cpSync: jest.fn(),
  rmSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  readdirSync: jest.fn().mockReturnValue([]),
  readFileSync: jest.fn().mockReturnValue(''),
}));

jest.mock('@cursor/sdk', () => {
  class CursorAgentError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CursorAgentError';
    }
  }
  return {
    Agent: { create: jest.fn(), resume: jest.fn() },
    CursorAgentError,
  };
});

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: jest.fn().mockResolvedValue(null) },
      prds: { findFirst: jest.fn().mockResolvedValue(null) },
      designDocs: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn(() => ({
      values: jest.fn(() =>
        Object.assign(Promise.resolve(), {
          onConflictDoNothing: jest.fn(() => Promise.resolve()),
        })
      ),
    })),
    delete: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve()),
    })),
  },
}));

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
  chatThreads: {},
  agentRuns: { id: 'id' },
}));

jest.mock('../services/chatThreadRepository', () => ({
  upsertThread: jest.fn().mockResolvedValue(undefined),
  insertMessage: jest.fn().mockResolvedValue(undefined),
  listThreadsByUser: jest.fn().mockResolvedValue([]),
  loadFullThread: jest.fn().mockResolvedValue(null),
  deleteThread: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/prdService', () => ({ syncPrdContent: jest.fn() }));

jest.mock('../services/designDocService', () => ({
  syncDesignDocContent: jest.fn(),
  syncValidationResult: jest.fn(),
  syncPerFeatureDesignDocs: jest.fn(),
  finalizeSingleFeatureDoc: jest.fn(),
  isSingleFeatureDesignDocRow: jest.fn().mockReturnValue(false),
}));

jest.mock('../services/telemetry', () => ({
  trackAgentError: jest.fn(),
  trackEvent: jest.fn(),
}));

jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => '/tmp/test-data',
  isAzureWwwroot: () => false,
}));

jest.mock('../utils/retry', () => ({
  retryWithBackoff: jest.fn(),
}));

jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
  handleIncoming: jest.fn(),
}));

jest.mock('../services/skillCatalogFacade', () => ({
  getSkillFile: jest.fn().mockResolvedValue('# Frozen skill content'),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/agentRunLifecycleService', () => ({
  enqueue: jest.fn(),
}));

jest.mock('../services/interactiveWorkflowRouter', () => ({
  interactiveWorkflowRouter: { route: jest.fn() },
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(false),
  isLifecycleBindingEnabledForCaller: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/callerGroundingService', () => ({
  callerGroundingService: { start: jest.fn() },
  callerGroundingSelectionToBinding: jest.fn(),
  evaluateBindingContinuity: jest.fn(),
}));

jest.mock('../services/groundingProfileResolver', () => ({
  groundingProfileResolver: { resolveConnectionProfile: jest.fn() },
}));

jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn().mockResolvedValue(false),
  resolveAgentRunHardLimitMs: jest.fn().mockReturnValue(10 * 60 * 1000),
  resolveAgentFirstEventTimeoutMs: jest.fn().mockReturnValue(2 * 60 * 1000),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import path from 'path';
import {
  createThread,
  isOutputWorkspaceReadable,
  readOutputRequirementsPhaseSummary,
} from '../services/chatAgentService';

const mockedFs = jest.requireMock('fs') as {
  existsSync: jest.Mock;
  readdirSync: jest.Mock;
  readFileSync: jest.Mock;
};

const SUMMARY = [
  '# Requirements Phase Summary',
  '',
  '## Feature intent',
  'Capture what the feature must do for the BA.',
].join('\n');

function fileEntry(name: string) {
  return { name, isFile: () => true, isDirectory: () => false };
}

/** Pretend `files` are the only entries in this thread's output directory. */
function stubOutputDir(outputDir: string, files: string[]): void {
  mockedFs.existsSync.mockImplementation((target: string) => target === outputDir);
  mockedFs.readdirSync.mockImplementation((target: string) =>
    target === outputDir ? files.map(fileEntry) : []
  );
}

async function newThread(): Promise<{ id: string; outputDir: string }> {
  const thread = await createThread(
    'requirements-owner',
    { project: 'proj', repo: 'org/repo', branch: 'main' },
    { skipAutoKickoff: true }
  );
  return {
    id: thread.id,
    outputDir: path.join(thread.workspaceDir, '.ai-pilot', 'output'),
  };
}

describe('readOutputRequirementsPhaseSummary (FEAT-004 / TBI-004 DoD-1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockReturnValue([]);
    mockedFs.readFileSync.mockReturnValue('');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('DoD-1 / VT-09: returns the summary the Skill wrote for the interview', async () => {
    const thread = await newThread();
    stubOutputDir(thread.outputDir, ['login-flow.requirements-phase-summary.md']);
    mockedFs.readFileSync.mockReturnValue(SUMMARY);

    expect(readOutputRequirementsPhaseSummary(thread.id)).toBe(SUMMARY);
    expect(mockedFs.readFileSync).toHaveBeenCalledWith(
      path.join(thread.outputDir, 'login-flow.requirements-phase-summary.md'),
      'utf-8'
    );
  });

  it('VT-10: returns null when the readable workspace holds no summary', async () => {
    const thread = await newThread();
    stubOutputDir(thread.outputDir, ['login-flow.prd.md', 'login-flow.backlog.json']);

    expect(readOutputRequirementsPhaseSummary(thread.id)).toBeNull();
    expect(isOutputWorkspaceReadable(thread.id)).toBe(true);
    expect(mockedFs.readFileSync).not.toHaveBeenCalled();
  });

  it('VT-10: returns null for an unreadable workspace, which the readable helper reports too', () => {
    expect(readOutputRequirementsPhaseSummary('never-hydrated-thread')).toBeNull();
    expect(isOutputWorkspaceReadable('never-hydrated-thread')).toBe(false);
  });
});
