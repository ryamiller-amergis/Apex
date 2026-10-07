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
      if (url.startsWith('/api/releases?')) return okResponse([]) as any;
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

  it('expands only the nested card that was clicked when an item appears in two releases', async () => {
    renderView();

    await screen.findByText('Release A');
    screen.getAllByTitle('Expand').forEach((button) => fireEvent.click(button));
    await waitFor(() => expect(screen.getAllByText('Shared feature')).toHaveLength(2));

    fireEvent.click(screen.getAllByTitle('Expand to view children')[0]);

    await screen.findByText('Nested PBI');
    expect(screen.getAllByText('Nested PBI')).toHaveLength(1);
    expect(screen.getAllByTitle('Collapse children')).toHaveLength(1);
    expect(screen.getAllByTitle('Expand to view children')).toHaveLength(1);
  });

  it('moves a card when it is dragged onto another release row', async () => {
    renderView();

    await screen.findByText('Release A');
    fireEvent.click(screen.getAllByTitle('Expand')[0]);
    const card = (await screen.findByText('Shared feature')).closest('.child-item-card');
    expect(card).not.toBeNull();

    const dataTransfer = { effectAllowed: 'move', setData: jest.fn(), dropEffect: 'none' };
    const queuedFrames: FrameRequestCallback[] = [];
    const realRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    };
    fireEvent.dragStart(card!, { dataTransfer });
    const frames = queuedFrames.splice(0);
    window.requestAnimationFrame = realRequestAnimationFrame;
    frames.forEach((callback) => callback(0));
    expect(document.querySelector('.release-view')).toHaveClass('is-moving-card');
    const dropZone = screen.getByText('Drop here to add to Release B');
    fireEvent.dragOver(dropZone, { dataTransfer });
    fireEvent.drop(dropZone, { dataTransfer });

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
    expect(screen.queryByText('Shared feature')).not.toBeInTheDocument();
  });
});
