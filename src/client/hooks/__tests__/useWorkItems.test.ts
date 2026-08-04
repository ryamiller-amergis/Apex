import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../../config/env', () => ({
  env: { VITE_POLL_INTERVAL: 60 },
}));

const getWorkItems = jest.fn().mockResolvedValue([]);

jest.mock('../../services/workItemService', () => ({
  workItemService: {
    getWorkItems: (...args: unknown[]) => getWorkItems(...args),
    updateDueDate: jest.fn(),
  },
}));

import { useWorkItems } from '../useWorkItems';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return wrapper;
}

const start = new Date('2026-08-01T00:00:00.000Z');
const end = new Date('2026-08-31T00:00:00.000Z');

beforeEach(() => {
  getWorkItems.mockClear();
  getWorkItems.mockResolvedValue([]);
});

describe('useWorkItems', () => {
  it('does not fetch when disabled', async () => {
    const wrapper = createWrapper();
    renderHook(
      () => useWorkItems(start, end, 'MaxView', 'MaxView', false),
      { wrapper },
    );

    await waitFor(() => {
      expect(getWorkItems).not.toHaveBeenCalled();
    });
  });

  it('skips the network call for Apex projects', async () => {
    const wrapper = createWrapper();
    renderHook(
      () => useWorkItems(start, end, 'Apex', 'Apex', true),
      { wrapper },
    );

    await waitFor(() => {
      expect(getWorkItems).not.toHaveBeenCalled();
    });
  });

  it('fetches when enabled for a non-Apex project', async () => {
    const wrapper = createWrapper();
    renderHook(
      () => useWorkItems(start, end, 'MaxView', 'MaxView/Team', true),
      { wrapper },
    );

    await waitFor(() => {
      expect(getWorkItems).toHaveBeenCalledWith(
        '2026-08-01',
        '2026-08-31',
        'MaxView',
        'MaxView\\Team',
      );
    });
  });
});
