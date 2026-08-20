import { fireEvent, render, screen } from '@testing-library/react';
import { RfpStatusControl } from '../RfpStatusControl';
import { useRfpReopen, useRfpStatusTransition } from '../../hooks/useRfpTriage';
import type { RfpTriageDetail } from '../../../shared/types/rfpIntake';

jest.mock('../../hooks/useRfpTriage', () => ({
  useRfpStatusTransition: jest.fn(),
  useRfpReopen: jest.fn(),
}));

const mockTransition = useRfpStatusTransition as jest.MockedFunction<typeof useRfpStatusTransition>;
const mockReopen = useRfpReopen as jest.MockedFunction<typeof useRfpReopen>;

function detail(status: RfpTriageDetail['status']): RfpTriageDetail {
  return {
    id: 'rfp-1',
    ownerId: 'owner-1',
    title: 'Tracker',
    stakeholder: 'BA',
    request: 'Need intake',
    problem: 'Fragmented',
    audience: 'internal',
    dataSensitivity: 'internal-only',
    existingSolution: 'none',
    advantage: null,
    constraints: null,
    requestType: null,
    existingSystemStack: null,
    status,
    aiStatus: 'complete',
    aiThreadId: null,
    sourceProject: 'Apex',
    currentEvaluationId: 'ev-1',
    clarificationUsed: false,
    createdAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    currentEvaluation: null,
    reviewerDecision: null,
    comments: [],
    attachments: [],
    activity: [],
    evaluations: [],
  };
}

describe('RfpStatusControl PBI-005', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransition.mockReturnValue({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null } as never);
    mockReopen.mockReturnValue({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null } as never);
  });

  it('PBI-005 AC-2 offers In Review from On Hold and audited Reopen from Accepted', () => {
    const { rerender } = render(<RfpStatusControl detail={detail('on-hold')} canManage />);
    expect(screen.getByTestId('rfp-status-in-review')).toBeInTheDocument();
    expect(screen.queryByTestId('rfp-reopen-button')).not.toBeInTheDocument();

    rerender(<RfpStatusControl detail={detail('accepted')} canManage />);
    expect(screen.getByTestId('rfp-reopen-button')).toBeInTheDocument();
    expect(screen.queryByTestId('rfp-status-in-review')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rfp-reopen-button'));
    expect(screen.getByTestId('rfp-reopen-confirm')).toHaveAttribute('role', 'alertdialog');
  });

  it('PBI-005 AC-1 keeps the previous status visible when a transition fails', () => {
    mockTransition.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
      isError: true,
      error: new Error('Invalid status transition'),
    } as never);
    render(<RfpStatusControl detail={detail('evaluated')} canManage />);
    expect(screen.getByText(/current status: evaluated/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/invalid status transition/i);
  });

  it('PBI-005 AC-3 hides status controls without manage permission', () => {
    render(<RfpStatusControl detail={detail('evaluated')} canManage={false} />);
    expect(screen.queryByTestId('rfp-status-control')).not.toBeInTheDocument();
  });
});
