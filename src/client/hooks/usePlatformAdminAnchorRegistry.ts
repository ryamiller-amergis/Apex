/**
 * Platform Admin — Smart Anchor Management catalog hooks (Phase 2).
 * Pair with `/api/platform-admin/walkthroughs/anchor-registry*`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkWalkthroughAnchorCommand,
  CreateManualWalkthroughAnchorCommand,
  UpdateWalkthroughAnchorCommand,
  UpdateWalkthroughAnchorMissingStateCommand,
  WalkthroughAnchorModuleCoverage,
  WalkthroughAnchorRegistryListPage,
  WalkthroughAnchorRegistryListQuery,
  WalkthroughAnchorRegistryRecord,
  WalkthroughAnchorSyncResult,
} from '../../shared/types/walkthroughAnchorRegistry';

export const anchorRegistryQueryKeys = {
  all: ['platform-admin', 'walkthroughs', 'anchor-registry'] as const,
  list: (params?: WalkthroughAnchorRegistryListQuery) =>
    [...anchorRegistryQueryKeys.all, 'list', params] as const,
  moduleCoverage: [
    'platform-admin',
    'walkthroughs',
    'anchor-registry',
    'module-coverage',
  ] as const,
  detail: (id: string | null) => [...anchorRegistryQueryKeys.all, 'detail', id] as const,
  byKey: (anchorKey: string | null) =>
    [...anchorRegistryQueryKeys.all, 'by-key', anchorKey] as const,
  byTestId: (testId: string | null) =>
    [...anchorRegistryQueryKeys.all, 'by-test-id', testId] as const,
};

async function registryFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message =
      (body as { error?: string }).error ??
      (body as { message?: string }).message ??
      `HTTP ${res.status}`;
    const err = new Error(message) as Error & { code?: string; details?: unknown; status?: number };
    err.code = (body as { code?: string }).code;
    err.details = (body as { details?: unknown }).details;
    err.status = res.status;
    throw err;
  }
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function buildListUrl(params: WalkthroughAnchorRegistryListQuery = {}): string {
  const search = new URLSearchParams();
  if (params.search) search.set('search', params.search);
  if (params.approvedRoute) search.set('approvedRoute', params.approvedRoute);
  if (params.reviewStatus != null) {
    search.set(
      'reviewStatus',
      Array.isArray(params.reviewStatus) ? params.reviewStatus.join(',') : params.reviewStatus,
    );
  }
  if (params.sourceKind != null) {
    search.set(
      'sourceKind',
      Array.isArray(params.sourceKind) ? params.sourceKind.join(',') : params.sourceKind,
    );
  }
  if (params.isActive != null) search.set('isActive', String(params.isActive));
  if (params.missingOnly != null) search.set('missingOnly', String(params.missingOnly));
  if (params.includeDeleted) search.set('includeDeleted', 'true');
  if (params.smartTags?.length) search.set('smartTags', params.smartTags.join(','));
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return `/api/platform-admin/walkthroughs/anchor-registry${qs ? `?${qs}` : ''}`;
}

export function useAnchorRegistryCatalog(
  params: WalkthroughAnchorRegistryListQuery = {},
  options?: { enabled?: boolean },
) {
  return useQuery<WalkthroughAnchorRegistryListPage>({
    queryKey: anchorRegistryQueryKeys.list(params),
    queryFn: () => registryFetch<WalkthroughAnchorRegistryListPage>(buildListUrl(params)),
    staleTime: 15_000,
    enabled: options?.enabled ?? true,
  });
}

export function useAnchorRegistryModuleCoverage(options?: { enabled?: boolean }) {
  return useQuery<WalkthroughAnchorModuleCoverage>({
    queryKey: anchorRegistryQueryKeys.moduleCoverage,
    queryFn: () =>
      registryFetch<WalkthroughAnchorModuleCoverage>(
        '/api/platform-admin/walkthroughs/anchor-registry/module-coverage',
      ),
    staleTime: 15_000,
    enabled: options?.enabled ?? true,
  });
}

export function useAnchorRegistryDetail(id: string | null) {
  return useQuery<WalkthroughAnchorRegistryRecord>({
    queryKey: anchorRegistryQueryKeys.detail(id),
    queryFn: () =>
      registryFetch<WalkthroughAnchorRegistryRecord>(
        `/api/platform-admin/walkthroughs/anchor-registry/${encodeURIComponent(id!)}`,
      ),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useAnchorRegistryByKey(anchorKey: string | null) {
  return useQuery<WalkthroughAnchorRegistryRecord>({
    queryKey: anchorRegistryQueryKeys.byKey(anchorKey),
    queryFn: () =>
      registryFetch<WalkthroughAnchorRegistryRecord>(
        `/api/platform-admin/walkthroughs/anchor-registry/by-key/${encodeURIComponent(anchorKey!)}`,
      ),
    enabled: !!anchorKey,
    staleTime: 15_000,
  });
}

export function useAnchorRegistryByTestId(testId: string | null) {
  return useQuery<WalkthroughAnchorRegistryRecord>({
    queryKey: anchorRegistryQueryKeys.byTestId(testId),
    queryFn: () =>
      registryFetch<WalkthroughAnchorRegistryRecord>(
        `/api/platform-admin/walkthroughs/anchor-registry/by-test-id/${encodeURIComponent(testId!)}`,
      ),
    enabled: !!testId,
    staleTime: 15_000,
  });
}

function invalidateCatalog(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: anchorRegistryQueryKeys.all });
}

export function useCreateManualAnchor() {
  const queryClient = useQueryClient();
  return useMutation<WalkthroughAnchorRegistryRecord, Error, CreateManualWalkthroughAnchorCommand>({
    mutationFn: (body) =>
      registryFetch<WalkthroughAnchorRegistryRecord>(
        '/api/platform-admin/walkthroughs/anchor-registry',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

export function useUpdateAnchorRegistry() {
  const queryClient = useQueryClient();
  return useMutation<
    WalkthroughAnchorRegistryRecord,
    Error,
    { id: string } & UpdateWalkthroughAnchorCommand
  >({
    mutationFn: ({ id, ...body }) =>
      registryFetch<WalkthroughAnchorRegistryRecord>(
        `/api/platform-admin/walkthroughs/anchor-registry/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (data) => {
      invalidateCatalog(queryClient);
      queryClient.setQueryData(anchorRegistryQueryKeys.detail(data.id), data);
    },
  });
}

export function useBulkUpdateAnchors() {
  const queryClient = useQueryClient();
  return useMutation<
    { items: WalkthroughAnchorRegistryRecord[] },
    Error,
    BulkWalkthroughAnchorCommand
  >({
    mutationFn: (body) =>
      registryFetch<{ items: WalkthroughAnchorRegistryRecord[] }>(
        '/api/platform-admin/walkthroughs/anchor-registry/bulk',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

export function useUpdateAnchorMissingState() {
  const queryClient = useQueryClient();
  return useMutation<
    { items: WalkthroughAnchorRegistryRecord[] },
    Error,
    UpdateWalkthroughAnchorMissingStateCommand
  >({
    mutationFn: (body) =>
      registryFetch<{ items: WalkthroughAnchorRegistryRecord[] }>(
        '/api/platform-admin/walkthroughs/anchor-registry/missing',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

export function useSoftDeleteAnchor() {
  const queryClient = useQueryClient();
  return useMutation<WalkthroughAnchorRegistryRecord, Error, { id: string }>({
    mutationFn: ({ id }) =>
      registryFetch<WalkthroughAnchorRegistryRecord>(
        `/api/platform-admin/walkthroughs/anchor-registry/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

/**
 * Track A sync response + optional legacy `candidates` alias used by early UI stubs.
 * Review modal rows come from `persistence.created` (full registry records).
 * Discovery-only `newCandidates` lack editable catalog fields (id/label/tags).
 */
export type WalkthroughAnchorRegistrySyncResult = WalkthroughAnchorSyncResult & {
  /** @deprecated Prefer persistence.created */
  candidates?: WalkthroughAnchorRegistryRecord[];
};

function isRegistryRecord(row: unknown): row is WalkthroughAnchorRegistryRecord {
  return row != null && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string';
}

/** Normalize sync payload → editable rows for WalkthroughAnchorSyncReviewModal. */
export function resolveSyncReviewCandidates(
  result: WalkthroughAnchorRegistrySyncResult | null | undefined,
): WalkthroughAnchorRegistryRecord[] {
  if (!result) return [];
  const review = result.persistence?.reviewCandidates;
  if (Array.isArray(review) && review.length > 0) {
    return review.filter(isRegistryRecord);
  }
  const created = result.persistence?.created;
  if (Array.isArray(created) && created.length > 0) {
    return created.filter(isRegistryRecord);
  }
  if (Array.isArray(result.candidates) && result.candidates.length > 0) {
    return result.candidates.filter(isRegistryRecord);
  }
  // Defensive: only accept newCandidates entries that already look like catalog rows.
  if (Array.isArray(result.newCandidates) && result.newCandidates.length > 0) {
    return (result.newCandidates as readonly unknown[]).filter(isRegistryRecord);
  }
  return [];
}

export interface WalkthroughAnchorSmartTaggingCandidateInput {
  testId: string;
  sourceLocations?: Array<{ filePath: string; line?: number | null }>;
  sourceKind?: string | null;
}

export interface WalkthroughAnchorSmartTaggingStartResponse {
  threadId: string;
  candidateTestIds: string[];
}

export type WalkthroughAnchorSmartTaggingStatus =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface WalkthroughAnchorSmartTaggingStatusResponse {
  status: WalkthroughAnchorSmartTaggingStatus;
  updated?: WalkthroughAnchorRegistryRecord[];
  warning?: string;
  error?: string;
}

/**
 * Build smart-tagging start payload from sync persistence IDs + created/review rows.
 * Returns [] when there is nothing new to tag.
 * Caps batch size so one Cursor run can finish (large first-time syncs can discover
 * hundreds of anchors; AI tagging of all of them never completes).
 */
export const SMART_TAGGING_CANDIDATE_BATCH_MAX = 20;

export function buildSmartTaggingCandidatesFromSync(
  result: WalkthroughAnchorRegistrySyncResult | null | undefined,
): WalkthroughAnchorSmartTaggingCandidateInput[] {
  if (!result?.persistence) return [];
  const ids = new Set(result.persistence.newCandidateIdsForSmartTagging ?? []);
  if (ids.size === 0) return [];
  const pool = [
    ...(result.persistence.reviewCandidates ?? []),
    ...(result.persistence.created ?? []),
  ];
  const seen = new Set<string>();
  const matched: WalkthroughAnchorSmartTaggingCandidateInput[] = [];
  for (const row of pool) {
    if (!ids.has(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    matched.push({
      testId: row.testId,
      sourceKind: row.sourceKind,
      sourceLocations: row.sourceLocations?.map((loc) => ({
        filePath: loc.filePath,
        line: loc.line ?? null,
      })),
    });
    if (matched.length >= SMART_TAGGING_CANDIDATE_BATCH_MAX) break;
  }
  return matched;
}

const SMART_TAGGING_POLL_MS = 2000;
/** ~10 minutes — Cursor agent runs for a 20-anchor batch often exceed the old ~2 min window. */
const SMART_TAGGING_POLL_MAX_ATTEMPTS = 300;

/**
 * Start smart-tagging and poll until terminal. Never throws for empty input.
 * Callers should treat failures as non-blocking for the Sync review modal.
 * Optional skillPath / model come from Platform Admin → Walkthroughs → Options.
 */
export async function startAndPollAnchorSmartTagging(
  result: WalkthroughAnchorRegistrySyncResult,
  options?: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    maxAttempts?: number;
    /** Override Cursor model (empty or omitted uses server default). */
    model?: string;
    /** Override skill markdown path under .cursor/skills (omitted uses server default). */
    skillPath?: string;
    onProgress?: (info: {
      attempt: number;
      maxAttempts: number;
      elapsedMs: number;
      threadId: string;
    }) => void;
  },
): Promise<WalkthroughAnchorSmartTaggingStatusResponse | null> {
  const candidates = buildSmartTaggingCandidatesFromSync(result);
  if (candidates.length === 0) return null;

  const model = options?.model?.trim();
  const skillPath = options?.skillPath?.trim();

  const started = await registryFetch<WalkthroughAnchorSmartTaggingStartResponse>(
    '/api/platform-admin/walkthroughs/anchor-registry/smart-tagging/start',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidates,
        ...(model ? { model } : {}),
        ...(skillPath ? { skillPath } : {}),
      }),
      signal: options?.signal,
    },
  );

  const interval = options?.pollIntervalMs ?? SMART_TAGGING_POLL_MS;
  const maxAttempts = options?.maxAttempts ?? SMART_TAGGING_POLL_MAX_ATTEMPTS;
  const startedAt = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    options?.onProgress?.({
      attempt: attempt + 1,
      maxAttempts,
      elapsedMs: Date.now() - startedAt,
      threadId: started.threadId,
    });
    const status = await registryFetch<WalkthroughAnchorSmartTaggingStatusResponse>(
      `/api/platform-admin/walkthroughs/anchor-registry/smart-tagging/status/${encodeURIComponent(started.threadId)}`,
      { signal: options?.signal },
    );
    if (status.status !== 'pending') {
      return status;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => resolve(), interval);
      options?.signal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }

  const waitedMin = Math.round((Date.now() - startedAt) / 60_000);
  return {
    status: 'failed',
    error: 'Smart-tagging timed out',
    warning: `AI smart-tagging still running after ~${waitedMin} min (client stopped waiting). Tags may appear if you Sync again once the agent finishes. You can edit and Save now.`,
  };
}

/** Merge AI-updated catalog rows into the open Sync review candidate list by id. */
export function mergeSmartTaggedSyncCandidates(
  current: readonly WalkthroughAnchorRegistryRecord[],
  updated: readonly WalkthroughAnchorRegistryRecord[] | undefined,
): WalkthroughAnchorRegistryRecord[] {
  if (!updated?.length) return [...current];
  const byId = new Map(updated.map((row) => [row.id, row]));
  return current.map((row) => byId.get(row.id) ?? row);
}

/**
 * POST /api/platform-admin/walkthroughs/anchor-registry/sync
 * Returns Track A WalkthroughAnchorSyncResult (extraction + persistence).
 */
export function useSyncAnchorRegistry() {
  return useMutation<WalkthroughAnchorRegistrySyncResult, Error, void>({
    mutationFn: () =>
      registryFetch<WalkthroughAnchorRegistrySyncResult>(
        '/api/platform-admin/walkthroughs/anchor-registry/sync',
        { method: 'POST' },
      ),
    // Catalog refreshes after Sync review modal save (update/bulk mutations), not on scan.
  });
}
