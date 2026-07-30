import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  buildSmartTaggingCandidatesFromSync,
  mergeSmartTaggedSyncCandidates,
  resolveSyncReviewCandidates,
  useAnchorRegistryCatalog,
  useAnchorRegistryModuleCoverage,
  useBulkUpdateAnchors,
  useCreateManualAnchor,
  useSyncAnchorRegistry,
} from '../usePlatformAdminAnchorRegistry';
import type { WalkthroughAnchorRegistryRecord } from '../../../shared/types/walkthroughAnchorRegistry';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function mockFetchOk(data: unknown, status = 200) {
  const body = status === 204 ? '' : JSON.stringify(data);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

function makeRecord(
  overrides: Partial<WalkthroughAnchorRegistryRecord> & Pick<WalkthroughAnchorRegistryRecord, 'id'>,
): WalkthroughAnchorRegistryRecord {
  return {
    anchorKey: overrides.anchorKey ?? overrides.id,
    testId: overrides.testId ?? overrides.id,
    label: overrides.label ?? overrides.id,
    suggestedRoute: null,
    approvedRoute: null,
    allowedPlacements: ['bottom'],
    smartTags: [],
    sourceKind: 'data_testid',
    sourceLocations: [{ filePath: 'src/client/components/X.tsx', line: 1 }],
    sourceHash: 'hash',
    reviewStatus: 'pending',
    isActive: false,
    lastSeenAt: null,
    missingSince: null,
    deletedAt: null,
    aiProvenance: null,
    createdBy: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'test',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('usePlatformAdminAnchorRegistry', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches catalog with filters', async () => {
    mockFetchOk({
      items: [],
      nextCursor: null,
      counts: { total: 0, pending: 0, approved: 0, rejected: 0, active: 0, missing: 0 },
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useAnchorRegistryCatalog({ search: 'profile', reviewStatus: 'pending' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/walkthroughs/anchor-registry?search=profile&reviewStatus=pending',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('fetches module coverage summary', async () => {
    mockFetchOk({
      totalModules: 16,
      coveredCount: 9,
      uncoveredCount: 7,
      coveredModules: [],
      uncoveredModules: [],
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAnchorRegistryModuleCoverage(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/walkthroughs/anchor-registry/module-coverage',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('posts manual create and bulk actions', async () => {
    mockFetchOk({ id: 'a1', anchorKey: 'x' }, 201);
    const { wrapper } = createWrapper();
    const { result: createResult } = renderHook(() => useCreateManualAnchor(), { wrapper });
    await createResult.current.mutateAsync({
      anchorKey: 'x',
      testId: 'x',
      label: 'X',
      allowedPlacements: ['bottom'],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/walkthroughs/anchor-registry',
      expect.objectContaining({ method: 'POST' }),
    );

    mockFetchOk({ items: [{ id: 'a1', reviewStatus: 'approved' }] });
    const { result: bulkResult } = renderHook(() => useBulkUpdateAnchors(), { wrapper });
    await bulkResult.current.mutateAsync({ ids: ['a1'], action: 'approve' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/walkthroughs/anchor-registry/bulk',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('posts sync and resolves review candidates from persistence.created', async () => {
    const created = makeRecord({ id: 'c1', anchorKey: 'bell', testId: 'notification-bell' });
    mockFetchOk({
      discoveries: [],
      newCandidates: [
        {
          testId: 'notification-bell',
          suggestedAnchorKey: 'notification-bell',
          sourceKind: 'data_testid',
          sourceLocations: [],
          sourceHash: 'h',
          proposedReviewStatus: 'pending',
          proposedIsActive: false,
        },
      ],
      existingMatches: [],
      missingWarnings: [],
      duplicates: [],
      unsupportedDynamicPatterns: [],
      diagnostics: {
        provider: 'local',
        rootPath: '.',
        filesScanned: 1,
        filesSkipped: 0,
        bytesRead: 10,
        durationMs: 1,
        truncatedFiles: [],
        errors: [],
      },
      persistence: {
        created: [created],
        refreshed: [],
        markedMissing: [],
        reviewCandidates: [created],
        newCandidateIdsForSmartTagging: ['c1'],
      },
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSyncAnchorRegistry(), { wrapper });
    const data = await result.current.mutateAsync();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/walkthroughs/anchor-registry/sync',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(resolveSyncReviewCandidates(data)).toEqual([
      expect.objectContaining({ id: 'c1', testId: 'notification-bell' }),
    ]);
    // Discovery-only newCandidates must not be treated as editable review rows.
    expect(
      resolveSyncReviewCandidates({
        ...data,
        persistence: {
          created: [],
          refreshed: [],
          markedMissing: [],
          reviewCandidates: [],
          newCandidateIdsForSmartTagging: [],
        },
      }),
    ).toEqual([]);
    // Legacy candidates alias still works.
    expect(
      resolveSyncReviewCandidates({
        candidates: [makeRecord({ id: 'legacy-1' })],
      } as never),
    ).toEqual([expect.objectContaining({ id: 'legacy-1' })]);
  });

  it('builds smart-tagging candidates from newCandidateIdsForSmartTagging', () => {
    const created = [
      makeRecord({ id: 'n1', testId: 'a', sourceKind: 'explicit' }),
      makeRecord({ id: 'n2', testId: 'b', sourceKind: 'data_testid' }),
    ];
    const inputs = buildSmartTaggingCandidatesFromSync({
      discoveries: [],
      newCandidates: [],
      existingMatches: [],
      missingWarnings: [],
      duplicates: [],
      unsupportedDynamicPatterns: [],
      diagnostics: {
        provider: 'local',
        rootPath: '.',
        filesScanned: 0,
        filesSkipped: 0,
        bytesRead: 0,
        durationMs: 0,
        truncatedFiles: [],
        errors: [],
      },
      persistence: {
        created,
        refreshed: [],
        markedMissing: [],
        reviewCandidates: created,
        newCandidateIdsForSmartTagging: ['n2'],
      },
    });
    expect(inputs).toEqual([
      expect.objectContaining({ testId: 'b', sourceKind: 'data_testid' }),
    ]);
    expect(
      mergeSmartTaggedSyncCandidates(created, [
        makeRecord({ id: 'n2', testId: 'b', label: 'Tagged B', smartTags: ['nav'] }),
      ]),
    ).toEqual([
      expect.objectContaining({ id: 'n1' }),
      expect.objectContaining({ id: 'n2', label: 'Tagged B', smartTags: ['nav'] }),
    ]);
  });

  it('caps smart-tagging candidate batch size', () => {
    const created = Array.from({ length: 30 }, (_, i) =>
      makeRecord({ id: `id-${i}`, testId: `test-${i}` }),
    );
    const inputs = buildSmartTaggingCandidatesFromSync({
      discoveries: [],
      newCandidates: [],
      existingMatches: [],
      missingWarnings: [],
      duplicates: [],
      unsupportedDynamicPatterns: [],
      diagnostics: {
        provider: 'local',
        rootPath: '.',
        filesScanned: 0,
        filesSkipped: 0,
        bytesRead: 0,
        durationMs: 0,
        truncatedFiles: [],
        errors: [],
      },
      persistence: {
        created,
        refreshed: [],
        markedMissing: [],
        reviewCandidates: created,
        newCandidateIdsForSmartTagging: created.map((r) => r.id),
      },
    });
    expect(inputs).toHaveLength(20);
  });

  it('prefers reviewCandidates so re-sync pending rows open in the modal', () => {
    const pendingExisting = makeRecord({
      id: 'pending-1',
      testId: 'ado-create-error',
      reviewStatus: 'pending',
      smartTags: ['ado', 'create', 'modal'],
    });
    expect(
      resolveSyncReviewCandidates({
        discoveries: [],
        newCandidates: [],
        existingMatches: [],
        missingWarnings: [],
        duplicates: [],
        unsupportedDynamicPatterns: [],
        diagnostics: {
          provider: 'local',
          rootPath: '.',
          filesScanned: 0,
          filesSkipped: 0,
          bytesRead: 0,
          durationMs: 0,
          truncatedFiles: [],
          errors: [],
        },
        persistence: {
          created: [],
          refreshed: [pendingExisting],
          markedMissing: [],
          reviewCandidates: [pendingExisting],
          newCandidateIdsForSmartTagging: [],
        },
      }),
    ).toEqual([expect.objectContaining({ id: 'pending-1', testId: 'ado-create-error' })]);
  });
});
