import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('../services/repoCheckoutService', () => ({
  checkoutDefaultBranch: jest.fn().mockResolvedValue('/tmp/workspace'),
  cleanupWorkspace: jest.fn(),
  computeDiff: jest.fn().mockResolvedValue({ diffText: 'diff', changedFiles: ['src/a.ts'] }),
  createFeatureBranch: jest.fn().mockResolvedValue('feature/apex-42-implement-login'),
  getCurrentBranch: jest.fn().mockResolvedValue('feature/apex-42-implement-login'),
  getWorkspaceDir: jest.fn().mockReturnValue('/tmp/workspace'),
  pushBranch: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/repoCacheService', () => ({
  resolveGitRemote: jest.fn().mockReturnValue({
    url: 'https://dev.azure.com/example/MaxView/_git/MaxView',
    env: {},
    secret: 'secret',
  }),
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn(),
}));

jest.mock('../services/skillCatalogGitHub', () => ({
  createPullRequest: jest.fn(),
}));

import { spawn } from 'child_process';
import {
  getCursorCliAgentRun,
  launchCursorCliAgent,
  streamCursorCliAgentRun,
} from '../services/cursorCliAgentClient';
import {
  checkoutDefaultBranch,
  cleanupWorkspace,
  computeDiff,
  createFeatureBranch,
  getCurrentBranch,
  pushBranch,
} from '../services/repoCheckoutService';

const PR_URL = 'https://dev.azure.com/example/MaxView/_git/MaxView/pullrequest/123';

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: jest.Mock };
  kill: jest.Mock;
}

function createMockChild(): MockChild {
  const stdin = new EventEmitter() as MockChild['stdin'];
  stdin.end = jest.fn();
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = stdin;
  child.kill = jest.fn();
  return child;
}

describe('cursorCliAgentClient publication', () => {
  const previousCliPath = process.env.CURSOR_AGENT_CLI_PATH;
  const createPullRequest = jest.fn();

  const launchInput = {
    project: 'MaxView',
    prompt: 'Implement the feature',
    model: 'composer-2.5',
    skillProvider: 'ado' as const,
    skillRepo: 'MaxView',
    skillBranch: 'development',
    workItemId: 42,
    workItemTitle: 'Implement login',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    createPullRequest.mockResolvedValue(PR_URL);
    process.env.CURSOR_AGENT_CLI_PATH = 'agent';
  });

  afterAll(() => {
    if (previousCliPath === undefined) delete process.env.CURSOR_AGENT_CLI_PATH;
    else process.env.CURSOR_AGENT_CLI_PATH = previousCliPath;
  });

  it('creates the feature branch before the CLI starts, then pushes and opens a PR', async () => {
    const child = createMockChild();
    (spawn as jest.Mock).mockReturnValue(child);

    const launched = await launchCursorCliAgent(launchInput, { createPullRequest });

    expect(checkoutDefaultBranch).toHaveBeenCalledWith(expect.objectContaining({
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
    }));
    expect(createFeatureBranch).toHaveBeenCalledWith(
      '/tmp/workspace',
      42,
      'Implement login',
      'development',
      expect.objectContaining({
        url: 'https://dev.azure.com/example/MaxView/_git/MaxView',
      }),
    );
    expect((createFeatureBranch as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (spawn as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((spawn as jest.Mock).mock.calls[0][1]).toEqual(expect.arrayContaining([
      '-p',
      '--workspace',
      '/tmp/workspace',
    ]));
    // --mode only accepts plan|ask; omitting it is the write-capable agent mode.
    expect((spawn as jest.Mock).mock.calls[0][1]).not.toContain('--mode=agent');
    expect(launched.branchName).toBe('feature/apex-42-implement-login');

    child.stdout.emit('data', Buffer.from('Implemented login.'));
    child.emit('close', 0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(pushBranch).toHaveBeenCalledWith(
      '/tmp/workspace',
      'feature/apex-42-implement-login',
      expect.any(Object),
    );
    expect(createPullRequest).toHaveBeenCalledWith({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      baseBranch: 'development',
      branchName: 'feature/apex-42-implement-login',
      workItemId: 42,
    });
    expect((pushBranch as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      createPullRequest.mock.invocationCallOrder[0],
    );
    expect(cleanupWorkspace).toHaveBeenCalled();
    expect(createPullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      (cleanupWorkspace as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(getCursorCliAgentRun(launched.cursorRunId)).toEqual(expect.objectContaining({
      status: 'completed',
      prUrl: PR_URL,
      resultText: expect.stringContaining('committed and pushed'),
    }));
  });

  it('streams clone, branch, verify, push and PR steps to the drawer', async () => {
    const child = createMockChild();
    (spawn as jest.Mock).mockReturnValue(child);

    const launched = await launchCursorCliAgent(launchInput, { createPullRequest });

    child.emit('close', 0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const titles: string[] = [];
    for await (const event of streamCursorCliAgentRun(launched.cursorRunId)) {
      titles.push(event.title);
    }

    expect(titles).toEqual(expect.arrayContaining([
      'Step 1 — Cloning repository',
      'Step 2 — On branch feature/apex-42-implement-login',
      'Step 3 — Cursor CLI running (agent mode)',
      'Step 4 — Verified still on feature/apex-42-implement-login',
      'Step 5 — Pushed origin/feature/apex-42-implement-login',
      'Step 6 — Pull request created',
    ]));
  });

  it('refuses to push when the agent left the workspace on the base branch', async () => {
    const child = createMockChild();
    (spawn as jest.Mock).mockReturnValue(child);
    (getCurrentBranch as jest.Mock)
      .mockResolvedValueOnce('feature/apex-42-implement-login')
      .mockResolvedValueOnce('development');

    const launched = await launchCursorCliAgent(launchInput, { createPullRequest });

    child.emit('close', 0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(pushBranch).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(getCursorCliAgentRun(launched.cursorRunId)).toEqual(expect.objectContaining({
      status: 'failed',
      resultText: expect.stringContaining('ended on development'),
    }));
  });

  it('skips the push and PR when the agent changed no files', async () => {
    const child = createMockChild();
    (spawn as jest.Mock).mockReturnValue(child);
    (computeDiff as jest.Mock).mockResolvedValueOnce({ diffText: '', changedFiles: [] });

    const launched = await launchCursorCliAgent(launchInput, { createPullRequest });

    child.emit('close', 0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(pushBranch).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(getCursorCliAgentRun(launched.cursorRunId)).toEqual(expect.objectContaining({
      status: 'completed',
      prUrl: null,
      resultText: expect.stringContaining('nothing was committed or pushed'),
    }));
  });

  it('fails the run when the PR cannot be created after a successful push', async () => {
    const child = createMockChild();
    (spawn as jest.Mock).mockReturnValue(child);
    createPullRequest.mockRejectedValueOnce(new Error('ADO rejected the PR'));

    const launched = await launchCursorCliAgent(launchInput, { createPullRequest });

    child.emit('close', 0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(pushBranch).toHaveBeenCalled();
    expect(getCursorCliAgentRun(launched.cursorRunId)).toEqual(expect.objectContaining({
      status: 'failed',
      resultText: expect.stringContaining('ADO rejected the PR'),
    }));
  });
});
