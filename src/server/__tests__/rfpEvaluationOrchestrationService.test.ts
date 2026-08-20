import fs from 'fs';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      rfpRequests: { findFirst: jest.fn(), findMany: jest.fn() },
      chatThreads: { findFirst: jest.fn() },
    },
  },
}));

jest.mock('../services/chatAgentService', () => ({
  isThreadIdle: jest.fn(),
  hydrateThread: jest.fn(),
  createThread: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

jest.mock('../services/rfpIntakeService', () => ({
  APEX_PROJECT: 'Apex',
  getRequestById: jest.fn(),
  markEvaluationFailedIfEvaluating: jest.fn(),
  persistSuccessfulEvaluation: jest.fn(),
  setEvaluationThread: jest.fn(),
}));

import { db } from '../db/drizzle';
import { createThread, hydrateThread, isThreadIdle } from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import {
  getRequestById,
  markEvaluationFailedIfEvaluating,
  persistSuccessfulEvaluation,
  setEvaluationThread,
} from '../services/rfpIntakeService';
import {
  autoStartEvaluation,
  isWatcherActive,
  recoverEvaluatingRfps,
  startWatcher,
  stopWatcher,
} from '../services/rfpEvaluationOrchestrationService';
import type { ProductIntakeEvaluationOutput, RfpRequest } from '../../shared/types/rfpIntake';

const mockedDb = db as any;
const mockedCreateThread = createThread as jest.MockedFunction<typeof createThread>;
const mockedHydrateThread = hydrateThread as jest.MockedFunction<typeof hydrateThread>;
const mockedIsThreadIdle = isThreadIdle as jest.MockedFunction<typeof isThreadIdle>;
const mockedResolveSkillConfig = resolveSkillConfig as jest.MockedFunction<typeof resolveSkillConfig>;
const mockedGetDefaultModel = getDefaultModel as jest.MockedFunction<typeof getDefaultModel>;
const mockedGetRequest = getRequestById as jest.MockedFunction<typeof getRequestById>;
const mockedMarkFailed = markEvaluationFailedIfEvaluating as jest.MockedFunction<typeof markEvaluationFailedIfEvaluating>;
const mockedPersist = persistSuccessfulEvaluation as jest.MockedFunction<typeof persistSuccessfulEvaluation>;
const mockedSetThread = setEvaluationThread as jest.MockedFunction<typeof setEvaluationThread>;

const VALID_OUTPUT: ProductIntakeEvaluationOutput = {
  verdict: 'build',
  confidence: 'high',
  techVelocity: 'stable',
  nativeBenefit: 'high',
  audience: 'internal',
  dataLeavesTenant: false,
  priority: 'high',
  risk: 'low',
  deliveryApproach: 'full-code',
  recommendedLane: 'platform-feature',
  recommendedTooling: ['Apex'],
  hostingRecommendation: 'azure-existing',
  operationalOwner: 'Apex platform team',
  reuseOpportunity: 'none',
  entersInterviewFlow: false,
  buildBuyRentSummary: 'Build it in Apex because it multiplies existing governance.',
  rationale: 'Stable CRUD with high native benefit; keep data in tenant.',
  existingOverlap: 'none',
  clarifyingQuestions: [],
};

const FAKE_REQUEST: RfpRequest = {
  id: 'rfp-1',
  ownerId: 'owner-1',
  title: 'Internal intake tracker',
  stakeholder: 'BA team',
  request: 'Track RFPs in Apex',
  problem: 'Intake is fragmented',
  audience: 'internal',
  dataSensitivity: 'internal-only',
  existingSolution: 'none known',
  advantage: null,
  constraints: null,
  requestType: null,
  existingSystemStack: null,
  status: 'evaluating',
  aiStatus: 'evaluating',
  aiThreadId: null,
  sourceProject: 'Apex',
  currentEvaluationId: null,
  clarificationUsed: false,
  createdAt: '2026-08-19T12:00:00.000Z',
  updatedAt: '2026-08-19T12:00:00.000Z',
};

const FAKE_SKILL_CONFIG = {
  id: 'cfg-1',
  project: 'Apex',
  skillRepo: 'org/repo',
  skillBranch: 'main',
  skillProvider: 'github' as const,
  friendlyName: 'Default',
  isDefault: true,
  productIntakeEvaluationSkillPath: '.cursor/skills/product-intake-evaluation/SKILL.md',
  productIntakeEvaluationModel: 'claude-sonnet-4',
  defaultModel: 'claude-sonnet-4',
};

const FAKE_THREAD = {
  id: 'thread-1',
  userId: 'system',
  kickoff: {} as any,
  messages: [],
  status: 'idle' as const,
  workspaceDir: '/tmp/ws/thread-1',
  flagged: false,
  createdAt: '2026-08-19T12:00:00.000Z',
  lastActivityAt: '2026-08-19T12:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockedGetDefaultModel.mockResolvedValue('claude-sonnet-4');
  mockedMarkFailed.mockResolvedValue(true);
  mockedPersist.mockResolvedValue({
    ...VALID_OUTPUT,
    id: 'eval-1',
    rfpRequestId: 'rfp-1',
    version: 1,
    rawOutput: VALID_OUTPUT,
    committedProductBadge: false,
    createdAt: '2026-08-19T12:00:00.000Z',
  });
  mockedSetThread.mockResolvedValue(undefined);
});

afterEach(() => {
  stopWatcher('rfp-1');
  jest.useRealTimers();
});

describe('autoStartEvaluation TBI-002', () => {
  it('creates a system-owned thread with structured intake when skill config exists', async () => {
    mockedGetRequest.mockResolvedValue(FAKE_REQUEST);
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedCreateThread.mockResolvedValue(FAKE_THREAD as any);

    await autoStartEvaluation('rfp-1');

    expect(mockedCreateThread).toHaveBeenCalledWith('system', expect.objectContaining({
      project: 'Apex',
      skillPath: FAKE_SKILL_CONFIG.productIntakeEvaluationSkillPath,
      model: 'claude-sonnet-4',
      freeformContext: expect.stringContaining('Track RFPs in Apex'),
    }));
    expect(mockedSetThread).toHaveBeenCalledWith('rfp-1', 'thread-1');
    expect(isWatcherActive('rfp-1')).toBe(true);
  });

  it('marks failed without a thread when productIntakeEvaluationSkillPath is missing', async () => {
    mockedGetRequest.mockResolvedValue(FAKE_REQUEST);
    mockedResolveSkillConfig.mockResolvedValue({
      ...FAKE_SKILL_CONFIG,
      productIntakeEvaluationSkillPath: null,
    } as any);

    await autoStartEvaluation('rfp-1');

    expect(mockedCreateThread).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith('rfp-1');
  });
});

describe('PBI-001 startWatcher', () => {
  it('VT-03 / AC-0 persists a versioned Evaluation on valid output', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir: '/tmp/ws/thread-1' });
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ aiThreadId: 'thread-1' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(VALID_OUTPUT));
    mockFs.rmSync.mockImplementation(() => {});

    startWatcher('rfp-1', 'thread-1');
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockedPersist).toHaveBeenCalledWith('rfp-1', VALID_OUTPUT);
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(isWatcherActive('rfp-1')).toBe(false);
  });

  it('VT-04 / AC-1 fails with no version when output is missing, malformed, idle, or timed out', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir: '/tmp/ws/thread-1' });
    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(true);

    startWatcher('rfp-1', 'thread-1');
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockedMarkFailed).toHaveBeenCalledWith('rfp-1');
    expect(mockedPersist).not.toHaveBeenCalled();

    stopWatcher('rfp-1');
    mockedMarkFailed.mockClear();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ verdict: 'nope' }));
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ aiThreadId: 'thread-1' });
    startWatcher('rfp-1', 'thread-1');
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockedMarkFailed).toHaveBeenCalledWith('rfp-1');
    expect(mockedPersist).not.toHaveBeenCalled();
  });

  it('VT-04 times out after the 10-minute watcher ceiling without creating a version', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir: '/tmp/ws/thread-1' });
    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(false);

    startWatcher('rfp-1', 'thread-1');
    for (let i = 0; i < 122; i += 1) {
      await jest.advanceTimersByTimeAsync(5_000);
    }

    expect(mockedMarkFailed).toHaveBeenCalledWith('rfp-1');
    expect(mockedPersist).not.toHaveBeenCalled();
    expect(isWatcherActive('rfp-1')).toBe(false);
  });

  it('VT-05 / AC-2 stores the next sequential version when a prior Evaluation exists', async () => {
    mockedPersist.mockResolvedValue({
      ...VALID_OUTPUT,
      id: 'eval-2',
      rfpRequestId: 'rfp-1',
      version: 2,
      rawOutput: VALID_OUTPUT,
      committedProductBadge: false,
      createdAt: '2026-08-19T12:00:00.000Z',
    });
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir: '/tmp/ws/thread-1' });
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ aiThreadId: 'thread-1' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(VALID_OUTPUT));
    mockFs.rmSync.mockImplementation(() => {});

    startWatcher('rfp-1', 'thread-1');
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockedPersist).toHaveBeenCalledWith('rfp-1', VALID_OUTPUT);
    await expect(mockedPersist.mock.results[0].value).resolves.toMatchObject({ version: 2 });
  });

  it('VT-06 / AC-3 discards stale thread output without changing the request or creating a version', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir: '/tmp/ws/thread-1' });
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ aiThreadId: 'thread-NEW' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(VALID_OUTPUT));
    mockFs.rmSync.mockImplementation(() => {});

    startWatcher('rfp-1', 'thread-1');
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockedPersist).not.toHaveBeenCalled();
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(mockFs.rmSync).toHaveBeenCalled();
    expect(isWatcherActive('rfp-1')).toBe(false);
  });
});

describe('recoverEvaluatingRfps TBI-002 VT-11', () => {
  it('restarts the watcher when output already exists without overwriting a sibling success', async () => {
    mockedDb.query.rfpRequests.findMany.mockResolvedValue([
      { id: 'rfp-1', aiThreadId: 'thread-1' },
    ]);
    mockedHydrateThread.mockResolvedValue(true);
    mockedIsThreadIdle.mockReturnValue(true);
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir: '/tmp/ws/thread-1' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(VALID_OUTPUT));

    const recovered = await recoverEvaluatingRfps();

    expect(recovered).toBe(1);
    expect(mockedCreateThread).not.toHaveBeenCalled();
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(isWatcherActive('rfp-1')).toBe(true);
  });

  it('re-kicks a dead idle thread that has no output', async () => {
    mockedDb.query.rfpRequests.findMany.mockResolvedValue([
      { id: 'rfp-1', aiThreadId: 'thread-dead' },
    ]);
    mockedHydrateThread.mockResolvedValue(true);
    mockedIsThreadIdle.mockReturnValue(true);
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({ workspaceDir: '/tmp/ws/thread-dead' });
    mockFs.existsSync.mockReturnValue(false);
    mockedGetRequest.mockResolvedValue(FAKE_REQUEST);
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedCreateThread.mockResolvedValue({ ...FAKE_THREAD, id: 'thread-fresh' } as any);

    const recovered = await recoverEvaluatingRfps();

    expect(recovered).toBe(1);
    expect(mockedCreateThread).toHaveBeenCalled();
  });

  it('marks failed when the evaluation thread cannot be hydrated and does not clobber via unguarded writes', async () => {
    mockedDb.query.rfpRequests.findMany.mockResolvedValue([
      { id: 'rfp-1', aiThreadId: 'thread-missing' },
    ]);
    mockedHydrateThread.mockResolvedValue(false);

    const recovered = await recoverEvaluatingRfps();

    expect(recovered).toBe(1);
    expect(mockedMarkFailed).toHaveBeenCalledWith('rfp-1');
    expect(mockedCreateThread).not.toHaveBeenCalled();
    expect(mockedPersist).not.toHaveBeenCalled();
  });
});
