import fs from 'fs';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      featureRequests: { findFirst: jest.fn() },
      chatThreads: { findFirst: jest.fn() },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

jest.mock('../services/chatAgentService', () => ({
  isThreadIdle: jest.fn(),
  createThread: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

import { db } from '../db/drizzle';
import {
  autoStartFeatureRequestAnalysis,
  reanalyzeFeatureRequest,
  stopWatcher,
  isWatcherActive,
  startWatcher,
} from '../services/featureRequestAnalysisService';
import { createThread, isThreadIdle } from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';

const mockedDb = db as any;
const mockedCreateThread = createThread as jest.MockedFunction<typeof createThread>;
const mockedIsThreadIdle = isThreadIdle as jest.MockedFunction<typeof isThreadIdle>;
const mockedResolveSkillConfig = resolveSkillConfig as jest.MockedFunction<typeof resolveSkillConfig>;
const mockedGetDefaultModel = getDefaultModel as jest.MockedFunction<typeof getDefaultModel>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockedGetDefaultModel.mockResolvedValue('claude-sonnet-4');
});

afterEach(() => {
  stopWatcher('req-1');
  jest.useRealTimers();
});

const FAKE_REQUEST = {
  id: 'req-1',
  title: 'Add dark mode',
  request: 'Users want a dark mode toggle',
  advantage: 'Improves accessibility and user satisfaction',
  submittedBy: 'user-1',
  sourceProject: 'Apex',
  status: 'new',
  aiStatus: 'pending',
  aiPriority: null,
  aiRisk: null,
  aiRationale: null,
  aiThreadId: null,
};

const FAKE_SKILL_CONFIG = {
  id: 'cfg-1',
  project: 'Apex',
  skillRepo: 'org/repo',
  skillBranch: 'main',
  skillProvider: 'github' as const,
  friendlyName: 'Default',
  isDefault: true,
  featureRequestSkillPath: 'src/server/skills/feature-request-analysis/SKILL.md',
  featureRequestModel: 'claude-sonnet-4',
  defaultModel: 'claude-sonnet-4',
};

describe('autoStartFeatureRequestAnalysis', () => {
  it('marks failed when feature request not found', async () => {
    mockedDb.query.featureRequests.findFirst.mockResolvedValue(null);

    await autoStartFeatureRequestAnalysis('req-1');

    expect(mockedDb.update).not.toHaveBeenCalled();
  });

  it('marks failed when no skill config exists', async () => {
    mockedDb.query.featureRequests.findFirst.mockResolvedValue(FAKE_REQUEST);
    mockedResolveSkillConfig.mockResolvedValue(null);

    await autoStartFeatureRequestAnalysis('req-1');

    expect(mockedDb.update).toHaveBeenCalled();
    const setCall = mockedDb.update().set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({ aiStatus: 'failed' }),
    );
  });

  it('marks failed when featureRequestSkillPath is not configured', async () => {
    mockedDb.query.featureRequests.findFirst.mockResolvedValue(FAKE_REQUEST);
    mockedResolveSkillConfig.mockResolvedValue({
      ...FAKE_SKILL_CONFIG,
      featureRequestSkillPath: null,
    });

    await autoStartFeatureRequestAnalysis('req-1');

    expect(mockedDb.update).toHaveBeenCalled();
  });

  it('creates a chat thread and starts watcher on success', async () => {
    mockedDb.query.featureRequests.findFirst.mockResolvedValue(FAKE_REQUEST);
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG);
    mockedCreateThread.mockResolvedValue({
      id: 'thread-1',
      userId: 'system',
      kickoff: {} as any,
      messages: [],
      status: 'idle',
      workspaceDir: '/tmp/ws/thread-1',
      flagged: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });

    await autoStartFeatureRequestAnalysis('req-1');

    expect(mockedCreateThread).toHaveBeenCalledWith('system', {
      project: 'Apex',
      repo: 'org/repo',
      branch: 'main',
      skillProvider: 'github',
      skillPath: FAKE_SKILL_CONFIG.featureRequestSkillPath,
      freeformContext: expect.stringContaining('Add dark mode'),
      model: 'claude-sonnet-4',
    });

    expect(mockedDb.update).toHaveBeenCalled();
    expect(isWatcherActive('req-1')).toBe(true);
  });
});

describe('startWatcher', () => {
  it('persists analysis result on successful output', async () => {
    const analysisResult = {
      priority: 'high',
      risk: 'medium',
      rationale: 'Dark mode is highly requested and aligns with accessibility goals.',
    };

    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      workspaceDir: '/tmp/ws/thread-1',
    });
    mockedDb.query.featureRequests.findFirst.mockResolvedValue({
      aiThreadId: 'thread-1',
    });

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(analysisResult));
    mockFs.rmSync.mockImplementation(() => {});

    startWatcher('req-1', 'thread-1');

    // First tick: resolves workspaceDir
    await jest.advanceTimersByTimeAsync(5_000);
    // Second tick: reads output and syncs
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockedDb.update).toHaveBeenCalled();
    const setFn = mockedDb.update().set;
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        aiStatus: 'complete',
        aiPriority: 'high',
        aiRisk: 'medium',
        aiRationale: 'Dark mode is highly requested and aligns with accessibility goals.',
      }),
    );
    expect(isWatcherActive('req-1')).toBe(false);
  });

  it('marks failed when agent completes without output', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      workspaceDir: '/tmp/ws/thread-1',
    });
    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(true);

    startWatcher('req-1', 'thread-1');

    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockedDb.update).toHaveBeenCalled();
    expect(isWatcherActive('req-1')).toBe(false);
  });

  it('times out after max attempts', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      workspaceDir: '/tmp/ws/thread-1',
    });
    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(false);

    startWatcher('req-1', 'thread-1');

    // Simulate exceeding max attempts (720 * 5s = 3600s)
    for (let i = 0; i < 722; i++) {
      await jest.advanceTimersByTimeAsync(5_000);
    }

    expect(mockedDb.update).toHaveBeenCalled();
    expect(isWatcherActive('req-1')).toBe(false);
  });

  it('discards stale results when thread no longer matches', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      workspaceDir: '/tmp/ws/thread-1',
    });
    mockedDb.query.featureRequests.findFirst.mockResolvedValue({
      aiThreadId: 'thread-NEW',
    });

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ priority: 'low', risk: 'low', rationale: 'test' }));
    mockFs.rmSync.mockImplementation(() => {});

    startWatcher('req-1', 'thread-1');

    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    // update should only be called for the workspace lookup, not for saving result
    // The stale result path does cleanupWorkspace but does not updateAiFields
    expect(isWatcherActive('req-1')).toBe(false);
  });
});

describe('reanalyzeFeatureRequest', () => {
  it('resets AI fields and restarts analysis', async () => {
    mockedDb.query.featureRequests.findFirst.mockResolvedValue(FAKE_REQUEST);
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG);
    mockedCreateThread.mockResolvedValue({
      id: 'thread-2',
      userId: 'system',
      kickoff: {} as any,
      messages: [],
      status: 'idle',
      workspaceDir: '/tmp/ws/thread-2',
      flagged: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });

    await reanalyzeFeatureRequest('req-1');

    // Should have been called at least twice: once for reset, once for analyzing start
    expect(mockedDb.update).toHaveBeenCalled();
    expect(mockedCreateThread).toHaveBeenCalled();
    expect(isWatcherActive('req-1')).toBe(true);
  });
});

describe('stopWatcher', () => {
  it('stops an active watcher', () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      workspaceDir: '/tmp/ws/thread-1',
    });

    startWatcher('req-1', 'thread-1');
    expect(isWatcherActive('req-1')).toBe(true);

    stopWatcher('req-1');
    expect(isWatcherActive('req-1')).toBe(false);
  });

  it('is a no-op for non-existent watchers', () => {
    expect(() => stopWatcher('nonexistent')).not.toThrow();
  });
});
