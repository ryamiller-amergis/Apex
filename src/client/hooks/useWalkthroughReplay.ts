/**
 * FEAT-006 — TanStack Query hooks for replay list, definition refetch, and progress mutation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  UpdateWalkthroughProgressRequest,
  WalkthroughDefinition,
  WalkthroughProgress,
  WalkthroughReplayPage,
} from '../../shared/types/walkthrough';

export class WalkthroughApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'WalkthroughApiError';
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new WalkthroughApiError(
      res.status,
      body.error ?? `HTTP ${res.status}`,
      body.code,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const walkthroughReplayListQueryKey = (projectId: string | null | undefined) =>
  ['walkthrough-replay-list', projectId ?? null] as const;

export const walkthroughDefinitionQueryKey = (
  projectId: string | null | undefined,
  walkthroughId: string | null | undefined,
) => ['walkthrough-definition', projectId ?? null, walkthroughId ?? null] as const;

export function useWalkthroughReplayList(projectId: string | null | undefined, enabled = true) {
  return useQuery<WalkthroughReplayPage, WalkthroughApiError>({
    queryKey: walkthroughReplayListQueryKey(projectId),
    queryFn: () =>
      apiFetch<WalkthroughReplayPage>(
        `/api/projects/${encodeURIComponent(projectId!)}/walkthroughs/replay`,
      ),
    enabled: Boolean(enabled && projectId),
    retry: false,
    staleTime: 30_000,
  });
}

export function useWalkthroughDefinition(
  projectId: string | null | undefined,
  walkthroughId: string | null | undefined,
  enabled = true,
) {
  return useQuery<WalkthroughDefinition, WalkthroughApiError>({
    queryKey: walkthroughDefinitionQueryKey(projectId, walkthroughId),
    queryFn: () =>
      apiFetch<WalkthroughDefinition>(
        `/api/projects/${encodeURIComponent(projectId!)}/walkthroughs/${encodeURIComponent(walkthroughId!)}`,
      ),
    enabled: Boolean(enabled && projectId && walkthroughId),
    retry: false,
  });
}

export interface UpdateWalkthroughProgressVars {
  walkthroughId: string;
  body: UpdateWalkthroughProgressRequest;
}

export function useUpdateWalkthroughProgress(projectId: string | null | undefined) {
  const queryClient = useQueryClient();

  return useMutation<WalkthroughProgress, WalkthroughApiError, UpdateWalkthroughProgressVars>({
    mutationFn: ({ walkthroughId, body }) => {
      if (!projectId) {
        throw new WalkthroughApiError(400, 'Project is required');
      }
      return apiFetch<WalkthroughProgress>(
        `/api/projects/${encodeURIComponent(projectId)}/walkthroughs/${encodeURIComponent(walkthroughId)}/progress`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: walkthroughReplayListQueryKey(projectId) });
      void queryClient.invalidateQueries({
        queryKey: ['walkthrough-eligibility', projectId ?? null],
      });
      void queryClient.invalidateQueries({
        queryKey: walkthroughDefinitionQueryKey(projectId, vars.walkthroughId),
      });
    },
  });
}
