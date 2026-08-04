import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  buildSmartTaggingCandidatesFromSync,
  chunkSmartTaggingCandidates,
  hasRealAiProvenance,
  mergeOpenSyncCandidates,
  mergeSmartTaggedSyncCandidates,
  persistAnchorSyncReviewDrafts,
  resolveSmartTaggingPollMaxAttempts,
  resolveSyncReviewCandidates,
  runChunkedAnchorSmartTagging,
  startAndPollAnchorSmartTagging,
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
    openerAnchorKeys: [],
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

const emptySyncDiagnostics = {
  provider: 'local' as const,
  rootPath: '.',
  filesScanned: 0,
  filesSkipped: 0,
  bytesRead: 0,
  durationMs: 0,
  truncatedFiles: [] as string[],
  errors: [] as Array<{ filePath: string; message: string }>,
  branch: null as string | null,
  committedTruth: false,
};

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
        branch: null,
        committedTruth: false,
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
      diagnostics: emptySyncDiagnostics,
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
    const syncPayload = {
      discoveries: [],
      newCandidates: [],
      existingMatches: [],
      missingWarnings: [],
      duplicates: [],
      unsupportedDynamicPatterns: [],
      diagnostics: emptySyncDiagnostics,
      persistence: {
        created,
        refreshed: [],
        markedMissing: [],
        reviewCandidates: created,
        newCandidateIdsForSmartTagging: created.map((r) => r.id),
      },
    };
    expect(buildSmartTaggingCandidatesFromSync(syncPayload)).toHaveLength(20);
    expect(buildSmartTaggingCandidatesFromSync(syncPayload, { batchSize: 10 })).toHaveLength(10);
    expect(buildSmartTaggingCandidatesFromSync(syncPayload, { batchSize: 50 })).toHaveLength(30);
  });

  it('scales the smart-tagging poll window with the batch size', () => {
    // Small batches keep the ~10 min floor (300 polls x 2s).
    expect(resolveSmartTaggingPollMaxAttempts(10)).toBe(300);
    expect(resolveSmartTaggingPollMaxAttempts(20)).toBe(360);
    // A 50-anchor batch waits ~30 min instead of the old flat ~10 min, so the
    // client stops abandoning still-running server runs.
    expect(resolveSmartTaggingPollMaxAttempts(50)).toBe(900);
  });

  it('splits candidates into fixed-size chunks (last may be smaller)', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(chunkSmartTaggingCandidates(items, 10).map((c) => c.length)).toEqual([10, 10, 5]);
    expect(chunkSmartTaggingCandidates(items, 10)[2]).toEqual([20, 21, 22, 23, 24]);
    expect(chunkSmartTaggingCandidates([], 10)).toEqual([]);
    // Degenerate size falls back to 1-per-chunk rather than looping forever.
    expect(chunkSmartTaggingCandidates([1, 2], 0).map((c) => c.length)).toEqual([1, 1]);
  });

  describe('runChunkedAnchorSmartTagging', () => {
    const jsonResponse = (payload: unknown) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    });

    const buildSyncResult = (count: number) => {
      const created = Array.from({ length: count }, (_, i) =>
        makeRecord({ id: `id-${i}`, testId: `test-${i}` }),
      );
      return {
        discoveries: [],
        newCandidates: [],
        existingMatches: [],
        missingWarnings: [],
        duplicates: [],
        unsupportedDynamicPatterns: [],
        diagnostics: emptySyncDiagnostics,
        persistence: {
          created,
          refreshed: [],
          markedMissing: [],
          reviewCandidates: created,
          newCandidateIdsForSmartTagging: created.map((r) => r.id),
        },
      };
    };

    it('fans a large batch into chunks and merges every AI update', async () => {
      let threadSeq = 0;
      const startedCounts: number[] = [];
      const threadTestIds = new Map<string, string[]>();

      (global.fetch as jest.Mock) = jest.fn((url: string, init?: RequestInit) => {
        if (url.includes('/smart-tagging/start')) {
          const body = JSON.parse((init?.body as string) ?? '{}');
          const testIds = (body.candidates ?? []).map((c: { testId: string }) => c.testId);
          const threadId = `thread-${threadSeq++}`;
          threadTestIds.set(threadId, testIds);
          startedCounts.push(testIds.length);
          return Promise.resolve(
            jsonResponse({ threadId, provenance: { provider: 'cursor', model: 'm' }, candidateTestIds: testIds }),
          );
        }
        const threadId = decodeURIComponent(url.split('/status/')[1]);
        const testIds = threadTestIds.get(threadId) ?? [];
        return Promise.resolve(
          jsonResponse({
            status: 'ready',
            updated: testIds.map((t) => makeRecord({ id: `u-${t}`, testId: t, smartTags: ['x'] })),
          }),
        );
      });

      const status = await runChunkedAnchorSmartTagging(buildSyncResult(25), {
        batchSize: 50,
        chunkSize: 10,
        pollIntervalMs: 1,
      });

      // 25 candidates → chunks of 10 / 10 / 5, each its own /start thread.
      expect([...startedCounts].sort((a, b) => b - a)).toEqual([10, 10, 5]);
      expect(status?.status).toBe('ready');
      expect(status?.updated).toHaveLength(25);
    });

    it('returns ready with a warning when some chunks fail but others succeed', async () => {
      let threadSeq = 0;
      const threadTestIds = new Map<string, string[]>();

      (global.fetch as jest.Mock) = jest.fn((url: string, init?: RequestInit) => {
        if (url.includes('/smart-tagging/start')) {
          const body = JSON.parse((init?.body as string) ?? '{}');
          const testIds = (body.candidates ?? []).map((c: { testId: string }) => c.testId);
          const threadId = `thread-${threadSeq++}`;
          threadTestIds.set(threadId, testIds);
          return Promise.resolve(jsonResponse({ threadId, candidateTestIds: testIds }));
        }
        const threadId = decodeURIComponent(url.split('/status/')[1]);
        const testIds = threadTestIds.get(threadId) ?? [];
        // First thread fails; the rest succeed.
        if (threadId === 'thread-0') {
          return Promise.resolve(jsonResponse({ status: 'failed', error: 'Agent crashed' }));
        }
        return Promise.resolve(
          jsonResponse({
            status: 'ready',
            updated: testIds.map((t) => makeRecord({ id: `u-${t}`, testId: t })),
          }),
        );
      });

      const status = await runChunkedAnchorSmartTagging(buildSyncResult(20), {
        batchSize: 50,
        chunkSize: 10,
        pollIntervalMs: 1,
      });

      expect(status?.status).toBe('ready');
      expect(status?.updated).toHaveLength(10);
      expect(status?.warning).toMatch(/did not finish/i);
    });
  });

  it('excludes already AI-enriched ids from the next smart-tagging batch', () => {
    const created = [
      makeRecord({ id: 'keep', testId: 'keep' }),
      makeRecord({
        id: 'skip',
        testId: 'skip',
        smartTags: ['nav'],
        aiProvenance: {
          provider: 'cursor',
          model: 'composer-2.5',
          skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
          generatedAt: '2026-01-01T00:00:00.000Z',
          confidence: 0.9,
          rationale: 'already tagged',
        },
      }),
    ];
    const inputs = buildSmartTaggingCandidatesFromSync(
      {
        discoveries: [],
        newCandidates: [],
        existingMatches: [],
        missingWarnings: [],
        duplicates: [],
        unsupportedDynamicPatterns: [],
        diagnostics: emptySyncDiagnostics,
        persistence: {
          created,
          refreshed: [],
          markedMissing: [],
          reviewCandidates: created,
          newCandidateIdsForSmartTagging: created.map((r) => r.id),
        },
      },
      { excludeIds: ['skip'] },
    );
    expect(inputs).toEqual([expect.objectContaining({ testId: 'keep' })]);
  });

  it('persists sync review via bulk actions and skips unchanged field PATCHes', async () => {
    const openAi = makeRecord({
      id: 'ai-1',
      testId: 'ai-1',
      label: 'Bell',
      smartTags: ['nav'],
      suggestedRoute: '/home',
    });
    mockFetchOk({ items: [openAi] });

    await persistAnchorSyncReviewDrafts(
      [
        {
          id: 'ai-1',
          label: 'Bell',
          suggestedRoute: '/home',
          approvedRoute: null,
          allowedPlacements: ['bottom'],
          smartTags: ['nav'],
          sourceLocations: openAi.sourceLocations,
          reviewStatus: 'approved',
          isActive: true,
        },
      ],
      { originals: [openAi] },
    );

    const calls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
    // No PATCH for unchanged fields — only bulk approve + activate.
    expect(
      (global.fetch as jest.Mock).mock.calls.filter(
        (c) => c[1]?.method === 'PATCH',
      ),
    ).toHaveLength(0);
    expect(calls.some((u) => u.includes('/anchor-registry/bulk'))).toBe(true);
    expect(
      (global.fetch as jest.Mock).mock.calls.filter(
        (c) =>
          String(c[0]).includes('/anchor-registry/bulk') && c[1]?.method === 'POST',
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('does not overwrite open AI-enriched rows when merging next sync or AI results', () => {
    const openAi = makeRecord({
      id: 'ai-1',
      testId: 'ai-1',
      label: 'Open AI label',
      smartTags: ['nav'],
      aiProvenance: {
        provider: 'cursor',
        model: 'composer-2.5',
        skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        generatedAt: '2026-01-01T00:00:00.000Z',
        confidence: 0.9,
        rationale: 'keep me',
      },
    });
    const scanner = makeRecord({ id: 'scan-1', testId: 'scan-1', label: 'Scanner' });
    expect(hasRealAiProvenance(openAi)).toBe(true);

    expect(
      mergeSmartTaggedSyncCandidates([openAi, scanner], [
        makeRecord({ id: 'ai-1', testId: 'ai-1', label: 'Should not win', smartTags: ['x'] }),
        makeRecord({ id: 'scan-1', testId: 'scan-1', label: 'AI tagged', smartTags: ['y'] }),
      ]),
    ).toEqual([
      expect.objectContaining({ id: 'ai-1', label: 'Open AI label', smartTags: ['nav'] }),
      expect.objectContaining({ id: 'scan-1', label: 'AI tagged', smartTags: ['y'] }),
    ]);

    expect(
      mergeOpenSyncCandidates([openAi], [
        makeRecord({ id: 'ai-1', testId: 'ai-1', label: 'Scanner overwrite' }),
        makeRecord({ id: 'new-1', testId: 'new-1', label: 'New pending' }),
      ]),
    ).toEqual([
      expect.objectContaining({ id: 'ai-1', label: 'Open AI label' }),
      expect.objectContaining({ id: 'new-1', label: 'New pending' }),
    ]);
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
        diagnostics: emptySyncDiagnostics,
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

  it('forwards Options model and skillPath on smart-tagging start', async () => {
    const created = [makeRecord({ id: 'n1', testId: 'new-anchor' })];
    (global.fetch as jest.Mock) = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            JSON.stringify({
              threadId: 'thread-1',
              provenance: {
                provider: 'cursor',
                model: 'gpt-4o',
                skillPath: '.cursor/skills/custom-tag/SKILL.md',
                generatedAt: '2026-07-30T00:00:00.000Z',
              },
              candidateTestIds: ['new-anchor'],
            }),
          ),
        json: () =>
          Promise.resolve({
            threadId: 'thread-1',
            provenance: {
              provider: 'cursor',
              model: 'gpt-4o',
              skillPath: '.cursor/skills/custom-tag/SKILL.md',
              generatedAt: '2026-07-30T00:00:00.000Z',
            },
            candidateTestIds: ['new-anchor'],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify({ status: 'ready', updated: [] })),
        json: () => Promise.resolve({ status: 'ready', updated: [] }),
      });

    const syncResult = {
      discoveries: [],
      newCandidates: [],
      existingMatches: [],
      missingWarnings: [],
      duplicates: [],
      unsupportedDynamicPatterns: [],
      diagnostics: emptySyncDiagnostics,
      persistence: {
        created,
        refreshed: [],
        markedMissing: [],
        reviewCandidates: created,
        newCandidateIdsForSmartTagging: ['n1'],
      },
    };

    await startAndPollAnchorSmartTagging(syncResult, {
      model: 'gpt-4o',
      skillPath: '.cursor/skills/custom-tag/SKILL.md',
      pollIntervalMs: 1,
      maxAttempts: 2,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/platform-admin/walkthroughs/anchor-registry/smart-tagging/start',
      expect.objectContaining({ method: 'POST' }),
    );
    const startCall = (global.fetch as jest.Mock).mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('/anchor-registry/smart-tagging/start'),
    );
    expect(startCall).toBeTruthy();
    const body = JSON.parse(startCall![1].body as string);
    expect(body.model).toBe('gpt-4o');
    expect(body.skillPath).toBe('.cursor/skills/custom-tag/SKILL.md');
    expect(body.candidates).toEqual([
      expect.objectContaining({ testId: 'new-anchor' }),
    ]);
  });
});
