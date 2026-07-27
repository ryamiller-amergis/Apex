import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdrsDashboard } from '../AdrsDashboard';
import type { AdrSummary } from '../../../shared/types/adr';

const mockNavigate = jest.fn();
const deleteMutate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../../hooks/useAdrs', () => ({
  useAdrs: jest.fn(),
  useDeleteAdr: jest.fn(),
}));

import { useAppShell } from '../../hooks/useAppShell';
import { useAdrs, useDeleteAdr } from '../../hooks/useAdrs';

const sampleAdr: AdrSummary = {
  id: 'adr-1',
  title: 'Choose event transport',
  project: 'Apex',
  repo: 'Apex',
  status: 'in_progress',
  authorId: 'user-1',
  ownerName: 'Owner One',
  chatThreadId: 'thread-1',
  reviewerIds: [],
  reviewers: [],
  updatedAt: '2026-07-17T00:00:00Z',
  createdAt: '2026-07-17T00:00:00Z',
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <AdrsDashboard />
    </MemoryRouter>,
  );
}

describe('AdrsDashboard — delete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'Apex',
      can: (key: string) => key === 'adr:delete' || key === 'adr:create',
    });
    (useAdrs as jest.Mock).mockReturnValue({ data: [sampleAdr], isLoading: false });
    (useDeleteAdr as jest.Mock).mockReturnValue({ mutate: deleteMutate, isPending: false });
  });

  it('shows a trash delete button on ADR cards when adr:delete is allowed', () => {
    renderDashboard();

    expect(screen.getByRole('button', { name: 'Delete ADR "Choose event transport"' })).toBeInTheDocument();
  });

  it('hides the card delete button when adr:delete is not allowed', () => {
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'Apex',
      can: (key: string) => key === 'adr:create',
    });

    renderDashboard();

    expect(screen.queryByRole('button', { name: /Delete ADR/i })).not.toBeInTheDocument();
  });

  it('opens ConfirmDeleteModal and deletes on confirm', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Delete ADR "Choose event transport"' }));

    expect(screen.getByRole('dialog', { name: 'Delete ADR' })).toBeInTheDocument();
    expect(screen.getByText(/permanently delete the ADR/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(deleteMutate).toHaveBeenCalledWith('adr-1', expect.objectContaining({
      onSuccess: expect.any(Function),
    }));
  });

  it('does not navigate when clicking the delete button on the card', () => {
    renderDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Delete ADR "Choose event transport"' }));

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
