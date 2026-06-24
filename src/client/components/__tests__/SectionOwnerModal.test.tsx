import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SectionOwnerModal } from '../SectionOwnerModal';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../hooks/useInterviews', () => ({
  useActiveUsers: jest.fn(),
  useAvailableApproverPool: jest.fn(),
  useInterviewGroupsWithMembers: jest.fn(),
}));

import { useActiveUsers, useAvailableApproverPool, useInterviewGroupsWithMembers } from '../../hooks/useInterviews';
const mockUseActiveUsers = useActiveUsers as jest.Mock;
const mockUseApproverPool = useAvailableApproverPool as jest.Mock;
const mockUseInterviewGroupsWithMembers = useInterviewGroupsWithMembers as jest.Mock;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const activeUsers = [
  { oid: 'alice', displayName: 'Alice Smith', email: 'alice@example.com' },
  { oid: 'bob', displayName: 'Bob Jones', email: 'bob@example.com' },
];

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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SectionOwnerModal', () => {
  beforeEach(() => {
    mockUseActiveUsers.mockReturnValue({ data: activeUsers, isLoading: false });
    mockUseApproverPool.mockReturnValue({ data: { individuals: [], groups: [] }, isLoading: false });
    mockUseInterviewGroupsWithMembers.mockReturnValue({ data: [], isLoading: false });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the heading', () => {
    renderModal();
    expect(screen.getByText(/Assign Owners/)).toBeInTheDocument();
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
