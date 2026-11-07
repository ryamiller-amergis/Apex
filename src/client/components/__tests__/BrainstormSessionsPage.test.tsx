import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BrainstormSessionsPage } from '../BrainstormSessionsPage';
import { BrainstormRepositoryAdmin } from '../BrainstormRepositoryAdmin';
import {
  useBrainstormSessions,
  useCreateBrainstormSession,
  useDeleteBrainstormSession,
} from '../../hooks/useBrainstormSessions';
import {
  useAddBrainstormRepository,
  useBrainstormRepositories,
  useCheckBrainstormRepositoryDrift,
  useCloneBrainstormRepository,
  useDeleteBrainstormRepository,
} from '../../hooks/useBrainstormRepositories';
import { useAppShell } from '../../hooks/useAppShell';

jest.mock('../../hooks/useBrainstormSessions', () => ({
  BrainstormApiError: class BrainstormApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  useBrainstormSessions: jest.fn(),
  useCreateBrainstormSession: jest.fn(),
  useDeleteBrainstormSession: jest.fn(),
}));

jest.mock('../../hooks/useBrainstormRepositories', () => ({
  useBrainstormRepositories: jest.fn(),
  useAddBrainstormRepository: jest.fn(),
  useCloneBrainstormRepository: jest.fn(),
  useDeleteBrainstormRepository: jest.fn(),
  useCheckBrainstormRepositoryDrift: jest.fn(),
}));

jest.mock('../../hooks/useAppShell', () => ({ useAppShell: jest.fn() }));

const list = useBrainstormSessions as jest.Mock;
const create = useCreateBrainstormSession as jest.Mock;
const deleteSession = useDeleteBrainstormSession as jest.Mock;
const shell = useAppShell as jest.Mock;
const listRepos = useBrainstormRepositories as jest.Mock;
const addRepo = useAddBrainstormRepository as jest.Mock;
const cloneRepo = useCloneBrainstormRepository as jest.Mock;
const deleteRepo = useDeleteBrainstormRepository as jest.Mock;
const checkDrift = useCheckBrainstormRepositoryDrift as jest.Mock;

function renderPage() {
  return render(
    <MemoryRouter>
      <BrainstormSessionsPage project="Apex" />
    </MemoryRouter>,
  );
}

describe('BrainstormSessionsPage (VT-31)', () => {
  beforeEach(() => {
    create.mockReturnValue({ mutate: jest.fn(), isPending: false, isError: false });
    deleteSession.mockReturnValue({ mutateAsync: jest.fn().mockResolvedValue({ deleted: true }), isPending: false });
    shell.mockReturnValue({ can: () => false, isSuperAdmin: false });
    listRepos.mockReturnValue({ data: { repositories: [] }, isLoading: false, isError: false });
    addRepo.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
    cloneRepo.mockReturnValue({ mutate: jest.fn(), isPending: false });
    deleteRepo.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
    checkDrift.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
  });

  it('PBI-004 (b): shows an error state whose Retry refetches', () => {
    const refetch = jest.fn();
    list.mockReturnValue({ data: undefined, isLoading: false, isError: true, isFetching: false, refetch });
    renderPage();

    expect(screen.getByTestId('brainstorm-sessions-error')).toHaveAttribute('role', 'alert');
    fireEvent.click(screen.getByTestId('brainstorm-sessions-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when the project has no sessions', () => {
    list.mockReturnValue({
      data: { sessions: [], total: 0 },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: jest.fn(),
    });
    renderPage();
    expect(screen.getByTestId('brainstorm-sessions-empty')).toHaveTextContent(
      'No Brainstorm sessions yet.',
    );
  });

  it('lists sessions in the data grid with title, creator, status chip, search, state filter, and delete confirm modal', async () => {
    const mutateDelete = jest.fn().mockResolvedValue({ deleted: true, id: 's-1' });
    deleteSession.mockReturnValue({ mutateAsync: mutateDelete, isPending: false });
    list.mockReturnValue({
      data: {
        total: 2,
        sessions: [
          {
            id: 's-1',
            title: 'Billing ideas',
            creatorId: 'u-1',
            creatorName: 'Ada',
            state: 'active',
            model: 'm',
            artifactType: null,
            lastActivityAt: '2026-10-29T10:00:00.000Z',
            createdAt: '2026-10-29T09:00:00.000Z',
            canMutate: true,
            canDelete: true,
          },
          {
            id: 's-2',
            title: 'MatterWorx homepage',
            creatorId: 'u-2',
            creatorName: 'Ryan Miller',
            state: 'ended',
            model: 'm',
            artifactType: null,
            lastActivityAt: '2026-10-29T11:00:00.000Z',
            createdAt: '2026-10-29T09:30:00.000Z',
            canMutate: false,
            canDelete: false,
          },
        ],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: jest.fn(),
    });
    renderPage();

    expect(screen.getByTestId('brainstorm-sessions-table')).toBeInTheDocument();
    const rows = screen.getAllByTestId('brainstorm-session-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Billing ideas');
    expect(rows[0]).toHaveTextContent('Ada');
    expect(screen.getByTestId('brainstorm-session-link-s-1')).toHaveAttribute('href', '/brainstorm/s-1');

    // Filter by state pill
    fireEvent.click(screen.getByTestId('brainstorm-sessions-filter-state-ended'));
    expect(screen.getAllByTestId('brainstorm-session-row')).toHaveLength(1);
    expect(screen.getByTestId('brainstorm-session-row')).toHaveTextContent('MatterWorx homepage');

    // Reset to all and search by title/creator
    fireEvent.click(screen.getByTestId('brainstorm-sessions-filter-state-all'));
    fireEvent.change(screen.getByTestId('brainstorm-sessions-search'), { target: { value: 'Ada' } });
    expect(screen.getAllByTestId('brainstorm-session-row')).toHaveLength(1);
    expect(screen.getByTestId('brainstorm-session-row')).toHaveTextContent('Billing ideas');

    // Delete session flow uses confirmation modal
    fireEvent.click(screen.getByTestId('brainstorm-session-delete-s-1'));
    expect(screen.getByTestId('brainstorm-delete-session-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('brainstorm-delete-session-confirm'));
    await waitFor(() => {
      expect(mutateDelete).toHaveBeenCalledWith('s-1');
    });
  });

  it('supports the My Sessions filter pill and Feature-Requests-style pagination controls', () => {
    const sessions = Array.from({ length: 12 }, (_, idx) => ({
      id: `s-${idx + 1}`,
      title: `Session ${idx + 1}`,
      creatorId: idx < 3 ? 'me' : 'other',
      creatorName: idx < 3 ? 'Ryan Miller' : 'Ada',
      state: 'ended' as const,
      model: 'm',
      artifactType: null,
      lastActivityAt: '2026-10-29T10:00:00.000Z',
      createdAt: '2026-10-29T09:00:00.000Z',
      canMutate: false,
      canDelete: idx < 3,
      isCreator: idx < 3,
    }));
    list.mockReturnValue({
      data: { total: sessions.length, sessions },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: jest.fn(),
    });

    renderPage();

    // Default page size 10 shows 1–10 of 12
    const pagination = screen.getByTestId('brainstorm-sessions-pagination');
    expect(pagination).toHaveTextContent('1–10 of 12');
    expect(screen.getAllByTestId('brainstorm-session-row')).toHaveLength(10);
    expect(screen.getByTestId('brainstorm-sessions-page-previous')).toBeDisabled();
    expect(screen.getByTestId('brainstorm-sessions-page-next')).not.toBeDisabled();

    // Next page shows 11–12 of 12
    fireEvent.click(screen.getByTestId('brainstorm-sessions-page-next'));
    expect(pagination).toHaveTextContent('11–12 of 12');
    expect(screen.getAllByTestId('brainstorm-session-row')).toHaveLength(2);

    // Changing page size to 25 resets to page 1 and shows all 12
    fireEvent.change(screen.getByTestId('brainstorm-sessions-page-size'), { target: { value: '25' } });
    expect(pagination).toHaveTextContent('1–12 of 12');
    expect(screen.getAllByTestId('brainstorm-session-row')).toHaveLength(12);

    // Filter by Mine pill shows only the 3 sessions created by the current user
    fireEvent.click(screen.getByTestId('brainstorm-sessions-filter-creator-mine'));
    expect(pagination).toHaveTextContent('1–3 of 3');
    expect(screen.getAllByTestId('brainstorm-session-row')).toHaveLength(3);
  });
});

describe('BrainstormRepositoryAdmin Data Grid', () => {
  beforeEach(() => {
    addRepo.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
    cloneRepo.mockReturnValue({ mutate: jest.fn(), isPending: false });
    deleteRepo.mockReturnValue({ mutateAsync: jest.fn().mockResolvedValue({ deleted: true }), isPending: false });
    checkDrift.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
  });

  it('supports search, status filtering, clone refresh, drift check, and delete confirmation', async () => {
    const mutateClone = jest.fn();
    const mutateDelete = jest.fn().mockResolvedValue({ deleted: true, id: 'r-1' });
    const mutateDrift = jest.fn().mockResolvedValue({
      id: 'r-1',
      localSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      remoteSha: 'f9e8d7c6b5a432109876543210fedcba98765432',
      drifted: true,
      reachable: true,
      checkedAt: '2026-10-30T00:00:00.000Z',
    });
    cloneRepo.mockReturnValue({ mutate: mutateClone, isPending: false });
    deleteRepo.mockReturnValue({ mutateAsync: mutateDelete, isPending: false });
    checkDrift.mockReturnValue({ mutateAsync: mutateDrift, isPending: false });

    listRepos.mockReturnValue({
      data: {
        repositories: [
          {
            id: 'r-1',
            displayName: 'MatterWorx',
            cloneUrl: 'https://dev.azure.com/org/project/_git/matterworx',
            branch: 'main',
            status: 'ready',
            commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            error: null,
            updatedAt: '2026-10-28T00:00:00.000Z',
          },
          {
            id: 'r-2',
            displayName: 'MaxView',
            cloneUrl: 'https://dev.azure.com/org/project/_git/maxview',
            branch: 'development',
            status: 'failed',
            commitSha: null,
            error: 'Authentication failed',
            updatedAt: '2026-10-29T20:00:00.000Z',
          },
        ],
      },
      isLoading: false,
      isError: false,
    });

    render(<BrainstormRepositoryAdmin project="Apex" />);

    expect(screen.getByTestId('brainstorm-repo-table')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-repo-row-r-1')).toHaveTextContent('a1b2c3d');
    expect(screen.getByTestId('brainstorm-repo-stale-r-1')).toHaveTextContent('Stale (>24h)');

    // Refresh clone on a ready repository
    fireEvent.click(screen.getByTestId('brainstorm-repo-clone-r-1'));
    expect(mutateClone).toHaveBeenCalledWith('r-1');

    // Check drift on a ready repository
    fireEvent.click(screen.getByTestId('brainstorm-repo-check-drift-r-1'));
    await waitFor(() => {
      expect(mutateDrift).toHaveBeenCalledWith('r-1');
    });
    expect(screen.getByTestId('brainstorm-repo-drift-r-1')).toHaveTextContent('Behind remote (f9e8d7c)');

    // Filter by Failed pill
    fireEvent.click(screen.getByTestId('brainstorm-repo-filter-status-failed'));
    expect(screen.queryByTestId('brainstorm-repo-row-r-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-repo-row-r-2')).toBeInTheDocument();

    // Reset filter and delete repository with confirm modal
    fireEvent.click(screen.getByTestId('brainstorm-repo-filter-status-all'));
    fireEvent.click(screen.getByTestId('brainstorm-repo-delete-r-1'));
    expect(screen.getByTestId('brainstorm-repo-delete-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('brainstorm-repo-delete-confirm'));
    await waitFor(() => {
      expect(mutateDelete).toHaveBeenCalledWith('r-1');
    });
  });
});
