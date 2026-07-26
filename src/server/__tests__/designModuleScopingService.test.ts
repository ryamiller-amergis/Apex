/**
 * Unit tests for designModuleScopingService
 */

import fs from 'fs';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      chatThreads: { findFirst: jest.fn() },
      designModules: { findFirst: jest.fn() },
    },
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([]),
      })),
    })),
  },
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  cancelRun: jest.fn(),
  isThreadIdle: jest.fn(),
  sendMessage: jest.fn().mockResolvedValue(undefined),
  updateThreadKickoffContext: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

import { db } from '../db/drizzle';
import {
  createThread,
  cancelRun,
  isThreadIdle,
  sendMessage,
  updateThreadKickoffContext,
} from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import {
  startScoping,
  getScopingResult,
  cancelScoping,
  parseScopingResult,
  DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH,
} from '../services/designModuleScopingService';

const mockedDb = db as any;
const mockedCreateThread = createThread as jest.MockedFunction<typeof createThread>;
const mockedCancelRun = cancelRun as jest.MockedFunction<typeof cancelRun>;
const mockedIsThreadIdle = isThreadIdle as jest.MockedFunction<typeof isThreadIdle>;
const mockedSendMessage = sendMessage as jest.MockedFunction<typeof sendMessage>;
const mockedUpdateKickoff = updateThreadKickoffContext as jest.MockedFunction<
  typeof updateThreadKickoffContext
>;
const mockedResolveSkillConfig = resolveSkillConfig as jest.MockedFunction<
  typeof resolveSkillConfig
>;
const mockedGetDefaultModel = getDefaultModel as jest.MockedFunction<
  typeof getDefaultModel
>;

const LOCAL_SKILL = `# Design Module Scoping\n\nWrite module-scoping.json.\n`;

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
  designDocModel: 'claude-sonnet-4',
  defaultModel: 'claude-sonnet-4',
};

const REQUEST = {
  project: PROJECT_ID,
  name: 'Load Testing',
  description: 'k6 authoring and runs',
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

beforeEach(async () => {
  jest.clearAllMocks();
  mockedSendMessage.mockResolvedValue(undefined as never);
  mockedGetDefaultModel.mockResolvedValue('claude-sonnet-4');
  mockedDb.query.designModules.findFirst.mockResolvedValue(null);
  mockFs.existsSync.mockImplementation((p) =>
    String(p).replace(/\\/g, '/').endsWith(DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH)
  );
  mockFs.readFileSync.mockImplementation((p) => {
    if (String(p).replace(/\\/g, '/').endsWith(DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH)) {
      return LOCAL_SKILL;
    }
    return '';
  });
  mockFs.mkdirSync.mockReturnValue(undefined as never);
  mockFs.writeFileSync.mockReturnValue(undefined as never);
  // Drain prior trackScopingSend().finally() handlers so in-flight set is clean.
  await Promise.resolve();
  await Promise.resolve();
});

describe('parseScopingResult', () => {
  it('parses a valid module-scoping.json payload', () => {
    const result = parseScopingResult(
      JSON.stringify({
        globs: [
          {
            pattern: 'src/server/services/loadTest*.ts',
            confidence: 'high',
            rationale: 'Primary services',
          },
        ],
        notes: 'Looks good',
      })
    );
    expect(result).toEqual({
      globs: [
        {
          pattern: 'src/server/services/loadTest*.ts',
          confidence: 'high',
          rationale: 'Primary services',
        },
      ],
      notes: 'Looks good',
    });
  });

  it('rejects absolute or parent-escaping patterns', () => {
    expect(() =>
      parseScopingResult(
        JSON.stringify({
          globs: [
            {
              pattern: '../secret.ts',
              confidence: 'high',
              rationale: 'bad',
            },
          ],
        })
      )
    ).toThrow('stay within the repository');
  });

  it('rejects missing globs', () => {
    expect(() => parseScopingResult(JSON.stringify({ globs: [] }))).toThrow(
      'missing globs'
    );
  });

  it('rejects invalid confidence', () => {
    expect(() =>
      parseScopingResult(
        JSON.stringify({
          globs: [
            {
              pattern: 'src/a.ts',
              confidence: 'maybe',
              rationale: 'x',
            },
          ],
        })
      )
    ).toThrow('invalid confidence');
  });
});

describe('startScoping', () => {
  it('throws NO_REPO_CONNECTED when skillRepo is missing', async () => {
    mockedResolveSkillConfig.mockResolvedValue({
      ...FAKE_SKILL_CONFIG,
      skillRepo: '',
    } as any);

    await expect(startScoping(PROJECT_ID, REQUEST, USER_ID)).rejects.toMatchObject({
      code: 'NO_REPO_CONNECTED',
    });
    expect(mockedCreateThread).not.toHaveBeenCalled();
  });

  it('creates a thread with the scoping skill when no prior thread exists', async () => {
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedCreateThread.mockResolvedValue(fakeThread(THREAD_ID, '/tmp/ws'));

    const result = await startScoping(PROJECT_ID, REQUEST, USER_ID);

    expect(result).toEqual({ threadId: THREAD_ID });
    expect(mockedCreateThread).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        project: PROJECT_ID,
        repo: 'org/repo',
        skillPath: DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH,
        freeformContext: expect.stringContaining('Load Testing'),
      }),
      expect.objectContaining({ skipAutoKickoff: true })
    );
    expect(mockedCreateThread.mock.calls[0][1].freeformContext).toContain(
      'Design Module Scoping skill'
    );
    expect(mockedCreateThread.mock.calls[0][1].freeformContext).toContain(
      'Connected repo: org/repo'
    );
    expect(mockedSendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.stringContaining('module-scoping.json'),
      undefined,
      [],
      expect.objectContaining({ hidden: true })
    );
  });

  it('includes searchHints in freeform kickoff context', async () => {
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedCreateThread.mockResolvedValue(fakeThread(THREAD_ID, '/tmp/ws'));

    await startScoping(
      PROJECT_ID,
      {
        ...REQUEST,
        searchHints: 'LoadTest* components; exclude e2e specs',
      },
      USER_ID
    );

    const freeform = mockedCreateThread.mock.calls[0][1].freeformContext as string;
    expect(freeform).toContain('Search hints (what to look for in the connected repo):');
    expect(freeform).toContain('LoadTest* components; exclude e2e specs');
  });

  it('omits searchHints section when hints are blank', async () => {
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedCreateThread.mockResolvedValue(fakeThread(THREAD_ID, '/tmp/ws'));

    await startScoping(
      PROJECT_ID,
      { ...REQUEST, searchHints: '   ' },
      USER_ID
    );

    const freeform = mockedCreateThread.mock.calls[0][1].freeformContext as string;
    expect(freeform).not.toContain('Search hints (what to look for in the connected repo):');
  });

  it('does not resume on a fresh suggest even when a prior thread exists', async () => {
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedCreateThread.mockResolvedValue(fakeThread('thread-new', '/tmp/ws2'));
    mockedDb.query.designModules.findFirst.mockResolvedValue({
      scopingThreadId: THREAD_ID,
    });

    const result = await startScoping(
      PROJECT_ID,
      { ...REQUEST, moduleSlug: 'load-testing', threadId: THREAD_ID },
      USER_ID
    );

    expect(result).toEqual({ threadId: 'thread-new' });
    expect(mockedCreateThread).toHaveBeenCalled();
    expect(mockedUpdateKickoff).not.toHaveBeenCalled();
  });

  it('resumes an existing thread via sendMessage', async () => {
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedDb.query.designModules.findFirst.mockResolvedValue({
      scopingThreadId: THREAD_ID,
    });
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws',
      status: 'idle',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.unlinkSync.mockReturnValue(undefined as never);

    const result = await startScoping(
      PROJECT_ID,
      {
        ...REQUEST,
        moduleSlug: 'load-testing',
        instruction: 'Exclude test files',
        currentGlobs: ['src/**/LoadTest*.tsx'],
      },
      USER_ID
    );

    expect(result).toEqual({ threadId: THREAD_ID });
    expect(mockedCreateThread).not.toHaveBeenCalled();
    expect(mockedUpdateKickoff).toHaveBeenCalledWith(
      THREAD_ID,
      expect.stringContaining('Exclude test files')
    );
    expect(mockedSendMessage).toHaveBeenCalledWith(
      THREAD_ID,
      expect.stringContaining('Exclude test files')
    );
  });
});

describe('getScopingResult / cancelScoping', () => {
  it('returns ready when output parses', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws',
      status: 'idle',
    });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        globs: [
          {
            pattern: 'src/a.ts',
            confidence: 'medium',
            rationale: 'core',
          },
        ],
      }) as any
    );

    await expect(getScopingResult(THREAD_ID, USER_ID)).resolves.toEqual({
      status: 'ready',
      result: {
        globs: [
          {
            pattern: 'src/a.ts',
            confidence: 'medium',
            rationale: 'core',
          },
        ],
        notes: undefined,
      },
    });
  });

  it('returns failed when idle without output', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws',
      status: 'idle',
    });
    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(true);

    await expect(getScopingResult(THREAD_ID, USER_ID)).resolves.toEqual({
      status: 'failed',
      error: 'Agent completed without producing a scoping proposal.',
    });
  });

  it('stays pending while kickoff is in flight even if thread looks idle', async () => {
    let resolveSend!: () => void;
    mockedSendMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }) as never
    );
    mockedResolveSkillConfig.mockResolvedValue(FAKE_SKILL_CONFIG as any);
    mockedCreateThread.mockResolvedValue(fakeThread(THREAD_ID, '/tmp/ws'));

    await startScoping(PROJECT_ID, REQUEST, USER_ID);

    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws',
      status: 'idle',
    });
    mockFs.existsSync.mockReturnValue(false);
    mockedIsThreadIdle.mockReturnValue(true);

    await expect(getScopingResult(THREAD_ID, USER_ID)).resolves.toEqual({
      status: 'pending',
    });

    resolveSend();
    await Promise.resolve();
    await Promise.resolve();

    await expect(getScopingResult(THREAD_ID, USER_ID)).resolves.toEqual({
      status: 'failed',
      error: 'Agent completed without producing a scoping proposal.',
    });
  });

  it('cancels a running scoping thread', async () => {
    mockedDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: USER_ID,
      workspaceDir: '/tmp/ws',
      status: 'running',
    });
    mockedCancelRun.mockResolvedValue(undefined as never);

    await expect(cancelScoping(THREAD_ID, USER_ID)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(mockedCancelRun).toHaveBeenCalledWith(THREAD_ID);
    await expect(getScopingResult(THREAD_ID, USER_ID)).resolves.toEqual({
      status: 'cancelled',
    });
  });
});
