import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useAssignedWorkItems,
  useStartDevSession,
  useStartCloudAgentRun,
  useCancelCloudAgentRun,
  useCloudAgentRun,
  cloudAgentRunRefetchInterval,
  devSessionQueryKey,
  CLOUD_AGENT_POLL_INTERVAL_MS,
  PR_STATUS_POLL_INTERVAL_MS,
  useActiveSessions,
  useCloseDevSession,
  useDevSession,
  useDevDiff,
  usePushBranch,
  useCreatePr,
} from '../useDevWorkbench';
import type {
  CloudAgentRunSummary,
  DevSessionDetail,
} from '../../../shared/types/devWorkbench';
import type { AgentRunStatus } from '../../../shared/types/agentRunLifecycle';

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

function mockFetchError(status: number, body: unknown = { error: `HTTP ${status}` }) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

type FetchStep =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string };

/**
 * Queues one response per call and repeats the last step afterwards, so a test can
 * drive a success-then-failure sequence without timers.
 */
function mockFetchSteps(steps: FetchStep[]) {
  let call = 0;
  global.fetch = jest.fn().mockImplementation(() => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    return Promise.resolve(
      step.ok
        ? { ok: true, status: 200, json: () => Promise.resolve(step.data) }
        : { ok: false, status: step.status, json: () => Promise.resolve({ error: step.error }) },
    );
  }) as jest.Mock;
}

function cloudAgentRun(overrides: Partial<CloudAgentRunSummary> = {}): CloudAgentRunSummary {
  return {
    runId: 'run-1',
    status: 'queued',
    prUrl: null,
    prStatus: 'none',
    finishedWithoutPr: false,
    terminalReason: null,
    checkResults: null,
    failingChecks: [],
    lastError: null,
    ...overrides,
  };
}

function devSessionDetail(
  run: CloudAgentRunSummary | null,
  overrides: Partial<DevSessionDetail> = {},
): DevSessionDetail {
  return {
    id: 'session-1',
    workItemId: 42,
    chatThreadId: null,
    branchName: 'feature/42',
    status: 'in_progress',
    setupError: null,
    setupPhase: null,
    setupDetail: null,
    setupProgressAt: null,
    prUrl: null,
    branchPushed: false,
    createdAt: '2026-06-01T00:00:00Z',
    cloudAgentRun: run,
    ...overrides,
  };
}

const assignedItems = [
  {
    id: 42,
    title: 'Implement login',
    workItemType: 'Product Backlog Item',
    state: 'In Progress',
    assignedTo: 'jane@example.com',
    project: 'MaxView',
  },
];

describe('useAssignedWorkItems', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches assigned work items for the selected project', async () => {
    mockFetchOk(assignedItems);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAssignedWorkItems('MaxView'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(assignedItems);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/workitems?project=MaxView',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('does not fetch when project is null', async () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAssignedWorkItems(null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces API errors', async () => {
    mockFetchError(500, { error: 'Failed to fetch assigned work items' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useAssignedWorkItems('MaxView'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Failed to fetch assigned work items');
  });
});

describe('useStartDevSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /start and invalidates dev-workbench queries', async () => {
    mockFetchOk({ sessionId: 'session-1' });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useStartDevSession(), { wrapper });

    await act(async () => {
      const response = await result.current.mutateAsync({ workItemId: 42, project: 'MaxView' });
      expect(response).toEqual({ sessionId: 'session-1' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/start',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workItemId: 42, project: 'MaxView' }),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dev-workbench'] });
  });
});

describe('useStartCloudAgentRun', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-002 AC-0 / VT-01: POSTs to /cloud-agent/start, returns the queued run, and invalidates the dev-workbench family', async () => {
    mockFetchOk({ sessionId: 'session-1', runId: 'run-1' });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useStartCloudAgentRun(), { wrapper });

    await act(async () => {
      const response = await result.current.mutateAsync({ workItemId: 42, project: 'MaxView' });
      expect(response).toEqual({ sessionId: 'session-1', runId: 'run-1' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/cloud-agent/start',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workItemId: 42, project: 'MaxView' }),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dev-workbench'] });
  });

  it('PBI-002 AC-1 / VT-02: surfaces the validation error naming the missing field and starts no run', async () => {
    const missingFieldError = 'Skill settings are incomplete: skillRepo is not set.';
    mockFetchError(403, { error: missingFieldError });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useStartCloudAgentRun(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ workItemId: 42, project: 'MaxView' }),
      ).rejects.toThrow(missingFieldError);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('useCancelCloudAgentRun', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-004 AC-0 / VT-09: POSTs to the session cancel URL, returns the cancelled status, and invalidates the dev-workbench family', async () => {
    mockFetchOk({ ok: true, status: 'cancelled' });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCancelCloudAgentRun(), { wrapper });

    await act(async () => {
      const response = await result.current.mutateAsync('session-1');
      expect(response).toEqual({ ok: true, status: 'cancelled' });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1/cloud-agent/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dev-workbench'] });
  });

  it('PBI-004 AC-1 / VT-10: surfaces a 409 on an already-terminal run and leaves the cached run untouched', async () => {
    const completed = cloudAgentRun({ status: 'completed', prUrl: 'https://pr/1' });
    mockFetchError(409, { error: 'Run is already completed' });
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(devSessionQueryKey('session-1'), devSessionDetail(completed));
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCancelCloudAgentRun(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync('session-1')).rejects.toThrow(
        'Run is already completed',
      );
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData<DevSessionDetail>(devSessionQueryKey('session-1'))?.cloudAgentRun,
    ).toEqual(completed);
  });
});

describe('cloudAgentRunRefetchInterval', () => {
  const live: AgentRunStatus[] = ['queued', 'dispatched', 'running'];
  const terminal: AgentRunStatus[] = ['completed', 'failed', 'cancelled'];

  it.each(live)(
    'PBI-003 AC-0 / VT-05: polls every 3s while the run is %s',
    (status) => {
      expect(cloudAgentRunRefetchInterval(cloudAgentRun({ status }))).toBe(
        CLOUD_AGENT_POLL_INTERVAL_MS,
      );
      expect(CLOUD_AGENT_POLL_INTERVAL_MS).toBe(3_000);
    },
  );

  it.each(terminal)(
    'PBI-003 AC-0 / VT-05: stops polling once the run is %s and it opened no PR',
    (status) => {
      expect(cloudAgentRunRefetchInterval(cloudAgentRun({ status, prStatus: 'none' }))).toBe(false);
    },
  );

  it('PBI-003 AC-0 / VT-05: does not poll when the session has no Cloud Agent run', () => {
    expect(cloudAgentRunRefetchInterval(null)).toBe(false);
    expect(cloudAgentRunRefetchInterval(undefined)).toBe(false);
  });

  it.each(terminal)(
    'PBI-007 AC-0 / VT-07: keeps a 30s PR-status poll after the run is %s while the PR is open',
    (status) => {
      expect(
        cloudAgentRunRefetchInterval(
          cloudAgentRun({ status, prUrl: 'https://pr/1', prStatus: 'open' }),
        ),
      ).toBe(PR_STATUS_POLL_INTERVAL_MS);
      expect(PR_STATUS_POLL_INTERVAL_MS).toBe(30_000);
    },
  );

  it.each(terminal)(
    'PBI-007 AC-0 / VT-07: stops polling once the run is %s and its PR is merged',
    (status) => {
      expect(
        cloudAgentRunRefetchInterval(
          cloudAgentRun({ status, prUrl: 'https://pr/1', prStatus: 'merged' }),
        ),
      ).toBe(false);
    },
  );

  it('PBI-007 AC-0 / VT-07: an open PR never slows a still-live run below the live cadence', () => {
    expect(
      cloudAgentRunRefetchInterval(
        cloudAgentRun({ status: 'running', prUrl: 'https://pr/1', prStatus: 'open' }),
      ),
    ).toBe(CLOUD_AGENT_POLL_INTERVAL_MS);
  });
});

describe('useCloudAgentRun', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-003 AC-0 / VT-06: fetches the session detail endpoint and projects the Cloud Agent run', async () => {
    const run = cloudAgentRun({ status: 'running' });
    mockFetchOk(devSessionDetail(run));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCloudAgentRun('session-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(run);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('PBI-003 AC-0 / VT-06: projects null when the session has no Cloud Agent run', async () => {
    mockFetchOk(devSessionDetail(null));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCloudAgentRun('session-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('does not fetch without a session id', () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCloudAgentRun(null), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('PBI-003 AC-1 / VT-05: keeps the last good run and reports the error when a refetch fails', async () => {
    const run = cloudAgentRun({ status: 'running' });
    mockFetchSteps([
      { ok: true, data: devSessionDetail(run) },
      { ok: false, status: 503, error: 'Failed to fetch session' },
    ]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCloudAgentRun('session-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Failed to fetch session');
    expect(result.current.data).toEqual(run);
  });

  it('TBI-004 DoD-0: shares the session query key with useDevSession so one fetch feeds both', async () => {
    // Terminal status so neither observer schedules a poll and the call count is exact.
    const run = cloudAgentRun({ status: 'completed', prUrl: 'https://pr/1' });
    mockFetchOk(devSessionDetail(run));
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => ({
        session: useDevSession('session-1'),
        run: useCloudAgentRun('session-1'),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.run.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.session.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.session.data?.cloudAgentRun).toEqual(run);
    expect(result.current.run.data).toEqual(run);
  });
});

describe('useActiveSessions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches active sessions for the selected project', async () => {
    mockFetchOk([{ id: 'session-1', workItemId: 42, status: 'in_progress' }]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useActiveSessions('MaxView'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions?project=MaxView',
      expect.any(Object),
    );
  });
});

describe('useDevSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches a single session by id', async () => {
    mockFetchOk({
      id: 'session-1',
      workItemId: 42,
      status: 'in_progress',
      chatThreadId: 'thread-1',
      branchName: 'feature/42',
      setupError: null,
      createdAt: '2026-06-01T00:00:00Z',
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDevSession('session-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1',
      expect.any(Object),
    );
  });
});

describe('useCloseDevSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to close and invalidates dev-workbench queries', async () => {
    mockFetchOk({ ok: true });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCloseDevSession(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('session-1');
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1/close',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dev-workbench'] });
  });
});

describe('usePushBranch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to push the session branch and returns branchPushed', async () => {
    mockFetchOk({ ok: true, status: 'clean', branch: 'feature/42', branchPushed: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePushBranch(), { wrapper });

    await act(async () => {
      const response = await result.current.mutateAsync('session-1');
      expect(response.branch).toBe('feature/42');
      expect(response.branchPushed).toBe(true);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1/push',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('useCreatePr', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to create a PR and returns prUrl', async () => {
    const PR_URL = 'https://dev.azure.com/org/proj/_git/repo/pullrequest/1';
    mockFetchOk({ prUrl: PR_URL });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreatePr('session-1'), { wrapper });

    await act(async () => {
      const response = await result.current.mutateAsync();
      expect(response.prUrl).toBe(PR_URL);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/sessions/session-1/pr',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['dev-workbench', 'session', 'session-1'],
    });
  });

  it('surfaces API errors', async () => {
    mockFetchError(400, { error: 'Branch has not been pushed yet' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreatePr('session-1'), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow('Branch has not been pushed yet');
    });
  });
});

describe('useDevDiff', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches diff data for a chat thread', async () => {
    mockFetchOk({ diffText: '+line', changedFiles: ['a.ts'], branch: 'feature/42' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDevDiff('thread-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/threads/thread-1/diff',
      expect.any(Object),
    );
  });
});
