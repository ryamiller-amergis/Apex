import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SectionOwnerModal } from '../SectionOwnerModal';
import type { ReviewerDocumentType } from '../../../shared/types/approvals';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../hooks/useInterviews', () => ({
  useActiveUsers: jest.fn(),
  useAvailableApproverPool: jest.fn(),
  useInterviewGroupsWithMembers: jest.fn(),
}));

jest.mock('../../hooks/useReviewerAvailability', () => ({
  useReviewerAvailability: jest.fn(),
}));

import { useActiveUsers, useAvailableApproverPool, useInterviewGroupsWithMembers } from '../../hooks/useInterviews';
import { useReviewerAvailability } from '../../hooks/useReviewerAvailability';
const mockUseActiveUsers = useActiveUsers as jest.Mock;
const mockUseApproverPool = useAvailableApproverPool as jest.Mock;
const mockUseInterviewGroupsWithMembers = useInterviewGroupsWithMembers as jest.Mock;
const mockUseReviewerAvailability = useReviewerAvailability as jest.Mock;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const activeUsers = [
  { oid: 'alice', displayName: 'Alice Smith', email: 'alice@example.com' },
  { oid: 'bob', displayName: 'Bob Jones', email: 'bob@example.com' },
];

interface PoolFixture {
  individuals: Array<{ userId: string; displayName: string; email: string }>;
  groups: Array<{
    id: string;
    name: string;
    members: Array<{ userId: string; displayName: string; email: string }>;
  }>;
}

const emptyPool: PoolFixture = { individuals: [], groups: [] };

const populatedPool: PoolFixture = {
  individuals: [
    { userId: 'alice', displayName: 'Alice Smith', email: 'alice@example.com' },
    { userId: 'bob', displayName: 'Bob Jones', email: 'bob@example.com' },
  ],
  groups: [],
};

const ALL_MODULES: ReviewerDocumentType[] = ['prd', 'design_doc', 'design_prototype', 'test_case'];

/** Build a mocked useReviewerAvailability result for a successful load. */
function availabilityLoaded(available: Partial<Record<ReviewerDocumentType, boolean>>) {
  return {
    data: {
      project: 'proj-alpha',
      modules: ALL_MODULES.map((documentType) => ({
        documentType,
        available: available[documentType] ?? false,
        candidateCount: available[documentType] ? 2 : 0,
      })),
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  };
}

function availabilityLoading() {
  return { data: undefined, isLoading: true, isError: false, error: null, refetch: jest.fn() };
}

function availabilityFailed(refetch = jest.fn()) {
  return { data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch };
}

/** Route each per-module pool hook to its own fixture. */
function mockPools(pools: Partial<Record<ReviewerDocumentType, PoolFixture>>) {
  mockUseApproverPool.mockImplementation((_project: string, documentType: ReviewerDocumentType) => ({
    data: pools[documentType] ?? emptyPool,
    isLoading: false,
  }));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderModal(
  overrides: Partial<React.ComponentProps<typeof SectionOwnerModal>> = {},
) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const view = render(
    <SectionOwnerModal
      project="proj-alpha"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel, ...view };
}

function selectOwner(labelPattern: RegExp, userName: string) {
  const field = screen.getByText(labelPattern).parentElement!;
  const input = within(field).getByRole('combobox');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: userName.split(' ')[0] } });
  fireEvent.mouseDown(within(field).getByRole('option', { name: new RegExp(userName) }));
}

function selectAllOwners() {
  selectOwner(/PRD Owner/, 'Alice Smith');
  selectOwner(/Design Doc Owner/, 'Bob Jones');
  selectOwner(/Design Prototype Owner/, 'Alice Smith');
  selectOwner(/Test Case Owner/, 'Bob Jones');
}

function goToReviewerStep() {
  selectAllOwners();
  fireEvent.click(screen.getByTestId('section-owner-next-btn'));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SectionOwnerModal', () => {
  beforeEach(() => {
    mockUseActiveUsers.mockReturnValue({ data: activeUsers, isLoading: false });
    mockUseApproverPool.mockReturnValue({ data: emptyPool, isLoading: false });
    mockUseInterviewGroupsWithMembers.mockReturnValue({ data: [], isLoading: false });
    mockUseReviewerAvailability.mockReturnValue(
      availabilityLoaded({ prd: true, design_doc: true, design_prototype: true, test_case: true }),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the heading', () => {
    renderModal();
    expect(screen.getByText(/Assign Owners/)).toBeInTheDocument();
  });

  it('loads owner candidates for the current interview project', () => {
    renderModal({ project: 'project-beta' });

    expect(mockUseActiveUsers).toHaveBeenCalledWith('project-beta');
  });

  it('renders required field labels', () => {
    renderModal();
    expect(screen.getByText(/PRD Owner.*\*/)).toBeInTheDocument();
    expect(screen.getByText(/Design Doc Owner.*\*/)).toBeInTheDocument();
    expect(screen.getByText(/Design Prototype Owner.*\*/)).toBeInTheDocument();
    expect(screen.getByText(/Test Case Owner.*\*/)).toBeInTheDocument();
  });

  it('shows loading text for owner fields while users are being fetched', () => {
    mockUseActiveUsers.mockReturnValue({ data: [], isLoading: true });
    renderModal();
    const loadingEls = screen.getAllByText('Loading users…');
    expect(loadingEls).toHaveLength(4);
  });

  it('renders combobox inputs when users have loaded', () => {
    renderModal();
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(4);
  });

  it('clicking the close button calls onCancel', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('clicking the overlay backdrop calls onCancel', () => {
    const { onCancel } = renderModal();
    const overlay = screen.getByRole('dialog');
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape calls onCancel', () => {
    const { onCancel } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Next button is disabled when no owners are selected', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('clicking Cancel calls onCancel', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Cancel button is disabled when isSubmitting=true', () => {
    renderModal({ isSubmitting: true });
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('shows "Creating…" label on the confirm button when isSubmitting=true', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { rerender } = render(
      <SectionOwnerModal project="proj-alpha" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    selectAllOwners();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    rerender(
      <SectionOwnerModal project="proj-alpha" onConfirm={onConfirm} onCancel={onCancel} isSubmitting />,
    );
    expect(screen.getByText('Creating…')).toBeInTheDocument();
  });

  it('clicking inside the modal card does not call onCancel', () => {
    const { onCancel } = renderModal();
    const card = screen.getByText(/Assign Owners/).closest('div')!;
    fireEvent.click(card);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ── PBI-004 reviewer availability ──────────────────────────────────────────────

describe('SectionOwnerModal reviewer availability (PBI-004)', () => {
  beforeEach(() => {
    mockUseActiveUsers.mockReturnValue({ data: activeUsers, isLoading: false });
    mockUseInterviewGroupsWithMembers.mockReturnValue({ data: [], isLoading: false });
    mockPools({});
    mockUseReviewerAvailability.mockReturnValue(
      availabilityLoaded({ prd: true, design_doc: true, design_prototype: true, test_case: true }),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('queries live reviewer availability for the interviews surface and current project', () => {
    renderModal({ project: 'project-beta' });

    expect(mockUseReviewerAvailability).toHaveBeenCalledWith('project-beta', 'interviews');
  });

  it('VT-04 (AC-0) shows only available module pickers and no placeholder for omitted modules', () => {
    mockPools({ prd: populatedPool });
    mockUseReviewerAvailability.mockReturnValue(availabilityLoaded({ prd: true }));

    renderModal();
    goToReviewerStep();

    expect(screen.getByTestId('reviewer-picker-prd')).toBeInTheDocument();
    expect(screen.queryByTestId('reviewer-picker-design-doc')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reviewer-picker-design-prototype')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reviewer-picker-qa')).not.toBeInTheDocument();
    expect(screen.queryByText(/Design Doc Reviewers/)).not.toBeInTheDocument();
    expect(screen.queryByText('No approvers configured')).not.toBeInTheDocument();
  });

  it('VT-04 (AC-0) treats a configured group with no current members as unavailable', () => {
    mockPools({
      prd: populatedPool,
      // A configured-but-empty group still yields zero candidates.
      design_doc: { individuals: [], groups: [{ id: 'g1', name: 'Reviewers', members: [] }] },
    });
    mockUseReviewerAvailability.mockReturnValue(availabilityLoaded({ prd: true, design_doc: false }));

    renderModal();
    goToReviewerStep();

    expect(screen.getByTestId('reviewer-picker-prd')).toBeInTheDocument();
    expect(screen.queryByTestId('reviewer-picker-design-doc')).not.toBeInTheDocument();
  });

  it('VT-05 (AC-1) renders a retry alert for each enabled module when availability fails', () => {
    const refetch = jest.fn();
    mockUseReviewerAvailability.mockReturnValue(availabilityFailed(refetch));

    renderModal();
    goToReviewerStep();

    for (const key of ['prd', 'design-doc', 'design-prototype', 'qa']) {
      const alert = screen.getByTestId(`reviewer-availability-error-${key}`);
      expect(alert).toHaveAttribute('role', 'alert');
      expect(screen.getByTestId(`section-owner-reviewer-retry-${key}`)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId('section-owner-reviewer-retry-prd'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('VT-05 (AC-1) does not classify a failed availability load as "no reviewers"', () => {
    mockUseReviewerAvailability.mockReturnValue(availabilityFailed());

    const { onConfirm } = renderModal();
    selectAllOwners();

    expect(screen.queryByTestId('confirm-start-interview-no-reviewers')).not.toBeInTheDocument();
    expect(screen.getByTestId('section-owner-next-btn')).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('section-owner-next-btn'));
    expect(screen.getByTestId('section-owner-confirm-btn')).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('VT-05 (AC-1) only renders retry alerts for enabled modules', () => {
    mockUseReviewerAvailability.mockReturnValue(availabilityFailed());

    renderModal({ prototypeStageEnabled: false, testCasesEnabled: false });
    selectOwner(/PRD Owner/, 'Alice Smith');
    selectOwner(/Design Doc Owner/, 'Bob Jones');
    fireEvent.click(screen.getByTestId('section-owner-next-btn'));

    expect(screen.getByTestId('reviewer-availability-error-prd')).toBeInTheDocument();
    expect(screen.getByTestId('reviewer-availability-error-design-doc')).toBeInTheDocument();
    expect(screen.queryByTestId('reviewer-availability-error-design-prototype')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reviewer-availability-error-qa')).not.toBeInTheDocument();
  });

  it('VT-06 (AC-2) skips the reviewer step and confirms with empty reviewer lists when nothing is available', () => {
    mockUseReviewerAvailability.mockReturnValue(availabilityLoaded({}));

    const { onConfirm } = renderModal();
    selectAllOwners();

    expect(screen.queryByTestId('section-owner-next-btn')).not.toBeInTheDocument();
    expect(screen.queryByText(/Step 2/)).not.toBeInTheDocument();

    const startBtn = screen.getByTestId('confirm-start-interview-no-reviewers');
    expect(startBtn).toHaveTextContent('Confirm & Start Interview');

    fireEvent.click(startBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        prdOwnerId: 'alice',
        designDocOwnerId: 'bob',
        designPrototypeOwnerId: 'alice',
        testCaseOwnerId: 'bob',
        prdApproverIds: [],
        designDocApproverIds: [],
        designPrototypeApproverIds: [],
        testCaseApproverIds: [],
      }),
    );
  });

  it('VT-06 (AC-2) keeps disabled module owners unset while still sending empty reviewer arrays', () => {
    mockUseReviewerAvailability.mockReturnValue(availabilityLoaded({}));

    const { onConfirm } = renderModal({ prototypeStageEnabled: false, testCasesEnabled: false });
    selectOwner(/PRD Owner/, 'Alice Smith');
    selectOwner(/Design Doc Owner/, 'Bob Jones');

    fireEvent.click(screen.getByTestId('confirm-start-interview-no-reviewers'));

    expect(onConfirm).toHaveBeenCalledWith({
      prdOwnerId: 'alice',
      designDocOwnerId: 'bob',
      designPrototypeOwnerId: undefined,
      testCaseOwnerId: undefined,
      prdApproverIds: [],
      designDocApproverIds: [],
      designPrototypeApproverIds: [],
      testCaseApproverIds: [],
    });
  });

  it('VT-06 (AC-2) does not skip the reviewer step while availability is still loading', () => {
    mockUseReviewerAvailability.mockReturnValue(availabilityLoading());

    renderModal();
    selectAllOwners();

    expect(screen.queryByTestId('confirm-start-interview-no-reviewers')).not.toBeInTheDocument();
    expect(screen.getByTestId('section-owner-next-btn')).toBeInTheDocument();
  });

  it('VT-07 (AC-3) blocks confirm until every available module has at least one reviewer', () => {
    mockPools({ prd: populatedPool });
    mockUseReviewerAvailability.mockReturnValue(availabilityLoaded({ prd: true }));

    const { onConfirm } = renderModal();
    goToReviewerStep();

    const confirmBtn = screen.getByTestId('section-owner-confirm-btn');
    expect(confirmBtn).toBeDisabled();
    expect(screen.getByText(/Select at least one reviewer/i)).toBeInTheDocument();

    fireEvent.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('section-owner-prd-chip-alice'));

    expect(screen.getByTestId('section-owner-confirm-btn')).toBeEnabled();
    fireEvent.click(screen.getByTestId('section-owner-confirm-btn'));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ prdApproverIds: ['alice'] }),
    );
  });

  it('VT-07 (AC-3) does not require selections for modules that are unavailable', () => {
    mockPools({ prd: populatedPool, design_doc: populatedPool });
    mockUseReviewerAvailability.mockReturnValue(availabilityLoaded({ prd: true }));

    const { onConfirm } = renderModal();
    goToReviewerStep();

    fireEvent.click(screen.getByTestId('section-owner-prd-chip-alice'));
    fireEvent.click(screen.getByTestId('section-owner-confirm-btn'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('BR-009 allows the module owner to be selected as a reviewer when they are in the pool', () => {
    mockPools({ prd: populatedPool });
    mockUseReviewerAvailability.mockReturnValue(availabilityLoaded({ prd: true }));

    const { onConfirm } = renderModal();
    goToReviewerStep();

    fireEvent.click(screen.getByTestId('section-owner-prd-chip-alice'));
    fireEvent.click(screen.getByTestId('section-owner-confirm-btn'));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ prdOwnerId: 'alice', prdApproverIds: ['alice'] }),
    );
  });

  it('shows a non-blocking loading state on the reviewer step without trapping focus', () => {
    mockUseReviewerAvailability.mockReturnValue(availabilityLoading());

    renderModal();
    goToReviewerStep();

    expect(screen.getByText(/Checking reviewer availability/i)).toBeInTheDocument();
    expect(screen.queryByTestId('reviewer-picker-prd')).not.toBeInTheDocument();
    // Back and Close stay reachable — no focus trap while loading.
    expect(screen.getByTestId('section-owner-back-btn')).toBeEnabled();
    expect(screen.getByLabelText('Close')).toBeEnabled();
  });
});
