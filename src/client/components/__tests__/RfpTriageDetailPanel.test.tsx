import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RfpTriageDetailPanel } from '../RfpTriageDetailPanel';
import { useAddRfpComment } from '../../hooks/useRfpIntake';
import { useRfpAttachmentUpload, useRfpMentionCandidates, useRfpTriageDetail } from '../../hooks/useRfpTriage';
import { RFP_ATTACHMENT_MAX_BYTES } from '../../../shared/types/rfpIntake';

jest.mock('../../hooks/useRfpIntake', () => ({
  useAddRfpComment: jest.fn(),
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
  useRfpTriageDetail: jest.fn(),
  useRfpAttachmentUpload: jest.fn(),
  useRfpMentionCandidates: jest.fn(),
  useRfpStatusTransition: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null })),
  useRfpReopen: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null })),
  useApplyRfpReviewerDecision: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null })),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const mockDetail = useRfpTriageDetail as jest.MockedFunction<typeof useRfpTriageDetail>;
const mockComment = useAddRfpComment as jest.MockedFunction<typeof useAddRfpComment>;
const mockUpload = useRfpAttachmentUpload as jest.MockedFunction<typeof useRfpAttachmentUpload>;
const mockMentions = useRfpMentionCandidates as jest.MockedFunction<typeof useRfpMentionCandidates>;

const detail = {
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
    verdict: 'build',
    confidence: 'high',
    techVelocity: 'stable',
    nativeBenefit: 'high',
    audience: 'internal',
    dataLeavesTenant: false,
    priority: 'high',
    risk: 'low',
    deliveryApproach: 'full-code',
    recommendedLane: 'committed-product',
    recommendedTooling: ['Apex SDLC'],
    hostingRecommendation: 'apex-managed-aws',
    operationalOwner: 'People Operations',
    reuseOpportunity: 'none',
    entersInterviewFlow: true,
    buildBuyRentSummary: 'Build it.',
    rationale: 'Native fit.',
    existingOverlap: 'none',
    clarifyingQuestions: [],
    rawOutput: {} as never,
    committedProductBadge: true,
    createdAt: '2026-08-19T12:00:00.000Z',
  },
  comments: [],
  attachments: [],
  activity: [{ id: 'evt-1', rfpRequestId: 'rfp-1', eventType: 'submitted', actorId: 'owner-1', payload: null, createdAt: '2026-08-19T12:00:00.000Z' }],
  evaluations: [],
};

describe('RfpTriageDetailPanel PBI-006', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComment.mockReturnValue({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null } as never);
    mockUpload.mockReturnValue({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null } as never);
    mockMentions.mockReturnValue({ data: [{ userId: 'owner-1', displayName: 'Owner', email: 'owner@example.com' }] } as never);
    mockDetail.mockReturnValue({
      isLoading: false,
      isError: false,
      data: detail,
      refetch: jest.fn(),
    } as never);
  });

  it('PBI-006 AC-0 shows mention suggestions from Apex candidates', () => {
    render(<RfpTriageDetailPanel requestId="rfp-1" canManage onClose={jest.fn()} />);
    fireEvent.change(screen.getByTestId('rfp-comment-input'), { target: { value: 'Need a screenshot @Ow' } });
    expect(screen.getByTestId('rfp-mention-picker')).toBeInTheDocument();
    expect(screen.getByTestId('rfp-mention-owner-1')).toHaveTextContent('Owner');
  });

  it('PBI-006 AC-3 rejects a sixth or oversized attachment without posting', () => {
    const mutateAsync = jest.fn();
    mockComment.mockReturnValue({ mutateAsync, isPending: false, isError: false, error: null } as never);
    render(<RfpTriageDetailPanel requestId="rfp-1" canManage onClose={jest.fn()} />);

    const huge = new File(['pdf'], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(huge, 'size', { value: RFP_ATTACHMENT_MAX_BYTES + 1 });
    fireEvent.change(screen.getByTestId('rfp-attachment-input'), { target: { files: [huge] } });
    expect(screen.getByRole('alert')).toHaveTextContent(/exceeds 10 MB/i);

    const extra = Array.from({ length: 6 }, (_, index) => new File(['ok'], `shot-${index}.png`, { type: 'image/png' }));
    fireEvent.change(screen.getByTestId('rfp-attachment-input'), { target: { files: extra } });
    expect(screen.getByRole('alert')).toHaveTextContent(/at most 5 attachments/i);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('widens the drawer when the left edge is dragged', async () => {
    render(<RfpTriageDetailPanel requestId="rfp-1" canManage onClose={jest.fn()} />);
    const handle = screen.getByTestId('rfp-triage-resize');
    const panel = handle.closest('aside') as HTMLElement;
    const initialWidth = parseInt(panel.style.width, 10);

    act(() => { fireEvent.mouseDown(handle, { clientX: 600 }); });
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, bubbles: true })); });

    await waitFor(() => {
      expect(parseInt(panel.style.width, 10)).toBeGreaterThan(initialWidth);
    });
  });
});
