import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RfpRequestWizard } from '../RfpRequestWizard';
import { useAddRfpComment, useApproveRfpProposal, useRejectRfpProposal, useRfpRequestDetail } from '../../hooks/useRfpIntake';
import {
  useDeleteIntakeProject,
  usePublishRfpProposal,
  useRegenerateRfpProposal,
  useRfpAttachmentUpload,
  useRfpMentionCandidates,
  useRfpTriageDetail,
  useSaveRfpProposalDraft,
  useSubmitRfpReview,
} from '../../hooks/useRfpTriage';
import { RFP_ATTACHMENT_MAX_BYTES } from '../../../shared/types/rfpIntake';
import type {
  RfpArchitecture,
  RfpCostLine,
  RfpDecisionSummaryDraft,
  RfpProposal,
  RfpProposalDraft,
  RfpProposalGeneration,
  RfpTriageDetail,
} from '../../../shared/types/rfpIntake';

const idleMutation = () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false, isError: false, error: null });

jest.mock('../../hooks/useRfpIntake', () => ({
  useRfpRequestDetail: jest.fn(),
  useAddRfpComment: jest.fn(),
  useApproveRfpProposal: jest.fn(),
  useRejectRfpProposal: jest.fn(),
  useClarifyRfpRequest: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null })),
  useRfpEvaluationChat: jest.fn(() => ({ data: [], isLoading: false, isError: false })),
  useAskRfpEvaluationChat: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null })),
}));

jest.mock('../../hooks/useRfpTriage', () => ({
  useRfpTriageDetail: jest.fn(),
  useRfpAttachmentUpload: jest.fn(),
  useRfpMentionCandidates: jest.fn(),
  useSubmitRfpReview: jest.fn(),
  useRegenerateRfpProposal: jest.fn(),
  useSaveRfpProposalDraft: jest.fn(),
  usePublishRfpProposal: jest.fn(),
  useDeleteIntakeProject: jest.fn(),
  useRfpStatusTransition: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null })),
  useRfpReopen: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null })),
  useApplyRfpReviewerDecision: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null })),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const mockRequesterDetail = useRfpRequestDetail as jest.MockedFunction<typeof useRfpRequestDetail>;
const mockTriageDetail = useRfpTriageDetail as jest.MockedFunction<typeof useRfpTriageDetail>;
const mockComment = useAddRfpComment as jest.MockedFunction<typeof useAddRfpComment>;
const mockApprove = useApproveRfpProposal as jest.MockedFunction<typeof useApproveRfpProposal>;
const mockReject = useRejectRfpProposal as jest.MockedFunction<typeof useRejectRfpProposal>;
const mockUpload = useRfpAttachmentUpload as jest.MockedFunction<typeof useRfpAttachmentUpload>;
const mockMentions = useRfpMentionCandidates as jest.MockedFunction<typeof useRfpMentionCandidates>;
const mockSubmitReview = useSubmitRfpReview as jest.MockedFunction<typeof useSubmitRfpReview>;
const mockRegenerate = useRegenerateRfpProposal as jest.MockedFunction<typeof useRegenerateRfpProposal>;
const mockSaveDraft = useSaveRfpProposalDraft as jest.MockedFunction<typeof useSaveRfpProposalDraft>;
const mockPublish = usePublishRfpProposal as jest.MockedFunction<typeof usePublishRfpProposal>;
const mockDeleteProject = useDeleteIntakeProject as jest.MockedFunction<typeof useDeleteIntakeProject>;

const NOW = '2026-09-21T12:00:00.000Z';

const ARCHITECTURE: RfpArchitecture = {
  appType: 'web',
  resources: ['rds', 'monitoring'],
  requiresAi: true,
  domainName: 'tracker.apex.example.com',
  sizing: {
    region: 'us-west',
    sizingProfile: 'large',
    environmentCount: 3,
    uptimePattern: 'always-on',
    storageGb: 500,
    aiUsage: 'heavy',
  },
  updatedBy: 'mgr-1',
  updatedAt: '2026-09-20T12:00:00.000Z',
};

function costLine(overrides: Partial<RfpCostLine> = {}): RfpCostLine {
  return {
    id: 'rds-prod',
    label: 'Production database',
    category: 'operating',
    cadence: 'monthly',
    quantity: 730,
    unit: 'instance-hour',
    unitPrice: 0.16,
    amounts: { low: 100, expected: 120, high: 140 },
    currency: 'USD',
    priceStatus: 'verified',
    sourceType: 'aws-price-list',
    sourceUrl: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-west-2/index.json',
    sourceTitle: 'AWS Price List — Amazon RDS',
    retrievedAt: NOW,
    confidence: 'high',
    assumptions: [],
    adminConfirmed: false,
    ...overrides,
  };
}

const IMPLEMENTATION_LINE = costLine({
  id: 'implementation-1',
  label: 'Build and launch',
  category: 'implementation',
  cadence: 'one-time',
  quantity: 8,
  unit: 'person-week',
  unitPrice: null,
  amounts: null,
  priceStatus: 'estimate',
  sourceType: 'internal-estimate',
  sourceUrl: null,
  sourceTitle: null,
  retrievedAt: null,
  confidence: 'medium',
  assumptions: ['Effort estimate: 6–12 person-weeks (expected 8).'],
});

const PROPOSAL_DRAFT: RfpProposalDraft = {
  version: 1,
  kind: 'proposal',
  jobId: 'job-1',
  inputFingerprint: 'fp-1',
  verdict: 'build',
  generatedAt: NOW,
  editedBy: null,
  editedAt: null,
  sections: {
    executiveSummary: 'Build a tracker for People Ops.',
    recommendedSolution: 'A small web app.',
    scope: ['Task lists', 'Reminders'],
    deliveryPhases: [{ name: 'Build', duration: '6 weeks', outcomes: ['Working app'] }],
    timeline: 'About eight weeks.',
    assumptions: ['Two environments'],
    exclusions: ['Payroll'],
    risks: [{ risk: 'Low adoption', mitigation: 'Pilot group first' }],
    securityAndData: 'Employee data stays in the company cloud.',
    ownership: 'People Ops owns it.',
    nextSteps: ['Approve the proposal'],
  },
  costLines: [costLine(), IMPLEMENTATION_LINE],
  totals: {
    oneTime: { low: 0, expected: 0, high: 0 },
    monthly: { low: 100, expected: 120, high: 140 },
    annual: { low: 1200, expected: 1440, high: 1680 },
    unpricedLineCount: 1,
  },
};

const PRICED_DRAFT: RfpProposalDraft = {
  ...PROPOSAL_DRAFT,
  costLines: [
    costLine({ adminConfirmed: true }),
    { ...IMPLEMENTATION_LINE, amounts: { low: 30000, expected: 40000, high: 60000 }, adminConfirmed: true },
  ],
  totals: {
    oneTime: { low: 30000, expected: 40000, high: 60000 },
    monthly: { low: 100, expected: 120, high: 140 },
    annual: { low: 1200, expected: 1440, high: 1680 },
    unpricedLineCount: 0,
  },
};

const DECISION_DRAFT: RfpDecisionSummaryDraft = {
  version: 1,
  kind: 'decision-summary',
  jobId: 'job-1',
  inputFingerprint: 'fp-d',
  verdict: 'decline',
  generatedAt: NOW,
  editedBy: null,
  editedAt: null,
  summary: 'Apex will not build this.',
  reasons: ['An existing licensed tool covers it'],
  alternatives: ['Use the existing tool'],
  nextSteps: ['Contact IT'],
};

const PROPOSAL: RfpProposal = {
  document: PRICED_DRAFT,
  productOwnerId: 'po-1',
  productOwnerName: 'Pat Owner',
  publishedBy: 'mgr-1',
  publishedAt: NOW,
};

function generation(overrides: Partial<RfpProposalGeneration> = {}): RfpProposalGeneration {
  return {
    jobId: 'job-1',
    kind: 'proposal',
    status: 'ready',
    attempts: 1,
    maxAttempts: 3,
    errorMessage: null,
    queuedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<RfpTriageDetail> = {}): RfpTriageDetail {
  return {
    id: 'rfp-1',
    ownerId: 'owner-1',
    title: 'Tracker',
    stakeholder: 'BA',
    request: 'Need intake',
    problem: 'Fragmented',
    audience: 'internal',
    dataSensitivity: 'internal-only',
    existingSolution: 'Spreadsheets',
    advantage: null,
    constraints: null,
    requestType: null,
    existingSystemStack: null,
    expectedUsers: 'medium',
    aiInApp: 'yes',
    architecture: null,
    reviewSubmittedAt: null,
    reviewSubmittedBy: null,
    proposalGeneration: null,
    proposalDraft: null,
    proposal: null,
    approval: null,
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
      recommendedTooling: [],
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
    ...overrides,
  } as RfpTriageDetail;
}

function withVerdict(verdict: 'decline' | 'needs-clarification', overrides: Partial<RfpTriageDetail> = {}) {
  const detail = makeDetail(overrides);
  detail.currentEvaluation = { ...detail.currentEvaluation!, verdict };
  return detail;
}

const SUBMITTED = { architecture: ARCHITECTURE, reviewSubmittedAt: NOW, reviewSubmittedBy: 'mgr-1' };

function loaded(data: RfpTriageDetail | undefined, extra: Record<string, unknown> = {}) {
  return { isLoading: false, isError: false, data, refetch: jest.fn(), ...extra } as never;
}

function renderRequester(detail = makeDetail()) {
  mockRequesterDetail.mockReturnValue(loaded(detail));
  return render(<RfpRequestWizard mode="requester" requestId="rfp-1" canManage={false} onClose={jest.fn()} />);
}

function renderTriage(detail = makeDetail(), canManage = true) {
  mockTriageDetail.mockReturnValue(loaded(detail));
  return render(<RfpRequestWizard mode="triage" requestId="rfp-1" canManage={canManage} onClose={jest.fn()} />);
}

function goToStep(step: 1 | 2 | 3) {
  fireEvent.click(screen.getByTestId(`rfp-wizard-step-${step}`));
}

describe('RfpRequestWizard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequesterDetail.mockReturnValue(loaded(undefined));
    mockTriageDetail.mockReturnValue(loaded(undefined));
    mockComment.mockReturnValue(idleMutation() as never);
    mockApprove.mockReturnValue(idleMutation() as never);
    mockReject.mockReturnValue(idleMutation() as never);
    mockUpload.mockReturnValue(idleMutation() as never);
    mockSubmitReview.mockReturnValue(idleMutation() as never);
    mockRegenerate.mockReturnValue(idleMutation() as never);
    mockSaveDraft.mockReturnValue(idleMutation() as never);
    mockPublish.mockReturnValue(idleMutation() as never);
    mockDeleteProject.mockReturnValue(idleMutation() as never);
    mockMentions.mockReturnValue({ data: [{ userId: 'po-1', displayName: 'Pat Owner', email: 'pat@example.com' }] } as never);
  });

  describe('WZ-0 centered three-step dialog', () => {
    it('WZ-0 renders a modal dialog with Request, Review, and Proposal steps', () => {
      renderRequester();
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(screen.getByTestId('rfp-wizard-step-1')).toHaveTextContent('Request');
      expect(screen.getByTestId('rfp-wizard-step-2')).toHaveTextContent('Review');
      expect(screen.getByTestId('rfp-wizard-step-3')).toHaveTextContent('Proposal');
      expect(screen.getByTestId('rfp-wizard-step-1')).toHaveAttribute('aria-current', 'step');
    });

    it('WZ-0 opens on the Proposal step once a proposal is published', () => {
      renderRequester(makeDetail({ architecture: ARCHITECTURE, proposal: PROPOSAL }));
      expect(screen.getByTestId('rfp-wizard-step-3')).toHaveAttribute('aria-current', 'step');
      expect(screen.getByTestId('rfp-proposal-document')).toBeInTheDocument();
    });

    it('WZ-0 moves forward and back with Next and Back', () => {
      renderRequester();
      fireEvent.click(screen.getByTestId('rfp-wizard-next'));
      expect(screen.getByTestId('rfp-wizard-step-2')).toHaveAttribute('aria-current', 'step');
      fireEvent.click(screen.getByTestId('rfp-wizard-back'));
      expect(screen.getByTestId('rfp-wizard-step-1')).toHaveAttribute('aria-current', 'step');
    });

    it('WZ-0 keeps Proposal locked for admins until the review is submitted', () => {
      const first = renderTriage(makeDetail({ architecture: ARCHITECTURE }));
      expect(screen.getByTestId('rfp-wizard-step-2')).toBeEnabled();
      expect(screen.getByTestId('rfp-wizard-step-3')).toBeDisabled();
      first.unmount();

      renderTriage(makeDetail({ ...SUBMITTED, proposalGeneration: generation({ status: 'queued' }) }));
      expect(screen.getByTestId('rfp-wizard-step-3')).toBeEnabled();
    });

    it('WZ-0 keeps Proposal locked for requesters until a proposal is published', () => {
      renderRequester(makeDetail({ ...SUBMITTED }));
      expect(screen.getByTestId('rfp-wizard-step-3')).toBeDisabled();
    });

    it('WZ-0 keeps Proposal locked while the verdict is Needs clarification', () => {
      renderTriage(withVerdict('needs-clarification', SUBMITTED));
      expect(screen.getByTestId('rfp-wizard-step-3')).toBeDisabled();
    });

    it('WZ-0 closes on Escape', () => {
      const onClose = jest.fn();
      mockRequesterDetail.mockReturnValue(loaded(makeDetail()));
      render(<RfpRequestWizard mode="requester" requestId="rfp-1" canManage={false} onClose={onClose} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();
    });

    it('WZ-0 stays open when the backdrop is clicked', () => {
      const onClose = jest.fn();
      mockRequesterDetail.mockReturnValue(loaded(makeDetail()));
      render(<RfpRequestWizard mode="requester" requestId="rfp-1" canManage={false} onClose={onClose} />);
      fireEvent.click(screen.getByTestId('rfp-wizard-overlay'));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('WZ-0 uses the triage detail endpoint in triage mode', () => {
      renderTriage();
      expect(mockTriageDetail).toHaveBeenCalledWith('rfp-1', true);
      expect(mockRequesterDetail).toHaveBeenCalledWith('rfp-1', false);
    });
  });

  describe('WZ-1 Request step', () => {
    it('WZ-1 shows the intake, including expected users and AI intent', () => {
      renderRequester();
      const intake = screen.getByTestId('rfp-wizard-intake');
      expect(intake).toHaveTextContent('Need intake');
      expect(intake).toHaveTextContent('Medium (101–500)');
      expect(intake).toHaveTextContent('Yes');
      expect(intake).toHaveTextContent('BA');
      expect(intake).toHaveTextContent('Advantage');
      expect(intake).toHaveTextContent('Constraints');
      expect(intake).toHaveTextContent('Request type');
      expect(intake).toHaveTextContent('Existing system stack');
      expect(intake).toHaveTextContent('Attachments');
      expect(intake).toHaveTextContent('Not answered');
      expect(screen.queryByTestId('rfp-current-evaluation')).not.toBeInTheDocument();
    });

    it('WZ-2 shows the current evaluation on Review', () => {
      renderRequester();
      goToStep(2);
      expect(screen.getByTestId('rfp-current-evaluation')).toBeInTheDocument();
    });

    it('WZ-1 shows retry guidance without stale success when loading fails', () => {
      mockRequesterDetail.mockReturnValue(loaded(undefined, { isError: true }));
      render(<RfpRequestWizard mode="requester" requestId="rfp-1" canManage={false} onClose={jest.fn()} />);
      expect(screen.getByTestId('rfp-wizard-retry')).toBeInTheDocument();
      expect(screen.queryByTestId('rfp-current-evaluation')).not.toBeInTheDocument();
    });

    it('WZ-1 offers clarification to the requester only', () => {
      const needsClarification = makeDetail();
      needsClarification.currentEvaluation = {
        ...needsClarification.currentEvaluation!,
        verdict: 'needs-clarification',
        clarifyingQuestions: ['Who is the audience?'],
      };
      const { unmount } = renderRequester(needsClarification);
      goToStep(2);
      expect(screen.getByTestId('rfp-clarification-form')).toBeInTheDocument();
      unmount();

      renderTriage(needsClarification);
      goToStep(2);
      expect(screen.queryByTestId('rfp-clarification-form')).not.toBeInTheDocument();
    });
  });

  describe('WZ-2 Review step discussion', () => {
    it('WZ-2 associates attachments with comments and names activity actors', () => {
      renderRequester(makeDetail({
        comments: [{
          id: 'comment-1',
          rfpRequestId: 'rfp-1',
          authorId: 'owner-1',
          authorName: 'Riley Manager',
          body: 'Any update here?',
          mentionedUserIds: [],
          createdAt: '2026-08-19T12:01:00.000Z',
        }],
        attachments: [{
          id: 'attachment-1',
          rfpRequestId: 'rfp-1',
          commentId: 'comment-1',
          filename: 'Interview-Flow.png',
          contentType: 'image/png',
          sizeBytes: 100,
          storageKey: 'rfp-1/attachment-1',
          createdAt: '2026-08-19T12:01:00.000Z',
        }],
        activity: [
          {
            id: 'evt-1',
            rfpRequestId: 'rfp-1',
            eventType: 'submitted',
            actorId: 'owner-1',
            actorName: 'Riley Manager',
            payload: null,
            createdAt: '2026-08-19T12:00:00.000Z',
          },
          {
            id: 'evt-2',
            rfpRequestId: 'rfp-1',
            eventType: 'evaluation-completed',
            actorId: null,
            actorName: 'Apex Bot',
            payload: null,
            createdAt: '2026-08-19T12:02:00.000Z',
          },
        ],
      }));
      goToStep(2);

      const comment = screen.getByTestId('rfp-comment-comment-1');
      expect(comment).toHaveTextContent('Riley Manager');
      expect(comment).toHaveTextContent('Any update here?');
      expect(within(comment).getByTestId('rfp-attachment-attachment-1')).toHaveTextContent('Interview-Flow.png');
      expect(screen.getByTestId('rfp-activity-list')).toHaveTextContent('Submitted · Riley Manager');
      expect(screen.getByTestId('rfp-activity-list')).toHaveTextContent('Evaluation Completed · Apex Bot');
    });

    it('WZ-2 shows mention suggestions in triage mode', () => {
      renderTriage();
      goToStep(2);
      fireEvent.change(screen.getByTestId('rfp-comment-input'), { target: { value: 'Need a screenshot @Pa' } });
      expect(screen.getByTestId('rfp-mention-picker')).toBeInTheDocument();
      expect(screen.getByTestId('rfp-mention-po-1')).toHaveTextContent('Pat Owner');
    });

    it('WZ-2 rejects a sixth or oversized attachment without posting', () => {
      const mutateAsync = jest.fn();
      mockComment.mockReturnValue({ ...idleMutation(), mutateAsync } as never);
      renderRequester();
      goToStep(2);

      const huge = new File(['pdf'], 'huge.pdf', { type: 'application/pdf' });
      Object.defineProperty(huge, 'size', { value: RFP_ATTACHMENT_MAX_BYTES + 1 });
      fireEvent.change(screen.getByTestId('rfp-attachment-input'), { target: { files: [huge] } });
      expect(screen.getByRole('alert')).toHaveTextContent(/exceeds 10 MB/i);

      const extra = Array.from({ length: 6 }, (_, index) => new File(['ok'], `shot-${index}.png`, { type: 'image/png' }));
      fireEvent.change(screen.getByTestId('rfp-attachment-input'), { target: { files: extra } });
      expect(screen.getByRole('alert')).toHaveTextContent(/at most 5 attachments/i);
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('WZ-2 posts a comment with its text', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({});
      mockComment.mockReturnValue({ ...idleMutation(), mutateAsync } as never);
      renderRequester();
      goToStep(2);
      fireEvent.change(screen.getByTestId('rfp-comment-input'), { target: { value: 'Any update?' } });
      fireEvent.click(screen.getByTestId('rfp-comment-submit'));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ id: 'rfp-1', body: 'Any update?' })));
    });

    it('CM-0 disables Post comment until the comment has text', () => {
      renderRequester();
      goToStep(2);
      expect(screen.getByTestId('rfp-comment-submit')).toBeDisabled();
      fireEvent.change(screen.getByTestId('rfp-comment-input'), { target: { value: '   ' } });
      expect(screen.getByTestId('rfp-comment-submit')).toBeDisabled();
      fireEvent.change(screen.getByTestId('rfp-comment-input'), { target: { value: 'Ready' } });
      expect(screen.getByTestId('rfp-comment-submit')).toBeEnabled();
    });

    it('CM-0 disables Post comment while a comment is posting', () => {
      mockComment.mockReturnValue({ ...idleMutation(), isPending: true } as never);
      renderRequester();
      goToStep(2);
      fireEvent.change(screen.getByTestId('rfp-comment-input'), { target: { value: 'Ready' } });
      expect(screen.getByTestId('rfp-comment-submit')).toBeDisabled();
    });

    it('WZ-2 lists the activity trail', () => {
      renderRequester();
      goToStep(2);
      expect(screen.getByTestId('rfp-activity-list')).toHaveTextContent('Submitted');
      expect(screen.getByTestId('rfp-activity-list')).toHaveTextContent('User');
      expect(screen.getByTestId('rfp-activity-list')).not.toHaveTextContent('owner-1');
    });
  });

  describe('AP-0 architecture and sizing', () => {
    it('AP-0 is editable only by managers', () => {
      const { unmount } = renderTriage(makeDetail(), false);
      goToStep(2);
      expect(screen.queryByTestId('rfp-architecture-form')).not.toBeInTheDocument();
      expect(screen.queryByTestId('rfp-wizard-submit-review')).not.toBeInTheDocument();
      unmount();

      renderRequester();
      goToStep(2);
      expect(screen.queryByTestId('rfp-architecture-form')).not.toBeInTheDocument();
    });

    it('AP-0 has no separate Save architecture button', () => {
      renderTriage();
      goToStep(2);
      expect(screen.queryByTestId('rfp-arch-submit')).not.toBeInTheDocument();
      expect(screen.getByTestId('rfp-wizard-submit-review')).toHaveTextContent('Submit for proposal');
    });

    it('AP-0 prefills requires-AI and sizing from the intake answers', () => {
      renderTriage(makeDetail({ aiInApp: 'yes', expectedUsers: 'large' }));
      goToStep(2);
      expect(screen.getByTestId('rfp-arch-requires-ai')).toBeChecked();
      expect(screen.getByTestId('rfp-arch-sizing-profile')).toHaveValue('large');
      expect(screen.getByTestId('rfp-arch-uptime')).toHaveValue('always-on');
      expect(screen.getByTestId('rfp-arch-ai-usage')).toHaveValue('heavy');
      expect(screen.getByTestId('rfp-arch-environments-value')).toHaveTextContent('3');
      expect(screen.getByTestId('rfp-arch-storage-value')).toHaveTextContent('500');
    });

    it('AP-0 requires a domain name for web apps', async () => {
      const mutateAsync = jest.fn();
      mockSubmitReview.mockReturnValue({ ...idleMutation(), mutateAsync } as never);
      renderTriage();
      goToStep(2);
      fireEvent.change(screen.getByTestId('rfp-arch-app-type'), { target: { value: 'web' } });
      fireEvent.click(screen.getByTestId('rfp-wizard-submit-review'));
      expect(await screen.findByText('Domain name is required for web apps')).toBeInTheDocument();
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('SR-0 submits the review with the confirmed sizing and opens Proposal', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({});
      mockSubmitReview.mockReturnValue({ ...idleMutation(), mutateAsync } as never);
      renderTriage(makeDetail({ aiInApp: 'no', expectedUsers: 'small' }));
      goToStep(2);
      expect(screen.queryByTestId('rfp-arch-domain')).not.toBeInTheDocument();
      fireEvent.change(screen.getByTestId('rfp-arch-app-type'), { target: { value: 'console' } });
      fireEvent.click(screen.getByTestId('rfp-arch-resource-service-bus'));
      fireEvent.click(screen.getByTestId('rfp-arch-resource-pagerduty'));
      fireEvent.change(screen.getByTestId('rfp-arch-region'), { target: { value: 'us-central' } });
      fireEvent.click(screen.getByTestId('rfp-arch-environments-increase'));
      fireEvent.click(screen.getByTestId('rfp-arch-storage-increase'));
      fireEvent.click(screen.getByTestId('rfp-wizard-submit-review'));
      await waitFor(() =>
        expect(mutateAsync).toHaveBeenCalledWith({
          id: 'rfp-1',
          architecture: {
            appType: 'console',
            resources: ['service-bus', 'pagerduty'],
            requiresAi: false,
            domainName: null,
            sizing: {
              region: 'us-central',
              sizingProfile: 'small',
              environmentCount: 3,
              uptimePattern: 'business-hours',
              storageGb: 30,
              aiUsage: null,
            },
          },
        }),
      );
    });

    it('SR-3 labels the action Save review for Needs clarification and keeps Proposal locked', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({});
      mockSubmitReview.mockReturnValue({ ...idleMutation(), mutateAsync } as never);
      renderTriage(withVerdict('needs-clarification', { architecture: ARCHITECTURE }));
      goToStep(2);
      expect(screen.getByTestId('rfp-wizard-submit-review')).toHaveTextContent('Save review');
      fireEvent.click(screen.getByTestId('rfp-wizard-submit-review'));
      expect(await screen.findByTestId('rfp-review-saved')).toBeInTheDocument();
      expect(screen.getByTestId('rfp-wizard-step-3')).toBeDisabled();
    });

    it('SR-4 submits a Decline decision summary without the architecture form', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({});
      mockSubmitReview.mockReturnValue({ ...idleMutation(), mutateAsync } as never);
      renderTriage(withVerdict('decline'));
      goToStep(2);
      expect(screen.queryByTestId('rfp-architecture-form')).not.toBeInTheDocument();
      expect(screen.getByTestId('rfp-review-decline-note')).toBeInTheDocument();
      expect(screen.getByTestId('rfp-wizard-submit-review')).toHaveTextContent('Submit decision summary');
      fireEvent.click(screen.getByTestId('rfp-wizard-submit-review'));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ id: 'rfp-1', architecture: null }));
    });

    it('SR-5 shows a submission error from the server', () => {
      mockSubmitReview.mockReturnValue({
        ...idleMutation(),
        isError: true,
        error: new Error('Proposal generation is already running'),
      } as never);
      renderTriage();
      goToStep(2);
      expect(screen.getByTestId('rfp-review-submit-error')).toHaveTextContent('Proposal generation is already running');
    });

    it('SR-5 hides the submit action while the evaluation is running', () => {
      renderTriage(makeDetail({ aiStatus: 'evaluating' }));
      goToStep(2);
      expect(screen.queryByTestId('rfp-wizard-submit-review')).not.toBeInTheDocument();
      expect(screen.getByTestId('rfp-evaluation-running')).toBeInTheDocument();
    });

    it('AP-1 shows the saved architecture and sizing read-only to non-managers', () => {
      renderRequester(makeDetail({ architecture: ARCHITECTURE }));
      goToStep(2);
      const summary = screen.getByTestId('rfp-architecture-summary');
      expect(summary).toHaveTextContent('Web');
      expect(summary).toHaveTextContent('RDS');
      expect(summary).toHaveTextContent('Amazon CloudWatch');
      expect(summary).toHaveTextContent('tracker.apex.example.com');
      expect(summary).toHaveTextContent('US West');
      expect(summary).toHaveTextContent('500 GB');
    });
  });

  describe('PG proposal generation', () => {
    it('PG-0 shows progress while prices are researched', () => {
      renderTriage(makeDetail({ ...SUBMITTED, proposalGeneration: generation({ status: 'researching-prices' }) }));
      goToStep(3);
      const progress = screen.getByTestId('rfp-proposal-progress');
      expect(progress).toHaveAttribute('role', 'status');
      expect(screen.getByTestId('rfp-proposal-progress-researching-prices')).toHaveAttribute('aria-current', 'step');
      expect(screen.getByTestId('rfp-proposal-progress-writing')).toBeInTheDocument();
    });

    it('PG-0 skips price research in the decision summary progress', () => {
      renderTriage(withVerdict('decline', {
        reviewSubmittedAt: NOW,
        proposalGeneration: generation({ kind: 'decision-summary', status: 'writing' }),
      }));
      goToStep(3);
      expect(screen.queryByTestId('rfp-proposal-progress-researching-prices')).not.toBeInTheDocument();
      expect(screen.getByTestId('rfp-proposal-progress-writing')).toHaveTextContent('Writing decision summary');
    });

    it('PG-1 shows a failure with a retry', () => {
      const mutate = jest.fn();
      mockRegenerate.mockReturnValue({ ...idleMutation(), mutate } as never);
      renderTriage(makeDetail({
        ...SUBMITTED,
        proposalGeneration: generation({ status: 'failed', attempts: 3, errorMessage: 'Bedrock timed out' }),
      }));
      goToStep(3);
      expect(screen.getByTestId('rfp-proposal-failed')).toHaveTextContent('Bedrock timed out');
      fireEvent.click(screen.getByTestId('rfp-proposal-retry'));
      expect(mutate).toHaveBeenCalledWith({ id: 'rfp-1' });
    });
  });

  describe('PB proposal editing and publishing', () => {
    const readyDetail = (draft: RfpProposalDraft | RfpDecisionSummaryDraft = PROPOSAL_DRAFT) =>
      makeDetail({ ...SUBMITTED, proposalGeneration: generation(), proposalDraft: draft });

    it('PB-0 shows each cost with its source and flags unpriced lines', () => {
      renderTriage(readyDetail());
      goToStep(3);
      const rds = screen.getByTestId('rfp-proposal-cost-rds-prod');
      expect(within(rds).getByTestId('rfp-cost-source-rds-prod')).toHaveAttribute('href', costLine().sourceUrl);
      expect(rds).toHaveTextContent('high confidence');
      expect(screen.getByTestId('rfp-proposal-cost-implementation-1')).toHaveTextContent('Apex estimate');
      expect(screen.getByTestId('rfp-proposal-cost-table')).toHaveTextContent('One cost still needs a price.');
    });

    it('PB-1 blocks publishing until costs are priced, confirmed, and an owner is chosen', async () => {
      const publish = jest.fn();
      const save = jest.fn();
      mockPublish.mockReturnValue({ ...idleMutation(), mutateAsync: publish } as never);
      mockSaveDraft.mockReturnValue({ ...idleMutation(), mutateAsync: save } as never);
      renderTriage(readyDetail());
      goToStep(3);
      fireEvent.click(screen.getByTestId('rfp-proposal-publish'));
      const errors = await screen.findByTestId('rfp-proposal-errors');
      expect(errors).toHaveTextContent('Choose a product owner');
      expect(errors).toHaveTextContent('Build and launch needs an amount');
      expect(errors).toHaveTextContent('Production database needs admin confirmation');
      expect(publish).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it('PB-2 rejects a partial or out-of-order amount range', async () => {
      renderTriage(readyDetail());
      goToStep(3);
      fireEvent.change(screen.getByTestId('rfp-cost-implementation-1-low'), { target: { value: '100' } });
      fireEvent.click(screen.getByTestId('rfp-proposal-save'));
      expect(await screen.findByText('Enter low, expected, and high')).toBeInTheDocument();
    });

    it('PB-3 saves the edited draft, then publishes with the product owner', async () => {
      const save = jest.fn().mockResolvedValue({});
      const publish = jest.fn().mockResolvedValue({});
      mockSaveDraft.mockReturnValue({ ...idleMutation(), mutateAsync: save } as never);
      mockPublish.mockReturnValue({ ...idleMutation(), mutateAsync: publish } as never);
      renderTriage(readyDetail());
      goToStep(3);

      fireEvent.click(screen.getByTestId('rfp-cost-confirm-rds-prod'));
      fireEvent.change(screen.getByTestId('rfp-cost-implementation-1-low'), { target: { value: '30000' } });
      fireEvent.change(screen.getByTestId('rfp-cost-implementation-1-expected'), { target: { value: '40000' } });
      fireEvent.change(screen.getByTestId('rfp-cost-implementation-1-high'), { target: { value: '60000' } });
      fireEvent.click(screen.getByTestId('rfp-cost-confirm-implementation-1'));
      fireEvent.change(screen.getByTestId('rfp-proposal-field-executiveSummary'), { target: { value: 'Edited summary' } });
      fireEvent.change(screen.getByTestId('rfp-proposal-owner-search'), { target: { value: 'Pat' } });
      fireEvent.click(screen.getByTestId('rfp-proposal-owner-po-1'));
      expect(screen.getByTestId('rfp-proposal-one-time-total')).toHaveTextContent('$30,000–$60,000');
      fireEvent.click(screen.getByTestId('rfp-proposal-publish'));

      await waitFor(() => expect(publish).toHaveBeenCalledWith({ id: 'rfp-1', productOwnerId: 'po-1' }));
      const saved = save.mock.calls[0][0].draft as RfpProposalDraft;
      expect(saved.sections.executiveSummary).toBe('Edited summary');
      expect(saved.costLines[1]).toMatchObject({
        amounts: { low: 30000, expected: 40000, high: 60000 },
        adminConfirmed: true,
        sourceType: 'internal-estimate',
      });
      expect(saved.costLines[0].sourceUrl).toBe(costLine().sourceUrl);
      expect(save.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]);
    });

    it('PB-4 regenerates the draft on request', () => {
      const mutate = jest.fn();
      mockRegenerate.mockReturnValue({ ...idleMutation(), mutate } as never);
      renderTriage(readyDetail());
      goToStep(3);
      fireEvent.click(screen.getByTestId('rfp-proposal-regenerate'));
      expect(mutate).toHaveBeenCalledWith({ id: 'rfp-1' });
    });

    it('PB-5 edits and publishes a Decline decision summary without a product owner', async () => {
      const save = jest.fn().mockResolvedValue({});
      const publish = jest.fn().mockResolvedValue({});
      mockSaveDraft.mockReturnValue({ ...idleMutation(), mutateAsync: save } as never);
      mockPublish.mockReturnValue({ ...idleMutation(), mutateAsync: publish } as never);
      renderTriage(withVerdict('decline', {
        reviewSubmittedAt: NOW,
        proposalGeneration: generation({ kind: 'decision-summary' }),
        proposalDraft: DECISION_DRAFT,
      }));
      goToStep(3);
      expect(screen.queryByTestId('rfp-proposal-owner-search')).not.toBeInTheDocument();
      fireEvent.change(screen.getByTestId('rfp-decision-summary-input'), { target: { value: 'Not a fit for Apex.' } });
      fireEvent.click(screen.getByTestId('rfp-proposal-publish'));
      await waitFor(() => expect(publish).toHaveBeenCalledWith({ id: 'rfp-1' }));
      expect(save.mock.calls[0][0].draft).toMatchObject({ kind: 'decision-summary', summary: 'Not a fit for Apex.' });
    });

    it('PB-6 shows the published version with an option to edit and republish', () => {
      renderTriage(makeDetail({
        ...SUBMITTED,
        proposalGeneration: generation(),
        proposalDraft: PRICED_DRAFT,
        proposal: PROPOSAL,
      }));
      expect(screen.getByTestId('rfp-proposal-published')).toBeInTheDocument();
      expect(screen.getByTestId('rfp-proposal-document')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('rfp-proposal-edit'));
      expect(screen.getByTestId('rfp-proposal-editor')).toBeInTheDocument();
    });

    it('PB-7 locks the proposal after approval', () => {
      renderTriage(makeDetail({
        ...SUBMITTED,
        proposalGeneration: generation(),
        proposalDraft: PRICED_DRAFT,
        proposal: PROPOSAL,
        approval: { approvedAt: '2026-09-22T12:00:00.000Z', repoName: 'tracker', repoUrl: 'https://dev.azure.com/org/Apex%20-%20Apps/_git/tracker', apexProject: 'Tracker' },
      }));
      expect(screen.queryByTestId('rfp-proposal-editor')).not.toBeInTheDocument();
      expect(screen.queryByTestId('rfp-proposal-edit')).not.toBeInTheDocument();
      expect(screen.getByTestId('rfp-project-delete')).toBeInTheDocument();
    });

    it('DP-0 lets triage delete the project after confirming', () => {
      const mutate = jest.fn();
      mockDeleteProject.mockReturnValue({ ...idleMutation(), mutate } as never);
      renderTriage(makeDetail({
        ...SUBMITTED,
        proposalGeneration: generation(),
        proposalDraft: PRICED_DRAFT,
        proposal: PROPOSAL,
        approval: { approvedAt: '2026-09-22T12:00:00.000Z', repoName: 'tracker', repoUrl: 'https://dev.azure.com/org/Apex%20-%20Apps/_git/tracker', apexProject: 'Tracker' },
      }));
      fireEvent.click(screen.getByTestId('rfp-project-delete'));
      expect(screen.getByText(/Archive Tracker/)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('rfp-project-delete-confirm'));
      expect(mutate).toHaveBeenCalledWith({ id: 'rfp-1' });
    });
  });

  describe('AR requester approval', () => {
    it('AR-0 shows the published proposal with cited costs and totals', () => {
      renderRequester(makeDetail({ architecture: ARCHITECTURE, proposal: PROPOSAL }));
      const doc = screen.getByTestId('rfp-proposal-document');
      expect(within(doc).getByText('Pat Owner')).toBeInTheDocument();
      expect(doc).toHaveTextContent('Build a tracker for People Ops.');
      expect(within(doc).getByTestId('rfp-cost-source-rds-prod')).toHaveTextContent('AWS Price List — Amazon RDS');
      expect(screen.getByTestId('rfp-proposal-monthly-total')).toHaveTextContent('$100–$140 (expected $120)');
      expect(screen.getByTestId('rfp-proposal-one-time-total')).toHaveTextContent('$30,000–$60,000');
      expect(screen.queryByTestId('rfp-proposal-editor')).not.toBeInTheDocument();
    });

    it('AR-0 lets the requester approve a published proposal', () => {
      const mutate = jest.fn();
      mockApprove.mockReturnValue({ ...idleMutation(), mutate } as never);
      renderRequester(makeDetail({ architecture: ARCHITECTURE, proposal: PROPOSAL }));
      fireEvent.click(screen.getByTestId('rfp-proposal-approve'));
      expect(mutate).toHaveBeenCalledWith({ id: 'rfp-1' });
    });

    it('RJ-0 lets the requester reject a published proposal with a reason', () => {
      const mutate = jest.fn();
      mockReject.mockReturnValue({ ...idleMutation(), mutate } as never);
      renderRequester(makeDetail({ architecture: ARCHITECTURE, proposal: PROPOSAL }));
      fireEvent.click(screen.getByTestId('rfp-proposal-reject'));
      expect(screen.getByTestId('rfp-proposal-reject-submit')).toBeDisabled();
      fireEvent.change(screen.getByTestId('rfp-proposal-reject-reason'), { target: { value: 'The monthly cost is too high.' } });
      fireEvent.click(screen.getByTestId('rfp-proposal-reject-submit'));
      expect(mutate).toHaveBeenCalledWith({ id: 'rfp-1', reason: 'The monthly cost is too high.' });
    });

    it('RJ-0 shows the rejection and hides approval until a new version is published', () => {
      renderRequester(makeDetail({
        architecture: ARCHITECTURE,
        proposal: {
          ...PROPOSAL,
          rejection: { rejectedAt: '2026-09-22T12:00:00.000Z', rejectedBy: 'owner-1', reason: 'The monthly cost is too high.' },
        },
      }));
      expect(screen.getByTestId('rfp-proposal-rejected')).toHaveTextContent('The monthly cost is too high.');
      expect(screen.queryByTestId('rfp-proposal-approve')).not.toBeInTheDocument();
      expect(screen.queryByTestId('rfp-proposal-reject')).not.toBeInTheDocument();
    });

    it('AR-0 shows a decision summary without an approve button', () => {
      renderRequester(withVerdict('decline', { proposal: { ...PROPOSAL, document: DECISION_DRAFT, productOwnerId: null, productOwnerName: null } }));
      expect(screen.getByTestId('rfp-decision-summary')).toHaveTextContent('Apex will not build this.');
      expect(screen.queryByTestId('rfp-proposal-approve')).not.toBeInTheDocument();
      expect(screen.queryByTestId('rfp-proposal-reject')).not.toBeInTheDocument();
    });

    it('AR-0 does not offer approval in triage mode', () => {
      renderTriage(makeDetail({ architecture: ARCHITECTURE, proposal: PROPOSAL }));
      expect(screen.queryByTestId('rfp-proposal-approve')).not.toBeInTheDocument();
      expect(screen.queryByTestId('rfp-proposal-reject')).not.toBeInTheDocument();
    });

    it('RJ-0 shows the requester rejection to triage', () => {
      renderTriage(makeDetail({
        architecture: ARCHITECTURE,
        proposal: {
          ...PROPOSAL,
          rejection: { rejectedAt: '2026-09-22T12:00:00.000Z', rejectedBy: 'owner-1', reason: 'The monthly cost is too high.' },
        },
      }));
      expect(screen.getByTestId('rfp-proposal-rejected')).toHaveTextContent('The requester rejected this proposal.');
      expect(screen.getByTestId('rfp-proposal-rejected')).toHaveTextContent('The monthly cost is too high.');
    });

    it('AR-4 shows the Azure DevOps error so the requester can retry', () => {
      mockApprove.mockReturnValue({
        ...idleMutation(),
        isError: true,
        error: new Error('Azure DevOps could not create the repository: denied'),
      } as never);
      renderRequester(makeDetail({ architecture: ARCHITECTURE, proposal: PROPOSAL }));
      expect(screen.getByRole('alert')).toHaveTextContent('Azure DevOps could not create the repository: denied');
      expect(screen.getByTestId('rfp-proposal-approve')).toBeEnabled();
    });

    it('DP-0 does not offer project deletion to the requester', () => {
      renderRequester(makeDetail({
        architecture: ARCHITECTURE,
        proposal: PROPOSAL,
        approval: { approvedAt: '2026-09-22T12:00:00.000Z', repoName: 'tracker', repoUrl: 'https://dev.azure.com/org/Apex%20-%20Apps/_git/tracker', apexProject: 'Tracker' },
      }));
      expect(screen.getByTestId('rfp-proposal-approved')).toBeInTheDocument();
      expect(screen.queryByTestId('rfp-project-delete')).not.toBeInTheDocument();
    });

    it('AR-1 shows the repository and project after approval', () => {
      renderRequester(makeDetail({
        architecture: ARCHITECTURE,
        proposal: PROPOSAL,
        approval: { approvedAt: '2026-09-22T12:00:00.000Z', repoName: 'tracker', repoUrl: 'https://dev.azure.com/org/Apex%20-%20Apps/_git/tracker', apexProject: 'Tracker' },
      }));
      expect(screen.queryByTestId('rfp-proposal-approve')).not.toBeInTheDocument();
      const approved = screen.getByTestId('rfp-proposal-approved');
      expect(approved).toHaveTextContent('Tracker');
      expect(screen.getByTestId('rfp-proposal-repo-link')).toHaveAttribute('href', 'https://dev.azure.com/org/Apex%20-%20Apps/_git/tracker');
    });
  });
});
