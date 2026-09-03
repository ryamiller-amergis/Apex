jest.mock('../services/repoCacheService', () => ({
  resolveGitRemote: jest.fn((provider: string, project: string, repo: string) => {
    if (provider === 'github') {
      return { url: `https://github.com/${repo}.git`, env: {}, secret: 'gh-token' };
    }
    return {
      url: `https://dev.azure.com/amergis/${project}/_git/${repo}`,
      env: {},
      secret: 'ado-pat',
    };
  }),
}));

const mockMintCursorUserSubToken = jest.fn();
const mockFetchCursorApiKeyInfo = jest.fn();

jest.mock('../services/cursorSubTokenService', () => ({
  mintCursorUserSubToken: (...args: unknown[]) => mockMintCursorUserSubToken(...args),
  fetchCursorApiKeyInfo: (...args: unknown[]) => mockFetchCursorApiKeyInfo(...args),
}));

jest.mock('@cursor/sdk', () => ({
  Agent: {
    create: jest.fn(),
    getRun: jest.fn(),
    cancelRun: jest.fn(),
  },
}));

import { Agent } from '@cursor/sdk';
import {
  buildCloudRepoUrl,
  launchCloudAgent,
  resolveLaunchApiKey,
  toCloudRepoUrl,
} from '../services/cursorCloudAgentClient';

describe('cursorCloudAgentClient', () => {
  const previousKey = process.env.CURSOR_API_KEY;
  const previousOverride = process.env.OTHER_CURSOR_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CURSOR_API_KEY = 'test-cursor-key';
    mockMintCursorUserSubToken.mockResolvedValue({
      accessToken: 'user-scoped-token',
      expiresAt: '2026-09-03T15:00:00.000Z',
      userId: 42,
      teamId: 7,
    });
    mockFetchCursorApiKeyInfo.mockImplementation(async (key: string) => {
      if (key === 'test-cursor-key') {
        return { apiKeyName: 'Service Account', createdAt: '2026-01-01T00:00:00.000Z' };
      }
      return {
        apiKeyName: 'Sub-token',
        userId: 42,
        userEmail: 'dev@example.com',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    });
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousKey;
    if (previousOverride === undefined) delete process.env.OTHER_CURSOR_KEY;
    else process.env.OTHER_CURSOR_KEY = previousOverride;
  });

  it('builds a GitHub HTTPS URL without a .git suffix', () => {
    expect(buildCloudRepoUrl('github', 'Apex', 'amergis/apex')).toBe(
      'https://github.com/amergis/apex',
    );
  });

  it('builds an Azure DevOps _git URL without credentials', () => {
    expect(buildCloudRepoUrl('ado', 'MaxView', 'MaxView')).toBe(
      'https://dev.azure.com/amergis/MaxView/_git/MaxView',
    );
  });

  it('strips a trailing .git from clone URLs', () => {
    expect(toCloudRepoUrl('https://github.com/org/repo.git')).toBe('https://github.com/org/repo');
  });

  it('uses CURSOR_API_KEY for GitHub launches', async () => {
    process.env.OTHER_CURSOR_KEY = 'project-override-key';
    await expect(resolveLaunchApiKey({
      project: 'Apex',
      prompt: 'x',
      model: 'composer-2.5',
      skillProvider: 'github',
      skillRepo: 'amergis/apex',
      skillBranch: 'main',
    })).resolves.toBe('test-cursor-key');
    expect(mockMintCursorUserSubToken).not.toHaveBeenCalled();
  });

  it('mints a user sub-token for ADO launches', async () => {
    await expect(resolveLaunchApiKey({
      project: 'MaxView',
      prompt: 'x',
      model: 'composer-2.5',
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'development',
      userEmail: 'dev@example.com',
    })).resolves.toBe('user-scoped-token');

    expect(mockMintCursorUserSubToken).toHaveBeenCalledWith({
      serviceAccountApiKey: 'test-cursor-key',
      forUserEmail: 'dev@example.com',
    });
  });

  it('requires userEmail for ADO launches', async () => {
    await expect(resolveLaunchApiKey({
      project: 'MaxView',
      prompt: 'x',
      model: 'composer-2.5',
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'development',
    })).rejects.toThrow(/User email is required/);
  });

  it('returns only vendor ids from launch — never the API key or clone secret', async () => {
    (Agent.create as jest.Mock).mockResolvedValue({
      agentId: 'bc-agent-1',
      send: jest.fn().mockResolvedValue({ id: 'run-cursor-1' }),
    });

    const result = await launchCloudAgent({
      project: 'MaxView',
      prompt: 'Implement the feature',
      model: 'composer-2.5',
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      userEmail: 'dev@example.com',
    });

    expect(result).toEqual({ cloudAgentId: 'bc-agent-1', cursorRunId: 'run-cursor-1' });
    expect(JSON.stringify(result)).not.toMatch(/test-cursor-key|user-scoped-token|ado-pat|gh-token/i);
    const createArg = (Agent.create as jest.Mock).mock.calls[0][0];
    expect(createArg.cloud).toEqual({
      repos: [{ url: 'https://dev.azure.com/amergis/MaxView/_git/MaxView', startingRef: 'main' }],
      autoCreatePR: true,
    });
    expect(createArg.cloud).not.toHaveProperty('env');
  });
});
