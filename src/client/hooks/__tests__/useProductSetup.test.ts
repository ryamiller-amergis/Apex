import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  draftProductFoundation,
  productSetupRefetchInterval,
  reviseProductFoundation,
  saveProductFoundation,
  startNextProductBuild,
  useApproveProductBuild,
  useProductSetup,
  useRegenerateProductPrototype,
  useStartNextProductBuild,
  useSyncProductBuild,
  type ProductSetupStatus,
} from '../useProductSetup';

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
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: { get: () => null },
  }) as jest.Mock;
}

const discovery: ProductSetupStatus = {
  active: true,
  phase: 'build',
  skillPath: '.agents/skills/product-discovery/SKILL.md',
  model: 'gemini-3.8-flash',
  candidates: [],
  foundationAnswers: [],
  project: 'Benefits Tracker',
  build: {
    id: 'build-1',
    kind: 'initial',
    status: 'discovery',
    project: 'Benefits Tracker',
    rfpRequestId: 'rfp-1',
    chatThreadId: 'thread-1',
    uiLabDesignId: null,
    prototypeVersion: null,
    devSessionId: null,
    agentRunId: null,
    brief: null,
    requesterId: 'user-1',
    reviewerId: null,
    adoWorkItemId: null,
    prUrl: null,
    errorMessage: null,
    approvedAt: null,
    prOpenedAt: null,
    mergedAt: null,
    createdAt: '2026-10-05T16:00:00.000Z',
    updatedAt: '2026-10-05T16:00:00.000Z',
  },
  chatThreadId: 'thread-1',
  thread: {
    id: 'thread-1',
    userId: 'user-1',
    title: 'Product discovery',
    status: 'idle',
    kickoff: { project: 'Benefits Tracker', repo: 'benefits', skillPath: '.agents/skills/product-discovery/SKILL.md' },
    flagged: false,
    createdAt: '2026-10-05T16:00:00.000Z',
    lastActivityAt: '2026-10-05T16:00:00.000Z',
  },
  design: null,
  history: [],
};

describe('product setup client contract', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('loads setup from the product-builds route and keeps the server shape', async () => {
    mockFetchOk(discovery);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProductSetup('Benefits Tracker'), { wrapper });

    await waitFor(() => expect(result.current.data?.phase).toBe('build'));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/product-builds/setup?project=Benefits%20Tracker',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(result.current.data).toMatchObject({
      active: true,
      phase: 'build',
      chatThreadId: 'thread-1',
      thread: { id: 'thread-1', title: 'Product discovery' },
      design: null,
      build: { id: 'build-1', status: 'discovery' },
    });
  });

  it('preserves the inactive setup when the request fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Not found' }),
      text: () => Promise.resolve(JSON.stringify({ error: 'Not found' })),
      headers: { get: () => null },
    }) as jest.Mock;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProductSetup('Benefits Tracker'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      active: false,
      phase: 'foundation',
      skillPath: '.agents/skills/product-foundation/SKILL.md',
      model: 'auto',
      candidates: [],
      canInviteTeammates: false,
      foundationAnswers: [],
      build: null,
      chatThreadId: null,
      thread: null,
      design: null,
    });
  });

  it('polls while discovery, prototype generation, or building is in progress', () => {
    expect(productSetupRefetchInterval(undefined)).toBe(false);
    expect(productSetupRefetchInterval({
      active: false,
      phase: 'foundation',
      skillPath: '',
      model: 'auto',
      candidates: [],
      canInviteTeammates: false,
      foundationAnswers: [],
      build: null,
      chatThreadId: null,
      thread: null,
      design: null,
    })).toBe(false);
    expect(productSetupRefetchInterval({
      active: true,
      phase: 'foundation',
      skillPath: '.agents/skills/product-foundation/SKILL.md',
      model: 'auto',
      candidates: [],
      canInviteTeammates: true,
      foundationAnswers: [],
      build: null,
      chatThreadId: null,
      thread: null,
      design: null,
    })).toBe(30_000);
    expect(productSetupRefetchInterval(discovery)).toBe(5_000);
    expect(productSetupRefetchInterval({
      ...discovery,
      build: { ...discovery.build, status: 'prototype' },
      design: {
        id: 'design-1',
        project: 'Benefits Tracker',
        authorId: 'user-1',
        title: 'My Benefits',
        prompt: 'Prototype',
        status: 'generating',
        version: 1,
        history: [],
        createdAt: '2026-10-05T16:00:00.000Z',
        updatedAt: '2026-10-05T16:00:00.000Z',
      },
    })).toBe(5_000);
    expect(productSetupRefetchInterval({
      ...discovery,
      build: { ...discovery.build, status: 'building', agentRunId: 'run-1' },
    })).toBe(5_000);
    expect(productSetupRefetchInterval({
      ...discovery,
      build: { ...discovery.build, status: 'prototype' },
      design: {
        id: 'design-1',
        project: 'Benefits Tracker',
        authorId: 'user-1',
        title: 'My Benefits',
        prompt: 'Prototype',
        status: 'ready',
        html: '<html></html>',
        version: 1,
        history: [],
        createdAt: '2026-10-05T16:00:00.000Z',
        updatedAt: '2026-10-05T16:00:00.000Z',
      },
    })).toBe(false);
    expect(productSetupRefetchInterval({
      ...discovery,
      build: { ...discovery.build, status: 'pr-open', prUrl: 'https://example.test/pr/1' },
    })).toBe(30_000);
    expect(productSetupRefetchInterval({
      ...discovery,
      build: { ...discovery.build, status: 'merged', prUrl: 'https://example.test/pr/1' },
    })).toBe(false);
    expect(productSetupRefetchInterval({
      ...discovery,
      build: { ...discovery.build, status: 'failed', errorMessage: 'The build stopped.' },
    })).toBe(false);
  });

  it('drafts, revises, and saves foundation without the admin route', async () => {
    mockFetchOk({ markdown: '# Product', ok: true });

    await draftProductFoundation('Benefits Tracker', ['a', 'b', 'c', 'd']);
    await reviseProductFoundation('Benefits Tracker', '# Product', 'Shorter problem');
    await saveProductFoundation('Benefits Tracker', '# Product');

    const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      '/api/product-builds/foundation/draft',
      '/api/product-builds/foundation/revise',
      '/api/product-builds/foundation/save',
    ]);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
      project: 'Benefits Tracker',
      answers: ['a', 'b', 'c', 'd'],
    });
  });

  it('syncs, regenerates, and approves, then refreshes product setup', async () => {
    mockFetchOk({ ...discovery, build: { ...discovery.build, status: 'approved' } });
    const { wrapper, queryClient } = createWrapper();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const sync = renderHook(() => useSyncProductBuild('Benefits Tracker'), { wrapper });
    const regenerate = renderHook(() => useRegenerateProductPrototype('Benefits Tracker'), { wrapper });
    const approve = renderHook(() => useApproveProductBuild('Benefits Tracker'), { wrapper });

    await act(async () => {
      await sync.result.current.mutateAsync('build-1');
      await regenerate.result.current.mutateAsync({ buildId: 'build-1', feedback: 'Larger type' });
      await approve.result.current.mutateAsync('build-1');
    });

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe('/api/product-builds/build-1/sync');
    expect(calls[0][1]).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(calls[1][0]).toBe('/api/product-builds/build-1/prototype/regenerate');
    expect(JSON.parse(calls[1][1].body)).toEqual({ feedback: 'Larger type' });
    expect(calls[2][0]).toBe('/api/product-builds/build-1/approve');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['product-setup', 'Benefits Tracker'] });
  });

  it('posts the prompt when starting the next build', async () => {
    mockFetchOk(discovery);
    await startNextProductBuild('Benefits Tracker', 'Add a reminder for tomorrow');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/product-builds/next',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ project: 'Benefits Tracker', prompt: 'Add a reminder for tomorrow' }),
      }),
    );

    const { wrapper } = createWrapper();
    const start = renderHook(() => useStartNextProductBuild('Benefits Tracker'), { wrapper });
    await act(async () => {
      await start.result.current.mutateAsync('Add a reminder for tomorrow');
    });
    const calls = (global.fetch as jest.Mock).mock.calls;
    const last = calls[calls.length - 1];
    expect(JSON.parse(last[1].body)).toEqual({
      project: 'Benefits Tracker',
      prompt: 'Add a reminder for tomorrow',
    });
  });
});
