import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useFeatureRequests,
  useSubmitFeatureRequest,
  useUpdateFeatureRequest,
  useReorderFeatureRequests,
  useReanalyzeFeatureRequest,
} from '../useFeatureRequests';

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

function mockFetchOk(data: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
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

const featureRequest = {
  id: 'fr-1',
  title: 'Dark mode',
  request: 'Add dark mode support',
  advantage: 'Reduced eye strain',
  submittedBy: 'user-1',
  sourceProject: 'Apex',
  status: 'new',
  aiStatus: 'pending',
  aiPriority: null,
  aiRisk: null,
  aiRationale: null,
  aiThreadId: null,
  teamPriority: null,
  teamRisk: null,
  rank: null,
  reviewedBy: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

// ── useFeatureRequests ─────────────────────────────────────────────────────────

describe('useFeatureRequests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/feature-requests?project=Apex and returns the list', async () => {
    mockFetchOk([featureRequest]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFeatureRequests(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ id: 'fr-1', title: 'Dark mode' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/feature-requests?project=Apex',
      expect.any(Object),
    );
  });

  it('returns an empty list when no feature requests exist', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFeatureRequests(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it('surfaces fetch errors', async () => {
    mockFetchError(500, { error: 'Server error' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFeatureRequests(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useSubmitFeatureRequest ────────────────────────────────────────────────────

describe('useSubmitFeatureRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/feature-requests and returns the created feature request', async () => {
    mockFetchOk(featureRequest, 201);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSubmitFeatureRequest(), { wrapper });

    await act(async () => {
      result.current.mutate({
        title: 'Dark mode',
        request: 'Add dark mode support',
        advantage: 'Reduced eye strain',
        project: 'Apex',
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ id: 'fr-1', title: 'Dark mode' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/feature-requests',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends the correct body payload', async () => {
    mockFetchOk(featureRequest, 201);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSubmitFeatureRequest(), { wrapper });

    await act(async () => {
      result.current.mutate({
        title: 'Dark mode',
        request: 'Add dark mode support',
        advantage: 'Reduced eye strain',
        project: 'Apex',
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      title: 'Dark mode',
      request: 'Add dark mode support',
      advantage: 'Reduced eye strain',
      project: 'Apex',
    });
  });

  it('surfaces errors from the API', async () => {
    mockFetchError(400, { error: 'title is required' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSubmitFeatureRequest(), { wrapper });

    await act(async () => {
      result.current.mutate({
        title: '',
        request: 'Add dark mode support',
        advantage: 'Reduced eye strain',
        project: 'Apex',
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useUpdateFeatureRequest ────────────────────────────────────────────────────

describe('useUpdateFeatureRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PATCHes /api/feature-requests/:id with the update payload', async () => {
    const updated = { ...featureRequest, status: 'planned', teamPriority: 'high' };
    mockFetchOk(updated);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateFeatureRequest(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'fr-1', status: 'planned', teamPriority: 'high' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/feature-requests/fr-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('sends only the provided fields in the body', async () => {
    mockFetchOk({ ...featureRequest, teamRisk: 'low' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateFeatureRequest(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'fr-1', teamRisk: 'low' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toEqual({ teamRisk: 'low' });
    expect(callBody).not.toHaveProperty('id');
  });

  it('surfaces errors from the API', async () => {
    mockFetchError(404, { error: 'Feature request not found' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateFeatureRequest(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'fr-999', status: 'planned' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useReorderFeatureRequests ──────────────────────────────────────────────────

describe('useReorderFeatureRequests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PATCHes all rank updates in parallel and invalidates once', async () => {
    mockFetchOk(featureRequest);
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useReorderFeatureRequests(), { wrapper });

    await act(async () => {
      result.current.mutate([
        { id: 'fr-1', rank: 2 },
        { id: 'fr-2', rank: 1 },
      ]);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/feature-requests/fr-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ rank: 2 }),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/feature-requests/fr-2',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ rank: 1 }),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['feature-requests'] });
  });
});

// ── useReanalyzeFeatureRequest ─────────────────────────────────────────────────

describe('useReanalyzeFeatureRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/feature-requests/:id/reanalyze', async () => {
    mockFetchOk({ ok: true }, 202);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReanalyzeFeatureRequest(), { wrapper });

    await act(async () => {
      result.current.mutate('fr-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/feature-requests/fr-1/reanalyze',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces errors from the API', async () => {
    mockFetchError(404, { error: 'Feature request not found' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReanalyzeFeatureRequest(), { wrapper });

    await act(async () => {
      result.current.mutate('fr-999');
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
