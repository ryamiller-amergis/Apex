import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  AssignedWorkItem,
  StartDevSessionResponse,
  DevDiff,
  ActiveDevSession,
  DevSessionDetail,
  ConflictedFile,
  PushSessionResponse,
  CreatePrResponse,
  StartDevSessionRequest,
  StartCloudAgentRunRequest,
  StartCloudAgentRunResponse,
  CloudAgentActivityEvent,
  CloudAgentActivityStreamEvent,
  CloudAgentRunSummary,
} from '../../shared/types/devWorkbench';
import type { AgentRunStatus } from '../../shared/types/agentRunLifecycle';
import { isAgentRunTerminalStatus } from '../../shared/types/agentRunLifecycle';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useAssignedWorkItems(project: string | null) {
  return useQuery<AssignedWorkItem[]>({
    queryKey: ['dev-workbench', 'workitems', project],
    queryFn: () => apiFetch(`/api/dev-workbench/workitems?project=${encodeURIComponent(project!)}`),
    enabled: !!project,
    staleTime: 60_000,
  });
}

/** Poll cadence for a live Cloud Agent run (queued / dispatched / running). */
export const CLOUD_AGENT_POLL_INTERVAL_MS = 3_000;

/** Slower cadence used after a run is terminal, while its PR is still open. */
export const PR_STATUS_POLL_INTERVAL_MS = 30_000;

/**
 * Query key for one dev session's detail payload. Every dev-workbench consumer of
 * that payload — including the Cloud Agent run projection — shares this key so a
 * single fetch feeds them all (TBI-004 DoD-0).
 */
export function devSessionQueryKey(sessionId: string | null) {
  return ['dev-workbench', 'session', sessionId] as const;
}

/**
 * Poll cadence for a session's Cloud Agent run: every
 * {@link CLOUD_AGENT_POLL_INTERVAL_MS} while the run is still live (PBI-003
 * AC-0), then every {@link PR_STATUS_POLL_INTERVAL_MS} while the finished run
 * still has an open PR so the row can move to Merged (PBI-007 AC-0). Polling is
 * off when there is no run, and when a terminal run has no PR or a merged one.
 */
export function cloudAgentRunRefetchInterval(
  run: CloudAgentRunSummary | null | undefined,
): number | false {
  if (!run) return false;
  if (!isAgentRunTerminalStatus(run.status)) return CLOUD_AGENT_POLL_INTERVAL_MS;
  return run.prStatus === 'open' ? PR_STATUS_POLL_INTERVAL_MS : false;
}

/**
 * Cloud Agent run for a dev session, projected off the shared session detail
 * query (TBI-004 DoD-1). `data` is `null` when the session has no run.
 *
 * A failed refetch leaves the last successful projection in place and reports the
 * failure through `error`/`isRefetchError`, so callers keep rendering the last
 * known status instead of blanking out (PBI-003 AC-1).
 */
export function useCloudAgentRun(sessionId: string | null) {
  return useQuery<DevSessionDetail, Error, CloudAgentRunSummary | null>({
    queryKey: devSessionQueryKey(sessionId),
    queryFn: () => apiFetch(`/api/dev-workbench/sessions/${sessionId}`),
    enabled: !!sessionId,
    select: (session) => session.cloudAgentRun ?? null,
    refetchInterval: (query) => cloudAgentRunRefetchInterval(query.state.data?.cloudAgentRun),
  });
}

export function useCloudAgentActivityStream(
  sessionId: string | null,
  runId: string | null,
  enabled: boolean,
) {
  const [events, setEvents] = useState<CloudAgentActivityEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEvents([]);
    setIsConnected(false);
    setError(null);
    if (!sessionId || !runId || !enabled) return;

    const source = new EventSource(
      `/api/dev-workbench/sessions/${encodeURIComponent(sessionId)}/cloud-agent/stream?runId=${encodeURIComponent(runId)}`,
      { withCredentials: true },
    );
    const seen = new Set<string>();

    source.onopen = () => {
      setIsConnected(true);
      setError(null);
    };
    source.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data) as CloudAgentActivityStreamEvent;
        if (payload.type === 'activity') {
          if (seen.has(payload.event.id)) return;
          seen.add(payload.event.id);
          setEvents((current) => [...current, payload.event].slice(-500));
        } else if (payload.type === 'stream_end') {
          setIsConnected(false);
          source.close();
        } else if (payload.type === 'stream_error') {
          setError(payload.error);
          setIsConnected(false);
          source.close();
        }
      } catch {
        setError('Received an invalid Cloud Agent activity event.');
      }
    };
    source.onerror = () => {
      setIsConnected(false);
      setError('Activity stream disconnected. Reconnecting…');
    };

    return () => source.close();
  }, [enabled, runId, sessionId]);

  return { events, isConnected, error };
}

export function useStartCloudAgentRun() {
  const queryClient = useQueryClient();
  return useMutation<StartCloudAgentRunResponse, Error, StartCloudAgentRunRequest>({
    mutationFn: (body) =>
      apiFetch('/api/dev-workbench/cloud-agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench'] });
    },
  });
}

export function useCancelCloudAgentRun() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true; status: AgentRunStatus }, Error, string>({
    mutationFn: (sessionId) =>
      apiFetch(`/api/dev-workbench/sessions/${sessionId}/cloud-agent/cancel`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench'] });
    },
  });
}

export function useStartDevSession() {
  const queryClient = useQueryClient();
  return useMutation<StartDevSessionResponse, Error, StartDevSessionRequest>({
    mutationFn: (body) =>
      apiFetch('/api/dev-workbench/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench'] });
    },
  });
}

export function useDevSession(sessionId: string | null) {
  return useQuery<DevSessionDetail>({
    queryKey: devSessionQueryKey(sessionId),
    queryFn: () => apiFetch(`/api/dev-workbench/sessions/${sessionId}`),
    enabled: !!sessionId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'setting_up' ? 2_000 : false;
    },
  });
}

export function useActiveSessions(project: string | null) {
  return useQuery<ActiveDevSession[]>({
    queryKey: ['dev-workbench', 'sessions', project],
    queryFn: () => apiFetch(`/api/dev-workbench/sessions?project=${encodeURIComponent(project!)}`),
    enabled: !!project,
    staleTime: 30_000,
  });
}

export function useCloseDevSession() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (sessionId) =>
      apiFetch(`/api/dev-workbench/sessions/${sessionId}/close`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench'] });
    },
  });
}

export function usePushBranch() {
  const queryClient = useQueryClient();
  return useMutation<PushSessionResponse, Error, string>({
    mutationFn: (sessionId) =>
      apiFetch(`/api/dev-workbench/sessions/${sessionId}/push`, { method: 'POST' }),
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench', 'session', sessionId] });
    },
  });
}

export function useSessionConflicts(sessionId: string | null) {
  return useQuery<{ files: ConflictedFile[] }>({
    queryKey: ['dev-workbench', 'conflicts', sessionId],
    queryFn: () => apiFetch(`/api/dev-workbench/sessions/${sessionId}/conflicts`),
    enabled: !!sessionId,
  });
}

export function useResolveConflict(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { path: string; content: string }>({
    mutationFn: (body) =>
      apiFetch(`/api/dev-workbench/sessions/${sessionId}/conflicts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench', 'conflicts', sessionId] });
    },
  });
}

export function useCompleteMerge(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean; branchPushed: boolean }, Error, void>({
    mutationFn: () =>
      apiFetch(`/api/dev-workbench/sessions/${sessionId}/conflicts/complete`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench', 'session', sessionId] });
    },
  });
}

export function useCreatePr(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<CreatePrResponse, Error, void>({
    mutationFn: () =>
      apiFetch(`/api/dev-workbench/sessions/${sessionId}/pr`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench', 'session', sessionId] });
    },
  });
}

export function useAbortMerge(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, void>({
    mutationFn: () =>
      apiFetch(`/api/dev-workbench/sessions/${sessionId}/conflicts/abort`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench', 'session', sessionId] });
    },
  });
}

export function useCompleteFeature() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean; sessionId: string }, Error, { prdId: string; featureId: string; project: string }>({
    mutationFn: (body) =>
      apiFetch('/api/dev-workbench/features/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench'] });
    },
  });
}

export function useStartLocalFeature() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: boolean; sessionId: string; status: string },
    Error,
    { prdId: string; featureId: string; project: string }
  >({
    mutationFn: (body) =>
      apiFetch('/api/dev-workbench/features/start-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dev-workbench'] });
    },
  });
}

export function useDevDiff(threadId: string | null) {
  return useQuery<DevDiff>({
    queryKey: ['dev-workbench', 'diff', threadId],
    queryFn: () => apiFetch(`/api/dev-workbench/threads/${threadId}/diff`),
    enabled: !!threadId,
    staleTime: 10_000,
  });
}
