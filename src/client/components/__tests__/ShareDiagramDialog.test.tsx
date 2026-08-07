/**
 * PBI-007 AC-0..AC-3 / VT-10, VT-11 — ShareDiagramDialog owner grant management
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DiagramShare, DiagramShareTarget } from '../../../shared/types/diagram';
import { ShareDiagramDialog } from '../ShareDiagramDialog';
import { DiagramApiError } from '../../services/diagramApi';

const sharesMutate = jest.fn();
const changeMutate = jest.fn();
const revokeMutate = jest.fn();

jest.mock('../../hooks/useDiagramShares', () => ({
  useDiagramShares: jest.fn(),
  useShareTargets: jest.fn(),
  useCreateShare: jest.fn(),
  useChangeShareAccess: jest.fn(),
  useRevokeShare: jest.fn(),
}));

import {
  useChangeShareAccess,
  useCreateShare,
  useDiagramShares,
  useRevokeShare,
  useShareTargets,
} from '../../hooks/useDiagramShares';

const PROJECT = 'project-a';
const DIAGRAM_ID = 'diagram-1';

const existingShare: DiagramShare = {
  id: 'share-1',
  diagramId: DIAGRAM_ID,
  granteeId: 'user-2',
  granteeName: 'Teammate Two',
  access: 'view',
  createdAt: '2026-08-06T00:00:00.000Z',
};

const targets: DiagramShareTarget[] = [
  {
    userId: 'user-2',
    displayName: 'Teammate Two',
    email: 'two@example.com',
    existingAccess: 'view',
  },
  {
    userId: 'user-3',
    displayName: 'Teammate Three',
    email: 'three@example.com',
    existingAccess: null,
  },
];

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ShareDiagramDialog
        projectId={PROJECT}
        diagramId={DIAGRAM_ID}
        diagramTitle="Architecture sketch"
        onClose={jest.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('ShareDiagramDialog (PBI-007)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useDiagramShares as jest.Mock).mockReturnValue({
      data: [existingShare],
      isLoading: false,
      isError: false,
      error: null,
    });
    (useShareTargets as jest.Mock).mockReturnValue({
      data: targets,
      isLoading: false,
      isError: false,
    });
    (useCreateShare as jest.Mock).mockReturnValue({
      mutate: sharesMutate,
      isPending: false,
    });
    (useChangeShareAccess as jest.Mock).mockReturnValue({
      mutate: changeMutate,
      isPending: false,
    });
    (useRevokeShare as jest.Mock).mockReturnValue({
      mutate: revokeMutate,
      isPending: false,
    });
  });

  it('PBI-007 AC-0: owner can grant view access to a teammate without an existing grant', () => {
    renderDialog();

    expect(screen.getByTestId('share-diagram-dialog')).toHaveAttribute('role', 'dialog');
    fireEvent.click(screen.getByTestId('share-target-user-3'));
    fireEvent.click(screen.getByTestId('share-access-view'));
    fireEvent.click(screen.getByTestId('share-add-button'));

    expect(sharesMutate).toHaveBeenCalledWith(
      { granteeId: 'user-3', access: 'view' },
      expect.any(Object),
    );
  });

  it('PBI-007 AC-2: selecting an already-granted teammate updates rather than duplicates', () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('share-target-user-2'));
    fireEvent.click(screen.getByTestId('share-access-edit'));
    fireEvent.click(screen.getByTestId('share-add-button'));

    expect(sharesMutate).not.toHaveBeenCalled();
    expect(changeMutate).toHaveBeenCalledWith(
      { granteeId: 'user-2', access: 'edit' },
      expect.any(Object),
    );
  });

  it('PBI-007 AC-1 / VT-11: mutation failure shows error and keeps prior grant list', async () => {
    (useCreateShare as jest.Mock).mockReturnValue({
      mutate: (_input: unknown, opts?: { onError?: (err: Error) => void }) => {
        opts?.onError?.(new DiagramApiError('Server error', 500));
      },
      isPending: false,
    });

    renderDialog();

    fireEvent.click(screen.getByTestId('share-target-user-3'));
    fireEvent.click(screen.getByTestId('share-add-button'));

    await waitFor(() => {
      expect(screen.getByTestId('share-error')).toHaveTextContent('Server error');
    });
    expect(screen.getByTestId('share-grant-row')).toBeInTheDocument();
    expect(within(screen.getByTestId('share-grant-row')).getByText('Teammate Two')).toBeInTheDocument();
  });

  it('PBI-007 AC-0 revoke: revoke button calls revoke mutation', () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('share-revoke-button'));
    expect(revokeMutate).toHaveBeenCalledWith('user-2', expect.any(Object));
  });

  it('empty grant list shows empty copy', () => {
    (useDiagramShares as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderDialog();
    expect(screen.getByText('Not shared with anyone yet')).toBeInTheDocument();
  });
});
