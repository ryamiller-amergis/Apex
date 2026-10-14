/**
 * FEAT-008 Wave 2 Bundle A — TBI-032 / VT-24.
 *
 * The descriptor schemas are the runtime contract at both adapter boundaries. Invalid input must
 * stop before permission lookup or adapter dispatch; invalid output must stop before durable
 * completion.
 */
const getUserPermissions = jest.fn();
const executeNotify = jest.fn();
const executeApprovalGate = jest.fn();
const executeCursorAgent = jest.fn();

jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...args: unknown[]) => getUserPermissions(...args),
}));

jest.mock('../services/playbookSteps/notifyAdapter', () => ({
  executeNotifyStep: (...args: unknown[]) => executeNotify(...args),
}));

jest.mock('../services/playbookSteps/approvalGateAdapter', () => ({
  executeApprovalGateStep: (...args: unknown[]) => executeApprovalGate(...args),
}));

jest.mock('../services/playbookSteps/cursorAgentAdapter', () => ({
  executeCursorAgentStep: (...args: unknown[]) => executeCursorAgent(...args),
}));

import { executeStep } from '../services/playbookSteps';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';

function context(stepType: string, config: Record<string, unknown>): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: `step-run-${stepType}`,
    stepId: `step-${stepType}`,
    stepType,
    project: 'Apex',
    initiatorUserId: 'initiator-1',
    config,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getUserPermissions.mockResolvedValue(new Set(['playbooks:run', 'playbooks:view']));
});

describe('TBI-032 VT-24 — descriptor input schemas guard adapter dispatch', () => {
  it.each([
    ['notify', { title: '' }, executeNotify, 'title'],
    [
      'cursor-agent',
      { skillPath: '.cursor/skills/app-knowledge/SKILL.md', prompt: '' },
      executeCursorAgent,
      'prompt',
    ],
    ['approval-gate', { deadlineMs: 0 }, executeApprovalGate, 'deadlineMs'],
  ])(
    'rejects invalid %s config before permission lookup or adapter dispatch',
    async (stepType, config, adapter, field) => {
      await expect(executeStep(context(stepType, config))).rejects.toThrow(
        new RegExp(`${stepType}.*input.*${field}`, 'i')
      );

      expect(getUserPermissions).not.toHaveBeenCalled();
      expect(adapter).not.toHaveBeenCalled();
    }
  );

  it('passes the schema-parsed config to the adapter', async () => {
    executeNotify.mockResolvedValue({ kind: 'completed', output: {} });

    await executeStep(context('notify', { title: 'Ready', ignored: 'strip me' }));

    expect(executeNotify).toHaveBeenCalledWith(
      expect.objectContaining({ config: { title: 'Ready' } })
    );
  });
});
