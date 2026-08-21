import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RfpDetailDrawer } from '../RfpDetailDrawer';
import { useAddRfpComment, useRfpRequestDetail } from '../../hooks/useRfpIntake';

jest.mock('../../hooks/useRfpIntake', () => ({
  useRfpRequestDetail: jest.fn(),
  useAddRfpComment: jest.fn(),
  useClarifyRfpRequest: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
    isError: false,
    error: null,
  })),
  useRfpEvaluationChat: jest.fn(() => ({
    data: [],
    isLoading: false,
    isError: false,
  })),
  useAskRfpEvaluationChat: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
    isError: false,
    error: null,
  })),
}));

jest.mock('../../hooks/useRfpTriage', () => ({
  useRfpAttachmentUpload: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
    isError: false,
    error: null,
  })),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const mockDetail = useRfpRequestDetail as jest.MockedFunction<typeof useRfpRequestDetail>;
const mockComment = useAddRfpComment as jest.MockedFunction<typeof useAddRfpComment>;

describe('RfpDetailDrawer VT-06 PBI-004', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComment.mockReturnValue({ mutateAsync: jest.fn(), isPending: false, isError: false } as never);
  });

  it('VT-06 AC-1 shows retry guidance without stale success', () => {
    mockDetail.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      refetch: jest.fn(),
    } as never);

    render(<RfpDetailDrawer requestId="rfp-1" onClose={jest.fn()} />);

    expect(screen.getByTestId('rfp-detail-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('rfp-current-evaluation')).not.toBeInTheDocument();
  });

  it('PBI-004 AC-2 shows clarification without triage actions', () => {
    mockDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        id: 'rfp-1',
        ownerId: 'user-1',
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
        status: 'evaluated',
        aiStatus: 'complete',
        aiThreadId: null,
        sourceProject: 'Apex',
        currentEvaluationId: 'ev-1',
        clarificationUsed: false,
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        reviewerDecision: null,
        currentEvaluation: {
          id: 'ev-1',
          rfpRequestId: 'rfp-1',
          version: 1,
          verdict: 'needs-clarification',
          confidence: 'low',
          techVelocity: 'stable',
          nativeBenefit: 'low',
          audience: 'internal',
          dataLeavesTenant: false,
          priority: 'medium',
          risk: 'low',
          deliveryApproach: 'full-code',
          recommendedLane: 'none',
          recommendedTooling: [],
          hostingRecommendation: 'undecided',
          operationalOwner: 'Apex',
          reuseOpportunity: 'none',
          entersInterviewFlow: false,
          buildBuyRentSummary: 'Need more detail',
          rationale: 'Underspecified',
          existingOverlap: 'none',
          clarifyingQuestions: ['Who is the audience?'],
          rawOutput: {} as never,
          committedProductBadge: false,
          createdAt: '2026-08-19T12:00:00.000Z',
        },
        comments: [],
        attachments: [],
        activity: [],
      },
      refetch: jest.fn(),
    } as never);

    render(<RfpDetailDrawer requestId="rfp-1" onClose={jest.fn()} />);

    expect(screen.getByTestId('rfp-clarification-form')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry evaluation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reopen/i })).not.toBeInTheDocument();
  });

  it('widens the drawer when the left edge is dragged', async () => {
    mockDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
      refetch: jest.fn(),
    } as never);

    render(<RfpDetailDrawer requestId="rfp-1" onClose={jest.fn()} />);
    const handle = screen.getByTestId('rfp-detail-resize');
    const panel = handle.closest('aside') as HTMLElement;
    const initialWidth = parseInt(panel.style.width, 10);

    act(() => { fireEvent.mouseDown(handle, { clientX: 600 }); });
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, bubbles: true })); });

    await waitFor(() => {
      expect(parseInt(panel.style.width, 10)).toBeGreaterThan(initialWidth);
    });
  });
});
