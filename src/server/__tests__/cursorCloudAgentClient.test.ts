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
  normalizeCloudAgentActivity,
  resolveCloudAgentLaunchTarget,
  resolveLaunchApiKey,
  toCloudRepoUrl,
} from '../services/cursorCloudAgentClient';

describe('cursorCloudAgentClient', () => {
  const previousKey = process.env.CURSOR_API_KEY;
  const previousOverride = process.env.OTHER_CURSOR_KEY;
  const previousTestRepo = process.env.CLOUD_AGENT_TEST_GITHUB_REPO;
  const previousTestBranch = process.env.CLOUD_AGENT_TEST_GITHUB_BRANCH;
  const previousEnvName = process.env.CLOUD_AGENT_CURSOR_ENV_NAME;
  const previousEnvType = process.env.CLOUD_AGENT_CURSOR_ENV_TYPE;
  const previousAdoNamedEnv = process.env.CLOUD_AGENT_ADO_USE_NAMED_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CLOUD_AGENT_TEST_GITHUB_REPO;
    delete process.env.CLOUD_AGENT_TEST_GITHUB_BRANCH;
    delete process.env.CLOUD_AGENT_CURSOR_ENV_NAME;
    delete process.env.CLOUD_AGENT_CURSOR_ENV_TYPE;
    delete process.env.CLOUD_AGENT_ADO_USE_NAMED_ENV;
    process.env.CURSOR_API_KEY = 'test-cursor-key';
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousKey;
    if (previousOverride === undefined) delete process.env.OTHER_CURSOR_KEY;
    else process.env.OTHER_CURSOR_KEY = previousOverride;
    if (previousTestRepo === undefined) delete process.env.CLOUD_AGENT_TEST_GITHUB_REPO;
    else process.env.CLOUD_AGENT_TEST_GITHUB_REPO = previousTestRepo;
    if (previousTestBranch === undefined) delete process.env.CLOUD_AGENT_TEST_GITHUB_BRANCH;
    else process.env.CLOUD_AGENT_TEST_GITHUB_BRANCH = previousTestBranch;
    if (previousEnvName === undefined) delete process.env.CLOUD_AGENT_CURSOR_ENV_NAME;
    else process.env.CLOUD_AGENT_CURSOR_ENV_NAME = previousEnvName;
    if (previousEnvType === undefined) delete process.env.CLOUD_AGENT_CURSOR_ENV_TYPE;
    else process.env.CLOUD_AGENT_CURSOR_ENV_TYPE = previousEnvType;
    if (previousAdoNamedEnv === undefined) delete process.env.CLOUD_AGENT_ADO_USE_NAMED_ENV;
    else process.env.CLOUD_AGENT_ADO_USE_NAMED_ENV = previousAdoNamedEnv;
  });

  it('overrides ADO launch target when CLOUD_AGENT_TEST_GITHUB_REPO is set', () => {
    process.env.CLOUD_AGENT_TEST_GITHUB_REPO = 'amergis/Apex';
    process.env.CLOUD_AGENT_TEST_GITHUB_BRANCH = 'main';
    expect(resolveCloudAgentLaunchTarget({
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'development',
    })).toEqual({
      skillProvider: 'github',
      skillRepo: 'amergis/Apex',
      skillBranch: 'main',
      testOverride: 'github:amergis/Apex',
    });
  });

  it('builds a GitHub HTTPS URL without a .git suffix or local token', () => {
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      expect(buildCloudRepoUrl('github', 'Apex', 'amergis/apex')).toBe(
        'https://github.com/amergis/apex',
      );
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });

  it('builds an Azure DevOps _git URL without credentials', () => {
    expect(buildCloudRepoUrl('ado', 'MaxView', 'MaxView')).toBe(
      'https://dev.azure.com/amergis/MaxView/_git/MaxView',
    );
  });

  it('strips a trailing .git from clone URLs', () => {
    expect(toCloudRepoUrl('https://github.com/org/repo.git')).toBe('https://github.com/org/repo');
  });

  it('normalizes assistant text without exposing non-text blocks', () => {
    expect(normalizeCloudAgentActivity({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Updated the route.' },
          { type: 'tool_use', name: 'edit', input: { secret: 'not-for-the-client' } },
        ],
      },
    }, 3)).toEqual([{
      id: '3:assistant:0',
      kind: 'assistant',
      title: 'Agent update',
      detail: 'Updated the route.',
    }]);
  });

  it('normalizes tool lifecycle without sending arguments or results', () => {
    const result = normalizeCloudAgentActivity({
      type: 'tool_call',
      call_id: 'call-1',
      name: 'read_file',
      status: 'completed',
      args: { path: '/secret' },
      result: 'file contents',
    }, 4);

    expect(result).toEqual([{
      id: '4:tool:call-1:completed',
      kind: 'tool',
      title: 'read file',
      detail: 'Completed',
      status: 'completed',
    }]);
    expect(JSON.stringify(result)).not.toContain('/secret');
    expect(JSON.stringify(result)).not.toContain('file contents');
  });

  it('uses CURSOR_API_KEY for GitHub and ADO launches', async () => {
    process.env.OTHER_CURSOR_KEY = 'project-override-key';
    await expect(resolveLaunchApiKey({
      project: 'Apex',
      prompt: 'x',
      model: 'composer-2.5',
      skillProvider: 'github',
      skillRepo: 'amergis/apex',
      skillBranch: 'main',
    })).resolves.toBe('test-cursor-key');

    await expect(resolveLaunchApiKey({
      project: 'MaxView',
      prompt: 'x',
      model: 'composer-2.5',
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'development',
    })).resolves.toBe('test-cursor-key');
  });

  it('uses GitHub service-account auth when test override is set', async () => {
    process.env.CLOUD_AGENT_TEST_GITHUB_REPO = 'amergis/Apex';
    (Agent.create as jest.Mock).mockResolvedValue({
      agentId: 'bc-agent-1',
      send: jest.fn().mockResolvedValue({ id: 'run-cursor-1' }),
    });

    await launchCloudAgent({
      project: 'MaxView',
      prompt: 'Implement the feature',
      model: 'composer-2.5',
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      skillBranch: 'development',
    });

    const createArg = (Agent.create as jest.Mock).mock.calls[0][0];
    expect(createArg.apiKey).toBe('test-cursor-key');
    expect(createArg.cloud.repos[0].url).toBe('https://github.com/amergis/Apex');
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
    });

    expect(result).toEqual({ cloudAgentId: 'bc-agent-1', cursorRunId: 'run-cursor-1' });
    expect(JSON.stringify(result)).not.toMatch(/test-cursor-key|ado-pat|gh-token/i);
    const createArg = (Agent.create as jest.Mock).mock.calls[0][0];
    expect(createArg.cloud).toEqual({
      repos: [{ url: 'https://dev.azure.com/amergis/MaxView/_git/MaxView', startingRef: 'main' }],
      autoCreatePR: true,
    });
    expect(createArg.cloud).not.toHaveProperty('env');
  });

  describe('named cloud environments', () => {
    const adoLaunch = {
      project: 'MaxView',
      prompt: 'Implement the feature',
      model: 'composer-2.5',
      skillProvider: 'ado' as const,
      skillRepo: 'MaxView',
      skillBranch: 'development',
    };

    beforeEach(() => {
      (Agent.create as jest.Mock).mockResolvedValue({
        agentId: 'bc-agent-1',
        send: jest.fn().mockResolvedValue({ id: 'run-cursor-1' }),
      });
    });

    it('targets a My Machines worker when the env type is machine', async () => {
      process.env.CLOUD_AGENT_CURSOR_ENV_TYPE = 'machine';
      process.env.CLOUD_AGENT_CURSOR_ENV_NAME = 'MSL-SD00HL8E';
      process.env.CLOUD_AGENT_ADO_USE_NAMED_ENV = 'true';

      await launchCloudAgent(adoLaunch);

      const createArg = (Agent.create as jest.Mock).mock.calls[0][0];
      expect(createArg.cloud.env).toEqual({ type: 'machine', name: 'MSL-SD00HL8E' });
      // Repo-less private-worker dispatch is rejected, so keep the anchor repo.
      expect(createArg.cloud.repos).toEqual([
        { url: 'https://dev.azure.com/amergis/MaxView/_git/MaxView', startingRef: 'development' },
      ]);
    });

    it('targets a self-hosted pool when the env type is pool', async () => {
      process.env.CLOUD_AGENT_CURSOR_ENV_TYPE = 'pool';
      process.env.CLOUD_AGENT_CURSOR_ENV_NAME = 'team-pool';
      process.env.CLOUD_AGENT_ADO_USE_NAMED_ENV = 'true';

      await launchCloudAgent(adoLaunch);

      const createArg = (Agent.create as jest.Mock).mock.calls[0][0];
      expect(createArg.cloud.env).toEqual({ type: 'pool', name: 'team-pool' });
      expect(createArg.cloud.repos).toHaveLength(1);
    });

    it('defaults to a Cursor-hosted env when the type is unset or unrecognized', async () => {
      process.env.CLOUD_AGENT_CURSOR_ENV_NAME = 'apex-env';
      process.env.CLOUD_AGENT_ADO_USE_NAMED_ENV = 'true';

      await launchCloudAgent(adoLaunch);

      const createArg = (Agent.create as jest.Mock).mock.calls[0][0];
      expect(createArg.cloud.env).toEqual({ type: 'cloud', name: 'apex-env' });
      expect(createArg.cloud).not.toHaveProperty('repos');
    });

    it('ignores the named env for ADO unless CLOUD_AGENT_ADO_USE_NAMED_ENV is true', async () => {
      process.env.CLOUD_AGENT_CURSOR_ENV_TYPE = 'machine';
      process.env.CLOUD_AGENT_CURSOR_ENV_NAME = 'MSL-SD00HL8E';

      await launchCloudAgent(adoLaunch);

      const createArg = (Agent.create as jest.Mock).mock.calls[0][0];
      expect(createArg.cloud).not.toHaveProperty('env');
      expect(createArg.cloud.repos[0].startingRef).toBe('development');
    });
  });
});
