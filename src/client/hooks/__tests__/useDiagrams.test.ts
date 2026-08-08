/**
 * PBI-004 AC-2 / VT-01 / VT-03 — TanStack hooks for diagram list, update, delete
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DiagramSummary, UpdateDiagramInput } from '../../../shared/types/diagram';
import {
  DIAGRAM_LIST_LIMIT,
  diagramsQueryKey,
  useDeleteDiagram,
  useOwnedDiagrams,
  useSharedDiagrams,
  useUpdateDiagram,
} from '../useDiagrams';

const PROJECT = 'project-a';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

function summary(overrides: Partial<DiagramSummary> = {}): DiagramSummary {
  return {
    id: 'diagram-1',
    projectId: PROJECT,
    ownerId: 'owner-1',
    ownerName: null,
    title: 'Untitled diagram',
    thumbnail: 'data:image/png;base64,aaa',
    version: 1,
    effectiveAccess: 'owner',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  } as DiagramSummary;
}

const updateInput: UpdateDiagramInput = {
  version: 1,
  title: 'Updated title',
  scene: { elements: [], appState: {}, files: {} },
  thumbnail: 'data:image/png;base64,bbb',
};

describe('useDiagrams family (PBI-004 AC-2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('PBI-004 AC-2 / VT-01: query keys are [diagrams, scope, projectId, offset]', () => {
    expect(diagramsQueryKey('owned', PROJECT, 0)).toEqual(['diagrams', 'owned', PROJECT, 0]);
    expect(diagramsQueryKey('shared', PROJECT, 50)).toEqual(['diagrams', 'shared', PROJECT, 50]);
  });

  it('PBI-004 AC-2 / VT-01: useOwnedDiagrams enabled only when projectId is set', async () => {
    mockFetchOk({ items: [summary()] });
    const { wrapper } = createWrapper();

    const disabled = renderHook(() => useOwnedDiagrams(null), { wrapper });
    expect(disabled.result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();

    const enabled = renderHook(() => useOwnedDiagrams(PROJECT), { wrapper });
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/projects/${PROJECT}/diagrams?`),
      expect.objectContaining({ credentials: 'include' }),
    );
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('scope=owned');
    expect(url).toContain(`limit=${DIAGRAM_LIST_LIMIT}`);
    expect(url).toContain('offset=0');
  });

  it('PBI-004 AC-2 / VT-01: useSharedDiagrams enabled only when projectId is set', async () => {
    mockFetchOk({ items: [summary({ effectiveAccess: 'view' })] });
    const { wrapper } = createWrapper();

    const disabled = renderHook(() => useSharedDiagrams(null), { wrapper });
    expect(disabled.result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();

    const enabled = renderHook(() => useSharedDiagrams(PROJECT, 0), { wrapper });
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true));
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('scope=shared');
    expect(url).toContain(`limit=${DIAGRAM_LIST_LIMIT}`);
  });

  it('PBI-004 AC-2 / VT-01: hasMore is true when nextOffset is present (limit 50)', async () => {
    mockFetchOk({ items: [summary()], nextOffset: 50 });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useOwnedDiagrams(PROJECT, 0), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toHaveLength(1);
    expect(result.current.data?.nextOffset).toBe(50);
    expect(result.current.data?.hasMore).toBe(true);
  });

  it('PBI-004 AC-2 / VT-01: hasMore is false when nextOffset is omitted', async () => {
    mockFetchOk({ items: [summary()] });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useOwnedDiagrams(PROJECT, 0), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.nextOffset).toBeUndefined();
    expect(result.current.data?.hasMore).toBe(false);
  });

  it('PBI-004 AC-2 / VT-01: list errors set isError with retry:false (no stale-as-current)', async () => {
    mockFetchError(500, { error: 'Server error', code: 'INTERNAL' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useOwnedDiagrams(PROJECT), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toMatchObject({ status: 500, message: 'Server error' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('PBI-004 AC-2 / VT-03: useUpdateDiagram invalidates owned+shared list queries on success', async () => {
    const updated = {
      ...summary({ title: 'Updated title', version: 2 }),
      scene: updateInput.scene,
    };
    mockFetchOk(updated);
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateDiagram(PROJECT), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 'diagram-1', input: updateInput });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/diagrams/diagram-1`,
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['diagrams', 'owned', PROJECT],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['diagrams', 'shared', PROJECT],
    });
  });

  it('PBI-004 AC-2 / VT-03: useDeleteDiagram invalidates lists on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(undefined),
    }) as jest.Mock;
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteDiagram(PROJECT), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('diagram-1');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/diagrams/diagram-1`,
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['diagrams', 'owned', PROJECT],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['diagrams', 'shared', PROJECT],
    });
  });

  it('PBI-004 AC-2 / VT-03: useDeleteDiagram surfaces error without removing on failure', async () => {
    mockFetchError(403, { error: 'Forbidden', code: 'DIAGRAM_FORBIDDEN' });
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    queryClient.setQueryData(diagramsQueryKey('owned', PROJECT, 0), {
      items: [summary()],
      hasMore: false,
    });

    const { result } = renderHook(() => useDeleteDiagram(PROJECT), { wrapper });

    await expect(result.current.mutateAsync('diagram-1')).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(diagramsQueryKey('owned', PROJECT, 0))).toEqual({
      items: [summary()],
      hasMore: false,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 403, message: 'Forbidden' });
  });
});
