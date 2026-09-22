import { fireEvent, render, screen } from '@testing-library/react';
import { PlaybookGateReviewPanel } from '../PlaybookGateReviewPanel';
import type { PlaybookRunDetail } from '../../../shared/types/playbook';

const mutate = jest.fn();
const usePlaybookGate = jest.fn();

jest.mock('../../hooks/usePlaybookRuns', () => ({
  PlaybookRunApiError: class PlaybookRunApiError extends Error {},
  usePlaybookGate: (...args: unknown[]) => usePlaybookGate(...args),
  usePlaybookGateDecision: () => ({ mutate, isPending: false }),
}));

const run: PlaybookRunDetail = {
  runId: 'run-1',
  project: 'Apex',
  definitionName: 'Validation',
  definitionVersionId: 'version-1',
  versionNumber: 1,
  status: 'suspended',
  initiatorUserId: 'owner',
  startedAt: '2026-09-22T12:00:00.000Z',
  completedAt: null,
  currentStepId: 'gate',
  suspension: {
    stepId: 'gate',
    reason: 'approval_gate',
    deadline: '2026-09-23T12:00:00.000Z',
  },
  steps: [{
    id: 'step-run-1',
    runId: 'run-1',
    stepId: 'gate',
    stepType: 'approval-gate',
    status: 'suspended',
    agentRunId: null,
    resumeToken: null,
    outputInline: null,
    outputBlobRef: null,
    expiresAt: '2026-09-23T12:00:00.000Z',
    startedAt: '2026-09-22T12:00:00.000Z',
    completedAt: null,
    createdAt: '2026-09-22T12:00:00.000Z',
    updatedAt: '2026-09-22T12:00:00.000Z',
  }],
};

describe('PlaybookGateReviewPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePlaybookGate.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        runId: 'run-1',
        stepRunId: 'step-run-1',
        subject: 'Review release',
        deadline: '2026-09-23T12:00:00.000Z',
        approvalMode: 'all_required',
        eligibleApproverCount: 2,
        currentUserDecision: null,
        hasInputFields: true,
        canDecide: true,
        fields: [{ path: 'targetUrl', label: 'Target Url', value: 'https://example.test' }],
      },
    });
  });

  it('renders labeled fields and accessible decision controls', () => {
    render(<PlaybookGateReviewPanel project="Apex" run={run} />);
    expect(screen.getByText('Target Url')).toBeInTheDocument();
    expect(screen.getByText('https://example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('playbook-gate-approve'));
    expect(mutate).toHaveBeenCalledWith({ decision: 'approved' });
  });

  it('renders an empty labeled input section', () => {
    usePlaybookGate.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        subject: 'Empty step',
        approvalMode: 'any_one',
        hasInputFields: false,
        canDecide: true,
        fields: [],
      },
    });
    render(<PlaybookGateReviewPanel project="Apex" run={run} />);
    expect(screen.getByText('Resolved inputs')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-gate-empty-inputs')).toBeInTheDocument();
  });
});
