import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useDeploymentOutcomes,
  useOutcomeByDeployment,
  useRecordOutcome,
  useOutcomeReport,
  useExportOutcomeReport,
  useAvailableReleaseVersions,
  useFilteredOutcomes,
} from '../useDeploymentOutcomes';
import type { DeploymentOutcome, OutcomeSummary } from '../../../shared/types/deploymentOutcome';

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

function mockFetchError(status: number) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: `HTTP ${status}` }),
  }) as jest.Mock;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const outcome: DeploymentOutcome = {
  id: 'outcome-1',
  deploymentId: 'deploy-1',
  releaseVersion: 'v1.0.0',
  environment: 'production',
  result: 'success',
  reportedBy: 'user-1',
  reportedAt: '2026-06-01T12:00:00Z',
};

const summary: OutcomeSummary = {
  total: 10,
  success: 7,
  downtime: 2,
  rollback: 1,
  avgDowntimeMinutes: 15,
  byMonth: [{ month: '2026-06', success: 7, downtime: 2, rollback: 1 }],
};

// ── useDeploymentOutcomes ──────────────────────────────────────────────────────

describe('useDeploymentOutcomes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches outcomes for a specific release version', async () => {
    mockFetchOk([outcome]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeploymentOutcomes('v1.0.0'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ id: 'outcome-1' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/deployment-outcomes/by-release/v1.0.0',
      expect.any(Object),
    );
  });

  it('does not fetch when releaseVersion is undefined', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => useDeploymentOutcomes(undefined), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── useOutcomeByDeployment ─────────────────────────────────────────────────────

describe('useOutcomeByDeployment', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches a single outcome by deployment id', async () => {
    mockFetchOk(outcome);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useOutcomeByDeployment('deploy-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ deploymentId: 'deploy-1' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/deployment-outcomes/deploy-1',
      expect.any(Object),
    );
  });

  it('does not fetch when deploymentId is null', async () => {
    mockFetchOk(outcome);
    const { wrapper } = createWrapper();

    renderHook(() => useOutcomeByDeployment(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── useRecordOutcome ───────────────────────────────────────────────────────────

describe('useRecordOutcome', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/deployment-outcomes with correct body', async () => {
    mockFetchOk(outcome);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRecordOutcome(), { wrapper });

    await act(async () => {
      result.current.mutate({
        deploymentId: 'deploy-1',
        releaseVersion: 'v1.0.0',
        result: 'success',
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/deployment-outcomes',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      deploymentId: 'deploy-1',
      releaseVersion: 'v1.0.0',
      result: 'success',
    });
  });

  it('includes optional fields in the POST body', async () => {
    mockFetchOk(outcome);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRecordOutcome(), { wrapper });

    await act(async () => {
      result.current.mutate({
        deploymentId: 'deploy-1',
        releaseVersion: 'v1.0.0',
        result: 'downtime',
        downtimeMinutes: 30,
        details: 'Database migration took too long',
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      result: 'downtime',
      downtimeMinutes: 30,
      details: 'Database migration took too long',
    });
  });

  it('surfaces errors from the API', async () => {
    mockFetchError(400);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRecordOutcome(), { wrapper });

    await act(async () => {
      result.current.mutate({
        deploymentId: 'deploy-1',
        releaseVersion: 'v1.0.0',
        result: 'success',
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useOutcomeReport ───────────────────────────────────────────────────────────

describe('useOutcomeReport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches report with filters as query params', async () => {
    mockFetchOk(summary);
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => useOutcomeReport({ startDate: '2026-01-01', endDate: '2026-06-01' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ total: 10, success: 7 });
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('/api/deployment-outcomes/report');
    expect(url).toContain('startDate=2026-01-01');
    expect(url).toContain('endDate=2026-06-01');
  });

  it('omits undefined filter params from the URL', async () => {
    mockFetchOk(summary);
    const { wrapper } = createWrapper();

    renderHook(() => useOutcomeReport({ result: 'rollback' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('result=rollback');
    expect(url).not.toContain('startDate');
    expect(url).not.toContain('endDate');
  });
});

// ── useExportOutcomeReport ─────────────────────────────────────────────────────

describe('useExportOutcomeReport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches CSV export and triggers download', async () => {
    const mockBlob = new Blob(['csv,data'], { type: 'text/csv' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    }) as jest.Mock;

    const createObjectURL = jest.fn().mockReturnValue('blob:url');
    const revokeObjectURL = jest.fn();
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;

    const clickSpy = jest.fn();
    const appendSpy = jest.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) (node as any).click = clickSpy;
      return node;
    });
    const removeSpy = jest.spyOn(HTMLAnchorElement.prototype, 'remove').mockImplementation(() => {});

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useExportOutcomeReport(), { wrapper });

    await result.current({ format: 'csv', startDate: '2026-01-01' });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('/api/deployment-outcomes/export');
    expect(url).toContain('format=csv');
    expect(url).toContain('startDate=2026-01-01');
    expect(createObjectURL).toHaveBeenCalledWith(mockBlob);
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:url');

    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('fetches JSON export and returns data', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([outcome]),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useExportOutcomeReport(), { wrapper });

    const data = await result.current({ format: 'json' });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('format=json');
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ id: 'outcome-1' });
  });

  it('throws on export failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useExportOutcomeReport(), { wrapper });

    await expect(result.current({ format: 'csv' })).rejects.toThrow('Export failed: 500');
  });

  it('serializes releaseVersions[] as repeated query params', async () => {
    const mockBlob = new Blob(['csv,data'], { type: 'text/csv' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    }) as jest.Mock;

    global.URL.createObjectURL = jest.fn().mockReturnValue('blob:url');
    global.URL.revokeObjectURL = jest.fn();
    jest.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) (node as any).click = jest.fn();
      return node;
    });
    jest.spyOn(HTMLAnchorElement.prototype, 'remove').mockImplementation(() => {});

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useExportOutcomeReport(), { wrapper });

    await result.current({ format: 'csv', releaseVersions: ['v1.0.0', 'v1.1.0'] });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('releaseVersions=v1.0.0');
    expect(url).toContain('releaseVersions=v1.1.0');
  });
});

// ── useAvailableReleaseVersions ────────────────────────────────────────────────

describe('useAvailableReleaseVersions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches distinct release versions from the /versions endpoint', async () => {
    mockFetchOk(['v1.2.0', 'v1.1.0', 'v1.0.0']);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAvailableReleaseVersions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(['v1.2.0', 'v1.1.0', 'v1.0.0']);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/deployment-outcomes/versions',
      expect.any(Object),
    );
  });

  it('returns empty array when no outcomes exist', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAvailableReleaseVersions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

// ── useFilteredOutcomes ────────────────────────────────────────────────────────

describe('useFilteredOutcomes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches from /list with no filters', async () => {
    mockFetchOk([outcome]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFilteredOutcomes({}), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('/api/deployment-outcomes/list');
  });

  it('serializes date and result filters as query params', async () => {
    mockFetchOk([outcome]);
    const { wrapper } = createWrapper();

    renderHook(
      () => useFilteredOutcomes({ startDate: '2026-01-01', endDate: '2026-06-01', result: 'success' }),
      { wrapper },
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('startDate=2026-01-01');
    expect(url).toContain('endDate=2026-06-01');
    expect(url).toContain('result=success');
  });

  it('serializes releaseVersions[] as repeated query params', async () => {
    mockFetchOk([outcome]);
    const { wrapper } = createWrapper();

    renderHook(
      () => useFilteredOutcomes({ releaseVersions: ['v1.0.0', 'v1.1.0'] }),
      { wrapper },
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('releaseVersions=v1.0.0');
    expect(url).toContain('releaseVersions=v1.1.0');
  });
});

// ── useOutcomeReport with releaseVersions ──────────────────────────────────────

describe('useOutcomeReport (releaseVersions)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('serializes releaseVersions[] as repeated query params', async () => {
    mockFetchOk(summary);
    const { wrapper } = createWrapper();

    renderHook(
      () => useOutcomeReport({ releaseVersions: ['v1.0.0', 'v1.1.0'] }),
      { wrapper },
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('releaseVersions=v1.0.0');
    expect(url).toContain('releaseVersions=v1.1.0');
  });

  it('falls back to releaseVersion (singular) when releaseVersions not set', async () => {
    mockFetchOk(summary);
    const { wrapper } = createWrapper();

    renderHook(() => useOutcomeReport({ releaseVersion: 'v1.0.0' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('releaseVersions=v1.0.0');
  });
});
