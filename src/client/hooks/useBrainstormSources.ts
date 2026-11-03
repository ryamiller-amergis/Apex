import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BrainstormCitationDto,
  BrainstormSourceDto,
  BrainstormSourceOptionsDto,
  BrainstormSourceState,
} from '../../shared/types/brainstormSources';
import { BrainstormApiError, brainstormKeys } from './useBrainstormSessions';

const TRANSITIONAL: BrainstormSourceState[] = ['preparing', 'restoring', 'removing'];

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function sourceFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
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

function sessionPath(project: string, sessionId: string, suffix: string): string {
  return `/api/brainstorm/sessions/${encodeURIComponent(sessionId)}${suffix}?project=${encodeURIComponent(project)}`;
}

export const brainstormSourceKeys = {
  sources: (project: string, sessionId: string) => [...brainstormKeys.session(project, sessionId), 'sources'] as const,
  options: (project: string, sessionId: string) => [...brainstormKeys.session(project, sessionId), 'source-options'] as const,
  citations: (project: string, sessionId: string) => [...brainstormKeys.session(project, sessionId), 'citations'] as const,
};

export function sourceIsTransitional(source: BrainstormSourceDto): boolean {
  return TRANSITIONAL.includes(source.state);
}

export function useBrainstormSources(project: string, sessionId: string) {
  return useQuery({
    queryKey: brainstormSourceKeys.sources(project, sessionId),
    enabled: Boolean(project && sessionId),
    queryFn: () => sourceFetch<BrainstormSourceDto[]>(sessionPath(project, sessionId, '/sources')),
    refetchInterval: (query) => (
      query.state.data?.some(sourceIsTransitional) ? 2_000 : false
    ),
  });
}

export function useBrainstormSourceOptions(project: string, sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: brainstormSourceKeys.options(project, sessionId),
    enabled: enabled && Boolean(project && sessionId),
    queryFn: () => sourceFetch<BrainstormSourceOptionsDto>(sessionPath(project, sessionId, '/sources/options')),
  });
}

export function useBrainstormCitations(project: string, sessionId: string) {
  return useQuery({
    queryKey: brainstormSourceKeys.citations(project, sessionId),
    enabled: Boolean(project && sessionId),
    queryFn: () => sourceFetch<BrainstormCitationDto[]>(sessionPath(project, sessionId, '/citations')),
  });
}

export function useAttachBrainstormSource(project: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, string>) => sourceFetch<{ source: BrainstormSourceDto }>(
      sessionPath(project, sessionId, '/sources'),
      { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: brainstormSourceKeys.sources(project, sessionId) });
    },
  });
}

export function useRemoveBrainstormSource(project: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => sourceFetch<{ source: BrainstormSourceDto }>(
      sessionPath(project, sessionId, `/sources/${encodeURIComponent(sourceId)}`),
      { method: 'DELETE' },
    ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: brainstormSourceKeys.sources(project, sessionId) });
    },
  });
}

export function useEndBrainstormSession(project: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => sourceFetch<{ session: { endedAt: string }; cleanup: string }>(
      sessionPath(project, sessionId, '/end'),
      { method: 'POST', body: '{}' },
    ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: brainstormKeys.session(project, sessionId) });
      void client.invalidateQueries({ queryKey: brainstormSourceKeys.sources(project, sessionId) });
    },
  });
}
