/**
 * TBI-025 — the gate-decision path.
 *
 * Covers VT-22 (an approval resumes the gate), VT-23 (a second decision is a no-op), VT-24 (a step
 * that is not awaiting approval is refused) and VT-25 (a suspension with no deadline is refused
 * rather than resumed).
 *
 * VT-25 is the unusual one. BR-005 says a suspension always carries a deadline, so the case being
 * tested should not be reachable — and that is the reason to test it. A gate with no deadline is
 * invisible to the reconciliation sweep: nothing will ever end it. Approving it anyway would
 * produce a run that looks fine and hides the write path that created it.
 */
const selectLimit = jest.fn();
const resumeStepRun = jest.fn();
const recordDecision = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => selectLimit() }) }) }),
    }),
    update: () => ({ set: () => ({ where: () => recordDecision() }) }),
  },
}));

jest.mock('../services/playbookSteps/stepRuns', () => ({
  resumeStepRun: (...a: unknown[]) => resumeStepRun(...a),
}));

import {
  ApprovalMissingDeadlineError,
  ApprovalNotAwaitingError,
  ApprovalNotPermittedError,
  submitApprovalDecision,
} from '../services/playbookSteps/approvalGateAdapter';

const STEP_RUN_ID = 'step-run-gate';
const RUN_ID = 'run-1';
const INITIATOR = 'user-who-started-it';
const DEADLINE = '2026-09-20T12:00:00.000Z';

/** The gate row as the decision path will find it. */
function gateIs(overrides: Record<string, unknown> = {}): void {
  selectLimit.mockResolvedValue([
    {
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
      stepType: 'approval-gate',
      status: 'suspended',
      expiresAt: DEADLINE,
      initiatorUserId: INITIATOR,
      ...overrides,
    },
  ]);
}

function decide(overrides: Record<string, unknown> = {}) {
  return submitApprovalDecision({
    stepRunId: STEP_RUN_ID,
    runId: RUN_ID,
    deciderUserId: INITIATOR,
    decision: 'approved',
    ...overrides,
  } as Parameters<typeof submitApprovalDecision>[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  gateIs();
  resumeStepRun.mockResolvedValue(true);
  recordDecision.mockResolvedValue(undefined);
});

describe('VT-22 — an approval resumes the gate', () => {
  it('resumes the step and reports the decision as recorded', async () => {
    const result = await decide();

    expect(result.outcome).toBe('recorded');
    expect(resumeStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ stepRunId: STEP_RUN_ID })
    );
  });

  it('records a rejection without resuming the run as though it were approved', async () => {
    const result = await decide({ decision: 'rejected' });

    expect(result.outcome).toBe('recorded');
    // The decision must reach the step output either way; what must not happen is a rejected gate
    // being indistinguishable from an approved one downstream.
    const call = resumeStepRun.mock.calls[0]?.[0] as { output?: Record<string, unknown> };
    expect(JSON.stringify(call?.output ?? {})).toContain('rejected');
  });
});

describe('VT-23 — a second decision on the same gate is a no-op', () => {
  it('reports already-decided for a gate that already completed', async () => {
    gateIs({ status: 'completed' });

    await expect(decide()).resolves.toEqual({ outcome: 'already-decided' });
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('reports already-decided for a gate that expired before anyone answered', async () => {
    gateIs({ status: 'expired' });

    await expect(decide()).resolves.toEqual({ outcome: 'already-decided' });
    expect(resumeStepRun).not.toHaveBeenCalled();
  });
});

describe('VT-24 — a step not awaiting approval is refused', () => {
  it.each(['pending', 'running'])('refuses a %s step', async (status) => {
    gateIs({ status });

    await expect(decide()).rejects.toBeInstanceOf(ApprovalNotAwaitingError);
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('refuses a step of a different type', async () => {
    gateIs({ stepType: 'notify' });

    await expect(decide()).rejects.toBeInstanceOf(ApprovalNotPermittedError);
  });

  it('refuses a step belonging to a different run', async () => {
    gateIs({ runId: 'some-other-run' });

    await expect(decide()).rejects.toBeInstanceOf(ApprovalNotPermittedError);
  });

  it('refuses a decider who did not start the run', async () => {
    await expect(decide({ deciderUserId: 'somebody-else' })).rejects.toBeInstanceOf(
      ApprovalNotPermittedError
    );
  });
});

describe('VT-25 — a suspension with no deadline is refused, not resumed', () => {
  it('refuses rather than quietly approving a gate the sweep cannot see', async () => {
    gateIs({ expiresAt: null });

    await expect(decide()).rejects.toBeInstanceOf(ApprovalMissingDeadlineError);
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('says why, rather than reporting a generic failure', async () => {
    gateIs({ expiresAt: null });

    await expect(decide()).rejects.toThrow(/no deadline/i);
  });
});
