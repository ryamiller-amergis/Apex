/**
 * FEAT-008 Wave 2 Bundle A — TBI-033 execution-time permission enforcement.
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
  const configs: Record<string, Record<string, unknown>> = {
    notify: { title: 'Ready' },
    'approval-gate': {},
    'cursor-agent': {
      skillPath: '.cursor/skills/app-knowledge/SKILL.md',
      prompt: 'Summarise the docs',
    },
  };
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'notify-the-team',
    stepType,
    project: PROJECT,
    initiatorUserId: INITIATOR,
    config: configs[stepType] ?? {},
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

describe('TBI-033 VT-24 — descriptor permissions run immediately before every adapter', () => {
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

  it('enforces the approval-gate read permission too', async () => {
    initiatorHas('playbooks:run');

    await expect(executeStep(context('approval-gate'))).rejects.toThrow(/playbooks:view/);

    expect(getUserPermissions).toHaveBeenCalledTimes(1);
    expect(executeApprovalGate).not.toHaveBeenCalled();
  });

  it('allows an approval gate when its descriptor permission is present', async () => {
    initiatorHas('playbooks:view');

    await executeStep(context('approval-gate'));

    expect(getUserPermissions).toHaveBeenCalledTimes(1);
    expect(executeApprovalGate).toHaveBeenCalledTimes(1);
  });

  it('enforces the exact current descriptor matrix once for every step type', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports -- reading the registry at runtime */
    const { listStepTypeDescriptors } =
      require('../services/playbookSteps/registry') as typeof import('../services/playbookSteps/registry');
    /* eslint-enable @typescript-eslint/no-require-imports */

    /*
     * Derived from the registry rather than hardcoded. Every descriptor is enforced, including
     * `read`, and only its declared permissions admit dispatch.
     */
    for (const descriptor of listStepTypeDescriptors()) {
      jest.clearAllMocks();
      initiatorHas(...descriptor.requiredPermissions);

      await executeStep(context(descriptor.stepType));

      expect(getUserPermissions).toHaveBeenCalledTimes(1);
    }
  });

  it('names the step and every missing descriptor permission', async () => {
    initiatorHas();

    await expect(executeStep(context('approval-gate'))).rejects.toThrow(
      /notify-the-team.*playbooks:view/i
    );
    expect(executeApprovalGate).not.toHaveBeenCalled();
  });
});
