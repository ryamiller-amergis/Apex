import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useCreatePlaybookDefinition,
  useDeprecatePlaybookVersion,
  usePlaybookDefinition,
  usePlaybookDefinitions,
  usePublishPlaybookDraft,
  useSavePlaybookDraft,
} from '../usePlaybookDefinitions';

const PROJECT = 'Apex & Lab';
const GRAPH = { nodes: [{ id: 'notify', stepType: 'notify' }], edges: [] };

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: React.PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, wrapper };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
});

it('requests project-scoped list and detail URLs and disables detail without a selection', async () => {
  const fetchMock = (global.fetch as jest.Mock)
    .mockResolvedValueOnce(response({ definitions: [] }))
    .mockResolvedValueOnce(response({ definition: {}, draft: {}, versions: [] }));
  const { wrapper } = setup();

  const list = renderHook(() => usePlaybookDefinitions(PROJECT), { wrapper });
  const detail = renderHook(() => usePlaybookDefinition(PROJECT, 'def/1'), { wrapper });
  renderHook(() => usePlaybookDefinition(PROJECT, null), { wrapper });

  await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
  await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/playbooks/definitions?project=Apex%20%26%20Lab',
    { credentials: 'include' },
  );
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/playbooks/definitions/def%2F1?project=Apex%20%26%20Lab',
    { credentials: 'include' },
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('sends lifecycle mutation contracts and invalidates only definition queries', async () => {
  const fetchMock = (global.fetch as jest.Mock)
    .mockResolvedValue(response({ definition: {}, draft: {}, versions: [] }, 201));
  const { wrapper, invalidate } = setup();
  const hooks = renderHook(
    () => ({
      create: useCreatePlaybookDefinition(PROJECT),
      save: useSavePlaybookDraft(PROJECT, 'def-1'),
      publish: usePublishPlaybookDraft(PROJECT, 'def-1'),
      deprecate: useDeprecatePlaybookVersion(PROJECT, 'def-1'),
    }),
    { wrapper },
  );

  await act(async () => {
    await hooks.result.current.create.mutateAsync({ name: 'Definition', description: '', graph: GRAPH });
    await hooks.result.current.save.mutateAsync({
      name: 'Definition',
      description: 'Changed',
      graph: GRAPH,
      expectedDraftUpdatedAt: 'rev-1',
    });
    await hooks.result.current.publish.mutateAsync({ expectedDraftUpdatedAt: 'rev-2' });
    await hooks.result.current.deprecate.mutateAsync({ versionId: 'version/2' });
  });

  expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
    ['/api/playbooks/definitions', 'POST'],
    ['/api/playbooks/definitions/def-1/draft', 'PUT'],
    ['/api/playbooks/definitions/def-1/publish', 'POST'],
    ['/api/playbooks/definitions/def-1/versions/version%2F2/deprecate', 'POST'],
  ]);
  expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toEqual({
    project: PROJECT,
    expectedDraftUpdatedAt: 'rev-2',
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['playbook-definitions', PROJECT] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['playbook-definition', PROJECT, 'def-1'] });
  expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['playbook-runs'] }));
});

it('preserves status and server error text for stale conflict handling', async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    response({ error: 'Draft revision is stale.' }, 409),
  );
  const { wrapper } = setup();
  const hook = renderHook(() => usePublishPlaybookDraft(PROJECT, 'def-1'), { wrapper });

  await expect(
    hook.result.current.mutateAsync({ expectedDraftUpdatedAt: 'old-revision' }),
  ).rejects.toMatchObject({ message: 'Draft revision is stale.', status: 409 });
});
