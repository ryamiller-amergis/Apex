import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  buildProfileQueryKey,
  useBuildProfile,
  useSaveBuildProfile,
  BuildProfileSaveError,
} from '../useBuildProfile';
import { emptyBuildProfile } from '../../../shared/types/buildPreflight';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

const response = { settingsId: 'cfg-1', project: 'proj', profile: emptyBuildProfile() };

describe('useBuildProfile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-004: uses the project-settings build-profile query key and URL', async () => {
    mockFetch(200, response);
    const { wrapper, queryClient } = createWrapper();
    const { result } = renderHook(() => useBuildProfile('cfg-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(buildProfileQueryKey('cfg-1')).toEqual(['admin', 'project-settings', 'cfg-1', 'build-profile']);
    expect(queryClient.getQueryData(buildProfileQueryKey('cfg-1'))).toEqual(response);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/project-settings/cfg-1/build-profile',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('PBI-004: does not fetch until the repository configuration is saved', () => {
    mockFetch(200, response);
    const { wrapper } = createWrapper();
    renderHook(() => useBuildProfile(null), { wrapper });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('useSaveBuildProfile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-004 AC-0: PUTs the profile and invalidates the build-profile and project-settings queries', async () => {
    mockFetch(200, response);
    const { wrapper, queryClient } = createWrapper();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSaveBuildProfile(), { wrapper });

    const profile = emptyBuildProfile();
    await act(async () => {
      await result.current.mutateAsync({ settingsId: 'cfg-1', profile });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/project-settings/cfg-1/build-profile',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(profile) }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: buildProfileQueryKey('cfg-1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'project-settings'] });
  });

  it('PBI-004 AC-3: surfaces 400 fieldErrors to the caller', async () => {
    mockFetch(400, { error: 'validation_failed', fieldErrors: { 'caps.maxParallelism': 'The maximum is 6.' } });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSaveBuildProfile(), { wrapper });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ settingsId: 'cfg-1', profile: emptyBuildProfile() });
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(BuildProfileSaveError);
    expect((caught as BuildProfileSaveError).fieldErrors).toEqual({ 'caps.maxParallelism': 'The maximum is 6.' });
  });

  it('PBI-004: surfaces the plain message when the flag refuses the save', async () => {
    mockFetch(403, { error: 'build_from_prompt_disabled', message: 'Build from prompt is turned off for this project.' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSaveBuildProfile(), { wrapper });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ settingsId: 'cfg-1', profile: emptyBuildProfile() });
      } catch (error) {
        caught = error;
      }
    });

    expect((caught as BuildProfileSaveError).message).toBe('Build from prompt is turned off for this project.');
    expect((caught as BuildProfileSaveError).fieldErrors).toEqual({});
  });
});
