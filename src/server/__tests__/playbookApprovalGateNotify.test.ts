jest.mock('../db/drizzle', () => ({ db: {} }));

const suspendStepRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/playbookSteps/stepRuns', () => ({
  deadlineFromNow: () => '2026-11-08T00:00:00.000Z',
  prepareStepRun: jest.fn().mockResolvedValue(undefined),
  resumeStepRun: jest.fn(),
  suspendStepRun: (...args: unknown[]) => suspendStepRun(...args),
}));

const snapshotGateAtSuspend = jest.fn();
jest.mock('../services/playbookGateService', () => ({
  snapshotGateAtSuspend: (...args: unknown[]) => snapshotGateAtSuspend(...args),
}));

jest.mock('../services/playbookStepBindings', () => ({
  resolveRunStepConfig: jest.fn().mockResolvedValue({}),
}));

const createNotification = jest.fn().mockResolvedValue({ id: 'n1' });
jest.mock('../services/notificationService', () => ({
  createNotification: (...args: unknown[]) => createNotification(...args),
}));

import { executeApprovalGateStep } from '../services/playbookSteps/approvalGateAdapter';
import type { PlaybookGraph } from '../../shared/types/playbook';

const GRAPH: PlaybookGraph = {
  nodes: [
    { id: 'gate', stepType: 'approval-gate', title: 'Approve the fix', config: {} },
    { id: 'fix', stepType: 'notify', title: 'Ship it', config: { title: 'Ship' } },
  ],
  edges: [{ from: 'gate', to: 'fix' }],
};

function context(config: Record<string, unknown>) {
  return {
    runId: 'run-1',
    stepRunId: 'sr-1',
    stepId: 'gate',
    stepType: 'approval-gate',
    project: 'Apex',
    initiatorUserId: 'owner',
    config,
    graph: GRAPH,
  };
}

describe('approval gate notifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends nothing unless the step turns notifications on', async () => {
    await executeApprovalGateStep(context({ subject: 'Check the fix' }));
    expect(suspendStepRun).toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('notifies the run owner when the run owner approves', async () => {
    await executeApprovalGateStep(context({ subject: 'Check the fix', notifyApprovers: true }));
    expect(createNotification).toHaveBeenCalledWith(
      'owner',
      {
        type: 'user-action',
        title: 'Approval needed: Approve the fix',
        body: 'Check the fix',
        link: '/playbooks/runs/run-1',
      },
      { dedupeKey: 'playbook-gate:sr-1:owner' },
    );
  });

  it('notifies everyone in the reviewer group', async () => {
    snapshotGateAtSuspend.mockResolvedValueOnce({ approvalMode: 'any_one', approverUserIds: ['a', 'b'] });
    await executeApprovalGateStep(
      context({ approverPool: 'prd', gatedStepId: 'fix', notifyApprovers: true }),
    );
    expect(createNotification.mock.calls.map(([userId]) => userId)).toEqual(['a', 'b']);
  });

  it('still waits for a decision when a notification fails', async () => {
    createNotification.mockRejectedValueOnce(new Error('Teams is down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      executeApprovalGateStep(context({ notifyApprovers: true })),
    ).resolves.toEqual({ kind: 'suspended', expiresAt: '2026-11-08T00:00:00.000Z' });
    warn.mockRestore();
  });
});
