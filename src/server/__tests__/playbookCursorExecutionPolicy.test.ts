import { createHash } from 'node:crypto';

jest.mock('@cursor/sdk', () => ({
  Agent: { create: jest.fn() },
}));

import { Agent } from '@cursor/sdk';
import { createLocalCursorExecution } from '../services/aiRunsWorker/cursorExecution';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { PlaybookCapability } from '../../shared/types/playbookExecutionCapability';

const skillContent = '# frozen skill';
const skillSha256 = createHash('sha256').update(skillContent).digest('hex');

const policy = {
  schemaVersion: 1 as const,
  resolverVersion: 1,
  executionProfile: 'repository-read-only',
  capabilities: ['repository-read', 'network-read'] as PlaybookCapability[],
  skill: {
    path: '.cursor/skills/test/SKILL.md',
    sha256: skillSha256,
  },
  mcpServers: [],
  localAgent: {
    cwdMode: 'scratch' as const,
    allowBuiltinWrites: false,
    customTools: 'native-read-only' as const,
  },
  enforcement: 'enforce' as const,
  resolvedAt: '2026-10-19T00:00:00.000Z',
};

const snapshot: ExecutionSnapshot = {
  prompt: 'Run the check',
  model: 'test-model',
  workspaceRef: 'C:\\scratch',
  workflowClass: 'playbook-step',
  skillPath: policy.skill.path,
  skillContent,
  skillSha256: 'a'.repeat(64),
  projectId: 'Apex',
  threadId: 'thread-1',
  playbookAgentPolicy: policy,
};

beforeEach(() => {
  process.env.CURSOR_API_KEY = 'test-key';
});

afterEach(() => {
  delete process.env.CURSOR_API_KEY;
});

it('refuses V1 execution when frozen Skill content does not match the policy hash', async () => {
  await expect(createLocalCursorExecution(snapshot)).rejects.toThrow(
    /Skill content with a mismatched hash/
  );
});

function mockAgent(): { send: jest.Mock } {
  const send = jest.fn().mockResolvedValue({ id: 'run' });
  jest.mocked(Agent.create).mockReset();
  jest.mocked(Agent.create).mockResolvedValue({
    send,
    [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
  } as never);
  return { send };
}

it('keeps the previous worker path while enforcement is observe', async () => {
  const { send } = mockAgent();

  await createLocalCursorExecution({
    ...snapshot,
    playbookAgentPolicy: { ...policy, enforcement: 'observe' },
  });

  const local = jest.mocked(Agent.create).mock.calls[0][0].local;
  expect(local?.settingSources).toEqual(['project']);
  expect(local?.sandboxOptions).toBeUndefined();
  expect(send).toHaveBeenCalledWith('Run the check');
});

it('restricts the worker and supplies the Skill only when enforcement is on', async () => {
  const { send } = mockAgent();

  await createLocalCursorExecution({
    ...snapshot,
    skillSha256,
  });

  const local = jest.mocked(Agent.create).mock.calls[0][0].local;
  expect(local?.settingSources).toEqual([]);
  expect(local?.sandboxOptions).toEqual({ enabled: true });
  expect(send).toHaveBeenCalledWith(`${skillContent}\n\n---\n\nRun the check`);
});

it('does not prepend Skill content the V2 prompt already carries', async () => {
  const { send } = mockAgent();
  const prompt = `# Frozen execution skill\n\n${skillContent}\n\n---\n\nRun the check`;

  await createLocalCursorExecution({
    ...snapshot,
    prompt,
    skillSha256,
  });

  expect(send).toHaveBeenCalledWith(prompt);
});

it('refuses an enforce-mode policy that grants built-in writes', async () => {
  await expect(
    createLocalCursorExecution({
      ...snapshot,
      skillSha256,
      playbookAgentPolicy: {
        ...policy,
        localAgent: { ...policy.localAgent, allowBuiltinWrites: true },
      },
    })
  ).rejects.toThrow(/broader than the worker read-only execution lane/);
});
