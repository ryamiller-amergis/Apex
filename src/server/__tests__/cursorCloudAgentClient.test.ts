const mockCreate = jest.fn();
const mockSend = jest.fn();
const mockDispose = jest.fn();
const mockGetRun = jest.fn();

jest.mock('@cursor/sdk', () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    getRun: (...args: unknown[]) => mockGetRun(...args),
  },
}));

const mockGetContainerRun = jest.fn();
const mockCancelContainerRun = jest.fn();

jest.mock('../services/cursorContainerCliService', () => ({
  isContainerAgentId: (id: string) => id.startsWith('container-agent-'),
  getCursorContainerCliRun: (...args: unknown[]) => mockGetContainerRun(...args),
  streamCursorContainerCliRun: jest.fn(),
  cancelCursorContainerCliRun: (...args: unknown[]) => mockCancelContainerRun(...args),
}));

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

import {
  buildCloudRepoUrl,
  cancelCursorCloudAgentRun,
  getCloudAgentRun,
  launchCloudAgent,
  observeCloudRun,
  sdkMessageToActivity,
  toCloudRepoUrl,
} from '../services/cursorCloudAgentClient';
import type { SDKMessage } from '@cursor/sdk';

describe('cursorCloudAgentClient', () => {
  it('builds a GitHub HTTPS URL without a .git suffix or local token', () => {
    expect(buildCloudRepoUrl('github', 'Apex', 'amergis/Apex')).toBe(
      'https://github.com/amergis/Apex',
    );
  });

  it('builds an Azure DevOps _git URL without credentials', () => {
    expect(buildCloudRepoUrl('ado', 'MaxView', 'MaxView')).toBe(
      'https://dev.azure.com/amergis/MaxView/_git/MaxView',
    );
  });

  it('maps Cursor SDK stream messages into drawer activity', () => {
    const messages: SDKMessage[] = [
      {
        type: 'assistant',
        agent_id: 'bc-1',
        run_id: 'run-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Updating the view.' }] },
      },
      {
        type: 'tool_call',
        agent_id: 'bc-1',
        run_id: 'run-1',
        call_id: 'call-1',
        name: 'edit',
        status: 'completed',
      },
    ];

    expect(messages.map((message, index) => sdkMessageToActivity(message, index))).toEqual([
      {
        id: 'assistant:run-1:0',
        kind: 'assistant',
        title: 'Assistant',
        detail: 'Updating the view.',
      },
      {
        id: 'tool:call-1:completed',
        kind: 'tool',
        title: 'edit',
        detail: 'Completed',
        status: 'completed',
      },
    ]);
  });

  it('strips a trailing .git from clone URLs', () => {
    expect(toCloudRepoUrl('https://github.com/amergis/Apex.git')).toBe(
      'https://github.com/amergis/Apex',
    );
  });

  it('starts a Cursor SDK cloud agent with CURSOR_API_KEY', async () => {
    const previous = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'cursor-key';
    mockDispose.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({ id: 'run-1' });
    mockCreate.mockResolvedValue({
      agentId: 'bc-1',
      send: mockSend,
      [Symbol.asyncDispose]: mockDispose,
    });

    try {
      const result = await launchCloudAgent({
        project: 'MaxView',
        prompt: 'Implement the work item',
        model: 'composer-2.5',
        skillProvider: 'ado',
        skillRepo: 'MaxView',
        skillBranch: 'development',
        workItemTitle: 'Document Management',
      });

      expect(mockCreate).toHaveBeenCalledWith({
        apiKey: 'cursor-key',
        model: { id: 'composer-2.5' },
        name: 'Document Management',
        cloud: {
          repos: [{
            url: 'https://dev.azure.com/amergis/MaxView/_git/MaxView',
            startingRef: 'development',
          }],
          autoCreatePR: false,
          skipReviewerRequest: true,
        },
      });
      expect(mockSend).toHaveBeenCalledWith('Implement the work item');
      expect(result).toEqual({
        cloudAgentId: 'bc-1',
        cursorRunId: 'run-1',
        jobName: 'cursor-sdk',
      });
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous;
    }
  });

  it('reads pull request and branch from the Cursor run', async () => {
    const previous = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'cursor-key';
    mockGetRun.mockResolvedValue({
      id: 'run-1',
      status: 'finished',
      result: 'Opened the pull request.',
      git: {
        branches: [{
          repoUrl: 'https://dev.azure.com/amergis/MaxView/_git/MaxView',
          branch: 'feature/hello',
          prUrl: 'https://dev.azure.com/amergis/MaxView/_git/MaxView/pullrequest/12',
        }],
      },
    });

    try {
      const observed = await getCloudAgentRun({
        project: 'MaxView',
        cloudAgentId: 'bc-1',
        cursorRunId: 'run-1',
      });

      expect(mockGetRun).toHaveBeenCalledWith('run-1', {
        runtime: 'cloud',
        agentId: 'bc-1',
        apiKey: 'cursor-key',
      });
      expect(observed).toEqual({
        status: 'finished',
        prUrl: 'https://dev.azure.com/amergis/MaxView/_git/MaxView/pullrequest/12',
        resultText: 'Opened the pull request.',
        branchName: 'feature/hello',
        baseBranch: null,
        summary: 'Opened the pull request.',
        noChanges: false,
        settled: true,
      });
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous;
    }
  });

  it('cancels the Cursor run', async () => {
    const previous = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'cursor-key';
    const cancel = jest.fn().mockResolvedValue(undefined);
    mockGetRun.mockResolvedValue({
      supports: () => true,
      cancel,
    });

    try {
      await cancelCursorCloudAgentRun({
        project: 'MaxView',
        cloudAgentId: 'bc-1',
        cursorRunId: 'run-1',
      });
      expect(cancel).toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous;
    }
  });

  it('lets Cursor open the pull request only for GitHub', async () => {
    const previous = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'cursor-key';
    mockDispose.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({ id: 'run-gh' });
    mockCreate.mockResolvedValue({
      agentId: 'bc-gh',
      send: mockSend,
      [Symbol.asyncDispose]: mockDispose,
    });

    try {
      await launchCloudAgent({
        project: 'Apex',
        prompt: 'Implement the work item',
        model: 'composer-2.5',
        skillProvider: 'github',
        skillRepo: 'amergis/Apex',
        skillBranch: 'main',
      });
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        cloud: expect.objectContaining({ autoCreatePR: true }),
      }));
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous;
    }
  });

  it('waits when a finished Cursor run has no git metadata yet', () => {
    const observed = observeCloudRun({
      status: 'finished',
      result: 'Done',
    } as Parameters<typeof observeCloudRun>[0]);

    expect(observed.status).toBe('running');
    expect(observed.noChanges).toBe(false);
    expect(observed.settled).toBe(false);
  });

  it('treats an explicit empty branch list as no file changes', () => {
    const observed = observeCloudRun({
      status: 'finished',
      git: { branches: [] },
    } as Parameters<typeof observeCloudRun>[0]);

    expect(observed.status).toBe('finished');
    expect(observed.noChanges).toBe(true);
    expect(observed.settled).toBe(true);
  });

  it('reads a live container execution through the container adapter', async () => {
    mockGetRun.mockClear();
    mockGetContainerRun.mockResolvedValue({
      status: 'running',
      prUrl: null,
      resultText: null,
      branchName: null,
      baseBranch: null,
      summary: null,
      noChanges: false,
      settled: false,
    });

    await getCloudAgentRun({
      project: 'MaxView',
      cloudAgentId: 'container-agent-exec-1',
      cursorRunId: 'exec-1',
    });

    expect(mockGetContainerRun).toHaveBeenCalledWith('exec-1');
    expect(mockGetRun).not.toHaveBeenCalled();
  });

  it('cancels a live container execution through the container adapter', async () => {
    mockGetRun.mockClear();
    mockCancelContainerRun.mockResolvedValue(undefined);

    await cancelCursorCloudAgentRun({
      project: 'MaxView',
      cloudAgentId: 'container-agent-exec-1',
      cursorRunId: 'exec-1',
    });

    expect(mockCancelContainerRun).toHaveBeenCalledWith('exec-1');
    expect(mockGetRun).not.toHaveBeenCalled();
  });
});
