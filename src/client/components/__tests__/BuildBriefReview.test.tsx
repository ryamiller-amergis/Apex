/**
 * FEAT-006 S7 — BuildBriefReview states, labels, keyboard order, and error and empty paths.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuildBriefReview } from '../BuildBriefReview';
import type { BuildBriefAnalysisResponse } from '../../../shared/types/build';
import type { InterviewBriefRecord } from '../../../shared/types/interview';
import type { BuildBriefAnalysisState } from '../../hooks/useBuildBrief';

const mockBriefQuery = jest.fn();
const mockAnalysisQuery = jest.fn();
const mockSave = { mutate: jest.fn(), mutateAsync: jest.fn(), reset: jest.fn(), isPending: false, error: null as Error | null };
const mockDraft = { mutate: jest.fn(), mutateAsync: jest.fn(), reset: jest.fn(), isPending: false, error: null as Error | null };
const mockApprove = { mutate: jest.fn(), mutateAsync: jest.fn(), reset: jest.fn(), isPending: false, error: null as Error | null };

jest.mock('../../hooks/useBuildBrief', () => ({
  useBuildBriefRecord: () => mockBriefQuery(),
  useBuildBriefAnalysis: () => mockAnalysisQuery(),
  useSaveBuildBrief: () => mockSave,
  useDraftBuildBrief: () => mockDraft,
  useApproveBuildBrief: () => mockApprove,
}));

const brief: InterviewBriefRecord = {
  id: 'brief-1',
  interviewId: 'iv-1',
  status: 'draft',
  version: 1,
  sections: {
    problemAndOutcome: 'Track team leave',
    users: 'Managers',
    scope: 'One page',
    businessRules: '',
    scenarios: 'A manager approves leave',
    acceptanceCriteria: 'AC-1: Shows leave\nAC-2: Approves leave\nAC-3: Exports leave',
    assumptions: 'None',
    unresolvedItems: [],
  },
  approvedBy: null,
  approvedAt: null,
};

function makeAnalysis(overrides: Partial<BuildBriefAnalysisResponse> = {}): BuildBriefAnalysisResponse {
  return {
    interviewId: 'iv-1',
    buildRunId: 'build-1',
    revisionNumber: 1,
    briefVersion: 1,
    briefStatus: 'draft',
    requirements: [
      { id: 'AC-1', kind: 'ac', text: 'Shows leave', retired: false },
      { id: 'AC-2', kind: 'ac', text: 'Approves leave', retired: false },
      { id: 'AC-3', kind: 'ac', text: 'Exports leave', retired: false },
    ],
    riskDecisions: [
      { id: 'RD-1', category: 'access', rating: 'medium', decision: 'Add a leave:approve permission', rationale: 'Only managers approve' },
    ],
    classification: { value: 'small', reasons: [] },
    requester: { id: 'requester', displayName: 'Dana Lee' },
    approval: null,
    viewer: { mayEdit: true, actingFor: null },
    ...overrides,
  };
}

function setAnalysis(state: BuildBriefAnalysisState | undefined, extra: { isLoading?: boolean; isError?: boolean } = {}) {
  mockAnalysisQuery.mockReturnValue({
    data: state,
    isLoading: extra.isLoading ?? false,
    isError: extra.isError ?? false,
    refetch: mockRefetch,
  });
}

const mockRefetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  for (const mutation of [mockSave, mockDraft, mockApprove]) {
    mutation.isPending = false;
    mutation.error = null;
  }
  mockSave.mutateAsync.mockResolvedValue(brief);
  mockBriefQuery.mockReturnValue({ data: brief, isLoading: false });
  setAnalysis({ kind: 'ready', analysis: makeAnalysis() });
});

describe('VT-26 — approve a drafted brief in one step (PBI-011 a)', () => {
  it('shows AC-1 to AC-3, the classification and the decision, and approves once', async () => {
    const user = userEvent.setup();
    render(<BuildBriefReview interviewId="iv-1" />);

    for (const id of ['AC-1', 'AC-2', 'AC-3']) {
      expect(screen.getByTestId(`build-requirement-row-${id}`)).toBeInTheDocument();
      expect(screen.getByLabelText(`${id} Acceptance criterion`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('build-brief-classification')).toHaveTextContent('Small build');
    expect(screen.getByTestId('build-risk-decision-RD-1')).toHaveTextContent('Add a leave:approve permission');

    await user.click(screen.getByTestId('build-brief-approve'));
    expect(mockApprove.mutate).toHaveBeenCalledTimes(1);
  });
});

describe('VT-28 — edit one criterion and keep its ID (PBI-011 c)', () => {
  it('disables Approve while dirty, saves the row with its ID, then enables Approve', async () => {
    const user = userEvent.setup();
    render(<BuildBriefReview interviewId="iv-1" />);

    const input = screen.getByTestId('build-requirement-input-AC-2');
    await user.clear(input);
    await user.type(input, 'Approves leave in one click');
    expect(screen.getByTestId('build-brief-approve')).toBeDisabled();

    await user.click(screen.getByTestId('build-brief-save'));
    await waitFor(() => expect(screen.getByTestId('build-brief-approve')).toBeEnabled());
    expect(mockSave.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      requirements: expect.arrayContaining([{ id: 'AC-2', kind: 'ac', text: 'Approves leave in one click' }]),
    }));
    expect(screen.getByLabelText('AC-2 Acceptance criterion')).toBeInTheDocument();
  });

  it('refuses an empty requirement before saving', async () => {
    const user = userEvent.setup();
    render(<BuildBriefReview interviewId="iv-1" />);

    await user.clear(screen.getByTestId('build-requirement-input-AC-1'));
    await user.click(screen.getByTestId('build-brief-save'));
    expect(await screen.findByText('Enter the requirement text.')).toBeInTheDocument();
    expect(mockSave.mutateAsync).not.toHaveBeenCalled();
  });

  it('adds a new row without an ID', async () => {
    const user = userEvent.setup();
    render(<BuildBriefReview interviewId="iv-1" />);

    await user.click(screen.getByTestId('build-requirement-add-dod'));
    await user.type(screen.getByTestId('build-requirement-input-new-dod-1'), 'Tests pass');
    await user.click(screen.getByTestId('build-brief-save'));
    await waitFor(() => expect(mockSave.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      requirements: expect.arrayContaining([{ id: null, kind: 'dod', text: 'Tests pass' }]),
    })));
  });
});

describe('VT-29 — read-only viewer (PBI-011 d, PBI-013 d2)', () => {
  it('hides Save, Draft and Approve and shows the read-only note', () => {
    setAnalysis({ kind: 'ready', analysis: makeAnalysis({ viewer: { mayEdit: false, actingFor: null } }) });
    render(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.queryByTestId('build-brief-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-brief-draft')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-brief-approve')).not.toBeInTheDocument();
    expect(screen.getByTestId('build-brief-readonly-note')).toHaveTextContent(
      'You can read this brief. Only the requester or an admin can change or approve it.',
    );
    expect(screen.getByTestId('build-requirement-row-AC-1')).toHaveTextContent('Shows leave');
  });
});

describe('VT-30 — takeover by an admin (PBI-012 a)', () => {
  it('shows the notice and names the requester on the Approve button', () => {
    setAnalysis({ kind: 'ready', analysis: makeAnalysis({ viewer: { mayEdit: true, actingFor: 'Dana Lee' } }) });
    render(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.getByTestId('build-brief-takeover-notice')).toHaveTextContent('You are editing this brief for Dana Lee.');
    const approve = screen.getByTestId('build-brief-approve');
    expect(approve).toHaveTextContent('Approve brief for Dana Lee');
    expect(approve).toHaveAttribute('aria-label', 'Approve brief for Dana Lee');
  });
});

describe('VT-31 — already approved (PBI-012 c2)', () => {
  it('says the brief was already approved, makes the form read-only and shows no error', async () => {
    const user = userEvent.setup();
    mockApprove.mutate.mockImplementation((_vars: unknown, options?: { onSuccess?: (r: unknown) => void }) => {
      options?.onSuccess?.({ version: 1, resumed: false, alreadyApproved: true });
      mockBriefQuery.mockReturnValue({ data: { ...brief, status: 'approved' }, isLoading: false });
    });
    const { rerender } = render(<BuildBriefReview interviewId="iv-1" />);

    await user.click(screen.getByTestId('build-brief-approve'));
    rerender(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.getByTestId('build-brief-approved-note')).toHaveTextContent('already approved');
    expect(screen.getByTestId('build-brief-problemAndOutcome')).toBeDisabled();
    expect(screen.queryByTestId('build-brief-approve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-brief-error')).not.toBeInTheDocument();
  });

  it('keeps a retry Approve when the brief was approved but planning did not start', async () => {
    const user = userEvent.setup();
    mockBriefQuery.mockReturnValue({ data: { ...brief, status: 'approved' }, isLoading: false });
    mockApprove.error = new Error('The brief was approved, but planning did not start. Approve again to continue.');
    render(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.getByTestId('build-brief-error')).toHaveTextContent('planning did not start');
    await user.click(screen.getByTestId('build-brief-approve'));
    expect(mockApprove.mutate).toHaveBeenCalledTimes(1);
  });

  it('shows who approved and when', () => {
    setAnalysis({
      kind: 'ready',
      analysis: makeAnalysis({
        briefStatus: 'approved',
        approval: { approvedBy: { id: 'pa-1', displayName: 'Sam Admin' }, approvedAt: '2026-10-27T10:00:00Z' },
      }),
    });
    render(<BuildBriefReview interviewId="iv-1" />);
    expect(screen.getByTestId('build-brief-approved-note')).toHaveTextContent('Approved by Sam Admin');
  });
});

describe('VT-33 — risk decisions fail to load (PBI-013 b)', () => {
  it('shows a section error with Retry and keeps the brief fields', async () => {
    const user = userEvent.setup();
    setAnalysis(undefined, { isError: true });
    render(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.getByTestId('build-risk-decisions-error')).toBeInTheDocument();
    expect(screen.getByTestId('build-brief-problemAndOutcome')).toHaveValue('Track team leave');
    await user.click(screen.getByTestId('build-risk-decisions-retry'));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
});

describe('waiting, drafting and failure states (PBI-011 b, b2)', () => {
  it('shows the waiting message and a Draft brief button when no draft exists', () => {
    mockBriefQuery.mockReturnValue({ data: null, isLoading: false });
    setAnalysis({ kind: 'missing', draftFailed: false });
    render(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.getByTestId('build-brief-empty')).toHaveTextContent('Your brief appears here when the agent has what it needs.');
    expect(screen.getByTestId('build-brief-draft')).toHaveTextContent('Draft brief');
    expect(screen.queryByTestId('build-brief-error')).not.toBeInTheDocument();
  });

  it('shows the draft failure with a retry when the automatic draft failed', async () => {
    const user = userEvent.setup();
    mockBriefQuery.mockReturnValue({ data: null, isLoading: false });
    setAnalysis({ kind: 'missing', draftFailed: true });
    render(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.getByTestId('build-brief-error')).toHaveTextContent('The brief could not be drafted.');
    await user.click(screen.getByTestId('build-brief-draft'));
    expect(mockDraft.mutate).toHaveBeenCalledTimes(1);
  });

  it('announces drafting politely', () => {
    mockBriefQuery.mockReturnValue({ data: null, isLoading: false });
    setAnalysis({ kind: 'missing', draftFailed: false });
    mockDraft.isPending = true;
    render(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.getByText('Drafting the brief…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('build-brief-draft')).toHaveTextContent('Drafting…');
  });

  it('shows the no-acceptance-criterion refusal from the server', () => {
    mockApprove.error = new Error('Add at least one acceptance criterion before you approve.');
    render(<BuildBriefReview interviewId="iv-1" />);

    expect(screen.getByTestId('build-brief-error')).toHaveTextContent('Add at least one acceptance criterion before you approve.');
    expect(screen.getByTestId('build-brief-approve')).toBeEnabled();
  });
});

describe('VT-36 — keyboard order (PBI-011 a)', () => {
  it('tabs through row fields, Add, Save and Approve in order on native buttons', async () => {
    const user = userEvent.setup();
    render(<BuildBriefReview interviewId="iv-1" />);
    await user.type(screen.getByTestId('build-requirement-input-AC-1'), ' today');

    const order = [
      'build-requirement-input-AC-1',
      'build-requirement-remove-AC-1',
      'build-requirement-input-AC-2',
      'build-requirement-remove-AC-2',
      'build-requirement-input-AC-3',
      'build-requirement-remove-AC-3',
      'build-requirement-add-ac',
    ];
    screen.getByTestId(order[0]).focus();
    for (const testId of order.slice(1)) {
      await user.tab();
      expect(screen.getByTestId(testId)).toHaveFocus();
    }

    const save = screen.getByTestId('build-brief-save');
    const approve = screen.getByTestId('build-brief-approve');
    for (const button of [save, approve, screen.getByTestId('build-requirement-add-ac')]) {
      expect(button.tagName).toBe('BUTTON');
    }
    expect(save.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByTestId('build-requirement-add-nfr').compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
