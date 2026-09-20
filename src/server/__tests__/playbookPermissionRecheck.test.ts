/**
 * TBI-024 — the execution-time permission re-check.
 *
 * Covers VT-19 (a revoked initiator cannot execute a side-effecting step), VT-20 (a still-permitted
 * one can) and VT-21 (the re-check happens before the adapter, not inside it).
 *
 * VT-21 is the one that matters and the one that is easy to get wrong. A re-check that runs after
 * the adapter has started its side effect is not a check — the notification has been sent, the
 * agent run has been enqueued. Asserting ordering rather than merely "it threw" is what makes that
 * distinction testable.
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

import {
  PlaybookPermissionRevokedError,
  executeStep,
} from '../services/playbookSteps';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';

const PROJECT = 'Apex';
const INITIATOR = 'user-who-started-it';

function context(stepType: string): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'notify-the-team',
    stepType,
    project: PROJECT,
    initiatorUserId: INITIATOR,
    config: {},
  };
}

/** What the initiator's permissions resolve to when the step is reached. */
function initiatorHas(...permissions: string[]): void {
  getUserPermissions.mockResolvedValue(new Set(permissions));
}

beforeEach(() => {
  jest.clearAllMocks();
  initiatorHas('playbooks:run', 'playbooks:view');
  executeNotify.mockResolvedValue({ kind: 'completed', output: {} });
  executeApprovalGate.mockResolvedValue({ kind: 'suspended' });
  executeCursorAgent.mockResolvedValue({ kind: 'suspended' });
});

describe('VT-19 — a revoked initiator cannot execute a side-effecting step', () => {
  it('refuses a notify step and never calls the adapter', async () => {
    initiatorHas('playbooks:view');

    await expect(executeStep(context('notify'))).rejects.toBeInstanceOf(
      PlaybookPermissionRevokedError
    );

    // The whole point: the notification was not sent.
    expect(executeNotify).not.toHaveBeenCalled();
  });

  it('refuses a cursor-agent step, which leaves Apex entirely', async () => {
    initiatorHas();

    await expect(executeStep(context('cursor-agent'))).rejects.toBeInstanceOf(
      PlaybookPermissionRevokedError
    );
    expect(executeCursorAgent).not.toHaveBeenCalled();
  });

  it('names the step and the project, so the failure can be acted on', async () => {
    initiatorHas('playbooks:view');

    // Both, because "permission denied" with neither is not something anyone can act on.
    await expect(executeStep(context('notify'))).rejects.toThrow('notify-the-team');
    await expect(executeStep(context('notify'))).rejects.toThrow(PROJECT);
  });

  it('re-checks against the run\'s project, not the platform', async () => {
    await executeStep(context('notify'));

    expect(getUserPermissions).toHaveBeenCalledWith(INITIATOR, PROJECT);
  });
});

describe('VT-20 — a still-permitted initiator executes normally', () => {
  it('runs the adapter and returns its outcome', async () => {
    executeNotify.mockResolvedValue({ kind: 'completed', output: { sent: 1 } });

    await expect(executeStep(context('notify'))).resolves.toEqual({
      kind: 'completed',
      output: { sent: 1 },
    });
    expect(executeNotify).toHaveBeenCalledTimes(1);
  });
});

describe('VT-21 — the re-check runs before the adapter, and only where it is owed', () => {
  it('checks permissions before invoking the adapter', async () => {
    const order: string[] = [];
    getUserPermissions.mockImplementation(async () => {
      order.push('permission-check');
      return new Set(['playbooks:run']);
    });
    executeNotify.mockImplementation(async () => {
      order.push('adapter');
      return { kind: 'completed', output: {} };
    });

    await executeStep(context('notify'));

    // Ordering, not merely occurrence. A check after the send is not a check.
    expect(order).toEqual(['permission-check', 'adapter']);
  });

  it('skips the re-check for an approval gate, which has no side effect outside Apex', async () => {
    await executeStep(context('approval-gate'));

    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(executeApprovalGate).toHaveBeenCalledTimes(1);
  });

  it('re-checks every step type the registry classifies as side-effecting', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports -- reading the registry at runtime */
    const { requiresInitiatorPermissionRecheck, listStepTypeDescriptors } =
      require('../services/playbookSteps/registry') as typeof import('../services/playbookSteps/registry');
    /* eslint-enable @typescript-eslint/no-require-imports */

    /*
     * Derived from the registry rather than hardcoded. A step type added later with a side effect
     * is then covered by this test on the day it is added, which is the only moment anyone would
     * think to check.
     */
    for (const descriptor of listStepTypeDescriptors()) {
      jest.clearAllMocks();
      initiatorHas('playbooks:run');

      await executeStep(context(descriptor.stepType));

      expect(getUserPermissions.mock.calls.length).toBe(
        requiresInitiatorPermissionRecheck(descriptor.stepType) ? 1 : 0
      );
    }
  });
});
