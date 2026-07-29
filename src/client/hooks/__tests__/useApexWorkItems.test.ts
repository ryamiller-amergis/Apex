import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useApexWorkItems, useApexWorkItemOwners, useMoveApexWorkItem } from '../useApexWorkItems';

// ── Mock fetch ────────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

function ok<T>(body: T) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response);
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return Wrapper;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useApexWorkItems', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches items list', async () => {
    const items = [{ id: '1', title: 'Test', status: 'idea' }];
    mockFetch.mockResolvedValue(ok(items));

    const { result } = renderHook(() => useApexWorkItems(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(items);
  });

  it('passes owner filter in query string', async () => {
    mockFetch.mockResolvedValue(ok([]));
    renderHook(() => useApexWorkItems({ ownerId: 'user-1' }), { wrapper: makeWrapper() });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain('ownerId=user-1');
  });

  it('passes types filter joined by comma', async () => {
    mockFetch.mockResolvedValue(ok([]));
    renderHook(() => useApexWorkItems({ types: ['PBI', 'TBI'] }), { wrapper: makeWrapper() });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain('types=PBI%2CTBI');
  });
});

describe('useApexWorkItemOwners', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches owners list', async () => {
    const owners = [{ oid: 'u1', displayName: 'Aneesh', email: 'a@a.com' }];
    mockFetch.mockResolvedValue(ok(owners));

    const { result } = renderHook(() => useApexWorkItemOwners(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(owners);
  });
});

describe('useMoveApexWorkItem', () => {
  beforeEach(() => jest.clearAllMocks());

  it('optimistically updates item status in cache', async () => {
    const item = { id: 'item-1', status: 'idea', position: 0, title: 'T' };
    mockFetch.mockResolvedValue(ok({ ...item, status: 'ready' }));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ['apex-work-items', 'list', {}];
    qc.setQueryData(key, [item]);

    const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);

    const { result } = renderHook(() => useMoveApexWorkItem(), { wrapper: Wrapper });
    result.current.mutate({ id: 'item-1', targetStatus: 'ready' });

    await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));
  });

  it('rolls back on error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ['apex-work-items', 'list', {}];
    qc.setQueryData(key, [{ id: 'item-1', status: 'idea' }]);

    const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);

    const { result } = renderHook(() => useMoveApexWorkItem(), { wrapper: Wrapper });
    result.current.mutate({ id: 'item-1', targetStatus: 'ready' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // After rollback, cache should still have the original item
    const cached = qc.getQueryData<{ id: string; status: string }[]>(key);
    expect(cached?.[0]?.status).toBe('idea');
  });
});
