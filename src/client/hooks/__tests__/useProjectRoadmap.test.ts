import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useCreateRoadmapIdea,
  useDeleteRoadmapIdea,
  useProjectRoadmap,
  usePromoteRoadmapIdea,
  useUpdateRoadmapIdea,
  useUpdateRoadmapSettings,
  useUpsertRoadmapOverlay,
} from '../useProjectRoadmap';

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

const sampleWorkspace = {
  settings: {
    project: 'MaxView',
    syncDatesToAdo: false,
    updatedBy: 'system',
    updatedAt: '1970-01-01T00:00:00.000Z',
  },
  overlays: [],
  ideas: [],
  events: [],
};

describe('useProjectRoadmap hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches workspace data from /api/projects/:projectId/roadmap', async () => {
    mockFetchOk(sampleWorkspace);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProjectRoadmap('MaxView'), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleWorkspace);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/MaxView/roadmap',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('stays idle when project is empty', () => {
    mockFetchOk(sampleWorkspace);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProjectRoadmap(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('executes overlay upsert, settings update, and idea lifecycle mutations', async () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    mockFetchOk({
      overlay: { id: 'ov-1', workItemId: 101 },
      events: [],
      syncedToAdo: false,
    });
    const overlayHook = renderHook(() => useUpsertRoadmapOverlay('MaxView'), {
      wrapper,
    });
    await act(async () => {
      await overlayHook.result.current.mutateAsync({
        workItemId: 101,
        horizon: 'now',
        itemTitle: 'Epic 101',
      });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/MaxView/roadmap/overlays/101',
      expect.objectContaining({ method: 'PUT' }),
    );

    mockFetchOk(
      { idea: { id: 'idea-1', title: 'Draft Idea' }, events: [] },
      201,
    );
    const createHook = renderHook(() => useCreateRoadmapIdea('MaxView'), {
      wrapper,
    });
    await act(async () => {
      await createHook.result.current.mutateAsync({ title: 'Draft Idea' });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/MaxView/roadmap/ideas',
      expect.objectContaining({ method: 'POST' }),
    );

    mockFetchOk({ idea: { id: 'idea-1', horizon: 'next' }, events: [] });
    const updateHook = renderHook(() => useUpdateRoadmapIdea('MaxView'), {
      wrapper,
    });
    await act(async () => {
      await updateHook.result.current.mutateAsync({
        ideaId: 'idea-1',
        horizon: 'next',
      });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/MaxView/roadmap/ideas/idea-1',
      expect.objectContaining({ method: 'PATCH' }),
    );

    mockFetchOk(
      {
        idea: { id: 'idea-1', promotedFeatureRequestId: 'fr-1' },
        event: { id: 'ev-1' },
        featureRequestId: 'fr-1',
      },
      201,
    );
    const promoteHook = renderHook(() => usePromoteRoadmapIdea('MaxView'), {
      wrapper,
    });
    await act(async () => {
      await promoteHook.result.current.mutateAsync({
        ideaId: 'idea-1',
        target: 'feature-request',
      });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/MaxView/roadmap/ideas/idea-1/promote',
      expect.objectContaining({ method: 'POST' }),
    );

    mockFetchOk({
      project: 'MaxView',
      syncDatesToAdo: true,
      updatedBy: 'u1',
      updatedAt: '2026-11-13T00:00:00Z',
    });
    const settingsHook = renderHook(() => useUpdateRoadmapSettings('MaxView'), {
      wrapper,
    });
    await act(async () => {
      await settingsHook.result.current.mutateAsync({ syncDatesToAdo: true });
    });

    mockFetchOk(undefined, 204);
    const deleteHook = renderHook(() => useDeleteRoadmapIdea('MaxView'), {
      wrapper,
    });
    await act(async () => {
      await deleteHook.result.current.mutateAsync('idea-1');
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['project-roadmap', 'MaxView'],
    });
  });
});
