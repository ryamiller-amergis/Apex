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
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { RepoReader } from '../../shared/types/repoReader';

describe('interactive Cursor execution repository tools', () => {
  it('mounts checkout-backed read tools for a new actor session', async () => {
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
    const snapshot: ExecutionSnapshot = {
      prompt: 'Run the pre-loaded interview skill.',
      model: 'composer-2.5',
      workspaceRef: '/shared/grounding/checkout',
      workflowClass: 'interview',
      skillPath: '/.cursor/skills/grill-with-docs/SKILL.md',
      projectId: 'Apex',
      threadId: 'thread-1',
    };

    try {
      const execution = await createInteractiveCursorExecution(
        snapshot,
        checkout,
      );

      expect(mockCreateNativeReadTools).toHaveBeenCalledWith(checkout);
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          local: {
            cwd: '/shared/grounding/checkout',
            settingSources: ['project'],
            customTools,
          },
          mcpServers: {},
        }),
      );
      expect(execution.agentId).toBe('agent-1');
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
    const snapshot: ExecutionSnapshot = {
      prompt: 'first',
      model: 'auto',
      workspaceRef: '/warm',
      workflowClass: 'agent_home_chat',
      skillPath: 'skills/app-knowledge',
      projectId: 'Apex',
      threadId: 'thread-1',
    };

    try {
      const handle = await acquireInteractiveCursorAgent(
        snapshot,
        {} as RepoReader,
      );
      expect(send).not.toHaveBeenCalled();
      await handle.send('turn-1');
      await handle.send('turn-2');
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenNthCalledWith(1, 'turn-1');
      expect(send).toHaveBeenNthCalledWith(2, 'turn-2');
      await handle.dispose();
      expect(dispose).toHaveBeenCalled();
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
    const snapshot: ExecutionSnapshot = {
      prompt: 'second turn',
      model: 'auto',
      workspaceRef: '/warm',
      workflowClass: 'agent_home_chat',
      skillPath: 'skills/app-knowledge',
      projectId: 'Apex',
      threadId: 'thread-1',
    };

    try {
      const handle = await acquireInteractiveCursorAgent(
        snapshot,
        {} as RepoReader,
        { resumeAgentId: 'agent-dead' },
      );

      expect(mockResumeAgent).toHaveBeenCalledWith(
        'agent-dead',
        expect.anything(),
      );
      expect(mockCreateAgent).toHaveBeenCalledTimes(1);
      // The dead id must not be persisted back onto the thread, or the next
      // turn resumes it again and fails identically.
      expect(handle.agentId).toBe('agent-fresh');
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
    const snapshot: ExecutionSnapshot = {
      prompt: 'second turn',
      model: 'auto',
      workspaceRef: '/warm',
      workflowClass: 'agent_home_chat',
      skillPath: 'skills/app-knowledge',
      projectId: 'Apex',
      threadId: 'thread-1',
    };

    try {
      await expect(
        acquireInteractiveCursorAgent(snapshot, {} as RepoReader, {
          resumeAgentId: 'agent-live',
        }),
      ).rejects.toThrow('service unavailable');
      // A transient failure must not silently abandon the thread's history.
      expect(mockCreateAgent).not.toHaveBeenCalled();
    } finally {
      delete process.env.CURSOR_API_KEY;
      jest.clearAllMocks();
    }
  });
});
