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

export function useChatThreadList(limit = 50) {
  return useQuery<ChatThreadSummary[]>({
    queryKey: ['chat-thread-list', limit],
    queryFn: () => apiFetch(`/api/chat/threads?limit=${limit}`),
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
      // Remove the deleted thread from the list cache immediately (optimistic)
      queryClient.setQueryData<ChatThreadSummary[]>(
        ['chat-thread-list', 50],
        (prev) => (prev ? prev.filter((t) => t.id !== id) : []),
      );
      // Drop the full-thread cache entry so it can't be loaded again
      queryClient.removeQueries({ queryKey: ['chat-thread', id] });
    },
  });
}

export function useSaveToWiki(threadId: string) {
  return useMutation<
    { path: string; url: string; version: string },
    Error,
    { project: string; wikiId: string; path: string; comment?: string }
  >({
    mutationFn: (body) =>
      apiFetch(`/api/chat/threads/${threadId}/save-to-wiki`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  });
}

export function useSkillProjects() {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: ['skill-projects'],
    queryFn: () => apiFetch('/api/skills/projects'),
    staleTime: 5 * 60_000,
  });
}

export function useSkillRepos(project: string | null) {
  return useQuery<{ id: string; name: string; defaultBranch: string }[]>({
    queryKey: ['skill-repos', project],
    queryFn: () => apiFetch(`/api/skills/repos?project=${encodeURIComponent(project!)}`),
    enabled: !!project,
    staleTime: 5 * 60_000,
  });
}

export function useSkillList(project: string | null, repo: string | null, branch?: string) {
  const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : '';
  return useQuery<
    { id: string; name: string; description: string; path: string }[]
  >({
    queryKey: ['skill-list', project, repo, branch],
    queryFn: () =>
      apiFetch(
        `/api/skills/list?project=${encodeURIComponent(project!)}&repo=${encodeURIComponent(repo!)}${branchParam}`,
      ),
    enabled: !!project && !!repo,
    staleTime: 5 * 60_000,
  });
}

export function useWikiList(project: string | null) {
  return useQuery<{ id: string; name: string; type: string }[]>({
    queryKey: ['wiki-list', project],
    queryFn: () => apiFetch(`/api/wiki/wikis?project=${encodeURIComponent(project!)}`),
    enabled: !!project,
    staleTime: 5 * 60_000,
  });
}
