import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DesignPrototypeReviewView from '../DesignPrototypeReviewView';

const mockUseAppShell = jest.fn();
const mockUsePrototypeAssignments = jest.fn();
const mockUseInterview = jest.fn();
const mockUsePrototypeComments = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => mockUseAppShell(),
}));

jest.mock('../../hooks/useDesignPrototypes', () => ({
  usePrototypesForPrd: () => ({
    data: [{
      id: 'prototype-1',
      featureName: 'Owner-only feature',
      status: 'pending_review',
      mockVersion: 1,
      model: null,
    }],
    isLoading: false,
  }),
  usePrototypeAssignments: () => mockUsePrototypeAssignments(),
  usePrototype: () => ({
    data: {
      id: 'prototype-1',
      featureName: 'Owner-only feature',
      status: 'pending_review',
      mockVersion: 1,
      mockHtml: '<main>Prototype</main>',
      pbiRequirements: [],
      history: [],
    },
  }),
  usePrototypeComments: () => mockUsePrototypeComments(),
  useRegeneratePrototype: () => ({ mutate: jest.fn(), isPending: false }),
  useRetryPrototype: () => ({ mutate: jest.fn(), isPending: false }),
  useResetPrototype: () => ({ mutate: jest.fn(), isPending: false }),
  useGeneratePrototypesForPrd: () => ({ mutate: jest.fn(), isPending: false }),
  useReviewPrototype: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useReopenPrototype: () => ({ mutate: jest.fn(), isPending: false }),
  useAddPrototypeComment: () => ({ mutate: jest.fn(), error: null }),
  useResolvePrototypeComment: () => ({ mutate: jest.fn() }),
  useUpdatePrototypeHtml: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock('../../hooks/useInterviews', () => ({
  useDesignDocsByPrd: () => ({ data: [] }),
  usePrd: () => ({ data: { id: 'prd-1', ownerId: 'owner-1', authorId: 'author-1' } }),
  useInterview: () => mockUseInterview(),
  useOwnerApprove: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock('../UiMockPreview', () => ({
  UiMockPreview: () => <div>Prototype preview</div>,
}));
jest.mock('../ReviewReasonModal', () => ({ ReviewReasonModal: () => null }));

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/backlog/design-prototype/prd-1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<DesignPrototypeReviewView />, { wrapper: Wrapper });
}

describe('PBI-006 Design Prototype owner-only approval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsePrototypeAssignments.mockReturnValue({ data: [], isLoading: false });
    mockUsePrototypeComments.mockReturnValue({ data: [] });
    mockUseInterview.mockReturnValue({ data: { designPrototypeOwnerId: 'owner-1' } });
    mockUseAppShell.mockReturnValue({
      can: () => true,
      userId: 'owner-1',
      isAdmin: false,
      isSuperAdmin: false,
    });
  });

  it('AC-0 offers one-step approval and omits revision for the owner', () => {
    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Request (Changes|Revision)/ })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Add a comment...')).toBeInTheDocument();
  });

  it('does not infer owner-only review when assignment loading fails', () => {
    mockUsePrototypeAssignments.mockReturnValue({ data: [], isLoading: false, isError: true });

    renderView();

    expect(screen.queryByRole('button', { name: 'Approve as Owner' })).not.toBeInTheDocument();
  });

  it('does not fall back to the PRD owner when no prototype owner is assigned', () => {
    mockUseInterview.mockReturnValue({ data: {} });

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).toBeDisabled();
  });

  it('hides the comment controls without interviews:manage permission', () => {
    mockUseAppShell.mockReturnValue({
      can: () => false,
      userId: 'owner-1',
      isAdmin: false,
      isSuperAdmin: false,
    });

    renderView();

    expect(screen.queryByPlaceholderText('Add a comment...')).not.toBeInTheDocument();
  });

  it('AC-3 disables owner approval for a Project Admin who is not Platform Admin', () => {
    mockUseAppShell.mockReturnValue({
      can: () => true,
      userId: 'project-admin-1',
      isAdmin: true,
      isSuperAdmin: false,
    });

    renderView();

    const approve = screen.getByRole('button', { name: 'Approve as Owner' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('aria-describedby', 'owner-approve-disabled-reason');
    expect(screen.getByTestId('owner-approve-disabled-reason')).toHaveTextContent(
      'Only the document owner or a Platform Admin can approve',
    );
  });
});
