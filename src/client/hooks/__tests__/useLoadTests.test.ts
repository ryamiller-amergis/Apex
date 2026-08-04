/**
 * TBI-006 DoD-4 / VT-02 — TanStack hooks for load-test definition CRUD
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  loadTestsQueryKey,
  useCreateLoadTest,
  useDeleteLoadTest,
  useLoadTest,
  useLoadTests,
  useUpdateLoadTest,
} from '../useLoadTests';
import type { CreateLoadTestDefinitionInput, LoadTestDefinition } from '../../../shared/types/loadTest';

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

const definition: LoadTestDefinition = {
  id: 'def-1',
  projectId: PROJECT,
  name: 'Health check',
  description: null,
  targetUrl: 'https://api.staging.example.internal',
  environment: 'staging',
  engine: 'k6',
  flowType: 'single',
  scriptSource: 'form_builder',
  script: 'export default function () {}',
  loadProfile: { vus: 10, durationMinutes: 5 },
  clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
  runSource: null,
  secretRefs: null,
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
  createdBy: 'user-1',
  updatedBy: 'user-1',
};

const createInput: CreateLoadTestDefinitionInput = {
  name: definition.name,
  targetUrl: definition.targetUrl,
  environment: definition.environment,
  script: definition.script,
  loadProfile: definition.loadProfile,
  clientThresholds: definition.clientThresholds,
  flowType: 'single',
  scriptSource: 'form_builder',
};

describe('useLoadTests family (TBI-006 DoD-4)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists definitions from GET /load-tests', async () => {
    mockFetchOk({ items: [definition] });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLoadTests(PROJECT), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/load-tests`,
      expect.any(Object),
    );
  });

  it('gets a definition by id', async () => {
    mockFetchOk(definition);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLoadTest(PROJECT, 'def-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe('def-1');
  });

  it('VT-02: create invalidates list cache and returns definition', async () => {
    mockFetchOk(definition, 201);
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateLoadTest(PROJECT), { wrapper });

    await act(async () => {
      const created = await result.current.mutateAsync(createInput);
      expect(created.id).toBe('def-1');
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: loadTestsQueryKey(PROJECT) });
  });

  it('update and delete invalidate caches', async () => {
    mockFetchOk({ ...definition, name: 'Updated' });
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const update = renderHook(() => useUpdateLoadTest(PROJECT), { wrapper });
    await act(async () => {
      await update.result.current.mutateAsync({ id: 'def-1', input: { name: 'Updated' } });
    });

    mockFetchOk(undefined, 204);
    const del = renderHook(() => useDeleteLoadTest(PROJECT), { wrapper });
    await act(async () => {
      await del.result.current.mutateAsync('def-1');
    });

    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('propagates 403 errors from create', async () => {
    mockFetchError(403, { error: 'Forbidden', code: 'FORBIDDEN' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCreateLoadTest(PROJECT), { wrapper });

    await expect(result.current.mutateAsync(createInput)).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    });
  });
});
