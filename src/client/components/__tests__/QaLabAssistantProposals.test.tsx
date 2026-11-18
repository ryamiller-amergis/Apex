import { fireEvent, render, screen } from '@testing-library/react';
import type { QaLabAssistantProposal, QaLabTestCase } from '../../../shared/types/qaLab';
import { QaLabAssistantProposals } from '../QaLabAssistantProposals';
import { useAssistantProposalActions, useAssistantProposals } from '../../hooks/useQaLab';

jest.mock('../../hooks/useQaLab', () => ({
  useAssistantProposals: jest.fn(),
  useAssistantProposalActions: jest.fn(),
}));

function mutation() {
  return { mutate: jest.fn(), isPending: false, error: null };
}

const approveCase: QaLabTestCase = {
  id: 'PBI-58989-1',
  pbiId: 'PBI-58989',
  title: 'Validate Approve Timesheet',
  persona: 'Approver',
  preconditions: [],
  testData: {},
  businessRules: [],
  steps: [{ order: 1, action: 'Open the timesheet', expected: 'Timesheet shows' }],
};

const proposal = (overrides: Partial<QaLabAssistantProposal> = {}): QaLabAssistantProposal => ({
  id: 'p1',
  kind: 'edit',
  status: 'pending',
  suiteId: 'suite-1',
  workItem: { id: 58977, title: 'Approval notifications' },
  localCaseId: 'PBI-58989-1',
  reason: 'Title should say what is checked',
  before: approveCase,
  after: { ...approveCase, title: 'Validate approval email' },
  commentBody: null,
  error: null,
  createdAt: '2026-11-05T10:00:00.000Z',
  ...overrides,
});

let actions: Record<'confirm' | 'discard' | 'confirmAll' | 'discardAll', ReturnType<typeof mutation>>;

function renderWith(proposals: QaLabAssistantProposal[], isRunning = false) {
  jest.mocked(useAssistantProposals).mockReturnValue({ data: proposals } as never);
  return render(<QaLabAssistantProposals threadId="thread-qa" isRunning={isRunning} />);
}

beforeEach(() => {
  actions = { confirm: mutation(), discard: mutation(), confirmAll: mutation(), discardAll: mutation() };
  jest.mocked(useAssistantProposalActions).mockReturnValue(actions as never);
});

describe('QaLabAssistantProposals', () => {
  it('shows nothing when there is nothing to review', () => {
    const { container } = renderWith([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the old and new text and confirms or discards one change', () => {
    renderWith([proposal()]);

    expect(screen.getByText('1 change to review')).toBeInTheDocument();
    expect(screen.getByText('Title should say what is checked')).toBeInTheDocument();
    expect(screen.getAllByText(/Validate Approve Timesheet/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Validate approval email/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('qa-lab-proposals-confirm-all')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('qa-lab-proposal-p1-confirm'));
    expect(actions.confirm.mutate).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByTestId('qa-lab-proposal-p1-discard'));
    expect(actions.discard.mutate).toHaveBeenCalledWith('p1');
  });

  it('offers Confirm all for several changes, and waits while the assistant is still working', () => {
    renderWith([proposal(), proposal({ id: 'p2', kind: 'comment', after: null, commentBody: 'Log in as the approver' })], true);

    expect(screen.getByText('Log in as the approver')).toBeInTheDocument();
    expect(screen.getByTestId('qa-lab-proposals-confirm-all')).toBeDisabled();
    expect(screen.getByTestId('qa-lab-proposal-p1-confirm')).toBeDisabled();
    expect(screen.getByTestId('qa-lab-proposal-p1-discard')).toBeEnabled();
  });

  it('shows why a change failed and lets QA try again', () => {
    renderWith([proposal({ status: 'failed', error: 'PBI-58989-1 changed after this was proposed.' })]);

    expect(screen.getByTestId('qa-lab-proposal-p1-error')).toHaveTextContent('changed after this was proposed');
    expect(screen.getByTestId('qa-lab-proposal-p1-confirm')).toHaveTextContent('Try again');
    expect(screen.getByTestId('qa-lab-proposal-p1-discard')).toHaveTextContent('Dismiss');
  });
});
