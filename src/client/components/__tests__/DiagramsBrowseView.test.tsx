/**
 * PBI-004 AC-0..AC-2 / VT-01, VT-02 — Diagrams browse view
 * PBI-006 AC-0, AC-1, AC-3 — delete UI wiring
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DiagramSummary } from '../../../shared/types/diagram';
import { DiagramsView } from '../DiagramsView';

const mockNavigate = jest.fn();
const deleteMutate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../../hooks/useDiagrams', () => ({
  DIAGRAM_LIST_LIMIT: 50,
  useOwnedDiagrams: jest.fn(),
  useSharedDiagrams: jest.fn(),
  useDeleteDiagram: jest.fn(),
}));

import { useAppShell } from '../../hooks/useAppShell';
import {
  useDeleteDiagram,
  useOwnedDiagrams,
  useSharedDiagrams,
} from '../../hooks/useDiagrams';

const PROJECT = 'project-a';

function summary(overrides: Partial<DiagramSummary> = {}): DiagramSummary {
  return {
    id: 'diagram-1',
    projectId: PROJECT,
    ownerId: 'owner-1',
    ownerName: 'Alex Owner',
    title: 'Architecture sketch',
    thumbnail: 'data:image/png;base64,aaa',
    version: 1,
    effectiveAccess: 'owner',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-05T12:00:00.000Z',
    ...overrides,
  };
}

function listResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
    ...overrides,
  };
}

function renderBrowse() {
  return render(
    <MemoryRouter>
      <DiagramsView projectId={PROJECT} />
    </MemoryRouter>,
  );
}

describe('DiagramsBrowseView (PBI-004 / PBI-006)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAppShell as jest.Mock).mockReturnValue({
      can: (key: string) =>
        key === 'diagram:create'
        || key === 'diagram:delete'
        || key === 'diagram:view'
        || key === 'diagram:share',
    });
    (useDeleteDiagram as jest.Mock).mockReturnValue({
      mutate: deleteMutate,
      isPending: false,
      isError: false,
      error: null,
      reset: jest.fn(),
    });
    (useOwnedDiagrams as jest.Mock).mockReturnValue(
      listResult({
        data: {
          items: [
            summary({ id: 'owned-1', title: 'Owned Diagram', effectiveAccess: 'owner' }),
          ],
          hasMore: false,
        },
      }),
    );
    (useSharedDiagrams as jest.Mock).mockReturnValue(
      listResult({
        data: {
          items: [
            summary({
              id: 'shared-1',
              title: 'Shared Diagram',
              ownerName: 'Sam Sharer',
              effectiveAccess: 'view',
            }),
          ],
          hasMore: false,
        },
      }),
    );
  });

  it('AC-0 / VT-01: owned + shared sections show cards with title, updated, owner, badge', () => {
    renderBrowse();

    expect(screen.getByTestId('diagrams-browse-view')).toBeInTheDocument();
    expect(screen.getByTestId('diagrams-tab-owned')).toBeInTheDocument();
    expect(screen.getByTestId('diagrams-tab-shared')).toBeInTheDocument();

    const ownedCard = screen.getByTestId('diagram-card-owned-1');
    expect(within(ownedCard).getByText('Owned Diagram')).toBeInTheDocument();
    expect(within(ownedCard).getByText('Alex Owner')).toBeInTheDocument();
    expect(within(ownedCard).getByTestId('diagram-card-access-badge')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/access:\s*owner/i),
    );

    fireEvent.click(screen.getByTestId('diagrams-tab-shared'));

    const sharedCard = screen.getByTestId('diagram-card-shared-1');
    expect(within(sharedCard).getByText('Shared Diagram')).toBeInTheDocument();
    expect(within(sharedCard).getByText('Sam Sharer')).toBeInTheDocument();
    expect(within(sharedCard).getByTestId('diagram-shared-badge')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/access:\s*view only/i),
    );
  });

  it('AC-1 / VT-02: list error shows diagrams-error and no cards as current', () => {
    (useOwnedDiagrams as jest.Mock).mockReturnValue(
      listResult({
        data: {
          items: [summary({ id: 'stale-1', title: 'Stale Card' })],
          hasMore: false,
        },
        isError: true,
      }),
    );

    renderBrowse();

    expect(screen.getByTestId('diagrams-error')).toBeInTheDocument();
    expect(screen.queryByTestId('diagram-card-stale-1')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale Card')).not.toBeInTheDocument();
  });

  it('AC-2: hasMore shows diagrams-load-more; click loads next offset', () => {
    (useOwnedDiagrams as jest.Mock).mockImplementation((_projectId: string, offset = 0) => {
      if (offset === 0) {
        return listResult({
          data: {
            items: [summary({ id: 'page-1', title: 'Page One' })],
            nextOffset: 50,
            hasMore: true,
          },
        });
      }
      return listResult({
        data: {
          items: [summary({ id: 'page-2', title: 'Page Two' })],
          hasMore: false,
        },
      });
    });

    renderBrowse();

    expect(screen.getByTestId('diagram-card-page-1')).toBeInTheDocument();
    expect(screen.queryByTestId('diagram-card-page-2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diagrams-load-more'));

    expect(useOwnedDiagrams).toHaveBeenCalledWith(PROJECT, 50);
    expect(screen.getByTestId('diagram-card-page-1')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-card-page-2')).toBeInTheDocument();
  });

  it('navigates to /diagrams/{id} when a card is clicked', () => {
    renderBrowse();
    fireEvent.click(screen.getByTestId('diagram-card-owned-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/diagrams/owned-1');
  });

  it('keeps diagram-new-button when diagram:create is allowed', () => {
    renderBrowse();
    expect(screen.getByTestId('diagram-new-button')).toBeInTheDocument();
  });

  it('PBI-006 AC-3: grantee/view card has no diagram-delete-button', () => {
    renderBrowse();
    fireEvent.click(screen.getByTestId('diagrams-tab-shared'));
    const sharedCard = screen.getByTestId('diagram-card-shared-1');
    expect(within(sharedCard).queryByTestId('diagram-delete-button')).not.toBeInTheDocument();
    expect(within(sharedCard).queryByTestId('diagram-share-button')).not.toBeInTheDocument();
  });

  it('PBI-007: owner card exposes share control when diagram:share is allowed', () => {
    renderBrowse();
    const ownedCard = screen.getByTestId('diagram-card-owned-1');
    expect(within(ownedCard).getByTestId('diagram-share-button')).toBeInTheDocument();
  });

  it('PBI-006 AC-0: confirm calls delete mutation', () => {
    renderBrowse();

    fireEvent.click(screen.getByTestId('diagram-delete-button'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diagram-delete-confirm'));
    expect(deleteMutate).toHaveBeenCalledWith(
      'owned-1',
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('VT-10 / PBI-006 AC-1: delete failure shows error and card remains', () => {
    deleteMutate.mockImplementation(
      (_id: string, opts?: { onError?: (err: Error) => void }) => {
        opts?.onError?.(new Error('Delete failed'));
      },
    );

    renderBrowse();
    fireEvent.click(screen.getByTestId('diagram-delete-button'));
    fireEvent.click(screen.getByTestId('diagram-delete-confirm'));

    expect(screen.getByText(/delete failed|could not delete|failed to delete/i)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-card-owned-1')).toBeInTheDocument();
  });
});
