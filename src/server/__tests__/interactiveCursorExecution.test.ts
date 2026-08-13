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
});
