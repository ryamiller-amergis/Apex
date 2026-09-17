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

/** Groups covering every preference list the owner pickers narrow toward. */
const ownerGroups = [
  { id: 'g-ba', name: 'BA', members: [{ userId: 'ba-1', displayName: 'Bea Analyst', email: 'bea@example.com' }] },
  { id: 'g-po', name: 'Product-Owner', members: [{ userId: 'po-1', displayName: 'Percy Owner', email: 'percy@example.com' }] },
  { id: 'g-mgr', name: 'Manager', members: [{ userId: 'mgr-1', displayName: 'Mona Manager', email: 'mona@example.com' }] },
  { id: 'g-dev', name: 'Developer', members: [{ userId: 'dev-1', displayName: 'Dev Devlin', email: 'dev@example.com' }] },
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

function selectDocumentOwners() {
  selectOwner(/PRD Owner/, 'Alice Smith');
  selectOwner(/Design Doc Owner/, 'Bob Jones');
  selectOwner(/Design Prototype Owner/, 'Alice Smith');
  selectOwner(/Test Case Owner/, 'Bob Jones');
}

/** Both phase owners — valid only under the default `both_sequential` flow. */
function selectPhaseOwners() {
  selectOwner(/Requirements Owner/, 'Alice Smith');
  selectOwner(/Technical Owner/, 'Bob Jones');
}

function selectAllOwners() {
  selectPhaseOwners();
  selectDocumentOwners();
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
    // 4 document owners + the 2 phase owners of the default both_sequential flow.
    expect(loadingEls).toHaveLength(6);
  });

  it('renders combobox inputs when users have loaded', () => {
    renderModal();
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(6);
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
    selectPhaseOwners();
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
    selectPhaseOwners();
    selectOwner(/PRD Owner/, 'Alice Smith');
    selectOwner(/Design Doc Owner/, 'Bob Jones');

    fireEvent.click(screen.getByTestId('confirm-start-interview-no-reviewers'));

    expect(onConfirm).toHaveBeenCalledWith({
      prdOwnerId: 'alice',
      designDocOwnerId: 'bob',
      designPrototypeOwnerId: undefined,
      testCaseOwnerId: undefined,
      phaseFlow: 'both_sequential',
      requirementsOwnerId: 'alice',
      technicalOwnerId: 'bob',
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

// ── PBI-001 phase flow + phase owners ─────────────────────────────────────────

describe('SectionOwnerModal phase flow (PBI-001)', () => {
  beforeEach(() => {
    mockUseActiveUsers.mockReturnValue({ data: activeUsers, isLoading: false });
    mockUseInterviewGroupsWithMembers.mockReturnValue({ data: [], isLoading: false });
    mockPools({});
    // No reviewers available → single-step modal, so Confirm is reachable directly.
    mockUseReviewerAvailability.mockReturnValue(availabilityLoaded({}));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('defaults to "Both in sequence" and renders all three phase flow options', () => {
    renderModal();

    const requirementsOnly = screen.getByTestId('phase-flow-radio-requirements-only');
    const technicalOnly = screen.getByTestId('phase-flow-radio-technical-only');
    const bothSequential = screen.getByTestId('phase-flow-radio-both-sequential');

    expect(requirementsOnly).not.toBeChecked();
    expect(technicalOnly).not.toBeChecked();
    expect(bothSequential).toBeChecked();

    expect(screen.getByText('Requirements only')).toBeInTheDocument();
    expect(screen.getByText('Technical only')).toBeInTheDocument();
    expect(screen.getByText('Both in sequence')).toBeInTheDocument();
    expect(
      screen.getByText('A single Requirements phase; no Technical review needed.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Skip Requirements; go straight to the Technical review phase.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Requirements phase first, then Technical review after it is approved.'),
    ).toBeInTheDocument();
  });

  it('NFR a11y groups the phase flow options as native radios in a fieldset/legend', () => {
    const { container } = renderModal();

    const fieldset = container.querySelector('fieldset');
    expect(fieldset).toBeInTheDocument();
    expect(fieldset!.querySelector('legend')).toHaveTextContent('Phase Flow');

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    for (const radio of radios) {
      expect(radio.tagName).toBe('INPUT');
      expect(radio).toHaveAttribute('type', 'radio');
      expect(fieldset).toContainElement(radio);
    }
    // One shared name keeps native arrow-key roving between the options.
    const names = new Set(radios.map((r) => r.getAttribute('name')));
    expect(names.size).toBe(1);
  });

  it('VT-03 (AC-2) renders only the Requirements owner slot for requirements_only', () => {
    renderModal();

    fireEvent.click(screen.getByTestId('phase-flow-radio-requirements-only'));

    expect(screen.getByTestId('so-requirements-owner-input')).toBeInTheDocument();
    expect(screen.queryByTestId('so-technical-owner-input')).not.toBeInTheDocument();
    expect(screen.queryByText(/Technical Owner/)).not.toBeInTheDocument();
  });

  it('VT-03 (AC-2) renders only the Technical owner slot for technical_only', () => {
    renderModal();

    fireEvent.click(screen.getByTestId('phase-flow-radio-technical-only'));

    expect(screen.getByTestId('so-technical-owner-input')).toBeInTheDocument();
    expect(screen.queryByTestId('so-requirements-owner-input')).not.toBeInTheDocument();
    expect(screen.queryByText(/Requirements Owner/)).not.toBeInTheDocument();
  });

  it('AC-2 renders both phase owner slots under the default both_sequential flow', () => {
    renderModal();

    expect(screen.getByTestId('so-requirements-owner-input')).toBeInTheDocument();
    expect(screen.getByTestId('so-technical-owner-input')).toBeInTheDocument();
  });

  it('AC-1 keeps Confirm disabled until every configured phase owner is filled', () => {
    const { onConfirm } = renderModal();
    selectDocumentOwners();

    const confirmBtn = screen.getByTestId('confirm-start-interview-no-reviewers');
    expect(confirmBtn).toBeDisabled();

    selectOwner(/Requirements Owner/, 'Alice Smith');
    expect(screen.getByTestId('confirm-start-interview-no-reviewers')).toBeDisabled();

    selectOwner(/Technical Owner/, 'Bob Jones');
    expect(screen.getByTestId('confirm-start-interview-no-reviewers')).toBeEnabled();

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('AC-1 keeps Next disabled while the single configured phase owner is empty', () => {
    mockUseReviewerAvailability.mockReturnValue(
      availabilityLoaded({ prd: true, design_doc: true, design_prototype: true, test_case: true }),
    );

    renderModal();
    fireEvent.click(screen.getByTestId('phase-flow-radio-technical-only'));
    selectDocumentOwners();

    expect(screen.getByTestId('section-owner-next-btn')).toBeDisabled();

    selectOwner(/Technical Owner/, 'Bob Jones');

    expect(screen.getByTestId('section-owner-next-btn')).toBeEnabled();
  });

  it('AC-0 confirms the default both_sequential flow with both phase owners', () => {
    const { onConfirm } = renderModal();
    selectAllOwners();

    fireEvent.click(screen.getByTestId('confirm-start-interview-no-reviewers'));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseFlow: 'both_sequential',
        requirementsOwnerId: 'alice',
        technicalOwnerId: 'bob',
      }),
    );
  });

  it('AC-2 requirements_only confirm payload clears the technical owner id', () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByTestId('phase-flow-radio-requirements-only'));
    selectOwner(/Requirements Owner/, 'Alice Smith');
    selectDocumentOwners();

    fireEvent.click(screen.getByTestId('confirm-start-interview-no-reviewers'));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseFlow: 'requirements_only',
        requirementsOwnerId: 'alice',
        technicalOwnerId: undefined,
      }),
    );
  });

  it('AC-2 technical_only confirm payload clears the requirements owner id', () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByTestId('phase-flow-radio-technical-only'));
    selectOwner(/Technical Owner/, 'Bob Jones');
    selectDocumentOwners();

    fireEvent.click(screen.getByTestId('confirm-start-interview-no-reviewers'));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        phaseFlow: 'technical_only',
        requirementsOwnerId: undefined,
        technicalOwnerId: 'bob',
      }),
    );
  });

  it('clears the owner of a phase that the new flow removes', () => {
    renderModal();
    selectPhaseOwners();

    expect(screen.getByTestId('so-requirements-owner-clear-btn')).toBeInTheDocument();
    expect(screen.getByTestId('so-technical-owner-clear-btn')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('phase-flow-radio-requirements-only'));
    fireEvent.click(screen.getByTestId('phase-flow-radio-both-sequential'));

    // Technical was dropped from the flow, so its pick is gone; Requirements survives.
    expect(screen.getByTestId('so-technical-owner-input')).toBeInTheDocument();
    expect(screen.queryByTestId('so-technical-owner-clear-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('so-requirements-owner-clear-btn')).toBeInTheDocument();
  });

  it('prefers BA/Product-Owner/Manager for Requirements and Developer for Technical', () => {
    mockUseInterviewGroupsWithMembers.mockReturnValue({ data: ownerGroups, isLoading: false });

    renderModal();

    fireEvent.focus(screen.getByTestId('so-requirements-owner-input'));
    expect(screen.getByTestId('so-requirements-owner-option-ba-1')).toBeInTheDocument();
    expect(screen.getByTestId('so-requirements-owner-option-po-1')).toBeInTheDocument();
    expect(screen.getByTestId('so-requirements-owner-option-mgr-1')).toBeInTheDocument();
    expect(screen.queryByTestId('so-requirements-owner-option-dev-1')).not.toBeInTheDocument();

    fireEvent.focus(screen.getByTestId('so-technical-owner-input'));
    expect(screen.getByTestId('so-technical-owner-option-dev-1')).toBeInTheDocument();
    expect(screen.queryByTestId('so-technical-owner-option-ba-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('so-technical-owner-option-mgr-1')).not.toBeInTheDocument();
  });

  it('falls back to all active users when the preferred groups have no members', () => {
    mockUseInterviewGroupsWithMembers.mockReturnValue({
      data: [{ id: 'g-ux', name: 'UI/UX', members: [{ userId: 'ux-1', displayName: 'Uma Ux', email: 'uma@example.com' }] }],
      isLoading: false,
    });

    renderModal();

    fireEvent.focus(screen.getByTestId('so-requirements-owner-input'));
    expect(screen.getByTestId('so-requirements-owner-option-alice')).toBeInTheDocument();
    expect(screen.getByTestId('so-requirements-owner-option-bob')).toBeInTheDocument();

    fireEvent.focus(screen.getByTestId('so-technical-owner-input'));
    expect(screen.getByTestId('so-technical-owner-option-alice')).toBeInTheDocument();
    expect(screen.getByTestId('so-technical-owner-option-bob')).toBeInTheDocument();
  });
});
