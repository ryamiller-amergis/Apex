import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useProjectSkillConfig,
  useAllProjectSkillConfigs,
  useUpsertProjectSkillConfig,
  useDeleteProjectSkillConfig,
  useGlobalDefaultModel,
  useSetGlobalDefaultModel,
  useAvailableModels,
  useProjectApprovers,
  useSetProjectApprovers,
} from '../useProjectSkillConfig';

// ── QueryClient wrapper ────────────────────────────────────────────────────────

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

function mockFetchNoContent() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    json: () => Promise.resolve(undefined),
  }) as jest.Mock;
}

function mockFetchError(status: number, body: unknown = { error: `HTTP ${status}` }) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const skillConfig = {
  project: 'proj-alpha',
  skillRepo: 'org/skills-repo',
  skillBranch: 'main',
  updatedBy: 'alice',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
};

// ── useProjectSkillConfig ──────────────────────────────────────────────────────

describe('useProjectSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/skill-config?project=... and returns the config', async () => {
    mockFetchOk(skillConfig);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProjectSkillConfig('proj-alpha'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ project: 'proj-alpha', skillRepo: 'org/skills-repo' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('project=proj-alpha'),
      expect.any(Object),
    );
  });

  it('URL-encodes the project name', async () => {
    mockFetchOk(null);
    const { wrapper } = createWrapper();

    renderHook(() => useProjectSkillConfig('my project/with spaces'), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('my project/with spaces')),
      expect.any(Object),
    );
  });

  it('returns null when the server responds with 404', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    }) as jest.Mock;
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProjectSkillConfig('proj-missing'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeNull();
  });

  it('does not fetch when project is null', async () => {
    mockFetchOk(skillConfig);
    const { wrapper } = createWrapper();

    renderHook(() => useProjectSkillConfig(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not fetch when project is empty string', async () => {
    mockFetchOk(skillConfig);
    const { wrapper } = createWrapper();

    renderHook(() => useProjectSkillConfig(''), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces non-404 errors', async () => {
    mockFetchError(500);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProjectSkillConfig('proj-alpha'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useAllProjectSkillConfigs ──────────────────────────────────────────────────

describe('useAllProjectSkillConfigs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/admin/project-settings and returns the list', async () => {
    mockFetchOk([skillConfig]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAllProjectSkillConfigs(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ project: 'proj-alpha' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/project-settings',
      expect.any(Object),
    );
  });

  it('returns an empty array when no configs exist', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAllProjectSkillConfigs(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it('surfaces fetch errors', async () => {
    mockFetchError(403);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAllProjectSkillConfigs(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useUpsertProjectSkillConfig ────────────────────────────────────────────────

describe('useUpsertProjectSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PUTs to /api/admin/project-settings/:id and returns the saved config', async () => {
    mockFetchOk(skillConfig);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpsertProjectSkillConfig(), { wrapper });

    await act(async () => {
      result.current.mutate({
        id: 'uuid-123',
        project: 'proj-alpha',
        body: { friendlyName: 'Main', skillRepo: 'org/skills-repo', skillBranch: 'main' },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ project: 'proj-alpha' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('uuid-123'),
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('POSTs when no id is provided (create)', async () => {
    mockFetchOk(skillConfig);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpsertProjectSkillConfig(), { wrapper });

    await act(async () => {
      result.current.mutate({
        project: 'proj-alpha',
        body: { friendlyName: 'New Config', skillRepo: 'org/skills-repo', skillBranch: 'main' },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/project-settings',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('URL-encodes the id in the URL', async () => {
    mockFetchOk(skillConfig);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpsertProjectSkillConfig(), { wrapper });

    await act(async () => {
      result.current.mutate({
        id: 'id/with spaces',
        project: 'my project/with spaces',
        body: { friendlyName: 'Test', skillRepo: 'org/repo', skillBranch: 'main' },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('id/with spaces')),
      expect.any(Object),
    );
  });

  it('sends the correct JSON body', async () => {
    mockFetchOk(skillConfig);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpsertProjectSkillConfig(), { wrapper });

    await act(async () => {
      result.current.mutate({
        id: 'uuid-123',
        project: 'proj-alpha',
        body: { friendlyName: 'Main', skillRepo: 'org/new-skills', skillBranch: 'release' },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const sentBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sentBody).toEqual({ friendlyName: 'Main', skillRepo: 'org/new-skills', skillBranch: 'release' });
  });

  it('surfaces errors from the API', async () => {
    mockFetchError(400);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpsertProjectSkillConfig(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'x', project: 'p', body: { friendlyName: 'f', skillRepo: '', skillBranch: '' } });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useDeleteProjectSkillConfig ────────────────────────────────────────────────

describe('useDeleteProjectSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs /api/admin/project-settings/:id', async () => {
    mockFetchNoContent();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteProjectSkillConfig(), { wrapper });

    await act(async () => {
      result.current.mutate('uuid-123');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('uuid-123'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('URL-encodes the id', async () => {
    mockFetchNoContent();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteProjectSkillConfig(), { wrapper });

    await act(async () => {
      result.current.mutate('id/with spaces');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('id/with spaces')),
      expect.any(Object),
    );
  });

  it('surfaces errors from the API', async () => {
    mockFetchError(500);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteProjectSkillConfig(), { wrapper });

    await act(async () => {
      result.current.mutate('uuid-123');
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useGlobalDefaultModel / useSetGlobalDefaultModel ───────────────────────────

describe('useGlobalDefaultModel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/admin/app-settings/defaultModel', async () => {
    mockFetchOk({ value: 'composer-2' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useGlobalDefaultModel(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ value: 'composer-2' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/admin/app-settings/defaultModel',
      expect.any(Object),
    );
  });
});

describe('useSetGlobalDefaultModel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PUTs the global default model value', async () => {
    mockFetchOk({ value: 'gpt-4o' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSetGlobalDefaultModel(), { wrapper });

    await act(async () => {
      result.current.mutate('gpt-4o');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ value: 'gpt-4o' });
  });
});

// ── useAvailableModels ─────────────────────────────────────────────────────────

describe('useAvailableModels', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/available-models and returns the models array', async () => {
    mockFetchOk({
      models: [
        { id: 'composer-2', displayName: 'Composer 2' },
        { id: 'gpt-4o', displayName: 'GPT-4o' },
      ],
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAvailableModels(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledWith('/api/available-models', expect.any(Object));
  });
});

// ── useProjectApprovers / useSetProjectApprovers ───────────────────────────────

const approver = {
  id: 'a1',
  project: 'proj-alpha',
  userId: 'user-1',
  documentType: 'design_doc' as const,
  displayName: 'Alice',
  email: 'alice@example.com',
  assignedBy: 'admin',
  assignedAt: '2026-01-01T00:00:00Z',
};

describe('useProjectApprovers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches approvers for the settings id', async () => {
    mockFetchOk([approver]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useProjectApprovers('settings-uuid-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/project-settings/settings-uuid-1/approvers'),
      expect.any(Object),
    );
  });

  it('does not fetch when settingsId is null', async () => {
    const { wrapper } = createWrapper();

    renderHook(() => useProjectApprovers(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('useSetProjectApprovers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PUTs design doc and PRD approver lists', async () => {
    mockFetchOk({ designDoc: [approver], prd: [] });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSetProjectApprovers(), { wrapper });

    await act(async () => {
      result.current.mutate({
        settingsId: 'settings-uuid-1',
        designDocApprovers: ['user-1'],
        prdApprovers: [],
        designPrototypeApprovers: [],
        testCaseApprovers: ['user-2'],
        testCaseApproverGroups: ['group-qa'],
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      designDocApprovers: ['user-1'],
      prdApprovers: [],
      designPrototypeApprovers: [],
      testCaseApprovers: ['user-2'],
      testCaseApproverGroups: ['group-qa'],
    });
  });
});
