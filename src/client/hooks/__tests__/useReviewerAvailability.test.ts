import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReviewerAvailability } from '../useReviewerAvailability';

// ── QueryClient wrapper ────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function mockFetchOk(data: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

function mockFetchError(status: number, body: unknown = { error: `HTTP ${status}` }) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const interviewAvailability = {
  project: 'proj-alpha',
  modules: [
    { documentType: 'prd', available: true, candidateCount: 2 },
    { documentType: 'design_doc', available: false, candidateCount: 0 },
    { documentType: 'design_prototype', available: false, candidateCount: 0 },
    { documentType: 'test_case', available: false, candidateCount: 0 },
  ],
};

const adrAvailability = {
  project: 'proj-alpha',
  modules: [{ documentType: 'adr', available: true, candidateCount: 3 }],
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('useReviewerAvailability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches the interviews endpoint by default and returns the module list', async () => {
    mockFetchOk(interviewAvailability);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReviewerAvailability('proj-alpha'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(interviewAvailability);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/reviewer-availability?project=proj-alpha',
      expect.any(Object),
    );
  });

  it('fetches the adr endpoint when the adr surface is requested', async () => {
    mockFetchOk(adrAvailability);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReviewerAvailability('proj-alpha', 'adr'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/adr/reviewer-availability?project=proj-alpha',
      expect.any(Object),
    );
  });

  it('URL-encodes the project name', async () => {
    mockFetchOk(interviewAvailability);
    const { wrapper } = createWrapper();

    renderHook(() => useReviewerAvailability('my project/with spaces'), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      `/api/interviews/reviewer-availability?project=${encodeURIComponent('my project/with spaces')}`,
      expect.any(Object),
    );
  });

  it('does not fetch when project is null', async () => {
    mockFetchOk(interviewAvailability);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReviewerAvailability(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch when project is an empty string', async () => {
    mockFetchOk(interviewAvailability);
    const { wrapper } = createWrapper();

    renderHook(() => useReviewerAvailability(''), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keys the query by project and surface so the two surfaces do not share a cache entry', async () => {
    mockFetchOk(interviewAvailability);
    const { wrapper } = createWrapper();

    const { result, rerender } = renderHook(
      ({ surface }: { surface: 'interviews' | 'adr' }) =>
        useReviewerAvailability('proj-alpha', surface),
      { wrapper, initialProps: { surface: 'interviews' as 'interviews' | 'adr' } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    mockFetchOk(adrAvailability);
    rerender({ surface: 'adr' });

    await waitFor(() => expect(result.current.data).toEqual(adrAvailability));
  });

  it('surfaces load errors instead of reporting an empty module list', async () => {
    mockFetchError(500);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReviewerAvailability('proj-alpha'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.data).toBeUndefined();
  });

  it('refetch re-requests availability after a failure', async () => {
    mockFetchError(500);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReviewerAvailability('proj-alpha'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));

    mockFetchOk(interviewAvailability);
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(interviewAvailability);
  });
});
