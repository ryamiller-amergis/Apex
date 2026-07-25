/**
 * Unit tests for loadTestAiGenerationService (FEAT-011 TBI-011)
 *
 * Coverage:
 *   DoD-1 / VT-01: happy parse → ready with script + suggested_thresholds
 *   DoD-2 / VT-03: NO_REPO_CONNECTED when skillRepo empty/missing; createThread NOT called
 *   VT-04: failed when idle without output
 *   VT-05: missing script → not ready (failed)
 *   VT-09: cancel → cancelled status
 *   Secret heuristic rejects obvious plaintext secrets
 */

import fs from 'fs';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      chatThreads: { findFirst: jest.fn() },
    },
  },
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  cancelRun: jest.fn(),
  isThreadIdle: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

import { db } from '../db/drizzle';
import { createThread, cancelRun, isThreadIdle } from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import {
  startGeneration,
  getGenerationResult,
  cancelGeneration,
  containsPlaintextSecret,
  DEFAULT_K6_GENERATION_SKILL_PATH,
} from '../services/loadTestAiGenerationService';
import { LoadTestAiGenerationError } from '../../shared/types/loadTestAi';

const mockedDb = db as any;
const mockedCreateThread = createThread as jest.MockedFunction<typeof createThread>;
const mockedCancelRun = cancelRun as jest.MockedFunction<typeof cancelRun>;
const mockedIsThreadIdle = isThreadIdle as jest.MockedFunction<typeof isThreadIdle>;
const mockedResolveSkillConfig = resolveSkillConfig as jest.MockedFunction<typeof resolveSkillConfig>;
const mockedGetDefaultModel = getDefaultModel as jest.MockedFunction<typeof getDefaultModel>;

const PROJECT_ID = 'Apex';
const USER_ID = 'user-1';
const THREAD_ID = 'thread-1';

const FAKE_SKILL_CONFIG = {
  id: 'cfg-1',
  project: PROJECT_ID,
  skillRepo: 'org/repo',
  skillBranch: 'main',
  skillProvider: 'github' as const,
  friendlyName: 'Default',
  isDefault: true,
  loadTestGenerationSkillPath: '.cursor/skills/k6-load-test-generation/SKILL.md',
  loadTestGenerationModel: 'claude-sonnet-4',
  developmentModel: 'claude-opus-4',
  defaultModel: 'claude-sonnet-4',
};

const REQUEST_BODY = {
  requirementRef: { kind: 'ado_work_item' as const, id: '100' },
  flowHints: 'login then browse',
  loadProfileCaps: { vus: 50, durationMinutes: 5 },
};

function fakeThread(id: string, workspaceDir: string) {
  return {
    id,
    userId: USER_ID,
    kickoff: {} as any,
    messages: [],
    status: 'idle' as const,
    workspaceDir,
    flagged: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetDefaultModel.mockResolvedValue('claude-sonnet-4');
});

// ── startGeneration ────────────────────────────────────────────────────────────

describe('startGeneration', () => {
  it('DoD-2 / VT-03: throws NO_REPO_CONNECTED when skillRepo is missing and does not create a thread', async () => {
    mockedResolveSkillConfig.mockResolvedValue({ ...FAKE_SKILL_CONFIG, skillRepo: '' } as any);

    await expect(startGeneration(PROJECT_ID, REQUEST_BODY, USER_ID)).rejects.toMatchObject({
      code: 'NO_REPO_CONNECTED',
    });
    expect(mockedCreateThread).not.toHaveBeenCalled();
  });

  it('DoD-2 / VT-03: throws NO_REPO_CONNECTED when no skill config resolves at all', async () => {
    mockedResolveSkillConfig.mockResolvedValue(null);

    await expect(startGeneration(PROJECT_ID, REQUEST_BODY, USER_ID)).rejects.toMatchObject({
      code: 'NO_REPO_CONNECTED',
    });
    expect(mockedCreateThread).not.toHaveBeenCalled();
  });

  it('creates a chat thread with the resolved skill path, model, and freeform context', async () => {
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedCreateThread.mockResolvedValue(fakeThread(THREAD_ID, '/tmp/ws/thread-1'));

    const result = await startGeneration(PROJECT_ID, REQUEST_BODY, USER_ID);

    expect(result).toEqual({ threadId: THREAD_ID });
    expect(mockedCreateThread).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      project: PROJECT_ID,
      repo: 'org/repo',
      branch: 'main',
      skillProvider: 'github',
      skillPath: FAKE_SKILL_CONFIG.loadTestGenerationSkillPath,
      model: FAKE_SKILL_CONFIG.loadTestGenerationModel,
      freeformContext: expect.stringContaining('login then browse'),
    }));
    // Never leak secret values into freeform context — sanity check requirementRef is present instead.
    expect(mockedCreateThread.mock.calls[0][1].freeformContext).toContain(PROJECT_ID);
  });

  it('falls back to developmentModel then the global default model when loadTestGenerationModel is unset', async () => {
    mockedResolveSkillConfig.mockResolvedValue({
      ...FAKE_SKILL_CONFIG,
      loadTestGenerationModel: null,
    } as any);
    mockedCreateThread.mockResolvedValue(fakeThread(THREAD_ID, '/tmp/ws/thread-1'));

    await startGeneration(PROJECT_ID, REQUEST_BODY, USER_ID);

    expect(mockedCreateThread).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      model: FAKE_SKILL_CONFIG.developmentModel,
    }));
  });

  it('falls back to the default skill path when loadTestGenerationSkillPath is unset', async () => {
    mockedResolveSkillConfig.mockResolvedValue({
      ...FAKE_SKILL_CONFIG,
      loadTestGenerationSkillPath: null,
    } as any);
    mockedCreateThread.mockResolvedValue(fakeThread(THREAD_ID, '/tmp/ws/thread-1'));

    await startGeneration(PROJECT_ID, REQUEST_BODY, USER_ID);

    expect(mockedCreateThread).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      skillPath: DEFAULT_K6_GENERATION_SKILL_PATH,
    }));
  });

  it('throws a validation error when requirementRef is missing', async () => {
    await expect(
      startGeneration(PROJECT_ID, { ...REQUEST_BODY, requirementRef: undefined as any }, USER_ID),
    ).rejects.toThrow(LoadTestAiGenerationError);
    expect(mockedResolveSkillConfig).not.toHaveBeenCalled();
    expect(mockedCreateThread).not.toHaveBeenCalled();
  });
});

// ── getGenerationResult ────────────────────────────────────────────────────────

describe('getGenerationResult', () => {
  it('DoD-1 / VT-01: returns ready with script + suggested_thresholds on happy parse', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws/thread-1',
      status: 'idle',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      script: "import http from 'k6/http';\nexport default function() { http.get('https://example-target.invalid'); }",
      suggested_thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
      notes: 'Synthetic target used.',
    }));

    const result = await getGenerationResult(THREAD_ID, USER_ID);

    expect(result.status).toBe('ready');
    expect(result.result?.script).toContain('http.get');
    expect(result.result?.suggested_thresholds).toEqual([
      { metric: 'http_req_duration', expression: 'p(95)<500' },
    ]);
  });

  it('VT-04: returns failed when the thread is idle without output', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws/thread-1',
      status: 'idle',
    });
    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(true);

    const result = await getGenerationResult(THREAD_ID, USER_ID);

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });

  it('returns pending when no output exists yet and the agent is still running', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws/thread-1',
      status: 'running',
    });
    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(false);

    const result = await getGenerationResult(THREAD_ID, USER_ID);

    expect(result.status).toBe('pending');
  });

  it('VT-05: returns failed when output is missing a script', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws/thread-1',
      status: 'idle',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      suggested_thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
    }));

    const result = await getGenerationResult(THREAD_ID, USER_ID);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/script/i);
  });

  it('rejects output containing an obvious plaintext bearer token', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws/thread-1',
      status: 'idle',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({
      script: "const headers = { Authorization: 'Bearer sk-live-abcdef1234567890ABCDEF' };",
      suggested_thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
    }));

    const result = await getGenerationResult(THREAD_ID, USER_ID);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/secret/i);
  });

  it('throws THREAD_NOT_FOUND when the thread does not belong to the requesting user', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: 'someone-else',
      workspaceDir: '/tmp/ws/thread-1',
      status: 'idle',
    });

    await expect(getGenerationResult(THREAD_ID, USER_ID)).rejects.toMatchObject({
      code: 'THREAD_NOT_FOUND',
    });
  });

  it('throws THREAD_NOT_FOUND when the thread does not exist', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue(undefined);

    await expect(getGenerationResult(THREAD_ID, USER_ID)).rejects.toMatchObject({
      code: 'THREAD_NOT_FOUND',
    });
  });
});

// ── cancelGeneration ───────────────────────────────────────────────────────────

describe('cancelGeneration', () => {
  it('VT-09: cancels the run and returns cancelled status, then reflects it on getGenerationResult', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws/thread-1',
      status: 'running',
    });
    mockedCancelRun.mockResolvedValue(undefined);

    const cancelResult = await cancelGeneration(THREAD_ID, USER_ID);
    expect(cancelResult.status).toBe('cancelled');
    expect(mockedCancelRun).toHaveBeenCalledWith(THREAD_ID);

    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(true);
    const followupResult = await getGenerationResult(THREAD_ID, USER_ID);
    expect(followupResult.status).toBe('cancelled');
  });

  it('throws THREAD_NOT_FOUND when cancelling a thread owned by another user', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: 'someone-else',
      workspaceDir: '/tmp/ws/thread-1',
      status: 'running',
    });

    await expect(cancelGeneration(THREAD_ID, USER_ID)).rejects.toMatchObject({
      code: 'THREAD_NOT_FOUND',
    });
    expect(mockedCancelRun).not.toHaveBeenCalled();
  });
});

// ── containsPlaintextSecret heuristic ──────────────────────────────────────────

describe('containsPlaintextSecret', () => {
  it('flags obvious bearer tokens', () => {
    expect(containsPlaintextSecret("Authorization: 'Bearer sk-live-abcdef1234567890ABCDEF'")).toBe(true);
  });

  it('flags AWS-style access key ids', () => {
    expect(containsPlaintextSecret('const key = "AKIAABCDEFGHIJKLMNOP";')).toBe(true);
  });

  it('flags GitHub personal access tokens', () => {
    expect(containsPlaintextSecret('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
  });

  it('does not flag env-var placeholders', () => {
    expect(containsPlaintextSecret("headers: { Authorization: `Bearer ${__ENV.AUTH_TOKEN}` }")).toBe(false);
  });

  it('does not flag ordinary script content', () => {
    expect(containsPlaintextSecret("http.get('https://example-target.invalid/api/resource');")).toBe(false);
  });
});
