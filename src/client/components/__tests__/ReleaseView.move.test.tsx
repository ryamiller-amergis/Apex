import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';
import type { WorkItem } from '../../types/workitem';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: () => true,
    permissionsLoaded: true,
  }),
}));

const epics = [
  {
    id: 100,
    version: 'Release A',
    status: 'In Progress',
    progress: 0,
    completedItems: 0,
    totalItems: 1,
  },
  {
    id: 200,
    version: 'Release B',
    status: 'In Progress',
    progress: 0,
    completedItems: 0,
    totalItems: 1,
  },
];

const sharedItem: WorkItem = {
  id: 42,
  title: 'Shared feature',
  state: 'In Progress',
  workItemType: 'Feature',
  assignedTo: 'Test User',
  tags: '',
  changedDate: '2026-01-02',
  createdDate: '2026-01-01',
  areaPath: 'TestArea',
  iterationPath: 'Sprint 1',
};

const nestedItem: WorkItem = {
  ...sharedItem,
  id: 43,
  title: 'Nested PBI',
  workItemType: 'Product Backlog Item',
};

const okResponse = (data: unknown) => Promise.resolve({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => data,
});

const renderView = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ReleaseView workItems={[]} project="TestProject" areaPath="TestArea" />
    </QueryClientProvider>,
  );
};

describe('ReleaseView item assignment behavior', () => {
  beforeEach(() => {
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/releases/epics')) return okResponse(epics) as any;
      if (url.includes('/api/releases/100/related-items')) return okResponse([sharedItem]) as any;
      if (url.includes('/api/releases/200/related-items')) return okResponse([sharedItem]) as any;
      if (url.includes('/api/features/42/children')) return okResponse([nestedItem]) as any;
      if (url.includes('/api/releases/200/link-related') && init?.method === 'POST') {
        return okResponse({
          success: true,
          linkedCount: 1,
          movedCount: 1,
          unchangedCount: 0,
          movedFrom: { 42: [100] },
        }) as any;
      }
      return okResponse([]) as any;
    }) as jest.Mock;
  });

  it('expands only the nested card for the active release when switching between releases sharing an item', async () => {
    renderView();

    await screen.findByTestId('release-card-100');
    fireEvent.click(await screen.findByTestId('release-item-expand-100-42'));

    await screen.findByText('Nested PBI');
    expect(screen.getByTitle('Collapse children')).toBeInTheDocument();

    // Switch to Release B — nested expansion is scoped by `${epicId}:${itemId}` so #42 starts collapsed
    fireEvent.click(screen.getByTestId('release-card-200'));
    await screen.findByTestId('release-item-200-42');
    expect(screen.queryByText('Nested PBI')).not.toBeInTheDocument();
    expect(screen.getByTitle('Expand to view children')).toBeInTheDocument();
  });

  it('moves a card when it is dragged onto another release card in the queue', async () => {
    renderView();

    await screen.findByTestId('release-card-100');
    const card = await screen.findByTestId('release-item-100-42');

    const dataTransfer = { effectAllowed: 'move', setData: jest.fn(), dropEffect: 'none' };
    const queuedFrames: FrameRequestCallback[] = [];
    const realRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    };
    fireEvent.dragStart(card, { dataTransfer });
    const frames = queuedFrames.splice(0);
    window.requestAnimationFrame = realRequestAnimationFrame;
    frames.forEach((callback) => callback(0));

    expect(document.querySelector('.release-view')).toHaveClass('is-moving-card');
    const targetCard = screen.getByTestId('release-card-200');
    fireEvent.dragOver(targetCard, { dataTransfer });
    fireEvent.drop(targetCard, { dataTransfer });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/releases/200/link-related',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"workItemIds":[42]'),
        }),
      );
    });
    expect(await screen.findByText('#42 moved to Release B.')).toBeInTheDocument();
    expect(screen.queryByTestId('release-item-100-42')).not.toBeInTheDocument();
  });
});
