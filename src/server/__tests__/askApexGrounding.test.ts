jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  mkdirSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  rmSync: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  listSkillConfigs: jest.fn().mockResolvedValue([
    {
      project: 'Apex',
      skillProvider: 'github',
      skillRepo: 'ASM/AI-Pilot',
      skillBranch: 'main',
      isDefault: true,
    },
  ]),
}));

let nextUuid = 0;
jest.mock('uuid', () => ({
  v4: jest.fn(() => `ask-${++nextUuid}`),
}));

const agentCreate = jest.fn();
jest.mock('@cursor/sdk', () => ({
  Agent: { create: agentCreate },
}));

jest.mock('../utils/retry', () => ({
  retryWithBackoff: jest.fn((operation: () => Promise<unknown>) => operation()),
}));
jest.mock('../services/aiUsageService', () => ({
  recordAiUsage: jest.fn(),
  estimateTokens: jest.fn().mockReturnValue(0),
}));
const mockLocalReadFile = jest.fn().mockResolvedValue('pinned local context');
jest.mock('fs/promises', () => ({
  readFile: mockLocalReadFile,
}));
const mockRemoteGetSkillFile = jest.fn().mockResolvedValue('remote context');
jest.mock('../services/skillCatalogGitHub', () => ({
  getSkillFile: mockRemoteGetSkillFile,
}));

const release = jest.fn().mockResolvedValue(undefined);
const start = jest.fn().mockResolvedValue({
  mode: 'local',
  cwd: 'C:\\data\\grounding-workspaces\\ask-profile',
  profileId: 'opaque-profile',
  release,
});
jest.mock('../services/callerGroundingService', () => ({
  callerGroundingService: { start },
}));

import fs from 'fs';
import {
  closeSession,
  createSession,
  getSession,
  sendMessage,
} from '../services/askApexService';

describe('PBI-005 Ask Apex shared grounding lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.CURSOR_API_KEY = 'test-key';
    agentCreate.mockResolvedValue({
      send: jest.fn().mockResolvedValue({
        supports: jest.fn().mockReturnValue(false),
      }),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.CURSOR_API_KEY;
  });

  it('AC-0 / VT-06 uses the shared profile checkout and cleanup without private temp files', async () => {
    // Arrange
    const sessionId = createSession('developer-1');

    // Act
    await sendMessage(sessionId, 'developer-1', 'How do interviews work?');
    const closed = closeSession(sessionId, 'developer-1');
    await Promise.resolve();

    // Assert
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      caller: 'ask-apex',
      userId: 'developer-1',
      run: {
        runType: 'service',
        runId: sessionId,
        project: 'Apex',
      },
      repository: {
        provider: 'github',
        repo: 'AI-Pilot',
        branch: 'main',
      },
    }));
    expect(agentCreate).toHaveBeenCalledWith(expect.objectContaining({
      local: { cwd: 'C:\\data\\grounding-workspaces\\ask-profile' },
      mcpServers: {
        'github-repo': {
          url: 'http://localhost:3001/mcp/github-repo/grounding/opaque-profile',
        },
      },
    }));
    expect(mockLocalReadFile).toHaveBeenCalledTimes(5);
    expect(mockRemoteGetSkillFile).not.toHaveBeenCalled();
    expect(closed).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('AC-2 reschedules idle cleanup while a turn is streaming', async () => {
    // Arrange
    let finishTurn: (() => void) | undefined;
    const pendingTurn = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    agentCreate.mockResolvedValue({
      send: jest.fn().mockImplementation(async () => {
        await pendingTurn;
        return { supports: jest.fn().mockReturnValue(false) };
      }),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
    });
    const sessionId = createSession('developer-1');

    // Act
    const sending = sendMessage(sessionId, 'developer-1', 'Explain grounding');
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

    // Assert
    expect(getSession(sessionId, 'developer-1')).not.toBeNull();
    expect(release).not.toHaveBeenCalled();

    finishTurn?.();
    await sending;
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    await Promise.resolve();
    expect(getSession(sessionId, 'developer-1')).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('AC-2 / VT-03 marks grounding inactive once on idle without deleting checkout or bundle', async () => {
    // Given an Ask Apex session has completed a local grounded turn.
    const sessionId = createSession('developer-1');
    await sendMessage(sessionId, 'developer-1', 'Explain repository grounding');
    expect(getSession(sessionId, 'developer-1')).not.toBeNull();

    // When the shared idle timeout elapses more than once.
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    await Promise.resolve();

    // Then cleanup releases/marks inactive once and never deletes durable artifacts.
    expect(getSession(sessionId, 'developer-1')).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('AC-1 preserves remote catalog context loading for remote fallback', async () => {
    // Arrange
    start.mockResolvedValueOnce({
      mode: 'remote',
      release: jest.fn().mockResolvedValue(undefined),
    });
    const sessionId = createSession('developer-1');

    // Act
    await sendMessage(sessionId, 'developer-1', 'What shipped recently?');

    // Assert
    expect(mockLocalReadFile).not.toHaveBeenCalled();
    expect(mockRemoteGetSkillFile).toHaveBeenCalledTimes(5);
    expect(agentCreate).toHaveBeenCalledWith(expect.objectContaining({
      local: { cwd: process.cwd() },
      mcpServers: {
        'github-repo': {
          url: 'http://localhost:3001/mcp/github-repo',
        },
      },
    }));
  });
});
