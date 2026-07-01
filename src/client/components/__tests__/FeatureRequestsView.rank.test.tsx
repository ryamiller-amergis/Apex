import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeatureRequest } from '../../../shared/types/featureRequest';
import { FeatureRequestsView } from '../FeatureRequestsView';

const reorderMutateMock = jest.fn();

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

import { useFeatureRequests } from '../../hooks/useFeatureRequests';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: (permission: string) => permission === 'feature-requests:manage',
  }),
}));

function makeRequest(id: string, title: string, rank: number | null): FeatureRequest {
  return {
    id,
    title,
    request: 'details',
    advantage: 'benefit',
    submittedBy: 'user-1',
    sourceProject: 'Apex',
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

function renderView(requests: FeatureRequest[]) {
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
      <FeatureRequestsView />
    </QueryClientProvider>,
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

    const rankValues = screen.getAllByText(/^[123]$/);
    expect(rankValues.map((el) => el.textContent)).toEqual(['1', '2', '3']);
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

    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: jest.fn() };
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
