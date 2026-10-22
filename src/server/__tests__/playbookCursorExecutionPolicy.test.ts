import { createHash } from 'node:crypto';

jest.mock('@cursor/sdk', () => ({
  Agent: { create: jest.fn() },
}));

import { createLocalCursorExecution } from '../services/aiRunsWorker/cursorExecution';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';

const skillContent = '# frozen skill';
const skillSha256 = createHash('sha256').update(skillContent).digest('hex');

const policy = {
  schemaVersion: 1 as const,
  resolverVersion: 1,
  executionProfile: 'repository-read-only',
  capabilities: ['repository-read', 'network-read'] as const,
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
