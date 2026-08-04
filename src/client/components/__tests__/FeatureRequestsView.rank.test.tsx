import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeatureRequest, WorkItemType } from '../../../shared/types/featureRequest';
import { FeatureRequestsView } from '../FeatureRequestsView';

const reorderMutateMock = jest.fn();
const navigateMock = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => navigateMock,
}));

jest.mock('../../hooks/useFeatureRequests', () => ({
  useFeatureRequests: jest.fn(),
  useUpdateFeatureRequest: () => ({
    mutate: jest.fn(),
    isPending: false,
  }),
  useReorderFeatureRequests: () => ({
    mutate: reorderMutateMock,
    isPending: false,
  }),
  useReanalyzeFeatureRequest: () => ({
    mutate: jest.fn(),
    isPending: false,
  }),
}));

jest.mock('../FeatureRequestDetailPanel', () => ({
  FeatureRequestDetailPanel: () => null,
}));

jest.mock('../FeatureRequestModal', () => ({
  FeatureRequestModal: ({ selectedProject, type }: { selectedProject: string; type: WorkItemType }) => (
    <div role="dialog">New {type} item for {selectedProject}</div>
  ),
}));

import { useFeatureRequests } from '../../hooks/useFeatureRequests';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: (permission: string) =>
      permission === 'feature-requests:manage' ||
      permission === 'feature-requests:submit' ||
      permission === 'interviews:manage',
    isInAnyGroup: () => true,
    permissionsLoaded: true,
    selectedProject: 'Apex',
  }),
}));

function makeRequest(
  id: string,
  title: string,
  rank: number | null,
  interviewId: string | null = null,
  type: WorkItemType = 'feature',
): FeatureRequest {
  return {
    id,
    type,
    title,
    request: 'details',
    advantage: 'benefit',
    interviewId,
    submittedBy: 'user-1',
    sourceProject: 'Apex',
    linkedAdrs: [],
    status: 'new',
    aiStatus: 'complete',
    aiPriority: 'medium',
    aiRisk: 'low',
    aiRationale: 'Looks good',
    aiThreadId: null,
    teamPriority: null,
    teamRisk: null,
    rank,
    reviewedBy: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  };
}

function renderView(requests: FeatureRequest[], initialEntry = '/feature-requests') {
  (useFeatureRequests as jest.Mock).mockReturnValue({
    data: requests,
    isLoading: false,
    error: null,
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <FeatureRequestsView />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('FeatureRequestsView rank reordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows list position in the rank column, not gapped stored ranks', () => {
    renderView([
      makeRequest('a', 'Alpha', 1),
      makeRequest('b', 'Beta', 5),
      makeRequest('c', 'Gamma', 9),
    ]);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row, index) => within(row).getByText(String(index + 1)).textContent))
      .toEqual(['1', '2', '3']);
  });

  it('persists sequential ranks when move-down is clicked', () => {
    renderView([
      makeRequest('a', 'Alpha', 1),
      makeRequest('b', 'Beta', 2),
      makeRequest('c', 'Gamma', 3),
    ]);

    const moveDownButtons = screen.getAllByTitle('Move down');
    fireEvent.click(moveDownButtons[0]);

    expect(reorderMutateMock).toHaveBeenCalledTimes(1);
    expect(reorderMutateMock).toHaveBeenCalledWith([
      { id: 'b', rank: 1 },
      { id: 'a', rank: 2 },
    ]);
  });

  it('persists sequential ranks after drag-and-drop reorder', () => {
    renderView([
      makeRequest('a', 'Alpha', 1),
      makeRequest('b', 'Beta', 2),
      makeRequest('c', 'Gamma', 3),
    ]);

    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: jest.fn(),
    };
    const dragHandles = screen.getAllByLabelText('Drag to reorder');
    const rows = screen.getAllByRole('row').slice(1);

    fireEvent.dragStart(dragHandles[0], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer });
    fireEvent.drop(rows[2], { dataTransfer });

    expect(reorderMutateMock).toHaveBeenCalledTimes(1);
    expect(reorderMutateMock).toHaveBeenCalledWith([
      { id: 'b', rank: 1 },
      { id: 'c', rank: 2 },
      { id: 'a', rank: 3 },
    ]);
  });
});

describe('FeatureRequestsView row actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('offers Kick off interview and View interview as row action buttons', () => {
    renderView([
      makeRequest('a', 'Alpha', 1),
      makeRequest('b', 'Beta', 2, 'interview-1'),
    ]);

    fireEvent.click(
      screen.getByRole('button', { name: 'Kick off interview' })
    );
    expect(navigateMock).toHaveBeenCalledWith('/backlog/interview/new', {
      state: {
        featureRequest: {
          id: 'a',
          type: 'feature',
          title: 'Alpha',
          request: 'details',
          advantage: 'benefit',
          linkedAdrs: [],
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'View interview' }));
    expect(navigateMock).toHaveBeenCalledWith('/backlog/interview/interview-1');
  });
});

describe('FeatureRequestsView submission', () => {
  it('opens the feature request form from the grid toolbar when the grid is empty', () => {
    renderView([]);

    fireEvent.click(
      screen.getByRole('button', { name: 'New feature request' })
    );

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'New feature item for Apex'
    );
  });
});

describe('FeatureRequestsView work item type filter', () => {
  it('shows counts and filters items by the selected query-param type', () => {
    renderView(
      [
        makeRequest('f', 'Feature Alpha', 1),
        makeRequest('t', 'Technical Beta', 1, null, 'technical'),
        makeRequest('i', 'Issue Gamma', 1, null, 'issue'),
      ],
      '/feature-requests?tab=technical',
    );

    expect(
      screen.getByRole('button', { name: /Technical 1/i }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Technical Beta')).toBeInTheDocument();
    expect(screen.queryByText('Feature Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Issue Gamma')).not.toBeInTheDocument();
  });

  it('opens a type-aware modal from the active type', () => {
    renderView([], '/feature-requests?tab=issue');

    fireEvent.click(screen.getByRole('button', { name: 'New issue' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('New issue item for Apex');
  });

  it('allows kicking off an interview from a technical item', () => {
    renderView(
      [makeRequest('t', 'Technical Beta', 1, null, 'technical')],
      '/feature-requests?tab=technical',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Kick off interview' }));

    expect(navigateMock).toHaveBeenCalledWith('/backlog/interview/new', {
      state: {
        featureRequest: {
          id: 't',
          type: 'technical',
          title: 'Technical Beta',
          request: 'details',
          advantage: 'benefit',
          linkedAdrs: [],
        },
      },
    });
  });
});
