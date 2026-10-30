import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BrainstormMessageDto,
  BrainstormSessionDetail,
  BrainstormSessionListResponse,
} from '../../shared/types/brainstorm';

export class BrainstormApiError extends Error {
  readonly status: number;
  /** The server's error code, when the body carried one. */
  readonly code: string | null;
  readonly body: Record<string, unknown>;

  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BrainstormApiError';
    this.status = status;
    this.code = typeof body.code === 'string' ? body.code : null;
    this.body = body;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new BrainstormApiError(
      response.status,
      typeof body.error === 'string' ? body.error : 'The request failed.',
      body,
    );
  }
  return body as T;
}

export function brainstormPath(project: string, suffix = ''): string {
  return `/api/brainstorm/sessions${suffix}?project=${encodeURIComponent(project)}`;
}

export const brainstormKeys = {
  all: (project: string) => ['brainstorm', project] as const,
  list: (project: string) => ['brainstorm', project, 'sessions'] as const,
  session: (project: string, sessionId: string) => ['brainstorm', project, 'session', sessionId] as const,
  messages: (project: string, sessionId: string) => ['brainstorm', project, 'messages', sessionId] as const,
};

export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (error instanceof BrainstormApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function useBrainstormSessions(project: string) {
  return useQuery({
    queryKey: brainstormKeys.list(project),
    enabled: Boolean(project),
    queryFn: () => apiFetch<BrainstormSessionListResponse>(brainstormPath(project)),
    retry: retryUnlessClientError,
  });
}

export function useBrainstormSession(project: string, sessionId: string) {
  return useQuery({
    queryKey: brainstormKeys.session(project, sessionId),
    enabled: Boolean(project && sessionId),
    queryFn: async () => {
      const body = await apiFetch<{ session: BrainstormSessionDetail }>(
        brainstormPath(project, `/${encodeURIComponent(sessionId)}`),
      );
      return body.session;
    },
    retry: retryUnlessClientError,
  });
}

/** Polls while a collaborator reply is still streaming; the server reconciles missed terminals on read. */
export function useBrainstormMessages(project: string, sessionId: string, enabled = true) {
  return useQuery({
    queryKey: brainstormKeys.messages(project, sessionId),
    enabled: Boolean(project && sessionId) && enabled,
    queryFn: async () => {
      const body = await apiFetch<{ messages: BrainstormMessageDto[] }>(
        brainstormPath(project, `/${encodeURIComponent(sessionId)}/messages`),
      );
      return body.messages;
    },
    retry: retryUnlessClientError,
    refetchInterval: (query) => (
      query.state.data?.some((message) => message.status === 'streaming') ? 3_000 : false
    ),
  });
}

export function useCreateBrainstormSession(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const body = await apiFetch<{ session: BrainstormSessionDetail }>(
        brainstormPath(project),
        { method: 'POST', body: '{}' },
      );
      return body.session;
    },
    onSuccess: (session) => {
      client.setQueryData(brainstormKeys.session(project, session.id), session);
      void client.invalidateQueries({ queryKey: brainstormKeys.list(project) });
    },
  });
}

export function useDeleteBrainstormSession(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) =>
      apiFetch<{ deleted: true; id: string }>(
        brainstormPath(project, `/${encodeURIComponent(sessionId)}`),
        { method: 'DELETE' },
      ),
    onSuccess: (_result, sessionId) => {
      client.removeQueries({ queryKey: brainstormKeys.session(project, sessionId) });
      void client.invalidateQueries({ queryKey: brainstormKeys.list(project) });
    },
  });
}

export function useRenameBrainstormSession(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sessionId: string; title: string }) => {
      const body = await apiFetch<{ session: BrainstormSessionDetail }>(
        brainstormPath(project, `/${encodeURIComponent(input.sessionId)}`),
        { method: 'PATCH', body: JSON.stringify({ title: input.title }) },
      );
      return body.session;
    },
    onSuccess: (session) => {
      client.setQueryData(brainstormKeys.session(project, session.id), session);
      void client.invalidateQueries({ queryKey: brainstormKeys.list(project) });
    },
  });
}
