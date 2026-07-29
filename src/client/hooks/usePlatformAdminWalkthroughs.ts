import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateWalkthroughCommand,
  PublishWalkthroughCommand,
  UpdateWalkthroughCommand,
  WalkthroughCatalogPage,
  WalkthroughDefinition,
  WalkthroughLifecycle,
} from '../../shared/types/walkthrough';
import type { WalkthroughAnchorRegistryEntry } from '../../shared/walkthroughAnchors';

export const walkthroughQueryKeys = {
  catalog: (params?: WalkthroughCatalogParams) => ['platform-admin', 'walkthroughs', 'catalog', params] as const,
  detail: (id: string | null) => ['platform-admin', 'walkthroughs', 'detail', id] as const,
  anchors: ['platform-admin', 'walkthroughs', 'anchors'] as const,
};

export interface WalkthroughCatalogParams {
  lifecycle?: WalkthroughLifecycle;
  project?: string;
  limit?: number;
}

interface WalkthroughAnchorsResponse {
  anchors: WalkthroughAnchorRegistryEntry[];
}

async function walkthroughFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

function buildCatalogUrl(params: WalkthroughCatalogParams, cursor: string | null): string {
  const search = new URLSearchParams();
  if (cursor) search.set('cursor', cursor);
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.lifecycle) search.set('lifecycle', params.lifecycle);
  if (params.project) search.set('project', params.project);
  const qs = search.toString();
  return `/api/platform-admin/walkthroughs${qs ? `?${qs}` : ''}`;
}

export function useWalkthroughCatalog(params: WalkthroughCatalogParams = {}) {
  return useInfiniteQuery<WalkthroughCatalogPage>({
    queryKey: walkthroughQueryKeys.catalog(params),
    queryFn: ({ pageParam }) =>
      walkthroughFetch<WalkthroughCatalogPage>(buildCatalogUrl(params, pageParam as string | null)),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
  });
}

export function useWalkthroughDetail(id: string | null) {
  return useQuery<WalkthroughDefinition>({
    queryKey: walkthroughQueryKeys.detail(id),
    queryFn: () =>
      walkthroughFetch<WalkthroughDefinition>(`/api/platform-admin/walkthroughs/${encodeURIComponent(id!)}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useWalkthroughAnchors() {
  return useQuery<WalkthroughAnchorRegistryEntry[]>({
    queryKey: walkthroughQueryKeys.anchors,
    queryFn: async () => {
      const data = await walkthroughFetch<WalkthroughAnchorsResponse>('/api/platform-admin/walkthroughs/anchors');
      return data.anchors;
    },
    staleTime: 300_000,
  });
}

export function useCreateWalkthrough() {
  const queryClient = useQueryClient();
  return useMutation<WalkthroughDefinition, Error, CreateWalkthroughCommand>({
    mutationFn: (body) =>
      walkthroughFetch<WalkthroughDefinition>('/api/platform-admin/walkthroughs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-admin', 'walkthroughs'] });
    },
  });
}

export function useUpdateWalkthrough() {
  const queryClient = useQueryClient();
  return useMutation<
    WalkthroughDefinition,
    Error,
    { id: string } & UpdateWalkthroughCommand
  >({
    mutationFn: ({ id, ...body }) =>
      walkthroughFetch<WalkthroughDefinition>(`/api/platform-admin/walkthroughs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['platform-admin', 'walkthroughs'] });
      queryClient.setQueryData(walkthroughQueryKeys.detail(data.id), data);
    },
  });
}

export function usePublishWalkthrough() {
  const queryClient = useQueryClient();
  return useMutation<
    WalkthroughDefinition,
    Error,
    { id: string } & PublishWalkthroughCommand
  >({
    mutationFn: ({ id, ...body }) =>
      walkthroughFetch<WalkthroughDefinition>(
        `/api/platform-admin/walkthroughs/${encodeURIComponent(id)}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['platform-admin', 'walkthroughs'] });
      queryClient.setQueryData(walkthroughQueryKeys.detail(data.id), data);
    },
  });
}

export function useUnpublishWalkthrough() {
  const queryClient = useQueryClient();
  return useMutation<WalkthroughDefinition, Error, { id: string; expectedUpdatedAt?: string }>({
    mutationFn: ({ id, expectedUpdatedAt }) =>
      walkthroughFetch<WalkthroughDefinition>(
        `/api/platform-admin/walkthroughs/${encodeURIComponent(id)}/unpublish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedUpdatedAt }),
        },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['platform-admin', 'walkthroughs'] });
      queryClient.setQueryData(walkthroughQueryKeys.detail(data.id), data);
    },
  });
}

export function useArchiveWalkthrough() {
  const queryClient = useQueryClient();
  return useMutation<WalkthroughDefinition, Error, { id: string; expectedUpdatedAt?: string }>({
    mutationFn: ({ id, expectedUpdatedAt }) =>
      walkthroughFetch<WalkthroughDefinition>(
        `/api/platform-admin/walkthroughs/${encodeURIComponent(id)}/archive`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedUpdatedAt }),
        },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['platform-admin', 'walkthroughs'] });
      queryClient.setQueryData(walkthroughQueryKeys.detail(data.id), data);
    },
  });
}
