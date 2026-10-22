import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CodeLabDiff,
  CodeLabLogs,
  CodeLabPushResult,
  CodeLabSession,
  StartCodeLabSessionRequest,
} from '../../shared/types/codeLab';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

const sessionUrl = (id: string, project: string, suffix = '') =>
  `/api/code-lab/sessions/${encodeURIComponent(id)}${suffix}?project=${encodeURIComponent(project)}`;

const IN_PROGRESS_STATUSES = new Set<CodeLabSession['status']>(['preparing', 'starting_preview']);

export const codeLabKeys = {
  active: (project: string) => ['code-lab', 'active', project] as const,
  diff: (id: string) => ['code-lab', 'diff', id] as const,
  logs: (id: string) => ['code-lab', 'logs', id] as const,
};

/** The caller's live session for this project; polls while setup is running. */
export function useActiveCodeLabSession(project: string | null | undefined) {
  return useQuery<CodeLabSession | null>({
    queryKey: codeLabKeys.active(project ?? ''),
    queryFn: async () => {
      const data = await apiFetch<{ session: CodeLabSession | null }>(
        `/api/code-lab/sessions/active?project=${encodeURIComponent(project!)}`,
      );
      return data.session;
    },
    enabled: !!project,
    refetchInterval: (query) => {
      const session = query.state.data;
      if (!session) return false;
      return IN_PROGRESS_STATUSES.has(session.status) ? 2_000 : 15_000;
    },
  });
}

export function useCodeLabDiff(sessionId: string | null, project: string, enabled: boolean) {
  return useQuery<CodeLabDiff>({
    queryKey: codeLabKeys.diff(sessionId ?? ''),
    queryFn: () => apiFetch(sessionUrl(sessionId!, project, '/diff')),
    enabled: enabled && !!sessionId,
  });
}

export function useCodeLabLogs(sessionId: string | null, project: string, enabled: boolean) {
  return useQuery<CodeLabLogs>({
    queryKey: codeLabKeys.logs(sessionId ?? ''),
    queryFn: () => apiFetch(sessionUrl(sessionId!, project, '/logs')),
    enabled: enabled && !!sessionId,
    refetchInterval: enabled ? 3_000 : false,
  });
}

export function useStartCodeLabSession() {
  const qc = useQueryClient();
  return useMutation<CodeLabSession, Error, StartCodeLabSessionRequest>({
    mutationFn: (body) =>
      apiFetch('/api/code-lab/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (session) => {
      qc.setQueryData(codeLabKeys.active(session.project), session);
    },
  });
}

export function useStopCodeLabSession(project: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiFetch(sessionUrl(id, project), { method: 'DELETE' }),
    onSuccess: () => {
      qc.setQueryData(codeLabKeys.active(project), null);
    },
  });
}

export function useRestartCodeLabPreview(project: string) {
  const qc = useQueryClient();
  return useMutation<CodeLabSession, Error, string>({
    mutationFn: (id) => apiFetch(sessionUrl(id, project, '/preview/restart'), { method: 'POST' }),
    onSuccess: (session) => {
      qc.setQueryData(codeLabKeys.active(project), session);
    },
  });
}

export function usePushCodeLabBranch(project: string) {
  const qc = useQueryClient();
  return useMutation<CodeLabPushResult, Error, string>({
    mutationFn: (id) => apiFetch(sessionUrl(id, project, '/push'), { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: codeLabKeys.active(project) });
    },
  });
}
