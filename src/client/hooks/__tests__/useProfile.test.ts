/**
 * PBI-001 / PBI-002 useProfile hook tests.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  currentProfileQueryKey,
  useCurrentProfile,
  useProfileCard,
  useUpdateCurrentProfile,
} from '../useProfile';
import type { CurrentProfileResponse, ProfileCardResponse } from '../../../shared/types/profile';

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

const currentProfile: CurrentProfileResponse = {
  userOid: 'oid-a',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  bio: 'Prior bio',
  avatar: { userOid: 'oid-a', version: null },
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const card: ProfileCardResponse = {
  userOid: 'oid-b',
  displayName: 'Colleague',
  bio: 'Hello',
  avatar: { userOid: 'oid-b', version: '2026-07-10T00:00:00.000Z' },
};

describe('useCurrentProfile — PBI-001 AC-0', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-0: fetches /api/profile/current with credentials', async () => {
    mockFetchOk(currentProfile);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCurrentProfile(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(currentProfile);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/profile/current',
      expect.objectContaining({ credentials: 'include' })
    );
  });
});

describe('useUpdateCurrentProfile — PBI-001 AC-0 AC-1 AC-2', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-0: PUTs bio and refreshes current profile on success', async () => {
    const updated = { ...currentProfile, bio: 'New bio' };
    mockFetchOk(updated);
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(currentProfileQueryKey, currentProfile);

    const { result } = renderHook(() => useUpdateCurrentProfile(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ bio: 'New bio' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/profile/current',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({ bio: 'New bio' }),
      })
    );
    expect(queryClient.getQueryData(currentProfileQueryKey)).toEqual(updated);
  });

  it('AC-1: on save failure retains previously cached bio and identity', async () => {
    mockFetchError(500, { error: 'Internal server error' });
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(currentProfileQueryKey, currentProfile);

    const { result } = renderHook(() => useUpdateCurrentProfile(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ bio: 'Draft that failed' })).rejects.toThrow();
    });

    expect(queryClient.getQueryData(currentProfileQueryKey)).toEqual(currentProfile);
  });

  it('AC-2: empty bio and 500-char bio are accepted by the mutation body', async () => {
    mockFetchOk({ ...currentProfile, bio: null });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUpdateCurrentProfile(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ bio: null });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/profile/current',
      expect.objectContaining({ body: JSON.stringify({ bio: null }) })
    );

    const boundary = 'q'.repeat(500);
    mockFetchOk({ ...currentProfile, bio: boundary });
    await act(async () => {
      await result.current.mutateAsync({ bio: boundary });
    });
    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/profile/current',
      expect.objectContaining({ body: JSON.stringify({ bio: boundary }) })
    );
  });
});

describe('useProfileCard — PBI-002 AC-0 AC-1 AC-2', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-0: fetches card projection for colleague oid', async () => {
    mockFetchOk(card);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProfileCard('oid-b'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(card);
    expect(result.current.data).not.toHaveProperty('email');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/profile/users/oid-b/card',
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('AC-1: surfaces error for contained unavailable state consumers', async () => {
    mockFetchError(500, { error: 'Internal server error' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProfileCard('oid-b'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('AC-2: null bio and null avatar version are valid card data', async () => {
    mockFetchOk({
      userOid: 'oid-b',
      displayName: 'Colleague',
      bio: null,
      avatar: { userOid: 'oid-b', version: null },
    } satisfies ProfileCardResponse);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProfileCard('oid-b'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.bio).toBeNull();
    expect(result.current.data!.avatar.version).toBeNull();
  });

  it('disables the query when oid is missing', async () => {
    mockFetchOk(card);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProfileCard(''), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
