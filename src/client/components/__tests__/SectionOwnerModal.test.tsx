import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionOwnerModal } from '../SectionOwnerModal';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../hooks/useInterviews', () => ({
  useActiveUsers: jest.fn(),
}));

import { useActiveUsers } from '../../hooks/useInterviews';
const mockUseActiveUsers = useActiveUsers as jest.Mock;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const activeUsers = [
  { oid: 'alice', displayName: 'Alice Smith', email: 'alice@example.com' },
  { oid: 'bob', displayName: 'Bob Jones', email: 'bob@example.com' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

interface RenderResult {
  onConfirm: jest.Mock;
  onSkip: jest.Mock;
}

function renderModal(
  overrides: Partial<React.ComponentProps<typeof SectionOwnerModal>> = {},
): RenderResult {
  const onConfirm = jest.fn();
  const onSkip = jest.fn();
  render(
    <SectionOwnerModal
      project="proj-alpha"
      onConfirm={onConfirm}
      onSkip={onSkip}
      {...overrides}
    />,
  );
  return { onConfirm, onSkip };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SectionOwnerModal', () => {
  beforeEach(() => {
    mockUseActiveUsers.mockReturnValue({ data: activeUsers, isLoading: false });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the "Assign Section Owners" heading', () => {
    renderModal();
    expect(screen.getByText('Assign Section Owners')).toBeInTheDocument();
  });

  it('renders PRD owner and Design Doc owner field labels', () => {
    renderModal();
    expect(screen.getByText('PRD Owner (BA)')).toBeInTheDocument();
    expect(screen.getByText('Design Doc Owner (Developer)')).toBeInTheDocument();
  });

  it('shows loading text for both fields while users are being fetched', () => {
    mockUseActiveUsers.mockReturnValue({ data: [], isLoading: true });
    renderModal();
    const loadingEls = screen.getAllByText('Loading users…');
    expect(loadingEls).toHaveLength(2);
  });

  it('renders combobox inputs when users have loaded', () => {
    renderModal();
    // Both comboboxes should be visible (one for each owner type)
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(2);
  });

  it('clicking Skip calls onSkip', () => {
    const { onSkip } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('clicking the close (✕) button calls onSkip', () => {
    const { onSkip } = renderModal();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('clicking the overlay backdrop calls onSkip', () => {
    const { onSkip } = renderModal();
    const overlay = screen.getByRole('dialog');
    fireEvent.click(overlay);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape calls onSkip', () => {
    const { onSkip } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('clicking Confirm with no owners selected calls onConfirm with undefined owner IDs', () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      prdOwnerId: undefined,
      designDocOwnerId: undefined,
    });
  });

  it('Skip and Confirm buttons are disabled when isSubmitting=true', () => {
    renderModal({ isSubmitting: true });
    expect(screen.getByRole('button', { name: /skip/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /confirm|creating/i })).toBeDisabled();
  });

  it('shows "Creating…" label on the confirm button when isSubmitting=true', () => {
    renderModal({ isSubmitting: true });
    expect(screen.getByText('Creating…')).toBeInTheDocument();
  });

  it('clicking inside the modal card does not call onSkip', () => {
    const { onSkip } = renderModal();
    // Click the card itself (not the overlay)
    const card = screen.getByText('Assign Section Owners').closest('div')!;
    fireEvent.click(card);
    expect(onSkip).not.toHaveBeenCalled();
  });
});
