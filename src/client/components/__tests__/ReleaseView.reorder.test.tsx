import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';
import { WorkItem } from '../../types/workitem';

let mockIsInAnyGroup = jest.fn(() => true);

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: mockIsInAnyGroup,
    permissionsLoaded: true,
  }),
}));

const createWrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
};

global.fetch = jest.fn();

const EPICS = [
  { id: 1, version: 'Alpha', status: 'New', progress: 0, completedItems: 0, totalItems: 0, greenItems: 0, amberItems: 0, redItems: 0, startDate: '', targetDate: '', description: '' },
  { id: 2, version: 'Beta',  status: 'New', progress: 0, completedItems: 0, totalItems: 0, greenItems: 0, amberItems: 0, redItems: 0, startDate: '', targetDate: '', description: '' },
  { id: 3, version: 'Gamma', status: 'New', progress: 0, completedItems: 0, totalItems: 0, greenItems: 0, amberItems: 0, redItems: 0, startDate: '', targetDate: '', description: '' },
];

function setupFetch(orderOk = true) {
  (global.fetch as jest.Mock).mockImplementation((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/releases/epics')) {
      return Promise.resolve({ ok: true, json: async () => EPICS });
    }
    if (url.includes('/api/releases/order') && method === 'PUT') {
      return Promise.resolve({ ok: orderOk, json: async () => orderOk ? { success: true, count: 3 } : { error: 'Forbidden' } });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });
}

const defaultProps: React.ComponentProps<typeof ReleaseView> = {
  workItems: [] as WorkItem[],
  project: 'Proj',
  areaPath: 'Area',
};

describe('ReleaseView – drag reorder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsInAnyGroup = jest.fn(() => true);
  });

  it('renders drag handles (⠿) for BA users', async () => {
    setupFetch();
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    await screen.findByTestId('release-card-1');
    const handles = screen.getAllByTestId(/^release-drag-handle-\d+$/);
    expect(handles).toHaveLength(EPICS.length);
  });

  it('does NOT render drag handles for non-BA users', async () => {
    mockIsInAnyGroup = jest.fn(() => false);
    setupFetch();
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    await screen.findByTestId('release-card-1');
    expect(screen.queryByTestId(/^release-drag-handle-\d+$/)).toBeNull();
  });

  it('calls PUT /api/releases/order when reordering in Manual Order mode', async () => {
    setupFetch();
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    const handle1 = await screen.findByTestId('release-drag-handle-1');
    const card3 = screen.getByTestId('release-card-3');
    const dataTransfer = { effectAllowed: 'move', setData: jest.fn(), dropEffect: 'move' };

    fireEvent.dragStart(handle1, { dataTransfer });
    fireEvent.dragOver(card3, { dataTransfer });
    fireEvent.drop(card3, { dataTransfer });
    fireEvent.dragEnd(handle1);

    await waitFor(() => {
      const orderCall = (global.fetch as jest.Mock).mock.calls.find(([url, opts]: any) =>
        String(url).includes('/api/releases/order') && opts?.method === 'PUT',
      );
      expect(orderCall).toBeDefined();
      expect(JSON.parse(orderCall[1].body)).toMatchObject({
        project: 'Proj',
        areaPath: 'Area',
        epicIds: [2, 3, 1],
      });
    });
  });

  it('does NOT call PUT /api/releases/order when a non-manual sort is active', async () => {
    setupFetch();
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    await screen.findByTestId('release-card-1');
    fireEvent.change(screen.getByTestId('release-sort-select'), { target: { value: 'version' } });

    const handle1 = screen.getByTestId('release-drag-handle-1');
    expect(handle1).toHaveAttribute('draggable', 'false');
    const card3 = screen.getByTestId('release-card-3');

    fireEvent.dragStart(handle1);
    fireEvent.dragOver(card3);
    fireEvent.drop(card3);
    fireEvent.dragEnd(handle1);

    const orderCall = (global.fetch as jest.Mock).mock.calls.find(([url, opts]: any) =>
      String(url).includes('/api/releases/order') && opts?.method === 'PUT',
    );
    expect(orderCall).toBeUndefined();
  });
});
