import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApexWorkItem,
  ApexWorkItemDraft,
  ApexWorkItemFacets,
  ApexWorkItemFilters,
  ApexWorkItemStatus,
  CreateApexWorkItemDTO,
  CreateFromDraftsDTO,
  GenerateFromFeatureRequestDTO,
  MoveApexWorkItemDTO,
  UpdateApexWorkItemDTO,
  WorkItemOwnerSummary,
} from '../../shared/types/apexWorkItem';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function buildQueryString(filters: ApexWorkItemFilters): string {
  const p = new URLSearchParams();
  if (filters.ownerId) p.set('ownerId', filters.ownerId);
  if (filters.types?.length) p.set('types', filters.types.join(','));
  if (filters.epicTitle) p.set('epicTitle', filters.epicTitle);
  if (filters.featureTitle) p.set('featureTitle', filters.featureTitle);
  if (filters.sourceType) p.set('sourceType', filters.sourceType);
  if (filters.search) p.set('search', filters.search);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

// ── Owners ────────────────────────────────────────────────────────────────────

export function useApexWorkItemOwners() {
  return useQuery<WorkItemOwnerSummary[]>({
    queryKey: ['apex-work-items', 'owners'],
    queryFn: () => apiFetch('/api/apex-work-items/owners'),
    staleTime: 60_000,
  });
}

// ── Facets ────────────────────────────────────────────────────────────────────

export function useApexWorkItemFacets() {
  return useQuery<ApexWorkItemFacets>({
    queryKey: ['apex-work-items', 'facets'],
    queryFn: () => apiFetch('/api/apex-work-items/facets'),
    staleTime: 30_000,
  });
}

// ── List ──────────────────────────────────────────────────────────────────────

export function useApexWorkItems(filters: ApexWorkItemFilters = {}) {
  return useQuery<ApexWorkItem[]>({
    queryKey: ['apex-work-items', 'list', filters],
    queryFn: () => apiFetch(`/api/apex-work-items${buildQueryString(filters)}`),
    staleTime: 15_000,
  });
}

// ── Get by id ─────────────────────────────────────────────────────────────────

export function useApexWorkItem(id: string | null) {
  return useQuery<ApexWorkItem>({
    queryKey: ['apex-work-items', 'item', id],
    queryFn: () => apiFetch(`/api/apex-work-items/${id!}`),
    enabled: !!id,
    staleTime: 10_000,
  });
}

// ── Create ────────────────────────────────────────────────────────────────────

export function useCreateApexWorkItem() {
  const qc = useQueryClient();
  return useMutation<ApexWorkItem, Error, CreateApexWorkItemDTO>({
    mutationFn: (dto) =>
      apiFetch('/api/apex-work-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items'] });
    },
  });
}

// ── Update ────────────────────────────────────────────────────────────────────

export function useUpdateApexWorkItem() {
  const qc = useQueryClient();
  return useMutation<ApexWorkItem, Error, { id: string } & UpdateApexWorkItemDTO>({
    mutationFn: ({ id, ...dto }) =>
      apiFetch(`/api/apex-work-items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items'] });
    },
  });
}

// ── Move (optimistic) ─────────────────────────────────────────────────────────

export function useMoveApexWorkItem(filters: ApexWorkItemFilters = {}) {
  const qc = useQueryClient();
  const listKey = ['apex-work-items', 'list', filters];

  return useMutation<
    ApexWorkItem,
    Error,
    { id: string } & MoveApexWorkItemDTO,
    { previous: ApexWorkItem[] | undefined }
  >({
    onMutate: async ({ id, targetStatus, targetPosition }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<ApexWorkItem[]>(listKey);

      qc.setQueryData<ApexWorkItem[]>(listKey, (old) => {
        if (!old) return old;
        return old.map((item) =>
          item.id === id
            ? { ...item, status: targetStatus as ApexWorkItemStatus, position: targetPosition ?? item.position }
            : item,
        );
      });
      return { previous };
    },
    mutationFn: ({ id, ...dto }) =>
      apiFetch(`/api/apex-work-items/${id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(listKey, ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items'] });
    },
  });
}

// ── Process 1 — Materialized ids ─────────────────────────────────────────────

export function useMaterializedItemIds(prdId: string | null) {
  return useQuery<{ backlogItemIds: string[] }>({
    queryKey: ['apex-work-items', 'materialized', prdId],
    queryFn: () => apiFetch(`/api/apex-work-items/materialized-ids/${prdId!}`),
    enabled: !!prdId,
    staleTime: 10_000,
  });
}

export function useMaterializeFromPrd() {
  const qc = useQueryClient();
  return useMutation<ApexWorkItem[], Error, Parameters<typeof apiFetch>[1] & { prdId: string; ownerId: string; items: unknown[] }>({
    mutationFn: (dto) =>
      apiFetch('/api/apex-work-items/materialize-from-prd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items'] });
    },
  });
}

// ── Process 2 — Generate drafts from FR ──────────────────────────────────────

export function useGenerateDrafts() {
  return useMutation<{ drafts: ApexWorkItemDraft[] }, Error, GenerateFromFeatureRequestDTO>({
    mutationFn: (dto) =>
      apiFetch('/api/apex-work-items/generate-drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
  });
}

export function useCreateFromDrafts() {
  const qc = useQueryClient();
  return useMutation<ApexWorkItem[], Error, CreateFromDraftsDTO>({
    mutationFn: (dto) =>
      apiFetch('/api/apex-work-items/create-from-drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items'] });
      qc.invalidateQueries({ queryKey: ['feature-requests'] });
    },
  });
}
