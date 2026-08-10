import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApexDeployment,
  ApexRelease,
  ApexWorkItem,
  ApexWorkItemAttachment,
  ApexWorkItemComment,
  ApexWorkItemDraft,
  ApexWorkItemFacets,
  ApexWorkItemFilters,
  ApexWorkItemStatus,
  BoardEventStatRow,
  BulkUpdateApexWorkItemsDTO,
  CreateApexReleaseDTO,
  CreateApexWorkItemDTO,
  CreateFromDraftsDTO,
  CreateFromDraftsResult,
  DraftReconcilePreviewResult,
  GenerateFromFeatureRequestDTO,
  MaterializePreviewResult,
  MaterializeResult,
  MoveApexWorkItemDTO,
  RecordApexDeploymentDTO,
  UpdateApexReleaseDTO,
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

function withProject(url: string, project: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}project=${encodeURIComponent(project)}`;
}

function buildQueryString(filters: ApexWorkItemFilters): string {
  const p = new URLSearchParams();
  p.set('project', filters.project);
  if (filters.ownerId) p.set('ownerId', filters.ownerId);
  if (filters.types?.length) p.set('types', filters.types.join(','));
  if (filters.epicTitle) p.set('epicTitle', filters.epicTitle);
  if (filters.featureTitle) p.set('featureTitle', filters.featureTitle);
  if (filters.sourceType) p.set('sourceType', filters.sourceType);
  if (filters.releaseId) p.set('releaseId', filters.releaseId);
  if (filters.parentId) p.set('parentId', filters.parentId);
  if (filters.search) p.set('search', filters.search);
  return `?${p.toString()}`;
}

// ── Owners ────────────────────────────────────────────────────────────────────

export function useApexWorkItemOwners(project: string | null) {
  return useQuery<WorkItemOwnerSummary[]>({
    queryKey: ['apex-work-items', project, 'owners'],
    queryFn: () => apiFetch(withProject('/api/apex-work-items/owners', project!)),
    enabled: !!project,
    staleTime: 60_000,
  });
}

// ── Facets ────────────────────────────────────────────────────────────────────

export function useApexWorkItemFacets(project: string | null) {
  return useQuery<ApexWorkItemFacets>({
    queryKey: ['apex-work-items', project, 'facets'],
    queryFn: () => apiFetch(withProject('/api/apex-work-items/facets', project!)),
    enabled: !!project,
    staleTime: 30_000,
  });
}

// ── Releases ──────────────────────────────────────────────────────────────────

export function useApexReleases(project: string | null) {
  return useQuery<ApexRelease[]>({
    queryKey: ['apex-work-items', project, 'releases'],
    queryFn: () => apiFetch(withProject('/api/apex-work-items/releases', project!)),
    enabled: !!project,
    staleTime: 30_000,
  });
}

export function useCreateApexRelease(project: string | null) {
  const qc = useQueryClient();
  return useMutation<ApexRelease, Error, CreateApexReleaseDTO>({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items/releases', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
    },
  });
}

export function useUpdateApexRelease(project: string | null) {
  const qc = useQueryClient();
  return useMutation<ApexRelease, Error, { id: string } & UpdateApexReleaseDTO>({
    mutationFn: ({ id, ...dto }) =>
      apiFetch(withProject(`/api/apex-work-items/releases/${id}`, project!), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
    },
  });
}

// ── List ──────────────────────────────────────────────────────────────────────

export function useApexWorkItems(filters: ApexWorkItemFilters | null) {
  return useQuery<ApexWorkItem[]>({
    queryKey: ['apex-work-items', filters?.project, 'list', filters],
    queryFn: () => apiFetch(`/api/apex-work-items${buildQueryString(filters!)}`),
    enabled: !!filters?.project,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}

// ── Get by id ─────────────────────────────────────────────────────────────────

export function useApexWorkItem(id: string | null, project: string | null) {
  return useQuery<ApexWorkItem>({
    queryKey: ['apex-work-items', project, 'item', id],
    queryFn: () => apiFetch(withProject(`/api/apex-work-items/${id!}`, project!)),
    enabled: !!id && !!project,
    staleTime: 10_000,
  });
}

// ── Create ────────────────────────────────────────────────────────────────────

export function useCreateApexWorkItem(project: string | null) {
  const qc = useQueryClient();
  return useMutation<ApexWorkItem, Error, CreateApexWorkItemDTO>({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dto, project }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
    },
  });
}

// ── Update ────────────────────────────────────────────────────────────────────

export function useUpdateApexWorkItem(project: string | null) {
  const qc = useQueryClient();
  return useMutation<ApexWorkItem, Error, { id: string } & UpdateApexWorkItemDTO>({
    mutationFn: ({ id, ...dto }) =>
      apiFetch(withProject(`/api/apex-work-items/${id}`, project!), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
    },
  });
}

// ── Move (optimistic) ─────────────────────────────────────────────────────────

export function useMoveApexWorkItem(filters: ApexWorkItemFilters | null) {
  const qc = useQueryClient();
  const project = filters?.project ?? null;
  const listKey = ['apex-work-items', project, 'list', filters];

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
      apiFetch(withProject(`/api/apex-work-items/${id}/move`, project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(listKey, ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
    },
  });
}

export function useBulkUpdateApexWorkItems(project: string | null) {
  const qc = useQueryClient();
  return useMutation<ApexWorkItem[], Error, BulkUpdateApexWorkItemsDTO>({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items/bulk', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
    },
  });
}

export interface AdoImportResult {
  created: number;
  updated: number;
  skipped: number;
  releasesCreated: number;
  errors: string[];
  preview?: Array<{
    adoId: number;
    title: string;
    type: string;
    status: string;
    adoState: string;
    releaseName: string | null;
    parentAdoId: number | null;
    action: 'create' | 'update' | 'skip';
  }>;
}

export function useImportApexWorkItemsFromAdo(project: string | null) {
  const qc = useQueryClient();
  return useMutation<AdoImportResult, Error, { dryRun?: boolean; areaPath?: string }>({
    mutationFn: (body) =>
      apiFetch(withProject('/api/apex-work-items/import/ado', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, vars) => {
      if (!vars.dryRun) {
        qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
      }
    },
  });
}

// ── Comments ──────────────────────────────────────────────────────────────────

export function useAddApexWorkItemComment(project: string | null) {
  const qc = useQueryClient();
  return useMutation<ApexWorkItemComment, Error, { id: string; body: string }>({
    mutationFn: ({ id, body }) =>
      apiFetch(withProject(`/api/apex-work-items/${id}/comments`, project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project, 'item', vars.id] });
    },
  });
}

// ── Process 1 — Materialized ids ─────────────────────────────────────────────

export function useMaterializedItemIds(prdId: string | null, project: string | null) {
  return useQuery<{ backlogItemIds: string[] }>({
    queryKey: ['apex-work-items', project, 'materialized', prdId],
    queryFn: () => apiFetch(withProject(`/api/apex-work-items/materialized-ids/${prdId!}`, project!)),
    enabled: !!prdId && !!project,
    staleTime: 10_000,
  });
}

export function usePreviewMaterializeFromPrd(project: string | null) {
  return useMutation<MaterializePreviewResult, Error, { prdId: string; items: unknown[] }>({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items/materialize-from-prd/preview', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dto, project }),
      }),
  });
}

export function useMaterializeFromPrd(project: string | null) {
  const qc = useQueryClient();
  return useMutation<
    MaterializeResult,
    Error,
    {
      prdId: string;
      ownerId: string;
      items: unknown[];
      linkChoices?: Record<string, string | 'create' | 'skip'>;
    }
  >({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items/materialize-from-prd', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dto, project }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
    },
  });
}

// ── Process 2 — Generate drafts from FR ──────────────────────────────────────

export function useGenerateDrafts(project: string | null) {
  return useMutation<{ drafts: ApexWorkItemDraft[] }, Error, GenerateFromFeatureRequestDTO>({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items/generate-drafts', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dto, project }),
      }),
  });
}

export function usePreviewCreateFromDrafts(project: string | null) {
  return useMutation<
    DraftReconcilePreviewResult,
    Error,
    Pick<CreateFromDraftsDTO, 'featureRequestId' | 'drafts'>
  >({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items/create-from-drafts/preview', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dto, project }),
      }),
  });
}

export function useCreateFromDrafts(project: string | null) {
  const qc = useQueryClient();
  return useMutation<CreateFromDraftsResult, Error, CreateFromDraftsDTO>({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items/create-from-drafts', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...dto, project }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
      qc.invalidateQueries({ queryKey: ['feature-requests'] });
    },
  });
}

export function useAssignedBoardItems(project: string | null) {
  return useQuery<ApexWorkItem[]>({
    queryKey: ['apex-work-items', project, 'assigned-to-me'],
    queryFn: () => apiFetch(withProject('/api/apex-work-items/assigned-to-me', project!)),
    enabled: !!project,
    staleTime: 15_000,
  });
}

// ── Deployments ───────────────────────────────────────────────────────────────

export function useApexDeployments(project: string | null, env?: string) {
  return useQuery<ApexDeployment[]>({
    queryKey: ['apex-work-items', project, 'deployments', env ?? 'all'],
    queryFn: () => {
      let url = withProject('/api/apex-work-items/deployments', project!);
      if (env) url += `&env=${encodeURIComponent(env)}`;
      return apiFetch(url);
    },
    enabled: !!project,
    staleTime: 30_000,
  });
}

export function useRecordApexDeployment(project: string | null) {
  const qc = useQueryClient();
  return useMutation<ApexDeployment, Error, RecordApexDeploymentDTO>({
    mutationFn: (dto) =>
      apiFetch(withProject('/api/apex-work-items/deployments', project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project, 'deployments'] });
    },
  });
}

// ── Board event stats ─────────────────────────────────────────────────────────

export function useBoardEventStats(project: string | null, from?: string, to?: string) {
  return useQuery<BoardEventStatRow[]>({
    queryKey: ['apex-work-items', project, 'stats', from ?? '', to ?? ''],
    queryFn: () => {
      let url = withProject('/api/apex-work-items/stats/events', project!);
      if (from) url += `&from=${encodeURIComponent(from)}`;
      if (to) url += `&to=${encodeURIComponent(to)}`;
      return apiFetch(url);
    },
    enabled: !!project,
    staleTime: 30_000,
  });
}

// ── Attachments ───────────────────────────────────────────────────────────────

export function useApexWorkItemAttachments(project: string | null, itemId: string | null) {
  return useQuery<ApexWorkItemAttachment[]>({
    queryKey: ['apex-work-items', project, 'item', itemId, 'attachments'],
    queryFn: () =>
      apiFetch(withProject(`/api/apex-work-items/${itemId!}/attachments`, project!)),
    enabled: !!project && !!itemId,
    staleTime: 10_000,
  });
}

export function useAddApexWorkItemAttachment(project: string | null) {
  const qc = useQueryClient();
  return useMutation<
    ApexWorkItemAttachment,
    Error,
    {
      id: string;
      fileName: string;
      contentType?: string;
      byteSize?: number;
      storagePath?: string;
      contentBase64?: string;
    }
  >({
    mutationFn: ({ id, ...meta }) =>
      apiFetch(withProject(`/api/apex-work-items/${id}/attachments`, project!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project, 'item', vars.id] });
      qc.invalidateQueries({
        queryKey: ['apex-work-items', project, 'item', vars.id, 'attachments'],
      });
    },
  });
}

export function useDeleteApexWorkItemAttachment(project: string | null) {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; attachmentId: string }>({
    mutationFn: ({ id, attachmentId }) =>
      apiFetch(
        withProject(`/api/apex-work-items/${id}/attachments/${attachmentId}`, project!),
        { method: 'DELETE' },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project, 'item', vars.id] });
      qc.invalidateQueries({
        queryKey: ['apex-work-items', project, 'item', vars.id, 'attachments'],
      });
    },
  });
}

// ── SSE board stream ──────────────────────────────────────────────────────────

export function useApexWorkBoardStream(project: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!project) return;

    const url = withProject('/api/apex-work-items/stream', project);
    const es = new EventSource(url, { withCredentials: true });

    es.onmessage = () => {
      qc.invalidateQueries({ queryKey: ['apex-work-items', project] });
    };

    es.onerror = () => {
      // Browser will auto-reconnect; avoid console spam.
    };

    return () => {
      es.close();
    };
  }, [project, qc]);
}
