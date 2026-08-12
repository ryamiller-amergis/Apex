import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  isProjectRepositoryReady,
  PROJECT_REPOSITORY_NOT_READY_MESSAGE,
  useProjectRepositoryReadiness,
} from '../useProjectRepositoryReadiness';
import type { ProjectRepositoryReadiness } from '../../../shared/types/projectSettings';

jest.mock('../useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));

import { useFeatureFlag } from '../useFeatureFlags';

const mockUseFeatureFlag = useFeatureFlag as jest.MockedFunction<typeof useFeatureFlag>;

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

const notCloned: ProjectRepositoryReadiness = {
  skillSettingsId: 'cfg-1',
  status: 'not_cloned',
  sha: null,
  error: null,
  startedAt: null,
  completedAt: null,
  filesystemReady: false,
};

const ready: ProjectRepositoryReadiness = {
  skillSettingsId: 'cfg-1',
  status: 'ready',
  sha: 'abc123def456',
  error: null,
  startedAt: '2026-08-01T00:00:00Z',
  completedAt: '2026-08-01T00:01:00Z',
  filesystemReady: true,
};

describe('isProjectRepositoryReady', () => {
  it('returns true only when status is ready and filesystemReady', () => {
    expect(isProjectRepositoryReady(ready)).toBe(true);
    expect(isProjectRepositoryReady(notCloned)).toBe(false);
    expect(isProjectRepositoryReady({ ...ready, filesystemReady: false })).toBe(false);
    expect(isProjectRepositoryReady(null)).toBe(false);
  });
});

describe('useProjectRepositoryReadiness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('treats repository as ready when feature flag is off (legacy path)', async () => {
    mockUseFeatureFlag.mockReturnValue(false);
    mockFetchOk(notCloned);
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => useProjectRepositoryReadiness('cfg-1', 'Apex'),
      { wrapper },
    );

    expect(result.current.isReady).toBe(true);
    expect(result.current.message).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns not ready with admin message when flag on and status is not_cloned', async () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockFetchOk(notCloned);
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => useProjectRepositoryReadiness('cfg-1', 'Apex'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isReady).toBe(false);
    expect(result.current.message).toBe(PROJECT_REPOSITORY_NOT_READY_MESSAGE);
    expect(result.current.readiness?.status).toBe('not_cloned');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/skill-settings/cfg-1/repository-readiness?project=Apex',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('returns ready when flag on and filesystem is ready', async () => {
    mockUseFeatureFlag.mockReturnValue(true);
    mockFetchOk(ready);
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => useProjectRepositoryReadiness('cfg-1', 'Apex'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(result.current.message).toBeNull();
    expect(result.current.readiness?.sha).toBe('abc123def456');
  });

  it('does not fetch when skillSettingsId or project is missing', async () => {
    mockUseFeatureFlag.mockReturnValue(true);
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();

    const { result: missingId } = renderHook(
      () => useProjectRepositoryReadiness(null, 'Apex'),
      { wrapper },
    );
    const { result: missingProject } = renderHook(
      () => useProjectRepositoryReadiness('cfg-1', null),
      { wrapper },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(missingId.current.isReady).toBe(true);
    expect(missingProject.current.isReady).toBe(true);
  });
});
