import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useProjectRepoConfigs } from '../useProjectRepoConfigs';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper };
}

const repoConfigs = [
  {
    id: 'cfg-1',
    project: 'proj-alpha',
    friendlyName: 'Main',
    skillRepo: 'org/skills',
    skillBranch: 'main',
    isDefault: true,
  },
  {
    id: 'cfg-2',
    project: 'proj-alpha',
    friendlyName: 'Staging',
    skillRepo: 'org/skills',
    skillBranch: 'staging',
    isDefault: false,
  },
];

describe('useProjectRepoConfigs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/skill-configs?project=... and returns configs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(repoConfigs),
    }) as jest.Mock;
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProjectRepoConfigs('proj-alpha'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0]).toMatchObject({ id: 'cfg-1', friendlyName: 'Main' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/skill-configs?project=proj-alpha',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('URL-encodes the project name', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    }) as jest.Mock;
    const { wrapper } = createWrapper();

    renderHook(() => useProjectRepoConfigs('my project/with spaces'), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      `/api/skill-configs?project=${encodeURIComponent('my project/with spaces')}`,
      expect.any(Object),
    );
  });

  it('does not fetch when project is null', async () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();

    renderHook(() => useProjectRepoConfigs(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces non-ok responses as errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Server error' }),
    }) as jest.Mock;
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProjectRepoConfigs('proj-alpha'), { wrapper });

    // Hook uses retry: 1 with default ~1s backoff between attempts
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3000 });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
