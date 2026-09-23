const mockCreateAgent = jest.fn();
const mockResumeAgent = jest.fn();
const mockCreateNativeReadTools = jest.fn();

jest.mock('@cursor/sdk', () => ({
  Agent: {
    create: mockCreateAgent,
    resume: mockResumeAgent,
  },
}));

jest.mock('../services/nativeReadToolAdapter', () => ({
  createNativeReadTools: mockCreateNativeReadTools,
}));

import {
  acquireInteractiveCursorAgent,
  createInteractiveCursorExecution,
} from '../services/interactiveActorHost/interactiveCursorExecution';
import { createLocalCursorExecution } from '../services/aiRunsWorker/cursorExecution';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { RepoReader } from '../../shared/types/repoReader';

const mcpServers = {
  'ado-skills': { url: 'https://apex.example/api/internal/ai-runs/run-1/tools/ado-skills' },
};

describe('interactive Cursor execution repository tools', () => {
  it('mounts checkout-backed read tools and bootstrapped MCP servers', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    const run = { supports: jest.fn(), stream: jest.fn(), wait: jest.fn() };
    const dispose = jest.fn().mockResolvedValue(undefined);
    mockCreateAgent.mockResolvedValue({
      id: 'agent-1',
      send: jest.fn().mockResolvedValue(run),
      [Symbol.asyncDispose]: dispose,
    });
    const customTools = { get_skill_file: { execute: jest.fn() } };
    mockCreateNativeReadTools.mockReturnValue(customTools);
    const checkout = {} as RepoReader;

    try {
      const execution = await createInteractiveCursorExecution(
        {
          prompt: 'Run the pre-loaded interview skill.',
          model: 'composer-2.5',
          effort: 'high',
          workspaceRef: '/shared/grounding/checkout',
        },
        checkout,
        { mcpServers },
      );

      expect(mockCreateNativeReadTools).toHaveBeenCalledWith(checkout);
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          local: {
            cwd: '/shared/grounding/checkout',
            settingSources: ['project'],
            customTools,
          },
          mcpServers,
          model: {
            id: 'composer-2.5',
            params: [{ id: 'effort', value: 'high' }],
          },
        }),
      );
      expect(execution.agentId).toBe('agent-1');
      expect(execution.mode).toBe('recreated');
    } finally {
      delete process.env.CURSOR_API_KEY;
      jest.clearAllMocks();
    }
  });

  it('DoD-1: sends frozen effort through the background Cursor model params', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    const run = { supports: jest.fn(), stream: jest.fn(), wait: jest.fn() };
    mockCreateAgent.mockResolvedValue({
      send: jest.fn().mockResolvedValue(run),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
    });
    mockCreateNativeReadTools.mockReturnValue({});
    const snapshot: ExecutionSnapshot = {
      prompt: 'Generate the PRD.',
      model: 'claude-opus-4-6',
      effort: 'medium',
      workspaceRef: '/worker',
      workflowClass: 'prd',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      projectId: 'Apex',
      threadId: 'thread-worker',
    };

    try {
      await createLocalCursorExecution(snapshot, {} as RepoReader);
      expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({
        model: {
          id: 'claude-opus-4-6',
          params: [{ id: 'effort', value: 'medium' }],
        },
      }));
    } finally {
      delete process.env.CURSOR_API_KEY;
      jest.clearAllMocks();
    }
  });

  it('separates Agent acquisition from send so the actor can reuse a live Agent', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    const run = { supports: jest.fn(), stream: jest.fn(), wait: jest.fn() };
    const send = jest.fn().mockResolvedValue(run);
    const dispose = jest.fn().mockResolvedValue(undefined);
    mockCreateAgent.mockResolvedValue({
      id: 'agent-live',
      send,
      [Symbol.asyncDispose]: dispose,
    });
    mockCreateNativeReadTools.mockReturnValue({});

    try {
      const acquired = await acquireInteractiveCursorAgent(
        {
          model: 'auto',
          effort: null,
          workspaceRef: '/warm',
        },
        {} as RepoReader,
        { mcpServers },
      );
      expect(acquired.mode).toBe('recreated');
      expect(send).not.toHaveBeenCalled();
      await acquired.handle.send('turn-1');
      await acquired.handle.send('turn-2');
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenNthCalledWith(1, 'turn-1');
      expect(send).toHaveBeenNthCalledWith(2, 'turn-2');
      await acquired.handle.dispose();
      expect(dispose).toHaveBeenCalled();
    } finally {
      delete process.env.CURSOR_API_KEY;
      jest.clearAllMocks();
    }
  });

  it('uses recreationPrompt after agent_not_found', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    const resume = mockResumeAgent;
    const create = mockCreateAgent;
    const send = jest.fn().mockResolvedValue({
      supports: jest.fn(),
      stream: jest.fn(),
      wait: jest.fn(),
    });
    resume.mockRejectedValue(
      Object.assign(new Error('gone'), { code: 'agent_not_found' }),
    );
    create.mockResolvedValue({
      id: 'agent-fresh',
      send,
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
    });
    mockCreateNativeReadTools.mockReturnValue({});
    const spec = {
      model: 'auto',
      effort: null,
      workspaceRef: '/warm',
      currentPrompt: 'current turn only',
      recreationPrompt: 'full transcript + current',
    };

    try {
      const acquired = await acquireInteractiveCursorAgent(spec, {} as RepoReader, {
        resumeAgentId: 'old-agent',
        mcpServers,
      });
      expect(acquired.mode).toBe('recreated');
      await acquired.handle.send(
        acquired.mode === 'recreated' ? spec.recreationPrompt : spec.currentPrompt,
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(spec.recreationPrompt);
    } finally {
      delete process.env.CURSOR_API_KEY;
      jest.clearAllMocks();
    }
  });

  it('returns resumed after a successful Agent.resume', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    mockResumeAgent.mockResolvedValue({
      id: 'agent-live',
      send: jest.fn(),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
    });
    mockCreateNativeReadTools.mockReturnValue({});

    try {
      const acquired = await acquireInteractiveCursorAgent(
        {
          model: 'auto',
          effort: null,
          workspaceRef: '/warm',
        },
        {} as RepoReader,
        { resumeAgentId: 'agent-live', mcpServers },
      );
      expect(acquired.mode).toBe('resumed');
      expect(acquired.handle.agentId).toBe('agent-live');
      expect(mockCreateAgent).not.toHaveBeenCalled();
    } finally {
      delete process.env.CURSOR_API_KEY;
      jest.clearAllMocks();
    }
  });

  it('starts a fresh Agent when the resume target was reaped', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    const notFound = Object.assign(new Error('Agent agent-dead not found'), {
      name: 'AgentNotFoundError',
      code: 'agent_not_found',
    });
    mockResumeAgent.mockRejectedValue(notFound);
    mockCreateAgent.mockResolvedValue({
      id: 'agent-fresh',
      send: jest.fn(),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
    });
    mockCreateNativeReadTools.mockReturnValue({});

    try {
      const acquired = await acquireInteractiveCursorAgent(
        {
          model: 'auto',
          effort: null,
          workspaceRef: '/warm',
        },
        {} as RepoReader,
        { resumeAgentId: 'agent-dead', mcpServers },
      );

      expect(mockResumeAgent).toHaveBeenCalledWith(
        'agent-dead',
        expect.anything(),
      );
      expect(mockCreateAgent).toHaveBeenCalledTimes(1);
      expect(acquired.mode).toBe('recreated');
      expect(acquired.handle.agentId).toBe('agent-fresh');
    } finally {
      delete process.env.CURSOR_API_KEY;
      jest.clearAllMocks();
    }
  });

  it('rethrows resume failures that are not a missing agent', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    const offline = Object.assign(new Error('service unavailable'), {
      name: 'NetworkError',
      code: 'unavailable',
    });
    mockResumeAgent.mockRejectedValue(offline);
    mockCreateNativeReadTools.mockReturnValue({});

    try {
      await expect(
        acquireInteractiveCursorAgent(
          {
            model: 'auto',
            effort: null,
            workspaceRef: '/warm',
          },
          {} as RepoReader,
          { resumeAgentId: 'agent-live', mcpServers },
        ),
      ).rejects.toThrow('service unavailable');
      expect(mockCreateAgent).not.toHaveBeenCalled();
    } finally {
      delete process.env.CURSOR_API_KEY;
      jest.clearAllMocks();
    }
  });
});
