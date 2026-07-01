import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ChatThread,
  ChatThreadSummary,
  StartChatRequest,
  SendMessageRequest,
} from '../../shared/types/chat';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useChatThreads() {
  return useQuery<ChatThread[]>({
    queryKey: ['chat-threads'],
    queryFn: () => apiFetch('/api/chat/threads'),
    staleTime: 30_000,
  });
}

export function useChatThreadList(limit = 50, project?: string | null) {
  return useQuery<ChatThreadSummary[]>({
    queryKey: ['chat-thread-list', limit, project],
    queryFn: () =>
      apiFetch(
        `/api/chat/threads?limit=${limit}${project ? `&project=${encodeURIComponent(project)}` : ''}`,
      ),
    enabled: !!project,
    staleTime: 30_000,
  });
}

export function useChatThread(threadId: string | null) {
  return useQuery<ChatThread>({
    queryKey: ['chat-thread', threadId],
    queryFn: () => apiFetch(`/api/chat/threads/${threadId}`),
    enabled: !!threadId,
    staleTime: 5_000,
  });
}

export function useStartChat() {
  const queryClient = useQueryClient();
  return useMutation<{ threadId: string }, Error, StartChatRequest>({
    mutationFn: (body) =>
      apiFetch('/api/chat/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
      queryClient.invalidateQueries({ queryKey: ['chat-thread-list'] });
    },
  });
}

export function useSendMessage(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, SendMessageRequest>({
    mutationFn: (body) =>
      apiFetch(`/api/chat/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-thread', threadId] });
      queryClient.invalidateQueries({ queryKey: ['chat-thread-list'] });
    },
  });
}

export function useCancelRun(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, void>({
    mutationFn: () =>
      apiFetch(`/api/chat/threads/${threadId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-thread', threadId] });
    },
  });
}

export function useCloseThread() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => apiFetch(`/api/chat/threads/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    },
  });
}

export function useDeleteThread() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => apiFetch(`/api/chat/threads/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      // Remove the deleted thread from all list caches (any project/limit combo)
      queryClient.setQueriesData<ChatThreadSummary[]>(
        { queryKey: ['chat-thread-list'] },
        (prev) => (prev ? prev.filter((t) => t.id !== id) : []),
      );
      // Drop the full-thread cache entry so it can't be loaded again
      queryClient.removeQueries({ queryKey: ['chat-thread', id] });
    },
  });
}

export function useFlagThread() {
  const queryClient = useQueryClient();
  return useMutation<
    { flagged: boolean; flaggedAt: string | null },
    Error,
    { threadId: string; flagged: boolean }
  >({
    mutationFn: ({ threadId, flagged }) =>
      apiFetch(`/api/chat/threads/${threadId}/flag`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flagged }),
      }),
    onSuccess: (data, { threadId }) => {
      queryClient.setQueriesData<ChatThreadSummary[]>(
        { queryKey: ['chat-thread-list'] },
        (prev) =>
          prev?.map((t) =>
            t.id === threadId
              ? { ...t, flagged: data.flagged, flaggedAt: data.flaggedAt ?? undefined }
              : t,
          ),
      );
      queryClient.invalidateQueries({ queryKey: ['chat-thread', threadId] });
    },
  });
}

export function useSkillProjects() {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: ['skill-projects'],
    queryFn: () => apiFetch('/api/skills/projects'),
    staleTime: 5 * 60_000,
  });
}

export function useSkillRepos(project: string | null, provider?: string) {
  const providerParam = provider ? `&provider=${encodeURIComponent(provider)}` : '';
  return useQuery<{ id: string; name: string; defaultBranch: string }[]>({
    queryKey: ['skill-repos', project, provider],
    queryFn: () => apiFetch(`/api/skills/repos?project=${encodeURIComponent(project!)}${providerParam}`),
    enabled: !!project,
    staleTime: 5 * 60_000,
  });
}

export function useSkillBranches(project: string | null, repo: string | null, provider?: string) {
  const providerParam = provider ? `&provider=${encodeURIComponent(provider)}` : '';
  return useQuery<string[]>({
    queryKey: ['skill-branches', project, repo, provider],
    queryFn: () => apiFetch(`/api/skills/branches?project=${encodeURIComponent(project!)}&repo=${encodeURIComponent(repo!)}${providerParam}`),
    enabled: !!project && !!repo,
    staleTime: 5 * 60_000,
  });
}

export function useSkillList(project: string | null, repo: string | null, branch?: string, provider?: string) {
  const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : '';
  const providerParam = provider ? `&provider=${encodeURIComponent(provider)}` : '';
  return useQuery<
    { id: string; name: string; description: string; path: string }[]
  >({
    queryKey: ['skill-list', project, repo, branch, provider],
    queryFn: () =>
      apiFetch(
        `/api/skills/list?project=${encodeURIComponent(project!)}&repo=${encodeURIComponent(repo!)}${branchParam}${providerParam}`,
      ),
    enabled: !!project && !!repo,
    staleTime: 5 * 60_000,
  });
}

