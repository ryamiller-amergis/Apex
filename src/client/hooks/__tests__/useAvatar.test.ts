/**
 * PBI-003 / PBI-004 useAvatar hook tests.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { currentProfileQueryKey } from '../useProfile';
import { avatarDescriptorFromSubject, useDeleteAvatar, useUploadAvatar } from '../useAvatar';
import { buildAvatarResolverUrl } from '../../../shared/types/profile';
import type { AvatarMutationResponse, CurrentProfileResponse } from '../../../shared/types/profile';

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
  bio: null,
  avatar: { userOid: 'oid-a', version: null },
  updatedAt: null,
};

const uploadedProfile: CurrentProfileResponse = {
  ...currentProfile,
  avatar: { userOid: 'oid-a', version: '2026-07-27T00:00:00.000Z' },
};

const uploadResponse: AvatarMutationResponse = {
  avatar: {
    source: 'uploaded',
    url: '/api/profile/avatar/oid-a?v=2026-07-28T00%3A00%3A00.000Z',
    cacheVersion: '2026-07-28T00:00:00.000Z',
    initials: null,
  },
  cacheVersion: '2026-07-28T00:00:00.000Z',
};

const fallbackResponse: AvatarMutationResponse = {
  avatar: {
    source: 'initials',
    url: null,
    cacheVersion: '2026-07-28T01:00:00.000Z',
    initials: 'AL',
  },
  cacheVersion: '2026-07-28T01:00:00.000Z',
};

describe('useUploadAvatar — PBI-003 AC-0 AC-1', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-0: posts FormData with the avatar file and crop JSON, updates cache with fresh version', async () => {
    mockFetchOk(uploadResponse);
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(currentProfileQueryKey, currentProfile);

    const { result } = renderHook(() => useUploadAvatar(), { wrapper });
    const file = new File(['abc'], 'avatar.png', { type: 'image/png' });
    const crop = { x: 0, y: 0, width: 1, height: 1 };

    await act(async () => {
      await result.current.mutateAsync({ file, crop });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/profile/avatar',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: expect.any(FormData),
      })
    );
    const call = (global.fetch as jest.Mock).mock.calls[0];
    const formData = call[1].body as FormData;
    expect(formData.get('avatar')).toBe(file);
    expect(formData.get('crop')).toBe(JSON.stringify(crop));

    expect(queryClient.getQueryData(currentProfileQueryKey)).toEqual({
      ...currentProfile,
      avatar: { userOid: 'oid-a', version: uploadResponse.cacheVersion },
    });
  });

  it('AC-1: on upload failure, prior cached profile data remains intact', async () => {
    mockFetchError(502, { error: 'Failed to store avatar' });
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(currentProfileQueryKey, currentProfile);

    const { result } = renderHook(() => useUploadAvatar(), { wrapper });
    const file = new File(['abc'], 'avatar.png', { type: 'image/png' });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ file, crop: { x: 0, y: 0, width: 1, height: 1 } })
      ).rejects.toThrow('Failed to store avatar');
    });

    expect(queryClient.getQueryData(currentProfileQueryKey)).toEqual(currentProfile);
  });
});

describe('useDeleteAvatar — PBI-004 AC-0 AC-1', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC-0: deletes avatar and updates cache with the fallback version', async () => {
    mockFetchOk(fallbackResponse);
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(currentProfileQueryKey, uploadedProfile);

    const { result } = renderHook(() => useDeleteAvatar(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/profile/avatar',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' })
    );
    expect(queryClient.getQueryData(currentProfileQueryKey)).toEqual({
      ...uploadedProfile,
      avatar: { userOid: 'oid-a', version: null },
    });
  });

  it('AC-1: on delete failure, prior cached profile data remains intact', async () => {
    mockFetchError(503, { error: 'Failed to delete avatar' });
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(currentProfileQueryKey, uploadedProfile);

    const { result } = renderHook(() => useDeleteAvatar(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow('Failed to delete avatar');
    });

    expect(queryClient.getQueryData(currentProfileQueryKey)).toEqual(uploadedProfile);
  });
});

describe('avatarDescriptorFromSubject', () => {
  it('derives an uploaded descriptor with the resolver URL when version is present', () => {
    const descriptor = avatarDescriptorFromSubject(
      { userOid: 'oid-a', version: '2026-07-27T00:00:00.000Z' },
      'Ada Lovelace'
    );
    expect(descriptor).toEqual({
      source: 'uploaded',
      url: buildAvatarResolverUrl('oid-a', '2026-07-27T00:00:00.000Z'),
      cacheVersion: '2026-07-27T00:00:00.000Z',
      initials: null,
    });
  });

  it('derives an initials descriptor from displayName when version is null', () => {
    const descriptor = avatarDescriptorFromSubject({ userOid: 'oid-a', version: null }, 'Ada Lovelace');
    expect(descriptor).toEqual({ source: 'initials', url: null, cacheVersion: '0', initials: 'AL' });
  });
});
