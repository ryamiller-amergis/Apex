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

/** Minimal draft shape for Sync review Save (avoids importing the modal). */
export interface AnchorSyncReviewPersistDraft {
  id: string;
  label: string;
  suggestedRoute: string | null;
  approvedRoute: string | null;
  allowedPlacements: WalkthroughAnchorRegistryRecord['allowedPlacements'];
  smartTags: readonly string[];
  sourceLocations: WalkthroughAnchorRegistryRecord['sourceLocations'];
  reviewStatus: WalkthroughAnchorRegistryRecord['reviewStatus'];
  isActive: boolean;
}

function syncReviewFieldsDiffer(
  draft: AnchorSyncReviewPersistDraft,
  original: WalkthroughAnchorRegistryRecord | undefined,
): boolean {
  if (!original) return true;
  const draftPaths = draft.sourceLocations.map((l) => l.filePath).join('\n');
  const originalPaths = original.sourceLocations.map((l) => l.filePath).join('\n');
  const draftPlacements = [...draft.allowedPlacements].sort().join(',');
  const originalPlacements = [...original.allowedPlacements].sort().join(',');
  const draftTags = [...draft.smartTags].sort().join(',');
  const originalTags = [...original.smartTags].sort().join(',');
  return (
    draft.label !== original.label ||
    (draft.suggestedRoute ?? null) !== (original.suggestedRoute ?? null) ||
    draftTags !== originalTags ||
    draftPlacements !== originalPlacements ||
    draftPaths !== originalPaths
  );
}

/**
 * Persist Sync review decisions without re-running Sync/scanner.
 * Field PATCHes run in parallel (skipped when unchanged vs originals), then bulk
 * approve/reject/activate. Callers should invalidate the catalog once afterward
 * (usePersistAnchorSyncReviewDrafts does this).
 */
export async function persistAnchorSyncReviewDrafts(
  drafts: readonly AnchorSyncReviewPersistDraft[],
  options?: { originals?: readonly WalkthroughAnchorRegistryRecord[] },
): Promise<void> {
  if (drafts.length === 0) return;

  const originalsById = new Map((options?.originals ?? []).map((row) => [row.id, row]));
  const fieldPatches = drafts.filter((d) => syncReviewFieldsDiffer(d, originalsById.get(d.id)));

  await Promise.all(
    fieldPatches.map((draft) => {
      const approvedRoute =
        draft.approvedRoute ??
        (draft.reviewStatus === 'approved' ? draft.suggestedRoute : null);
      return registryFetch<WalkthroughAnchorRegistryRecord>(
        `/api/platform-admin/walkthroughs/anchor-registry/${encodeURIComponent(draft.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: draft.label,
            suggestedRoute: draft.suggestedRoute,
            approvedRoute,
            allowedPlacements: draft.allowedPlacements,
            smartTags: draft.smartTags,
            sourceLocations: draft.sourceLocations,
          } satisfies UpdateWalkthroughAnchorCommand),
        },
      );
    }),
  );

  const approvedIds = drafts.filter((d) => d.reviewStatus === 'approved').map((d) => d.id);
  const rejectedIds = drafts.filter((d) => d.reviewStatus === 'rejected').map((d) => d.id);
  const activateIds = drafts
    .filter((d) => d.reviewStatus === 'approved' && d.isActive)
    .map((d) => d.id);

  const runBulk = async (ids: string[], action: BulkWalkthroughAnchorCommand['action']) => {
    if (ids.length === 0) return;
    await registryFetch<{ items: WalkthroughAnchorRegistryRecord[] }>(
      '/api/platform-admin/walkthroughs/anchor-registry/bulk',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action } satisfies BulkWalkthroughAnchorCommand),
      },
    );
  };

  await runBulk(approvedIds, 'approve');
  await runBulk(rejectedIds, 'reject');
  await runBulk(activateIds, 'activate');
}

/** Sync review Save — one mutation, one catalog invalidation (no Sync/scan). */
export function usePersistAnchorSyncReviewDrafts() {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    {
      drafts: readonly AnchorSyncReviewPersistDraft[];
      originals?: readonly WalkthroughAnchorRegistryRecord[];
    }
  >({
    mutationFn: ({ drafts, originals }) =>
      persistAnchorSyncReviewDrafts(drafts, { originals }),
    onSuccess: () => invalidateCatalog(queryClient),
  });
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
export const SMART_TAGGING_CANDIDATE_BATCH_MAX = 50;
export const SMART_TAGGING_BATCH_SIZE_OPTIONS = [10, 20, 50] as const;
export type SmartTaggingBatchSize = (typeof SMART_TAGGING_BATCH_SIZE_OPTIONS)[number];
export const SMART_TAGGING_BATCH_SIZE_DEFAULT: SmartTaggingBatchSize = 20;

export function clampSmartTaggingBatchSize(value: number | undefined): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : SMART_TAGGING_BATCH_SIZE_DEFAULT;
  if (SMART_TAGGING_BATCH_SIZE_OPTIONS.includes(n as SmartTaggingBatchSize)) return n;
  return Math.min(SMART_TAGGING_CANDIDATE_BATCH_MAX, Math.max(1, n));
}

/** True when a catalog row already carries real AI smart-tag metadata. */
export function hasRealAiProvenance(row: {
  smartTags?: readonly string[] | null;
  aiProvenance?: WalkthroughAnchorRegistryRecord['aiProvenance'];
}): boolean {
  const model = row.aiProvenance?.model?.trim();
  if (!model || model === 'sync-heuristic') return false;
  const tags = row.smartTags ?? [];
  return tags.length > 0 || !!row.aiProvenance?.rationale?.trim();
}

export function buildSmartTaggingCandidatesFromSync(
  result: WalkthroughAnchorRegistrySyncResult | null | undefined,
  options?: {
    batchSize?: number;
    /** Skip rows already AI-enriched in the open review list. */
    excludeIds?: ReadonlySet<string> | readonly string[];
  },
): WalkthroughAnchorSmartTaggingCandidateInput[] {
  if (!result?.persistence) return [];
  const ids = new Set(result.persistence.newCandidateIdsForSmartTagging ?? []);
  if (ids.size === 0) return [];
  const exclude = options?.excludeIds
    ? options.excludeIds instanceof Set
      ? options.excludeIds
      : new Set(options.excludeIds)
    : null;
  const batchSize = clampSmartTaggingBatchSize(options?.batchSize);
  const pool = [
    ...(result.persistence.reviewCandidates ?? []),
    ...(result.persistence.created ?? []),
  ];
  const seen = new Set<string>();
  const matched: WalkthroughAnchorSmartTaggingCandidateInput[] = [];
  for (const row of pool) {
    if (!ids.has(row.id) || seen.has(row.id)) continue;
    if (exclude?.has(row.id)) continue;
    seen.add(row.id);
    matched.push({
      testId: row.testId,
      sourceKind: row.sourceKind,
      sourceLocations: row.sourceLocations?.map((loc) => ({
        filePath: loc.filePath,
        line: loc.line ?? null,
      })),
    });
    if (matched.length >= batchSize) break;
  }
  return matched;
}

const SMART_TAGGING_POLL_MS = 2000;
/**
 * Floor of ~10 minutes so small batches keep the previous window. Cursor agent
 * runtime scales with the number of anchors, so a fixed 10-min cap caused large
 * batches (e.g. 50) to "time out" on the client while the server agent was still
 * running. The real budget is derived per-run from the candidate count below.
 */
const SMART_TAGGING_POLL_MIN_ATTEMPTS = 300;
/**
 * ~36s of budget per anchor (18 polls × 2s). A 50-anchor batch therefore waits
 * up to ~30 min instead of the old flat ~10 min, which is enough headroom for
 * the agent to finish on the smaller App Service SKUs used in dev/prod-staging.
 */
const SMART_TAGGING_POLL_ATTEMPTS_PER_CANDIDATE = 18;

/** Poll attempts to allow for a run of `candidateCount` anchors. */
export function resolveSmartTaggingPollMaxAttempts(candidateCount: number): number {
  const scaled = Math.ceil(candidateCount) * SMART_TAGGING_POLL_ATTEMPTS_PER_CANDIDATE;
  return Math.max(SMART_TAGGING_POLL_MIN_ATTEMPTS, scaled);
}

/**
 * Anchors tagged per Cursor run when fanning out a large batch. Small runs are
 * the reliable unit — the 10-anchor batch consistently finishes and rarely
 * produces partial/garbled output — so we split big batches into chunks of this
 * size and run them as independent threads (each has its own isolated workspace
 * server-side, so unique candidate ids never collide across chunks).
 */
export const SMART_TAGGING_CHUNK_SIZE = 10;
/**
 * Max chunks the client runs at once. Mirrors the server's default
 * MAX_CONCURRENT_LOCAL_AGENTS (2) — firing more just queues server-side and, if
 * the server cap were raised, risks the App Service RAM/EPIPE crashes the cap
 * exists to prevent. Extra chunks beyond this are started as slots free up.
 */
export const SMART_TAGGING_MAX_PARALLEL_CHUNKS = 2;

/** Split candidates into fixed-size chunks (last chunk may be smaller). */
export function chunkSmartTaggingCandidates<T>(items: readonly T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/** Progress emitted while a chunked smart-tagging run is in flight. */
export interface ChunkedSmartTaggingProgress {
  elapsedMs: number;
  totalChunks: number;
  completedChunks: number;
  runningChunks: number;
  /** Distinct anchors tagged so far across finished chunks. */
  updatedCount: number;
}

/**
 * Start smart-tagging for an explicit candidate set and poll until terminal.
 * Low-level primitive: one Cursor thread per call. Throws on abort.
 */
async function startAndPollSmartTaggingCandidates(
  candidates: readonly WalkthroughAnchorSmartTaggingCandidateInput[],
  options?: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    maxAttempts?: number;
    model?: string;
    skillPath?: string;
    onProgress?: (info: {
      attempt: number;
      maxAttempts: number;
      elapsedMs: number;
      threadId: string;
    }) => void;
  },
): Promise<WalkthroughAnchorSmartTaggingStatusResponse> {
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
  const maxAttempts =
    options?.maxAttempts ?? resolveSmartTaggingPollMaxAttempts(candidates.length);
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
    warning: `An AI batch is still running server-side after ~${waitedMin} min (client stopped waiting). The agent keeps working, so tags may appear if you Sync again once it finishes. You can edit and Save now.`,
  };
}

/**
 * Combine per-chunk statuses into a single response. Partial success still
 * returns 'ready' with the merged rows plus a warning naming the shortfall, so
 * the UI applies what finished instead of discarding it.
 */
function aggregateChunkedSmartTaggingStatuses(
  statuses: readonly WalkthroughAnchorSmartTaggingStatusResponse[],
  mergedUpdated: WalkthroughAnchorRegistryRecord[],
): WalkthroughAnchorSmartTaggingStatusResponse {
  const settled = statuses.filter(Boolean);
  const failed = settled.filter((s) => s.status !== 'ready');

  if (failed.length === 0) {
    return { status: 'ready', updated: mergedUpdated };
  }

  const readyCount = settled.length - failed.length;
  if (readyCount === 0) {
    const firstError = failed.find((s) => s.error)?.error;
    return {
      status: 'failed',
      error: firstError ?? 'Smart-tagging did not complete for any batch.',
      warning: `All ${failed.length} AI batch(es) failed. Newly discovered anchors remain pending and reviewable — try Sync again or edit manually.`,
      updated: mergedUpdated,
    };
  }

  return {
    status: 'ready',
    updated: mergedUpdated,
    warning: `${failed.length} of ${settled.length} AI batch(es) did not finish; ${mergedUpdated.length} anchor(s) tagged. Use “Tag next AI batch” to retry the rest.`,
  };
}

/**
 * Start smart-tagging and poll until terminal. Never throws for empty input.
 * Callers should treat failures as non-blocking for the Sync review modal.
 * Optional skillPath / model come from Platform Admin → Walkthroughs → Options.
 *
 * Single-thread variant (one Cursor run for the whole batch). For large batches
 * prefer runChunkedAnchorSmartTagging, which fans out into smaller reliable runs.
 */
export async function startAndPollAnchorSmartTagging(
  result: WalkthroughAnchorRegistrySyncResult,
  options?: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    maxAttempts?: number;
    batchSize?: number;
    excludeIds?: ReadonlySet<string> | readonly string[];
    /** Override Cursor model (empty or omitted uses server default). */
    model?: string;
    /** Override SKILL.md under a supported Agent Skills root. */
    skillPath?: string;
    onProgress?: (info: {
      attempt: number;
      maxAttempts: number;
      elapsedMs: number;
      threadId: string;
    }) => void;
  },
): Promise<WalkthroughAnchorSmartTaggingStatusResponse | null> {
  const candidates = buildSmartTaggingCandidatesFromSync(result, {
    batchSize: options?.batchSize,
    excludeIds: options?.excludeIds,
  });
  if (candidates.length === 0) return null;

  return startAndPollSmartTaggingCandidates(candidates, {
    signal: options?.signal,
    pollIntervalMs: options?.pollIntervalMs,
    maxAttempts: options?.maxAttempts,
    model: options?.model,
    skillPath: options?.skillPath,
    onProgress: options?.onProgress,
  });
}

/**
 * Chunked smart-tagging: split the batch into SMART_TAGGING_CHUNK_SIZE-anchor
 * runs and execute up to SMART_TAGGING_MAX_PARALLEL_CHUNKS at once (extra chunks
 * start as earlier ones finish). Resolves only after every chunk is terminal,
 * with all AI-updated rows merged by id. Never throws for empty input; aborts
 * propagate as AbortError.
 */
export async function runChunkedAnchorSmartTagging(
  result: WalkthroughAnchorRegistrySyncResult,
  options?: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    batchSize?: number;
    excludeIds?: ReadonlySet<string> | readonly string[];
    chunkSize?: number;
    maxParallelChunks?: number;
    model?: string;
    skillPath?: string;
    onProgress?: (info: ChunkedSmartTaggingProgress) => void;
  },
): Promise<WalkthroughAnchorSmartTaggingStatusResponse | null> {
  const candidates = buildSmartTaggingCandidatesFromSync(result, {
    batchSize: options?.batchSize,
    excludeIds: options?.excludeIds,
  });
  if (candidates.length === 0) return null;

  const chunks = chunkSmartTaggingCandidates(
    candidates,
    options?.chunkSize ?? SMART_TAGGING_CHUNK_SIZE,
  );

  const startedAt = Date.now();
  const totalChunks = chunks.length;
  const mergedUpdatedById = new Map<string, WalkthroughAnchorRegistryRecord>();
  const statuses = new Array<WalkthroughAnchorSmartTaggingStatusResponse>(totalChunks);
  let completedChunks = 0;
  let runningChunks = 0;

  const emitProgress = () => {
    options?.onProgress?.({
      elapsedMs: Date.now() - startedAt,
      totalChunks,
      completedChunks,
      runningChunks,
      updatedCount: mergedUpdatedById.size,
    });
  };
  emitProgress();

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= chunks.length) return;

      runningChunks += 1;
      emitProgress();
      try {
        const status = await startAndPollSmartTaggingCandidates(chunks[index], {
          signal: options?.signal,
          pollIntervalMs: options?.pollIntervalMs,
          model: options?.model,
          skillPath: options?.skillPath,
        });
        statuses[index] = status;
        if (status.status === 'ready' && status.updated) {
          for (const row of status.updated) mergedUpdatedById.set(row.id, row);
        }
      } finally {
        runningChunks -= 1;
        completedChunks += 1;
        emitProgress();
      }
    }
  };

  const parallelism = Math.min(
    Math.max(1, options?.maxParallelChunks ?? SMART_TAGGING_MAX_PARALLEL_CHUNKS),
    chunks.length,
  );
  await Promise.all(Array.from({ length: parallelism }, () => worker()));

  return aggregateChunkedSmartTaggingStatuses(
    statuses,
    Array.from(mergedUpdatedById.values()),
  );
}

/**
 * Merge AI-updated catalog rows into the open Sync review list by id.
 * Never overwrites rows that already have real AI provenance in the open list.
 */
export function mergeSmartTaggedSyncCandidates(
  current: readonly WalkthroughAnchorRegistryRecord[],
  updated: readonly WalkthroughAnchorRegistryRecord[] | undefined,
): WalkthroughAnchorRegistryRecord[] {
  if (!updated?.length) return [...current];
  const byId = new Map(updated.map((row) => [row.id, row]));
  return current.map((row) => {
    const next = byId.get(row.id);
    if (!next) return row;
    if (hasRealAiProvenance(row)) return row;
    return next;
  });
}

/**
 * Merge a fresh Sync candidate list into an open review list without wiping
 * unsaved AI-completed rows. Appends newly discovered ids; skips AI overwrite
 * when the open row already has real AI provenance.
 */
export function mergeOpenSyncCandidates(
  current: readonly WalkthroughAnchorRegistryRecord[],
  incoming: readonly WalkthroughAnchorRegistryRecord[],
): WalkthroughAnchorRegistryRecord[] {
  if (incoming.length === 0) return [...current];
  const currentById = new Map(current.map((row) => [row.id, row]));
  const result: WalkthroughAnchorRegistryRecord[] = current.map((row) => {
    const next = incoming.find((r) => r.id === row.id);
    if (!next) return row;
    if (hasRealAiProvenance(row)) return row;
    return next;
  });
  for (const row of incoming) {
    if (currentById.has(row.id)) continue;
    result.push(row);
  }
  return result;
}

/** Ids of open rows that already have real AI metadata (exclude from next AI batch). */
export function idsWithRealAiProvenance(
  rows: readonly WalkthroughAnchorRegistryRecord[],
): string[] {
  return rows.filter(hasRealAiProvenance).map((r) => r.id);
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
