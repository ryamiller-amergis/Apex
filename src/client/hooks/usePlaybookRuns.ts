/**
 * Data path for the Playbook status view.
 *
 * Polled rather than streamed, deliberately. The PRD reserves stream-as-invalidation-hint for the
 * Phase 4 canvas and warns against treating a stream event as sufficient on its own — a quiet
 * WebSocket leaves a step showing stale state with nothing to correct it, and in Phase 0 the thing
 * being demonstrated is precisely that the status is right.
 *
 * Polling stops once every step is terminal. A view left open on a finished run should not keep
 * asking, and "is anything still moving" is a question the data already answers.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLAYBOOK_STEP_RUN_OPEN_STATUSES } from '../../shared/types/playbook';
import type {
  PlaybookRunDetail,
  PlaybookRunListResult,
  PlaybookRunStatus,
  PlaybookStepRunStatus,
  CancelPlaybookRunResponse,
  RetryPlaybookStepResponse,
} from '../../shared/types/playbook';

/** How often a live run is re-read. Frequent enough to watch, slow enough not to be a load test. */
const POLL_INTERVAL_MS = 5_000;

/**
 * A run is live while it is running or parked. Everything else is over.
 *
 * Expressed as the live set rather than the terminal set so that a status added later polls by
 * default only if it is genuinely one of these two — anything new reads as finished, and a view
 * that stops polling too early is recoverable by reloading, while one that never stops is not.
 */
const LIVE_RUN_STATUSES: ReadonlySet<PlaybookRunStatus> = new Set(['running', 'suspended']);

/**
 * Derived from the shared constant rather than re-listed here. `PLAYBOOK_STEP_RUN_OPEN_STATUSES` is
 * the same set the reconciliation sweep's partial index is built over, so the view and the sweep
 * cannot disagree about which steps are still waiting.
 */
const OPEN_STEP_STATUSES: ReadonlySet<PlaybookStepRunStatus> = new Set(
  PLAYBOOK_STEP_RUN_OPEN_STATUSES
);

export class PlaybookRunApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'PlaybookRunApiError';
  }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new PlaybookRunApiError(
      (body as { error?: string }).error ?? `Request failed: ${response.status}`,
      response.status
    );
  }
  return response.json() as Promise<T>;
}

export function isRunLive(status: PlaybookRunStatus): boolean {
  return LIVE_RUN_STATUSES.has(status);
}

export function hasLiveStep(run: PlaybookRunDetail | undefined): boolean {
  if (!run) return false;
  // The run's own status is not enough: a run can read `running` while its steps are all done, in
  // the moment between the last step finishing and the run being closed out.
  return isRunLive(run.status) || run.steps.some((s) => OPEN_STEP_STATUSES.has(s.status));
}

/** Runs in a project, most recent first. Polls while any of them is still going. */
export function usePlaybookRuns(project: string | undefined) {
  return useQuery<PlaybookRunListResult>({
    queryKey: ['playbook-runs', project],
    queryFn: () =>
      apiFetch<PlaybookRunListResult>(
        `/api/playbooks/runs?project=${encodeURIComponent(project!)}`
      ),
    enabled: !!project,
    staleTime: 0,
    refetchInterval: (result) =>
      result.state.data?.runs.some((run) => isRunLive(run.status)) ? POLL_INTERVAL_MS : false,
  });
}

/** One run with its steps. Polls while any step is non-terminal, then stops. */
export function usePlaybookRun(project: string | undefined, runId: string | null) {
  return useQuery<PlaybookRunDetail>({
    queryKey: ['playbook-run', project, runId],
    queryFn: () =>
      apiFetch<PlaybookRunDetail>(
        `/api/playbooks/runs/${encodeURIComponent(runId!)}?project=${encodeURIComponent(project!)}`
      ),
    enabled: !!project && !!runId,
    staleTime: 0,
    refetchInterval: (result) => (hasLiveStep(result.state.data) ? POLL_INTERVAL_MS : false),
  });
}

async function invalidateRunQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  project: string,
  runId: string
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['playbook-runs', project] }),
    queryClient.invalidateQueries({ queryKey: ['playbook-run', project, runId] }),
  ]);
}

export function useCancelPlaybookRun(project: string, runId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    CancelPlaybookRunResponse,
    PlaybookRunApiError,
    { reason?: string }
  >({
    mutationFn: ({ reason }) =>
      apiFetch(`/api/playbooks/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, ...(reason ? { reason } : {}) }),
      }),
    onSuccess: () => invalidateRunQueries(queryClient, project, runId),
    onError: (error) => {
      if (error.status === 403) void invalidateRunQueries(queryClient, project, runId);
    },
  });
}

export function useRetryPlaybookStep(project: string, runId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    RetryPlaybookStepResponse,
    PlaybookRunApiError,
    { stepRunId: string }
  >({
    mutationFn: ({ stepRunId }) =>
      apiFetch(
        `/api/playbooks/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepRunId)}/retry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project }),
        }
      ),
    onSuccess: () => invalidateRunQueries(queryClient, project, runId),
    onError: (error) => {
      if (error.status === 403) void invalidateRunQueries(queryClient, project, runId);
    },
  });
}
