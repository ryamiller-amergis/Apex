import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useCreateDesignModule,
  useDeleteDesignModule,
  useDesignModule,
  useDesignModules,
} from '../useDesignModules';
import type { DesignModule, DesignModuleSummary } from '../../../shared/types/designModule';

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

const summary: DesignModuleSummary = {
  id: 'mod-1',
  slug: 'chat',
  label: 'Chat',
  description: null,
  iconKey: 'chat',
  sourceGlobs: ['src/server/services/chat*.ts'],
  sortOrder: 0,
  hasContent: true,
  isStale: false,
  sourceAvailable: true,
  lastGeneratedAt: null,
  generatedByModel: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const designModule: DesignModule = {
  ...summary,
  content: '# Chat',
  sourceFingerprint: 'abc',
  sourceCommit: 'def',
  scopingThreadId: null,
  createdBy: 'user-1',
  updatedBy: 'user-1',
};

describe('useDesignModules', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches the design module list', async () => {
    mockFetchOk([summary]);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDesignModules(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([summary]);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/design-modules',
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('surfaces list fetch errors', async () => {
    mockFetchError(500, { error: 'boom' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDesignModules(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('boom');
  });
});

describe('useDesignModule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches a module by slug when enabled', async () => {
    mockFetchOk(designModule);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDesignModule('chat'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.slug).toBe('chat');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/design-modules/chat',
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('does not fetch when slug is null', async () => {
    mockFetchOk(designModule);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDesignModule(null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('useCreateDesignModule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs a new module and caches the result', async () => {
    mockFetchOk({ ...designModule, generation: { started: false } });
    const { queryClient, wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateDesignModule(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        slug: 'chat',
        label: 'Chat',
        iconKey: 'chat',
        sourceGlobs: ['src/**/*.ts'],
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(['design-modules', 'chat'])).toMatchObject({
      slug: 'chat',
      label: 'Chat',
    });
  });
});

describe('useDeleteDesignModule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs a module by slug', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(undefined),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDeleteDesignModule(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('chat');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/design-modules/chat',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});
