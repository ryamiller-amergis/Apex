import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AssignedWorkItem,
  StartDevSessionResponse,
  DevDiff,
  ActiveDevSession,
  DevSessionDetail,
  ConflictedFile,
  PushSessionResponse,
  CreatePrResponse,
} from '../../shared/types/devWorkbench';

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

export function useStartDevSession() {
  const queryClient = useQueryClient();
  return useMutation<StartDevSessionResponse, Error, { workItemId?: number; project: string; model?: string; prdId?: string; featureId?: string }>({
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
    queryKey: ['dev-workbench', 'session', sessionId],
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

export function useDevDiff(threadId: string | null) {
  return useQuery<DevDiff>({
    queryKey: ['dev-workbench', 'diff', threadId],
    queryFn: () => apiFetch(`/api/dev-workbench/threads/${threadId}/diff`),
    enabled: !!threadId,
    staleTime: 10_000,
  });
}
